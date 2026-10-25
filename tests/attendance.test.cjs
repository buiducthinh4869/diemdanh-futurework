const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
function fixture() {
  const properties = new Map([['ADMIN_KEY', 'test-admin']]);
  const cache = new Map();
  const log = { rows: [], getLastRow() { return this.rows.length + 1; }, getLastColumn() { return 13; }, getMaxColumns() { return 26; },
    getRange(start, col, count, width) { return { getValue: () => "Device_hash", setValue: value => { assert.equal(locked, true); this.rows[start - 2][col - 1] = value; }, getValues: () => this.rows.slice(start - 2, start - 2 + count).map(r => r.slice(col - 1, col - 1 + width)) }; } };
  const ss = { getSheetByName: () => log };
  let locked = false;
  const c = vm.createContext({ console, Date, PropertiesService: { getScriptProperties: () => ({
    getProperty: k => properties.get(k) || null, setProperty: (k, v) => properties.set(k, v), deleteProperty: k => properties.delete(k)
  }) }, Utilities: { DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (_, value) => Array.from(crypto.createHash('sha256').update(value).digest()),
    formatDate(date, tz, format) {
      const d = new Date(date.getTime() + 7 * 3600000), iso = d.toISOString();
      const map = { 'yyyy-MM-dd': iso.slice(0, 10), 'dd/MM/yyyy': iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4),
        'HH:mm': iso.slice(11, 16), 'H': String(d.getUTCHours()), 'm': String(d.getUTCMinutes()), 'yyyy-MM-dd HH:mm:ss': iso.slice(0, 19).replace('T', ' ') };
      return map[format];
    }
  }, CacheService: { getScriptCache: () => ({ get: k => cache.get(k), put: (k,v) => cache.set(k,v) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => { assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; } }) },
  SpreadsheetApp: { openById: () => ss, flush() {} }, SHEET_ID: 'test',
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => JSON.parse(value) }) }
  });
  vm.runInContext(fs.readFileSync('apps-script/Code.gs', 'utf8'), c);
  c.appendLogRow_ = (_, row) => { assert.equal(locked, true); log.rows.push(row); };
  c.readRoster_ = () => roster;
  c.clearRosterCache_ = () => {};
  c.appendTextRow_ = (_, row) => {
    assert.equal(locked, true);
    roster.push({ id: row[0], school: row[1], khoa: row[2], dot: row[3], name: row[4], year: row[5], bomon: row[8], src: row[11], regDate: row[14] });
  };
  const roster = ['A','B'].map(id => ({ id, name: id, school: 'TUAF', khoa: 'K', bomon: '', year: '', dot: 'Đợt 1', arm: '', src: c.SRC_ORIG }));
  c.findPerson_ = id => roster.find(p => p.id === id);
  properties.set('FAKE_NOW', '2026-10-24 10:00');
  const deviceId = 'a'.repeat(48), otherDevice = 'b'.repeat(48);
  return { c, properties, cache, log, roster, deviceId, otherDevice };
}
test('server enforces configured boundaries, exceptions, and closed days', () => {
  const { c } = fixture();
  c.actionAdmin_('adminSetSchedule', { key: 'test-admin', openAt: '09:30', closeAt: '11:15' });
  assert.equal(c.nowInfo_('2026-10-24 09:29').open, false);
  assert.equal(c.nowInfo_('2026-10-24 09:30').open, true);
  assert.equal(c.nowInfo_('2026-10-24 11:15').open, false);
  c.adminSchedule_({ date: '2026-10-24', openAt: '14:00', closeAt: '16:00' });
  assert.equal(c.nowInfo_('2026-10-24 10:00').open, false);
  assert.equal(c.nowInfo_('2026-10-24 14:00').open, true);
  assert.equal(c.nowInfo_('2026-10-25 10:00').open, true);
  c.adminSchedule_({ date: '2026-10-24', openAt: '14:00', closeAt: '16:00', closed: true });
  assert.equal(c.nowInfo_('2026-10-24 14:00').open, false);
  c.adminSchedule_({ date: '2026-10-24', reset: true });
  assert.equal(c.nowInfo_('2026-10-24 10:00').open, true);
  assert.equal(c.statusOf_(c.nowInfo_()).openAt, '09:30');
});
test('unauthorized/GET schedule calls do not mutate settings; invalid dates and times rejected', () => {
  const { c, properties } = fixture();
  assert.equal(c.actionAdmin_('adminSetSchedule', { key: 'wrong' }).code, 'forbidden');
  assert.equal(c.route_({ parameter: { action: 'adminSetSchedule', key: 'test-admin' } }, false).code, 'bad_request');
  for (const p of [{ openAt:'17:00', closeAt:'08:00' }, { openAt:'9:00', closeAt:'10:00' },
    { date:'2026-02-30', openAt:'08:00', closeAt:'17:00' }, { date:'2026-11-12', openAt:'08:00', closeAt:'17:00' }])
    assert.throws(() => c.adminSchedule_(p));
  assert.equal(properties.has('ATTENDANCE_SETTINGS'), false);
});
test('one device cannot check in a second person; retries are idempotent even after cache loss', () => {
  const { c, deviceId, otherDevice, log, cache, properties } = fixture();
  assert.equal(c.actionCheckin_({id:'A'}).code, 'device_required');
  assert.equal(c.actionCheckin_({id:'A',deviceId}).status, 'ok');
  cache.clear();
  assert.equal(c.actionCheckin_({id:'A',deviceId}).status, 'already');
  assert.equal(c.actionCheckin_({id:'B',deviceId}).code, 'device_used');
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0][12].length, 64);
  assert.notEqual(log.rows[0][12], deviceId);
  assert.equal(c.actionCheckin_({id:'B',deviceId:otherDevice}).status, 'ok');
  properties.set('FAKE_NOW', '2026-10-25 10:00');
  assert.equal(c.actionCheckin_({id:'B',deviceId}).status, 'ok');
});
test('reopening reports the used device from Log; next day and other devices remain available', () => {
  const { c, deviceId, otherDevice } = fixture();
  assert.equal(c.actionStatus_({deviceId}).deviceUsed, false);
  c.actionCheckin_({id:'A', deviceId});
  assert.equal(c.route_({postData:{contents:JSON.stringify({action:'status',deviceId})}},true).deviceUsed,true);
  assert.equal(c.actionStatus_({deviceId:otherDevice}).deviceUsed,false);
  assert.equal(c.actionCheckin_({id:'B',deviceId}).code,'device_used');
  assert.equal(c.actionStatus_({deviceId, fake:'2026-10-25 10:00',key:'test-admin'}).deviceUsed,false);
});
test('already-attended person also consumes the second browser without overwriting first device', () => {
  const { c, deviceId, otherDevice, log } = fixture();
  c.actionCheckin_({id:'A', deviceId});
  assert.equal(c.actionCheckin_({id:'A',deviceId:otherDevice}).status,'already');
  assert.equal(log.rows.length,1);
  assert.equal(log.rows[0][12].split(',').length,2);
  for (const id of [deviceId,otherDevice]) {
    assert.equal(c.actionStatus_({deviceId:id}).deviceUsed,true);
    assert.equal(c.actionCheckin_({id:'B',deviceId:id}).code,'device_used');
  }
});
test('stale attendance cache after another project deletes Log cannot create a phantom success', () => {
  const { c, deviceId, log } = fixture();
  c.actionCheckin_({id:'A',deviceId});
  log.rows.length = 0;
  assert.equal(c.actionStatus_({deviceId}).deviceUsed,false);
  assert.equal(c.actionCheckin_({id:'A',deviceId}).status,'ok');
  assert.equal(log.rows.length,1);
  assert.equal(c.actionCheckin_({id:'B',deviceId}).code,'device_used');
});
test('registration cannot bypass device lock or add a roster entry when rejected', () => {
  const { c, deviceId, roster, log } = fixture();
  c.actionCheckin_({id:'A',deviceId});
  const input = { deviceId, name:'Nguyen Van C',school:'TUAF',khoa:'K',dot:'Đợt 1' };
  assert.equal(c.actionRegister_(input).code, 'device_used');
  assert.equal(roster.length, 2);
  assert.equal(log.rows.length, 1);
});
test('registration retries reuse the same student and attendance', () => {
  const { c, deviceId, roster, log, cache } = fixture();
  const input = { deviceId, name:'Nguyen Van C',school:'TUAF',khoa:'K',dot:'Đợt 1' };
  assert.equal(c.actionRegister_(input).status, 'ok');
  cache.clear();
  assert.equal(c.actionRegister_(input).status, 'already');
  assert.equal(roster.length, 3);
  assert.equal(log.rows.length, 1);
});
test('admin checkin remains available without a device, and closed public endpoint writes nothing', () => {
  const { c, deviceId, log } = fixture();
  c.afterEdit_ = () => ({});
  assert.equal(c.adminCheckin('2026-10-24', 'A').status, 'ok');
  c.adminSchedule_({openAt:'08:00',closeAt:'09:00'});
  assert.equal(c.actionCheckin_({id:'B', deviceId}).code, 'closed');
  assert.equal(log.rows.length, 1);
});
test('public checkin rechecks time after waiting for the lock', () => {
  const { c, deviceId, log, properties } = fixture();
  c.LockService = { getScriptLock: () => ({
    tryLock: () => { properties.set('FAKE_NOW', '2026-10-24 17:00'); return true; }, releaseLock() {}
  }) };
  assert.equal(c.actionCheckin_({id:'A', deviceId}).code, 'closed');
  assert.equal(log.rows.length, 0);
});
test('schema upgrade only adds an empty device column and refuses an occupied column', () => {
  const { c } = fixture();
  let header = '', formats = 0;
  const range = { getValue: () => header, setValue(value) { header = value; return this; },
    setFontWeight() { return this; }, setBackground() { return this; }, setNumberFormat() { formats++; return this; } };
  const sheet = { getMaxColumns: () => 26, getMaxRows: () => 100, getRange: () => range };
  c.ensureLogDeviceColumn_(sheet);
  assert.equal(header, 'Device_hash');
  assert.equal(formats, 1);
  c.ensureLogDeviceColumn_(sheet);
  assert.equal(formats, 1);
  header = 'Other data';
  assert.throws(() => c.ensureLogDeviceColumn_(sheet));
});
test('Đợt 0 is excluded from reporting while original roster and log stay intact', () => {
  const {c}=fixture();
  const roster=[{id:'A',dot:'Đợt 1'},{id:'B',dot:'Đợt 0'},{id:'C',dot:'Đợt 2'}];
  const logs=[{id:'A'},{id:'B'},{id:'C'},{id:'unknown'}];
  const report=c.reportData_(roster,logs);
  assert.equal(report.roster.length,2);
  assert.equal(report.log.length,3);
  assert.equal(report.log.some(r=>r.id==='B'),false);
  assert.equal(roster.length,3);
  assert.equal(logs.length,4);
  assert.equal(c.SUMMARY_HOUR,17);
});
test('username/password authenticates schedule administration only', () => {
  const {c,properties}=fixture();
  properties.set('ADMIN_USERNAME','admin');
  properties.set('ADMIN_PASSWORD','example-password-for-test');
  const credentials={username:'admin',password:'example-password-for-test'};
  assert.equal(c.actionAdmin_('adminGetSchedule',credentials).ok,true);
  assert.equal(c.actionAdmin_('adminSetSchedule',{...credentials,openAt:'09:00',closeAt:'16:00'}).ok,true);
  assert.equal(c.actionAdmin_('adminGetSchedule',{...credentials,password:'wrong'}).code,'forbidden');
  assert.equal(c.actionAdmin_('adminGetSchedule',{...credentials,username:'other'}).code,'forbidden');
  assert.equal(c.actionAdmin_('adminGetSchedule',{username:'admin'}).code,'forbidden');
  assert.equal(c.actionAdmin_('adminDeleteDay',credentials).code,'forbidden');
  assert.equal(c.actionAdmin_('adminGetSchedule',{key:'test-admin'}).ok,true);
  properties.delete('ADMIN_PASSWORD');
  assert.equal(c.actionAdmin_('adminGetSchedule',credentials).code,'forbidden');
});
