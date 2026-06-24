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

function broadcastPersonUpdate(payload, newEvents = []) {
  broadcast('person', {
    type: 'person_update',
    payload,
    newEvents,
    ts: Date.now(),
  });
}

module.exports = {
  addClient,
  broadcast,
  broadcastPersonUpdate,
};
