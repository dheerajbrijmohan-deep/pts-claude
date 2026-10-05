const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(ENV_PATH);

// Passenger-managed hosting (DirectAdmin/cPanel Node Selector) commonly hands
// the app a Unix domain socket PATH here, not a TCP port number — Node's
// server.listen() accepts either, so this must stay a raw string/number, not
// be coerced through Number() (which would silently turn a socket path into
// NaN and fall back to the default, binding to the wrong address entirely).
const PORT = process.env.PORT || 4100;
// Legacy SQLite path — only used by the one-time migrate-to-mysql script.
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || './data/fleet.db');
const UPLOADS_DIR = path.resolve(ROOT, process.env.UPLOADS_DIR || './data/uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.MYSQL_PORT) || 3306;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'fleet_command';
const MYSQL_USER = process.env.MYSQL_USER || 'fleet_app';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
// Shared hosting typically exposes MySQL over a Unix socket rather than TCP —
// when set, this takes priority over MYSQL_HOST/MYSQL_PORT.
const MYSQL_SOCKET = process.env.MYSQL_SOCKET || '';

module.exports = {
  ROOT, PORT, DB_PATH, UPLOADS_DIR, SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD,
  MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD, MYSQL_SOCKET,
};
