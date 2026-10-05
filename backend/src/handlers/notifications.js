const { sendJson } = require('../lib/http');
const db = require('../db');

async function list(req, res) {
  const rows = await db.prepare(
    `SELECT n.*, d.name AS driver_name, v.reg_no AS vehicle_reg_no
     FROM notifications n LEFT JOIN drivers d ON d.id = n.driver_id LEFT JOIN vehicles v ON v.id = n.vehicle_id
     ORDER BY n.created_at DESC LIMIT 200`
  ).all();
  sendJson(res, 200, rows);
}

async function markRead(req, res, params) {
  const row = await db.prepare('SELECT id FROM notifications WHERE id = ?').get(params.id);
  if (!row) return sendJson(res, 404, { error: 'Not found' });
  await db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(new Date().toISOString(), params.id);
  sendJson(res, 200, { ok: true });
}

async function markAllRead(req, res) {
  await db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(new Date().toISOString());
  sendJson(res, 200, { ok: true });
}

module.exports = { list, markRead, markAllRead };
