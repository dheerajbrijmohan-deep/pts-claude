const crypto = require('node:crypto');
const db = require('./db');
const { hashPassword } = db;

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const COOKIE_NAME = 'fc_session';

function verifyPasswordHash(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password || '', salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Password policy for every admin/manager account: at least 8 characters,
// with at least one uppercase letter, one lowercase letter, and one digit.
function validatePasswordPolicy(password) {
  const value = String(password || '');
  if (value.length < 8 || !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) {
    throw Object.assign(
      new Error('Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.'),
      { statusCode: 400 }
    );
  }
}

function publicAdminUser(u) {
  return { id: u.id, username: u.username, role: u.role, active: !!u.active, createdAt: u.created_at };
}

async function authenticate(username, password) {
  const user = await db.prepare('SELECT * FROM admin_users WHERE username = ? AND active = 1').get(username);
  if (!user || !verifyPasswordHash(password, user.password_hash)) return null;
  return user;
}

async function changeOwnPassword(adminUserId, currentPassword, newPassword) {
  const user = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(adminUserId);
  if (!user || !verifyPasswordHash(currentPassword, user.password_hash)) {
    throw Object.assign(new Error('Current password is incorrect.'), { statusCode: 401 });
  }
  validatePasswordPolicy(newPassword);
  const now = new Date().toISOString();
  await db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(newPassword), now, user.id);
}

// ---- Boss-only admin-user management ----
async function listAdminUsers() {
  const rows = await db.prepare('SELECT * FROM admin_users ORDER BY id').all();
  return rows.map(publicAdminUser);
}

async function countActiveBosses(excludingId) {
  const rows = await db.prepare("SELECT id FROM admin_users WHERE role = 'boss' AND active = 1").all();
  return rows.filter((r) => r.id !== excludingId).length;
}

async function createAdminUser({ username, password, role }) {
  if (!username || !String(username).trim()) throw Object.assign(new Error('Username is required'), { statusCode: 400 });
  validatePasswordPolicy(password);
  if (!['boss', 'manager'].includes(role)) throw Object.assign(new Error('Role must be boss or manager'), { statusCode: 400 });
  const existing = await db.prepare('SELECT id FROM admin_users WHERE username = ?').get(String(username).trim());
  if (existing) throw Object.assign(new Error('That username is already taken'), { statusCode: 409 });
  const now = new Date().toISOString();
  const info = await db.prepare('INSERT INTO admin_users (username, password_hash, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)')
    .run(String(username).trim(), hashPassword(password), role, now, now);
  return publicAdminUser(await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(info.lastInsertRowid));
}

async function updateAdminUser(id, { role, active }) {
  const user = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
  if (!user) throw Object.assign(new Error('Admin user not found'), { statusCode: 404 });
  const nextRole = role != null ? role : user.role;
  const nextActive = active != null ? (active ? 1 : 0) : user.active;
  if (!['boss', 'manager'].includes(nextRole)) throw Object.assign(new Error('Role must be boss or manager'), { statusCode: 400 });
  const demotingOrDeactivatingLastBoss = user.role === 'boss' && (nextRole !== 'boss' || !nextActive);
  if (demotingOrDeactivatingLastBoss && (await countActiveBosses(id)) === 0) {
    throw Object.assign(new Error('Cannot remove the last active Boss account.'), { statusCode: 409 });
  }
  const now = new Date().toISOString();
  await db.prepare('UPDATE admin_users SET role = ?, active = ?, updated_at = ? WHERE id = ?').run(nextRole, nextActive, now, id);
  return publicAdminUser(await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id));
}

async function resetAdminUserPassword(id, newPassword) {
  validatePasswordPolicy(newPassword);
  const user = await db.prepare('SELECT id FROM admin_users WHERE id = ?').get(id);
  if (!user) throw Object.assign(new Error('Admin user not found'), { statusCode: 404 });
  const now = new Date().toISOString();
  await db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(newPassword), now, id);
}

// ---- sessions ----
async function createSession(adminUserId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await db.prepare('INSERT INTO sessions (token, admin_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    adminUserId,
    now.toISOString(),
    expires.toISOString()
  );
  return { token, expires };
}

async function destroySession(token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Returns {id, username, role} for a valid, unexpired session tied to an
// active admin user, or null.
async function getSessionUser(token) {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.role, s.expires_at FROM sessions s
       JOIN admin_users u ON u.id = s.admin_user_id
       WHERE s.token = ? AND u.active = 1`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(token);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

function sessionCookieHeader(token, expires) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ];
  return parts.join('; ');
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

module.exports = {
  COOKIE_NAME,
  authenticate,
  changeOwnPassword,
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  resetAdminUserPassword,
  createSession,
  destroySession,
  getSessionUser,
  sessionCookieHeader,
  clearCookieHeader,
};
