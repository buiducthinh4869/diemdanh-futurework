/**
 * Điểm danh khóa học AI – Futurework: backend Google Apps Script (Web App).
 *
 * Mọi kiểm tra ngày / giờ / trùng điểm danh đều chạy ở server theo giờ
 * Asia/Ho_Chi_Minh. Client không được gửi ngày; không tin giờ thiết bị.
 *
 *   GET  ?action=status            -> trạng thái mở/đóng, đợt hiện hành
 *   GET  ?action=roster            -> danh sách học viên (chỉ khi đang mở)
 *   POST {action:'checkin', id}    -> điểm danh
 *   POST {action:'register', ...}  -> tự đăng ký + điểm danh
 *   admin*  (cần key=ADMIN_KEY)    -> xem README.md
 *
 * Danh sách học viên nằm trong RosterData.gs (không đưa lên GitHub) và chỉ
 * được nạp vào Google Sheet bởi setup().
 */

// ===================== Cấu hình =====================
// SHEET_ID (ID Google Sheet) được khai báo trong RosterData.gs – file này không đưa lên GitHub.
var TZ = 'Asia/Ho_Chi_Minh';
var OPEN_MIN = 8 * 60;         // 08:00 (mở)
var CLOSE_MIN = 17 * 60;       // 17:00 (đóng, không tính 17:00)
var SUMMARY_HOUR = 19;         // tổng hợp lúc 19:00
var DOTS = [
  { name: 'Đợt 1', from: '2026-10-10', to: '2026-11-10' },
  { name: 'Đợt 2', from: '2026-11-14', to: '2026-12-14' }
];
var OUT_OF_DOT = 'Ngoài đợt';
var LOCK_WAIT_MS = 45000;
var CHECKED_TTL = 1800;        // giây; bộ nhớ đệm "đã điểm danh" tự làm mới sau 30 phút
var ROSTER_TTL = 900;           // giây; sửa tay DanhSach sẽ có hiệu lực sau tối đa 15 phút (hoặc chạy clearCache)
var MAX_SELF_REG_PER_DAY = 60;  // chặn spam form tự đăng ký
var LOG_PREALLOC_ROWS = 12000;

var TAB = { ROSTER: 'DanhSach', REG: 'TuDangKy', LOG: 'Log', LUYKE: 'TongHop_LuyKe' };
var SRC_ORIG = 'Danh sách gốc';
var SRC_SELF = 'Tự đăng ký';
var SRC_IMPORT = 'Nhập bù';      // giá trị cột Nguon của dòng nhập bù (adminImport)
var SCHOOLS = ['TUAF', 'TUEBA'];
var BC_HEADERS = ['ID', 'Ho_ten', 'Truong', 'Ngay_hoc', 'Diem_danh', 'Dot'];

var ROSTER_HEADERS = ['ID học viên', 'Trường', 'Khoa', 'Đợt học', 'Họ và tên', 'Năm sinh', 'Giới tính',
  'Ngạch giảng viên', 'Bộ môn', 'Ghi chú', 'study_arm', 'Nguồn', 'ten_khong_dau'];
var LOG_HEADERS = ['Timestamp', 'Ngay', 'ID', 'Ho ten', 'Truong', 'Khoa', 'Bo mon', 'Dot dang ky',
  'Dot hien hanh', 'Dung dot (1/0)', 'study_arm', 'Nguon', 'Ghi chu'];
var REG_HEADERS = ['Timestamp', 'Ngay', 'ID moi', 'Ho ten', 'Truong', 'Khoa', 'Bo mon', 'Dot hoc',
  'Nam sinh', 'Gioi tinh', 'Ngach giang vien', 'So dien thoai', 'study_arm'];
var LUYKE_HEADERS = ['ID học viên', 'Họ và tên', 'Trường', 'Khoa', 'Bộ môn', 'Đợt học', 'study_arm', 'Nguồn',
  'Số buổi có mặt (đúng đợt)', 'Số buổi đáng lẽ phải đi', 'Tỷ lệ chuyên cần', 'Số buổi đi sai đợt'];

// ===================== Điểm vào HTTP =====================
function doGet(e) { return route_(e, false); }
function doPost(e) { return route_(e, true); }

function route_(e, isPost) {
  var out;
  var isAdminCall = false;
  try {
    var p = params_(e, isPost);
    var a = String(p.action || '');
    isAdminCall = a.indexOf('admin') === 0;
    if (a === 'status') out = statusOf_(nowInfo_(fakeOf_(p)));
    else if (a === 'roster') out = actionRoster_(p);
    else if (a === 'checkin' && isPost) out = actionCheckin_(p);
    else if (a === 'register' && isPost) out = actionRegister_(p);
    else if (isAdminCall) out = actionAdmin_(a, p);
    else out = { ok: false, code: 'bad_request', message: 'Yêu cầu không hợp lệ.' };
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    out = {
      ok: false, code: 'error',
      message: isAdminCall ? String(err && err.message ? err.message : err)
                           : 'Lỗi máy chủ, vui lòng thử lại sau ít giây.'
    };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function params_(e, isPost) {
  var p = {};
  var q = (e && e.parameter) || {};
  Object.keys(q).forEach(function (k) { p[k] = q[k]; });
  if (isPost && e && e.postData && e.postData.contents) {
    var body = JSON.parse(e.postData.contents);
    Object.keys(body).forEach(function (k) { p[k] = body[k]; });
  }
  return p;
}

// ===================== Thời gian & đợt =====================
function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function props_() { return PropertiesService.getScriptProperties(); }
function fmt_(d, f) { return Utilities.formatDate(d, TZ, f); }
function pad2_(n) { n = Number(n); return n < 10 ? '0' + n : String(n); }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }

/** Bỏ dấu, hạ chữ thường, gộp khoảng trắng. */
function noAccent_(s) {
  return String(s || '').replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function dotOf_(iso) {
  for (var i = 0; i < DOTS.length; i++) {
    if (iso >= DOTS[i].from && iso <= DOTS[i].to) return DOTS[i].name;
  }
  return OUT_OF_DOT;
}

/** "yyyy-MM-dd HH:mm[:ss]" (giờ VN) -> Date, hoặc null. Chỉ có ngày -> 10:00. */
function parseFake_(s) {
  var m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  var hh = m[4] === undefined ? 10 : Number(m[4]);
  var mm = m[5] === undefined ? 0 : Number(m[5]);
  var ss = m[6] === undefined ? 0 : Number(m[6]);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  var d = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + pad2_(hh) + ':' + pad2_(mm) + ':' + pad2_(ss) + '+07:00');
  return isNaN(d.getTime()) ? null : d;
}

/** Giờ giả lập theo từng yêu cầu: chỉ có hiệu lực khi kèm key=ADMIN_KEY hợp lệ. */
function fakeOf_(p) { return p && p.fake && isAdmin_(p) ? String(p.fake) : ''; }

function nowInfo_(fakeOverride) {
  var fake = fakeOverride || props_().getProperty('FAKE_NOW') || '';
  var d = fake ? parseFake_(fake) : null;
  var isFake = !!d;
  if (!d) d = new Date();
  var iso = fmt_(d, 'yyyy-MM-dd');
  var mins = Number(fmt_(d, 'H')) * 60 + Number(fmt_(d, 'm'));
  var dot = dotOf_(iso);
  var open = dot !== OUT_OF_DOT && mins >= OPEN_MIN && mins < CLOSE_MIN;
  var message = '';
  if (!open) {
    if (dot === OUT_OF_DOT) message = 'Hiện không trong thời gian của đợt học';
    else if (mins < OPEN_MIN) message = 'Chưa đến giờ điểm danh (mở lúc 08:00)';
    else message = 'Đã hết giờ điểm danh hôm nay (đóng lúc 17:00)';
  }
  return {
    epoch: d.getTime(), iso: iso, date: fmt_(d, 'dd/MM/yyyy'), time: fmt_(d, 'HH:mm'),
    ts: fmt_(d, 'yyyy-MM-dd HH:mm:ss'), dot: dot, open: open, message: message, fake: isFake
  };
}

function statusOf_(info) {
  return {
    ok: true, date: info.date, dateISO: info.iso, time: info.time, epoch: info.epoch,
    dot: info.dot, open: info.open, message: info.message, openAt: '08:00', closeAt: '17:00', fake: info.fake
  };
}

function normDate_(s) {
  s = str_(s);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) { var n = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (n) m = [0, n[3], pad2_(n[2]), pad2_(n[1])]; }
  if (!m) throw new Error('Ngày không hợp lệ (dùng yyyy-MM-dd): ' + s);
  return m[1] + '-' + m[2] + '-' + m[3];
}

function cellDate_(v) { return v instanceof Date ? fmt_(v, 'yyyy-MM-dd') : str_(v).substring(0, 10); }
function cellTs_(v) { return v instanceof Date ? fmt_(v, 'yyyy-MM-dd HH:mm:ss') : str_(v); }

// ===================== Danh sách (DanhSach) =====================
function cachePutBig_(cache, key, str, ttl) {
  var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(str, 'text/plain', 'x.txt')).getBytes());
  var CH = 90000, n = Math.ceil(b64.length / CH), obj = {};
  for (var i = 0; i < n; i++) obj[key + '_' + i] = b64.substr(i * CH, CH);
  obj[key + '_n'] = String(n);
  cache.putAll(obj, ttl);
}

function cacheGetBig_(cache, key) {
  var n = Number(cache.get(key + '_n'));
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys), b64 = '';
  for (var j = 0; j < keys.length; j++) { if (!got[keys[j]]) return null; b64 += got[keys[j]]; }
  return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip', 'x.gz')).getDataAsString();
}

function clearRosterCache_() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('roster_n')) || 0;
  var keys = ['roster_n'];
  for (var i = 0; i < Math.max(n, 4); i++) keys.push('roster_' + i);
  cache.removeAll(keys);
}

/** Đọc DanhSach -> mảng đối tượng. force=true bỏ qua bộ nhớ đệm. */
function readRoster_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var c = cacheGetBig_(cache, 'roster');
    if (c) { try { return JSON.parse(c); } catch (e) { /* đọc lại từ sheet */ } }
  }
  var sh = ss_().getSheetByName(TAB.ROSTER);
  if (!sh) throw new Error('Chưa có tab DanhSach – hãy chạy setup().');
  var v = sh.getDataRange().getValues();
  var out = [];
  for (var r = 1; r < v.length; r++) {
    var row = v[r];
    var id = str_(row[0]);
    if (!id) continue;
    out.push({
      id: id, school: str_(row[1]), khoa: str_(row[2]), dot: str_(row[3]), name: str_(row[4]),
      year: str_(row[5]).replace(/\.0$/, ''), gender: str_(row[6]), rank: str_(row[7]), bomon: str_(row[8]),
      note: str_(row[9]), arm: str_(row[10]), src: str_(row[11]) || SRC_ORIG
    });
  }
  cachePutBig_(cache, 'roster', JSON.stringify(out), ROSTER_TTL);
  return out;
}

/** Xóa bộ nhớ đệm (danh sách + 'đã điểm danh' của mọi ngày trong các đợt). Chạy sau khi sửa tay DanhSach/DD_. */
function clearCache() {
  clearRosterCache_();
  var keys = [];
  DOTS.forEach(function (d) {
    for (var t = parseFake_(d.from + ' 12:00').getTime(), end = parseFake_(d.to + ' 12:00').getTime(); t <= end; t += 86400000)
      keys.push('ci_' + fmt_(new Date(t), 'yyyy-MM-dd'));
  });
  for (var i = 0; i < keys.length; i += 90) CacheService.getScriptCache().removeAll(keys.slice(i, i + 90));
  return { ok: true, cleared: keys.length };
}

function findPerson_(id, force) {
  var list = readRoster_(!!force);
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function personOut_(p) {
  return { id: p.id, name: p.name, school: p.school, khoa: p.khoa, bomon: p.bomon, dot: p.dot,
    year: p.year, gender: p.gender, rank: p.rank, note: p.note };
}

function unitsOf_(roster) {
  var seen = {}, out = { TUAF: [], TUEBA: [] };
  roster.forEach(function (r) {
    if (r.src !== SRC_ORIG || !out[r.school]) return;
    var k = r.school + '|' + noAccent_(r.khoa);
    if (seen[k]) return;
    seen[k] = 1;
    out[r.school].push(r.khoa);
  });
  Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return a.localeCompare(b, 'vi'); }); });
  return out;
}

/** study_arm + tên khoa chuẩn của (trường, khoa) theo danh sách gốc; không khớp -> arm rỗng. */
function matchUnit_(roster, school, khoa) {
  var key = noAccent_(khoa);
  for (var i = 0; i < roster.length; i++) {
    var r = roster[i];
    if (r.src === SRC_ORIG && r.school === school && noAccent_(r.khoa) === key) return { khoa: r.khoa, arm: r.arm };
  }
  return { khoa: khoa, arm: '' };
}

// ===================== Endpoint: roster / checkin / register =====================
function closedResp_(info) {
  return { ok: false, code: 'closed', message: info.message, status: statusOf_(info) };
}

function actionRoster_(p) {
  var info = nowInfo_(fakeOf_(p));
  if (!info.open) return closedResp_(info);   // ngoài giờ thì không phát danh sách
  var roster = readRoster_(false);
  var rows = roster.map(function (r) {
    return [r.id, r.name, r.school, r.khoa, r.bomon, r.dot, r.year, r.gender, r.rank, r.note];
  });
  return {
    ok: true, fields: ['id', 'name', 'school', 'khoa', 'bomon', 'dot', 'year', 'gender', 'rank', 'note'],
    rows: rows, units: unitsOf_(roster), status: statusOf_(info)
  };
}

function reqCacheKey_(p) {
  var id = str_(p.reqId).replace(/[^A-Za-z0-9_-]/g, '').substring(0, 64);
  return id ? 'rq_' + id : '';
}

function checkinResp_(person, res, ctx) {
  return {
    ok: true, status: res.status, person: personOut_(person), date: ctx.date, time: res.time,
    dotNow: ctx.dot, dotReg: person.dot, wrongDot: person.dot !== ctx.dot
  };
}

function ctxOfInfo_(info) {
  return { iso: info.iso, date: info.date, dot: info.dot, ts: info.ts, time: info.time };
}

function actionCheckin_(p) {
  var info = nowInfo_(fakeOf_(p));
  if (!info.open) return closedResp_(info);
  var cache = CacheService.getScriptCache();
  var rk = reqCacheKey_(p);
  if (rk) { var hit = cache.get(rk); if (hit) return JSON.parse(hit); }
  var person = findPerson_(str_(p.id), false);
  if (!person) return { ok: false, code: 'notfound', message: 'Không tìm thấy học viên này trong danh sách.' };

  var ss = ss_();   // mở Spreadsheet trước khi lấy khóa để rút ngắn thời gian giữ khóa
  ss.getSheetByName(TAB.LOG);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, code: 'busy', message: 'Hệ thống đang bận, vui lòng thử lại.' };
  var ctx = ctxOfInfo_(info), res;
  try {
    res = recordCheckinLocked_(ss, person, ctx, '');
  } finally {
    lock.releaseLock();
  }
  if (res.status === 'ok') appendLog_(ss, res.row);
  var out = checkinResp_(person, res, ctx);
  if (rk) cache.put(rk, JSON.stringify(out), 3600);
  return out;
}

/** Gọi khi đã giữ khóa. Khóa trùng theo (Ngày, ID). */
function recordCheckinLocked_(ss, person, ctx, note) {
  var day = daySheet_(ss, ctx.iso, true);
  var set = checkedSet_(ctx.iso, day);
  // dòng nhập bù có Timestamp trống -> giờ là '' (falsy), nên kiểm tra theo sự tồn tại của khóa
  if (Object.prototype.hasOwnProperty.call(set, person.id)) return { status: 'already', time: set[person.id] };
  var row = [ctx.ts, ctx.iso, person.id, person.name, person.school, person.khoa, person.bomon,
    person.dot, ctx.dot, person.dot === ctx.dot ? 1 : 0, person.arm, person.src, note || ''];
  day.appendRow(row);                       // DD_ là nguồn chính để chặn trùng: ghi trong khóa
  set[person.id] = ctx.time;
  CacheService.getScriptCache().put('ci_' + ctx.iso, JSON.stringify(set), CHECKED_TTL);
  SpreadsheetApp.flush();
  return { status: 'ok', time: ctx.time, row: row };   // Log được ghi SAU khi nhả khóa (appendLog_) để rút ngắn hàng đợi
}

/** Ghi 1 dòng ở dạng chữ: appendRow tự đổi chuỗi số thành số (mất số 0 đầu của điện thoại), nên đặt định dạng '@' trước. */
function appendTextRow_(sh, row) {
  var r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}

/** Ghi dòng vào Log (chỉ thêm cuối, không cần khóa). Nếu lỗi thì không làm hỏng điểm danh: resyncLog_ sẽ bù lại khi tổng hợp. */
function appendLog_(ss, row) {
  try {
    ss.getSheetByName(TAB.LOG).appendRow(row);
  } catch (e) {
    console.error('appendLog_ lỗi, sẽ được resyncLog_ bù: ' + e);
  }
}

/** Bù các lượt có trong DD_<ngày> nhưng thiếu trong Log. Trả về các dòng đã bù (mảng rỗng nếu không thiếu). */
function resyncLog_(ss, date) {
  var day = ss.getSheetByName('DD_' + date), log = ss.getSheetByName(TAB.LOG);
  if (!day || !log || day.getLastRow() < 2) return [];
  var have = {};
  readLog_(ss).forEach(function (l) { if (l.date === date) have[l.id] = true; });
  var rows = day.getRange(2, 1, day.getLastRow() - 1, LOG_HEADERS.length).getValues()
    .filter(function (r) { return str_(r[2]) && !have[str_(r[2])]; });
  if (rows.length) log.getRange(log.getLastRow() + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  return rows;
}

/** Bộ nhớ đệm {ID: 'HH:mm'} của ngày; nếu mất thì dựng lại từ tab DD_. */
function checkedSet_(iso, daySh) {
  var raw = CacheService.getScriptCache().get('ci_' + iso);
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* dựng lại */ } }
  var set = {};
  var n = daySh.getLastRow();
  if (n > 1) {
    daySh.getRange(2, 1, n - 1, 3).getValues().forEach(function (r) {
      var id = str_(r[2]);
      if (id) set[id] = cellTs_(r[0]).substring(11, 16);
    });
  }
  return set;
}

function daySheet_(ss, iso, create) {
  var name = 'DD_' + iso;
  var sh = ss.getSheetByName(name);
  if (!sh && create) sh = makeTab_(ss, name, LOG_HEADERS, true, 0);
  return sh;
}

// ----- Tự đăng ký -----
function cleanText_(v, max) {
  return str_(v).replace(/\s+/g, ' ').replace(/^[=+\-@\s]+/, '').substring(0, max);
}

function actionRegister_(p) {
  var info = nowInfo_(fakeOf_(p));
  if (!info.open) return closedResp_(info);
  var cache = CacheService.getScriptCache();
  var rk = reqCacheKey_(p);
  if (rk) { var hit = cache.get(rk); if (hit) return JSON.parse(hit); }

  var name = cleanText_(p.name, 100);
  var school = str_(p.school);
  var khoa = cleanText_(p.khoa, 120);
  var bomon = cleanText_(p.bomon, 120);
  var dot = str_(p.dot);
  var year = str_(p.year);
  var gender = str_(p.gender);
  var rank = cleanText_(p.rank, 30);
  var phone = str_(p.phone).replace(/[^0-9+\-\s().]/g, '').substring(0, 20);
  if (!name || name.length < 2) return { ok: false, code: 'invalid', message: 'Vui lòng nhập họ và tên.' };
  if (SCHOOLS.indexOf(school) < 0) return { ok: false, code: 'invalid', message: 'Vui lòng chọn trường.' };
  if (!khoa) return { ok: false, code: 'invalid', message: 'Vui lòng chọn hoặc nhập khoa.' };
  if (dot !== 'Đợt 1' && dot !== 'Đợt 2') return { ok: false, code: 'invalid', message: 'Vui lòng chọn đợt học.' };
  if (year && (!/^\d{4}$/.test(year) || Number(year) < 1930 || Number(year) > 2010))
    return { ok: false, code: 'invalid', message: 'Năm sinh không hợp lệ.' };
  if (['Nam', 'Nữ', 'Khác'].indexOf(gender) < 0) gender = '';

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, code: 'busy', message: 'Hệ thống đang bận, vui lòng thử lại.' };
  var ctx = ctxOfInfo_(info), person, res, created = false;
  try {
    var ss = ss_();
    var roster = readRoster_(true);
    var unit = matchUnit_(roster, school, khoa);
    var nkey = noAccent_(name) + '|' + school + '|' + noAccent_(unit.khoa) + '|' + noAccent_(bomon) + '|' + year;
    for (var i = 0; i < roster.length; i++) {      // gửi lại form -> dùng lại ID cũ, không tạo người mới
      var r = roster[i];
      if (r.src === SRC_SELF && (noAccent_(r.name) + '|' + r.school + '|' + noAccent_(r.khoa) + '|' +
          noAccent_(r.bomon) + '|' + r.year) === nkey) { person = r; break; }
    }
    if (!person) {
      if (countSelfRegToday_(ss, ctx.iso) >= MAX_SELF_REG_PER_DAY)
        return { ok: false, code: 'limit', message: 'Hôm nay đã đạt giới hạn số lượt tự đăng ký. Vui lòng liên hệ ban tổ chức.' };
      var id = nextSelfId_(school, roster);
      person = { id: id, school: school, khoa: unit.khoa, dot: dot, name: name, year: year, gender: gender,
        rank: rank, bomon: bomon, note: '', arm: unit.arm, src: SRC_SELF };
      appendTextRow_(ss.getSheetByName(TAB.ROSTER), [id, school, unit.khoa, dot, name, year, gender, rank, bomon, '',
        unit.arm, SRC_SELF, noAccent_(name)]);
      appendTextRow_(ss.getSheetByName(TAB.REG), [ctx.ts, ctx.iso, id, name, school, unit.khoa, bomon, dot, year,
        gender, rank, phone, unit.arm]);
      clearRosterCache_();
      created = true;
    }
    res = recordCheckinLocked_(ss, person, ctx, '');
  } finally {
    lock.releaseLock();
  }
  if (res.status === 'ok') appendLog_(ss_(), res.row);
  var out = checkinResp_(person, res, ctx);
  out.registered = created;
  if (rk) cache.put(rk, JSON.stringify(out), 3600);
  return out;
}

function countSelfRegToday_(ss, iso) {
  var sh = ss.getSheetByName(TAB.REG), n = 0;
  if (!sh || sh.getLastRow() < 2) return 0;
  sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { if (cellDate_(r[0]) === iso) n++; });
  return n;
}

/** ID tự đăng ký dạng TUAF-N001; bộ đếm chỉ tăng (Script Property NCOUNT_<trường>). */
function nextSelfId_(school, roster) {
  var key = 'NCOUNT_' + school;
  var cur = Number(props_().getProperty(key) || 0);
  var re = new RegExp('^' + school + '-N(\\d+)$');
  roster.forEach(function (r) { var m = re.exec(r.id); if (m) cur = Math.max(cur, Number(m[1])); });
  cur += 1;
  props_().setProperty(key, String(cur));
  return school + '-N' + (cur < 10 ? '00' + cur : cur < 100 ? '0' + cur : String(cur));
}

// ===================== Tạo tab / định dạng =====================
function makeTab_(ss, name, headers, textFormat, minRows) {
  var sh = ss.insertSheet(name);
  if (minRows && sh.getMaxRows() < minRows) sh.insertRowsAfter(sh.getMaxRows(), minRows - sh.getMaxRows());
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  if (textFormat) sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaed');
  sh.setFrozenRows(1);
  return sh;
}

// ===================== Tổng hợp 19:00 =====================
/** Trigger hằng ngày (19:00–20:00 giờ VN). */
function dailySummaryTrigger() { return buildDailySummary(); }

/**
 * Tạo / ghi đè tab TH_yyyy-MM-dd và BC_dd-MM-yyyy (báo cáo cho sếp), rồi cập nhật TongHop_LuyKe.
 * Chạy tay được cho mọi ngày: buildDailySummary('2026-10-12').
 * Chỉ tạo khi ngày thuộc một đợt VÀ có ít nhất 1 lượt điểm danh của TUAF/TUEBA.
 * Trường có lớp trong ngày = trường có ít nhất 1 lượt điểm danh ngày đó; trường không có lớp không bị tính vắng.
 */
function buildDailySummary(dateStr) {
  if (typeof dateStr !== 'string' || !dateStr) dateStr = nowInfo_().iso;   // trigger truyền event object
  dateStr = normDate_(dateStr);
  var dot = dotOf_(dateStr);
  if (dot === OUT_OF_DOT) return { ok: true, skipped: 'Ngày ' + dateStr + ' không thuộc đợt nào.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new Error('Hệ thống đang bận, thử lại sau.');
  try { return buildDailySummaryLocked_(dateStr, dot); } finally { lock.releaseLock(); }
}

function readLog_(ss) {
  var sh = ss.getSheetByName(TAB.LOG);
  var n = sh ? sh.getLastRow() : 0;
  if (n < 2) return [];
  var out = [];
  sh.getRange(2, 1, n - 1, LOG_HEADERS.length).getValues().forEach(function (r) {
    if (str_(r[2])) out.push(logRowToObj_(r));
  });
  return out;
}

function logRowToObj_(r) {
  return { ts: cellTs_(r[0]), date: cellDate_(r[1]), id: str_(r[2]), name: str_(r[3]), school: str_(r[4]),
    khoa: str_(r[5]), bomon: str_(r[6]), dotReg: str_(r[7]), dotNow: str_(r[8]), arm: str_(r[10]),
    src: str_(r[11]), note: str_(r[12]) };
}

function thDates_(ss) {
  return ss.getSheets().map(function (s) { return s.getName(); })
    .filter(function (n) { return /^TH_\d{4}-\d{2}-\d{2}$/.test(n); })
    .map(function (n) { return n.substring(3); });
}

function cmpPerson_(a, b) {
  return a.school.localeCompare(b.school) || a.khoa.localeCompare(b.khoa, 'vi') || a.name.localeCompare(b.name, 'vi');
}

/**
 * Trường X "có lớp" vào ngày D <=> có ít nhất 1 lượt điểm danh của học viên trường X vào ngày D
 * (tính cả người tự đăng ký và dữ liệu nhập bù). Trả về { 'yyyy-MM-dd': { TUAF: true, TUEBA: true } }.
 */
function classMap_(log) {
  var m = {};
  log.forEach(function (l) {
    if (SCHOOLS.indexOf(l.school) < 0) return;
    (m[l.date] = m[l.date] || {})[l.school] = true;
  });
  return m;
}

/** Các ngày thuộc đợt `dot` mà trường `school` có lớp (trong danh sách `days`), không quá `upTo` nếu có. */
function classDaysOf_(cmap, days, school, dot, upTo) {
  return days.filter(function (d) {
    return dotOf_(d) === dot && cmap[d] && cmap[d][school] && (!upTo || d <= upTo);
  });
}

/** Nguồn của người học (Danh sách gốc / Tự đăng ký): lấy từ DanhSach; cột Nguon của Log có thể là 'Nhập bù'. */
function srcOf_(l, byId) {
  var p = byId[l.id];
  if (p && p.src) return p.src;
  if (l.src === SRC_ORIG || l.src === SRC_SELF) return l.src;
  return /-N\d+$/.test(l.id) ? SRC_SELF : SRC_ORIG;
}

function cmpId_(a, b) {
  var sa = /-N\d+$/.test(a.id) ? 1 : 0, sb = /-N\d+$/.test(b.id) ? 1 : 0;
  return sa - sb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function dotNum_(name) { return name === 'Đợt 1' ? 1 : name === 'Đợt 2' ? 2 : ''; }

function dmyOf_(iso) { return iso.substring(8, 10) + '/' + iso.substring(5, 7) + '/' + iso.substring(0, 4); }

function bcName_(iso) { return 'BC_' + iso.substring(8, 10) + '-' + iso.substring(5, 7) + '-' + iso.substring(0, 4); }

function buildDailySummaryLocked_(dateStr, dot) {
  var ss = ss_();
  var added = resyncLog_(ss, dateStr);      // bù Log nếu có lượt chỉ nằm trong DD_
  var roster = readRoster_(true);
  var byId = {};
  roster.forEach(function (r) { byId[r.id] = r; });
  var log = readLog_(ss);
  added.forEach(function (r) {              // gộp thẳng dòng vừa bù, không phụ thuộc việc đọc lại sheet
    var o = logRowToObj_(r);
    if (!log.some(function (l) { return l.date === o.date && l.id === o.id; })) log.push(o);
  });
  log.forEach(function (l) { l.src = srcOf_(l, byId); });

  // Lượt điểm danh trong ngày của TUAF / TUEBA (mỗi ID một lần, lấy lần sớm nhất)
  var today = [], seen = {};
  log.filter(function (l) { return l.date === dateStr && SCHOOLS.indexOf(l.school) >= 0; })
    .sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; })
    .forEach(function (l) { if (!seen[l.id]) { seen[l.id] = true; today.push(l); } });
  if (!today.length) return { ok: true, skipped: 'Không có lượt điểm danh nào trong ngày ' + dateStr + '.' };

  // Trường có lớp hôm nay = có ít nhất 1 lượt điểm danh
  var classSet = {};
  today.forEach(function (l) { classSet[l.school] = true; });
  var isClass = SCHOOLS.map(function (s) { return !!classSet[s]; });
  var nClass = isClass.filter(Boolean).length;

  // Số buổi học của từng trường trong đợt = các ngày đã có TH_ (cộng ngày đang tổng hợp) mà trường đó có lớp
  var days = thDates_(ss);
  if (days.indexOf(dateStr) < 0) days.push(dateStr);
  var cmap = classMap_(log);
  var attended = {};
  log.forEach(function (l) { (attended[l.id] = attended[l.id] || {})[l.date] = true; });

  // ---- Bảng A ----
  function by(items, pred) {
    var c = [0, 0];
    items.forEach(function (x) {
      if (pred && !pred(x)) return;
      var i = SCHOOLS.indexOf(x.school);
      if (i >= 0) c[i]++;
    });
    return [c[0], c[1], c[0] + c[1]];
  }
  // chỉ tiêu liên quan tới vắng / đáng lẽ phải đi: trường không có lớp ghi '–'
  function onlyClass(arr) { return [isClass[0] ? arr[0] : '–', isClass[1] ? arr[1] : '–', arr[2]]; }
  var inDot = roster.filter(function (r) { return r.dot === dot && classSet[r.school]; });   // đáng lẽ phải đi
  var absent = inDot.filter(function (r) { return !seen[r.id]; });
  var right = by(today, function (l) { return l.dotReg === dot; });
  var totInDot = by(inDot);
  var ctrlD1 = {};
  log.forEach(function (l) {
    if (l.arm === 'Control' && l.date <= dateStr && dotOf_(l.date) === 'Đợt 1') ctrlD1[l.id] = l.school;
  });
  var ctrlD1Cum = [0, 0];
  Object.keys(ctrlD1).forEach(function (id) { var i = SCHOOLS.indexOf(ctrlD1[id]); if (i >= 0) ctrlD1Cum[i]++; });
  var ratio = function (a, b) { return b ? a / b : ''; };
  var rowsA = [
    ['Đợt hiện hành', dot, dot, dot],
    ['Có lớp hôm nay (Có/Không)', isClass[0] ? 'Có' : 'Không', isClass[1] ? 'Có' : 'Không', nClass + ' trường'],
    ['Tổng số người đi học hôm nay'].concat(by(today)),
    ['   Trong đó: thuộc Đợt 1 (danh sách gốc)'].concat(by(today, function (l) { return l.src === SRC_ORIG && l.dotReg === 'Đợt 1'; })),
    ['   Trong đó: thuộc Đợt 2 (danh sách gốc)'].concat(by(today, function (l) { return l.src === SRC_ORIG && l.dotReg === 'Đợt 2'; })),
    ['   Trong đó: tự đăng ký (không có trong danh sách gốc)'].concat(by(today, function (l) { return l.src === SRC_SELF; })),
    ['Đi đúng đợt (đợt đăng ký = đợt hiện hành)'].concat(right),
    ['Đi sai đợt (đợt đăng ký ≠ đợt hiện hành)'].concat(by(today, function (l) { return l.dotReg !== dot; })),
    ['Số người đáng lẽ phải đi (thuộc đợt hiện hành, trường có lớp)'].concat(onlyClass(totInDot)),
    ['Số người đáng lẽ phải đi nhưng vắng'].concat(onlyClass(by(absent))),
    ['Tỷ lệ có mặt đúng đợt (đúng đợt / số người đáng lẽ phải đi)',
      isClass[0] ? ratio(right[0], totInDot[0]) : '–', isClass[1] ? ratio(right[1], totInDot[1]) : '–', ratio(right[2], totInDot[2])],
    ['Có mặt hôm nay – nhóm Treatment'].concat(by(today, function (l) { return l.arm === 'Treatment'; })),
    ['Có mặt hôm nay – nhóm Control'].concat(by(today, function (l) { return l.arm === 'Control'; })),
    ['Có mặt hôm nay – chưa xác định study_arm'].concat(by(today, function (l) { return l.arm !== 'Treatment' && l.arm !== 'Control'; }))
  ];
  if (dot === 'Đợt 1') {
    rowsA.push(['Control đi học trong Đợt 1 – hôm nay (nhiễm chéo nhóm đối chứng)']
      .concat(by(today, function (l) { return l.arm === 'Control'; })));
  } else {
    rowsA.push(['Control đi học trong Đợt 1 – hôm nay (nhiễm chéo nhóm đối chứng)', 'Không áp dụng', 'Không áp dụng', 'Không áp dụng']);
  }
  rowsA.push(['Control đã từng đi học trong Đợt 1 – lũy kế đến hết hôm nay (số người)',
    ctrlD1Cum[0], ctrlD1Cum[1], ctrlD1Cum[0] + ctrlD1Cum[1]]);
  var ratioRow = 0;   // chỉ số dòng tỷ lệ trong rowsA
  rowsA.forEach(function (x, i) { if (String(x[0]).indexOf('Tỷ lệ có mặt đúng đợt') === 0) ratioRow = i; });

  // ---- Bảng B: đi sai đợt ----
  var rowsB = today.filter(function (l) { return l.dotReg !== dot; }).map(function (l) {
    return [l.id, l.name, l.school, l.khoa, l.bomon, l.dotReg, l.arm, l.ts.substring(11, 19)];
  });

  // ---- Bảng C: vắng (thuộc đợt hiện hành, trường có lớp) ----
  var rowsC = absent.slice().sort(cmpPerson_).map(function (r) {
    var a = attended[r.id] || {}, miss = 0;
    classDaysOf_(cmap, days, r.school, dot, dateStr).forEach(function (d) { if (!a[d]) miss++; });
    return [r.id, r.name, r.school, r.khoa, r.bomon, r.note, miss];
  });

  // ---- Bảng D: tự đăng ký trong ngày ----
  var regSh = ss.getSheetByName(TAB.REG), rowsD = [];
  if (regSh && regSh.getLastRow() > 1) {
    regSh.getRange(2, 1, regSh.getLastRow() - 1, REG_HEADERS.length).getValues().forEach(function (r) {
      if (cellDate_(r[1]) !== dateStr) return;
      rowsD.push([str_(r[2]), str_(r[3]), str_(r[4]), str_(r[5]), str_(r[6]), str_(r[7]), str_(r[12]),
        cellTs_(r[0]).substring(11, 19)]);
    });
  }

  // ---- Ghi tab TH_ ----
  var name = 'TH_' + dateStr;
  var sh = ss.getSheetByName(name);
  if (sh) { sh.clear(); sh.setFrozenRows(0); } else sh = ss.insertSheet(name);
  var dmy = dmyOf_(dateStr);
  sh.getRange(1, 1).setValue('Tổng hợp điểm danh – ngày ' + dmy + ' – ' + dot).setFontWeight('bold').setFontSize(14);
  var r = 3;
  var startA = r + 2;   // dòng dữ liệu đầu của bảng A
  r = putTable_(sh, r, 'A. Số liệu tổng', ['Chỉ tiêu', 'TUAF', 'TUEBA', 'Tổng'], rowsA, '#e8f0fe', '#c6dafc');
  sh.getRange(startA + ratioRow, 2, 1, 3).setNumberFormat('0.0%');
  r = putTable_(sh, r, 'B. Danh sách đi sai đợt (' + rowsB.length + ' người)',
    ['ID', 'Họ tên', 'Trường', 'Khoa', 'Bộ môn', 'Đợt đăng ký', 'study_arm', 'Giờ điểm danh'], rowsB, '#fff4e5', '#fde0b0', [8]);
  r = putTable_(sh, r, 'C. Danh sách vắng mặt – thuộc ' + dot + ', trường có lớp (' + rowsC.length + ' người)',
    ['ID', 'Họ tên', 'Trường', 'Khoa', 'Bộ môn', 'Ghi chú', 'Số buổi đã vắng lũy kế trong đợt'], rowsC, '#fdecea', '#f8c9c4');
  putTable_(sh, r, 'D. Tự đăng ký trong ngày (' + rowsD.length + ' người)',
    ['ID mới', 'Họ tên', 'Trường', 'Khoa', 'Bộ môn', 'Đợt học', 'study_arm', 'Giờ đăng ký'], rowsD, '#e6f4ea', '#c4e5cc', [8]);
  [340, 210, 170, 210, 210, 150, 130, 120].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(1);

  var bc = writeBaoCao_(ss, dateStr, dot, roster, today, seen, classSet);
  writeCumulative_(ss, roster, log);
  return { ok: true, sheet: name, bcSheet: bc.sheet, present: today.length, absent: absent.length, wrongDot: rowsB.length,
    selfRegistered: rowsD.length, classSchools: SCHOOLS.filter(function (s) { return classSet[s]; }), bc: bc };
}

/**
 * Sheet báo cáo cho sếp BC_dd-MM-yyyy (giá trị tĩnh, ghi đè nếu đã có).
 * Khối 1: học viên thuộc đợt hiện hành của các trường có lớp (Y/N); Khối 2: người có mặt nhưng không thuộc đợt hiện hành (luôn Y).
 * Sắp xếp: Trường (TUAF trước) > Khối 1 trước Khối 2 > ID tăng dần (ID tự đăng ký xếp cuối).
 */
function writeBaoCao_(ss, dateStr, dot, roster, today, seen, classSet) {
  var dmy = dmyOf_(dateStr), dn = dotNum_(dot), byId = {}, rows = [];
  roster.forEach(function (r) { byId[r.id] = r; });
  SCHOOLS.forEach(function (sc) {
    if (!classSet[sc]) return;
    var inBlock1 = {};
    roster.filter(function (r) { return r.school === sc && r.dot === dot; }).sort(cmpId_).forEach(function (r) {
      inBlock1[r.id] = true;
      rows.push([r.id, r.name, sc, dmy, seen[r.id] ? 'Y' : 'N', dn]);
    });
    today.filter(function (l) { return l.school === sc && !inBlock1[l.id]; }).sort(cmpId_).forEach(function (l) {
      rows.push([l.id, byId[l.id] ? byId[l.id].name : l.name, sc, dmy, 'Y', dotNum_(byId[l.id] ? byId[l.id].dot : l.dotReg)]);
    });
  });

  var name = bcName_(dateStr);
  var sh = ss.getSheetByName(name);
  if (sh) { sh.clear(); sh.setFrozenRows(0); } else sh = ss.insertSheet(name);
  var n = rows.length;
  if (sh.getMaxRows() < n + 1) sh.insertRowsAfter(sh.getMaxRows(), n + 1 - sh.getMaxRows());
  sh.getRange(1, 1, 1, BC_HEADERS.length).setValues([BC_HEADERS]).setFontWeight('bold').setBackground('#e8eaed');
  sh.getRange(2, 4, n, 1).setNumberFormat('@');      // 11/10/2026 giữ dạng chữ, không bị hiểu là ngày tháng Mỹ
  sh.getRange(2, 1, n, BC_HEADERS.length).setValues(rows);
  sh.getRange(2, 1, n, BC_HEADERS.length).setBackgrounds(rows.map(function (x) {
    var c = x[4] === 'N' ? '#fdecea' : '#ffffff';
    return [c, c, c, c, c, c];
  }));

  // Bảng đếm bên phải (ô N3): số dòng Diem_danh = Y (gồm cả người đi sai đợt)
  var pivot = [], total = 0;
  SCHOOLS.forEach(function (sc) {
    if (!classSet[sc]) return;
    var c = rows.filter(function (x) { return x[2] === sc && x[4] === 'Y'; }).length;
    pivot.push([sc, c]);
    total += c;
  });
  pivot.push(['Grand Total', total]);
  sh.getRange(3, 14, 1, 2).setValues([['Truong', 'Count of Diem_danh']]).setFontWeight('bold').setBackground('#e8eaed');
  sh.getRange(4, 14, pivot.length, 2).setValues(pivot);
  sh.getRange(3 + pivot.length, 14, 1, 2).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, BC_HEADERS.length);
  sh.autoResizeColumns(14, 2);
  BC_HEADERS.map(function (h, i) { return i + 1; }).concat([14, 15]).forEach(function (c) {
    sh.setColumnWidth(c, sh.getColumnWidth(c) + 18);   // autoResize hay đo hẹp, chữ in đậm bị cắt
  });
  var yes = rows.filter(function (x) { return x[4] === 'Y'; }).length;
  return { sheet: name, rows: n, y: yes, n: n - yes, counts: pivot };
}

/** Ghi một bảng; trả về dòng bắt đầu của bảng kế tiếp (cách 2 dòng trống). */
function putTable_(sh, r, title, headers, rows, bgLight, bgHead, textCols) {
  var w = headers.length;
  sh.getRange(r, 1, 1, w).setBackground(bgHead);
  sh.getRange(r, 1).setValue(title).setFontWeight('bold').setFontSize(12);
  sh.getRange(r + 1, 1, 1, w).setValues([headers]).setFontWeight('bold').setBackground(bgHead);
  var n = rows.length;
  if (!n) {
    var empty = [['(Không có)']];
    for (var i = 1; i < w; i++) empty[0].push('');
    rows = empty; n = 1;
  }
  (textCols || []).forEach(function (c) { sh.getRange(r + 2, c, n, 1).setNumberFormat('@'); });   // giờ HH:mm:ss giữ dạng chữ
  sh.getRange(r + 2, 1, n, w).setValues(rows).setBackground(bgLight);
  return r + 2 + n + 2;
}

/**
 * TongHop_LuyKe. Số buổi đáng lẽ phải đi của một người = số ngày (đã có TH_) thuộc đợt của người đó
 * mà trường của người đó có lớp. Số buổi đi sai đợt = số ngày người đó có mặt ở một đợt khác đợt đăng ký.
 */
function writeCumulative_(ss, roster, log) {
  var days = thDates_(ss), cmap = classMap_(log);
  var attended = {};
  log.forEach(function (l) { (attended[l.id] = attended[l.id] || {})[l.date] = true; });
  var rows = roster.map(function (p) {
    var a = attended[p.id] || {}, cd = classDaysOf_(cmap, days, p.school, p.dot);
    var own = 0, wrong = 0;
    cd.forEach(function (d) { if (a[d]) own++; });
    Object.keys(a).forEach(function (d) { var k = dotOf_(d); if (k !== OUT_OF_DOT && k !== p.dot) wrong++; });
    return [p.id, p.name, p.school, p.khoa, p.bomon, p.dot, p.arm, p.src, own, cd.length, cd.length ? own / cd.length : '', wrong];
  });
  var sh = ss.getSheetByName(TAB.LUYKE) || ss.insertSheet(TAB.LUYKE);
  sh.clear();
  if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
  sh.getRange(1, 1, 1, LUYKE_HEADERS.length).setValues([LUYKE_HEADERS]).setFontWeight('bold').setBackground('#e8eaed');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, LUYKE_HEADERS.length).setValues(rows);
    sh.getRange(2, 11, rows.length, 1).setNumberFormat('0.0%');
  }
  sh.setFrozenRows(1);
}

function rebuildCumulative_() {
  var ss = ss_();
  writeCumulative_(ss, readRoster_(true), readLog_(ss));
}

// ===================== Admin =====================
function isAdmin_(p) {
  var k = props_().getProperty('ADMIN_KEY');
  return !!k && !!p && String(p.key || '') === k;
}

function actionAdmin_(action, p) {
  if (!isAdmin_(p)) return { ok: false, code: 'forbidden', message: 'Sai khóa quản trị.' };
  switch (action) {
    case 'adminDelete': return adminDelete(normDate_(p.date), str_(p.id));
    case 'adminCheckin': return adminCheckin(normDate_(p.date), str_(p.id));
    case 'adminSummary': return adminSummary(normDate_(p.date));
    case 'adminImport': return adminImport(p.items);
    case 'adminExport': return adminExport(str_(p.sheet) || TAB.ROSTER);
    case 'adminRemovePerson': return adminRemovePerson(str_(p.id));
    case 'adminDeleteTab': return adminDeleteTab(str_(p.name));
    case 'adminDeleteDay': return adminDeleteDay(normDate_(p.date), str_(p.confirm));
    case 'adminRebuild': rebuildCumulative_(); return { ok: true };
    case 'adminResyncLog': return withLock_(function () { return { ok: true, added: resyncLog_(ss_(), normDate_(p.date)).length }; });
    case 'adminClearCache': return clearCache();
    case 'adminFake': return { ok: true, status: statusOf_(testMode(str_(p.value))) };
    case 'adminDebug': return adminDebug();
    case 'adminSetup': return { ok: true, log: setup() };
    default: return { ok: false, code: 'bad_request', message: 'Hành động admin không tồn tại.' };
  }
}

/** Đặt giờ giả lập (chỉ để kiểm thử), vd testMode('2026-11-12 10:00'); testMode('') để tắt. */
function testMode(value) {
  var p = props_();
  if (value && value !== 'off') {
    if (!parseFake_(value)) throw new Error('Định dạng: yyyy-MM-dd HH:mm');
    p.setProperty('FAKE_NOW', value);
  } else {
    p.deleteProperty('FAKE_NOW');
  }
  return nowInfo_();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new Error('Hệ thống đang bận, thử lại sau.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Xóa mọi dòng trong sheet mà cột colIdx (1-based) thỏa pred(giá trị); trả về số dòng đã xóa. */
function deleteRowsWhere_(sh, colIdx, pred) {
  if (!sh || sh.getLastRow() < 2) return 0;
  var vals = sh.getRange(2, colIdx, sh.getLastRow() - 1, 1).getValues(), n = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    if (pred(vals[i][0])) { sh.deleteRow(i + 2); n++; }
  }
  return n;
}

function adminDelete(date, id) {
  date = normDate_(date);
  return withLock_(function () {
    var ss = ss_();
    var day = ss.getSheetByName('DD_' + date);
    var nDay = deleteRowsWhere_(day, 3, function (v) { return str_(v) === id; });
    var log = ss.getSheetByName(TAB.LOG), nLog = 0;
    if (log && log.getLastRow() > 1) {
      var v = log.getRange(2, 2, log.getLastRow() - 1, 2).getValues();
      for (var i = v.length - 1; i >= 0; i--) {
        if (cellDate_(v[i][0]) === date && str_(v[i][1]) === id) { log.deleteRow(i + 2); nLog++; }
      }
    }
    CacheService.getScriptCache().remove('ci_' + date);
    return { ok: true, deletedDay: nDay, deletedLog: nLog };
  });
}

function adminCheckin(date, id) {
  date = normDate_(date);
  var person = findPerson_(id, true);
  if (!person) throw new Error('Không có ID ' + id + ' trong DanhSach.');
  var now = nowInfo_();
  var ctx = { iso: date, date: fmt_(parseFake_(date + ' 12:00'), 'dd/MM/yyyy'), dot: dotOf_(date), ts: now.ts, time: now.time };
  return withLock_(function () {
    var ss = ss_();
    var res = recordCheckinLocked_(ss, person, ctx, 'admin');
    if (res.status === 'ok') appendLog_(ss, res.row);
    return { ok: true, status: res.status, time: res.time, date: date, dot: ctx.dot };
  });
}

function adminSummary(date) { return buildDailySummary(normDate_(date)); }

/** Ghi `rows` (mảng các dòng) vào cuối sheet ở dạng chữ (giữ nguyên '2026-10-10', số 0 đầu...). */
function putRows_(sh, rows) {
  if (!rows.length) return;
  var first = sh.getLastRow() + 1, need = first + rows.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(first, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}

/**
 * Nhập bù lượt điểm danh: items = [{date:'yyyy-MM-dd', id:'<ID học viên>'}, ...].
 * Toàn bộ yêu cầu bị từ chối nếu có ngày ngoài đợt / ID không có trong DanhSach (không ghi gì).
 * Bỏ qua lượt đã có (khóa Ngày + ID) nên chạy lại không bị trùng. Dòng ghi vào DD_ và Log với Timestamp trống, Nguon = 'Nhập bù'.
 */
function adminImport(items) {
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = null; } }
  if (!Array.isArray(items) || !items.length) throw new Error('Cần items = [{date, id}, ...].');
  if (items.length > 3000) throw new Error('Tối đa 3000 lượt mỗi lần.');
  var byId = {}, bad = [], clean = [], dup = {};
  readRoster_(true).forEach(function (r) { byId[r.id] = r; });
  items.forEach(function (it, i) {
    var id = str_(it && it.id), date = '';
    try { date = normDate_(it && it.date); } catch (e) { bad.push({ index: i, id: id, reason: 'ngày không hợp lệ' }); return; }
    if (dotOf_(date) === OUT_OF_DOT) { bad.push({ index: i, id: id, date: date, reason: 'ngày không thuộc đợt nào' }); return; }
    if (!byId[id]) { bad.push({ index: i, id: id, date: date, reason: 'ID không có trong DanhSach' }); return; }
    if (dup[date + '|' + id]) return;
    dup[date + '|' + id] = true;
    clean.push({ date: date, person: byId[id] });
  });
  if (bad.length) return { ok: false, code: 'invalid', message: 'Có ' + bad.length + ' dòng không hợp lệ; chưa ghi gì.', invalid: bad.slice(0, 50) };
  return withLock_(function () {
    var ss = ss_(), groups = {}, res = { ok: true, received: items.length, added: 0, skipped: items.length - clean.length, byDate: {} };
    clean.forEach(function (c) { (groups[c.date] = groups[c.date] || []).push(c.person); });
    Object.keys(groups).sort().forEach(function (date) {
      var day = daySheet_(ss, date, true), have = {}, rows = [], dotNow = dotOf_(date);
      if (day.getLastRow() > 1) day.getRange(2, 3, day.getLastRow() - 1, 1).getValues().forEach(function (r) { if (str_(r[0])) have[str_(r[0])] = true; });
      groups[date].forEach(function (p) {
        if (have[p.id]) { res.skipped++; return; }
        have[p.id] = true;
        rows.push(['', date, p.id, p.name, p.school, p.khoa, p.bomon, p.dot, dotNow, p.dot === dotNow ? 1 : 0, p.arm, SRC_IMPORT, '']);
      });
      putRows_(day, rows);
      resyncLog_(ss, date);        // Log được bù từ DD_ (cũng sửa luôn trường hợp lần chạy trước dừng giữa chừng)
      CacheService.getScriptCache().remove('ci_' + date);
      res.added += rows.length;
      res.byDate[date] = rows.length;
    });
    SpreadsheetApp.flush();
    return res;
  });
}

function adminExport(name) {
  if ([TAB.ROSTER, TAB.REG, TAB.LOG, TAB.LUYKE].indexOf(name) < 0 && !/^(DD|TH)_\d{4}-\d{2}-\d{2}$/.test(name) &&
      !/^BC_\d{2}-\d{2}-\d{4}$/.test(name))
    throw new Error('Tab không được phép xuất: ' + name);
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Không có tab ' + name);
  var v = sh.getDataRange().getValues();
  return { ok: true, headers: v[0].map(String), rows: v.slice(1).map(function (r) { return r.map(function (c) { return str_(c); }); }) };
}

function adminDeleteTab(name) {
  if (!/^(TH|DD)_\d{4}-\d{2}-\d{2}$/.test(name) && !/^BC_\d{2}-\d{2}-\d{4}$/.test(name))
    throw new Error('Chỉ được xóa tab TH_yyyy-MM-dd, DD_yyyy-MM-dd hoặc BC_dd-MM-yyyy.');
  return withLock_(function () {
    var ss = ss_(), sh = ss.getSheetByName(name);
    if (!sh) return { ok: true, deleted: false };
    ss.deleteSheet(sh);
    if (name.charAt(0) === 'D') CacheService.getScriptCache().remove('ci_' + name.substring(3));
    return { ok: true, deleted: true };
  });
}

/** Xóa toàn bộ điểm danh của một ngày: tab DD_, TH_, BC_ + các dòng của ngày đó trong Log. Cần confirm='yes'. Dùng để dọn dữ liệu thử. */
function adminDeleteDay(date, confirm) {
  date = normDate_(date);
  if (confirm !== 'yes') throw new Error("Thao tác xóa cả ngày: cần thêm confirm=yes.");
  return withLock_(function () {
    var ss = ss_(), res = { ok: true, date: date, dayTab: false, thTab: false, bcTab: false, logRows: 0 };
    var day = ss.getSheetByName('DD_' + date);
    if (day) { ss.deleteSheet(day); res.dayTab = true; }
    var th = ss.getSheetByName('TH_' + date);
    if (th) { ss.deleteSheet(th); res.thTab = true; }
    var bc = ss.getSheetByName(bcName_(date));
    if (bc) { ss.deleteSheet(bc); res.bcTab = true; }
    var log = ss.getSheetByName(TAB.LOG);
    if (log && log.getLastRow() > 1) {
      var v = log.getRange(2, 2, log.getLastRow() - 1, 1).getValues();
      var i = v.length - 1;
      while (i >= 0) {                                  // xóa theo từng đoạn liên tiếp, từ dưới lên
        if (cellDate_(v[i][0]) !== date) { i--; continue; }
        var end = i;
        while (i >= 0 && cellDate_(v[i][0]) === date) i--;
        log.deleteRows(i + 3, end - i);
        res.logRows += end - i;
      }
    }
    CacheService.getScriptCache().remove('ci_' + date);
    if (res.thTab) rebuildCumulative_();     // số buổi của ngày đã xóa không còn được tính trong TongHop_LuyKe
    return res;
  });
}

/** Xóa HẲN một người tự đăng ký (ID dạng TUAF-N001) khỏi mọi tab; đặt lại bộ đếm. Dùng để dọn dữ liệu thử. */
function adminRemovePerson(id) {
  var m = /^(TUAF|TUEBA)-N\d+$/.exec(id);
  if (!m) throw new Error('Chỉ xóa được ID tự đăng ký (dạng TUAF-N001).');
  return withLock_(function () {
    var ss = ss_(), res = { ok: true, danhSach: 0, tuDangKy: 0, log: 0, dayTabs: 0 };
    var same = function (v) { return str_(v) === id; };
    res.danhSach = deleteRowsWhere_(ss.getSheetByName(TAB.ROSTER), 1, same);
    res.tuDangKy = deleteRowsWhere_(ss.getSheetByName(TAB.REG), 3, same);
    res.log = deleteRowsWhere_(ss.getSheetByName(TAB.LOG), 3, same);
    ss.getSheets().forEach(function (s) {
      if (/^DD_\d{4}-\d{2}-\d{2}$/.test(s.getName())) {
        res.dayTabs += deleteRowsWhere_(s, 3, same);
        CacheService.getScriptCache().remove('ci_' + s.getName().substring(3));
      }
    });
    // Đặt lại bộ đếm = số lớn nhất còn lại
    var re = new RegExp('^' + m[1] + '-N(\\d+)$'), max = 0;
    readRoster_(true).forEach(function (r) { var x = re.exec(r.id); if (x) max = Math.max(max, Number(x[1])); });
    if (max) props_().setProperty('NCOUNT_' + m[1], String(max)); else props_().deleteProperty('NCOUNT_' + m[1]);
    clearRosterCache_();
    rebuildCumulative_();      // bỏ dòng của người đã xóa khỏi TongHop_LuyKe
    res.counter = max;
    return res;
  });
}

function adminDebug() {
  var ss = ss_();
  var p = props_();
  return {
    ok: true,
    tabs: ss.getSheets().map(function (s) { return { name: s.getName(), rows: s.getLastRow() }; }),
    fakeNow: p.getProperty('FAKE_NOW') || null,
    sheetTimeZone: ss.getSpreadsheetTimeZone(),
    scriptTimeZone: TZ,
    counters: { TUAF: p.getProperty('NCOUNT_TUAF'), TUEBA: p.getProperty('NCOUNT_TUEBA') },
    triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); })
  };
}

// ===================== setup() =====================
/**
 * Chạy MỘT LẦN từ trình soạn thảo (an toàn khi chạy lại): tạo tab, nạp danh sách
 * từ RosterData.gs, tạo trigger 19:00, tạo ADMIN_KEY (nếu chưa có).
 */
function setup() {
  var ss = ss_(), log = [];
  // Múi giờ của Sheet phải trùng múi giờ script: nếu lệch, Sheets tự đổi chuỗi ngày/giờ thành giá trị ngày-giờ
  // và việc đọc/ghi sẽ lệch vài giờ (có thể sang ngày khác).
  if (ss.getSpreadsheetTimeZone() !== TZ) {
    log.push('Đổi múi giờ Sheet từ ' + ss.getSpreadsheetTimeZone() + ' sang ' + TZ);
    ss.setSpreadsheetTimeZone(TZ);
  }
  ensureTab_(ss, TAB.ROSTER, ROSTER_HEADERS, true, 0, log);
  ensureTab_(ss, TAB.REG, REG_HEADERS, true, 0, log);
  ensureTab_(ss, TAB.LOG, LOG_HEADERS, true, LOG_PREALLOC_ROWS, log);
  ensureTab_(ss, TAB.LUYKE, LUYKE_HEADERS, false, 0, log);
  loadRosterData_(ss, log);
  dropDefaultTab_(ss, log);
  var n = installTrigger_();
  log.push('Trigger tổng hợp ' + SUMMARY_HOUR + ':00 (' + TZ + '): ' + n);
  var p = props_();
  if (!p.getProperty('ADMIN_KEY')) {
    var key = (typeof ADMIN_KEY_SEED === 'string' && ADMIN_KEY_SEED.length >= 16) ? ADMIN_KEY_SEED : randomKey_();
    p.setProperty('ADMIN_KEY', key);
    log.push('Đã tạo ADMIN_KEY mới (xem Script Properties).');
  } else {
    log.push('ADMIN_KEY đã có – giữ nguyên.');
  }
  clearRosterCache_();
  Logger.log(log.join('\n'));
  return log;
}

function randomKey_() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', out = '';
  for (var i = 0; i < 16; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function ensureTab_(ss, name, headers, textFormat, minRows, log) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    makeTab_(ss, name, headers, textFormat, minRows);
    log.push('Tạo tab ' + name);
    return;
  }
  if (sh.getLastRow() === 0) {
    if (textFormat) sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
    log.push('Ghi tiêu đề cho tab ' + name);
  } else if (str_(sh.getRange(1, 1).getValue()) !== headers[0]) {
    log.push('CẢNH BÁO: tab ' + name + ' đã có dữ liệu với tiêu đề khác – không sửa.');
  } else {
    log.push('Tab ' + name + ' đã có – giữ nguyên.');
  }
}

function loadRosterData_(ss, log) {
  if (typeof ROSTER_DATA === 'undefined') throw new Error('Thiếu RosterData.gs (chạy prepare_roster.py rồi clasp push).');
  var sh = ss.getSheetByName(TAB.ROSTER);
  var have = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { have[str_(r[0])] = true; });
  var add = ROSTER_DATA.filter(function (r) { return !have[r[0]]; }).map(function (r) {
    return [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], SRC_ORIG, noAccent_(r[4])];
  });
  if (add.length) {
    var first = sh.getLastRow() + 1;
    if (sh.getMaxRows() < first + add.length) sh.insertRowsAfter(sh.getMaxRows(), first + add.length - sh.getMaxRows());
    sh.getRange(first, 1, add.length, ROSTER_HEADERS.length).setValues(add);
  }
  log.push('DanhSach: thêm ' + add.length + ' dòng mới, đã có sẵn ' + Object.keys(have).length + '.');
}

function dropDefaultTab_(ss, log) {
  var names = ['Sheet1', 'Sheet 1', 'Trang tính1', 'Trang tính 1'];
  ss.getSheets().forEach(function (s) {
    var nm = s.getName();   // lấy tên trước khi xóa: gọi phương thức trên tab đã xóa sẽ báo lỗi
    if (names.indexOf(nm) >= 0 && s.getLastRow() === 0 && s.getLastColumn() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(s);
      log.push('Đã xóa tab trống mặc định: ' + nm);
    }
  });
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailySummaryTrigger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySummaryTrigger').timeBased().atHour(SUMMARY_HOUR).everyDays(1).inTimezone(TZ).create();
  return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'dailySummaryTrigger'; }).length;
}
