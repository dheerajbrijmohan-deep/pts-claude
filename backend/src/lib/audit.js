// Records who did what, for the Audit Logs screen. Covers the highest-value
// actions (auth events, driver/vehicle lifecycle, documents, fines, payroll,
// admin users, incidents, commit/uncommit) rather than literally every
// mutation in the app — standard practice audits authentication, permission
// changes, and business-critical record changes, not read-only traffic.
const db = require('../db');

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

// req: the HTTP request (used for req.adminUser and the client IP).
// adminUserOverride: pass an explicit {id, username} when there's no
// req.adminUser yet — e.g. a failed login attempt.
async function recordAudit(req, action, entityType, entityId, oldValue, newValue, adminUserOverride) {
  const adminUser = adminUserOverride || req.adminUser || null;
  await db.prepare(
    'INSERT INTO audit_logs (admin_user_id, username, action, entity_type, entity_id, old_value, new_value, ip_address, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    adminUser ? adminUser.id : null,
    adminUser ? adminUser.username : null,
    action,
    entityType,
    entityId != null ? String(entityId) : null,
    oldValue != null ? JSON.stringify(oldValue) : null,
    newValue != null ? JSON.stringify(newValue) : null,
    clientIp(req),
    new Date().toISOString()
  );
}

module.exports = { recordAudit };
