const cameraStore = require('./camera-store');
const detectionStore = require('./detection-store');
const { isDemoMode } = require('./demo-mode');

const DEMO_CAMERA_ID = 'demo-cam-1';
const DEMO_VIDEO_URL = '/demo/detection.mp4';
const PERSON_SLUG = 'person';
const FACE_SLUG = 'face';
const FIRE_SMOKE_SLUG = 'fire-smoke';

function buildDemoCamera() {
  return {
    id: DEMO_CAMERA_ID,
    name: 'Demo Camera — Gate A',
    type: 'video-file',
    rtspUrl: DEMO_VIDEO_URL,
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
  detectionStore.saveModelState(slug, {
    activeCameraId: DEMO_CAMERA_ID,
    inferenceRunning: state.inferenceRunning !== false,
    streamMode: 'demo',
  });
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

const DEMO_HOLD_MS = 3200;
const demoSceneCache = new Map();

function rawDemoDetections(slug) {
  if (slug === FACE_SLUG) {
    const count = Math.random() > 0.35 ? 2 : 1;
    const identities = ['known', 'unknown'];
    const detections = [];
    for (let i = 0; i < count; i += 1) {
      const identity = identities[Math.floor(Math.random() * identities.length)];
      const x1 = 0.12 + Math.random() * 0.5;
      const y1 = 0.1 + Math.random() * 0.4;
      const w = 0.06 + Math.random() * 0.12;
      const h = 0.08 + Math.random() * 0.16;
      detections.push({
        label: 'face',
        identity,
        score: 0.62 + Math.random() * 0.35,
        box: [x1, y1, x1 + w, y1 + h],
      });
    }
    return detections;
  }
  if (slug === FIRE_SMOKE_SLUG) {
    return generateDemoFireSmokeDetections();
  }
  const count = Math.floor(Math.random() * 2) + 1;
  const detections = [];
  for (let i = 0; i < count; i += 1) {
    const x1 = 0.08 + Math.random() * 0.55;
    const y1 = 0.15 + Math.random() * 0.45;
    const w = 0.07 + Math.random() * 0.14;
    const h = 0.12 + Math.random() * 0.22;
    detections.push({
      label: 'person',
      score: 0.55 + Math.random() * 0.4,
      box: [x1, y1, x1 + w, y1 + h],
    });
  }
  return detections;
}

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
    scene = {
      detections: rawDemoDetections(key),
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

module.exports = {
  DEMO_CAMERA_ID,
  DEMO_VIDEO_URL,
  buildDemoCamera,
  ensureDemoCamera,
  isDemoCamera,
  generateDemoDetections: () => generateDemoDetectionsForSlug(PERSON_SLUG),
  generateDemoFireSmokeDetections,
  generateDemoDetectionsForSlug,
  generateDemoWorkerMeta,
  FACE_SLUG,
  FIRE_SMOKE_SLUG,
  PERSON_SLUG,
};
