// MySQL via the mysql2 driver. Exposes the same db.prepare(sql).get/all/run(...)
// shape the app used with SQLite, just async now — call sites await it.
const fs = require('node:fs');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { UPLOADS_DIR, MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD, MYSQL_SOCKET, ADMIN_USERNAME, ADMIN_PASSWORD } = require('./config');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const pool = mysql.createPool({
  ...(MYSQL_SOCKET ? { socketPath: MYSQL_SOCKET } : { host: MYSQL_HOST, port: MYSQL_PORT }),
  database: MYSQL_DATABASE,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});

function prepare(sql) {
  return {
    get: async (...params) => {
      const [rows] = await pool.execute(sql, params);
      return rows[0];
    },
    all: async (...params) => {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },
    run: async (...params) => {
      const [result] = await pool.execute(sql, params);
      return { lastInsertRowid: result.insertId, changes: result.affectedRows };
    },
  };
}

// Tables in FK-safe creation order: a table referenced by a FOREIGN KEY must
// already exist (unlike SQLite, which doesn't check this until DML runs).
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS drivers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    father_name VARCHAR(255),
    phone VARCHAR(20),
    license_no VARCHAR(50),
    pan_no VARCHAR(20),
    aadhar_no VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    commission_pct DOUBLE NOT NULL DEFAULT 20,
    joined_on VARCHAR(10),
    blood_group VARCHAR(10),
    marital_status VARCHAR(20),
    experience VARCHAR(100),
    current_address_line1 VARCHAR(255),
    current_address_line2 VARCHAR(255),
    current_address_city VARCHAR(100),
    current_address_state VARCHAR(100),
    current_address_pincode VARCHAR(10),
    permanent_same_as_current TINYINT NOT NULL DEFAULT 0,
    permanent_address_line1 VARCHAR(255),
    permanent_address_line2 VARCHAR(255),
    permanent_address_city VARCHAR(100),
    permanent_address_state VARCHAR(100),
    permanent_address_pincode VARCHAR(10),
    emergency_contact_name VARCHAR(255),
    emergency_contact_phone VARCHAR(20),
    emergency_contact_relation VARCHAR(50),
    bank_account_no VARCHAR(50),
    bank_name VARCHAR(255),
    bank_branch VARCHAR(255),
    bank_ifsc VARCHAR(20),
    notes TEXT,
    pin_hash VARCHAR(255),
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS admin_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'manager',
    active TINYINT NOT NULL DEFAULT 1,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS vehicles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    reg_no VARCHAR(50) NOT NULL UNIQUE,
    model VARCHAR(255),
    vehicle_type VARCHAR(50),
    assigned_driver_id INT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_vehicles_driver FOREIGN KEY (assigned_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS duty_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    vehicle_id INT,
    log_date VARCHAR(10) NOT NULL,
    start_reading DOUBLE,
    end_reading DOUBLE,
    total_run DOUBLE,
    total_earning DOUBLE,
    trip_count INT,
    commission_pct_snapshot DOUBLE,
    commission_amount DOUBLE,
    shift_status VARCHAR(20) NOT NULL DEFAULT 'not_started',
    check_in_at VARCHAR(40),
    lunch_start_at VARCHAR(40),
    lunch_end_at VARCHAR(40),
    check_out_at VARCHAR(40),
    driver_submitted_at VARCHAR(40),
    admin_updated_at VARCHAR(40),
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    UNIQUE KEY uq_duty_logs_driver_date (driver_id, log_date),
    CONSTRAINT fk_duty_logs_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
    CONSTRAINT fk_duty_logs_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS driver_sessions (
    token VARCHAR(64) PRIMARY KEY,
    driver_id INT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    expires_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_driver_sessions_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS location_pings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    duty_log_id INT,
    lat DOUBLE NOT NULL,
    lng DOUBLE NOT NULL,
    speed_kmh DOUBLE,
    recorded_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_location_pings_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
    CONSTRAINT fk_location_pings_duty_log FOREIGN KEY (duty_log_id) REFERENCES duty_logs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS driving_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    duty_log_id INT,
    event_type VARCHAR(30) NOT NULL,
    g_force DOUBLE,
    lat DOUBLE,
    lng DOUBLE,
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_driving_events_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
    CONSTRAINT fk_driving_events_duty_log FOREIGN KEY (duty_log_id) REFERENCES duty_logs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS fuel_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    duty_log_id INT NOT NULL,
    fuel_type VARCHAR(20) NOT NULL,
    amount DOUBLE,
    pump_photo_stored_name VARCHAR(255),
    odometer_photo_stored_name VARCHAR(255),
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_fuel_entries_duty_log FOREIGN KEY (duty_log_id) REFERENCES duty_logs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS expense_claims (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    category VARCHAR(30) NOT NULL,
    amount DOUBLE,
    notes TEXT,
    photo_stored_name VARCHAR(255),
    photo_file_name VARCHAR(255),
    photo_mime VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    decided_at VARCHAR(40),
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_expense_claims_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS leave_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    start_date VARCHAR(10) NOT NULL,
    end_date VARCHAR(10) NOT NULL,
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    decided_at VARCHAR(40),
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_leave_requests_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS fines (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    date VARCHAR(10) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'other',
    amount DOUBLE NOT NULL DEFAULT 0,
    reason TEXT,
    evidence_stored_name VARCHAR(255),
    recovery_method VARCHAR(20) NOT NULL DEFAULT 'next_payroll',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    committed_at VARCHAR(40),
    committed_by INT,
    created_by INT,
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_fines_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS payroll_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    period_start VARCHAR(10) NOT NULL,
    period_end VARCHAR(10) NOT NULL,
    gross_earnings DOUBLE NOT NULL DEFAULT 0,
    commission_amount DOUBLE NOT NULL DEFAULT 0,
    fines_amount DOUBLE NOT NULL DEFAULT 0,
    reimbursements_amount DOUBLE NOT NULL DEFAULT 0,
    advance_amount DOUBLE NOT NULL DEFAULT 0,
    net_payable DOUBLE NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    paid_at VARCHAR(40),
    notes TEXT,
    committed_at VARCHAR(40),
    committed_by INT,
    created_by INT,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_payroll_runs_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS advances (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    date VARCHAR(10) NOT NULL,
    amount DOUBLE NOT NULL DEFAULT 0,
    note TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'outstanding',
    recovered_in_payroll_id INT,
    committed_at VARCHAR(40),
    committed_by INT,
    created_by INT,
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_advances_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
    CONSTRAINT fk_advances_payroll FOREIGN KEY (recovered_in_payroll_id) REFERENCES payroll_runs(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS announcements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    message TEXT NOT NULL,
    acknowledged_at VARCHAR(40),
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_announcements_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS driver_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    doc_type VARCHAR(50) NOT NULL,
    label VARCHAR(255),
    file_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    file_mime VARCHAR(100),
    file_size INT,
    issued_on VARCHAR(10),
    expires_on VARCHAR(10),
    notes TEXT,
    uploaded_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_driver_documents_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS vehicle_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vehicle_id INT NOT NULL,
    doc_type VARCHAR(50) NOT NULL,
    label VARCHAR(255),
    file_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    file_mime VARCHAR(100),
    file_size INT,
    issued_on VARCHAR(10),
    expires_on VARCHAR(10),
    notes TEXT,
    uploaded_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_vehicle_documents_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS maintenance_records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vehicle_id INT NOT NULL,
    type VARCHAR(30) NOT NULL,
    service_date VARCHAR(10) NOT NULL,
    odometer_km DOUBLE,
    cost DOUBLE DEFAULT 0,
    next_due_date VARCHAR(10),
    next_due_km DOUBLE,
    notes TEXT,
    created_by INT,
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_maintenance_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS incidents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    vehicle_id INT,
    incident_date VARCHAR(10) NOT NULL,
    incident_time VARCHAR(10),
    location VARCHAR(255),
    description TEXT,
    other_vehicle_info TEXT,
    police_complaint_no VARCHAR(100),
    injury_details TEXT,
    repair_cost DOUBLE DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    reported_by VARCHAR(20) NOT NULL DEFAULT 'driver',
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_incidents_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
    CONSTRAINT fk_incidents_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS incident_photos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    incident_id INT NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    file_mime VARCHAR(100),
    uploaded_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_incident_photos_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    driver_id INT,
    vehicle_id INT,
    read_at VARCHAR(40),
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_notifications_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
    CONSTRAINT fk_notifications_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    admin_user_id INT,
    username VARCHAR(100),
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(50),
    old_value TEXT,
    new_value TEXT,
    ip_address VARCHAR(64),
    created_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS status_change_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    action VARCHAR(20) NOT NULL,
    from_status VARCHAR(20),
    to_status VARCHAR(20) NOT NULL,
    reason TEXT,
    by_admin VARCHAR(100),
    created_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_status_change_log_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(64) PRIMARY KEY,
    admin_user_id INT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    expires_at VARCHAR(40) NOT NULL,
    CONSTRAINT fk_sessions_admin_user FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL
  ) ENGINE=InnoDB`,

  // Leads captured from the public ptsnagpur.in website — submitted alongside
  // (not instead of) the customer's WhatsApp message, so the Boss/Manager
  // have a record even if the WhatsApp chat itself is lost or unread.
  `CREATE TABLE IF NOT EXISTS website_bookings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pickup_location VARCHAR(255) NOT NULL,
    destination VARCHAR(255) NOT NULL,
    travel_date VARCHAR(20),
    travel_time VARCHAR(20),
    passengers INT,
    customer_name VARCHAR(150) NOT NULL,
    phone_number VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'new',
    created_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS website_contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150),
    message TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'new',
    created_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE INDEX idx_location_pings_driver_time ON location_pings(driver_id, recorded_at)`,
  `CREATE INDEX idx_driving_events_driver_time ON driving_events(driver_id, created_at)`,
  `CREATE INDEX idx_notifications_created ON notifications(created_at)`,
  `CREATE INDEX idx_audit_logs_created ON audit_logs(created_at)`,
  `CREATE INDEX idx_website_bookings_created ON website_bookings(created_at)`,
  `CREATE INDEX idx_website_contacts_created ON website_contacts(created_at)`,
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Adds a column to an already-existing table if it isn't there yet — safe to
// run on every startup. Returns true only the first time it actually adds it,
// so callers can run one-time follow-up steps (backfill, constraints).
async function ensureColumn(table, column, ddl) {
  const [cols] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (cols.length) return false;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

async function init() {
  for (const stmt of SCHEMA_STATEMENTS) {
    try {
      await pool.query(stmt);
    } catch (err) {
      // indexes use plain CREATE INDEX (no IF NOT EXISTS support in MySQL) — ignore re-creation on restart
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    }
  }

  // Upgrading an install that predates admin_users: sessions.admin_user_id
  // didn't exist, so old sessions can't reference a user — clear them (a
  // one-time forced re-login) and add the column + FK for good.
  const addedSessionUserCol = await ensureColumn('sessions', 'admin_user_id', 'admin_user_id INT NULL');
  if (addedSessionUserCol) {
    await pool.query('TRUNCATE TABLE sessions');
    await pool.query('ALTER TABLE sessions MODIFY admin_user_id INT NOT NULL');
    await pool.query('ALTER TABLE sessions ADD CONSTRAINT fk_sessions_admin_user FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE');
  }

  // Commit/lock mechanic: once the Boss commits one of these records, the
  // Manager (and the driver app, for duty logs / fuel entries) can no longer
  // edit or delete it. NULL = not committed.
  for (const table of ['duty_logs', 'expense_claims', 'fuel_entries']) {
    await ensureColumn(table, 'committed_at', 'committed_at VARCHAR(40) NULL');
    await ensureColumn(table, 'committed_by', 'committed_by INT NULL');
  }

  await ensureColumn('audit_logs', 'ip_address', 'ip_address VARCHAR(64) NULL');

  // Vehicle-level Profit tab: EMI (or, for a Jiju-settlement vehicle, a flat
  // daily amount instead) plus a manual per-day maintenance figure alongside
  // the real logged maintenance_records.
  await ensureColumn('vehicles', 'emi_amount', 'emi_amount DOUBLE NULL');
  await ensureColumn('vehicles', 'emi_period', "emi_period VARCHAR(20) NULL DEFAULT 'monthly'");
  await ensureColumn('vehicles', 'is_jiju', 'is_jiju TINYINT NOT NULL DEFAULT 0');
  await ensureColumn('duty_logs', 'maintenance_amount', 'maintenance_amount DOUBLE NOT NULL DEFAULT 0');

  // Re-check-in after checkout: a driver who already checked out today can
  // ask to check in again (e.g. a split shift), but it only takes effect
  // once the Boss/Manager approves it — see driverPortal.checkIn.
  await ensureColumn('duty_logs', 'reopen_status', 'reopen_status VARCHAR(20) NULL');
  await ensureColumn('duty_logs', 'reopen_requested_at', 'reopen_requested_at VARCHAR(40) NULL');
  const [jijuSettingRows] = await pool.query("SELECT 1 FROM settings WHERE `key` = 'jiju_flat_amount'");
  if (!jijuSettingRows.length) {
    await pool.execute("INSERT INTO settings (`key`, value) VALUES ('jiju_flat_amount', '1000')");
  }

  // First run only: seed the admin login from .env into the database, so that
  // changing the password later (Settings) persists across restarts without
  // needing to rewrite the .env file.
  const [hashRows] = await pool.query("SELECT 1 FROM settings WHERE `key` = 'admin_password_hash'");
  if (!hashRows.length) {
    await pool.execute("INSERT INTO settings (`key`, value) VALUES ('admin_password_hash', ?)", [hashPassword(ADMIN_PASSWORD)]);
  }
  const [userRows] = await pool.query("SELECT 1 FROM settings WHERE `key` = 'admin_username'");
  if (!userRows.length) {
    await pool.execute("INSERT INTO settings (`key`, value) VALUES ('admin_username', ?)", [ADMIN_USERNAME]);
  }

  // Migrate the old single-admin login (settings.admin_username / admin_password_hash)
  // into admin_users as the first Boss account, first run only. Keeps the exact
  // same credentials — no disruption to whoever is already logging in.
  const [adminCountRows] = await pool.query('SELECT COUNT(*) AS n FROM admin_users');
  if (adminCountRows[0].n === 0) {
    const [usernameRows] = await pool.query("SELECT value FROM settings WHERE `key` = 'admin_username'");
    const [hashRows2] = await pool.query("SELECT value FROM settings WHERE `key` = 'admin_password_hash'");
    const username = usernameRows[0] ? usernameRows[0].value : ADMIN_USERNAME;
    const passwordHash = hashRows2[0] ? hashRows2[0].value : hashPassword(ADMIN_PASSWORD);
    const now = new Date().toISOString();
    await pool.execute(
      "INSERT INTO admin_users (username, password_hash, role, active, created_at, updated_at) VALUES (?,?,'boss',1,?,?)",
      [username, passwordHash, now, now]
    );
    console.log(`Migrated existing admin login "${username}" into admin_users as Boss.`);
  }
}

const dbCompat = { prepare, pool, ready: init(), ensureColumn, hashPassword };
module.exports = dbCompat;
