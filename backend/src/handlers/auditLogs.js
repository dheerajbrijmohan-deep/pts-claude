const { sendJson } = require('../lib/http');
const db = require('../db');

async function list(req, res) {
  const rows = await db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 300').all();
  sendJson(res, 200, rows.map((r) => ({
    ...r,
    old_value: r.old_value ? JSON.parse(r.old_value) : null,
    new_value: r.new_value ? JSON.parse(r.new_value) : null,
  })));
}

module.exports = { list };
