const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const { recordAudit } = require('../lib/audit');

const VALID_ACTIONS = {
  suspend: { from: ['active'], to: 'suspended' },
  reinstate: { from: ['suspended', 'terminated'], to: 'active' },
  terminate: { from: ['active', 'suspended'], to: 'terminated' },
};

function stripPinHash(driver) {
  const { pin_hash, ...rest } = driver;
  return { ...rest, has_pin: !!pin_hash };
}

async function driverDocCounts() {
  const rows = await db.prepare('SELECT driver_id, COUNT(*) AS n FROM driver_documents GROUP BY driver_id').all();
  const map = {};
  for (const r of rows) map[r.driver_id] = r.n;
  return map;
}

async function vehicleAssignments() {
  const rows = await db.prepare("SELECT id, reg_no, assigned_driver_id FROM vehicles WHERE assigned_driver_id IS NOT NULL").all();
  const map = {};
  for (const r of rows) map[r.assigned_driver_id] = { id: r.id, reg_no: r.reg_no };
  return map;
}

async function todayShiftStatuses() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .prepare('SELECT driver_id, shift_status, check_in_at, lunch_start_at, lunch_end_at, check_out_at FROM duty_logs WHERE log_date = ?')
    .all(today);
  const map = {};
  for (const r of rows) map[r.driver_id] = r;
  return map;
}

async function list(req, res) {
  const rows = await db.prepare('SELECT * FROM drivers ORDER BY name').all();
  const docCounts = await driverDocCounts();
  const assignments = await vehicleAssignments();
  const shifts = await todayShiftStatuses();
  const out = rows.map((d) => ({
    ...stripPinHash(d),
    document_count: docCounts[d.id] || 0,
    assigned_vehicle: assignments[d.id] || null,
    today_shift: shifts[d.id] || { shift_status: 'not_started' },
  }));
  sendJson(res, 200, out);
}

async function getOne(req, res, params) {
  const driverRow = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  if (!driverRow) return sendJson(res, 404, { error: 'Driver not found' });
  const driver = stripPinHash(driverRow);
  const documents = await db
    .prepare('SELECT id, doc_type, label, file_name, file_mime, file_size, issued_on, expires_on, notes, uploaded_at FROM driver_documents WHERE driver_id = ? ORDER BY uploaded_at DESC')
    .all(params.id);
  const history = await db
    .prepare('SELECT * FROM status_change_log WHERE driver_id = ? ORDER BY created_at DESC')
    .all(params.id);
  const vehicle = await db.prepare('SELECT id, reg_no, model FROM vehicles WHERE assigned_driver_id = ?').get(params.id);
  sendJson(res, 200, { ...driver, documents, history, assigned_vehicle: vehicle || null });
}

const PERSONAL_FIELDS = [
  'license_no', 'pan_no', 'aadhar_no', 'blood_group', 'marital_status', 'experience',
  'current_address_line1', 'current_address_line2', 'current_address_city', 'current_address_state', 'current_address_pincode',
  'permanent_address_line1', 'permanent_address_line2', 'permanent_address_city', 'permanent_address_state', 'permanent_address_pincode',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  'bank_account_no', 'bank_name', 'bank_branch', 'bank_ifsc',
];

async function create(req, res) {
  const b = await readJsonBody(req);
  if (!b.name || !String(b.name).trim()) {
    return sendJson(res, 400, { error: 'Driver name is required' });
  }
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO drivers (name, father_name, phone, status, commission_pct, joined_on, notes, permanent_same_as_current, ${PERSONAL_FIELDS.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ${PERSONAL_FIELDS.map(() => '?').join(', ')}, ?, ?)`
    )
    .run(
      String(b.name).trim(),
      b.father_name || null,
      b.phone || null,
      b.commission_pct != null && b.commission_pct !== '' ? Number(b.commission_pct) : 20,
      b.joined_on || now.slice(0, 10),
      b.notes || null,
      b.permanent_same_as_current ? 1 : 0,
      ...PERSONAL_FIELDS.map((f) => b[f] || null),
      now,
      now
    );
  const driver = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'driver', info.lastInsertRowid, null, stripPinHash(driver));
  sendJson(res, 201, stripPinHash(driver));
}

async function update(req, res, params) {
  const existing = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Driver not found' });
  const b = await readJsonBody(req);
  if (!b.name || !String(b.name).trim()) {
    return sendJson(res, 400, { error: 'Driver name is required' });
  }
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE drivers SET name = ?, father_name = ?, phone = ?, commission_pct = ?, joined_on = ?, notes = ?, permanent_same_as_current = ?, ${PERSONAL_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ?
     WHERE id = ?`
  ).run(
    String(b.name).trim(),
    'father_name' in b ? b.father_name || null : existing.father_name,
    'phone' in b ? b.phone || null : existing.phone,
    b.commission_pct != null && b.commission_pct !== '' ? Number(b.commission_pct) : existing.commission_pct,
    b.joined_on || existing.joined_on,
    'notes' in b ? b.notes || null : existing.notes,
    'permanent_same_as_current' in b ? (b.permanent_same_as_current ? 1 : 0) : existing.permanent_same_as_current,
    ...PERSONAL_FIELDS.map((f) => (f in b ? b[f] || null : existing[f])),
    now,
    params.id
  );
  const driver = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  await recordAudit(req, 'update', 'driver', params.id, stripPinHash(existing), stripPinHash(driver));
  sendJson(res, 200, stripPinHash(driver));
}

async function changeStatus(req, res, params) {
  const existing = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Driver not found' });
  const b = await readJsonBody(req);
  const action = b.action;
  const rule = VALID_ACTIONS[action];
  if (!rule) return sendJson(res, 400, { error: 'Unknown action. Use suspend, reinstate, or terminate.' });
  if (!rule.from.includes(existing.status)) {
    return sendJson(res, 409, { error: `Cannot ${action} a driver who is currently ${existing.status}.` });
  }
  if (!b.reason || !String(b.reason).trim()) {
    return sendJson(res, 400, { error: 'A reason is required for this action.' });
  }
  const now = new Date().toISOString();
  await db.prepare('UPDATE drivers SET status = ?, updated_at = ? WHERE id = ?').run(rule.to, now, params.id);
  await db.prepare(
    `INSERT INTO status_change_log (driver_id, action, from_status, to_status, reason, by_admin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(params.id, action, existing.status, rule.to, String(b.reason).trim(), req.adminUser.username, now);
  const driver = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  await recordAudit(req, action, 'driver', params.id, existing.status, rule.to);
  sendJson(res, 200, stripPinHash(driver));
}

async function remove(req, res, params) {
  const existing = await db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Driver not found' });
  await db.prepare('DELETE FROM drivers WHERE id = ?').run(params.id);
  await recordAudit(req, 'delete', 'driver', params.id, stripPinHash(existing), null);
  sendJson(res, 200, { ok: true });
}

module.exports = { list, getOne, create, update, changeStatus, remove };
