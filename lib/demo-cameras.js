const cameraStore = require('./camera-store');
const detectionStore = require('./detection-store');
const { isDemoMode } = require('./demo-mode');

const DEMO_CAMERA_ID = 'demo-cam-1';
const DEMO_VIDEO_URL = '/demo/detection.mp4';
const PERSON_SLUG = 'person';
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
    aiModels: ['yolov8-perimeter', 'fire-smoke'],
    recording: true,
    alertRules: ['intrusion-perimeter', 'fire-smoke-alert'],
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
  primeDemoModel(FIRE_SMOKE_SLUG);

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

function generateDemoDetectionsForSlug(slug) {
  if (slug === FIRE_SMOKE_SLUG) return generateDemoFireSmokeDetections();
  return generateDemoDetections();
}

function generateDemoDetections() {
  const count = Math.floor(Math.random() * 3) + 1;
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

function generateDemoWorkerMeta() {
  return {
    fps: jitter(24, 3, 8, 30),
    inference_ms: jitter(42, 12, 18, 95),
  };
}

module.exports = {
  DEMO_CAMERA_ID,
  DEMO_VIDEO_URL,
  buildDemoCamera,
  ensureDemoCamera,
  isDemoCamera,
  generateDemoDetections,
  generateDemoFireSmokeDetections,
  generateDemoDetectionsForSlug,
  generateDemoWorkerMeta,
  FIRE_SMOKE_SLUG,
  PERSON_SLUG,
};
