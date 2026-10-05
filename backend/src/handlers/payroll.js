// Default payroll formula (flagged for the owner to correct once they
// explain their actual profit calculation):
//   Net Payable = Gross Earnings − Commission − Fines − Outstanding Advances + Approved Reimbursements
//
// Advances are a running ledger (see advances.js): generating a payroll run
// sweeps up every currently-outstanding advance for that driver and marks it
// "recovered" against this run, whatever period it was actually given in.
const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const { assertNotCommitted } = require('../lib/locks');
const { recordAudit } = require('../lib/audit');
const { notify } = require('../lib/notify');

async function computeLedger(driverId, from, to) {
  const earningsRow = await db.prepare(
    `SELECT COALESCE(SUM(total_earning),0) AS gross, COALESCE(SUM(commission_amount),0) AS commission
     FROM duty_logs WHERE driver_id = ? AND log_date BETWEEN ? AND ?`
  ).get(driverId, from, to);
  const finesRow = await db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM fines WHERE driver_id = ? AND date BETWEEN ? AND ? AND status != 'waived'`
  ).get(driverId, from, to);
  const reimbursementsRow = await db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM expense_claims WHERE driver_id = ? AND status = 'approved' AND LEFT(created_at,10) BETWEEN ? AND ?`
  ).get(driverId, from, to);
  const advanceRow = await db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS total FROM advances WHERE driver_id = ? AND status = 'outstanding'"
  ).get(driverId);
  return {
    grossEarnings: earningsRow.gross,
    commissionAmount: earningsRow.commission,
    finesAmount: finesRow.total,
    reimbursementsAmount: reimbursementsRow.total,
    advanceAmount: advanceRow.total,
  };
}

function netPayable(l) {
  return Math.round((l.grossEarnings - l.commissionAmount - l.finesAmount - l.advanceAmount + l.reimbursementsAmount) * 100) / 100;
}

async function preview(req, res, params, query) {
  if (!query.driver_id || !query.from || !query.to) return sendJson(res, 400, { error: 'driver_id, from, and to are required' });
  const ledger = await computeLedger(query.driver_id, query.from, query.to);
  sendJson(res, 200, { ...ledger, netPayable: netPayable(ledger) });
}

async function list(req, res, params, query) {
  const rows = query.driver_id
    ? await db.prepare('SELECT p.*, d.name AS driver_name FROM payroll_runs p JOIN drivers d ON d.id = p.driver_id WHERE p.driver_id = ? ORDER BY p.period_start DESC').all(query.driver_id)
    : await db.prepare('SELECT p.*, d.name AS driver_name FROM payroll_runs p JOIN drivers d ON d.id = p.driver_id ORDER BY p.period_start DESC').all();
  sendJson(res, 200, rows);
}

async function create(req, res) {
  const b = await readJsonBody(req);
  if (!b.driver_id || !b.period_start || !b.period_end) {
    return sendJson(res, 400, { error: 'Driver and period start/end are required' });
  }
  const driver = await db.prepare('SELECT id, name FROM drivers WHERE id = ?').get(b.driver_id);
  if (!driver) return sendJson(res, 404, { error: 'Driver not found' });
  const ledger = await computeLedger(b.driver_id, b.period_start, b.period_end);
  const net = netPayable(ledger);
  const now = new Date().toISOString();
  const info = await db.prepare(
    `INSERT INTO payroll_runs (driver_id, period_start, period_end, gross_earnings, commission_amount, fines_amount, reimbursements_amount, advance_amount, net_payable, status, notes, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`
  ).run(
    b.driver_id, b.period_start, b.period_end,
    ledger.grossEarnings, ledger.commissionAmount, ledger.finesAmount, ledger.reimbursementsAmount, ledger.advanceAmount, net,
    b.notes || null, req.adminUser.id, now, now
  );
  // Sweep every currently-outstanding advance into this run.
  await db.prepare("UPDATE advances SET status = 'recovered', recovered_in_payroll_id = ? WHERE driver_id = ? AND status = 'outstanding'")
    .run(info.lastInsertRowid, b.driver_id);
  const row = await db.prepare('SELECT p.*, d.name AS driver_name FROM payroll_runs p JOIN drivers d ON d.id = p.driver_id WHERE p.id = ?').get(info.lastInsertRowid);
  await recordAudit(req, 'create', 'payroll_run', info.lastInsertRowid, null, row);
  await notify('financial', `Payroll generated for ${driver.name}: ${b.period_start} to ${b.period_end}, net payable ₹${net}`, { driverId: b.driver_id });
  sendJson(res, 201, row);
}

async function update(req, res, params) {
  const existing = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Payroll run not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  if (existing.status === 'paid' && req.adminUser.role !== 'boss') {
    return sendJson(res, 423, { error: 'This payroll run is already marked paid. Ask the Boss to make further changes.' });
  }
  // Earnings/commission/fines/reimbursements can be refreshed from the source
  // data, but the advance amount stays as-is: it's already tied to specific
  // ledger rows recovered_in_payroll_id-linked to this run, not recomputed here.
  const b = await readJsonBody(req);
  const earningsRow = await db.prepare(
    `SELECT COALESCE(SUM(total_earning),0) AS gross, COALESCE(SUM(commission_amount),0) AS commission
     FROM duty_logs WHERE driver_id = ? AND log_date BETWEEN ? AND ?`
  ).get(existing.driver_id, existing.period_start, existing.period_end);
  const finesRow = await db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM fines WHERE driver_id = ? AND date BETWEEN ? AND ? AND status != 'waived'`
  ).get(existing.driver_id, existing.period_start, existing.period_end);
  const reimbursementsRow = await db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM expense_claims WHERE driver_id = ? AND status = 'approved' AND LEFT(created_at,10) BETWEEN ? AND ?`
  ).get(existing.driver_id, existing.period_start, existing.period_end);
  const ledger = { grossEarnings: earningsRow.gross, commissionAmount: earningsRow.commission, finesAmount: finesRow.total, reimbursementsAmount: reimbursementsRow.total, advanceAmount: existing.advance_amount };
  const net = netPayable(ledger);
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE payroll_runs SET gross_earnings=?, commission_amount=?, fines_amount=?, reimbursements_amount=?, net_payable=?, notes=?, updated_at=? WHERE id=?`
  ).run(ledger.grossEarnings, ledger.commissionAmount, ledger.finesAmount, ledger.reimbursementsAmount, net, 'notes' in b ? b.notes || null : existing.notes, now, params.id);
  const row = await db.prepare('SELECT p.*, d.name AS driver_name FROM payroll_runs p JOIN drivers d ON d.id = p.driver_id WHERE p.id = ?').get(params.id);
  await recordAudit(req, 'update', 'payroll_run', params.id, existing, row);
  sendJson(res, 200, row);
}

async function markPaid(req, res, params) {
  const existing = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Payroll run not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  const now = new Date().toISOString();
  await db.prepare("UPDATE payroll_runs SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?").run(now, now, params.id);
  const row = await db.prepare('SELECT p.*, d.name AS driver_name FROM payroll_runs p JOIN drivers d ON d.id = p.driver_id WHERE p.id = ?').get(params.id);
  await recordAudit(req, 'mark_paid', 'payroll_run', params.id, existing.status, 'paid');
  await notify('financial', `Payroll marked paid for ${row.driver_name}: ₹${row.net_payable}`, { driverId: row.driver_id });
  sendJson(res, 200, row);
}

async function remove(req, res, params) {
  const existing = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Payroll run not found' });
  try {
    assertNotCommitted(existing, req.adminUser);
  } catch (err) {
    return sendJson(res, err.statusCode, { error: err.message });
  }
  // Give back any advances this run had swept up, so they're pickable again.
  await db.prepare("UPDATE advances SET status = 'outstanding', recovered_in_payroll_id = NULL WHERE recovered_in_payroll_id = ?").run(params.id);
  await db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(params.id);
  await recordAudit(req, 'delete', 'payroll_run', params.id, existing, null);
  sendJson(res, 200, { ok: true });
}

module.exports = { preview, list, create, update, markPaid, remove };
