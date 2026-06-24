const { closeAllConnections } = require('./sqlite-open');

const DB_MODULES = [
  './device-binding',
  './device-profile',
  './cloud-sync',
  './dashboard-rbac',
  './master-control/db',
];

function resetAllDbConnections() {
  closeAllConnections();
  for (const modPath of DB_MODULES) {
    try {
      const mod = require(modPath);
      if (typeof mod.resetDbConnection === 'function') {
        mod.resetDbConnection();
      }
    } catch {
      // ignore
    }
  }
}

module.exports = { resetAllDbConnections };
