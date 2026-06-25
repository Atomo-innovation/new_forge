/**
 * Dashboard WebSocket broadcast for real-time detection events + metrics.
 */

const clients = new Set();

function addClient(ws, slug = 'person') {
  ws._slug = slug;
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

function broadcast(slug, message) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  for (const ws of clients) {
    if (ws._slug === slug && ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  }
}

function pickMetrics(payload) {
  if (!payload) return null;
  return {
    peopleMetrics: payload.peopleMetrics || null,
    faceMetrics: payload.faceMetrics || null,
    fireSmokeMetrics: payload.fireSmokeMetrics || null,
    report: payload.report || null,
  };
}

function broadcastDetectionUpdate(slug, payload, newEvents = []) {
  broadcast(slug, {
    type: 'detection_update',
    slug,
    payload: newEvents.length ? payload : undefined,
    newEvents,
    metrics: pickMetrics(payload),
    ts: Date.now(),
  });
}

function broadcastMetricsUpdate(slug, payload) {
  broadcast(slug, {
    type: 'metrics_update',
    slug,
    metrics: pickMetrics(payload),
    ts: Date.now(),
  });
}

/** @deprecated use broadcastDetectionUpdate */
function broadcastPersonUpdate(payload, newEvents = []) {
  broadcastDetectionUpdate('person', payload, newEvents);
}

module.exports = {
  addClient,
  broadcast,
  broadcastDetectionUpdate,
  broadcastMetricsUpdate,
  broadcastPersonUpdate,
};
