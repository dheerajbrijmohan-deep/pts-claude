// Boss-only commit/uncommit toggle, shared by duty logs, expense claims, and
// fuel entries. Committing a record locks it: the Manager (and the driver
// app, for duty logs / fuel entries) can no longer edit or delete it. The
// Boss can always un-commit to make further changes.
const { sendJson } = require('../lib/http');
const db = require('../db');
const { recordAudit } = require('../lib/audit');

function commitFor(table) {
  return async function handler(req, res, params) {
    const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Not found' });
    const now = new Date().toISOString();
    await db.prepare(`UPDATE ${table} SET committed_at = ?, committed_by = ? WHERE id = ?`).run(now, req.adminUser.id, params.id);
    await recordAudit(req, 'commit', table, params.id, null, { committedAt: now });
    sendJson(res, 200, { ok: true, committedAt: now });
  };
}

function uncommitFor(table) {
  return async function handler(req, res, params) {
    const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Not found' });
    await db.prepare(`UPDATE ${table} SET committed_at = NULL, committed_by = NULL WHERE id = ?`).run(params.id);
    await recordAudit(req, 'uncommit', table, params.id, null, null);
    sendJson(res, 200, { ok: true });
  };
}

module.exports = {
  commitDutyLog: commitFor('duty_logs'),
  uncommitDutyLog: uncommitFor('duty_logs'),
  commitExpenseClaim: commitFor('expense_claims'),
  uncommitExpenseClaim: uncommitFor('expense_claims'),
  commitFuelEntry: commitFor('fuel_entries'),
  uncommitFuelEntry: uncommitFor('fuel_entries'),
  commitFine: commitFor('fines'),
  uncommitFine: uncommitFor('fines'),
  commitPayrollRun: commitFor('payroll_runs'),
  uncommitPayrollRun: uncommitFor('payroll_runs'),
  commitAdvance: commitFor('advances'),
  uncommitAdvance: uncommitFor('advances'),
};
