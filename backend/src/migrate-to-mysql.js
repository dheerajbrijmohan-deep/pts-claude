// One-time migration: copies every row out of the old SQLite database
// (backend/data/fleet.db) into the new MySQL database. Safe to re-run — it
// truncates the MySQL tables first, so re-running just re-copies fresh from
// SQLite rather than duplicating rows. Uploaded document/photo files on disk
// (backend/data/uploads) are untouched — only the metadata rows move.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = require('./db');
const { pool, ready } = db;
const { DB_PATH } = require('./config');

const SQLITE_PATH = process.argv[2] || DB_PATH;

const AUTO_INCREMENT_TABLES = [
  'vehicles', 'duty_logs', 'location_pings', 'driving_events', 'fuel_entries',
  'expense_claims', 'leave_requests', 'announcements', 'drivers',
  'driver_documents', 'vehicle_documents', 'status_change_log',
];

const TABLES = [
  { name: 'drivers', columns: ['id', 'name', 'father_name', 'phone', 'license_no', 'pan_no', 'aadhar_no', 'status', 'commission_pct', 'joined_on', 'blood_group', 'marital_status', 'experience', 'current_address_line1', 'current_address_line2', 'current_address_city', 'current_address_state', 'current_address_pincode', 'permanent_same_as_current', 'permanent_address_line1', 'permanent_address_line2', 'permanent_address_city', 'permanent_address_state', 'permanent_address_pincode', 'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation', 'bank_account_no', 'bank_name', 'bank_branch', 'bank_ifsc', 'notes', 'pin_hash', 'created_at', 'updated_at'] },
  { name: 'vehicles', columns: ['id', 'reg_no', 'model', 'vehicle_type', 'assigned_driver_id', 'status', 'notes', 'created_at', 'updated_at'] },
  { name: 'duty_logs', columns: ['id', 'driver_id', 'vehicle_id', 'log_date', 'start_reading', 'end_reading', 'total_run', 'total_earning', 'trip_count', 'commission_pct_snapshot', 'commission_amount', 'shift_status', 'check_in_at', 'lunch_start_at', 'lunch_end_at', 'check_out_at', 'driver_submitted_at', 'admin_updated_at', 'created_at', 'updated_at'] },
  { name: 'driver_sessions', columns: ['token', 'driver_id', 'created_at', 'expires_at'] },
  { name: 'location_pings', columns: ['id', 'driver_id', 'duty_log_id', 'lat', 'lng', 'speed_kmh', 'recorded_at'] },
  { name: 'driving_events', columns: ['id', 'driver_id', 'duty_log_id', 'event_type', 'g_force', 'lat', 'lng', 'created_at'] },
  { name: 'fuel_entries', columns: ['id', 'duty_log_id', 'fuel_type', 'amount', 'pump_photo_stored_name', 'odometer_photo_stored_name', 'created_at'] },
  { name: 'expense_claims', columns: ['id', 'driver_id', 'category', 'amount', 'notes', 'photo_stored_name', 'photo_file_name', 'photo_mime', 'status', 'admin_note', 'decided_at', 'created_at'] },
  { name: 'leave_requests', columns: ['id', 'driver_id', 'start_date', 'end_date', 'reason', 'status', 'admin_note', 'decided_at', 'created_at'] },
  { name: 'announcements', columns: ['id', 'driver_id', 'message', 'acknowledged_at', 'created_at'] },
  { name: 'driver_documents', columns: ['id', 'driver_id', 'doc_type', 'label', 'file_name', 'stored_name', 'file_mime', 'file_size', 'issued_on', 'expires_on', 'notes', 'uploaded_at'] },
  { name: 'vehicle_documents', columns: ['id', 'vehicle_id', 'doc_type', 'label', 'file_name', 'stored_name', 'file_mime', 'file_size', 'issued_on', 'expires_on', 'notes', 'uploaded_at'] },
  { name: 'status_change_log', columns: ['id', 'driver_id', 'action', 'from_status', 'to_status', 'reason', 'by_admin', 'created_at'] },
  { name: 'sessions', columns: ['token', 'created_at', 'expires_at'] },
  { name: 'settings', columns: ['key', 'value'] },
];

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`No SQLite database found at ${SQLITE_PATH}`);
    process.exit(1);
  }

  await ready;
  const sqlite = new DatabaseSync(SQLITE_PATH);

  console.log(`Migrating from ${SQLITE_PATH} into MySQL...`);

  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [...TABLES].reverse()) {
    await pool.query(`TRUNCATE TABLE ${t.name}`);
  }

  for (const t of TABLES) {
    const rows = sqlite.prepare(`SELECT ${t.columns.map((c) => `"${c}"`).join(',')} FROM ${t.name}`).all();
    if (!rows.length) { console.log(`  ${t.name}: 0 rows`); continue; }
    const colList = t.columns.map((c) => `\`${c}\``).join(',');
    const placeholders = `(${t.columns.map(() => '?').join(',')})`;
    const insert = db.prepare(`INSERT INTO ${t.name} (${colList}) VALUES ${placeholders}`);
    for (const row of rows) {
      await insert.run(...t.columns.map((c) => row[c]));
    }
    console.log(`  ${t.name}: ${rows.length} rows`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  // keep AUTO_INCREMENT counters ahead of the migrated ids so new rows don't collide
  for (const table of AUTO_INCREMENT_TABLES) {
    const [rows] = await pool.query(`SELECT COALESCE(MAX(id), 0) AS maxId FROM ${table}`);
    await pool.query(`ALTER TABLE ${table} AUTO_INCREMENT = ${rows[0].maxId + 1}`);
  }

  sqlite.close();
  console.log('Migration complete. Uploaded files under backend/data/uploads were left as-is.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
