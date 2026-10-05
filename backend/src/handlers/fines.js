const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const { assertNotCommitted } = require('../lib/locks');
const { recordAudit } = require('../lib/audit');
const { notify } = require('../lib/notify');

const CATEGORIES = ['traffic_violation', 'vehicle_damage', 'late_reporting', 'policy_violation', 'other'];
const RECOVERY_METHODS = ['immediate', 'next_payroll', 'installments'];

async function list(req, res, params, query) {
  const rows = query.driver_id
    ? await db.prepare('SELECT f.*, d.name AS driver_name FROM fines f JOIN drivers d ON d.id = f.driver_id WHERE f.driver_id = ? ORDER BY f.date DESC').all(query.driver_id)
    : await db.prepare('SELECT f.*, d.name AS driver_name FROM fines f JOIN drivers d ON d.id = f.driver_id ORDER BY f.date DESC').all();
  sendJson(res, 200, rows);
}

async function create(req, res) {
  const b = await readJsonBody(req);
  if (!b.driver_id || !b.date) return sendJson(res, 400, { error: 'Driver and date are required' });
  if (!b.amount || Number(b.amount) <= 0) return sendJson(res, 400, { error: 'Amount must be greater than zero' });
  const driver = await db.prepare('SELECT id FROM drivers WHERE id = ?').get(b.driver_id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const category = CATEGORIES.includes(b.category) ? b.category : 'other';
  const recoveryMethod = RECOVERY_METHODS.includes(b.recovery_method) ? b.recovery_method : 'next_payroll';
  const now = new Date().toISOString();
  const info = await db.prepare(
    `INSERT INTO fines (driver_id, date, category, amount, reason, recovery_method, status, created_by, created_at)
     VALUES (?,?,?,?,?,?,'pending',?,?)`
  ).run(b.driver_id, b.date, category, Number(b.amount), b.reason || null, recoveryMethod, req.adminUser.id, now);
  const row = await db.prepare('SELECT f.*, d.name AS driver_name FROM fines f JOIN drivers d ON d.id = f.driver_id WHERE f.id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'fine', info.lastInsertRowid, null, row);
  await notify('warning', `Fine of ₹${row.amount} issued to ${row.driver_name} (${category.replace(/_/g, ' ')})`, { driverId: b.driver_id });
  sendJson(res, 201, row);
}

async function update(req, res, params) {
  const existing = await db.prepare('SELECT * FROM fines WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Fine not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const b = await readJsonBody(req);
  const category = b.category != null ? (CATEGORIES.includes(b.category) ? b.category : existing.category) : existing.category;
  const recoveryMethod = b.recovery_method != null ? (RECOVERY_METHODS.includes(b.recovery_method) ? b.recovery_method : existing.recovery_method) : existing.recovery_method;
  await db.prepare('UPDATE fines SET date=?, category=?, amount=?, reason=?, recovery_method=? WHERE id=?').run(
    b.date || existing.date,
    category,
    b.amount != null ? Number(b.amount) : existing.amount,
    'reason' in b ? b.reason || null : existing.reason,
    recoveryMethod,
    params.id
  );
  const row = await db.prepare('SELECT f.*, d.name AS driver_name FROM fines f JOIN drivers d ON d.id = f.driver_id WHERE f.id = ?').get(params.id);
  await recordAudit(req, 'update', 'fine', params.id, existing, row);
  sendJson(res, 200, row);
}

async function setStatus(req, res, params) {
  const existing = await db.prepare('SELECT * FROM fines WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Fine not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const b = await readJsonBody(req);
  if (!['pending', 'recovered', 'waived'].includes(b.status)) {
    return sendJson(res, 400, { error: 'Status must be pending, recovered, or waived' });
  }
  await db.prepare('UPDATE fines SET status = ? WHERE id = ?').run(b.status, params.id);
  const row = await db.prepare('SELECT f.*, d.name AS driver_name FROM fines f JOIN drivers d ON d.id = f.driver_id WHERE f.id = ?').get(params.id);
  await recordAudit(req, 'status_change', 'fine', params.id, existing.status, b.status);
  sendJson(res, 200, row);
}

async function remove(req, res, params) {
  const existing = await db.prepare('SELECT * FROM fines WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Fine not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  await db.prepare('DELETE FROM fines WHERE id = ?').run(params.id);
  await recordAudit(req, 'delete', 'fine', params.id, existing, null);
  sendJson(res, 200, { ok: true });
}

module.exports = { CATEGORIES, RECOVERY_METHODS, list, create, update, setStatus, remove };
