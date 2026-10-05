const { sendJson, readJsonBody, parseCookies } = require('../lib/http');
const auth = require('../auth');
const { recordAudit } = require('../lib/audit');

async function login(req, res) {
  const body = await readJsonBody(req);
  const user = await auth.authenticate(body.username, body.password);
  if (!user) {
    await recordAudit(req, 'login_failure', 'auth', null, null, { username: body.username }, null);
    return sendJson(res, 401, { error: 'Invalid username or password' });
  }
  const { token, expires } = await auth.createSession(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(token, expires));
  await recordAudit(req, 'login_success', 'auth', user.id, null, { username: user.username }, user);
  sendJson(res, 200, { ok: true, username: user.username, role: user.role });
}

async function logout(req, res) {
  const cookies = parseCookies(req);
  await auth.destroySession(cookies[auth.COOKIE_NAME]);
  res.setHeader('Set-Cookie', auth.clearCookieHeader());
  await recordAudit(req, 'logout', 'auth', req.adminUser ? req.adminUser.id : null, null, null);
  sendJson(res, 200, { ok: true });
}

async function me(req, res) {
  sendJson(res, 200, { username: req.adminUser.username, role: req.adminUser.role });
}

module.exports = { login, logout, me };
