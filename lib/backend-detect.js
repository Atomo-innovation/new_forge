/**
 * Person detection via Vision Backend /api/detect/* (mdl_person worker).
 */

const { backendJson } = require('./backend-client');

const PERSON_MODEL_ID = 'mdl_person';

async function startPersonWorker(backendCameraId, config = {}) {
  return backendJson('/api/detect/start', {
    method: 'POST',
    body: {
      camera_id: backendCameraId,
      model_id: PERSON_MODEL_ID,
      confidence: config.confidence ?? 0.45,
      fps: config.fps ?? 5,
      capabilities: ['person_detection'],
    },
  });
}

async function stopPersonWorker(backendCameraId) {
  return backendJson('/api/detect/stop', {
    method: 'POST',
    body: {
      camera_id: backendCameraId,
      model_id: PERSON_MODEL_ID,
    },
  });
}

async function updatePersonWorkerConfig(backendCameraId, config = {}) {
  return backendJson('/api/detect/config', {
    method: 'PUT',
    body: {
      camera_id: backendCameraId,
      model_id: PERSON_MODEL_ID,
      confidence: config.confidence,
      fps: config.fps,
    },
  });
}

async function getPersonWorkerResult(backendCameraId) {
  try {
    return await backendJson(`/api/detect/result/${encodeURIComponent(backendCameraId)}/${PERSON_MODEL_ID}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getWorkerStatus() {
  return backendJson('/api/detect/status');
}

async function isPersonWorkerRunning(backendCameraId) {
  const list = await getWorkerStatus();
  return Array.isArray(list) && list.some(
    (w) => w.camera_id === backendCameraId && w.model_id === PERSON_MODEL_ID && w.status === 'running'
  );
}

async function getPersonModelUsage(backendCameraId) {
  try {
    const usage = await backendJson('/api/system/models/usage');
    const entry = Array.isArray(usage)
      ? usage.find((u) => u.model_id === PERSON_MODEL_ID && u.cameras?.includes(backendCameraId))
      : null;
    if (!entry) return null;
    return {
      fps: entry.total_fps || 0,
      inferenceMs: entry.avg_inf_ms || 0,
    };
  } catch {
    return null;
  }
}

module.exports = {
  PERSON_MODEL_ID,
  startPersonWorker,
  stopPersonWorker,
  updatePersonWorkerConfig,
  getPersonWorkerResult,
  getWorkerStatus,
  isPersonWorkerRunning,
  getPersonModelUsage,
};
