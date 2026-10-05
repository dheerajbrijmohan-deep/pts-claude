const { sendJson, readJsonBody } = require('../lib/http');
const auth = require('../auth');

async function getSettings(req, res) {
  sendJson(res, 200, { username: req.adminUser.username, role: req.adminUser.role });
}

async function changePassword(req, res) {
  const b = await readJsonBody(req);
  try {
    await auth.changeOwnPassword(req.adminUser.id, b.currentPassword, b.newPassword);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
  }
}

module.exports = { getSettings, changePassword };
