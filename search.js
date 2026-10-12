/* Tìm kiếm tên: không phân biệt hoa/thường và dấu tiếng Việt, khớp theo tiền tố từng từ.
 * Thuần logic (không đụng DOM) để có thể kiểm thử bằng Node hoặc trong trình duyệt. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FWSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 1 ký tự -> đúng 1 ký tự [a-z0-9 ] (đ -> d, bỏ dấu, ký tự khác -> khoảng trắng). Giữ nguyên độ dài chuỗi. */
  function foldChar(ch) {
    var s = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (s === 'đ') s = 'd';
    var c = s.charAt(0);
    return /[a-z0-9]/.test(c) ? c : ' ';
  }

  function fold(str) {
    var s = String(str == null ? '' : str).normalize('NFC'), out = '';
    for (var i = 0; i < s.length; i++) out += foldChar(s.charAt(i));
    return out;
  }

  function wordsOf(folded) {
    var re = /[a-z0-9]+/g, m, out = [];
    while ((m = re.exec(folded))) out.push({ w: m[0], i: m.index });
    return out;
  }

  function tokens(text) {
    return wordsOf(fold(text)).map(function (x) { return x.w; });
  }

  var collator = (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator('vi') : { compare: function (a, b) { return a < b ? -1 : a > b ? 1 : 0; } };

  /** Chuẩn bị danh sách: tính sẵn từ đã bỏ dấu và cờ "trùng tên" để hiển thị thêm thông tin phân biệt. */
  function prepare(list) {
    var people = list.map(function (r) {
      var p = {};
      Object.keys(r).forEach(function (k) { p[k] = r[k] == null ? '' : String(r[k]).normalize('NFC'); });
      p.fold = fold(p.name);
      p.nw = wordsOf(p.fold);
      p.given = p.nw.length ? p.nw[p.nw.length - 1].w : '';
      var idk = p.id.toLowerCase().replace(/[^a-z0-9]/g, '');
      p.idw = wordsOf(fold(p.id)).map(function (x) { return x.w; });
      if (idk) p.idw.push(idk);
      return p;
    });
    var byName = {}, byFull = {};
    people.forEach(function (p) {
      var n = p.nw.map(function (x) { return x.w; }).join(' ');
      var full = [n, p.school, fold(p.khoa).replace(/\s+/g, ' ').trim(), fold(p.bomon).replace(/\s+/g, ' ').trim(), p.year].join('|');
      p._n = n; p._full = full;
      byName[n] = (byName[n] || 0) + 1;
      byFull[full] = (byFull[full] || 0) + 1;
    });
    people.forEach(function (p) {
      var meta = [p.school, p.khoa, p.bomon].filter(Boolean);
      if (byName[p._n] > 1 && p.year) meta.push('sinh ' + p.year);      // trùng họ tên -> thêm năm sinh
      if (byFull[p._full] > 1) meta.push('mã ' + p.id);                 // vẫn không phân biệt được -> thêm mã
      p.meta = meta.join(' · ');
    });
    return people;
  }

  function scoreOf(p, toks) {
    var total = 0;
    for (var t = 0; t < toks.length; t++) {
      var tok = toks[t], best = -1, k, w;
      for (k = 0; k < p.nw.length; k++) {
        w = p.nw[k].w;
        var last = k === p.nw.length - 1;
        if (w === tok) best = Math.max(best, last ? 100 : 50);                 // khớp nguyên từ; tên gọi (từ cuối) ưu tiên
        else if (w.indexOf(tok) === 0) best = Math.max(best, last ? 80 : 30);   // khớp tiền tố
      }
      if (best < 0) {
        for (k = 0; k < p.idw.length; k++) {
          w = p.idw[k];
          if (w === tok) best = Math.max(best, 90);
          else if (w.indexOf(tok) === 0) best = Math.max(best, 70);
        }
      }
      if (best < 0) return -1;
      total += best;
    }
    return total + phraseBonus(p, toks);
  }

  /** Thưởng khi các từ gõ khớp liên tiếp đúng thứ tự: ở đầu tên (+100) hoặc giữa tên (+40). */
  function phraseBonus(p, toks) {
    var n = toks.length, W = p.nw;
    if (n < 2) return 0;
    for (var j = 0; j + n <= W.length; j++) {
      var ok = true;
      for (var t = 0; t < n; t++) if (W[j + t].w.indexOf(toks[t]) !== 0) { ok = false; break; }
      if (ok) return j === 0 ? 100 : 40;
    }
    return 0;
  }

  /** Các đoạn [bắt đầu, kết thúc) của tên cần in đậm. */
  function highlightRanges(p, toks) {
    var rs = [];
    p.nw.forEach(function (x) {
      var len = 0;
      toks.forEach(function (t) { if (x.w.indexOf(t) === 0 && t.length > len) len = t.length; });
      if (len) rs.push([x.i, x.i + len]);
    });
    return rs;
  }

  /** Trả về {items: tối đa `limit` kết quả, total: tổng số khớp, toks}. */
  function search(people, text, limit) {
    var toks = tokens(text);
    if (!toks.length) return { items: [], total: 0, toks: toks };
    var hits = [];
    for (var i = 0; i < people.length; i++) {
      var s = scoreOf(people[i], toks);
      if (s >= 0) hits.push({ p: people[i], score: s });
    }
    hits.sort(function (a, b) {
      return b.score - a.score || collator.compare(a.p.given, b.p.given) || collator.compare(a.p.name, b.p.name) || (a.p.id < b.p.id ? -1 : 1);
    });
    return { items: hits.slice(0, limit || 15), total: hits.length, toks: toks };
  }

  return { fold: fold, tokens: tokens, prepare: prepare, search: search, highlightRanges: highlightRanges };
});
