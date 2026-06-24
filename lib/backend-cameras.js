/**
 * Sync dashboard cameras with Vision Backend camera registry + MediaMTX streams.
 */

const cameraStore = require('./camera-store');
const { backendJson, BACKEND_URL } = require('./backend-client');

const HLS_BASE = (process.env.MEDIAMTX_HLS_URL || 'http://localhost:8888').replace(/\/$/, '');
const WHEP_BASE = (process.env.MEDIAMTX_WHEP_URL || 'http://localhost:8889').replace(/\/$/, '');

function mapDashboardType(type) {
  const map = {
    rtsp: 'rtsp',
    onvif: 'onvif',
    usb: 'usb',
    ip: 'rtsp',
    http: 'http',
    'video-file': 'video',
    'image-folder': 'image',
    mipi: 'mipi',
    'local-test': 'rtsp',
  };
  return map[type] || 'rtsp';
}

function buildBackendUrl(camera) {
  const url = String(camera.rtspUrl || camera.url || '').trim();
  if (url) return url;
  if (camera.type === 'local-test') return 'rtsp://localhost:8554/test';
  return null;
}

function hlsUrlFor(backendId) {
  return `${HLS_BASE}/${backendId}/index.m3u8`;
}

function whepUrlFor(backendId) {
  return `${WHEP_BASE}/${backendId}/whep`;
}

function localRtspFor(backendId) {
  const host = process.env.BOARD_IP || 'localhost';
  return `rtsp://${host}:${process.env.MEDIAMTX_RTSP_PORT || 8554}/${backendId}`;
}

/** Rewrite legacy localhost MediaMTX URLs to board IP when running split PC↔board. */
function normalizeMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const hls = HLS_BASE;
  const whep = WHEP_BASE;
  return url
    .replace(/^http:\/\/localhost:8888/i, hls)
    .replace(/^http:\/\/127\.0\.0\.1:8888/i, hls)
    .replace(/^http:\/\/localhost:8889/i, whep)
    .replace(/^http:\/\/127\.0\.0\.1:8889/i, whep);
}

function wsDetectUrl(backendId) {
  const u = new URL(BACKEND_URL);
  return `ws://${u.host}/ws?camera=${encodeURIComponent(backendId)}&model=mdl_person`;
}

function applyBackendFields(dashboardCameraId, backendId, status = 'online') {
  cameraStore.updateCamera(dashboardCameraId, {
    backendId,
    hlsUrl: hlsUrlFor(backendId),
    whepUrl: whepUrlFor(backendId),
    localRtsp: localRtspFor(backendId),
    status: status === 'online' || status === 'idle' ? 'online' : status,
  });
}

async function listBackendCameras() {
  try {
    return await backendJson('/api/cameras');
  } catch {
    return [];
  }
}

async function ensureBackendCamera(dashboardCamera) {
  if (!dashboardCamera) return null;

  let cam = { ...dashboardCamera };

  if (cam.backendId) {
    try {
      await backendJson(`/api/cameras/${encodeURIComponent(cam.backendId)}`);
      return cam.backendId;
    } catch {
      /* Stale ID after backend/MediaMTX restart — clear and re-register */
      cameraStore.updateCamera(cam.id, { backendId: null });
      cam = cameraStore.getCamera(cam.id) || cam;
    }
  }

  const backendList = await listBackendCameras();
  const byName = backendList.find((c) => c.name === cam.name);
  if (byName?.id) {
    applyBackendFields(cam.id, byName.id, byName.status || 'online');
    return byName.id;
  }

  const url = buildBackendUrl(cam);
  if (!url) return null;

  try {
    const created = await backendJson('/api/cameras', {
      method: 'POST',
      body: {
        name: cam.name,
        type: mapDashboardType(cam.type),
        url,
        username: cam.username || null,
        password: cam.password || null,
        location: cam.location || null,
        zone: cam.group || null,
        floor: cam.zoneFloor || null,
        department: cam.department || null,
      },
    });
    if (created?.id) {
      applyBackendFields(cam.id, created.id, created.status || 'online');
      return created.id;
    }
  } catch (err) {
    console.warn('[backend-cameras] register failed:', err.message);
  }

  return null;
}

async function verifyHlsReady(backendId, retries = 8) {
  const url = hlsUrlFor(backendId);
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      if (res.ok || res.status === 206) return { ok: true, url };
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500 + i * 250));
  }
  return { ok: false, url };
}

/** Re-add MediaMTX pull path after MediaMTX or backend restart. */
async function ensureMediaMtxStream(backendId) {
  try {
    await backendJson(`/api/cameras/${encodeURIComponent(backendId)}/restart`, { method: 'POST' });
    return true;
  } catch (err) {
    console.warn('[backend-cameras] MediaMTX restart failed:', err.message);
    return false;
  }
}

async function syncDashboardCamera(dashboardCamera) {
  const backendId = await ensureBackendCamera(dashboardCamera);
  if (!backendId) {
    return { backendId: null, synced: false, hlsReady: false };
  }

  let hlsCheck = await verifyHlsReady(backendId, 2);
  if (!hlsCheck.ok) {
    await ensureMediaMtxStream(backendId);
    hlsCheck = await verifyHlsReady(backendId, 12);
  }

  const updated = cameraStore.getCamera(dashboardCamera.id);
  return {
    backendId,
    synced: true,
    hlsReady: hlsCheck.ok,
    hlsUrl: updated?.hlsUrl || hlsCheck.url,
    whepUrl: updated?.whepUrl || whepUrlFor(backendId),
    localRtsp: updated?.localRtsp || localRtspFor(backendId),
    wsUrl: wsDetectUrl(backendId),
    status: updated?.status || 'online',
  };
}

module.exports = {
  ensureBackendCamera,
  syncDashboardCamera,
  listBackendCameras,
  buildBackendUrl,
  hlsUrlFor,
  whepUrlFor,
  normalizeMediaUrl,
  wsDetectUrl,
  verifyHlsReady,
};
