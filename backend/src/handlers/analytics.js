const { sendJson } = require('../lib/http');
const db = require('../db');

const EVENT_WEIGHTS = { speeding: 5, harsh_braking: 3, rapid_acceleration: 3, possible_collision: 20 };

function ratingFor(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Average';
  if (score >= 25) return 'Poor';
  return 'Dangerous';
}

async function run(req, res, params, query) {
  const from = query.from || '2000-01-01';
  const to = query.to || '2999-12-31';

  const fleetRow = await db.prepare(
    `SELECT COALESCE(SUM(total_run),0) AS total_distance, COALESCE(SUM(trip_count),0) AS total_trips
     FROM duty_logs WHERE log_date BETWEEN ? AND ?`
  ).get(from, to);
  const fuelRow = await db.prepare(
    `SELECT COALESCE(SUM(fe.amount),0) AS fuel_cost
     FROM fuel_entries fe JOIN duty_logs dl ON dl.id = fe.duty_log_id
     WHERE dl.log_date BETWEEN ? AND ?`
  ).get(from, to);
  const vehicleCounts = await db.prepare("SELECT status, COUNT(*) AS n FROM vehicles GROUP BY status").all();

  const revenueRow = await db.prepare(`SELECT COALESCE(SUM(total_earning),0) AS revenue FROM duty_logs WHERE log_date BETWEEN ? AND ?`).get(from, to);
  const expenseCategories = await Promise.all([
    db.prepare(`SELECT COALESCE(SUM(fe.amount),0) AS total FROM fuel_entries fe JOIN duty_logs dl ON dl.id = fe.duty_log_id WHERE dl.log_date BETWEEN ? AND ?`).get(from, to),
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM expense_claims WHERE status = 'approved' AND LEFT(created_at,10) BETWEEN ? AND ?`).get(from, to),
    db.prepare(`SELECT COALESCE(SUM(cost),0) AS total FROM maintenance_records WHERE service_date BETWEEN ? AND ?`).get(from, to),
    db.prepare(`SELECT COALESCE(SUM(repair_cost),0) AS total FROM incidents WHERE incident_date BETWEEN ? AND ?`).get(from, to),
  ]);
  const [fuelExp, claimsExp, maintExp, incidentExp] = expenseCategories.map((r) => r.total);
  const totalExpenses = fuelExp + claimsExp + maintExp + incidentExp;

  const driverRows = await db.prepare('SELECT id, name FROM drivers ORDER BY name').all();
  const drivers = [];
  for (const d of driverRows) {
    const earn = await db.prepare(
      `SELECT COALESCE(SUM(total_earning),0) AS earnings, COALESCE(SUM(total_run),0) AS distance
       FROM duty_logs WHERE driver_id = ? AND log_date BETWEEN ? AND ?`
    ).get(d.id, from, to);
    const events = await db.prepare(
      `SELECT event_type, COUNT(*) AS n FROM driving_events WHERE driver_id = ? AND LEFT(created_at,10) BETWEEN ? AND ? GROUP BY event_type`
    ).all(d.id, from, to);
    let score = 100;
    events.forEach((e) => { score -= (EVENT_WEIGHTS[e.event_type] || 2) * e.n; });
    score = Math.max(0, Math.min(100, score));
    drivers.push({
      id: d.id, name: d.name,
      earnings: earn.earnings, distance: earn.distance,
      safetyScore: score, rating: ratingFor(score),
      eventCounts: events,
    });
  }
  drivers.sort((a, b) => b.earnings - a.earnings);

  sendJson(res, 200, {
    from, to,
    fleet: {
      totalDistance: fleetRow.total_distance,
      totalTrips: fleetRow.total_trips,
      fuelCost: fuelRow.fuel_cost,
      vehiclesByStatus: vehicleCounts,
    },
    financial: {
      revenue: revenueRow.revenue,
      expenses: { fuel: fuelExp, reimbursements: claimsExp, maintenance: maintExp, incidents: incidentExp, total: totalExpenses },
      profitEstimate: Math.round((revenueRow.revenue - totalExpenses) * 100) / 100,
    },
    drivers,
  });
}

module.exports = { run };
