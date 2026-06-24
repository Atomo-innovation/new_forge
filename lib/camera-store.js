const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getWritableDataDir } = require('./device-config');

function getStorePath() {
  return path.join(getWritableDataDir(), 'cameras.json');
}

const DEFAULT_CAMERAS = [
  {
    id: 'cam-1',
    name: 'North Gate',
    type: 'rtsp',
    status: 'online',
    location: 'Building A',
    zoneFloor: 'Ground',
    department: 'Security',
    group: 'Perimeter',
    resolution: '1920x1080',
    fpsLimit: 25,
    aiModels: ['yolov8-perimeter'],
    recording: true,
    alertRules: ['intrusion-perimeter'],
    createdAt: '2026-06-10T08:00:00.000Z',
  },
  {
    id: 'cam-2',
    name: 'Loading Dock',
    type: 'onvif',
    status: 'online',
    location: 'Warehouse',
    zoneFloor: 'Bay 3',
    department: 'Logistics',
    group: 'Operations',
    resolution: '1280x720',
    fpsLimit: 20,
    aiModels: ['reid-tracking'],
    recording: true,
    alertRules: ['motion-dock'],
    createdAt: '2026-06-11T10:30:00.000Z',
  },
];

function ensureStore() {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify({ cameras: DEFAULT_CAMERAS }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
    return Array.isArray(raw.cameras) ? raw.cameras : [];
  } catch {
    return DEFAULT_CAMERAS.slice();
  }
}

function writeStore(cameras) {
  ensureStore();
  fs.writeFileSync(getStorePath(), JSON.stringify({ cameras }, null, 2));
}

function listCameras() {
  return readStore();
}

function getCamera(id) {
  return readStore().find((c) => c.id === id) || null;
}

function addCamera(payload) {
  const cameras = readStore();
  const camera = {
    id: randomUUID(),
    status: 'online',
    createdAt: new Date().toISOString(),
    ...payload,
  };
  cameras.unshift(camera);
  writeStore(cameras);
  return camera;
}

function removeCamera(id) {
  const cameras = readStore();
  const next = cameras.filter((c) => c.id !== id);
  if (next.length === cameras.length) return false;
  writeStore(next);
  return true;
}

function updateCamera(id, patch) {
  const cameras = readStore();
  const idx = cameras.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  cameras[idx] = { ...cameras[idx], ...patch };
  writeStore(cameras);
  return cameras[idx];
}

function cameraStats() {
  const cameras = readStore();
  const online = cameras.filter((c) => c.status === 'online').length;
  return {
    total: cameras.length,
    online,
    offline: cameras.length - online,
  };
}

module.exports = {
  listCameras,
  getCamera,
  addCamera,
  removeCamera,
  updateCamera,
  cameraStats,
};
