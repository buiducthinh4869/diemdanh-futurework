/**
 * Chuyển dữ liệu từ cấu trúc v2 (DD_, TH_, TuDangKy, TongHop_LuyKe, Log 13 cột) sang v3
 * (DanhSach, Log, TongHop, ChuyenCan + BC_ mỗi ngày). Chạy MỘT lần, qua admin:
 *
 *   adminMigrate                       -> KHÔNG xóa gì: chuyển Log sang định dạng mới, bổ sung Log từ DD_, chuyển
 *                                         TuDangKy vào DanhSach, tổng hợp lại mọi ngày (BC_, TongHop, ChuyenCan)
 *   adminMigrateCleanup&confirm=yes    -> chỉ sau khi đã đối chiếu: xóa DD_*, TH_*, TuDangKy, TongHop_LuyKe
 *                                         (tự kiểm tra lại điều kiện; không đạt thì không xóa gì)
 *
 * Chạy lại an toàn (không trùng dòng). Có thể xóa file này sau khi đã chuyển xong.
 */

var V2_LOG_NOTE_COL = 13;

/** Dòng cũ (Log / DD_ 13 cột) -> dòng Log mới 12 cột. */
function migrateLogRow_(r) {
  var orig = str_(r[11]), note = str_(r[12]);
  var nguon = note === 'admin' ? LOG_ADMIN : (!orig || orig === SRC_ORIG || orig === SRC_SELF) ? LOG_WEB : orig;
  return [cellTs_(r[0]), cellDate_(r[1]), str_(r[2]), str_(r[3]), str_(r[4]), str_(r[5]), str_(r[6]), str_(r[7]),
    str_(r[8]), r[9], str_(r[10]), nguon];
}

function logKeys_(log) {
  var keys = {};
  if (log && log.getLastRow() > 1) {
    log.getRange(2, 2, log.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (str_(r[1])) keys[cellDate_(r[0]) + '|' + str_(r[1])] = true;
    });
  }
  return keys;
}

function migrateV3_() {
  var rep = withLock_(migrateDataLocked_);
  rep.summaries = [];
  rep.dates.forEach(function (d) {
    var s = buildDailySummary(d);      // BC_ + TongHop + ChuyenCan
    rep.summaries.push({ date: d, present: s.present, classSchools: s.classSchools, bc: s.bc && s.bc.rows });
  });
  if (!rep.dates.length) withLock_(rebuildAttendance_);
  rep.ok = true;
  return rep;
}

function migrateDataLocked_() {
  var ss = ss_(), rep = { log: {}, dd: {}, reg: {}, dates: [] }, tmp = [];
  ensureTab_(ss, TAB.SUM, SUM_HEADERS, false, 0, tmp);
  ensureTab_(ss, TAB.ATT, ATT_HEADERS, false, 0, tmp);
  ensureRosterColumns_(ss, tmp);

  // 1. Log: 13 cột (Ho ten, ..., Ghi chu) -> 12 cột (Ho_ten, ..., Nguon = Web/Admin/Nhập bù)
  var log = ss.getSheetByName(TAB.LOG);
  var h = log.getRange(1, 1, 1, Math.min(13, log.getMaxColumns())).getValues()[0];
  var isOld = str_(h[3]) === 'Ho ten' || str_(h[12]) === 'Ghi chu';
  rep.log.alreadyNewFormat = !isOld;
  if (isOld) {
    var n = log.getLastRow() - 1;
    var rows = n > 0 ? log.getRange(2, 1, n, 13).getValues().filter(function (r) { return str_(r[2]); }).map(migrateLogRow_) : [];
    if (n > 0) log.getRange(2, 1, n, 13).clearContent();
    log.getRange(1, 1, 1, LOG_HEADERS.length).setNumberFormat('@').setValues([LOG_HEADERS]).setFontWeight('bold').setBackground('#e8eaed');
    if (rows.length) log.getRange(2, 1, rows.length, LOG_HEADERS.length).setNumberFormat('@').setValues(rows);
    if (log.getMaxColumns() >= V2_LOG_NOTE_COL) { log.getRange(1, V2_LOG_NOTE_COL).clearContent(); log.deleteColumn(V2_LOG_NOTE_COL); }
    log.setFrozenRows(1);
    rep.log.rows = rows.length;
  }

  // 2. Đối chiếu DD_*: mọi dòng phải có trong Log (theo Ngay + ID); thiếu thì bổ sung
  var have = logKeys_(log), add = [], checked = 0;
  var dd = ss.getSheets().filter(function (s) { return /^DD_\d{4}-\d{2}-\d{2}$/.test(s.getName()); });
  dd.forEach(function (s) {
    if (s.getLastRow() < 2) return;
    s.getRange(2, 1, s.getLastRow() - 1, 13).getValues().forEach(function (r) {
      var id = str_(r[2]);
      if (!id) return;
      checked++;
      var k = cellDate_(r[1]) + '|' + id;
      if (!have[k]) { have[k] = true; add.push(migrateLogRow_(r)); }
    });
  });
  putRows_(log, add);
  rep.dd = { tabs: dd.length, rowsChecked: checked, rowsAdded: add.length };

  // 3. TuDangKy -> DanhSach (giữ nguyên ID đã cấp; chưa có thì thêm, có rồi thì chỉ bổ sung điện thoại/ngày đăng ký còn trống)
  var reg = ss.getSheetByName('TuDangKy'), ros = ss.getSheetByName(TAB.ROSTER);
  var rpos = {}, moved = 0, filled = 0, radd = [];
  if (ros.getLastRow() > 1) ros.getRange(2, 1, ros.getLastRow() - 1, 1).getValues().forEach(function (r, i) { rpos[str_(r[0])] = i + 2; });
  if (reg && reg.getLastRow() > 1) {
    reg.getRange(2, 1, reg.getLastRow() - 1, 13).getValues().forEach(function (r) {
      var id = str_(r[2]);
      if (!id) return;
      var phone = str_(r[11]), rd = cellDate_(r[1]);
      if (rpos[id]) {
        var cells = ros.getRange(rpos[id], 14, 1, 2), cur = cells.getValues()[0];
        if (!str_(cur[0]) && phone || !str_(cur[1]) && rd) {
          cells.setNumberFormat('@').setValues([[str_(cur[0]) || phone, str_(cur[1]) || rd]]);
          filled++;
        }
      } else {
        rpos[id] = -1;
        radd.push([id, str_(r[4]), str_(r[5]), str_(r[7]), str_(r[3]), str_(r[8]), str_(r[9]), str_(r[10]), str_(r[6]), '',
          str_(r[12]), SRC_SELF, noAccent_(str_(r[3])), phone, rd]);
        moved++;
      }
    });
    putRows_(ros, radd);
  }
  rep.reg = { rowsMoved: moved, rowsFilled: filled };
  clearRosterCache_();
  CacheService.getScriptCache().removeAll(['ci_' + nowInfo_().iso]);

  // 4. Các ngày đã có dữ liệu (TUAF/TUEBA)
  var dates = {};
  readLog_(ss).forEach(function (l) { if (SCHOOLS.indexOf(l.school) >= 0 && l.date) dates[l.date] = true; });
  rep.dates = Object.keys(dates).sort();
  return rep;
}

/** Xóa DD_*, TH_*, TuDangKy, TongHop_LuyKe - CHỈ khi mọi điều kiện đối chiếu đều đạt. */
function migrateV3Cleanup_(confirm) {
  if (confirm !== 'yes') throw new Error('Cần confirm=yes.');
  return withLock_(function () {
    var ss = ss_(), problems = [];
    var log = ss.getSheetByName(TAB.LOG);
    if (str_(log.getRange(1, 4).getValue()) !== 'Ho_ten') problems.push('Log chưa ở định dạng mới');
    if (!ss.getSheetByName(TAB.SUM)) problems.push('Thiếu tab TongHop');
    if (!ss.getSheetByName(TAB.ATT)) problems.push('Thiếu tab ChuyenCan');
    var have = logKeys_(log), missing = 0;
    var dd = ss.getSheets().filter(function (s) { return /^DD_\d{4}-\d{2}-\d{2}$/.test(s.getName()); });
    dd.forEach(function (s) {
      if (s.getLastRow() < 2) return;
      s.getRange(2, 1, s.getLastRow() - 1, 3).getValues().forEach(function (r) {
        if (str_(r[2]) && !have[cellDate_(r[1]) + '|' + str_(r[2])]) missing++;
      });
    });
    if (missing) problems.push(missing + ' dòng DD_ chưa có trong Log');
    var ros = ss.getSheetByName(TAB.ROSTER), ids = {};
    if (ros.getLastRow() > 1) ros.getRange(2, 1, ros.getLastRow() - 1, 1).getValues().forEach(function (r) { ids[str_(r[0])] = true; });
    var reg = ss.getSheetByName('TuDangKy'), lost = 0;
    if (reg && reg.getLastRow() > 1) reg.getRange(2, 3, reg.getLastRow() - 1, 1).getValues().forEach(function (r) { if (str_(r[0]) && !ids[str_(r[0])]) lost++; });
    if (lost) problems.push(lost + ' người trong TuDangKy chưa có trong DanhSach');
    var cd = readClassDays_(ss), classKeys = {};
    readLog_(ss).forEach(function (l) { if (SCHOOLS.indexOf(l.school) >= 0 && l.date) classKeys[l.date + '|' + l.school] = true; });
    Object.keys(classKeys).forEach(function (k) {
      var d = k.split('|')[0], sc = k.split('|')[1];
      if (!ss.getSheetByName(bcName_(d))) problems.push('Thiếu ' + bcName_(d));
      if (!(cd.bySchool[sc] && cd.bySchool[sc][d])) problems.push('TongHop thiếu ' + d + ' ' + sc);
    });
    if (problems.length) return { ok: false, code: 'not_ready', message: 'Chưa đủ điều kiện, không xóa gì.', problems: problems.slice(0, 30) };
    var deleted = [];
    ss.getSheets().forEach(function (s) {
      var nm = s.getName();
      if (/^(DD|TH)_\d{4}-\d{2}-\d{2}$/.test(nm) || nm === 'TuDangKy' || nm === 'TongHop_LuyKe') { ss.deleteSheet(s); deleted.push(nm); }
    });
    arrangeTabs_(ss);
    return { ok: true, deleted: deleted.sort() };
  });
}
