const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendJson, readJsonBody, readMultipart, parseCookies } = require('../lib/http');
const db = require('../db');
const driverAuth = require('../driverAuth');
const { UPLOADS_DIR } = require('../config');
const { assertNotCommitted } = require('../lib/locks');
const { notify } = require('../lib/notify');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function publicDriver(d) {
  return {
    id: d.id,
    name: d.name,
    phone: d.phone,
    status: d.status,
    commission_pct: d.commission_pct,
  };
}

async function login(req, res) {
  const b = await readJsonBody(req);
  const driver = await driverAuth.findDriverByPhone(b.phone);
  if (!driver || !driverAuth.verifyPin(b.pin, driver.pin_hash)) {
    return sendJson(res, 401, { error: 'Invalid phone number or PIN' });
  }
  if (driver.status !== 'active') {
    return sendJson(res, 403, { error: `Your account is ${driver.status}. Contact the fleet office.` });
  }
  const { token, expires } = await driverAuth.createSession(driver.id);
  res.setHeader('Set-Cookie', driverAuth.sessionCookieHeader(token, expires));
  sendJson(res, 200, publicDriver(driver));
}

async function logout(req, res) {
  const cookies = parseCookies(req);
  await driverAuth.destroySession(cookies[driverAuth.COOKIE_NAME]);
  res.setHeader('Set-Cookie', driverAuth.clearCookieHeader());
  sendJson(res, 200, { ok: true });
}

async function me(req, res) {
  sendJson(res, 200, publicDriver(req.driver));
}

// Self-service PIN change. The Boss/Manager can still set or reset a
// driver's PIN from the admin panel (e.g. for a first-time login or if a
// driver forgets it); this lets a driver who already knows their current
// PIN pick a new one themselves, without going through the office.
async function changeMyPin(req, res) {
  const b = await readJsonBody(req);
  if (!driverAuth.verifyPin(b.currentPin, req.driver.pin_hash)) {
    return sendJson(res, 401, { error: 'Current PIN is incorrect' });
  }
  try {
    await driverAuth.setPin(req.driver.id, b.newPin);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
  }
}

async function findOrNullTodayLog(driverId) {
  return db.prepare('SELECT * FROM duty_logs WHERE driver_id = ? AND log_date = ?').get(driverId, todayStr());
}

async function fuelEntriesFor(logId) {
  const rows = await db
    .prepare('SELECT id, fuel_type, amount, pump_photo_stored_name, odometer_photo_stored_name, created_at FROM fuel_entries WHERE duty_log_id = ? ORDER BY created_at ASC')
    .all(logId);
  return rows.map((f) => ({
    id: f.id,
    fuel_type: f.fuel_type,
    amount: f.amount,
    created_at: f.created_at,
    has_pump_photo: !!f.pump_photo_stored_name,
    has_odometer_photo: !!f.odometer_photo_stored_name,
  }));
}

async function getTodayLog(req, res) {
  const log = await findOrNullTodayLog(req.driver.id);
  if (!log) return sendJson(res, 200, { log_date: todayStr(), exists: false });
  sendJson(res, 200, { ...log, exists: true, fuel_entries: await fuelEntriesFor(log.id) });
}

async function ensureTodayLog(driverId) {
  let log = await findOrNullTodayLog(driverId);
  if (log) return log;
  const now = new Date().toISOString();
  const info = await db
    .prepare('INSERT INTO duty_logs (driver_id, log_date, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(driverId, todayStr(), now, now);
  return db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(info.lastInsertRowid);
}

function assertNotLocked(log) {
  if (log.shift_status === 'checked_out') {
    throw Object.assign(new Error('Your shift is checked out for today. Contact the office for corrections.'), { statusCode: 403 });
  }
  assertNotCommitted(log, null);
}

async function checkIn(req, res) {
  const log = await ensureTodayLog(req.driver.id);
  try {
    assertNotCommitted(log, null);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (log.shift_status === 'checked_out') {
    if (log.reopen_status === 'approved') {
      const now = new Date().toISOString();
      await db.prepare('UPDATE duty_logs SET shift_status = ?, check_in_at = ?, reopen_status = NULL, updated_at = ? WHERE id = ?')
        .run('checked_in', now, now, log.id);
      return sendJson(res, 200, { ...(await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(log.id)), fuel_entries: await fuelEntriesFor(log.id) });
    }
    if (log.reopen_status === 'pending') {
      return sendJson(res, 202, { pendingApproval: true, message: 'Your request to check in again is still waiting for admin approval.' });
    }
    const now = new Date().toISOString();
    await db.prepare('UPDATE duty_logs SET reopen_status = ?, reopen_requested_at = ?, updated_at = ? WHERE id = ?').run('pending', now, now, log.id);
    await notify('warning', `${req.driver.name} is requesting to check in again after already checking out today.`, { driverId: req.driver.id });
    return sendJson(res, 202, { pendingApproval: true, message: 'Request sent — you can check in again once the Boss/Manager approves it.' });
  }
  if (log.shift_status !== 'not_started') return sendJson(res, 409, { error: 'Already checked in today.' });
  const now = new Date().toISOString();
  let vehicleId = log.vehicle_id;
  if (!vehicleId) {
    const assigned = await db.prepare('SELECT id FROM vehicles WHERE assigned_driver_id = ?').get(req.driver.id);
    if (assigned) vehicleId = assigned.id;
  }
  await db.prepare('UPDATE duty_logs SET shift_status = ?, check_in_at = ?, vehicle_id = ?, updated_at = ? WHERE id = ?').run('checked_in', now, vehicleId, now, log.id);
  sendJson(res, 200, { ...(await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(log.id)), fuel_entries: await fuelEntriesFor(log.id) });
}

async function startLunch(req, res) {
  const log = await ensureTodayLog(req.driver.id);
  try {
    assertNotCommitted(log, null);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (log.shift_status !== 'checked_in') return sendJson(res, 409, { error: 'You need to be checked in to start lunch.' });
  const now = new Date().toISOString();
  await db.prepare('UPDATE duty_logs SET shift_status = ?, lunch_start_at = ?, updated_at = ? WHERE id = ?').run('on_lunch', now, now, log.id);
  sendJson(res, 200, { ...(await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(log.id)), fuel_entries: await fuelEntriesFor(log.id) });
}

async function endLunch(req, res) {
  const log = await ensureTodayLog(req.driver.id);
  try {
    assertNotCommitted(log, null);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (log.shift_status !== 'on_lunch') return sendJson(res, 409, { error: 'You are not currently on lunch.' });
  const now = new Date().toISOString();
  await db.prepare('UPDATE duty_logs SET shift_status = ?, lunch_end_at = ?, updated_at = ? WHERE id = ?').run('checked_in', now, now, log.id);
  sendJson(res, 200, { ...(await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(log.id)), fuel_entries: await fuelEntriesFor(log.id) });
}

async function checkOut(req, res) {
  const log = await ensureTodayLog(req.driver.id);
  try {
    assertNotCommitted(log, null);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (log.shift_status !== 'checked_in' && log.shift_status !== 'on_lunch') {
    return sendJson(res, 409, { error: 'You need to be checked in to check out.' });
  }
  const now = new Date().toISOString();
  await db.prepare('UPDATE duty_logs SET shift_status = ?, check_out_at = ?, updated_at = ? WHERE id = ?').run('checked_out', now, now, log.id);
  sendJson(res, 200, { ...(await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(log.id)), fuel_entries: await fuelEntriesFor(log.id) });
}

async function deleteFuelEntry(req, res, params) {
  const entry = await db.prepare('SELECT * FROM fuel_entries WHERE id = ?').get(params.fuelId);
  if (!entry) return sendJson(res, 404, { error: 'Not found' });
  const log = await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(entry.duty_log_id);
  if (!log || log.driver_id !== req.driver.id || log.log_date !== todayStr()) {
    return sendJson(res, 403, { error: 'Not your record' });
  }
  try {
    assertNotLocked(log);
    assertNotCommitted(entry, null);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  [entry.pump_photo_stored_name, entry.odometer_photo_stored_name].forEach((stored) => {
    if (!stored) return;
    const p = path.join(UPLOADS_DIR, stored);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  await db.prepare('DELETE FROM fuel_entries WHERE id = ?').run(params.fuelId);
  sendJson(res, 200, { fuel_entries: await fuelEntriesFor(log.id) });
}

async function saveTodayLog(req, res) {
  const b = await readJsonBody(req);
  const log = await ensureTodayLog(req.driver.id);
  try {
    assertNotLocked(log);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const startReading = b.start_reading != null && b.start_reading !== '' ? Number(b.start_reading) : log.start_reading;
  const endReading = b.end_reading != null && b.end_reading !== '' ? Number(b.end_reading) : log.end_reading;
  const totalRun = startReading != null && endReading != null ? Math.max(0, endReading - startReading) : null;
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE duty_logs SET vehicle_id = ?, start_reading = ?, end_reading = ?, total_run = ?, driver_submitted_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    'vehicle_id' in b ? b.vehicle_id || null : log.vehicle_id,
    startReading,
    endReading,
    totalRun,
    now,
    now,
    log.id
  );
  const updated = await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(log.id);
  sendJson(res, 200, { ...updated, fuel_entries: await fuelEntriesFor(log.id) });
}

// Location pings and driving-behaviour events are only accepted while the
// driver is actually on duty (checked in, not on a lunch break) — the phone
// isn't tracked before clock-in, during lunch, or after clock-out.
async function assertOnDuty(driverId) {
  const log = await findOrNullTodayLog(driverId);
  if (!log || log.shift_status !== 'checked_in') {
    throw Object.assign(new Error('Not currently on duty'), { statusCode: 409 });
  }
  return log;
}

async function addLocationPing(req, res) {
  const b = await readJsonBody(req);
  let log;
  try {
    log = await assertOnDuty(req.driver.id);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (b.lat == null || b.lng == null) return sendJson(res, 400, { error: 'lat and lng are required' });
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO location_pings (driver_id, duty_log_id, lat, lng, speed_kmh, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    req.driver.id,
    log.id,
    Number(b.lat),
    Number(b.lng),
    b.speed_kmh != null ? Number(b.speed_kmh) : null,
    now
  );
  sendJson(res, 201, { ok: true });
}

const DRIVING_EVENT_TYPES = ['rapid_acceleration', 'harsh_braking', 'possible_collision', 'speeding'];

async function addDrivingEvent(req, res) {
  const b = await readJsonBody(req);
  let log;
  try {
    log = await assertOnDuty(req.driver.id);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const eventType = DRIVING_EVENT_TYPES.includes(b.event_type) ? b.event_type : null;
  if (!eventType) return sendJson(res, 400, { error: 'Unknown event type' });
  const now = new Date().toISOString();
  const info = await db
    .prepare('INSERT INTO driving_events (driver_id, duty_log_id, event_type, g_force, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.driver.id, log.id, eventType, b.g_force != null ? Number(b.g_force) : null, b.lat != null ? Number(b.lat) : null, b.lng != null ? Number(b.lng) : null, now);
  sendJson(res, 201, await db.prepare('SELECT * FROM driving_events WHERE id = ?').get(info.lastInsertRowid));
}

const FUEL_TYPES = ['petrol', 'cng', 'diesel', 'other'];

async function addFuelEntry(req, res) {
  const log = await ensureTodayLog(req.driver.id);
  try {
    assertNotLocked(log);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return sendJson(res, 400, { error: 'Expected multipart/form-data upload' });
  }
  let parsed;
  try {
    parsed = await readMultipart(req, contentType);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }
  const fuelType = FUEL_TYPES.includes(parsed.fields.fuel_type) ? parsed.fields.fuel_type : 'other';
  const pumpPhoto = parsed.files.find((f) => f.fieldName === 'pump_photo');
  const odoPhoto = parsed.files.find((f) => f.fieldName === 'odometer_photo');

  function store(file) {
    if (!file) return null;
    const ext = path.extname(file.fileName || '');
    const storedName = crypto.randomUUID() + (ext && ext.length <= 10 ? ext : '');
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.data);
    return storedName;
  }
  const pumpStored = store(pumpPhoto);
  const odoStored = store(odoPhoto);

  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO fuel_entries (duty_log_id, fuel_type, amount, pump_photo_stored_name, odometer_photo_stored_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(log.id, fuelType, parsed.fields.amount ? Number(parsed.fields.amount) : null, pumpStored, odoStored, now);

  sendJson(res, 201, { log_id: log.id, fuel_entries: await fuelEntriesFor(log.id) });
}

function downloadFuelPhoto(kind) {
  return async function handler(req, res, params) {
    const entry = await db.prepare('SELECT * FROM fuel_entries WHERE id = ?').get(params.id);
    if (!entry) return sendJson(res, 404, { error: 'Not found' });
    if (req.driver) {
      const log = await db.prepare('SELECT driver_id FROM duty_logs WHERE id = ?').get(entry.duty_log_id);
      if (!log || log.driver_id !== req.driver.id) return sendJson(res, 403, { error: 'Not your record' });
    }
    const storedName = kind === 'pump' ? entry.pump_photo_stored_name : entry.odometer_photo_stored_name;
    if (!storedName) return sendJson(res, 404, { error: 'No photo uploaded' });
    const filePath = path.join(UPLOADS_DIR, storedName);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'File is missing from storage' });
    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  };
}

async function listMyLogs(req, res) {
  const rows = await db
    .prepare('SELECT * FROM duty_logs WHERE driver_id = ? ORDER BY log_date DESC LIMIT 60')
    .all(req.driver.id);
  sendJson(res, 200, rows);
}

async function listMyDocuments(req, res) {
  const rows = await db
    .prepare('SELECT id, doc_type, label, file_name, expires_on, uploaded_at FROM driver_documents WHERE driver_id = ? ORDER BY uploaded_at DESC')
    .all(req.driver.id);
  sendJson(res, 200, rows);
}

async function createLeaveRequest(req, res) {
  const b = await readJsonBody(req);
  if (!b.start_date || !b.end_date) {
    return sendJson(res, 400, { error: 'Start and end date are required' });
  }
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO leave_requests (driver_id, start_date, end_date, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .run(req.driver.id, b.start_date, b.end_date, b.reason || null, now);
  sendJson(res, 201, await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(info.lastInsertRowid));
}

async function listMyLeaveRequests(req, res) {
  sendJson(res, 200, await db.prepare('SELECT * FROM leave_requests WHERE driver_id = ? ORDER BY created_at DESC').all(req.driver.id));
}

async function listMyAnnouncements(req, res) {
  sendJson(res, 200, await db.prepare('SELECT * FROM announcements WHERE driver_id = ? ORDER BY created_at DESC LIMIT 20').all(req.driver.id));
}

async function ackAnnouncement(req, res, params) {
  const row = await db.prepare('SELECT * FROM announcements WHERE id = ? AND driver_id = ?').get(params.id, req.driver.id);
  if (!row) return sendJson(res, 404, { error: 'Not found' });
  await db.prepare('UPDATE announcements SET acknowledged_at = ? WHERE id = ?').run(new Date().toISOString(), params.id);
  sendJson(res, 200, { ok: true });
}

const EXPENSE_CATEGORIES = ['puncture', 'accident', 'other'];

async function createExpenseClaim(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return sendJson(res, 400, { error: 'Expected multipart/form-data upload' });
  }
  let parsed;
  try {
    parsed = await readMultipart(req, contentType);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }
  const category = EXPENSE_CATEGORIES.includes(parsed.fields.category) ? parsed.fields.category : 'other';
  const photo = parsed.files[0];
  let photoStored = null;
  if (photo) {
    const ext = path.extname(photo.fileName || '');
    photoStored = crypto.randomUUID() + (ext && ext.length <= 10 ? ext : '');
    fs.writeFileSync(path.join(UPLOADS_DIR, photoStored), photo.data);
  }
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO expense_claims (driver_id, category, amount, notes, photo_stored_name, photo_file_name, photo_mime, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      req.driver.id,
      category,
      parsed.fields.amount ? Number(parsed.fields.amount) : null,
      parsed.fields.notes || null,
      photoStored,
      photo ? photo.fileName : null,
      photo ? photo.mimeType : null,
      now
    );
  sendJson(res, 201, await db.prepare('SELECT id, category, amount, notes, status, created_at FROM expense_claims WHERE id = ?').get(info.lastInsertRowid));
}

async function listMyExpenseClaims(req, res) {
  sendJson(res, 200, await db.prepare('SELECT id, category, amount, notes, status, admin_note, created_at FROM expense_claims WHERE driver_id = ? ORDER BY created_at DESC').all(req.driver.id));
}

async function downloadExpensePhoto(req, res, params) {
  const claim = await db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(params.id);
  if (!claim) return sendJson(res, 404, { error: 'Not found' });
  if (req.driver && claim.driver_id !== req.driver.id) return sendJson(res, 403, { error: 'Not your record' });
  if (!claim.photo_stored_name) return sendJson(res, 404, { error: 'No photo uploaded' });
  const filePath = path.join(UPLOADS_DIR, claim.photo_stored_name);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'File is missing from storage' });
  const stat = fs.statSync(filePath);
  res.writeHead(200, { 'Content-Type': claim.photo_mime || 'application/octet-stream', 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
}

module.exports = {
  login,
  logout,
  me,
  changeMyPin,
  getTodayLog,
  saveTodayLog,
  addFuelEntry,
  deleteFuelEntry,
  checkIn,
  startLunch,
  endLunch,
  checkOut,
  addLocationPing,
  addDrivingEvent,
  downloadFuelPumpPhoto: downloadFuelPhoto('pump'),
  downloadFuelOdometerPhoto: downloadFuelPhoto('odometer'),
  listMyLogs,
  listMyDocuments,
  createLeaveRequest,
  listMyLeaveRequests,
  listMyAnnouncements,
  ackAnnouncement,
  createExpenseClaim,
  listMyExpenseClaims,
  downloadExpensePhoto,
  FUEL_TYPES,
  EXPENSE_CATEGORIES,
};
