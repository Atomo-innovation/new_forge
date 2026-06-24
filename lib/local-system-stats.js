/**
 * System stats from the vision board (not the PC running the dashboard).
 */
const { backendJson } = require('./backend-client');

async function fetchSystemStats() {
  try {
    return await backendJson('/api/system/stats');
  } catch (err) {
    console.warn('[system-stats] Board unreachable, returning null:', err.message);
    return null;
  }
}

/** Minimal placeholder when board is offline — never shows PC stats. */
function getLocalSystemStats() {
  return {
    timestamp: new Date().toISOString(),
    uptime_s: 0,
    cpu: 0,
    npu: null,
    ram: 0,
    storage: 0,
    temp: 0,
    net: 0,
    workers: { count: 0, total_fps: 0, avg_inf_ms: 0 },
    _fallback: true,
    _boardOffline: true,
  };
}

module.exports = { fetchSystemStats, getLocalSystemStats };
