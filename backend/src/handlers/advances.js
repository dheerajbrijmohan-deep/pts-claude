// Running advance ledger. Each row is money handed to a driver ahead of
// payroll; it sits "outstanding" until a payroll run sweeps it up (see
// payroll.js) and marks it "recovered" against that specific run.
const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const { assertNotCommitted } = require('../lib/locks');
const { recordAudit } = require('../lib/audit');

async function list(req, res, params, query) {
  const rows = query.driver_id
    ? await db.prepare('SELECT a.*, d.name AS driver_name FROM advances a JOIN drivers d ON d.id = a.driver_id WHERE a.driver_id = ? ORDER BY a.date DESC').all(query.driver_id)
    : await db.prepare('SELECT a.*, d.name AS driver_name FROM advances a JOIN drivers d ON d.id = a.driver_id ORDER BY a.date DESC').all();
  sendJson(res, 200, rows);
}

async function balance(req, res, params, query) {
  if (!query.driver_id) return sendJson(res, 400, { error: 'driver_id is required' });
  const row = await db.prepare("SELECT COALESCE(SUM(amount),0) AS outstanding FROM advances WHERE driver_id = ? AND status = 'outstanding'").get(query.driver_id);
  sendJson(res, 200, { outstanding: row.outstanding });
}

async function create(req, res) {
  const b = await readJsonBody(req);
  if (!b.driver_id || !b.date) return sendJson(res, 400, { error: 'Driver and date are required' });
  if (!b.amount || Number(b.amount) <= 0) return sendJson(res, 400, { error: 'Amount must be greater than zero' });
  const driver = await db.prepare('SELECT id, name FROM drivers WHERE id = ?').get(b.driver_id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const now = new Date().toISOString();
  const info = await db.prepare(
    "INSERT INTO advances (driver_id, date, amount, note, status, created_by, created_at) VALUES (?,?,?,?,'outstanding',?,?)"
  ).run(b.driver_id, b.date, Number(b.amount), b.note || null, req.adminUser.id, now);
  const row = await db.prepare('SELECT a.*, d.name AS driver_name FROM advances a JOIN drivers d ON d.id = a.driver_id WHERE a.id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'advance', info.lastInsertRowid, null, row);
  sendJson(res, 201, row);
}

async function update(req, res, params) {
  const existing = await db.prepare('SELECT * FROM advances WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Advance not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (existing.status !== 'outstanding') {
    return sendJson(res, 409, { error: 'This advance has already been recovered in a payroll run and can no longer be edited.' });
  }
  const b = await readJsonBody(req);
  await db.prepare('UPDATE advances SET date=?, amount=?, note=? WHERE id=?').run(
    b.date || existing.date,
    b.amount != null ? Number(b.amount) : existing.amount,
    'note' in b ? b.note || null : existing.note,
    params.id
  );
  const row = await db.prepare('SELECT a.*, d.name AS driver_name FROM advances a JOIN drivers d ON d.id = a.driver_id WHERE a.id = ?').get(params.id);
  await recordAudit(req, 'update', 'advance', params.id, existing, row);
  sendJson(res, 200, row);
}

async function remove(req, res, params) {
  const existing = await db.prepare('SELECT * FROM advances WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Advance not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (existing.status !== 'outstanding') {
    return sendJson(res, 409, { error: 'This advance has already been recovered in a payroll run and can no longer be deleted.' });
  }
  await db.prepare('DELETE FROM advances WHERE id = ?').run(params.id);
  await recordAudit(req, 'delete', 'advance', params.id, existing, null);
  sendJson(res, 200, { ok: true });
}

module.exports = { list, balance, create, update, remove };
