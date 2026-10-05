// Shared commit-lock check for duty_logs / expense_claims / fuel_entries.
// A committed row can only still be changed by the Boss; everyone else
// (Manager, or the driver app) is locked out once it's committed.
function assertNotCommitted(row, adminUser) {
  if (row && row.committed_at && (!adminUser || adminUser.role !== 'boss')) {
    throw Object.assign(new Error('This entry has been committed and is locked. Ask the Boss to un-commit it first.'), { statusCode: 423 });
  }
}

module.exports = { assertNotCommitted };
