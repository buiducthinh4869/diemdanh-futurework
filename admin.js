(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var key = '', settings = null, busy = false;
  function message(text) { $('message').textContent = text; }
  async function api(body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    try {
      var response = await fetch(window.APP_CONFIG.API_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({}, body, { key: key })), signal: controller.signal
      });
      var data = await response.json();
      if (!data.ok) throw new Error(data.message || 'Máy chủ chưa hỗ trợ chức năng quản trị giờ. Cần cập nhật Apps Script.');
      return data;
    } finally { clearTimeout(timer); }
  }
  function fill() {
    var perDate = $('scope').value === 'date';
    $('dateWrap').hidden = !perDate;
    $('resetDate').hidden = !perDate;
    $('scheduleDate').required = perDate;
    var schedule = (perDate && settings.dates[$('scheduleDate').value]) || settings.default;
    $('openAt').value = schedule.openAt;
    $('closeAt').value = schedule.closeAt;
    $('closed').checked = schedule.closed;
  }
  function render(data) {
    settings = data.settings;
    if (!settings) throw new Error('Cần triển khai phiên bản Apps Script mới trước khi sử dụng.');
    var status = data.status;
    $('currentStatus').textContent = 'Hôm nay ' + status.date + ': ' + (status.open ? 'đang mở' : 'đang đóng') + ' · ' + status.openAt + '–' + status.closeAt;
    if (!$('scheduleDate').value) $('scheduleDate').value = status.dateISO;
    $('overrides').textContent = '';
    Object.keys(settings.dates).sort().forEach(function (date) {
      var schedule = settings.dates[date], li = document.createElement('li');
      li.textContent = date + ': ' + (schedule.closed ? 'Đóng cả ngày' : schedule.openAt + '–' + schedule.closeAt);
      $('overrides').appendChild(li);
    });
    if (!$('overrides').children.length) $('overrides').textContent = 'Chưa đặt lịch riêng.';
    fill();
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try { await fn(); }
    catch (error) { message(error.name === 'AbortError' ? 'Yêu cầu quá thời gian. Đăng nhập lại để kiểm tra thiết lập trước khi lưu lại.' : error.message); }
    finally {
      busy = false;
      document.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
    }
  }
  $('loginForm').addEventListener('submit', function (event) {
    event.preventDefault();
    run(async function () {
      key = $('adminKey').value;
      message('Đang kiểm tra…');
      var data = await api({ action: 'adminGetSchedule' });
      render(data);
      $('adminKey').value = '';
      $('loginForm').hidden = true;
      $('logout').hidden = false;
      $('settingsPanel').hidden = false;
      message('Đã đăng nhập.');
    });
  });
  $('logout').addEventListener('click', function () {
    key = ''; settings = null;
    $('settingsPanel').hidden = true;
    $('logout').hidden = true;
    $('loginForm').hidden = false;
    message('Đã đăng xuất.');
  });
  $('scope').addEventListener('change', fill);
  $('scheduleDate').addEventListener('change', fill);
  async function save(reset) {
    var date = $('scope').value === 'date' ? $('scheduleDate').value : '';
    if ($('scope').value === 'date' && !date) { message('Vui lòng chọn ngày.'); return; }
    await run(async function () {
      message('Đang lưu…');
      render(await api({ action: 'adminSetSchedule', date: date, openAt: $('openAt').value,
        closeAt: $('closeAt').value, closed: $('closed').checked, reset: reset }));
      message('Đã lưu. Trang điểm danh sẽ cập nhật trong vòng một phút hoặc ngay khi tải lại trang.');
    });
  }
  $('scheduleForm').addEventListener('submit', function (event) { event.preventDefault(); save(false); });
  $('resetDate').addEventListener('click', function () { save(true); });
})();
