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
const { broadcastDetectionUpdate, broadcastMetricsUpdate } = require('./event-broadcast');
const { isDemoMode } = require('./demo-mode');
const {
  isDemoCamera,
  generateDemoDetections,
  generateDemoDetectionsForSlug,
  generateDemoWorkerMeta,
  getDemoVideoPreview,
  DEMO_PEAK_COUNT,
  pickDemoLiveCount,
  seedDemoLiveMetrics,
  PERSON_SLUG,
  FACE_SLUG,
  FIRE_SMOKE_SLUG,
} = require('./demo-cameras');

function isDemoCountSlug(slug) {
  return slug === PERSON_SLUG || slug === FACE_SLUG;
}

function finalizeDemoMetrics(metrics, slug) {
  if (!isDemoCountSlug(slug)) return metrics;
  if (!metrics.current || metrics.current < 6) {
    metrics.current = pickDemoLiveCount();
  }
  metrics.peakToday = DEMO_PEAK_COUNT;
  if (slug === FACE_SLUG) {
    metrics.recognitionActive = true;
  } else {
    metrics.presenceActive = true;
  }
  return metrics;
}

function resolveSlug(slug) {
  if (slug === 'face') return 'face';
  if (slug === 'fire-smoke') return 'fire-smoke';
  return 'person';
}
const WORKER_BOOT_MS = workerBootMs();
const NPU_WORKER_RETRIES = 3;
let lastMetricsBroadcastBySlug = new Map();
const METRICS_BROADCAST_MS = 2000;

function maybeBroadcastLiveUpdate(slug, fullPayload, newEvents) {
  if (newEvents.length) {
    broadcastDetectionUpdate(slug, fullPayload, newEvents);
    lastMetricsBroadcastBySlug.set(slug, Date.now());
    return;
  }
  const now = Date.now();
  const last = lastMetricsBroadcastBySlug.get(slug) || 0;
  if (now - last >= METRICS_BROADCAST_MS) {
    lastMetricsBroadcastBySlug.set(slug, now);
    broadcastMetricsUpdate(slug, fullPayload);
  }
}

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

function buildMetrics(detections, state, workerMeta = {}, slug = 'person') {
  const count = detections.length;
  const running = Boolean(state.inferenceRunning);
  const peak = Math.max(count, state._peakToday || 0);
  const base = {
    current: count,
    peakToday: peak,
    fps: workerMeta.fps ?? null,
    inferenceMs: workerMeta.inference_ms ?? workerMeta.inferenceMs ?? null,
  };
  if (slug === 'face') {
    return {
      ...base,
      recognitionActive: Boolean(running && count > 0),
    };
  }
  if (slug === 'fire-smoke') {
    return {
      ...base,
      alertsActive: Boolean(running && count > 0),
    };
  }
  return {
    ...base,
    presenceActive: Boolean(running && state.features?.personPresence && count > 0),
  };
}

async function selectCamera(cameraId, modelSlug = 'person') {
  const slug = resolveSlug(modelSlug);
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  const demoStream = isDemoMode() && isDemoCamera(camera);

  const state = detectionStore.getModelState(slug);
  if (state.inferenceRunning && state.activeCameraId && state.activeCameraId !== cameraId) {
    await stopLive(state.activeCameraId, slug);
  }

  let sync = { synced: false };
  if (!demoStream) {
    const backendReachable = await isBackendReachable();
    if (backendReachable && buildBackendUrl(camera)) {
      try {
        sync = await syncDashboardCamera(camera);
        camera = cameraStore.getCamera(cameraId) || camera;
      } catch (err) {
        console.warn('[person-live] camera sync failed:', err.message);
      }
    }
  }

  detectionStore.saveModelState(slug, {
    activeCameraId: cameraId,
    inferenceRunning: false,
    streamMode: demoStream ? 'demo' : (sync.synced ? 'backend' : null),
    backendCameraId: demoStream ? null : (sync.backendId || camera.backendId || null),
    ...(demoStream ? { workerSource: null, _liveMetrics: null } : {}),
  });

  const preview = demoStream
    ? getDemoVideoPreview(false)
    : getLiveViewPayload(camera).preview;
  const backendReachable = demoStream ? true : await isBackendReachable();

  return {
    ok: true,
    demoMode: demoStream,
    camera: sanitizeCam(camera),
    preview,
    backendReachable,
    hasStreamUrl: demoStream || Boolean(buildBackendUrl(camera)),
    backendCameraId: demoStream ? null : (sync.backendId || camera.backendId || null),
    wsUrl: demoStream ? null : (sync.backendId || camera.backendId ? wsDetectUrl(sync.backendId || camera.backendId) : null),
    hlsUrl: camera.hlsUrl || preview?.url || null,
    payload: detectionStore.getPayload(slug),
  };
}

async function resyncStream(cameraId, modelSlug = 'person') {
  const slug = resolveSlug(modelSlug);
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

  const state = detectionStore.getModelState(slug);
  detectionStore.saveModelState(slug, {
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

async function startLive(cameraId, modelSlug = 'person') {
  const slug = resolveSlug(modelSlug);
  const camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  if (isDemoMode() && isDemoCamera(camera)) {
    detectionStore.saveModelState(slug, {
      activeCameraId: cameraId,
      inferenceRunning: true,
      streamMode: 'demo',
      backendCameraId: null,
      workerSource: 'demo',
      _peakToday: isDemoCountSlug(slug) ? DEMO_PEAK_COUNT : (detectionStore.getModelState(slug)._peakToday || 0),
      ...(isDemoCountSlug(slug) ? { _liveMetrics: seedDemoLiveMetrics() } : {}),
    });
    detectionStore.ensureDemoEvents(slug, camera);
    return {
      ok: true,
      demoMode: true,
      backendConnected: true,
      streamMode: 'demo',
      workerSource: 'demo',
      backendError: null,
      backendCameraId: null,
      wsUrl: null,
      preview: getDemoVideoPreview(true),
      payload: detectionStore.getPayload(slug),
    };
  }

  const state = detectionStore.getModelState(slug);
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
    return { ok: false, error: backendError, payload: detectionStore.getPayload(slug) };
  }

  const boot = await ensurePersonWorker(cameraStore.getCamera(cameraId) || camera, backendId, state);
  if (!boot.ok) {
    detectionStore.saveModelState(slug, { inferenceRunning: false });
    return {
      ok: false,
      error: boot.error,
      backendError: boot.error,
      backendConnected: false,
      payload: detectionStore.getPayload(slug),
    };
  }

  detectionStore.saveModelState(slug, {
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
    payload: detectionStore.getPayload(slug),
  };
}

async function stopLive(cameraId, modelSlug = 'person') {
  const slug = resolveSlug(modelSlug);
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(slug);
  const backendId = camera?.backendId || state.backendCameraId;

  if (isDemoMode() && isDemoCamera(camera)) {
    detectionStore.saveModelState(slug, {
      inferenceRunning: false,
      streamMode: 'demo',
      workerSource: null,
      _lastEventKey: null,
      _liveMetrics: null,
    });
    return {
      ok: true,
      demoMode: true,
      preview: getDemoVideoPreview(false),
      payload: detectionStore.getPayload(slug),
    };
  }

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

  detectionStore.saveModelState(slug, {
    inferenceRunning: false,
    streamMode: backendId ? 'preview' : null,
    workerSource: null,
    _lastEventKey: null,
  });

  return { ok: true, payload: detectionStore.getPayload(slug) };
}

async function getLiveFrame(cameraId, modelSlug = 'person') {
  const slug = resolveSlug(modelSlug);
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) {
    return {
      ok: true,
      error: 'Camera not found — add or re-select the camera',
      inferenceRunning: false,
      backendConnected: false,
      metrics: { current: 0, peakToday: 0, fps: null, inferenceMs: null, presenceActive: false },
      detections: [],
      payload: detectionStore.getPayload(slug),
    };
  }

  if (!isDemoCamera(camera) && !camera.backendId && (await isBackendReachable())) {
    try {
      await syncDashboardCamera(camera);
      camera = cameraStore.getCamera(cameraId) || camera;
    } catch (err) {
      console.warn('[person-live] frame sync failed:', err.message);
    }
  }

  const state = detectionStore.getModelState(slug);
  const live = getLiveViewPayload(camera);
  const demoStream = isDemoMode() && isDemoCamera(camera);

  if (demoStream) {
    const preview = getDemoVideoPreview(Boolean(state.inferenceRunning));

    if (!state.inferenceRunning) {
      return {
        ok: true,
        demoMode: true,
        camera: sanitizeCam(camera),
        preview,
        streamMode: 'demo',
        workerSource: null,
        backendConnected: true,
        inferenceRunning: false,
        backendCameraId: null,
        wsUrl: null,
        hlsUrl: null,
        whepUrl: null,
        detections: [],
        peopleCount: null,
        metrics: {
          current: 0,
          peakToday: state._peakToday || 0,
          fps: null,
          inferenceMs: null,
          presenceActive: false,
          recognitionActive: false,
          skippedFrames: null,
          inferenceFps: null,
        },
        features: state.features,
        alerts: state.alerts,
        confidence: state.confidence,
        minObjectSizePx: state.minObjectSizePx,
        updatedAt: new Date().toISOString(),
        payload: detectionStore.getPayload(slug),
      };
    }

    let detections = generateDemoDetectionsForSlug(slug);
    const workerMeta = generateDemoWorkerMeta(slug);
    const fps = workerMeta.fps;
    const inferenceMs = workerMeta.inference_ms;

    const metrics = finalizeDemoMetrics(
      buildMetrics(detections, state, { fps, inference_ms: inferenceMs }, slug),
      slug
    );
    if (isDemoCountSlug(slug)) {
      detectionStore.saveModelState(slug, {
        _peakToday: DEMO_PEAK_COUNT,
        _liveMetrics: { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs },
      });
    } else if (metrics.current > (state._peakToday || 0)) {
      detectionStore.saveModelState(slug, {
        _peakToday: metrics.current,
        _liveMetrics: { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs },
      });
      metrics.peakToday = metrics.current;
    } else {
      metrics.peakToday = state._peakToday || metrics.current;
      detectionStore.saveModelState(slug, {
        _liveMetrics: { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs },
      });
    }

    const fullPayload = detectionStore.getPayload(slug);
    maybeBroadcastLiveUpdate(slug, fullPayload, []);

    return {
      ok: true,
      demoMode: true,
      camera: sanitizeCam(camera),
      preview,
      streamMode: 'demo',
      workerSource: 'demo',
      backendConnected: true,
      inferenceRunning: state.inferenceRunning,
      backendCameraId: null,
      wsUrl: null,
      hlsUrl: null,
      whepUrl: null,
      detections: state.features?.boundingBoxes !== false ? detections : [],
      peopleCount: state.features?.countPeople !== false ? detections.length : null,
      metrics: {
        ...metrics,
        skippedFrames: null,
        inferenceFps: fps,
      },
      features: state.features,
      alerts: state.alerts,
      confidence: state.confidence,
      minObjectSizePx: state.minObjectSizePx,
      updatedAt: new Date().toISOString(),
      payload: detectionStore.getPayload(slug),
    };
  }

  const backendId = camera.backendId || state.backendCameraId;
  let streamMode = state.streamMode || (camera.hlsUrl ? 'preview' : 'none');

  const { result, workerSource, connected: backendConnected } = await fetchWorkerResult(backendId, state);
  if (workerSource && workerSource !== state.workerSource) {
    detectionStore.saveModelState(slug, { workerSource });
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

  const metrics = buildMetrics(detections, state, { fps, inference_ms: inferenceMs }, slug);
  if (metrics.current > (state._peakToday || 0)) {
    detectionStore.saveModelState(slug, {
      _peakToday: metrics.current,
      _liveMetrics: { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs },
    });
    metrics.peakToday = metrics.current;
  } else {
    metrics.peakToday = state._peakToday || metrics.current;
    detectionStore.saveModelState(slug, {
      _liveMetrics: { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs },
    });
  }

  if (state.inferenceRunning) {
    let newEvents = [];
    if (slug === 'person') {
      ({ newEvents } = detectionStore.recordPersonDetection(camera, detections, state, snapshotJpeg));
    } else {
      ({ newEvents } = detectionStore.recordDemoDetection(slug, camera, detections, state));
    }
    const fullPayload = detectionStore.getPayload(slug);
    maybeBroadcastLiveUpdate(slug, fullPayload, newEvents);
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
    payload: detectionStore.getPayload(slug),
  };
}

async function updateLiveConfig(cameraId, patch, modelSlug = 'person') {
  const slug = resolveSlug(modelSlug);
  detectionStore.updateSettings(slug, patch);
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(slug);
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

  return { ok: true, payload: detectionStore.getPayload(slug) };
}

function sanitizeCam(camera) {
  const { password, ...safe } = camera;
  return safe;
}

function getActiveCameraId(modelSlug = 'person') {
  const slug = resolveSlug(modelSlug);
  return detectionStore.getModelState(slug).activeCameraId || null;
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
