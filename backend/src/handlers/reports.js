const ExcelJS = require('exceljs');
const { sendJson } = require('../lib/http');
const db = require('../db');

async function driverEarnings(from, to) {
  return db
    .prepare(
      `SELECT d.id AS driver_id, d.name AS driver_name,
              COALESCE(SUM(dl.total_earning),0) AS gross_earning,
              COALESCE(SUM(dl.commission_amount),0) AS driver_commission,
              COALESCE(SUM(dl.trip_count),0) AS trips,
              COALESCE(SUM(dl.total_run),0) AS total_run_km
       FROM drivers d
       LEFT JOIN duty_logs dl ON dl.driver_id = d.id AND dl.log_date BETWEEN ? AND ?
       GROUP BY d.id ORDER BY d.name`
    )
    .all(from, to);
}

async function vehicleCosts(from, to) {
  return db
    .prepare(
      `SELECT v.id AS vehicle_id, v.reg_no,
              COALESCE(SUM(dl.total_run),0) AS total_run_km,
              COALESCE((
                SELECT SUM(fe.amount) FROM fuel_entries fe
                JOIN duty_logs dl2 ON dl2.id = fe.duty_log_id
                WHERE dl2.vehicle_id = v.id AND dl2.log_date BETWEEN ? AND ?
              ), 0) AS fuel_cost
       FROM vehicles v
       LEFT JOIN duty_logs dl ON dl.vehicle_id = v.id AND dl.log_date BETWEEN ? AND ?
       GROUP BY v.id ORDER BY v.reg_no`
    )
    .all(from, to, from, to);
}

async function drivingEventsSummary(from, to) {
  return db
    .prepare(
      `SELECT d.name AS driver_name, de.event_type, COUNT(*) AS occurrences
       FROM driving_events de JOIN drivers d ON d.id = de.driver_id
       WHERE LEFT(de.created_at, 10) BETWEEN ? AND ?
       GROUP BY d.id, de.event_type ORDER BY d.name, de.event_type`
    )
    .all(from, to);
}

async function dutyLogsRaw(from, to) {
  return db
    .prepare(
      `SELECT dl.log_date, d.name AS driver_name, v.reg_no AS vehicle_reg_no, dl.total_run AS total_run_km,
              dl.trip_count AS trips, dl.total_earning AS gross_earning, dl.commission_amount AS driver_commission, dl.shift_status
       FROM duty_logs dl JOIN drivers d ON d.id = dl.driver_id LEFT JOIN vehicles v ON v.id = dl.vehicle_id
       WHERE dl.log_date BETWEEN ? AND ? ORDER BY dl.log_date DESC`
    )
    .all(from, to);
}

async function expenseClaimsRaw(from, to) {
  return db
    .prepare(
      `SELECT ec.created_at, d.name AS driver_name, ec.category, ec.amount, ec.status, ec.notes
       FROM expense_claims ec JOIN drivers d ON d.id = ec.driver_id
       WHERE LEFT(ec.created_at, 10) BETWEEN ? AND ? ORDER BY ec.created_at DESC`
    )
    .all(from, to);
}

async function leaveRequestsRaw(from, to) {
  return db
    .prepare(
      `SELECT lr.created_at, d.name AS driver_name, lr.start_date, lr.end_date, lr.status, lr.reason
       FROM leave_requests lr JOIN drivers d ON d.id = lr.driver_id
       WHERE LEFT(lr.created_at, 10) BETWEEN ? AND ? ORDER BY lr.created_at DESC`
    )
    .all(from, to);
}

async function finesRaw(from, to) {
  return db
    .prepare(
      `SELECT f.date, d.name AS driver_name, f.category, f.amount, f.recovery_method, f.status, f.reason
       FROM fines f JOIN drivers d ON d.id = f.driver_id
       WHERE f.date BETWEEN ? AND ? ORDER BY f.date DESC`
    )
    .all(from, to);
}

async function advancesRaw(from, to) {
  return db
    .prepare(
      `SELECT a.date, d.name AS driver_name, a.amount, a.status, a.note
       FROM advances a JOIN drivers d ON d.id = a.driver_id
       WHERE a.date BETWEEN ? AND ? ORDER BY a.date DESC`
    )
    .all(from, to);
}

async function payrollRaw(from, to) {
  return db
    .prepare(
      `SELECT p.period_start, p.period_end, d.name AS driver_name, p.gross_earnings, p.commission_amount,
              p.fines_amount, p.reimbursements_amount, p.advance_amount, p.net_payable, p.status
       FROM payroll_runs p JOIN drivers d ON d.id = p.driver_id
       WHERE p.period_start BETWEEN ? AND ? ORDER BY p.period_start DESC`
    )
    .all(from, to);
}

async function maintenanceRaw(from, to) {
  return db
    .prepare(
      `SELECT m.service_date, v.reg_no, m.type, m.odometer_km, m.cost, m.next_due_date, m.next_due_km, m.notes
       FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id
       WHERE m.service_date BETWEEN ? AND ? ORDER BY m.service_date DESC`
    )
    .all(from, to);
}

async function incidentsRaw(from, to) {
  return db
    .prepare(
      `SELECT i.incident_date, d.name AS driver_name, v.reg_no AS vehicle_reg_no, i.location, i.description, i.repair_cost, i.status
       FROM incidents i JOIN drivers d ON d.id = i.driver_id LEFT JOIN vehicles v ON v.id = i.vehicle_id
       WHERE i.incident_date BETWEEN ? AND ? ORDER BY i.incident_date DESC`
    )
    .all(from, to);
}

const ENTITIES = {
  driver_earnings: { label: 'Driver earnings & commission', fn: driverEarnings },
  vehicle_costs: { label: 'Vehicle running cost', fn: vehicleCosts },
  driving_events_summary: { label: 'Driving events summary', fn: drivingEventsSummary },
  duty_logs: { label: 'Duty logs (raw)', fn: dutyLogsRaw },
  expense_claims: { label: 'Expense claims (raw)', fn: expenseClaimsRaw },
  leave_requests: { label: 'Leave requests (raw)', fn: leaveRequestsRaw },
  fines: { label: 'Fines & damage recovery', fn: finesRaw },
  advances: { label: 'Driver advances', fn: advancesRaw },
  payroll: { label: 'Payroll runs', fn: payrollRaw },
  maintenance: { label: 'Maintenance records', fn: maintenanceRaw },
  incidents: { label: 'Accidents & incidents', fn: incidentsRaw },
};

function listEntities(req, res) {
  sendJson(
    res,
    200,
    Object.entries(ENTITIES).map(([id, e]) => ({ id, label: e.label }))
  );
}

async function run(req, res) {
  const url = new URL(req.url, 'http://internal');
  const entity = url.searchParams.get('entity');
  const from = url.searchParams.get('from') || '2000-01-01';
  const to = url.searchParams.get('to') || '2999-12-31';
  const def = ENTITIES[entity];
  if (!def) return sendJson(res, 400, { error: 'Unknown report entity' });
  sendJson(res, 200, { entity, label: def.label, from, to, rows: await def.fn(from, to) });
}

// Real .xlsx download (not CSV) — a formatted workbook with a bold header row
// and sensible column widths, generated on the fly from the same report data.
async function exportXlsx(req, res) {
  const url = new URL(req.url, 'http://internal');
  const entity = url.searchParams.get('entity');
  const from = url.searchParams.get('from') || '2000-01-01';
  const to = url.searchParams.get('to') || '2999-12-31';
  const def = ENTITIES[entity];
  if (!def) return sendJson(res, 400, { error: 'Unknown report entity' });
  const rows = await def.fn(from, to);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Pooja Fleet Management System';
  const sheet = workbook.addWorksheet(def.label.replace(/[\\/*?:[\]]/g, '').slice(0, 31) || 'Report');
  if (rows.length) {
    sheet.columns = Object.keys(rows[0]).map((k) => ({ header: k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), key: k, width: 20 }));
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8DCC8' } };
  } else {
    sheet.addRow(['No data in this range']);
  }

  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${entity}_${from}_to_${to}.xlsx"`,
  });
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { listEntities, run, exportXlsx };
