const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const { recordAudit } = require('../lib/audit');

const VEHICLE_STATUSES = ['active', 'maintenance', 'retired'];

async function vehicleDocCounts() {
  const rows = await db.prepare('SELECT vehicle_id, COUNT(*) AS n FROM vehicle_documents GROUP BY vehicle_id').all();
  const map = {};
  for (const r of rows) map[r.vehicle_id] = r.n;
  return map;
}

async function list(req, res) {
  const rows = await db
    .prepare(
      `SELECT v.*, d.name AS driver_name, d.status AS driver_status
       FROM vehicles v LEFT JOIN drivers d ON d.id = v.assigned_driver_id
       ORDER BY v.reg_no`
    )
    .all();
  const docCounts = await vehicleDocCounts();
  sendJson(res, 200, rows.map((v) => ({ ...v, document_count: docCounts[v.id] || 0 })));
}

async function getOne(req, res, params) {
  const vehicle = await db
    .prepare(
      `SELECT v.*, d.name AS driver_name, d.status AS driver_status
       FROM vehicles v LEFT JOIN drivers d ON d.id = v.assigned_driver_id
       WHERE v.id = ?`
    )
    .get(params.id);
  if (!vehicle) return sendJson(res, 404, { error: 'Vehicle not found' });
  const documents = await db
    .prepare('SELECT id, doc_type, label, file_name, file_mime, file_size, issued_on, expires_on, notes, uploaded_at FROM vehicle_documents WHERE vehicle_id = ? ORDER BY uploaded_at DESC')
    .all(params.id);
  sendJson(res, 200, { ...vehicle, documents });
}

async function assertDriverAssignable(driverId) {
  if (driverId == null || driverId === '') return null;
  const driver = await db.prepare('SELECT id, name, status FROM drivers WHERE id = ?').get(driverId);
  if (!driver) throw Object.assign(new Error('Selected driver does not exist'), { statusCode: 400 });
  if (driver.status !== 'active') {
    throw Object.assign(new Error(`Cannot assign a vehicle to ${driver.name}, who is ${driver.status}.`), { statusCode: 409 });
  }
  return driver.id;
}

async function create(req, res) {
  const b = await readJsonBody(req);
  if (!b.reg_no || !String(b.reg_no).trim()) {
    return sendJson(res, 400, { error: 'Registration number is required' });
  }
  const existing = await db.prepare('SELECT id FROM vehicles WHERE reg_no = ?').get(String(b.reg_no).trim().toUpperCase());
  if (existing) return sendJson(res, 409, { error: 'A vehicle with this registration number already exists' });

  let driverId;
  try {
    driverId = await assertDriverAssignable(b.assigned_driver_id);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }

  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO vehicles (reg_no, model, vehicle_type, assigned_driver_id, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(String(b.reg_no).trim().toUpperCase(), b.model || null, b.vehicle_type || null, driverId, b.notes || null, now, now);
  const vehicle = await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'vehicle', info.lastInsertRowid, null, vehicle);
  sendJson(res, 201, vehicle);
}

async function update(req, res, params) {
  const existing = await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Vehicle not found' });
  const b = await readJsonBody(req);
  if (!b.reg_no || !String(b.reg_no).trim()) {
    return sendJson(res, 400, { error: 'Registration number is required' });
  }
  const dupe = await db
    .prepare('SELECT id FROM vehicles WHERE reg_no = ? AND id != ?')
    .get(String(b.reg_no).trim().toUpperCase(), params.id);
  if (dupe) return sendJson(res, 409, { error: 'A vehicle with this registration number already exists' });

  if (b.status && !VEHICLE_STATUSES.includes(b.status)) {
    return sendJson(res, 400, { error: 'Unknown vehicle status' });
  }

  let driverId;
  try {
    driverId = await assertDriverAssignable(b.assigned_driver_id);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE vehicles SET reg_no = ?, model = ?, vehicle_type = ?, assigned_driver_id = ?, status = ?, notes = ?, emi_amount = ?, emi_period = ?, is_jiju = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    String(b.reg_no).trim().toUpperCase(),
    b.model || null,
    b.vehicle_type || null,
    driverId,
    b.status || existing.status,
    b.notes || null,
    b.emi_amount != null && b.emi_amount !== '' ? Number(b.emi_amount) : existing.emi_amount,
    b.emi_period || existing.emi_period || 'monthly',
    b.is_jiju != null ? (b.is_jiju ? 1 : 0) : existing.is_jiju,
    now,
    params.id
  );
  const vehicle = await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(params.id);
  await recordAudit(req, 'update', 'vehicle', params.id, existing, vehicle);
  sendJson(res, 200, vehicle);
}

async function remove(req, res, params) {
  const existing = await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Vehicle not found' });
  await db.prepare('DELETE FROM vehicles WHERE id = ?').run(params.id);
  await recordAudit(req, 'delete', 'vehicle', params.id, existing, null);
  sendJson(res, 200, { ok: true });
}

module.exports = { list, getOne, create, update, remove };
