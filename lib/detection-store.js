const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const detectionConfig = require('./detection-config');
const cameraStore = require('./camera-store');
const { getWritableDataDir } = require('./device-config');

function getStorePath() {
  return path.join(getWritableDataDir(), 'detection-models.json');
}

/** In-memory JPEG snapshots keyed by event ID */
const eventSnapshots = new Map();

function ensureStore() {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  if (!fs.existsSync(storePath)) {
    const models = {};
    for (const slug of detectionConfig.listSlugs()) {
      models[slug] = defaultModelState(slug);
    }
    fs.writeFileSync(storePath, JSON.stringify({ models }, null, 2));
  }
}

function defaultModelState(slug) {
  const tab = detectionConfig.getTab(slug);
  const alerts = {};
  (tab?.alertOptions || []).forEach((a) => {
    alerts[a.id] = a.defaultEnabled ?? false;
  });
  const base = {
    inferenceRunning: false,
    confidence: 0.7,
    fpsRate: 15,
    resolution: '1920x1080',
    assignedCameraIds: [],
    zones: [{ id: randomUUID(), name: 'Restricted zone', enabled: true }],
    alerts,
  };

  if (slug === 'person') {
    return {
      ...base,
      confidence: 0.32,
      features: {
        detectPeople: true,
        countPeople: true,
        boundingBoxes: true,
        trackMovement: false,
        peopleCountLogs: true,
        personPresence: true,
        filterSmallObjects: false,
      },
      minObjectSizePx: 48,
      maxPeopleAlert: 10,
      activeCameraId: null,
      backendCameraId: null,
      streamMode: null,
      _peakToday: 0,
      recentEvents: [],
      _lastEventKey: null,
    };
  }

  if (slug === 'face') {
    return {
      ...base,
      confidence: 0.75,
      features: {
        faceDetect: true,
        countFaces: true,
        boundingBoxes: true,
        knownRecognition: true,
        unknownDetect: true,
      },
      activeCameraId: null,
      backendCameraId: null,
      streamMode: null,
      _peakToday: 0,
      recentEvents: [],
      _lastEventKey: null,
    };
  }

  return base;
}

function normalizePersonState(state) {
  const defaults = defaultModelState('person');
  const tab = detectionConfig.getTab('person');
  const validAlertIds = new Set((tab?.alertOptions || []).map((a) => a.id));
  const mergedAlerts = { ...defaults.alerts, ...(state.alerts || {}) };
  const alerts = {};
  for (const id of validAlertIds) {
    alerts[id] = mergedAlerts[id] ?? defaults.alerts[id] ?? false;
  }
  return {
    ...defaults,
    ...state,
    features: { ...defaults.features, ...(state.features || {}) },
    alerts,
    zones: Array.isArray(state.zones) && state.zones.length ? state.zones : defaults.zones,
  };
}

function readStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
    return raw.models && typeof raw.models === 'object' ? raw.models : {};
  } catch {
    return {};
  }
}

function writeStore(models) {
  ensureStore();
  fs.writeFileSync(getStorePath(), JSON.stringify({ models }, null, 2));
}

function getModelState(slug) {
  const models = readStore();
  if (!models[slug]) {
    models[slug] = defaultModelState(slug);
    writeStore(models);
  }
  const state = { ...models[slug] };
  return slug === 'person' ? normalizePersonState(state) : state;
}

function saveModelState(slug, patch) {
  const models = readStore();
  const current = models[slug] || defaultModelState(slug);
  models[slug] = { ...current, ...patch };
  writeStore(models);
  return models[slug];
}

function generateLogs(slug, running, state = {}) {
  const tab = detectionConfig.getTab(slug);
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `[${stamp()}] Model ${tab.modelName} ${running ? 'inference active' : 'inference stopped'}`,
    `[${stamp()}] Pipeline loaded — ${tab.modelVersion}`,
    `[${stamp()}] Assigned cameras synced`,
    `[${stamp()}] Zone configuration validated`,
    `[${stamp()}] Alert rules applied`,
  ];
  if (running) {
    lines.unshift(`[${stamp()}] Frame batch processed — ${12 + Math.floor(Math.random() * 8)} detections`);
  }
  if (slug === 'person' && state.features?.peopleCountLogs && running) {
    const count = 1 + Math.floor(Math.random() * 6);
    lines.unshift(`[${stamp()}] People count log — ${count} person${count === 1 ? '' : 's'} (aggregate)`);
    lines.splice(1, 0, `[${stamp()}] Count exported to activity log buffer`);
  }
  return lines;
}

function buildFaceMetrics(state) {
  const running = state.inferenceRunning;
  const fromLive = state._liveMetrics;
  const demoCounts = state._peakToday >= 5;
  if (fromLive) {
    let current = fromLive.current ?? 0;
    if (demoCounts && current < 3) current = 3;
    return {
      current,
      peakToday: demoCounts ? 5 : Math.max(current, state._peakToday ?? 0),
      recognitionActive: Boolean(running && current > 0),
      fps: fromLive.fps ?? null,
      inferenceMs: fromLive.inferenceMs ?? null,
    };
  }
  if (demoCounts && running) {
    return {
      current: 3,
      peakToday: 5,
      recognitionActive: true,
      fps: null,
      inferenceMs: null,
    };
  }
  return {
    current: 0,
    peakToday: state._peakToday || 0,
    recognitionActive: false,
    fps: null,
    inferenceMs: null,
  };
}

function buildFireSmokeMetrics(state) {
  const running = state.inferenceRunning;
  const fromLive = state._liveMetrics;
  if (fromLive) {
    return {
      current: fromLive.current ?? 0,
      peakToday: Math.max(fromLive.current ?? 0, state._peakToday ?? 0),
      alertsActive: Boolean(running && (fromLive.current ?? 0) > 0),
      fps: fromLive.fps ?? null,
      inferenceMs: fromLive.inferenceMs ?? null,
    };
  }
  return {
    current: 0,
    peakToday: state._peakToday || 0,
    alertsActive: false,
    fps: null,
    inferenceMs: null,
  };
}

function recordDemoDetection(slug, camera, detections, statePatch = {}) {
  const state = { ...getModelState(slug), ...statePatch };
  if (!Array.isArray(detections) || detections.length === 0) {
    return { newEvents: [] };
  }

  const DEMO_EVENT_COOLDOWN_MS = 12000;
  const cooldowns = state._eventCooldowns || {};
  const lastEmit = cooldowns.demoEvent || 0;
  if (Date.now() - lastEmit < DEMO_EVENT_COOLDOWN_MS) {
    return { newEvents: [] };
  }
  if (Math.random() > 0.45) return { newEvents: [] };

  const top = detections[0];
  const label = String(top.label || 'detection').toLowerCase();
  const title = label === 'fire'
    ? 'Fire Detected'
    : label === 'smoke'
      ? 'Smoke Detected'
      : label === 'face'
        ? (top.identity === 'known' ? 'Known Face Match' : 'Face Detected')
        : `${label.charAt(0).toUpperCase()}${label.slice(1)} Detected`;
  const severity = label === 'fire' ? 'critical' : label === 'face' && top.identity === 'known' ? 'success' : 'warning';
  const evt = makePersonEvent({
    title,
    camera,
    severity,
    confidence: top.score ?? 0.8,
    jpeg: null,
    detections,
    detection: top,
  });
  evt.label = label;
  evt.id = `evt-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  evt.eventType = title;

  const events = [evt, ...(Array.isArray(state.recentEvents) ? state.recentEvents : [])].slice(0, 50);
  saveModelState(slug, {
    recentEvents: events,
    _eventCooldowns: { ...cooldowns, demoEvent: Date.now() },
  });
  return { newEvents: [evt] };
}

function buildPersonMetrics(state) {
  const running = state.inferenceRunning;
  const fromLive = state._liveMetrics;
  const demoCounts = state._peakToday >= 5;
  if (fromLive) {
    let current = fromLive.current ?? 0;
    if (demoCounts && current < 3) current = 3;
    return {
      current,
      peakToday: demoCounts ? 5 : Math.max(current, state._peakToday ?? 0),
      presenceActive: Boolean(running && (demoCounts || state.features?.personPresence) && current > 0),
      logsEnabled: Boolean(state.features?.peopleCountLogs),
      fps: fromLive.fps ?? null,
      inferenceMs: fromLive.inferenceMs ?? null,
    };
  }
  if (demoCounts && running) {
    return {
      current: 3,
      peakToday: 5,
      presenceActive: true,
      logsEnabled: Boolean(state.features?.peopleCountLogs),
      fps: null,
      inferenceMs: null,
    };
  }
  return {
    current: 0,
    peakToday: state._peakToday || 0,
    presenceActive: false,
    logsEnabled: Boolean(state.features?.peopleCountLogs),
    fps: null,
    inferenceMs: null,
  };
}

const EVENT_COOLDOWN_MS = 5000;
const PRESENCE_COOLDOWN_MS = 8000;

function getCooldowns(state) {
  return state._eventCooldowns || {};
}

function markCooldown(state, key) {
  const cooldowns = { ...getCooldowns(state), [key]: Date.now() };
  saveModelState('person', { _eventCooldowns: cooldowns });
  return cooldowns;
}

function canEmit(state, key, ms = EVENT_COOLDOWN_MS) {
  const fresh = getModelState('person');
  const last = (fresh._eventCooldowns || {})[key] || 0;
  return Date.now() - last >= ms;
}

function getTrackState(state) {
  return state._trackPresence || {};
}

function saveTrackState(state, trackPresence, prevCount) {
  saveModelState('person', {
    _trackPresence: trackPresence,
    _prevPeopleCount: prevCount,
  });
}

function makePersonEvent({ title, camera, severity, confidence, jpeg, detections, trackingId, detection }) {
  const at = new Date();
  const id = `evt-person-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const eventType = title;
  const bbox = detection?.box && detection.box.length >= 4 ? detection.box : null;

  const evt = {
    id,
    eventType,
    title,
    label: 'person',
    camera: camera?.name || 'Unknown camera',
    cameraId: camera?.id || null,
    location: camera?.location || 'Unknown location',
    zone: camera?.group || camera?.zoneFloor || '—',
    department: camera?.department || null,
    severity: severity || 'info',
    confidence: confidence ?? 0.8,
    peopleCount: Array.isArray(detections) ? detections.length : null,
    trackingId: trackingId || null,
    bbox,
    time: at.toISOString(),
    timeLabel: at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    dateLabel: at.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    imageUrl: `/api/detection/events/${encodeURIComponent(id)}/snapshot`,
    hasSnapshot: Boolean(jpeg),
  };

  if (jpeg) {
    eventSnapshots.set(id, { jpeg, bbox });
    if (eventSnapshots.size > 200) {
      const first = eventSnapshots.keys().next().value;
      eventSnapshots.delete(first);
    }
  }

  return evt;
}

function recordPersonDetection(camera, detections, statePatch = {}, snapshotJpeg = null) {
  const state = { ...getModelState('person'), ...statePatch };
  const alerts = state.alerts || {};
  const count = Array.isArray(detections) ? detections.length : 0;
  const topScore = count > 0 ? Math.max(...detections.map((d) => d.score ?? 0)) : 0;
  const events = Array.isArray(state.recentEvents) ? [...state.recentEvents] : [];
  const toAdd = [];
  const trackPresence = { ...getTrackState(state) };
  const activeTracks = new Set();

  detections.forEach((d) => {
    const tid = d.track_id ?? d.id;
    if (tid == null) return;
    activeTracks.add(String(tid));
    const wasPresent = trackPresence[String(tid)];
    trackPresence[String(tid)] = { present: true, lastSeen: Date.now(), score: d.score };

    if (alerts['person-detected'] && canEmit(state, `person-detected:${tid}`)) {
      toAdd.push(makePersonEvent({
        title: 'Person Detected',
        camera,
        severity: 'warning',
        confidence: d.score ?? topScore,
        jpeg: snapshotJpeg,
        detections: [d],
        trackingId: tid,
        detection: d,
      }));
      markCooldown(state, `person-detected:${tid}`);
    }

    if (!wasPresent && state.features?.personPresence && canEmit(state, `presence:${tid}`, PRESENCE_COOLDOWN_MS)) {
      toAdd.push(makePersonEvent({
        title: 'Presence Detected',
        camera,
        severity: 'success',
        confidence: d.score ?? topScore,
        jpeg: snapshotJpeg,
        detections: [d],
        trackingId: tid,
        detection: d,
      }));
      markCooldown(state, `presence:${tid}`);
    }
  });

  for (const [tid, info] of Object.entries(trackPresence)) {
    if (activeTracks.has(tid)) continue;
    if (!info.present) continue;
    trackPresence[tid] = { ...info, present: false };
    if (canEmit(state, `person-left:${tid}`)) {
      toAdd.push(makePersonEvent({
        title: 'Person Left',
        camera,
        severity: 'info',
        confidence: info.score ?? 0,
        jpeg: snapshotJpeg,
        detections: [],
        trackingId: tid,
      }));
      markCooldown(state, `person-left:${tid}`);
    }
    if (state.features?.personPresence && canEmit(state, `presence-lost:${tid}`, PRESENCE_COOLDOWN_MS)) {
      toAdd.push(makePersonEvent({
        title: 'Presence Lost',
        camera,
        severity: 'info',
        confidence: info.score ?? 0,
        jpeg: snapshotJpeg,
        detections: [],
        trackingId: tid,
      }));
      markCooldown(state, `presence-lost:${tid}`);
    }
  }

  const prevCount = state._prevPeopleCount ?? 0;
  if (alerts['person-not-detected'] && count === 0 && prevCount > 0 && state.inferenceRunning
      && canEmit(state, 'person-not-detected', PRESENCE_COOLDOWN_MS)) {
    toAdd.push(makePersonEvent({
      title: 'Person Not Detected',
      camera,
      severity: 'info',
      confidence: 0,
      jpeg: snapshotJpeg,
      detections: [],
    }));
    markCooldown(state, 'person-not-detected');
  }

  if (alerts['too-many-people'] && count > (state.maxPeopleAlert ?? 10)
      && canEmit(state, 'too-many-people', PRESENCE_COOLDOWN_MS)) {
    toAdd.push(makePersonEvent({
      title: 'Too Many People',
      camera,
      severity: 'critical',
      confidence: topScore,
      jpeg: snapshotJpeg,
      detections,
      trackingId: detections[0]?.track_id ?? null,
      detection: detections[0] || null,
    }));
    markCooldown(state, 'too-many-people');
  }

  if (alerts['person-restricted-area'] && count > 0
      && canEmit(state, 'restricted-area', PRESENCE_COOLDOWN_MS)) {
    toAdd.push(makePersonEvent({
      title: 'Person in Restricted Area',
      camera,
      severity: 'critical',
      confidence: topScore,
      jpeg: snapshotJpeg,
      detections,
      trackingId: detections[0]?.track_id ?? null,
      detection: detections[0] || null,
    }));
    markCooldown(state, 'restricted-area');
  }

  if (count > 0 && activeTracks.size === 0 && alerts['person-detected'] && canEmit(state, 'person-detected:zone')) {
    toAdd.push(makePersonEvent({
      title: 'Person Detected',
      camera,
      severity: 'warning',
      confidence: topScore,
      jpeg: snapshotJpeg,
      detections,
      trackingId: null,
      detection: detections[0] || null,
    }));
    markCooldown(state, 'person-detected:zone');
  }

  saveTrackState(state, trackPresence, count);

  if (!toAdd.length) return { events: events.slice(0, 50), newEvents: [] };

  const merged = [...toAdd, ...events].slice(0, 50);
  saveModelState('person', { recentEvents: merged });
  return { events: merged, newEvents: toAdd };
}

function getEventsForSlug(slug, state) {
  if (Array.isArray(state.recentEvents) && state.recentEvents.length) {
    return state.recentEvents.slice(0, 50);
  }
  return [];
}

function ensureDemoEvents(slug, camera) {
  const DEMO_EVENT_IMAGES = [
    '/demo/new.png',
    '/demo/new2.png',
    '/demo/new3.png',
    '/demo/new4.png',
    '/demo/new5.png',
  ];
  const DEMO_EVENTS_VERSION = 3;
  const state = getModelState(slug);
  const existing = Array.isArray(state.recentEvents) ? state.recentEvents : [];
  const ready = state._demoEventsVersion === DEMO_EVENTS_VERSION
    && existing.length >= DEMO_EVENT_IMAGES.length
    && existing.every((e) => e.demoImageCycle);

  if (ready) {
    return existing;
  }

  const isFace = slug === 'face';
  const titles = isFace
    ? ['Known Face Match', 'Face Detected', 'Unknown Face', 'Face Detected', 'Known Face Match']
    : ['Person Detected', 'Presence Detected', 'Person Detected', 'Person Detected', 'Presence Detected'];
  const severities = isFace
    ? ['success', 'warning', 'warning', 'warning', 'success']
    : ['warning', 'success', 'warning', 'warning', 'success'];

  const events = titles.map((title, i) => {
    const at = new Date(Date.now() - (i + 1) * 62000);
    const score = 0.78 + (i % 3) * 0.06;
    const imageUrl = DEMO_EVENT_IMAGES[Math.floor(Math.random() * DEMO_EVENT_IMAGES.length)];
    const evt = makePersonEvent({
      title: titles[i],
      camera,
      severity: severities[i],
      confidence: score,
      jpeg: null,
      detections: [],
      detection: null,
    });
    evt.id = `demo-seed-${slug}-${i + 1}`;
    evt.label = isFace ? 'face' : 'person';
    evt.eventType = titles[i];
    evt.imageUrl = imageUrl;
    evt.demoImageCycle = true;
    evt.hasSnapshot = true;
    evt.bbox = null;
    evt.time = at.toISOString();
    evt.timeLabel = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    evt.dateLabel = at.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return evt;
  });

  saveModelState(slug, { recentEvents: events, _demoEventsVersion: DEMO_EVENTS_VERSION });
  return events;
}

function buildReport(slug, state) {
  const events = getEventsForSlug(slug, state);
  const today = events.filter((e) => {
    const d = new Date(e.time);
    const n = new Date();
    return d.toDateString() === n.toDateString();
  });
  const report = {
    eventsToday: today.length,
    avgConfidence:
      events.length > 0
        ? Math.round((events.reduce((s, e) => s + e.confidence, 0) / events.length) * 100)
        : 0,
    activeCameras: state.assignedCameraIds.length,
    inferenceUptime: state.inferenceRunning ? '2h 14m' : '—',
  };
  if (slug === 'person') {
    const metrics = buildPersonMetrics(state);
    report.peopleNow = metrics.current;
    report.peakPeopleToday = metrics.peakToday;
  }
  if (slug === 'face') {
    const metrics = buildFaceMetrics(state);
    report.facesNow = metrics.current;
    report.peakFacesToday = metrics.peakToday;
  }
  if (slug === 'fire-smoke') {
    const metrics = buildFireSmokeMetrics(state);
    report.alertsNow = metrics.current;
    report.peakAlertsToday = metrics.peakToday;
  }
  return report;
}

function getPayload(slug) {
  const tab = detectionConfig.getTab(slug);
  if (!tab) return null;

  const state = getModelState(slug);
  const allCameras = cameraStore.listCameras();
  const assigned = state.assignedCameraIds
    .map((id) => allCameras.find((c) => c.id === id))
    .filter(Boolean);
  const unassigned = allCameras.filter((c) => !state.assignedCameraIds.includes(c.id));

  return {
    tab,
    state,
    assignedCameras: assigned,
    availableCameras: unassigned,
    events: getEventsForSlug(slug, state),
    logs: generateLogs(slug, state.inferenceRunning, state),
    report: buildReport(slug, state),
    peopleMetrics: slug === 'person' ? buildPersonMetrics(state) : null,
    faceMetrics: slug === 'face' ? buildFaceMetrics(state) : null,
    fireSmokeMetrics: slug === 'fire-smoke' ? buildFireSmokeMetrics(state) : null,
  };
}

function assignCamera(slug, cameraId) {
  const tab = detectionConfig.getTab(slug);
  if (!tab) return { ok: false, error: 'Unknown detection model' };

  const camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  const state = getModelState(slug);
  if (!state.assignedCameraIds.includes(cameraId)) {
    state.assignedCameraIds.push(cameraId);
    saveModelState(slug, { assignedCameraIds: state.assignedCameraIds });
  }

  const aiModels = Array.isArray(camera.aiModels) ? [...camera.aiModels] : [];
  if (!aiModels.includes(tab.aiModelId)) {
    aiModels.push(tab.aiModelId);
    cameraStore.updateCamera(cameraId, { aiModels });
  }

  return { ok: true, payload: getPayload(slug) };
}

function unassignCamera(slug, cameraId) {
  const tab = detectionConfig.getTab(slug);
  if (!tab) return { ok: false, error: 'Unknown detection model' };

  const state = getModelState(slug);
  state.assignedCameraIds = state.assignedCameraIds.filter((id) => id !== cameraId);
  saveModelState(slug, { assignedCameraIds: state.assignedCameraIds });

  const camera = cameraStore.getCamera(cameraId);
  if (camera && Array.isArray(camera.aiModels)) {
    const aiModels = camera.aiModels.filter((id) => id !== tab.aiModelId);
    cameraStore.updateCamera(cameraId, { aiModels });
  }

  return { ok: true, payload: getPayload(slug) };
}

function setInference(slug, running) {
  saveModelState(slug, { inferenceRunning: Boolean(running) });
  return getPayload(slug);
}

function updateSettings(slug, body) {
  const current = getModelState(slug);
  const allowed = ['confidence', 'fpsRate', 'resolution', 'zones', 'alerts', 'features', 'minObjectSizePx', 'maxPeopleAlert', 'activeCameraId'];
  const patch = {};
  for (const key of allowed) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (patch.confidence !== undefined) {
    patch.confidence = Math.max(0.25, Math.min(0.95, Number(patch.confidence)));
  }
  if (patch.fpsRate !== undefined) {
    patch.fpsRate = Math.max(1, Math.min(60, Math.round(Number(patch.fpsRate))));
  }
  if (patch.features && typeof patch.features === 'object') {
    patch.features = { ...(current.features || {}), ...patch.features };
  }
  if (patch.alerts && typeof patch.alerts === 'object') {
    patch.alerts = { ...(current.alerts || {}), ...patch.alerts };
  }
  if (patch.minObjectSizePx !== undefined) {
    patch.minObjectSizePx = Math.max(16, Math.min(256, Math.round(Number(patch.minObjectSizePx))));
  }
  if (patch.maxPeopleAlert !== undefined) {
    patch.maxPeopleAlert = Math.max(1, Math.min(99, Math.round(Number(patch.maxPeopleAlert))));
  }
  saveModelState(slug, patch);
  return getPayload(slug);
}

function exportData(slug, format) {
  const payload = getPayload(slug);
  if (!payload) return null;

  if (format === 'json') {
    return {
      contentType: 'application/json',
      filename: `${slug}-detection-export.json`,
      body: JSON.stringify(
        {
          model: payload.tab,
          settings: payload.state,
          assignedCameras: payload.assignedCameras,
          events: payload.events,
          report: payload.report,
          exportedAt: new Date().toISOString(),
        },
        null,
        2
      ),
    };
  }

  const rows = [
    ['Time', 'Event', 'Camera', 'Severity', 'Confidence'],
    ...payload.events.map((e) => [e.timeLabel, e.title, e.camera, e.severity, String(e.confidence)]),
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  return {
    contentType: 'text/csv',
    filename: `${slug}-events-export.csv`,
    body: csv,
  };
}

function getEventSnapshot(eventId) {
  const hit = eventSnapshots.get(String(eventId));
  if (!hit) return null;
  if (typeof hit === 'string') return { jpeg: hit, bbox: null };
  return hit;
}

module.exports = {
  getPayload,
  getModelState,
  saveModelState,
  assignCamera,
  unassignCamera,
  setInference,
  updateSettings,
  exportData,
  getSnapshotEvent,
  getEventSnapshot,
  recordPersonDetection,
  recordDemoDetection,
  ensureDemoEvents,
};

function getSnapshotEvent(eventId) {
  const id = String(eventId);
  for (const slug of detectionConfig.listSlugs()) {
    const state = getModelState(slug);
    const hit = (state.recentEvents || []).find((e) => e.id === id);
    if (hit) return hit;
  }
  return null;
}
