const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendJson, readMultipart } = require('../lib/http');
const db = require('../db');
const { UPLOADS_DIR } = require('../config');
const { recordAudit } = require('../lib/audit');

const DRIVER_DOC_TYPES = ['license', 'aadhar', 'pan', 'police_verification', 'badge', 'photo', 'other'];
const VEHICLE_DOC_TYPES = ['rc', 'insurance', 'puc', 'fitness', 'permit', 'road_tax', 'other'];

function extOf(fileName) {
  const ext = path.extname(fileName || '');
  return ext && ext.length <= 10 ? ext : '';
}

function uploadFor(kind) {
  const table = kind === 'driver' ? 'driver_documents' : 'vehicle_documents';
  const ownerCol = kind === 'driver' ? 'driver_id' : 'vehicle_id';
  const ownerTable = kind === 'driver' ? 'drivers' : 'vehicles';
  const validTypes = kind === 'driver' ? DRIVER_DOC_TYPES : VEHICLE_DOC_TYPES;

  return async function handler(req, res, params) {
    const owner = await db.prepare(`SELECT id FROM ${ownerTable} WHERE id = ?`).get(params.id);
    if (!owner) return sendJson(res, 404, { error: `${kind === 'driver' ? 'Driver' : 'Vehicle'} not found` });

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
    const file = parsed.files[0];
    if (!file) return sendJson(res, 400, { error: 'No file was uploaded' });

    const docType = validTypes.includes(parsed.fields.doc_type) ? parsed.fields.doc_type : 'other';
    const storedName = crypto.randomUUID() + extOf(file.fileName);
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.data);

    const now = new Date().toISOString();
    const info = await db
      .prepare(
        `INSERT INTO ${table} (${ownerCol}, doc_type, label, file_name, stored_name, file_mime, file_size, issued_on, expires_on, notes, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.id,
        docType,
        parsed.fields.label || null,
        file.fileName,
        storedName,
        file.mimeType,
        file.data.length,
        parsed.fields.issued_on || null,
        parsed.fields.expires_on || null,
        parsed.fields.notes || null,
        now
      );
    const doc = await db.prepare(`SELECT id, doc_type, label, file_name, file_mime, file_size, issued_on, expires_on, notes, uploaded_at FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
    await recordAudit(req, 'upload', kind + '_document', info.lastInsertRowid, null, doc);
    sendJson(res, 201, doc);
  };
}

function downloadFor(kind) {
  const table = kind === 'driver' ? 'driver_documents' : 'vehicle_documents';
  return async function handler(req, res, params) {
    const doc = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(params.id);
    if (!doc) return sendJson(res, 404, { error: 'Document not found' });
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'File is missing from storage' });
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': doc.file_mime || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(doc.file_name)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  };
}

function removeFor(kind) {
  const table = kind === 'driver' ? 'driver_documents' : 'vehicle_documents';
  return async function handler(req, res, params) {
    const doc = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(params.id);
    if (!doc) return sendJson(res, 404, { error: 'Document not found' });
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(params.id);
    await recordAudit(req, 'delete', kind + '_document', params.id, doc, null);
    sendJson(res, 200, { ok: true });
  };
}

// Documents expiring within 30 days (or already expired), across drivers and
// vehicles both — backs the Dashboard's "Docs expiring" tile and list.
async function listExpiring(req, res) {
  const cutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await db
    .prepare(
      `SELECT 'driver' AS kind, d.id AS owner_id, d.name AS owner_label, dd.id AS doc_id, dd.doc_type, dd.expires_on
       FROM driver_documents dd JOIN drivers d ON d.id = dd.driver_id
       WHERE dd.expires_on IS NOT NULL AND dd.expires_on <= ?
       UNION ALL
       SELECT 'vehicle' AS kind, v.id AS owner_id, v.reg_no AS owner_label, vd.id AS doc_id, vd.doc_type, vd.expires_on
       FROM vehicle_documents vd JOIN vehicles v ON v.id = vd.vehicle_id
       WHERE vd.expires_on IS NOT NULL AND vd.expires_on <= ?
       ORDER BY expires_on ASC`
    )
    .all(cutoff, cutoff);
  sendJson(res, 200, rows);
}

module.exports = {
  DRIVER_DOC_TYPES,
  VEHICLE_DOC_TYPES,
  uploadDriverDoc: uploadFor('driver'),
  uploadVehicleDoc: uploadFor('vehicle'),
  downloadDriverDoc: downloadFor('driver'),
  downloadVehicleDoc: downloadFor('vehicle'),
  removeDriverDoc: removeFor('driver'),
  removeVehicleDoc: removeFor('vehicle'),
  listExpiring,
};
