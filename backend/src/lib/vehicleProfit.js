// Per-vehicle profit calculation for the Expenses & Profit tab, ported from
// pooja-cashbook-app but adapted to this app's schema (no separate "payout"
// field here, so a duty log's total_earning stands in for it; driver
// commission is already snapshotted on the duty log at commission_amount
// rather than recomputed from a percentage).
//
// Profit = Total Earning − (Fuel + daily EMI-or-Jiju share + Maintenance
//          [logged records + a manual daily figure] + approved expense
//          claims that day + Driver's commission)
const db = require('../db');

function daysInclusive(from, to) {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  return Math.round((end - start) / 86400000) + 1;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function computeVehicleProfit(vehicleId, from, to) {
  const vehicle = await db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  if (!vehicle) throw Object.assign(new Error('Vehicle not found'), { statusCode: 404 });

  const dutyLogRows = await db.prepare('SELECT * FROM duty_logs WHERE vehicle_id = ? AND log_date BETWEEN ? AND ? ORDER BY log_date').all(vehicleId, from, to);
  const logsByDate = {};
  dutyLogRows.forEach((l) => { logsByDate[l.log_date] = l; });

  const dutyLogIds = dutyLogRows.map((l) => l.id);
  const fuelByLogId = {};
  if (dutyLogIds.length) {
    const placeholders = dutyLogIds.map(() => '?').join(',');
    const fuelRows = await db.prepare(`SELECT * FROM fuel_entries WHERE duty_log_id IN (${placeholders})`).all(...dutyLogIds);
    fuelRows.forEach((f) => { (fuelByLogId[f.duty_log_id] = fuelByLogId[f.duty_log_id] || []).push(f); });
  }

  // Real logged services (Maintenance page) that fall in range, keyed by exact service date.
  const maintenanceRows = await db.prepare('SELECT * FROM maintenance_records WHERE vehicle_id = ? AND service_date BETWEEN ? AND ?').all(vehicleId, from, to);
  const maintenanceByDate = {};
  maintenanceRows.forEach((m) => { maintenanceByDate[m.service_date] = (maintenanceByDate[m.service_date] || 0) + (Number(m.cost) || 0); });

  // Approved expense claims (puncture/accident/other), attributed to this vehicle
  // via whichever driver had it assigned on that exact day (that day's duty log).
  const driverIdsByDate = {};
  dutyLogRows.forEach((l) => { driverIdsByDate[l.log_date] = l.driver_id; });
  const involvedDriverIds = [...new Set(dutyLogRows.map((l) => l.driver_id))];
  const claimsByDriverAndDate = {};
  if (involvedDriverIds.length) {
    const placeholders = involvedDriverIds.map(() => '?').join(',');
    const claimRows = await db.prepare(
      `SELECT driver_id, amount, LEFT(created_at,10) AS claim_date FROM expense_claims WHERE status = 'approved' AND driver_id IN (${placeholders}) AND LEFT(created_at,10) BETWEEN ? AND ?`
    ).all(...involvedDriverIds, from, to);
    claimRows.forEach((c) => {
      const key = c.driver_id + '|' + c.claim_date;
      claimsByDriverAndDate[key] = (claimsByDriverAndDate[key] || 0) + (Number(c.amount) || 0);
    });
  }

  const isJiju = !!vehicle.is_jiju;
  let jijuFlatAmount = 0;
  if (isJiju) {
    const row = await db.prepare("SELECT value FROM settings WHERE `key` = 'jiju_flat_amount'").get();
    jijuFlatAmount = row ? Number(row.value) || 0 : 0;
  }
  const dailyOverhead = isJiju
    ? jijuFlatAmount
    : (vehicle.emi_period === 'daily' ? (Number(vehicle.emi_amount) || 0) : (Number(vehicle.emi_amount) || 0) / 30);

  const numDays = daysInclusive(from, to);
  const rows = [];
  const totals = {
    totalEarning: 0, totalRun: 0, fuelTotal: 0, fuelByType: {},
    driverSalary: 0, maintenanceLogged: 0, maintenanceManual: 0, supplies: 0, overhead: 0, totalCost: 0, profit: 0,
  };

  for (let i = 0; i < numDays; i++) {
    const date = addDays(from, i);
    const log = logsByDate[date];
    const fuelLines = log ? (fuelByLogId[log.id] || []) : [];
    const fuelTotal = fuelLines.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    fuelLines.forEach((f) => {
      const type = f.fuel_type ? f.fuel_type.charAt(0).toUpperCase() + f.fuel_type.slice(1) : 'Other';
      totals.fuelByType[type] = (totals.fuelByType[type] || 0) + (Number(f.amount) || 0);
    });

    const totalEarning = log ? Number(log.total_earning) || 0 : 0;
    const driverSalary = log ? Number(log.commission_amount) || 0 : 0;
    const maintenanceManual = log ? Number(log.maintenance_amount) || 0 : 0;
    const maintenanceLogged = maintenanceByDate[date] || 0;
    const driverId = driverIdsByDate[date];
    const supplies = driverId != null ? (claimsByDriverAndDate[driverId + '|' + date] || 0) : 0;
    const overhead = dailyOverhead;
    const cost = fuelTotal + maintenanceManual + maintenanceLogged + supplies + driverSalary + overhead;
    const profit = totalEarning - cost;

    rows.push({
      date,
      driver: null, // filled in by caller with a name lookup if useful
      driverId: driverId || null,
      startReading: log ? log.start_reading : null,
      endReading: log ? log.end_reading : null,
      totalRun: log ? log.total_run : null,
      fuelLines: fuelLines.map((f) => ({ fuelType: f.fuel_type, amount: f.amount })),
      fuelTotal,
      totalEarning, driverSalary, maintenanceManual, maintenanceLogged, supplies, overhead, cost, profit,
      hasEntry: !!log,
    });

    totals.totalEarning += totalEarning;
    totals.totalRun += log ? (Number(log.total_run) || 0) : 0;
    totals.fuelTotal += fuelTotal;
    totals.driverSalary += driverSalary;
    totals.maintenanceManual += maintenanceManual;
    totals.maintenanceLogged += maintenanceLogged;
    totals.supplies += supplies;
    totals.overhead += overhead;
  }
  totals.totalCost = totals.fuelTotal + totals.maintenanceManual + totals.maintenanceLogged + totals.supplies + totals.driverSalary + totals.overhead;
  totals.profit = totals.totalEarning - totals.totalCost;

  // Attach driver names for display.
  const driverIds = [...new Set(rows.filter((r) => r.driverId).map((r) => r.driverId))];
  if (driverIds.length) {
    const placeholders = driverIds.map(() => '?').join(',');
    const driverRows = await db.prepare(`SELECT id, name FROM drivers WHERE id IN (${placeholders})`).all(...driverIds);
    const nameById = {};
    driverRows.forEach((d) => { nameById[d.id] = d.name; });
    rows.forEach((r) => { if (r.driverId) r.driver = nameById[r.driverId] || null; });
  }

  return {
    vehicle: { id: vehicle.id, regNo: vehicle.reg_no, isJiju, emiAmount: vehicle.emi_amount, emiPeriod: vehicle.emi_period },
    from, to, isJiju, dailyOverhead,
    rows, totals,
  };
}

module.exports = { computeVehicleProfit };
