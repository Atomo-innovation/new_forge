const cameraStore = require('./camera-store');
const detectionStore = require('./detection-store');
const { isDemoMode } = require('./demo-mode');

const DEMO_CAMERA_ID = 'demo-cam-1';
const DEMO_PREVIEW_VIDEO_URL = '/demo/office.mp4';
const DEMO_DETECTION_VIDEO_URL = '/demo/new.mp4';
const DEMO_VIDEO_URL = DEMO_PREVIEW_VIDEO_URL;
const PERSON_SLUG = 'person';
const FACE_SLUG = 'face';
const FIRE_SMOKE_SLUG = 'fire-smoke';

function buildDemoCamera() {
  return {
    id: DEMO_CAMERA_ID,
    name: 'Demo Camera — Gate A',
    type: 'video-file',
    rtspUrl: '',
    status: 'online',
    location: 'Demo site',
    zoneFloor: 'Ground',
    department: 'Security',
    group: 'Perimeter',
    resolution: '1920x1080',
    fpsLimit: 25,
    aiModels: ['yolov8-perimeter', 'face-recog'],
    recording: true,
    alertRules: ['intrusion-perimeter', 'face-watchlist'],
    demo: true,
    createdAt: new Date().toISOString(),
  };
}

function primeDemoModel(slug) {
  detectionStore.assignCamera(slug, DEMO_CAMERA_ID);
  const state = detectionStore.getModelState(slug);
  const patch = {
    activeCameraId: DEMO_CAMERA_ID,
    streamMode: 'demo',
  };
  if (usesDemoLiveCounts(slug)) {
    patch._peakToday = DEMO_PEAK_COUNT;
    if (state.inferenceRunning && state._liveMetrics) {
      patch._liveMetrics = state._liveMetrics;
    }
  }
  detectionStore.saveModelState(slug, patch);
}

function ensureDemoCamera() {
  if (!isDemoMode()) return null;

  const cameras = cameraStore.listCameras();
  const hasDemo = cameras.some((c) => c.demo === true || c.id === DEMO_CAMERA_ID);
  const onlyPlaceholders = cameras.length > 0
    && cameras.every((c) => c.id === 'cam-1' || c.id === 'cam-2');

  if (!hasDemo && (cameras.length === 0 || onlyPlaceholders)) {
    cameraStore.setCameras([buildDemoCamera()]);
  } else if (!hasDemo) {
    cameraStore.upsertCamera(buildDemoCamera());
  } else {
    cameraStore.upsertCamera(buildDemoCamera());
  }

  detectionStore.assignCamera(PERSON_SLUG, DEMO_CAMERA_ID);
  primeDemoModel(PERSON_SLUG);
  primeDemoModel(FACE_SLUG);

  return cameraStore.getCamera(DEMO_CAMERA_ID);
}

function isDemoCamera(camera) {
  return Boolean(camera?.demo || camera?.id === DEMO_CAMERA_ID);
}

function jitter(value, range = 1, min = 0, max = Infinity) {
  const delta = (Math.random() * range * 2) - range;
  return Math.max(min, Math.min(max, Math.round((value + delta) * 10) / 10));
}

function generateDemoFireSmokeDetections() {
  const labels = ['fire', 'smoke'];
  const count = Math.random() > 0.55 ? 2 : 1;
  const detections = [];
  for (let i = 0; i < count; i += 1) {
    const label = labels[Math.floor(Math.random() * labels.length)];
    const x1 = 0.1 + Math.random() * 0.5;
    const y1 = 0.12 + Math.random() * 0.42;
    const w = 0.09 + Math.random() * 0.16;
    const h = 0.1 + Math.random() * 0.2;
    detections.push({
      label,
      score: 0.58 + Math.random() * 0.38,
      box: [x1, y1, x1 + w, y1 + h],
    });
  }
  return detections;
}

const DEMO_PEAK_COUNT = 5;
const DEMO_LIVE_COUNTS = [3, 4, 5];

function pickDemoLiveCount(last = null) {
  const pool = last == null
    ? DEMO_LIVE_COUNTS
    : DEMO_LIVE_COUNTS.filter((n) => n !== last);
  return pool[Math.floor(Math.random() * pool.length)];
}

function seedDemoLiveMetrics() {
  return {
    current: pickDemoLiveCount(),
    fps: jitter(24, 1.5, 12, 28),
    inferenceMs: jitter(42, 5, 28, 68),
  };
}

function buildDemoDetectionStubs(slug, count) {
  const label = slug === FACE_SLUG ? 'face' : 'person';
  const identities = ['known', 'unknown'];
  const detections = [];
  for (let i = 0; i < count; i += 1) {
    const x1 = 0.08 + (i * 0.12) + Math.random() * 0.08;
    const y1 = 0.15 + Math.random() * 0.35;
    const w = 0.07 + Math.random() * 0.1;
    const h = 0.12 + Math.random() * 0.16;
    const det = {
      label,
      score: 0.72 + Math.random() * 0.22,
      box: [x1, y1, x1 + w, y1 + h],
    };
    if (slug === FACE_SLUG) {
      det.identity = identities[Math.floor(Math.random() * identities.length)];
    }
    detections.push(det);
  }
  return detections;
}

function usesDemoLiveCounts(slug) {
  return slug === PERSON_SLUG || slug === FACE_SLUG;
}

function rawDemoDetections(slug) {
  if (usesDemoLiveCounts(slug)) {
    return buildDemoDetectionStubs(slug, pickDemoLiveCount());
  }
  if (slug === FIRE_SMOKE_SLUG) {
    return generateDemoFireSmokeDetections();
  }
  return buildDemoDetectionStubs(PERSON_SLUG, pickDemoLiveCount());
}

const DEMO_HOLD_MS = 350;
const demoSceneCache = new Map();

function driftBox(box, seed) {
  if (!Array.isArray(box) || box.length < 4) return box;
  const t = Date.now() / 900;
  const dx = Math.sin(t + seed) * 0.006;
  const dy = Math.cos(t + seed * 1.3) * 0.005;
  return [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
}

function generateDemoDetectionsForSlug(slug) {
  const key = String(slug || PERSON_SLUG);
  const now = Date.now();
  let scene = demoSceneCache.get(key);
  if (!scene || now - scene.updatedAt >= DEMO_HOLD_MS) {
    const count = pickDemoLiveCount(scene?.count);
    scene = {
      count,
      detections: buildDemoDetectionStubs(key, count),
      workerMeta: {
        fps: jitter(24, 1.5, 12, 28),
        inference_ms: jitter(42, 5, 28, 68),
      },
      updatedAt: now,
    };
    demoSceneCache.set(key, scene);
  }
  return scene.detections.map((det, i) => ({
    ...det,
    box: driftBox(det.box, i + 1),
  }));
}

function generateDemoWorkerMeta(slug = PERSON_SLUG) {
  const key = String(slug || PERSON_SLUG);
  const scene = demoSceneCache.get(key);
  if (scene?.workerMeta) return { ...scene.workerMeta };
  return {
    fps: jitter(24, 1.5, 12, 28),
    inference_ms: jitter(42, 5, 28, 68),
  };
}

function getDemoVideoPreview(inferenceRunning = false, opts = {}) {
  const clientSafe = opts.clientSafe !== false;
  const base = {
    mode: 'video',
    simulated: false,
    label: inferenceRunning ? 'Live AI detection' : 'Live preview',
    demoPhase: inferenceRunning ? 'detection' : 'preview',
  };
  if (clientSafe) return base;
  return {
    ...base,
    url: inferenceRunning ? DEMO_DETECTION_VIDEO_URL : DEMO_PREVIEW_VIDEO_URL,
  };
}

function sanitizeCameraForClient(camera) {
  if (!camera) return camera;
  if (!isDemoCamera(camera)) return camera;
  const { rtspUrl, ...rest } = camera;
  return { ...rest, streamSource: 'demo' };
}

module.exports = {
  DEMO_CAMERA_ID,
  DEMO_VIDEO_URL,
  DEMO_PREVIEW_VIDEO_URL,
  DEMO_DETECTION_VIDEO_URL,
  getDemoVideoPreview,
  sanitizeCameraForClient,
  buildDemoCamera,
  ensureDemoCamera,
  isDemoCamera,
  generateDemoDetections: () => generateDemoDetectionsForSlug(PERSON_SLUG),
  generateDemoFireSmokeDetections,
  generateDemoDetectionsForSlug,
  generateDemoWorkerMeta,
  seedDemoLiveMetrics,
  DEMO_PEAK_COUNT,
  DEMO_LIVE_COUNTS,
  pickDemoLiveCount,
  FACE_SLUG,
  FIRE_SMOKE_SLUG,
  PERSON_SLUG,
};
