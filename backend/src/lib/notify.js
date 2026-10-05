// Centralized notification feed. Rows are inserted at the moment a
// significant event happens (incident reported, fine issued, payroll
// generated/paid, driver suspended/terminated) — categories match the PDF's
// Critical / Warning / Reminder / Financial buckets.
const db = require('../db');

async function notify(category, message, { driverId, vehicleId } = {}) {
  await db.prepare(
    'INSERT INTO notifications (category, message, driver_id, vehicle_id, created_at) VALUES (?,?,?,?,?)'
  ).run(category, message, driverId || null, vehicleId || null, new Date().toISOString());
}

module.exports = { notify };
