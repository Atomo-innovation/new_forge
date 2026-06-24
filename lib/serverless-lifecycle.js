const { isServerlessRuntime } = require('./runtime-env');
const { resetAllDbConnections } = require('./db-runtime');
const { hydrateFromBlob, flushToBlob } = require('./vercel-persist');
const pendingFlows = require('./pending-flows');
const session = require('./session');

async function runBackgroundTasks() {
  if (!isServerlessRuntime()) return;

  const meshcentralStatus = require('./meshcentral-status');
  meshcentralStatus.refreshInBackground();

  try {
    const online = await meshcentralStatus.isReachableFast({ maxWaitMs: 5500 });
    if (!online) return;

    const cloudSync = require('./cloud-sync');
    const passwordSync = require('./password-sync');
    const { saveDeviceProfileToCloud } = require('./meshcentral-register');

    for (let i = 0; i < 3; i += 1) {
      const result = await cloudSync.processNext({ saveDeviceProfileToCloud });
      if (!result?.processed) break;
    }
    await passwordSync.syncPending();
  } catch (err) {
    console.warn('[Serverless] background sync failed:', err.message);
  }
}

async function prepareForRequest() {
  if (!isServerlessRuntime()) return;

  resetAllDbConnections();
  await hydrateFromBlob();
  pendingFlows.load();
  if (typeof session.reloadFromDisk === 'function') {
    session.reloadFromDisk();
  }
  pendingFlows.purgeExpired();
}

async function finalizeAfterRequest() {
  if (!isServerlessRuntime()) return;

  pendingFlows.save();
  await runBackgroundTasks();
  resetAllDbConnections();
  await flushToBlob();
}

function registerExpressHooks(app) {
  if (!isServerlessRuntime()) return;

  app.use((req, res, next) => {
    meshcentralStatusRefresh();
    res.on('finish', () => {
      runBackgroundTasks().catch(() => {});
    });
    next();
  });
}

function meshcentralStatusRefresh() {
  try {
    require('./meshcentral-status').refreshInBackground();
  } catch {
    // ignore
  }
}

module.exports = {
  prepareForRequest,
  finalizeAfterRequest,
  runBackgroundTasks,
  registerExpressHooks,
};
