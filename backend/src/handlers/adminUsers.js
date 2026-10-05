const { sendJson, readJsonBody } = require('../lib/http');
const auth = require('../auth');
const { recordAudit } = require('../lib/audit');

async function list(req, res) {
  sendJson(res, 200, await auth.listAdminUsers());
}

async function create(req, res) {
  const b = await readJsonBody(req);
  try {
    const user = await auth.createAdminUser({ username: b.username, password: b.password, role: b.role || 'manager' });
    await recordAudit(req, 'create', 'admin_user', user.id, null, user);
    sendJson(res, 201, user);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
  }
}

async function update(req, res, params) {
  const b = await readJsonBody(req);
  try {
    const before = (await auth.listAdminUsers()).find((u) => u.id === Number(params.id));
    const user = await auth.updateAdminUser(Number(params.id), { role: b.role, active: b.active });
    await recordAudit(req, 'update', 'admin_user', params.id, before, user);
    sendJson(res, 200, user);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
  }
}

async function resetPassword(req, res, params) {
  const b = await readJsonBody(req);
  try {
    await auth.resetAdminUserPassword(Number(params.id), b.newPassword);
    await recordAudit(req, 'reset_password', 'admin_user', params.id, null, null); // never log password values
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
  }
}

module.exports = { list, create, update, resetPassword };
