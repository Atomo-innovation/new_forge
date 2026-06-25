function jitter(value, range = 1, min = 0, max = Infinity) {
  const delta = (Math.random() * range * 2) - range;
  return Math.max(min, Math.min(max, Math.round((value + delta) * 10) / 10));
}

const { hlsUrlFor, whepUrlFor, normalizeMediaUrl } = require('./backend-cameras');

function sanitizeCamera(camera) {
  if (!camera) return null;
  const { password, ...safe } = camera;
  return {
    ...safe,
    hlsUrl: normalizeMediaUrl(safe.hlsUrl),
    whepUrl: normalizeMediaUrl(safe.whepUrl),
    hasCredentials: Boolean(camera.username || password),
  };
}

function getPreviewConfig(camera) {
  const url = String(camera.rtspUrl || '').trim();
  const type = camera.type || 'rtsp';

  if (camera.whepUrl) {
    return {
      mode: 'whep',
      url: normalizeMediaUrl(camera.whepUrl),
      hlsUrl: normalizeMediaUrl(camera.hlsUrl) || null,
      simulated: false,
      label: 'Live WebRTC stream',
    };
  }

  if (camera.hlsUrl) {
    return {
      mode: 'hls',
      url: normalizeMediaUrl(camera.hlsUrl),
      whepUrl: normalizeMediaUrl(camera.whepUrl) || null,
      simulated: false,
      label: 'Live stream via MediaMTX',
    };
  }

  if (camera.backendId) {
    const hls = hlsUrlFor(camera.backendId);
    const whep = whepUrlFor(camera.backendId);
    return {
      mode: 'whep',
      url: whep,
      hlsUrl: hls,
      simulated: false,
      label: 'Live WebRTC stream',
    };
  }

  if (type === 'http' && /^https?:\/\//i.test(url)) {
    return { mode: 'http', url, simulated: false };
  }

  if (type === 'video-file' && /\.(mp4|webm|ogg)(\?|$)/i.test(url)) {
    return { mode: 'video', url, simulated: false, label: 'Demo video stream' };
  }

  if (url) {
    return {
      mode: 'edge',
      url: null,
      simulated: true,
      label: 'Connecting stream — sync camera with vision backend',
    };
  }

  return {
    mode: 'edge',
    url: null,
    simulated: true,
    label: 'No stream URL configured',
  };
}

function getLiveAnalytics(camera) {
  const v = camera.validation || {};
  const fpsTarget = Number(camera.fpsLimit) || v.fps || 25;
  const fps = jitter(fpsTarget, 1.2, 1, fpsTarget);
  const latencyMs = jitter(v.latencyMs || 128, 18, 40, 400);
  const packetLoss = jitter(0.3, 0.25, 0, 5);
  const bitrate = jitter(2.6, 0.4, 0.5, 12);
  const uptimeSecs = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400);

  let streamHealth = 'good';
  if (camera.status !== 'online' || packetLoss > 2 || latencyMs > 250) streamHealth = 'poor';
  else if (packetLoss > 0.8 || latencyMs > 160 || Math.abs(fps - fpsTarget) > 2) streamHealth = 'fair';

  return {
    timestamp: new Date().toISOString(),
    fps,
    fpsTarget,
    bitrateMbps: bitrate,
    latencyMs: Math.round(latencyMs),
    jitterMs: Math.round(jitter(8, 4, 1, 40)),
    packetLossPercent: packetLoss,
    codec: v.codec || 'H.264',
    resolution: camera.resolution || v.resolution || '1920x1080',
    hasAudio: v.hasAudio !== false,
    uptimeSeconds: uptimeSecs,
    framesReceived: Math.floor(uptimeSecs * fps * 0.98),
    frameDrops: Math.floor(Math.random() * 4),
    streamHealth,
    recording: Boolean(camera.recording),
    aiEventsLastHour: Math.floor(Math.random() * 18),
    alertsToday: Math.floor(Math.random() * 6),
    reconnectCount: v.reconnectOk === false ? 1 : 0,
    bandwidthInKbps: Math.round(bitrate * 1024 * 0.7),
    bandwidthOutKbps: Math.round(bitrate * 1024 * 0.15),
  };
}

function getLiveViewPayload(camera) {
  return {
    camera: sanitizeCamera(camera),
    preview: getPreviewConfig(camera),
    analytics: getLiveAnalytics(camera),
  };
}

module.exports = {
  getLiveViewPayload,
  getLiveAnalytics,
  sanitizeCamera,
};
