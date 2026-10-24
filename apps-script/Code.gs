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
 * Cấu trúc Google Sheet (v3): 4 tab cố định + 1 tab BC_dd-MM-yyyy mỗi ngày học
 *   DanhSach   danh sách học viên (master, gồm cả người tự đăng ký)
 *   Log        mọi lượt điểm danh (nguồn dữ liệu gốc duy nhất)
 *   TongHop    mỗi (Ngày, Trường có lớp) một dòng, cập nhật lúc 17:00
 *   ChuyenCan  mỗi học viên một dòng, cập nhật lúc 17:00
 *   BC_...     báo cáo cho lãnh đạo của ngày
 *
 * Danh sách học viên nằm trong RosterData.gs (không đưa lên GitHub) và chỉ
 * được nạp vào Google Sheet bởi setup().
 */

// ===================== Cấu hình =====================
// SHEET_ID (ID Google Sheet) được khai báo trong RosterData.gs – file này không đưa lên GitHub.
var TZ = 'Asia/Ho_Chi_Minh';
var OPEN_MIN = 8 * 60;         // 08:00 (mở)
var CLOSE_MIN = 17 * 60;       // 17:00 (đóng, không tính 17:00)
var SUMMARY_HOUR = 17;         // tổng hợp lúc 17:00
var DOTS = [
  { name: 'Đợt 1', from: '2026-10-10', to: '2026-11-10' },
  { name: 'Đợt 2', from: '2026-11-14', to: '2026-12-14' }
];
var OUT_OF_DOT = 'Ngoài đợt';
var LOCK_WAIT_MS = 45000;
var CHECKED_TTL = 1800;        // giây; bộ nhớ đệm "đã điểm danh" tự làm mới sau 30 phút (dựng lại từ Log)
var ROSTER_TTL = 900;           // giây; sửa tay DanhSach sẽ có hiệu lực sau tối đa 15 phút (hoặc chạy clearCache)
var MAX_SELF_REG_PER_DAY = 60;  // chặn spam form tự đăng ký
var LOG_PREALLOC_ROWS = 12000;

var TAB = { ROSTER: 'DanhSach', LOG: 'Log', SUM: 'TongHop', ATT: 'ChuyenCan' };
var SRC_ORIG = 'Danh sách gốc';       // cột Nguon của DanhSach
var SRC_SELF = 'Tự đăng ký';
var LOG_WEB = 'Web';                  // cột Nguon của Log: lượt điểm danh qua web
var LOG_ADMIN = 'Admin';              // ... do admin điểm danh bù một người
var LOG_IMPORT = 'Nhập bù';           // ... nhập bù hàng loạt (adminImport)
var SCHOOLS = ['TUAF', 'TUEBA'];
var BC_HEADERS = ['ID', 'Ho_ten', 'Truong', 'Ngay_hoc', 'Diem_danh', 'Dot'];

var ROSTER_HEADERS = ['ID học viên', 'Trường', 'Khoa', 'Đợt học', 'Họ và tên', 'Năm sinh', 'Giới tính',
  'Ngạch giảng viên', 'Bộ môn', 'Ghi chú', 'study_arm', 'Nguồn', 'ten_khong_dau', 'So_dien_thoai', 'Ngay_dang_ky'];
var LOG_HEADERS = ['Timestamp', 'Ngay', 'ID', 'Ho_ten', 'Truong', 'Khoa', 'Bo_mon', 'Dot_dang_ky',
  'Dot_hien_hanh', 'Dung_dot', 'study_arm', 'Nguon', 'Device_hash'];
var SUM_HEADERS = ['Ngay', 'Truong', 'Dot_hien_hanh', 'Tong_phai_di', 'Co_mat', 'Co_mat_dung_dot', 'Co_mat_sai_dot',
  'Tu_dang_ky', 'Vang', 'Ty_le_co_mat_dung_dot', 'Treatment_co_mat', 'Control_co_mat', 'Control_di_dot1'];
var ATT_HEADERS = ['ID', 'Ho_ten', 'Truong', 'Khoa', 'Dot_dang_ky', 'study_arm', 'So_buoi_phai_di', 'So_buoi_co_mat',
  'So_buoi_sai_dot', 'Ty_le_chuyen_can', 'Ngay_vang_gan_nhat'];

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
    else if (isAdminCall) {
      if ((a === 'adminSetSchedule' || a === 'adminGetSchedule') && !isPost)
        out = { ok: false, code: 'bad_request', message: 'Hãy sử dụng POST.' };
      else out = actionAdmin_(a, p);
    }
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
  var schedule = scheduleFor_(iso);
  var opening = timeMinutes_(schedule.openAt), closing = timeMinutes_(schedule.closeAt);
  var open = dot !== OUT_OF_DOT && !schedule.closed && mins >= opening && mins < closing;
  var message = '';
  if (!open) {
    if (dot === OUT_OF_DOT) message = 'Hiện không trong thời gian của đợt học';
    else if (schedule.closed) message = 'Admin đã đóng điểm danh ngày hôm nay';
    else if (mins < opening) message = 'Chưa đến giờ điểm danh (mở lúc ' + schedule.openAt + ')';
    else message = 'Đã hết giờ điểm danh hôm nay (đóng lúc ' + schedule.closeAt + ')';
  }
  return {
    epoch: d.getTime(), iso: iso, date: fmt_(d, 'dd/MM/yyyy'), time: fmt_(d, 'HH:mm'),
    ts: fmt_(d, 'yyyy-MM-dd HH:mm:ss'), dot: dot, open: open, message: message, fake: isFake, openAt: schedule.openAt, closeAt: schedule.closeAt
  };
}

function statusOf_(info) {
  return {
    ok: true, date: info.date, dateISO: info.iso, time: info.time, epoch: info.epoch,
    dot: info.dot, open: info.open, message: info.message, openAt: info.openAt, closeAt: info.closeAt, fake: info.fake
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
function dmyOf_(iso) { return iso.substring(8, 10) + '/' + iso.substring(5, 7) + '/' + iso.substring(0, 4); }
function bcName_(iso) { return 'BC_' + iso.substring(8, 10) + '-' + iso.substring(5, 7) + '-' + iso.substring(0, 4); }
function hasOwn_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/** Ngày trong cột Ngay của TongHop (dd/MM/yyyy, yyyy-MM-dd hoặc Date) -> yyyy-MM-dd; không hiểu thì ''. */
function sumDateIso_(v) {
  if (v instanceof Date) return fmt_(v, 'yyyy-MM-dd');
  var s = str_(v), m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// Giờ mặc định + ngoại lệ từng ngày, lưu bền vững trong Script Properties.
function timeMinutes_(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('Giờ phải có dạng HH:mm (00:00–23:59).');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function attendanceSettings_() {
  var raw = props_().getProperty('ATTENDANCE_SETTINGS');
  return raw ? JSON.parse(raw) : { default: { openAt: '08:00', closeAt: '17:00', closed: false }, dates: {} };
}
function scheduleFor_(iso) {
  var settings = attendanceSettings_();
  return settings.dates[iso] || settings.default;
}
function adminSchedule_(p) {
  return withLock_(function () {
    var settings = attendanceSettings_(), date = str_(p.date);
    if (date) {
      var parsed = parseFake_(date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parsed || fmt_(parsed, 'yyyy-MM-dd') !== date)
        throw new Error('Ngày không hợp lệ.');
    }
    if (p.reset === true) {
      if (!date) throw new Error('Chọn ngày cần khôi phục giờ mặc định.');
      delete settings.dates[date];
    } else {
      var openAt = str_(p.openAt), closeAt = str_(p.closeAt);
      if (timeMinutes_(openAt) >= timeMinutes_(closeAt)) throw new Error('Giờ đóng phải sau giờ mở trong cùng ngày.');
      var schedule = { openAt: openAt, closeAt: closeAt, closed: p.closed === true };
      if (date) settings.dates[date] = schedule; else settings.default = schedule;
    }
    // Không lưu ngoại lệ ngoài đợt để tránh nhầm với lịch phân đợt nghiên cứu.
    if (date && dotOf_(date) === OUT_OF_DOT) throw new Error('Ngày này không thuộc đợt học.');
    var encoded = JSON.stringify(settings);
    if (encoded.length > 8000) throw new Error('Quá nhiều ngày ngoại lệ. Hãy xóa các ngày không dùng.');
    props_().setProperty('ATTENDANCE_SETTINGS', encoded);
    return { ok: true, settings: settings, status: statusOf_(nowInfo_()) };
  });
}
function ensureLogDeviceColumn_(log) {
  if (log.getMaxColumns() < 13) log.insertColumnsAfter(log.getMaxColumns(), 13 - log.getMaxColumns());
  var header = str_(log.getRange(1, 13).getValue());
  if (header && header !== 'Device_hash') throw new Error('Cột M của Log đang được sử dụng; cần kiểm tra trước khi cập nhật.');
  if (!header) {
    log.getRange(1, 13).setValue('Device_hash').setFontWeight('bold').setBackground('#e8eaed');
    log.getRange(2, 13, log.getMaxRows() - 1, 1).setNumberFormat('@');
  }
}

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
      note: str_(row[9]), arm: str_(row[10]), src: str_(row[11]) || SRC_ORIG,
      phone: str_(row[13]), regDate: cellDate_(row[14])
    });
  }
  cachePutBig_(cache, 'roster', JSON.stringify(out), ROSTER_TTL);
  return out;
}

/** Xóa bộ nhớ đệm (danh sách + 'đã điểm danh' của mọi ngày trong các đợt). Chạy sau khi sửa tay DanhSach/Log. */
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
  var rows = roster.map(function (r) {         // KHÔNG phát số điện thoại, study_arm, ngày đăng ký
    return [r.id, r.name, r.school, r.khoa, r.bomon, r.dot, r.year, r.gender, r.rank, r.note];
  });
  return {
    ok: true, fields: ['id', 'name', 'school', 'khoa', 'bomon', 'dot', 'year', 'gender', 'rank', 'note'],
    rows: rows, units: unitsOf_(roster), status: statusOf_(info)
  };
}

// Mã ngẫu nhiên được lưu trong trình duyệt; server chỉ lưu SHA-256 trong Log.
function deviceHash_(p) {
  var id = str_(p.deviceId);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(id)) return '';
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, id)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function deviceError_(missing) {
  return { ok: false, code: missing ? 'device_required' : 'device_used', message: missing
    ? 'Không xác định được thiết bị. Hãy tải lại trang và cho phép trình duyệt lưu dữ liệu.'
    : 'Thiết bị này đã điểm danh hôm nay. Mỗi thiết bị chỉ được điểm danh một người mỗi ngày. Vui lòng liên hệ ban tổ chức nếu cần sửa.' };
}
function deviceOwner_(ss, iso, hash) {
  var log = ss.getSheetByName(TAB.LOG), n = log.getLastRow();
  if (n < 2 || log.getLastColumn() < 13) return '';
  var rows = log.getRange(2, 1, n - 1, 13).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (cellDate_(rows[i][1]) === iso && str_(rows[i][12]) === hash) return str_(rows[i][2]);
  }
  return '';
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
  var deviceHash = deviceHash_(p);
  if (!deviceHash) return deviceError_(true);
  var person = findPerson_(str_(p.id), false);
  if (!person) return { ok: false, code: 'notfound', message: 'Không tìm thấy học viên này trong danh sách.' };

  var ss = ss_();   // mở Spreadsheet trước khi lấy khóa để rút ngắn thời gian giữ khóa
  ss.getSheetByName(TAB.LOG);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, code: 'busy', message: 'Hệ thống đang bận, vui lòng thử lại.' };
  var ctx = ctxOfInfo_(info), res;
  try {
    info = nowInfo_(fakeOf_(p));
    if (!info.open) return closedResp_(info);
    ctx = ctxOfInfo_(info);
    res = recordCheckinLocked_(ss, person, ctx, LOG_WEB, deviceHash);
    if (res.error) return res.error;
  } finally {
    lock.releaseLock();
  }
  var out = checkinResp_(person, res, ctx);
  return out;
}

/** Gọi khi đã giữ khóa. Log là nguồn duy nhất; khóa trùng theo (Ngày, ID). */
function recordCheckinLocked_(ss, person, ctx, nguon, deviceHash) {
  if (nguon === LOG_WEB) {
    if (!deviceHash) return { error: deviceError_(true) };
    var owner = deviceOwner_(ss, ctx.iso, deviceHash);
    if (owner && owner !== person.id) return { error: deviceError_(false) };
  }
  var log = ss.getSheetByName(TAB.LOG);
  var set = checkedSet_(ctx.iso, log);
  // dòng nhập bù có Timestamp trống -> giờ là '' (falsy), nên kiểm tra theo sự tồn tại của khóa
  if (hasOwn_(set, person.id)) return { status: 'already', time: set[person.id] };
  var row = [ctx.ts, ctx.iso, person.id, person.name, person.school, person.khoa, person.bomon,
    person.dot, ctx.dot, person.dot === ctx.dot ? 1 : 0, person.arm, nguon, deviceHash || ''];
  appendLogRow_(log, row);
  set[person.id] = ctx.time;
  CacheService.getScriptCache().put('ci_' + ctx.iso, JSON.stringify(set), CHECKED_TTL);
  SpreadsheetApp.flush();
  return { status: 'ok', time: ctx.time, row: row };
}

/** Ghi 1 dòng ở dạng chữ: appendRow tự đổi chuỗi số thành số (mất số 0 đầu của điện thoại), nên đặt định dạng '@' trước. */
function appendTextRow_(sh, row) {
  var r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}

/**
 * Ghi 1 dòng vào cuối Log. KHÔNG dùng appendRow: nó bỏ qua định dạng '@' của ô và tự đổi chuỗi
 * '2026-10-17' / '2026-10-17 09:00:00' thành kiểu ngày giờ; setValues vào ô đã đặt '@' thì giữ nguyên chữ.
 */
function appendLogRow_(log, row) {
  ensureLogDeviceColumn_(log);
  var r = log.getLastRow() + 1;
  if (r > log.getMaxRows()) {
    log.insertRowsAfter(log.getMaxRows(), 500);
    log.getRange(r, 1, 500, row.length).setNumberFormat('@');
  }
  log.getRange(r, 1, 1, row.length).setValues([row]);
}

/** Ghi nhiều dòng vào cuối sheet ở dạng chữ (giữ '2026-10-10', số 0 đầu...). */
function putRows_(sh, rows) {
  if (!rows.length) return;
  var first = sh.getLastRow() + 1, need = first + rows.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(first, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}

/** Bộ nhớ đệm {ID: 'HH:mm'} của ngày; nếu mất thì dựng lại từ Log (cột Timestamp, Ngay, ID). */
function checkedSet_(iso, logSh) {
  var raw = CacheService.getScriptCache().get('ci_' + iso);
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* dựng lại */ } }
  var set = {};
  var n = logSh.getLastRow();
  if (n > 1) {
    logSh.getRange(2, 1, n - 1, 3).getValues().forEach(function (r) {
      if (cellDate_(r[1]) !== iso) return;
      var id = str_(r[2]);
      if (id) set[id] = cellTs_(r[0]).substring(11, 16);
    });
  }
  return set;
}

// ----- Tự đăng ký (ghi thẳng vào DanhSach) -----
function cleanText_(v, max) {
  return str_(v).replace(/\s+/g, ' ').replace(/^[=+\-@\s]+/, '').substring(0, max);
}

function actionRegister_(p) {
  var info = nowInfo_(fakeOf_(p));
  if (!info.open) return closedResp_(info);
  var deviceHash = deviceHash_(p);
  if (!deviceHash) return deviceError_(true);

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
    info = nowInfo_(fakeOf_(p));
    if (!info.open) return closedResp_(info);
    ctx = ctxOfInfo_(info);
    var ss = ss_();
    ensureLogDeviceColumn_(ss.getSheetByName(TAB.LOG));
    var owner = deviceOwner_(ss, ctx.iso, deviceHash);
    var roster = readRoster_(true);
    var unit = matchUnit_(roster, school, khoa);
    var nkey = noAccent_(name) + '|' + school + '|' + noAccent_(unit.khoa) + '|' + noAccent_(bomon) + '|' + year;
    for (var i = 0; i < roster.length; i++) {      // gửi lại form -> dùng lại ID cũ, không tạo người mới
      var r = roster[i];
      if (r.src === SRC_SELF && (noAccent_(r.name) + '|' + r.school + '|' + noAccent_(r.khoa) + '|' +
          noAccent_(r.bomon) + '|' + r.year) === nkey) { person = r; break; }
    }
    if (owner && (!person || owner !== person.id)) return deviceError_(false);
    if (!person) {
      if (countSelfRegToday_(roster, ctx.iso) >= MAX_SELF_REG_PER_DAY)
        return { ok: false, code: 'limit', message: 'Hôm nay đã đạt giới hạn số lượt tự đăng ký. Vui lòng liên hệ ban tổ chức.' };
      var id = nextSelfId_(school, roster);
      person = { id: id, school: school, khoa: unit.khoa, dot: dot, name: name, year: year, gender: gender,
        rank: rank, bomon: bomon, note: '', arm: unit.arm, src: SRC_SELF, phone: phone, regDate: ctx.iso };
      appendTextRow_(ss.getSheetByName(TAB.ROSTER), [id, school, unit.khoa, dot, name, year, gender, rank, bomon, '',
        unit.arm, SRC_SELF, noAccent_(name), phone, ctx.iso]);
      clearRosterCache_();
      created = true;
    }
    res = recordCheckinLocked_(ss, person, ctx, LOG_WEB, deviceHash);
    if (res.error) return res.error;
  } finally {
    lock.releaseLock();
  }
  var out = checkinResp_(person, res, ctx);
  out.registered = created;
  return out;
}

function countSelfRegToday_(roster, iso) {
  return roster.filter(function (r) { return r.src === SRC_SELF && r.regDate === iso; }).length;
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

/**
 * Thứ tự tab: BC_ của ngày mới nhất, TongHop, ChuyenCan, DanhSach, Log, các BC_ cũ hơn (ngày giảm dần),
 * cuối cùng là các tab khác (bị ẩn, không xóa). Không bao giờ làm hỏng việc tổng hợp nếu lỗi.
 */
function arrangeTabs_(ss) {
  try {
    var bc = [], fixed = {}, others = [];
    ss.getSheets().forEach(function (s) {
      var n = s.getName(), m = /^BC_(\d{2})-(\d{2})-(\d{4})$/.exec(n);
      if (m) bc.push({ s: s, key: m[3] + '-' + m[2] + '-' + m[1] });
      else if (n === TAB.SUM || n === TAB.ATT || n === TAB.ROSTER || n === TAB.LOG) fixed[n] = s;
      else others.push(s);
    });
    bc.sort(function (a, b) { return a.key < b.key ? 1 : a.key > b.key ? -1 : 0; });
    var order = [];
    if (bc.length) order.push(bc[0].s);
    [TAB.SUM, TAB.ATT, TAB.ROSTER, TAB.LOG].forEach(function (n) { if (fixed[n]) order.push(fixed[n]); });
    bc.slice(1).forEach(function (b) { order.push(b.s); });
    others.forEach(function (s) { order.push(s); });
    order.forEach(function (s) { if (s.isSheetHidden && s.isSheetHidden()) s.showSheet(); });   // tab ẩn không kích hoạt/di chuyển được
    order.forEach(function (s, i) {
      if (s.getIndex() !== i + 1) { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
    });
    if (order.length) ss.setActiveSheet(order[0]);
    others.forEach(function (s) { if (!s.isSheetHidden()) s.hideSheet(); });
  } catch (e) {
    console.error('arrangeTabs_ lỗi (bỏ qua): ' + e);
  }
}

// ===================== Tổng hợp 17:00 =====================
/** Trigger hằng ngày (17:00–18:00 giờ VN). */
function dailySummaryTrigger() { return buildDailySummary(); }

/**
 * Tổng hợp một ngày: (1) tạo / ghi đè BC_dd-MM-yyyy, (2) ghi / ghi đè các dòng của ngày đó trong TongHop,
 * (3) tính lại toàn bộ ChuyenCan. Chạy tay được cho mọi ngày: buildDailySummary('2026-10-12').
 * Trường có lớp trong ngày = trường có ít nhất 1 lượt điểm danh ngày đó; trường không có lớp không bị tính vắng.
 * Nếu ngày không còn lượt điểm danh nào của TUAF/TUEBA thì BC_ và các dòng TongHop của ngày đó bị gỡ.
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

/** Đợt 0: không thuộc mẫu báo cáo; giữ nguyên DanhSach và Log gốc. */
function reportData_(roster, log) {
  var excluded = {};
  roster.forEach(function (p) { if (str_(p.dot) === 'Đợt 0') excluded[p.id] = true; });
  return {
    roster: roster.filter(function (p) { return !hasOwn_(excluded, p.id); }),
    log: log.filter(function (l) { return !hasOwn_(excluded, l.id); })
  };
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
    khoa: str_(r[5]), bomon: str_(r[6]), dotReg: str_(r[7]), dotNow: str_(r[8]), arm: str_(r[10]), src: str_(r[11]) };
}

function cmpId_(a, b) {
  var sa = /-N\d+$/.test(a.id) ? 1 : 0, sb = /-N\d+$/.test(b.id) ? 1 : 0;
  return sa - sb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function dotNum_(name) { return name === 'Đợt 1' ? 1 : name === 'Đợt 2' ? 2 : ''; }

function buildDailySummaryLocked_(dateStr, dot) {
  var ss = ss_();
  var data = reportData_(readRoster_(true), readLog_(ss));
  var roster = data.roster;
  var byId = {};
  roster.forEach(function (r) { byId[r.id] = r; });
  var log = data.log;

  // Lượt điểm danh trong ngày của TUAF / TUEBA (mỗi ID một lần, lấy lần sớm nhất)
  var today = [], seen = {};
  log.filter(function (l) { return l.date === dateStr && SCHOOLS.indexOf(l.school) >= 0; })
    .sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; })
    .forEach(function (l) { if (!seen[l.id]) { seen[l.id] = true; today.push(l); } });

  if (!today.length) {                       // không còn ai điểm danh: gỡ báo cáo của ngày (nếu có)
    var removed = removeDaySummary_(ss, dateStr);
    writeAttendance_(ss, roster, log);
    arrangeTabs_(ss);
    return { ok: true, skipped: 'Không có lượt điểm danh nào trong ngày ' + dateStr + '.', removed: removed };
  }

  // Nguồn của người học (Danh sách gốc / Tự đăng ký): lấy từ DanhSach
  today.forEach(function (l) { var p = byId[l.id]; l.person = p || null; l.isSelf = p ? p.src === SRC_SELF : /-N\d+$/.test(l.id); });

  // Trường có lớp hôm nay = có ít nhất 1 lượt điểm danh
  var classSet = {};
  today.forEach(function (l) { classSet[l.school] = true; });
  var classSchools = SCHOOLS.filter(function (s) { return classSet[s]; });

  // Đáng lẽ phải đi = thuộc đợt hiện hành + trường có lớp + đã có tên trong danh sách vào ngày đó
  // (người tự đăng ký sau ngày này không bị tính vắng ngày này, để số liệu ngày cũ không đổi khi tổng hợp lại)
  var expected = function (r) { return r.dot === dot && classSet[r.school] && (!r.regDate || r.regDate <= dateStr || seen[r.id]); };
  var inDot = roster.filter(expected);
  var stats = {}, sumRows = [];
  var ctrlD1Today = function (l) { return dot === 'Đợt 1' && l.arm === 'Control'; };
  classSchools.forEach(function (sc) {
    var att = today.filter(function (l) { return l.school === sc; });
    var exp = inDot.filter(function (r) { return r.school === sc; });
    var right = att.filter(function (l) { return l.dotReg === dot; }).length;
    var wrong = att.length - right;
    var absent = exp.filter(function (r) { return !seen[r.id]; }).length;
    stats[sc] = { phai: exp.length, dung: right, sai: wrong, vang: absent };
    sumRows.push([dmyOf_(dateStr), sc, dot, exp.length, att.length, right, wrong,
      att.filter(function (l) { return l.isSelf; }).length, absent, exp.length ? right / exp.length : '',
      att.filter(function (l) { return l.arm === 'Treatment'; }).length,
      att.filter(function (l) { return l.arm === 'Control'; }).length,
      dot === 'Đợt 1' ? att.filter(ctrlD1Today).length : '']);
  });

  var bc = writeBaoCao_(ss, dateStr, dot, roster.filter(function (r) { return r.regDate <= dateStr || !r.regDate || seen[r.id]; }), today, seen, classSet, stats);
  writeSummaryRows_(ss, dateStr, sumRows);
  writeAttendance_(ss, roster, log);
  arrangeTabs_(ss);
  return { ok: true, bcSheet: bc.sheet, present: today.length, classSchools: classSchools, stats: stats,
    absent: classSchools.reduce(function (a, s) { return a + stats[s].vang; }, 0),
    wrongDot: classSchools.reduce(function (a, s) { return a + stats[s].sai; }, 0),
    selfRegistered: today.filter(function (l) { return l.isSelf; }).length, bc: bc };
}

/** Gỡ BC_ và các dòng TongHop của một ngày. Trả về {bc: bool, sumRows: n}. */
function removeDaySummary_(ss, dateStr) {
  var res = { bc: false, sumRows: 0 };
  var bc = ss.getSheetByName(bcName_(dateStr));
  if (bc) { ss.deleteSheet(bc); res.bc = true; }
  var sh = ss.getSheetByName(TAB.SUM);
  if (sh && sh.getLastRow() > 1) {
    var keep = [], n = sh.getLastRow() - 1;
    sh.getRange(2, 1, n, SUM_HEADERS.length).getValues().forEach(function (r) {
      if (sumDateIso_(r[0]) === dateStr) res.sumRows++; else keep.push(r);
    });
    if (res.sumRows) {
      sh.getRange(2, 1, n, SUM_HEADERS.length).clearContent();
      if (keep.length) {
        sh.getRange(2, 1, keep.length, 1).setNumberFormat('@');
        sh.getRange(2, 1, keep.length, SUM_HEADERS.length).setValues(keep);
      }
    }
  }
  return res;
}

/**
 * Ghi các dòng (Ngày, Trường có lớp) của một ngày vào TongHop: thay các dòng cũ của ngày đó, giữ các ngày khác,
 * sắp ngày mới nhất lên đầu (trong ngày: TUAF trước TUEBA).
 */
function writeSummaryRows_(ss, dateStr, newRows) {
  var sh = ss.getSheetByName(TAB.SUM) || makeTab_(ss, TAB.SUM, SUM_HEADERS, false, 0);
  var n = sh.getLastRow(), existing = [];
  if (n >= 2) {
    sh.getRange(2, 1, n - 1, SUM_HEADERS.length).getValues().forEach(function (r) {
      var iso = sumDateIso_(r[0]);
      if (iso && iso !== dateStr) { r[0] = dmyOf_(iso); existing.push(r); }
    });
  }
  var all = existing.concat(newRows);
  all.sort(function (a, b) {
    var da = sumDateIso_(a[0]), db = sumDateIso_(b[0]);
    if (da !== db) return da < db ? 1 : -1;
    return SCHOOLS.indexOf(a[1]) - SCHOOLS.indexOf(b[1]);
  });
  if (n >= 2) sh.getRange(2, 1, n - 1, SUM_HEADERS.length).clearContent();
  if (!all.length) return;
  if (sh.getMaxRows() < all.length + 1) sh.insertRowsAfter(sh.getMaxRows(), all.length + 1 - sh.getMaxRows());
  sh.getRange(2, 1, all.length, 1).setNumberFormat('@');       // 11/10/2026 giữ dạng chữ, không bị hiểu là ngày tháng Mỹ
  sh.getRange(2, 1, all.length, SUM_HEADERS.length).setValues(all);
  sh.getRange(2, 10, all.length, 1).setNumberFormat('0.0%');
  sh.setFrozenRows(1);
  fitColumns_(sh, SUM_HEADERS.length);
}

/** Các ngày lớp học đã được tổng hợp: {byKey: {'TUAF|Đợt 1': ['yyyy-MM-dd', ...]}, bySchool: {TUAF: {iso: true}}}. */
function readClassDays_(ss) {
  var out = { byKey: {}, bySchool: {} }, sh = ss.getSheetByName(TAB.SUM);
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    var iso = sumDateIso_(r[0]), sc = str_(r[1]), dot = str_(r[2]) || dotOf_(iso);
    if (!iso || !sc) return;
    var k = sc + '|' + dot;
    (out.byKey[k] = out.byKey[k] || []).push(iso);
    (out.bySchool[sc] = out.bySchool[sc] || {})[iso] = true;
  });
  Object.keys(out.byKey).forEach(function (k) { out.byKey[k].sort(); });
  return out;
}

/**
 * ChuyenCan: mỗi học viên một dòng. Số buổi phải đi = số ngày (đã có trong TongHop) thuộc đợt của người đó mà
 * trường của người đó có lớp. Số buổi sai đợt = số ngày đã tổng hợp mà người đó có mặt ở đợt khác đợt đăng ký.
 */
function writeAttendance_(ss, roster, log) {
  var data = reportData_(roster, log);
  roster = data.roster;
  log = data.log;
  var cd = readClassDays_(ss), attended = {};
  log.forEach(function (l) { (attended[l.id] = attended[l.id] || {})[l.date] = true; });
  var rows = roster.map(function (p) {
    var a = attended[p.id] || {};
    // buổi phải đi: chỉ tính từ ngày người đó có tên trong danh sách (người tự đăng ký: từ Ngay_dang_ky)
    var days = (cd.byKey[p.school + '|' + p.dot] || []).filter(function (d) { return !p.regDate || d >= p.regDate; });
    var own = 0, lastAbsent = '', wrong = 0;
    days.forEach(function (d) { if (a[d]) own++; else lastAbsent = d; });
    var school = cd.bySchool[p.school] || {};
    Object.keys(a).forEach(function (d) { if (school[d] && dotOf_(d) !== p.dot) wrong++; });
    return [p.id, p.name, p.school, p.khoa, p.dot, p.arm, days.length, own, wrong,
      days.length ? own / days.length : '', lastAbsent ? dmyOf_(lastAbsent) : ''];
  });
  var sh = ss.getSheetByName(TAB.ATT) || makeTab_(ss, TAB.ATT, ATT_HEADERS, false, 0);
  var f = sh.getFilter && sh.getFilter();
  if (f) f.remove();
  sh.clear();
  if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
  sh.getRange(1, 1, 1, ATT_HEADERS.length).setValues([ATT_HEADERS]).setFontWeight('bold').setBackground('#e8eaed');
  if (rows.length) {
    sh.getRange(2, 11, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, ATT_HEADERS.length).setValues(rows);
    sh.getRange(2, 10, rows.length, 1).setNumberFormat('0.0%');
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, rows.length + 1, ATT_HEADERS.length).createFilter();   // bật sẵn bộ lọc để lọc người vắng nhiều
  fitColumns_(sh, ATT_HEADERS.length);
}

/** Tự giãn độ rộng n cột đầu (autoResize hay đo hẹp nên cộng thêm đệm). */
function fitColumns_(sh, n) {
  try {
    sh.autoResizeColumns(1, n);
    for (var c = 1; c <= n; c++) sh.setColumnWidth(c, sh.getColumnWidth(c) + 18);
  } catch (e) { /* chỉ là trang trí */ }
}

function rebuildAttendance_() {
  var ss = ss_();
  writeAttendance_(ss, readRoster_(true), readLog_(ss));
}

/**
 * Sheet báo cáo cho sếp BC_dd-MM-yyyy (giá trị tĩnh, ghi đè nếu đã có).
 * Khối 1: học viên thuộc đợt hiện hành của các trường có lớp (Y/N); Khối 2: người có mặt nhưng không thuộc đợt hiện hành (luôn Y).
 * Sắp xếp: Trường (TUAF trước) > Khối 1 trước Khối 2 > ID tăng dần (ID tự đăng ký xếp cuối).
 * Dòng N tô nền đỏ nhạt; dòng khối sai đợt tô nền vàng nhạt. Bảng đếm ở N3; bảng chỉ tiêu nhỏ ở N9.
 */
function writeBaoCao_(ss, dateStr, dot, roster, today, seen, classSet, stats) {
  var dmy = dmyOf_(dateStr), dn = dotNum_(dot), byId = {}, rows = [], kind = [];
  roster.forEach(function (r) { byId[r.id] = r; });
  SCHOOLS.forEach(function (sc) {
    if (!classSet[sc]) return;
    var inBlock1 = {};
    roster.filter(function (r) { return r.school === sc && r.dot === dot; }).sort(cmpId_).forEach(function (r) {
      inBlock1[r.id] = true;
      rows.push([r.id, r.name, sc, dmy, seen[r.id] ? 'Y' : 'N', dn]);
      kind.push(seen[r.id] ? 'Y' : 'N');
    });
    today.filter(function (l) { return l.school === sc && !inBlock1[l.id]; }).sort(cmpId_).forEach(function (l) {
      rows.push([l.id, byId[l.id] ? byId[l.id].name : l.name, sc, dmy, 'Y', dotNum_(byId[l.id] ? byId[l.id].dot : l.dotReg)]);
      kind.push('W');
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
  sh.getRange(2, 1, n, BC_HEADERS.length).setBackgrounds(kind.map(function (k) {
    var c = k === 'N' ? '#fdecea' : k === 'W' ? '#fff8e1' : '#ffffff';
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

  // Bảng chỉ tiêu nhỏ (ô N9): chỉ hiện cột của trường có lớp, cột cuối là Tổng
  var cols = SCHOOLS.filter(function (sc) { return classSet[sc]; });
  var sum = function (key) { return cols.reduce(function (a, sc) { return a + stats[sc][key]; }, 0); };
  var ratio = function (a, b) { return b ? a / b : ''; };
  var tbl = [
    ['Chỉ tiêu'].concat(cols, ['Tổng']),
    ['Phải đi (đúng đợt)'].concat(cols.map(function (sc) { return stats[sc].phai; }), [sum('phai')]),
    ['Có mặt đúng đợt'].concat(cols.map(function (sc) { return stats[sc].dung; }), [sum('dung')]),
    ['Có mặt sai đợt'].concat(cols.map(function (sc) { return stats[sc].sai; }), [sum('sai')]),
    ['Vắng'].concat(cols.map(function (sc) { return stats[sc].vang; }), [sum('vang')]),
    ['Tỷ lệ có mặt đúng đợt'].concat(cols.map(function (sc) { return ratio(stats[sc].dung, stats[sc].phai); }),
      [ratio(sum('dung'), sum('phai'))])
  ];
  sh.getRange(9, 14, tbl.length, cols.length + 2).setValues(tbl);
  sh.getRange(9, 14, 1, cols.length + 2).setFontWeight('bold').setBackground('#e8eaed');
  sh.getRange(14, 15, 1, cols.length + 1).setNumberFormat('0.0%');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, BC_HEADERS.length);
  sh.autoResizeColumns(14, cols.length + 2);
  BC_HEADERS.map(function (h, i) { return i + 1; }).concat([14, 15]).forEach(function (c) {
    sh.setColumnWidth(c, sh.getColumnWidth(c) + 18);   // autoResize hay đo hẹp, chữ in đậm bị cắt
  });
  for (var c2 = 16; c2 < 14 + cols.length + 2; c2++) sh.setColumnWidth(c2, sh.getColumnWidth(c2) + 18);
  var yes = rows.filter(function (x) { return x[4] === 'Y'; }).length;
  return { sheet: name, rows: n, y: yes, n: rows.filter(function (x) { return x[4] === 'N'; }).length, counts: pivot };
}

// ===================== Admin =====================
function isAdmin_(p) {
  var k = props_().getProperty('ADMIN_KEY');
  return !!k && !!p && String(p.key || '') === k;
}

function actionAdmin_(action, p) {
  if (!isAdmin_(p)) return { ok: false, code: 'forbidden', message: 'Sai khóa quản trị.' };
  switch (action) {
    case 'adminGetSchedule': return { ok: true, settings: attendanceSettings_(), status: statusOf_(nowInfo_()) };
    case 'adminSetSchedule': return adminSchedule_(p);
    case 'adminDelete': return adminDelete(normDate_(p.date), str_(p.id));
    case 'adminCheckin': return adminCheckin(normDate_(p.date), str_(p.id));
    case 'adminSummary': return adminSummary(normDate_(p.date));
    case 'adminImport': return adminImport(p.items);
    case 'adminExport': return adminExport(str_(p.sheet) || TAB.ROSTER);
    case 'adminRemovePerson': return adminRemovePerson(str_(p.id));
    case 'adminDeleteTab': return adminDeleteTab(str_(p.name));
    case 'adminDeleteDay': return adminDeleteDay(normDate_(p.date), str_(p.confirm));
    case 'adminRebuild': rebuildAttendance_(); return { ok: true };
    case 'adminClearCache': return clearCache();
    case 'adminFake': return { ok: true, status: statusOf_(testMode(str_(p.value))) };
    case 'adminDebug': return adminDebug();
    case 'adminSetup': return { ok: true, log: setup() };
    case 'adminMigrate': return migrateV3_();
    case 'adminMigrateCleanup': return migrateV3Cleanup_(str_(p.confirm));
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

/**
 * Sau khi sửa dữ liệu của một ngày: nếu ngày đã qua (hoặc đã có BC_ của ngày đó) thì tổng hợp lại ngay;
 * ngày hôm nay chưa tổng hợp thì để trigger 17:00 làm.
 */
function afterEdit_(date) {
  if (date < nowInfo_().iso || ss_().getSheetByName(bcName_(date))) return buildDailySummary(date);
  return { skipped: 'Ngày ' + date + ' chưa qua, sẽ tổng hợp lúc 17:00.' };
}

function adminDelete(date, id) {
  date = normDate_(date);
  var res = withLock_(function () {
    var ss = ss_(), log = ss.getSheetByName(TAB.LOG), nLog = 0;
    if (log && log.getLastRow() > 1) {
      var v = log.getRange(2, 2, log.getLastRow() - 1, 2).getValues();
      for (var i = v.length - 1; i >= 0; i--) {
        if (cellDate_(v[i][0]) === date && str_(v[i][1]) === id) { log.deleteRow(i + 2); nLog++; }
      }
    }
    CacheService.getScriptCache().remove('ci_' + date);
    return { ok: true, deletedLog: nLog };
  });
  if (res.deletedLog) res.summary = afterEdit_(date);
  return res;
}

function adminCheckin(date, id) {
  date = normDate_(date);
  var person = findPerson_(id, true);
  if (!person) throw new Error('Không có ID ' + id + ' trong DanhSach.');
  var now = nowInfo_();
  var ctx = { iso: date, date: dmyOf_(date), dot: dotOf_(date), ts: now.ts, time: now.time };
  var res = withLock_(function () {
    var r = recordCheckinLocked_(ss_(), person, ctx, LOG_ADMIN);
    return { ok: true, status: r.status, time: r.time, date: date, dot: ctx.dot };
  });
  if (res.status === 'ok') res.summary = afterEdit_(date);
  return res;
}

function adminSummary(date) { return buildDailySummary(normDate_(date)); }

/**
 * Nhập bù lượt điểm danh: items = [{date:'yyyy-MM-dd', id:'<ID học viên>'}, ...].
 * Toàn bộ yêu cầu bị từ chối nếu có ngày ngoài đợt / ID không có trong DanhSach (không ghi gì).
 * Bỏ qua lượt đã có (khóa Ngày + ID) nên chạy lại không bị trùng. Dòng ghi vào Log với Timestamp trống, Nguon = 'Nhập bù'.
 * Xong thì tổng hợp lại các ngày đã qua có thêm dữ liệu.
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
  var res = withLock_(function () {
    var ss = ss_(), log = ss.getSheetByName(TAB.LOG), have = {}, rows = [];
    var out = { ok: true, received: items.length, added: 0, skipped: items.length - clean.length, byDate: {} };
    if (log.getLastRow() > 1) {
      log.getRange(2, 2, log.getLastRow() - 1, 2).getValues().forEach(function (r) { have[cellDate_(r[0]) + '|' + str_(r[1])] = true; });
    }
    clean.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    clean.forEach(function (c) {
      var p = c.person, dotNow = dotOf_(c.date), k = c.date + '|' + p.id;
      out.byDate[c.date] = out.byDate[c.date] || 0;
      if (have[k]) { out.skipped++; return; }
      have[k] = true;
      rows.push(['', c.date, p.id, p.name, p.school, p.khoa, p.bomon, p.dot, dotNow, p.dot === dotNow ? 1 : 0, p.arm, LOG_IMPORT]);
      out.byDate[c.date]++;
      out.added++;
    });
    putRows_(log, rows);
    Object.keys(out.byDate).forEach(function (d) { CacheService.getScriptCache().remove('ci_' + d); });
    SpreadsheetApp.flush();
    return out;
  });
  res.summaries = {};
  Object.keys(res.byDate).sort().forEach(function (d) {
    if (res.byDate[d] > 0) res.summaries[d] = afterEdit_(d);
  });
  return res;
}

function adminExport(name) {
  if ([TAB.ROSTER, TAB.LOG, TAB.SUM, TAB.ATT].indexOf(name) < 0 && !/^BC_\d{2}-\d{2}-\d{4}$/.test(name))
    throw new Error('Tab không được phép xuất: ' + name);
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Không có tab ' + name);
  var v = sh.getDataRange().getValues();
  return { ok: true, headers: v[0].map(String), rows: v.slice(1).map(function (r) { return r.map(function (c) { return str_(c); }); }) };
}

function adminDeleteTab(name) {
  if (!/^BC_\d{2}-\d{2}-\d{4}$/.test(name) && !/^(TH|DD)_\d{4}-\d{2}-\d{2}$/.test(name))
    throw new Error('Chỉ được xóa tab BC_dd-MM-yyyy (hoặc TH_/DD_ cũ).');
  return withLock_(function () {
    var ss = ss_(), sh = ss.getSheetByName(name);
    if (!sh) return { ok: true, deleted: false };
    ss.deleteSheet(sh);
    return { ok: true, deleted: true };
  });
}

/**
 * Xóa toàn bộ điểm danh của một ngày: các dòng của ngày đó trong Log, tab BC_ và các dòng TongHop của ngày;
 * rồi tính lại ChuyenCan. Cần confirm='yes'. Dùng để dọn dữ liệu thử.
 */
function adminDeleteDay(date, confirm) {
  date = normDate_(date);
  if (confirm !== 'yes') throw new Error("Thao tác xóa cả ngày: cần thêm confirm=yes.");
  var res = withLock_(function () {
    var ss = ss_(), r = { ok: true, date: date, logRows: 0 };
    var log = ss.getSheetByName(TAB.LOG);
    if (log && log.getLastRow() > 1) {
      var v = log.getRange(2, 2, log.getLastRow() - 1, 1).getValues();
      var i = v.length - 1;
      while (i >= 0) {                                  // xóa theo từng đoạn liên tiếp, từ dưới lên
        if (cellDate_(v[i][0]) !== date) { i--; continue; }
        var end = i;
        while (i >= 0 && cellDate_(v[i][0]) === date) i--;
        log.deleteRows(i + 3, end - i);
        r.logRows += end - i;
      }
    }
    CacheService.getScriptCache().remove('ci_' + date);
    return r;
  });
  var s = buildDailySummary(date);       // không còn lượt nào -> gỡ BC_ + TongHop của ngày, tính lại ChuyenCan
  res.removed = s.removed || null;
  return res;
}

/** Xóa HẲN một người tự đăng ký (ID dạng TUAF-N001) khỏi DanhSach và Log; đặt lại bộ đếm; tổng hợp lại các ngày bị ảnh hưởng. */
function adminRemovePerson(id) {
  var m = /^(TUAF|TUEBA)-N\d+$/.exec(id);
  if (!m) throw new Error('Chỉ xóa được ID tự đăng ký (dạng TUAF-N001).');
  var dates = {};
  var res = withLock_(function () {
    var ss = ss_(), r = { ok: true, danhSach: 0, log: 0, counter: 0 };
    var same = function (v) { return str_(v) === id; };
    var log = ss.getSheetByName(TAB.LOG);
    if (log && log.getLastRow() > 1) {
      var v = log.getRange(2, 2, log.getLastRow() - 1, 2).getValues();
      for (var i = v.length - 1; i >= 0; i--) {
        if (str_(v[i][1]) === id) { dates[cellDate_(v[i][0])] = true; log.deleteRow(i + 2); r.log++; }
      }
    }
    r.danhSach = deleteRowsWhere_(ss.getSheetByName(TAB.ROSTER), 1, same);
    Object.keys(dates).forEach(function (d) { CacheService.getScriptCache().remove('ci_' + d); });
    // Đặt lại bộ đếm = số lớn nhất còn lại
    var re = new RegExp('^' + m[1] + '-N(\\d+)$'), max = 0;
    readRoster_(true).forEach(function (x) { var q = re.exec(x.id); if (q) max = Math.max(max, Number(q[1])); });
    if (max) props_().setProperty('NCOUNT_' + m[1], String(max)); else props_().deleteProperty('NCOUNT_' + m[1]);
    clearRosterCache_();
    r.counter = max;
    return r;
  });
  var ds = Object.keys(dates).sort();
  if (ds.length) ds.forEach(function (d) { buildDailySummary(d); });
  else withLock_(rebuildAttendance_);
  res.resummarized = ds;
  return res;
}

function adminDebug() {
  var ss = ss_();
  var p = props_();
  return {
    ok: true,
    tabs: ss.getSheets().map(function (s) { return { name: s.getName(), rows: s.getLastRow(), hidden: s.isSheetHidden ? s.isSheetHidden() : false }; }),
    fakeNow: p.getProperty('FAKE_NOW') || null,
    sheetTimeZone: ss.getSpreadsheetTimeZone(),
    scriptTimeZone: TZ,
    counters: { TUAF: p.getProperty('NCOUNT_TUAF'), TUEBA: p.getProperty('NCOUNT_TUEBA') },
    triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
    logFormats: logFormatSample_(ss)
  };
}

/** Định dạng số của vài ô trong Log (cột Timestamp, Ngay): để kiểm tra các dòng mới có giữ dạng chữ '@' không. */
function logFormatSample_(ss) {
  var sh = ss.getSheetByName(TAB.LOG);
  if (!sh) return null;
  var last = sh.getLastRow(), out = {};
  [2, last, last + 1, last + 2, 1000, 5000, 11999].forEach(function (r) {
    if (r >= 1 && r <= sh.getMaxRows()) out['row' + r] = [sh.getRange(r, 1).getNumberFormat(), sh.getRange(r, 2).getNumberFormat()];
  });
  out.maxRows = sh.getMaxRows();
  out.maxCols = sh.getMaxColumns();
  return out;
}

// ===================== setup() =====================
/**
 * Chạy MỘT LẦN từ trình soạn thảo (an toàn khi chạy lại, không ghi đè dữ liệu): tạo tab còn thiếu, thêm cột còn thiếu
 * cho DanhSach, nạp danh sách từ RosterData.gs, tạo trigger 17:00, tạo ADMIN_KEY (nếu chưa có), sắp xếp tab.
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
  ensureTab_(ss, TAB.LOG, LOG_HEADERS, true, LOG_PREALLOC_ROWS, log);
  ensureTab_(ss, TAB.SUM, SUM_HEADERS, false, 0, log);
  ensureTab_(ss, TAB.ATT, ATT_HEADERS, false, 0, log);
  ensureLogDeviceColumn_(ss.getSheetByName(TAB.LOG));
  ensureRosterColumns_(ss, log);
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
  arrangeTabs_(ss);
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

/** Thêm cột còn thiếu (So_dien_thoai, Ngay_dang_ky) vào cuối tiêu đề DanhSach; không đụng vào dữ liệu. */
function ensureRosterColumns_(ss, log) {
  var sh = ss.getSheetByName(TAB.ROSTER);
  if (!sh || sh.getLastRow() === 0) return;
  var need = ROSTER_HEADERS.length;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  var cur = sh.getRange(1, 1, 1, need).getValues()[0], added = [];
  for (var i = 13; i < need; i++) {
    if (!str_(cur[i])) {
      sh.getRange(1, i + 1).setNumberFormat('@').setValue(ROSTER_HEADERS[i]).setFontWeight('bold').setBackground('#e8eaed');
      sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
      added.push(ROSTER_HEADERS[i]);
    }
  }
  if (log && added.length) log.push('DanhSach: thêm cột ' + added.join(', '));
}

function loadRosterData_(ss, log) {
  if (typeof ROSTER_DATA === 'undefined') throw new Error('Thiếu RosterData.gs (chạy prepare_roster.py rồi clasp push).');
  var sh = ss.getSheetByName(TAB.ROSTER);
  var have = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { have[str_(r[0])] = true; });
  var add = ROSTER_DATA.filter(function (r) { return !have[r[0]]; }).map(function (r) {
    return [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], SRC_ORIG, noAccent_(r[4]), '', ''];
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
