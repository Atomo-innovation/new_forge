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

/** Placeholder when board is offline — demo mode returns jittered sample stats. */
function getLocalSystemStats(options = {}) {
  if (options.demo) {
    const jitter = (value, range, min = 0, max = 100) => {
      const delta = (Math.random() * range * 2) - range;
      return Math.max(min, Math.min(max, Math.round(value + delta)));
    };
    return {
      timestamp: new Date().toISOString(),
      uptime_s: 86400 + Math.floor(Math.random() * 3600),
      cpu: jitter(34, 10, 8, 72),
      npu: jitter(67, 12, 20, 95),
      ram: jitter(36, 8, 18, 78),
      storage: jitter(36, 5, 20, 82),
      temp: jitter(58, 6, 42, 72),
      net: jitter(120, 35, 20, 980),
      workers: {
        count: 1,
        total_fps: jitter(24, 4, 10, 30),
        avg_inf_ms: jitter(42, 10, 18, 95),
      },
      _fallback: true,
      _demo: true,
    };
  }

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
