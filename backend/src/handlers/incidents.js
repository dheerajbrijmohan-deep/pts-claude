const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendJson, readJsonBody, readMultipart } = require('../lib/http');
const db = require('../db');
const { UPLOADS_DIR } = require('../config');
const { recordAudit } = require('../lib/audit');
const { notify } = require('../lib/notify');

const STATUSES = ['open', 'under_investigation', 'resolved', 'closed'];

async function photosFor(incidentId) {
  return db.prepare('SELECT id, stored_name, file_mime, uploaded_at FROM incident_photos WHERE incident_id = ?').all(incidentId);
}

async function list(req, res) {
  const rows = await db.prepare(
    `SELECT i.*, d.name AS driver_name, v.reg_no AS vehicle_reg_no
     FROM incidents i JOIN drivers d ON d.id = i.driver_id LEFT JOIN vehicles v ON v.id = i.vehicle_id
     ORDER BY i.incident_date DESC, i.id DESC`
  ).all();
  sendJson(res, 200, rows);
}

async function getOne(req, res, params) {
  const row = await db.prepare(
    `SELECT i.*, d.name AS driver_name, v.reg_no AS vehicle_reg_no
     FROM incidents i JOIN drivers d ON d.id = i.driver_id LEFT JOIN vehicles v ON v.id = i.vehicle_id
     WHERE i.id = ?`
  ).get(params.id);
  if (!row) return sendJson(res, 404, { error: 'Incident not found' });
  sendJson(res, 200, { ...row, photos: await photosFor(row.id) });
}

async function storeUploadedPhotos(incidentId, files) {
  const now = new Date().toISOString();
  for (const file of files) {
    const ext = path.extname(file.fileName || '');
    const storedName = crypto.randomUUID() + (ext && ext.length <= 10 ? ext : '');
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.data);
    await db.prepare('INSERT INTO incident_photos (incident_id, stored_name, file_mime, uploaded_at) VALUES (?,?,?,?)')
      .run(incidentId, storedName, file.mimeType, now);
  }
}

// Admin-reported incident (JSON body, no photos) — for logging something after the fact.
async function create(req, res) {
  const b = await readJsonBody(req);
  if (!b.driver_id || !b.incident_date) return sendJson(res, 400, { error: 'Driver and date are required' });
  const driver = await db.prepare('SELECT id FROM drivers WHERE id = ?').get(b.driver_id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const now = new Date().toISOString();
  const info = await db.prepare(
    `INSERT INTO incidents (driver_id, vehicle_id, incident_date, incident_time, location, description, other_vehicle_info, police_complaint_no, injury_details, repair_cost, status, reported_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'open','admin',?,?)`
  ).run(
    b.driver_id, b.vehicle_id || null, b.incident_date, b.incident_time || null, b.location || null,
    b.description || null, b.other_vehicle_info || null, b.police_complaint_no || null, b.injury_details || null,
    b.repair_cost != null && b.repair_cost !== '' ? Number(b.repair_cost) : 0,
    now, now
  );
  const row = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'incident', info.lastInsertRowid, null, row);
  await notify('critical', `Incident logged for driver #${b.driver_id} on ${b.incident_date}`, { driverId: b.driver_id, vehicleId: b.vehicle_id || null });
  sendJson(res, 201, row);
}

// Driver-reported incident (multipart, with photos).
async function createFromDriver(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) return sendJson(res, 400, { error: 'Expected multipart/form-data upload' });
  let parsed;
  try {
    parsed = await readMultipart(req, contentType);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }
  const f = parsed.fields;
  if (!f.incident_date) return sendJson(res, 400, { error: 'Date is required' });
  const assignedVehicle = await db.prepare('SELECT id FROM vehicles WHERE assigned_driver_id = ?').get(req.driver.id);
  const now = new Date().toISOString();
  const info = await db.prepare(
    `INSERT INTO incidents (driver_id, vehicle_id, incident_date, incident_time, location, description, other_vehicle_info, police_complaint_no, injury_details, repair_cost, status, reported_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,'open','driver',?,?)`
  ).run(
    req.driver.id, assignedVehicle ? assignedVehicle.id : null, f.incident_date, f.incident_time || null, f.location || null,
    f.description || null, f.other_vehicle_info || null, f.police_complaint_no || null, f.injury_details || null,
    now, now
  );
  await storeUploadedPhotos(info.lastInsertRowid, parsed.files);
  await notify('critical', `${req.driver.name} reported an incident on ${f.incident_date}`, { driverId: req.driver.id, vehicleId: assignedVehicle ? assignedVehicle.id : null });
  const row = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(info.lastInsertRowid);
  sendJson(res, 201, { ...row, photos: await photosFor(row.id) });
}

async function listMyIncidents(req, res) {
  const rows = await db.prepare('SELECT * FROM incidents WHERE driver_id = ? ORDER BY incident_date DESC, id DESC').all(req.driver.id);
  sendJson(res, 200, rows);
}

async function update(req, res, params) {
  const existing = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Incident not found' });
  const b = await readJsonBody(req);
  const status = b.status != null ? (STATUSES.includes(b.status) ? b.status : existing.status) : existing.status;
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE incidents SET status=?, repair_cost=?, description=?, injury_details=?, police_complaint_no=?, updated_at=? WHERE id=?`
  ).run(
    status,
    b.repair_cost != null && b.repair_cost !== '' ? Number(b.repair_cost) : existing.repair_cost,
    'description' in b ? b.description || null : existing.description,
    'injury_details' in b ? b.injury_details || null : existing.injury_details,
    'police_complaint_no' in b ? b.police_complaint_no || null : existing.police_complaint_no,
    now, params.id
  );
  const row = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(params.id);
  await recordAudit(req, 'update', 'incident', params.id, existing, row);
  sendJson(res, 200, { ...row, photos: await photosFor(row.id) });
}

function downloadPhoto(req, res, params) {
  return db.prepare('SELECT * FROM incident_photos WHERE id = ?').get(params.id).then((photo) => {
    if (!photo) return sendJson(res, 404, { error: 'Not found' });
    const filePath = path.join(UPLOADS_DIR, photo.stored_name);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'File is missing from storage' });
    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': photo.file_mime || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { STATUSES, list, getOne, create, createFromDriver, listMyIncidents, update, downloadPhoto };
