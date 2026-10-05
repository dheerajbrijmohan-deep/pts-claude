const crypto = require('node:crypto');
const db = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'fc_driver_session';

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(pin || ''), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function setPin(driverId, pin) {
  if (!/^\d{4,6}$/.test(String(pin))) {
    throw Object.assign(new Error('PIN must be 4 to 6 digits'), { statusCode: 400 });
  }
  await db.prepare('UPDATE drivers SET pin_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPin(pin),
    new Date().toISOString(),
    driverId
  );
}

async function findDriverByPhone(phone) {
  return db.prepare('SELECT * FROM drivers WHERE phone = ?').get(phone);
}

async function createSession(driverId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await db.prepare('INSERT INTO driver_sessions (token, driver_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    driverId,
    now.toISOString(),
    expires.toISOString()
  );
  return { token, expires };
}

async function destroySession(token) {
  if (!token) return;
  await db.prepare('DELETE FROM driver_sessions WHERE token = ?').run(token);
}

async function getDriverForSession(token) {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT d.* FROM driver_sessions s JOIN drivers d ON d.id = s.driver_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, new Date().toISOString());
  return row || null;
}

function sessionCookieHeader(token, expires) {
  return [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${expires.toUTCString()}`].join('; ');
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

module.exports = {
  COOKIE_NAME,
  hashPin,
  verifyPin,
  setPin,
  findDriverByPhone,
  createSession,
  destroySession,
  getDriverForSession,
  sessionCookieHeader,
  clearCookieHeader,
};
