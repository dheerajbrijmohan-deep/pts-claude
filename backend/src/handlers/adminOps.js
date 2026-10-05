const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const driverAuth = require('../driverAuth');
const { assertNotCommitted } = require('../lib/locks');
const { recordAudit } = require('../lib/audit');

async function setDriverPin(req, res, params) {
  const driver = await db.prepare('SELECT id FROM drivers WHERE id = ?').get(params.id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const b = await readJsonBody(req);
  try {
    await driverAuth.setPin(params.id, b.pin);
    await recordAudit(req, 'set_pin', 'driver', params.id, null, null); // never log PIN values, even hashed
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
  }
}

async function listDutyLogsForDriver(req, res, params) {
  const rows = await db
    .prepare('SELECT * FROM duty_logs WHERE driver_id = ? ORDER BY log_date DESC LIMIT 60')
    .all(params.id);
  const withFuel = [];
  for (const log of rows) {
    withFuel.push({
      ...log,
      fuel_entries: await db
        .prepare('SELECT id, fuel_type, amount, created_at, committed_at FROM fuel_entries WHERE duty_log_id = ?')
        .all(log.id),
    });
  }
  sendJson(res, 200, withFuel);
}

// Admin (Boss/Manager) backfill of a day's duty log — used when a driver
// forgot to log in via their own app. Creates the row if it doesn't exist
// yet, or fills in/updates whichever fields are supplied on an existing one.
async function setDutyLogEarnings(req, res, params) {
  const driver = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const b = await readJsonBody(req);
  if (b.total_earning == null || b.total_earning === '') {
    return sendJson(res, 400, { error: 'Total earning is required' });
  }
  const now = new Date().toISOString();
  let log = await db.prepare('SELECT * FROM duty_logs WHERE driver_id = ? AND log_date = ?').get(params.id, params.date);
  try {
    assertNotCommitted(log, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const totalEarning = Number(b.total_earning);
  const commissionPct = driver.commission_pct;
  const commissionAmount = Math.round((totalEarning * commissionPct) / 100 * 100) / 100;

  const startReading = b.start_reading != null && b.start_reading !== '' ? Number(b.start_reading) : (log ? log.start_reading : null);
  const endReading = b.end_reading != null && b.end_reading !== '' ? Number(b.end_reading) : (log ? log.end_reading : null);
  const totalRun = startReading != null && endReading != null ? Math.max(0, endReading - startReading) : null;

  let vehicleId = b.vehicle_id != null && b.vehicle_id !== '' ? Number(b.vehicle_id) : (log ? log.vehicle_id : null);
  if (!vehicleId) {
    const assigned = await db.prepare('SELECT id FROM vehicles WHERE assigned_driver_id = ?').get(params.id);
    if (assigned) vehicleId = assigned.id;
  }

  if (!log) {
    const info = await db
      .prepare(
        `INSERT INTO duty_logs (driver_id, log_date, vehicle_id, start_reading, end_reading, total_run, total_earning, trip_count, commission_pct_snapshot, commission_amount, admin_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(params.id, params.date, vehicleId, startReading, endReading, totalRun, totalEarning, b.trip_count != null ? Number(b.trip_count) : null, commissionPct, commissionAmount, now, now, now);
    log = await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(info.lastInsertRowid);
  } else {
    await db.prepare(
      `UPDATE duty_logs SET vehicle_id = ?, start_reading = ?, end_reading = ?, total_run = ?, total_earning = ?, trip_count = ?, commission_pct_snapshot = ?, commission_amount = ?, admin_updated_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(vehicleId, startReading, endReading, totalRun, totalEarning, b.trip_count != null ? Number(b.trip_count) : log.trip_count, commissionPct, commissionAmount, now, now, log.id);
    log = await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(log.id);
  }
  await recordAudit(req, 'set_earnings', 'duty_log', log.id, null, log);
  sendJson(res, 200, log);
}

async function decideReopenRequest(req, res, params) {
  const log = await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(params.id);
  if (!log) return sendJson(res, 404, { error: 'Duty log not found' });
  if (log.reopen_status !== 'pending') return sendJson(res, 409, { error: 'There is no pending check-in request for this entry.' });
  const b = await readJsonBody(req);
  const approve = !!b.approve;
  const now = new Date().toISOString();
  await db.prepare('UPDATE duty_logs SET reopen_status = ?, updated_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', now, log.id);
  await recordAudit(req, approve ? 'approve_reopen' : 'reject_reopen', 'duty_log', log.id, null, null);
  sendJson(res, 200, { ok: true });
}

async function ensureAdminLogForDate(driverId, date) {
  let log = await db.prepare('SELECT * FROM duty_logs WHERE driver_id = ? AND log_date = ?').get(driverId, date);
  if (log) return log;
  let vehicleId = null;
  const assigned = await db.prepare('SELECT id FROM vehicles WHERE assigned_driver_id = ?').get(driverId);
  if (assigned) vehicleId = assigned.id;
  const now = new Date().toISOString();
  const info = await db
    .prepare('INSERT INTO duty_logs (driver_id, log_date, vehicle_id, admin_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(driverId, date, vehicleId, now, now, now);
  return db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(info.lastInsertRowid);
}

const ADMIN_FUEL_TYPES = ['petrol', 'cng', 'diesel', 'other'];

async function addAdminFuelEntry(req, res, params) {
  const driver = await db.prepare('SELECT id FROM drivers WHERE id = ?').get(params.id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const b = await readJsonBody(req);
  if (b.amount == null || b.amount === '') return sendJson(res, 400, { error: 'Amount is required' });
  const log = await ensureAdminLogForDate(params.id, params.date);
  try {
    assertNotCommitted(log, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const fuelType = ADMIN_FUEL_TYPES.includes(b.fuel_type) ? b.fuel_type : 'other';
  const now = new Date().toISOString();
  const info = await db
    .prepare('INSERT INTO fuel_entries (duty_log_id, fuel_type, amount, created_at) VALUES (?, ?, ?, ?)')
    .run(log.id, fuelType, Number(b.amount), now);
  await recordAudit(req, 'add_fuel_entry', 'duty_log', log.id, null, { fuel_type: fuelType, amount: Number(b.amount) });
  const fuelEntries = await db.prepare('SELECT id, fuel_type, amount, created_at, committed_at FROM fuel_entries WHERE duty_log_id = ?').all(log.id);
  sendJson(res, 201, { log_id: log.id, fuel_entries: fuelEntries });
}

async function deleteAdminFuelEntry(req, res, params) {
  const entry = await db.prepare('SELECT * FROM fuel_entries WHERE id = ?').get(params.fuelId);
  if (!entry) return sendJson(res, 404, { error: 'Not found' });
  const log = await db.prepare('SELECT * FROM duty_logs WHERE id = ?').get(entry.duty_log_id);
  try {
    assertNotCommitted(log, req.adminUser);
    assertNotCommitted(entry, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  await db.prepare('DELETE FROM fuel_entries WHERE id = ?').run(params.fuelId);
  await recordAudit(req, 'delete_fuel_entry', 'duty_log', log.id, entry, null);
  const fuelEntries = await db.prepare('SELECT id, fuel_type, amount, created_at, committed_at FROM fuel_entries WHERE duty_log_id = ?').all(log.id);
  sendJson(res, 200, { fuel_entries: fuelEntries });
}

async function listExpenseClaims(req, res) {
  const rows = await db
    .prepare(
      `SELECT ec.*, d.name AS driver_name FROM expense_claims ec JOIN drivers d ON d.id = ec.driver_id
       ORDER BY ec.created_at DESC LIMIT 200`
    )
    .all();
  sendJson(res, 200, rows);
}

async function decideExpenseClaim(req, res, params) {
  const claim = await db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(params.id);
  if (!claim) return sendJson(res, 404, { error: 'Claim not found' });
  try {
    assertNotCommitted(claim, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const b = await readJsonBody(req);
  if (!['approved', 'rejected'].includes(b.status)) {
    return sendJson(res, 400, { error: 'Status must be approved or rejected' });
  }
  await db.prepare('UPDATE expense_claims SET status = ?, admin_note = ?, decided_at = ? WHERE id = ?').run(
    b.status,
    b.admin_note || null,
    new Date().toISOString(),
    params.id
  );
  const row = await db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(params.id);
  await recordAudit(req, 'decide', 'expense_claim', params.id, claim.status, row.status);
  sendJson(res, 200, row);
}

async function listLeaveRequests(req, res) {
  const rows = await db
    .prepare(
      `SELECT lr.*, d.name AS driver_name FROM leave_requests lr JOIN drivers d ON d.id = lr.driver_id
       ORDER BY lr.created_at DESC LIMIT 200`
    )
    .all();
  sendJson(res, 200, rows);
}

async function decideLeaveRequest(req, res, params) {
  const reqRow = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(params.id);
  if (!reqRow) return sendJson(res, 404, { error: 'Leave request not found' });
  const b = await readJsonBody(req);
  if (!['approved', 'rejected'].includes(b.status)) {
    return sendJson(res, 400, { error: 'Status must be approved or rejected' });
  }
  await db.prepare('UPDATE leave_requests SET status = ?, admin_note = ?, decided_at = ? WHERE id = ?').run(
    b.status,
    b.admin_note || null,
    new Date().toISOString(),
    params.id
  );
  const row = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(params.id);
  await recordAudit(req, 'decide', 'leave_request', params.id, reqRow.status, row.status);
  sendJson(res, 200, row);
}

async function sendAnnouncement(req, res, params) {
  const driver = await db.prepare('SELECT id FROM drivers WHERE id = ?').get(params.id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const b = await readJsonBody(req);
  if (!b.message || !String(b.message).trim()) {
    return sendJson(res, 400, { error: 'Message is required' });
  }
  const now = new Date().toISOString();
  const info = await db
    .prepare('INSERT INTO announcements (driver_id, message, created_at) VALUES (?, ?, ?)')
    .run(params.id, String(b.message).trim(), now);
  const row = await db.prepare('SELECT * FROM announcements WHERE id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'announcement', info.lastInsertRowid, null, row);
  sendJson(res, 201, row);
}

async function listAnnouncementsForDriver(req, res, params) {
  sendJson(res, 200, await db.prepare('SELECT * FROM announcements WHERE driver_id = ? ORDER BY created_at DESC LIMIT 20').all(params.id));
}

// Latest known position for every driver currently checked in or on lunch —
// backs the admin Live Map. One row per driver, its most recent ping.
async function listLiveLocations(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .prepare(
      `SELECT d.id AS driver_id, d.name AS driver_name, dl.shift_status,
              v.reg_no AS vehicle_reg_no,
              lp.lat, lp.lng, lp.speed_kmh, lp.recorded_at
       FROM duty_logs dl
       JOIN drivers d ON d.id = dl.driver_id
       LEFT JOIN vehicles v ON v.id = dl.vehicle_id
       LEFT JOIN location_pings lp ON lp.id = (
         SELECT id FROM location_pings WHERE driver_id = dl.driver_id ORDER BY recorded_at DESC LIMIT 1
       )
       WHERE dl.log_date = ? AND dl.shift_status IN ('checked_in', 'on_lunch')`
    )
    .all(today);
  sendJson(res, 200, rows.filter((r) => r.lat != null));
}

async function getLocationTrail(req, res, params) {
  const rows = await db
    .prepare(
      `SELECT lp.lat, lp.lng, lp.speed_kmh, lp.recorded_at
       FROM location_pings lp JOIN duty_logs dl ON dl.id = lp.duty_log_id
       WHERE dl.driver_id = ? AND dl.log_date = ? ORDER BY lp.recorded_at ASC`
    )
    .all(params.id, params.date);
  sendJson(res, 200, rows);
}

async function listAllAnnouncements(req, res) {
  const rows = await db
    .prepare(
      `SELECT a.*, d.name AS driver_name FROM announcements a JOIN drivers d ON d.id = a.driver_id
       ORDER BY a.created_at DESC LIMIT 200`
    )
    .all();
  sendJson(res, 200, rows);
}

async function listDrivingEvents(req, res) {
  const rows = await db
    .prepare(
      `SELECT de.*, d.name AS driver_name, v.reg_no AS vehicle_reg_no
       FROM driving_events de
       JOIN drivers d ON d.id = de.driver_id
       LEFT JOIN duty_logs dl ON dl.id = de.duty_log_id
       LEFT JOIN vehicles v ON v.id = dl.vehicle_id
       ORDER BY de.created_at DESC LIMIT 300`
    )
    .all();
  sendJson(res, 200, rows);
}

module.exports = {
  setDriverPin,
  listDutyLogsForDriver,
  setDutyLogEarnings,
  addAdminFuelEntry,
  deleteAdminFuelEntry,
  decideReopenRequest,
  listExpenseClaims,
  decideExpenseClaim,
  listLeaveRequests,
  decideLeaveRequest,
  sendAnnouncement,
  listAnnouncementsForDriver,
  listLiveLocations,
  getLocationTrail,
  listDrivingEvents,
  listAllAnnouncements,
};
