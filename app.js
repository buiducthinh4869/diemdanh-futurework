/* Điểm danh khóa học AI – Futurework (giao diện).
 * Server quyết định ngày/giờ/đợt/trùng lặp; trang này chỉ hiển thị và gửi yêu cầu. */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var S = window.FWSearch;
  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['vLoading', 'vClosed', 'vError', 'vSearch', 'vConfirm', 'vRegister', 'vResult'];
  var ROSTER_MAX_AGE = 10 * 60 * 1000;
  var LIMIT = 15;

  var st = {
    status: null, blockedDate: '', blockedMessage: '', people: null, units: null, rosterAt: 0,
    view: '', results: [], active: -1, selected: null, busy: false, reqId: '', retry: null
  };

  // ---------------------------------------------------------------- tiện ích
  function show(name) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== name; });
    st.view = name;
    if (name !== 'vSearch') closeList();
    try { window.scrollTo({ top: 0 }); } catch (e) { /* bỏ qua */ }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function newReqId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* dùng cách dự phòng */ }
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function deviceId() {
    try {
      var id = localStorage.getItem('fw_device_v1');
      if (!id || !/^[A-Za-z0-9_-]{20,80}$/.test(id)) {
        if (!window.crypto || !crypto.getRandomValues) throw new Error('crypto');
        var bytes = new Uint8Array(24);
        crypto.getRandomValues(bytes);
        id = Array.from(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        localStorage.setItem('fw_device_v1', id);
      }
      return id;
    } catch (e) {
      throw new Error('Cần cho phép trình duyệt lưu dữ liệu để xác định thiết bị. Vui lòng liên hệ ban tổ chức nếu không thể điểm danh.');
    }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------------------------------------------------------------- mạng
  /* Tự thử lại tối đa `tries` lần khi lỗi mạng hoặc server báo bận (khóa). */
  async function fetchJson(url, init, tries) {
    var lastErr;
    for (var i = 1; i <= tries; i++) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 25000);
      try {
        var res = await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
        var data = await res.json();
        clearTimeout(timer);
        if (data && (data.code === 'busy' || data.code === 'error') && i < tries) { await sleep(1000 * i + Math.random() * 2000); continue; }   // server đông / lỗi tạm thời -> thử lại
        return data;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (i < tries) await sleep(800 * i + Math.random() * 1200);
      }
    }
    throw lastErr || new Error('network');
  }
  function apiGet(params, tries) {
    var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var url = CFG.API_URL + (CFG.API_URL.indexOf('?') < 0 ? '?' : '&') + q + '&_=' + Date.now();
    return fetchJson(url, { method: 'GET' }, tries || 2);
  }
  function apiPost(body, tries) {
    // text/plain để tránh CORS preflight với Apps Script
    return fetchJson(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }, tries || 5);
  }

  // ---------------------------------------------------------------- trạng thái mở/đóng
  async function pollStatus() {
    try {
      var s = await apiGet({ action: 'status' }, 2);
      if (!s || !s.ok) throw new Error('status');
      applyStatus(s);
    } catch (e) {
      if (!st.status) showError('Không kết nối được máy chủ. Vui lòng kiểm tra mạng rồi thử lại.', start);
      else $('infoTime').textContent = 'mất kết nối, đang thử lại…';
    }
  }

  function applyStatus(s) {
    var wasOpen = !!(st.status && st.status.open);
    st.status = s;
    $('infoDate').textContent = 'Hôm nay: ' + s.date;
    $('infoDot').textContent = 'Đợt hiện hành: ' + s.dot;
    $('infoTime').textContent = 'Giờ hệ thống ' + s.time;
    $('fakeBanner').hidden = !s.fake;
    var b = $('badge');
    b.className = 'badge ' + (s.open ? 'badge-open' : 'badge-closed');
    b.textContent = s.open ? 'Đang mở điểm danh (' + s.openAt + '–' + s.closeAt + ')' : 'Đang đóng';

    if (st.blockedDate === s.dateISO) { showClosed(st.blockedMessage); return; }
    if (!s.open) {
      // Đóng: ẩn ô tìm kiếm + nút điểm danh. Màn hình kết quả (đã điểm danh xong) được giữ lại.
      if (st.view !== 'vResult') showClosed(s.message);
      return;
    }
    if (st.view === 'vLoading' || st.view === 'vClosed' || st.view === 'vError' || (!wasOpen && st.view !== 'vResult')) enterSearch();
  }

  function showClosed(msg) {
    $('closedMsg').textContent = msg || 'Hiện chưa mở điểm danh';
    show('vClosed');
  }

  function showError(msg, retryFn) {
    $('errorMsg').textContent = msg;
    st.retry = retryFn || start;
    show('vError');
  }

  // ---------------------------------------------------------------- danh sách + tìm kiếm
  async function ensureRoster() {
    if (st.people && Date.now() - st.rosterAt < ROSTER_MAX_AGE) return true;
    var r = await apiGet({ action: 'roster' }, 2);
    if (r && r.ok) {
      st.people = S.prepare(r.rows.map(function (row) {
        var o = {};
        r.fields.forEach(function (f, i) { o[f] = row[i]; });
        return o;
      }));
      st.units = r.units || { TUAF: [], TUEBA: [] };
      st.rosterAt = Date.now();
      return true;
    }
    if (r && r.status) { applyStatus(r.status); return false; }   // vừa đóng cửa
    throw new Error((r && r.message) || 'roster');
  }

  async function enterSearch() {
    show('vLoading');
    try {
      if (!(await ensureRoster())) return;
    } catch (e) {
      showError('Không tải được danh sách. Vui lòng thử lại.', enterSearch);
      return;
    }
    resetSearch();
  }

  function resetSearch() {
    st.selected = null; st.results = []; st.active = -1; st.reqId = '';
    $('q').value = '';
    if (st.status && !st.status.open) { showClosed(st.status.message); return; }
    show('vSearch');
    $('q').focus();
  }

  function closeList() {
    $('listBox').hidden = true;
    $('q').setAttribute('aria-expanded', 'false');
    $('q').removeAttribute('aria-activedescendant');
  }

  function appendHighlighted(parent, text, ranges) {
    var pos = 0;
    ranges.forEach(function (r) {
      if (r[0] > pos) parent.appendChild(document.createTextNode(text.slice(pos, r[0])));
      parent.appendChild(el('b', '', text.slice(r[0], r[1])));
      pos = r[1];
    });
    if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
  }

  function onInput() {
    if (!st.people) return;
    var text = $('q').value;
    var res = S.search(st.people, text, LIMIT);
    st.results = res.items;
    st.active = res.items.length ? 0 : -1;
    var ul = $('list');
    ul.textContent = '';
    var more = $('more');
    if (!res.toks.length) { closeList(); return; }
    res.items.forEach(function (h, i) {
      var li = el('li');
      li.id = 'opt' + i;
      li.setAttribute('role', 'option');
      var nm = el('div', 'opt-name');
      appendHighlighted(nm, h.p.name, S.highlightRanges(h.p, res.toks));
      li.appendChild(nm);
      li.appendChild(el('div', 'opt-meta', h.p.meta));
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });   // giữ focus ở ô nhập
      li.addEventListener('mouseenter', function () { setActive(i, false); });
      li.addEventListener('click', function () { choose(i); });
      ul.appendChild(li);
    });
    if (!res.items.length) {
      more.textContent = 'Không có tên nào khớp. Hãy thử gõ ngắn hơn, hoặc bấm “Không tìm thấy tên của bạn?” bên dưới.';
      more.hidden = false;
    } else if (res.total > res.items.length) {
      more.textContent = 'Còn ' + (res.total - res.items.length) + ' kết quả khác – gõ thêm để lọc.';
      more.hidden = false;
    } else {
      more.hidden = true;
    }
    $('listBox').hidden = false;
    $('q').setAttribute('aria-expanded', 'true');
    setActive(st.active, false);
  }

  function setActive(i, scroll) {
    st.active = i;
    var items = $('list').children;
    for (var k = 0; k < items.length; k++) {
      var on = k === i;
      items[k].classList.toggle('active', on);
      items[k].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (i >= 0 && items[i]) {
      $('q').setAttribute('aria-activedescendant', items[i].id);
      if (scroll) items[i].scrollIntoView({ block: 'nearest' });
    }
  }

  function move(delta) {
    var n = st.results.length;
    if (!n) return;
    setActive(((st.active < 0 ? (delta > 0 ? -1 : 0) : st.active) + delta + n) % n, true);
  }

  function choose(i) {
    var h = st.results[i];
    if (!h) return;
    st.selected = h.p;
    st.reqId = newReqId();
    closeList();
    showConfirm(h.p);
  }

  // ---------------------------------------------------------------- xác nhận
  function showConfirm(p) {
    var dl = $('confirmInfo');
    dl.textContent = '';
    var rows = [
      ['Mã học viên', p.id], ['Họ và tên', p.name, true], ['Trường', p.school], ['Khoa', p.khoa], ['Bộ môn', p.bomon],
      ['Đợt học', p.dot], ['Năm sinh', p.year], ['Giới tính', p.gender], ['Ngạch giảng viên', p.rank]
    ];
    if (p.note) rows.push(['Ghi chú', p.note]);
    rows.forEach(function (r) {
      var row = el('div', 'row' + (r[2] ? ' big' : ''));
      row.appendChild(el('dt', '', r[0]));
      row.appendChild(el('dd', '', r[1] || '—'));
      dl.appendChild(row);
    });
    $('btnConfirm').disabled = false;
    $('btnConfirm').textContent = 'Xác nhận điểm danh';
    show('vConfirm');
  }

  async function submitCheckin() {
    if (st.busy || !st.selected) return;
    st.busy = true;
    var btn = $('btnConfirm');
    btn.disabled = true; btn.textContent = 'Đang ghi nhận…';
    var slow = setTimeout(function () { btn.textContent = 'Hệ thống đang đông, vui lòng chờ…'; }, 8000);
    try {
      var res = await apiPost({ action: 'checkin', deviceId: deviceId(), id: st.selected.id, reqId: st.reqId }, 5);
      handleResult(res, st.selected, submitCheckin);
    } catch (e) {
      showError('Không gửi được yêu cầu (lỗi mạng). Bấm “Thử lại” để gửi lại; nếu bạn đã điểm danh trước đó, hệ thống sẽ không ghi trùng.', submitCheckin);
    } finally {
      clearTimeout(slow);
      st.busy = false;
    }
  }

  function handleResult(res, person, retryFn) {
    if (res && res.ok) { showResult(res, person); return; }
    if (res && res.code === 'closed') { if (res.status) applyStatus(res.status); else showClosed(res.message); return; }
    if (res && (res.code === 'device_used' || res.code === 'device_required')) {
      st.blockedDate = st.status && st.status.dateISO; st.blockedMessage = res.message;
      showClosed(res.message); return;
    }
    var msg = (res && res.message) || 'Có lỗi xảy ra. Vui lòng thử lại.';
    if (res && (res.code === 'invalid' || res.code === 'limit') && st.view === 'vRegister') { showRegErr(msg); return; }
    showError(msg, res && res.code === 'notfound' ? resetSearch : retryFn);
  }

  function showResult(res, person) {
    var p = res.person || person || {};
    var card = $('vResult');
    var already = res.status === 'already';
    card.className = 'card result' + (already ? ' info-state' : '');
    $('resIcon').textContent = already ? 'ℹ' : '✔';
    $('resTitle').textContent = already ? 'Bạn đã điểm danh hôm nay' + (res.time ? ' lúc ' + res.time : '') :'Bạn đã điểm danh thành công';
    $('resName').textContent = p.name || '';
    $('resWhen').textContent = already ? 'Ngày ' + res.date : 'Ngày ' + res.date + ' · lúc ' + res.time;
    var notes = [];
    if (res.registered && p.id) notes.push('Mã học viên của bạn: ' + p.id + '. Thông tin của bạn đã được gửi cho ban tổ chức.');
    if (res.wrongDot) notes.push('Lưu ý: bạn thuộc ' + res.dotReg + '; hôm nay là buổi học của ' + res.dotNow);
    $('resNote').textContent = notes.join(' ');
    $('resNote').hidden = !notes.length;
    st.reqId = '';
    show('vResult');
  }

  // ---------------------------------------------------------------- tự đăng ký
  function openRegister() {
    var f = $('regForm');
    f.reset();
    $('rKhoa').innerHTML = '';
    $('rKhoa').appendChild(new Option('— Chọn trường trước —', ''));
    $('rKhoa').disabled = true;
    $('rKhoaOtherWrap').hidden = true;
    showRegErr('');
    $('btnReg').disabled = false;
    $('btnReg').textContent = 'Gửi và điểm danh';
    st.reqId = newReqId();
    // điền sẵn từ ô tìm kiếm nếu người dùng đã gõ tên
    var typed = $('q').value.trim();
    if (typed && !/^[A-Za-z]+-?N?\d+$/i.test(typed)) $('rName').value = typed;
    show('vRegister');
  }

  function fillKhoa() {
    var school = $('rSchool').value, sel = $('rKhoa');
    sel.innerHTML = '';
    $('rKhoaOtherWrap').hidden = true;
    if (!school) { sel.appendChild(new Option('— Chọn trường trước —', '')); sel.disabled = true; return; }
    sel.appendChild(new Option('— Chọn khoa —', ''));
    ((st.units && st.units[school]) || []).forEach(function (k) { sel.appendChild(new Option(k, k)); });
    sel.appendChild(new Option('Khác (tự nhập)', '__other__'));
    sel.disabled = false;
  }

  function showRegErr(msg) {
    $('regErr').textContent = msg || '';
    $('regErr').hidden = !msg;
  }

  async function submitRegister(ev) {
    ev.preventDefault();
    if (st.busy) return;
    var name = $('rName').value.replace(/\s+/g, ' ').trim();
    var school = $('rSchool').value;
    var khoa = $('rKhoa').value === '__other__' ? $('rKhoaOther').value.replace(/\s+/g, ' ').trim() : $('rKhoa').value;
    var dotEl = document.querySelector('input[name=dot]:checked');
    var year = $('rYear').value.trim();
    if (name.length < 2) { showRegErr('Vui lòng nhập họ và tên.'); $('rName').focus(); return; }
    if (!school) { showRegErr('Vui lòng chọn trường.'); $('rSchool').focus(); return; }
    if (!khoa) { showRegErr('Vui lòng chọn hoặc nhập khoa.'); ($('rKhoa').value === '__other__' ? $('rKhoaOther') : $('rKhoa')).focus(); return; }
    if (!dotEl) { showRegErr('Vui lòng chọn đợt học.'); return; }
    if (year && (!/^\d{4}$/.test(year) || +year < 1930 || +year > 2010)) { showRegErr('Năm sinh không hợp lệ (ví dụ: 1985).'); $('rYear').focus(); return; }
    showRegErr('');
    st.busy = true;
    var btn = $('btnReg');
    btn.disabled = true; btn.textContent = 'Đang gửi…';
    try {
      var res = await apiPost({
        action: 'register', deviceId: deviceId(), reqId: st.reqId, name: name, school: school, khoa: khoa, bomon: $('rBomon').value,
        dot: dotEl.value, year: year, gender: $('rGender').value, rank: $('rRank').value, phone: $('rPhone').value
      }, 5);
      if (res && !res.ok && st.view === 'vRegister' && res.code !== 'closed') { btn.disabled = false; btn.textContent = 'Gửi và điểm danh'; }
      handleResult(res, null, function () { show('vRegister'); });
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Gửi và điểm danh';
      showRegErr('Không gửi được (lỗi mạng). Vui lòng bấm gửi lại – hệ thống sẽ không tạo trùng.');
    } finally {
      st.busy = false;
    }
  }

  // ---------------------------------------------------------------- khởi động
  function start() {
    if (!CFG.API_URL) { showError('Chưa cấu hình địa chỉ máy chủ (config.js).', start); return; }
    try { deviceId(); } catch (e) { showError(e.message, start); return; }
    show('vLoading');
    pollStatus();
  }

  function bind() {
    var q = $('q');
    q.addEventListener('input', onInput);
    // Focus lại (đổi cửa sổ, chụp màn hình...) chỉ mở lại danh sách nếu đang ẩn, không đặt lại dòng đang chọn.
    q.addEventListener('focus', function () { if (q.value.trim() && $('listBox').hidden) onInput(); });
    q.addEventListener('blur', function () { setTimeout(closeList, 150); });
    q.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;   // đang gõ tiếng Việt (IME)
      if (e.key === 'ArrowDown') { e.preventDefault(); if ($('listBox').hidden) onInput(); else move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if ($('listBox').hidden) onInput(); else move(-1); }
      else if (e.key === 'Enter') {
        if (!$('listBox').hidden && st.active >= 0) { e.preventDefault(); choose(st.active); }
      } else if (e.key === 'Escape') { closeList(); }
    });
    $('btnNotFound').addEventListener('click', openRegister);
    $('btnConfirm').addEventListener('click', submitCheckin);
    $('btnNotMe').addEventListener('click', resetSearch);
    $('btnRetry').addEventListener('click', function () { var fn = st.retry || start; show('vLoading'); fn(); });
    $('btnRegBack').addEventListener('click', resetSearch);
    $('rSchool').addEventListener('change', fillKhoa);
    $('rKhoa').addEventListener('change', function () {
      var other = $('rKhoa').value === '__other__';
      $('rKhoaOtherWrap').hidden = !other;
      if (other) $('rKhoaOther').focus();
    });
    $('regForm').addEventListener('submit', submitRegister);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && CFG.API_URL) pollStatus(); });
    setInterval(function () { if (CFG.API_URL) pollStatus(); }, CFG.STATUS_POLL_MS || 60000);
  }

  bind();
  start();
})();
