/**
 * Person tab live stream — bridges dashboard cameras to Vision Backend inference.
 */

const cameraStore = require('./camera-store');
const detectionStore = require('./detection-store');
const { getLiveViewPayload } = require('./camera-analytics');
const { ensureBackendCamera, buildBackendUrl, wsDetectUrl, syncDashboardCamera } = require('./backend-cameras');
const { isBackendReachable } = require('./backend-client');
const {
  startPersonWorker,
  stopPersonWorker,
  updatePersonWorkerConfig,
  getPersonWorkerResult,
  isPersonWorkerRunning,
  getPersonModelUsage,
} = require('./backend-detect');
const {
  shouldUseLocalPersonWorker,
  startLocalPersonWorker,
  stopLocalPersonWorker,
  isLocalPersonWorkerRunning,
  getLocalPersonWorkerResult,
} = require('./local-person-worker');
const { isNpuPersonPlatform, workerBootMs } = require('./person-detector-platform');
const { broadcastPersonUpdate } = require('./event-broadcast');

const PERSON_SLUG = 'person';
const WORKER_BOOT_MS = workerBootMs();
const NPU_WORKER_RETRIES = 3;
let lastMetricsBroadcast = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function workerRtspUrl(camera, backendId) {
  const host = process.env.BOARD_IP || 'localhost';
  return camera.localRtsp || `rtsp://${host}:${process.env.MEDIAMTX_RTSP_PORT || 8554}/${backendId}`;
}

async function ensurePersonWorker(camera, backendId, state) {
  const conf = state.confidence ?? 0.32;
  const fps = Math.min(state.fpsRate || 15, 10);
  const rtsp = workerRtspUrl(camera, backendId);
  const npuMode = isNpuPersonPlatform();

  if (await isBackendReachable()) {
    for (let attempt = 1; attempt <= NPU_WORKER_RETRIES; attempt += 1) {
      try {
        if (await isPersonWorkerRunning(backendId)) {
          await updatePersonWorkerConfig(backendId, { confidence: conf, fps });
        } else {
          await startPersonWorker(backendId, { confidence: conf, fps });
        }
        await sleep(WORKER_BOOT_MS);
        if (await isPersonWorkerRunning(backendId)) {
          const probe = await getPersonWorkerResult(backendId);
          if (probe || (await isPersonWorkerRunning(backendId))) {
            const workerSource = (npuMode || probe?.backend?.startsWith('npu'))
              ? 'npu'
              : (probe?.backend === 'cpu-hog' ? 'cpu' : 'backend');
            return {
              ok: true,
              streamMode: workerSource === 'npu' ? 'npu' : 'backend',
              workerSource,
              backendConnected: true,
            };
          }
        }
      } catch (err) {
        console.warn(`[person-live] NPU/backend worker attempt ${attempt} failed:`, err.message);
      }
      if (attempt < NPU_WORKER_RETRIES) await sleep(1500);
    }
  }

  if (shouldUseLocalPersonWorker()) {
    try {
      if (!isLocalPersonWorkerRunning(backendId)) {
        startLocalPersonWorker(backendId, rtsp, { confidence: conf });
      }
      await sleep(WORKER_BOOT_MS);
      if (isLocalPersonWorkerRunning(backendId)) {
        return { ok: true, streamMode: 'local-cpu', workerSource: 'local-cpu', backendConnected: true };
      }
    } catch (err) {
      console.warn('[person-live] local CPU worker failed:', err.message);
    }
  }

  const hint = npuMode
    ? 'NPU person worker failed. Check yolo26s.nb, libnn_yolo26s.so, and asnn on Khadas. Restart: cd Backend_Atomo_fordge && npm run restart'
    : 'Person detection worker could not start. Restart backend: cd Backend_Atomo_fordge && npm run restart';

  return { ok: false, error: hint, streamMode: 'preview', workerSource: null, backendConnected: false };
}

async function fetchWorkerResult(backendId, state) {
  if (!backendId || !state.inferenceRunning) return { result: null, workerSource: null, connected: false };

  let result = null;
  let workerSource = state.workerSource || null;

  if (await isPersonWorkerRunning(backendId)) {
    result = await getPersonWorkerResult(backendId);
    workerSource = result?.backend?.startsWith('npu')
      ? 'npu'
      : (result?.backend === 'cpu-hog' ? 'cpu' : 'backend');
  } else if (shouldUseLocalPersonWorker() && isLocalPersonWorkerRunning(backendId)) {
    result = getLocalPersonWorkerResult(backendId);
    workerSource = 'local-cpu';
  } else if (shouldUseLocalPersonWorker()) {
    const camera = cameraStore.getCamera(state.activeCameraId);
    if (camera) {
      const boot = await ensurePersonWorker(camera, backendId, state);
      if (boot.ok) {
        workerSource = boot.workerSource;
        result = workerSource === 'local-cpu'
          ? getLocalPersonWorkerResult(backendId)
          : await getPersonWorkerResult(backendId);
      }
    }
  }

  return {
    result,
    workerSource,
    connected: Boolean(result || (workerSource === 'local-cpu' && isLocalPersonWorkerRunning(backendId)) || (await isPersonWorkerRunning(backendId))),
  };
}

function filterDetections(detections, state) {
  let dets = Array.isArray(detections) ? [...detections] : [];
  const conf = state.confidence ?? 0.32;
  dets = dets.filter((d) => (d.score ?? 0) >= conf);

  if (state.features?.filterSmallObjects) {
    const minPx = state.minObjectSizePx ?? 48;
    const minNorm = minPx / 640;
    dets = dets.filter((d) => {
      const box = d.box || [];
      if (box.length < 4) return true;
      const w = Math.abs(box[2] - box[0]);
      const h = Math.abs(box[3] - box[1]);
      return w >= minNorm && h >= minNorm;
    });
  }

  return dets;
}

function buildMetrics(detections, state, workerMeta = {}) {
  const count = detections.length;
  const running = Boolean(state.inferenceRunning);
  const peak = Math.max(count, state._peakToday || 0);
  return {
    current: count,
    peakToday: peak,
    presenceActive: Boolean(running && state.features?.personPresence && count > 0),
    fps: workerMeta.fps ?? null,
    inferenceMs: workerMeta.inference_ms ?? workerMeta.inferenceMs ?? null,
  };
}

async function selectCamera(cameraId) {
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  const state = detectionStore.getModelState(PERSON_SLUG);
  if (state.inferenceRunning && state.activeCameraId && state.activeCameraId !== cameraId) {
    await stopLive(state.activeCameraId);
  }

  const backendReachable = await isBackendReachable();
  let sync = { synced: false };
  if (backendReachable && buildBackendUrl(camera)) {
    try {
      sync = await syncDashboardCamera(camera);
      camera = cameraStore.getCamera(cameraId) || camera;
    } catch (err) {
      console.warn('[person-live] camera sync failed:', err.message);
    }
  }

  detectionStore.saveModelState(PERSON_SLUG, {
    activeCameraId: cameraId,
    inferenceRunning: false,
    streamMode: sync.synced ? 'backend' : null,
    backendCameraId: sync.backendId || camera.backendId || null,
  });

  const live = getLiveViewPayload(camera);

  return {
    ok: true,
    camera: sanitizeCam(camera),
    preview: live.preview,
    backendReachable,
    hasStreamUrl: Boolean(buildBackendUrl(camera)),
    backendCameraId: sync.backendId || camera.backendId || null,
    wsUrl: sync.backendId || camera.backendId ? wsDetectUrl(sync.backendId || camera.backendId) : null,
    hlsUrl: camera.hlsUrl || live.preview?.url || null,
    payload: detectionStore.getPayload(PERSON_SLUG),
  };
}

async function resyncStream(cameraId) {
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  if (!(await isBackendReachable())) {
    return { ok: false, error: 'Vision backend offline on port 3001' };
  }

  /* Force re-register with backend + MediaMTX */
  cameraStore.updateCamera(cameraId, { backendId: null });
  camera = cameraStore.getCamera(cameraId);

  const sync = await syncDashboardCamera(camera);
  camera = cameraStore.getCamera(cameraId) || camera;
  const live = getLiveViewPayload(camera);

  const state = detectionStore.getModelState(PERSON_SLUG);
  detectionStore.saveModelState(PERSON_SLUG, {
    backendCameraId: sync.backendId || null,
    streamMode: sync.synced ? 'backend' : state.streamMode,
  });

  return {
    ok: sync.synced,
    error: sync.synced ? null : 'Could not register camera stream',
    backendCameraId: sync.backendId,
    hlsReady: sync.hlsReady,
    hlsUrl: sync.hlsUrl || camera.hlsUrl,
    preview: live.preview,
    camera: sanitizeCam(camera),
  };
}

async function startLive(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  const state = detectionStore.getModelState(PERSON_SLUG);
  let backendId = camera.backendId || state.backendCameraId || null;
  let backendError = null;

  if (await isBackendReachable() && buildBackendUrl(camera)) {
    try {
      const sync = await syncDashboardCamera(camera);
      backendId = sync.backendId || backendId;
    } catch (err) {
      console.warn('[person-live] camera sync failed:', err.message);
    }
  }

  if (!backendId) {
    backendError = buildBackendUrl(camera)
      ? 'Could not register camera on vision backend.'
      : 'No stream URL on this camera — add an RTSP URL when registering the camera.';
    return { ok: false, error: backendError, payload: detectionStore.getPayload(PERSON_SLUG) };
  }

  const boot = await ensurePersonWorker(cameraStore.getCamera(cameraId) || camera, backendId, state);
  if (!boot.ok) {
    detectionStore.saveModelState(PERSON_SLUG, { inferenceRunning: false });
    return {
      ok: false,
      error: boot.error,
      backendError: boot.error,
      backendConnected: false,
      payload: detectionStore.getPayload(PERSON_SLUG),
    };
  }

  detectionStore.saveModelState(PERSON_SLUG, {
    activeCameraId: cameraId,
    inferenceRunning: true,
    streamMode: boot.streamMode,
    workerSource: boot.workerSource,
    backendCameraId: backendId,
    _peakToday: state._peakToday || 0,
  });

  return {
    ok: true,
    backendConnected: true,
    streamMode: boot.streamMode,
    workerSource: boot.workerSource,
    backendError: null,
    backendCameraId: backendId,
    wsUrl: wsDetectUrl(backendId),
    payload: detectionStore.getPayload(PERSON_SLUG),
  };
}

async function stopLive(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(PERSON_SLUG);
  const backendId = camera?.backendId || state.backendCameraId;

  if (backendId) {
    try {
      if (await isPersonWorkerRunning(backendId)) {
        await stopPersonWorker(backendId);
      }
    } catch (err) {
      console.warn('[person-live] backend stop failed:', err.message);
    }
    if (isLocalPersonWorkerRunning(backendId)) {
      stopLocalPersonWorker(backendId);
    }
  }

  detectionStore.saveModelState(PERSON_SLUG, {
    inferenceRunning: false,
    streamMode: backendId ? 'preview' : null,
    workerSource: null,
    _lastEventKey: null,
  });

  return { ok: true, payload: detectionStore.getPayload(PERSON_SLUG) };
}

async function getLiveFrame(cameraId) {
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) {
    return {
      ok: true,
      error: 'Camera not found — add or re-select the camera',
      inferenceRunning: false,
      backendConnected: false,
      metrics: { current: 0, peakToday: 0, fps: null, inferenceMs: null, presenceActive: false },
      detections: [],
      payload: detectionStore.getPayload(PERSON_SLUG),
    };
  }

  if (!camera.backendId && (await isBackendReachable())) {
    try {
      await syncDashboardCamera(camera);
      camera = cameraStore.getCamera(cameraId) || camera;
    } catch (err) {
      console.warn('[person-live] frame sync failed:', err.message);
    }
  }

  const state = detectionStore.getModelState(PERSON_SLUG);
  const live = getLiveViewPayload(camera);
  const backendId = camera.backendId || state.backendCameraId;
  let streamMode = state.streamMode || (camera.hlsUrl ? 'preview' : 'none');

  const { result, workerSource, connected: backendConnected } = await fetchWorkerResult(backendId, state);
  if (workerSource && workerSource !== state.workerSource) {
    detectionStore.saveModelState(PERSON_SLUG, { workerSource });
  }

  let detections = filterDetections(result?.detections || [], state);
  const snapshotJpeg = result?.snapshot_jpeg || null;
  let fps = result?.inference_fps ?? result?.fps ?? null;
  let inferenceMs = result?.inference_ms ?? null;

  if (backendId && state.inferenceRunning && workerSource === 'backend') {
    const usage = await getPersonModelUsage(backendId);
    if (usage) {
      fps = fps ?? usage.fps;
      inferenceMs = inferenceMs ?? usage.inferenceMs;
    }
  }

  const metrics = buildMetrics(detections, state, { fps, inference_ms: inferenceMs });
  if (metrics.current > (state._peakToday || 0)) {
    detectionStore.saveModelState(PERSON_SLUG, {
      _peakToday: metrics.current,
      _liveMetrics: { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs },
    });
    metrics.peakToday = metrics.current;
  } else {
    metrics.peakToday = state._peakToday || metrics.current;
    detectionStore.saveModelState(PERSON_SLUG, {
      _liveMetrics: { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs },
    });
  }

  if (state.inferenceRunning) {
    const { newEvents } = detectionStore.recordPersonDetection(camera, detections, state, snapshotJpeg);
    const fullPayload = detectionStore.getPayload(PERSON_SLUG);
    const now = Date.now();
    if (newEvents.length || now - lastMetricsBroadcast >= 250) {
      lastMetricsBroadcast = now;
      broadcastPersonUpdate(fullPayload, newEvents);
    }
  }

  return {
    ok: true,
    camera: sanitizeCam(camera),
    preview: live.preview,
    streamMode,
    workerSource: workerSource || state.workerSource || null,
    backendConnected,
    inferenceRunning: state.inferenceRunning,
    backendCameraId: backendId || null,
    wsUrl: backendId ? wsDetectUrl(backendId) : null,
    hlsUrl: camera.hlsUrl || (live.preview?.mode === 'hls' ? live.preview.url : null),
    whepUrl: camera.whepUrl || (live.preview?.mode === 'whep' ? live.preview.url : null),
    detections: state.features?.boundingBoxes !== false ? detections : [],
    peopleCount: state.features?.countPeople !== false ? detections.length : null,
    metrics: {
      ...metrics,
      skippedFrames: result?.skipped_frames ?? null,
      inferenceFps: result?.inference_fps ?? fps,
    },
    features: state.features,
    alerts: state.alerts,
    confidence: state.confidence,
    minObjectSizePx: state.minObjectSizePx,
    updatedAt: new Date().toISOString(),
    payload: detectionStore.getPayload(PERSON_SLUG),
  };
}

async function updateLiveConfig(cameraId, patch) {
  detectionStore.updateSettings(PERSON_SLUG, patch);
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(PERSON_SLUG);
  const backendId = camera?.backendId || state.backendCameraId;

  if (backendId && state.inferenceRunning) {
    const conf = state.confidence;
    const fps = Math.min(state.fpsRate || 15, 10);
    if (state.workerSource === 'local-cpu' && shouldUseLocalPersonWorker()) {
      stopLocalPersonWorker(backendId);
      startLocalPersonWorker(backendId, workerRtspUrl(camera, backendId), { confidence: conf });
    } else {
      try {
        await updatePersonWorkerConfig(backendId, { confidence: conf, fps });
      } catch (err) {
        console.warn('[person-live] config update failed:', err.message);
      }
    }
  }

  return { ok: true, payload: detectionStore.getPayload(PERSON_SLUG) };
}

function sanitizeCam(camera) {
  const { password, ...safe } = camera;
  return safe;
}

function getActiveCameraId() {
  return detectionStore.getModelState(PERSON_SLUG).activeCameraId || null;
}

module.exports = {
  selectCamera,
  startLive,
  stopLive,
  getLiveFrame,
  updateLiveConfig,
  resyncStream,
  getActiveCameraId,
};
