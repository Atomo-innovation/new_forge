const CAMERA_SOURCES = [
  { id: 'rtsp', label: 'RTSP camera' },
  { id: 'onvif', label: 'ONVIF camera' },
  { id: 'usb', label: 'USB camera' },
  { id: 'ip', label: 'IP camera' },
  { id: 'http', label: 'HTTP stream' },
  { id: 'video-file', label: 'Video file' },
  { id: 'image-folder', label: 'Image folder' },
  { id: 'mipi', label: 'MIPI camera' },
  { id: 'local-test', label: 'Local test feed' },
];

const AI_MODELS = [
  { id: 'yolov8-perimeter', label: 'Person' },
  { id: 'fire-smoke', label: 'Fire & Smoke' },
  { id: 'face-recog', label: 'Face' },
  { id: 'ppe-detection', label: 'Safety model' },
];

const RESOLUTIONS = ['3840x2160', '2560x1440', '1920x1080', '1280x720', '640x480'];

const CHECK_ORDER = [
  'streamReachable',
  'credentialsValid',
  'frameReceived',
  'resolutionDetected',
  'fpsDetected',
  'codecDetected',
  'latencyMeasured',
  'audioPresence',
  'reconnectCapability',
];

const CHECK_LABELS = {
  streamReachable: 'Stream reachable',
  credentialsValid: 'Credentials valid',
  frameReceived: 'Frame received',
  resolutionDetected: 'Resolution detected',
  fpsDetected: 'FPS detected',
  codecDetected: 'Codec detected',
  latencyMeasured: 'Latency measured',
  audioPresence: 'Audio presence',
  reconnectCapability: 'Reconnect capability',
};

let cameras = [];
let stats = { total: 0, online: 0, offline: 0 };
let demoMode = false;
let lastValidation = null;
let isTesting = false;
let modalOpen = false;

function sessionUrl(path) {
  const sid = sessionStorage.getItem('atomoSessionId');
  return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

function typeLabel(type) {
  return CAMERA_SOURCES.find((s) => s.id === type)?.label || type;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formValue(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

function selectedValues(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return Array.from(el.selectedOptions).map((o) => o.value);
}

function getFormPayload() {
  return {
    name: formValue('camName'),
    type: formValue('camType'),
    rtspUrl: formValue('camRtspUrl'),
    location: formValue('camLocation'),
    zoneFloor: formValue('camZone'),
    department: formValue('camDepartment'),
    group: formValue('camGroup'),
    resolution: formValue('camResolution'),
    fpsLimit: Number(formValue('camFps')) || 25,
    aiModels: selectedValues('camAiModels'),
    recording: formValue('camRecording'),
    mipiEnabled: formValue('camType') !== 'mipi' || formValue('camMipiHw'),
    checkAudio: true,
  };
}

function renderSources() {
  return CAMERA_SOURCES.map(
    (s) => `<button type="button" class="ov-quick-btn ov-cam-source-chip" data-type="${s.id}">${esc(s.label)}</button>`
  ).join('');
}

function isDetectionLiveTab() {
  const slug = document.body.dataset.detectionSlug;
  return slug === 'person' || slug === 'fire-smoke';
}

function renderCameraTile(cam) {
  const online = cam.status === 'online';
  const liveTab = isDetectionLiveTab();
  const selected = liveTab && window.PersonLive?.getSelectedCameraId?.() === cam.id;
  return `
    <article class="ov-cam-tile ov-cam-tile-clickable ${selected ? 'is-selected' : ''}" data-id="${cam.id}" data-action="open-view" tabindex="0" role="button" aria-label="${liveTab ? 'Select' : 'Open live view for'} ${esc(cam.name)}">
      <div class="ov-cam-tile-head">
        <span class="ov-cam-tile-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
        </span>
        <button type="button" class="ov-cam-icon-btn" data-action="delete" data-id="${cam.id}" title="Remove camera" aria-label="Remove ${esc(cam.name)}" ${demoMode ? 'hidden' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
      <h3 class="ov-cam-tile-name">${esc(cam.name)}</h3>
      <p class="ov-cam-tile-type">${esc(typeLabel(cam.type))}</p>
      <span class="ov-badge ${online ? 'ov-badge-success' : 'ov-badge-error'}">${online ? 'Online' : 'Offline'}</span>
      <div class="ov-cam-tile-meta">
        <span>${esc(cam.location || 'No location')}</span>
        <span class="ov-mono">${esc(cam.resolution || '—')} · ${cam.fpsLimit || '—'} fps</span>
      </div>
      <span class="ov-cam-tile-hint">${liveTab ? 'Select for detection' : 'Open live view'}</span>
    </article>`;
}

function renderCameraGrid() {
  const tiles = cameras.map(renderCameraTile).join('');
  if (demoMode) return tiles;
  const addTile = `
    <button type="button" class="ov-cam-tile ov-cam-tile-add" data-action="open-add" aria-label="Add camera">
      <span class="ov-cam-tile-plus" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      </span>
      <span class="ov-cam-tile-add-label">Add camera</span>
      <span class="ov-cam-tile-add-sub">Connect a new source</span>
    </button>`;
  return `${tiles}${addTile}`;
}

function renderValidationPanel() {
  if (!lastValidation) {
    return `
      <div class="ov-cam-val-idle">
        <div class="ov-cam-val-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
        </div>
        <h3>Stream validation</h3>
        <p>Test the stream before saving. The system checks reachability, credentials, frames, codec, latency, and reconnect behavior.</p>
      </div>`;
  }

  const { success, error, checks, detected } = lastValidation;
  const checksHtml = CHECK_ORDER.map((key) => {
    const item = checks?.[key];
    if (!item) return '';
    const badge = item.ok ? 'ov-badge-success' : 'ov-badge-error';
    return `
      <div class="ov-alert-activity-row ov-cam-check">
        <div class="ov-alert-activity-main">
          <div class="ov-alert-activity-title">${CHECK_LABELS[key]}</div>
          <div class="ov-alert-activity-time">${esc(item.message)}</div>
        </div>
        <span class="ov-badge ${badge}">${item.ok ? 'Pass' : 'Fail'}</span>
      </div>`;
  }).join('');

  const detectedHtml =
    success && detected
      ? `<div class="ov-merged-mini ov-cam-detected">
        <div class="ov-mini-label">Detected stream profile</div>
        <div class="ov-cam-detected-grid">
          <span>Resolution</span><strong class="ov-mono">${esc(detected.resolution)}</strong>
          <span>FPS</span><strong class="ov-mono">${detected.fps}</strong>
          <span>Codec</span><strong class="ov-mono">${esc(detected.codec)}</strong>
          <span>Latency</span><strong class="ov-mono">${detected.latencyMs} ms</strong>
        </div>
      </div>`
      : '';

  const bannerHtml = !success
    ? `<div class="ov-kpi ov-kpi-critical ov-cam-val-banner" role="alert">
        <div class="ov-kpi-label">Validation failed</div>
        <div class="ov-kpi-sub">${esc(error || 'Stream validation failed')}</div>
      </div>`
    : `<div class="ov-kpi ov-cam-val-banner ov-cam-val-banner-success" role="status">
        <div class="ov-kpi-label">Validation passed</div>
        <div class="ov-kpi-sub">Stream validated — ready to save</div>
      </div>`;

  return `${bannerHtml}${detectedHtml}<div class="ov-cam-checks">${checksHtml}</div>`;
}

function renderAddForm() {
  return `
    <form class="ov-cam-form" id="camAddForm" novalidate>
      <div class="ov-cam-form-section">
        <div class="ov-info-title">Identity</div>
        <div class="ov-cam-field">
          <label for="camName">Camera name <span class="req">*</span></label>
          <input id="camName" name="name" type="text" placeholder="e.g. North Gate — Entrance" required>
        </div>
        <div class="ov-cam-field">
          <label for="camType">Camera type <span class="req">*</span></label>
          <select id="camType" name="type">
            ${CAMERA_SOURCES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">Connection</div>
        <div class="ov-cam-field">
          <label for="camRtspUrl">Stream URL / path</label>
          <input id="camRtspUrl" name="rtspUrl" type="text" placeholder="rtsp://192.168.1.50:554/stream1">
        </div>
        <label class="ov-cam-check-inline" id="camMipiWrap" hidden>
          <input id="camMipiHw" type="checkbox">
          <span>MIPI hardware detected on this device</span>
        </label>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">Placement</div>
        <div class="ov-cam-field-row">
          <div class="ov-cam-field">
            <label for="camLocation">Location</label>
            <input id="camLocation" name="location" type="text" placeholder="Building A — Main entrance">
          </div>
          <div class="ov-cam-field">
            <label for="camZone">Zone / Floor</label>
            <input id="camZone" name="zoneFloor" type="text" placeholder="Ground floor">
          </div>
        </div>
        <div class="ov-cam-field-row">
          <div class="ov-cam-field">
            <label for="camDepartment">Department</label>
            <input id="camDepartment" name="department" type="text" placeholder="Security">
          </div>
          <div class="ov-cam-field">
            <label for="camGroup">Camera group</label>
            <input id="camGroup" name="group" type="text" placeholder="Perimeter">
          </div>
        </div>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">Stream profile</div>
        <div class="ov-cam-field-row">
          <div class="ov-cam-field">
            <label for="camResolution">Resolution</label>
            <select id="camResolution" name="resolution">
              ${RESOLUTIONS.map((r) => `<option value="${r}" ${r === '1920x1080' ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </div>
          <div class="ov-cam-field">
            <label for="camFps">FPS limit</label>
            <input id="camFps" name="fpsLimit" type="number" min="1" max="60" value="25">
          </div>
        </div>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">AI models</div>
        <div class="ov-cam-field">
          <label for="camAiModels">AI model assignment</label>
          <select id="camAiModels" name="aiModels" multiple size="3">
            ${AI_MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <label class="ov-cam-check-inline">
          <input id="camRecording" name="recording" type="checkbox" checked>
          <span>Enable continuous recording</span>
        </label>
      </div>
    </form>`;
}

function renderModal() {
  return `
    <div class="ov-modal ${modalOpen ? 'is-open' : ''}" id="camAddModal" role="dialog" aria-modal="true" aria-labelledby="camModalTitle" ${modalOpen ? '' : 'hidden'}>
      <div class="ov-modal-backdrop" data-action="close-modal"></div>
      <div class="ov-modal-dialog">
        <div class="ov-modal-head">
          <div>
            <h2 id="camModalTitle" class="ov-modal-title">Add camera</h2>
            <p class="ov-merged-sub">Fill in details, test the stream, then save to register the camera.</p>
          </div>
          <button type="button" class="ov-modal-close" data-action="close-modal" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="ov-modal-sources">
          <div class="ov-stat-headline">Supported sources</div>
          <div class="ov-cam-sources-chips">${renderSources()}</div>
        </div>

        <div class="ov-modal-body ov-cam-add-grid">
          <div class="ov-modal-form-wrap">${renderAddForm()}</div>
          <aside class="ov-cam-validation" id="camValidationPanel" aria-live="polite">${renderValidationPanel()}</aside>
        </div>

        <div class="ov-modal-foot">
          <button type="button" class="ov-quick-btn" id="camResetBtn">Reset</button>
          <button type="button" class="ov-quick-btn" id="camTestBtn" ${isTesting ? 'disabled' : ''}>
            ${isTesting ? 'Testing stream…' : 'Test stream'}
          </button>
          <button type="button" class="ov-quick-btn ov-cam-save-btn" id="camSaveBtn" ${!lastValidation?.success ? 'disabled' : ''}>Save camera</button>
        </div>
      </div>
    </div>`;
}

function navigateToCamera(id) {
  if (isDetectionLiveTab() && window.PersonLive?.selectCamera) {
    window.PersonLive.selectCamera(id);
    return;
  }
  window.location.href = sessionUrl(`/cameras/${encodeURIComponent(id)}`);
}

function renderShell() {
  const root = document.getElementById('cameraManagement');
  if (!root) return;

  root.innerHTML = `
    <article class="ov-card ov-cam-mgmt">
      <div class="ov-cam-mgmt-inner">
        <div class="ov-merged-head ov-cam-mgmt-head">
          <div>
            <div class="ov-stat-headline ov-cam-mgmt-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
              <span>Camera management</span>
            </div>
            <div class="ov-merged-sub">${cameras.length ? `${cameras.length} registered camera${cameras.length === 1 ? '' : 's'}` : 'No cameras yet — add your first source'}</div>
          </div>
          <button type="button" class="ov-cam-add-btn" data-action="open-add" aria-label="Add camera" ${demoMode ? 'hidden' : ''}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            <span>Add camera</span>
          </button>
        </div>

        <div class="ov-merged-divider" aria-hidden="true"></div>

        <div class="ov-cam-grid" id="camGrid">${renderCameraGrid()}</div>
      </div>
      <div class="ov-merged-accent" aria-hidden="true"></div>
    </article>`;

  mountModal();
  wireCardEvents();
}

function mountModal() {
  let modal = document.getElementById('camAddModal');
  if (!modal) {
    const host = document.createElement('div');
    host.id = 'camModalHost';
    document.body.appendChild(host);
  }
  const host = document.getElementById('camModalHost');
  host.innerHTML = renderModal();
  wireModalEvents();
  syncTypeFields();
}

function updateGrid() {
  const grid = document.getElementById('camGrid');
  if (grid) grid.innerHTML = renderCameraGrid();
  wireCardEvents();
}

function syncTypeFields() {
  const type = formValue('camType');
  const urlField = document.getElementById('camRtspUrl');
  const mipiWrap = document.getElementById('camMipiWrap');
  if (!urlField) return;

  const placeholders = {
    rtsp: 'rtsp://192.168.1.50:554/stream1',
    onvif: 'onvif://192.168.1.50:80/onvif/device_service',
    usb: '/dev/video0',
    ip: '192.168.1.50:554',
    http: 'http://192.168.1.50/mjpeg/stream',
    'video-file': '/var/test/footage/sample.mp4',
    'image-folder': '/var/test/frames/gate-a/',
    mipi: 'mipi-csi0',
    'local-test': 'local://test-pattern',
  };
  urlField.placeholder = placeholders[type] || 'Stream address';

  document.querySelectorAll('.ov-cam-source-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.type === type);
  });

  if (mipiWrap) mipiWrap.hidden = type !== 'mipi';
}

function wireCardEvents() {
  document.querySelectorAll('[data-action="open-add"]').forEach((btn) => {
    btn.addEventListener('click', openAddModal);
  });

  document.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDelete(e);
    });
  });

  document.querySelectorAll('.ov-cam-tile-clickable[data-id]').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="delete"]')) return;
      navigateToCamera(tile.dataset.id);
    });
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateToCamera(tile.dataset.id);
      }
    });
  });
}

function wireModalEvents() {
  document.querySelectorAll('[data-action="close-modal"]').forEach((el) => {
    el.addEventListener('click', closeAddModal);
  });

  document.getElementById('camType')?.addEventListener('change', () => {
    syncTypeFields();
    lastValidation = null;
    updateValidationPanel();
    document.getElementById('camSaveBtn')?.setAttribute('disabled', 'disabled');
  });

  document.querySelectorAll('.ov-cam-source-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const select = document.getElementById('camType');
      if (select) {
        select.value = chip.dataset.type;
        select.dispatchEvent(new Event('change'));
      }
    });
  });

  document.getElementById('camTestBtn')?.addEventListener('click', testStream);
  document.getElementById('camResetBtn')?.addEventListener('click', resetForm);
  document.getElementById('camSaveBtn')?.addEventListener('click', saveCamera);
}

function onModalKeydown(e) {
  if (e.key === 'Escape' && modalOpen) closeAddModal();
}

function preselectDetectionModel() {
  const modelId = document.body.dataset.detectionModelId;
  if (!modelId) return;
  const select = document.getElementById('camAiModels');
  if (!select) return;
  Array.from(select.options).forEach((opt) => {
    opt.selected = opt.value === modelId || opt.selected;
  });
}

function openAddModal() {
  modalOpen = true;
  lastValidation = null;
  mountModal();
  preselectDetectionModel();
  document.body.classList.add('ov-modal-open');
  document.getElementById('camName')?.focus();
}

function closeAddModal() {
  modalOpen = false;
  const modal = document.getElementById('camAddModal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.hidden = true;
  }
  document.body.classList.remove('ov-modal-open');
}

function updateValidationPanel() {
  const panel = document.getElementById('camValidationPanel');
  if (panel) panel.innerHTML = renderValidationPanel();
  const saveBtn = document.getElementById('camSaveBtn');
  if (saveBtn) {
    if (lastValidation?.success) saveBtn.removeAttribute('disabled');
    else saveBtn.setAttribute('disabled', 'disabled');
  }
}

function resetForm() {
  document.getElementById('camAddForm')?.reset();
  const fps = document.getElementById('camFps');
  const res = document.getElementById('camResolution');
  const rec = document.getElementById('camRecording');
  if (fps) fps.value = '25';
  if (res) res.value = '1920x1080';
  if (rec) rec.checked = true;
  lastValidation = null;
  syncTypeFields();
  updateValidationPanel();
}

async function handleDelete(e) {
  const btn = e.currentTarget;
  const id = btn.dataset.id;
  if (!id || !window.confirm('Remove this camera from the system?')) return;
  const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(id)}`), { method: 'DELETE' });
  if (!res.ok) {
    showToast('Could not remove camera');
    return;
  }
  const data = await res.json();
  stats = data.stats;
  await loadCameras();
  showToast('Camera removed');
}

async function loadCameras() {
  try {
    const res = await fetch(sessionUrl('/api/cameras'));
    if (!res.ok) return;
    const data = await res.json();
    cameras = data.cameras || [];
    stats = data.stats || { total: cameras.length, online: 0, offline: 0 };
    demoMode = data.demoMode === true;
    if (document.getElementById('camGrid')) {
      updateGrid();
    } else if (document.getElementById('cameraManagement')) {
      renderShell();
    }
    const sub = document.querySelector('.ov-cam-mgmt-head .ov-merged-sub');
    if (sub) {
      sub.textContent = cameras.length
        ? `${cameras.length} registered camera${cameras.length === 1 ? '' : 's'}`
        : 'No cameras yet — add your first source';
    }
  } catch {
    /* ignore */
  }
}

async function testStream() {
  if (isTesting) return;
  isTesting = true;
  lastValidation = null;

  const testBtn = document.getElementById('camTestBtn');
  const saveBtn = document.getElementById('camSaveBtn');
  if (testBtn) {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing stream…';
  }
  if (saveBtn) saveBtn.setAttribute('disabled', 'disabled');

  const panel = document.getElementById('camValidationPanel');
  if (panel) {
    panel.innerHTML = `<div class="ov-cam-val-loading"><span class="ov-cam-spinner"></span> Running stream validation…</div>`;
  }

  try {
    const res = await fetch(sessionUrl('/api/cameras/validate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getFormPayload()),
    });
    lastValidation = await res.json();
    if (lastValidation.success) showToast('Stream validated successfully');
    else showToast(lastValidation.error || 'Validation failed');
  } catch {
    lastValidation = { success: false, error: 'Network timeout', checks: {} };
    showToast('Network timeout');
  } finally {
    isTesting = false;
    if (testBtn) {
      testBtn.disabled = false;
      testBtn.textContent = 'Test stream';
    }
    updateValidationPanel();
  }
}

async function saveCamera() {
  if (!lastValidation?.success) {
    showToast('Test the stream before saving');
    return;
  }

  const saveBtn = document.getElementById('camSaveBtn');
  if (saveBtn) saveBtn.disabled = true;

  try {
    const res = await fetch(sessionUrl('/api/cameras'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getFormPayload()),
    });
    const data = await res.json();
    if (!res.ok) {
      lastValidation = { success: false, error: data.error, checks: data.checks || {} };
      updateValidationPanel();
      showToast(data.error || 'Could not save camera');
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    stats = data.stats;
    cameras.unshift(data.camera);
    closeAddModal();
    renderShell();
    showToast(`Camera "${data.camera.name}" added`);

    const detSlug = document.body.dataset.detectionSlug;
    if (detSlug && data.camera?.id) {
      try {
        await fetch(sessionUrl(`/api/detection/${detSlug}/cameras`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cameraId: data.camera.id }),
        });
        if (window.DetectionTab?.reload) window.DetectionTab.reload();
      } catch {
        /* ignore */
      }
    }
  } catch {
    showToast('Failed to save camera');
    if (saveBtn) saveBtn.disabled = false;
  }
}

function openAddCameraModal() {
  const root = document.getElementById('cameraManagement');
  if (root) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  openAddModal();
}

async function initCameraManagement() {
  if (!document.getElementById('cameraManagement')) return;
  document.addEventListener('keydown', onModalKeydown);
  await loadCameras();
}

window.CameraManagement = {
  reload: loadCameras,
};

window.openOverviewAddCamera = openAddCameraModal;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCameraManagement);
} else {
  initCameraManagement();
}
