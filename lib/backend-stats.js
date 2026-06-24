const { backendJson, BACKEND_URL } = require('./backend-client');

async function fetchSystemStats() {
  return backendJson('/api/system/stats');
}

module.exports = { fetchSystemStats, BACKEND_URL };
