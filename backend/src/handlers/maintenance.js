const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const { recordAudit } = require('../lib/audit');

const TYPES = ['oil_change', 'tyre_replacement', 'brake_service', 'general_service', 'battery', 'engine_repair', 'other'];

async function list(req, res, params, query) {
  const rows = query.vehicle_id
    ? await db.prepare('SELECT m.*, v.reg_no FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.vehicle_id = ? ORDER BY m.service_date DESC').all(query.vehicle_id)
    : await db.prepare('SELECT m.*, v.reg_no FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id ORDER BY m.service_date DESC').all();
  sendJson(res, 200, rows);
}

// Due-soon = next_due_date within 14 days (or already past), OR the vehicle's
// most recent odometer reading is within 500km of next_due_km.
async function dueSoon(req, res) {
  const cutoff = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await db.prepare(
    `SELECT m.*, v.reg_no,
            (SELECT MAX(end_reading) FROM duty_logs WHERE vehicle_id = v.id) AS latest_odometer
     FROM maintenance_records m
     JOIN vehicles v ON v.id = m.vehicle_id
     WHERE m.id IN (
       SELECT MAX(id) FROM maintenance_records GROUP BY vehicle_id, type
     )`
  ).all();
  const due = rows.filter((r) => {
    if (r.next_due_date && r.next_due_date <= cutoff) return true;
    if (r.next_due_km != null && r.latest_odometer != null && r.latest_odometer >= r.next_due_km - 500) return true;
    return false;
  });
  sendJson(res, 200, due);
}

async function create(req, res) {
  const b = await readJsonBody(req);
  if (!b.vehicle_id || !b.service_date) return sendJson(res, 400, { error: 'Vehicle and service date are required' });
  const vehicle = await db.prepare('SELECT id, reg_no FROM vehicles WHERE id = ?').get(b.vehicle_id);
  if (!vehicle) return sendJson(res, 404, { error: 'Vehicle not found' });
  const type = TYPES.includes(b.type) ? b.type : 'other';
  const now = new Date().toISOString();
  const info = await db.prepare(
    `INSERT INTO maintenance_records (vehicle_id, type, service_date, odometer_km, cost, next_due_date, next_due_km, notes, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.vehicle_id, type, b.service_date,
    b.odometer_km != null && b.odometer_km !== '' ? Number(b.odometer_km) : null,
    b.cost != null && b.cost !== '' ? Number(b.cost) : 0,
    b.next_due_date || null,
    b.next_due_km != null && b.next_due_km !== '' ? Number(b.next_due_km) : null,
    b.notes || null, req.adminUser.id, now
  );
  const row = await db.prepare('SELECT m.*, v.reg_no FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'maintenance_record', info.lastInsertRowid, null, row);
  sendJson(res, 201, row);
}

async function update(req, res, params) {
  const existing = await db.prepare('SELECT * FROM maintenance_records WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Maintenance record not found' });
  const b = await readJsonBody(req);
  const type = b.type != null ? (TYPES.includes(b.type) ? b.type : existing.type) : existing.type;
  await db.prepare(
    `UPDATE maintenance_records SET type=?, service_date=?, odometer_km=?, cost=?, next_due_date=?, next_due_km=?, notes=? WHERE id=?`
  ).run(
    type,
    b.service_date || existing.service_date,
    b.odometer_km != null && b.odometer_km !== '' ? Number(b.odometer_km) : existing.odometer_km,
    b.cost != null && b.cost !== '' ? Number(b.cost) : existing.cost,
    'next_due_date' in b ? b.next_due_date || null : existing.next_due_date,
    b.next_due_km != null && b.next_due_km !== '' ? Number(b.next_due_km) : existing.next_due_km,
    'notes' in b ? b.notes || null : existing.notes,
    params.id
  );
  const row = await db.prepare('SELECT m.*, v.reg_no FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.id = ?').get(params.id);
  await recordAudit(req, 'update', 'maintenance_record', params.id, existing, row);
  sendJson(res, 200, row);
}

async function remove(req, res, params) {
  const existing = await db.prepare('SELECT * FROM maintenance_records WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Maintenance record not found' });
  await db.prepare('DELETE FROM maintenance_records WHERE id = ?').run(params.id);
  await recordAudit(req, 'delete', 'maintenance_record', params.id, existing, null);
  sendJson(res, 200, { ok: true });
}

module.exports = { TYPES, list, dueSoon, create, update, remove };
