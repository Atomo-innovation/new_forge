const slug = document.body.dataset.detectionSlug;
let payload = null;
let previewCameraId = null;
let refreshTimer = null;
let eventSearchQuery = '';
let personSaveTimer = null;
let dashEventWs = null;
let dashWsConnected = false;
let lastEventsFingerprint = '';

function eventsFingerprint(events) {
  return (events || []).map((e) => e.id).join('|');
}

function applyLiveMetricsFromPayload(source) {
  if (!source) return;
  const m = isFaceTab
    ? (source.faceMetrics || null)
    : (source.peopleMetrics || null);
  if (!m) return;
  const demo = source.demoMode === true || document.body.classList.contains('demo-mode');
  const current = demo && (m.current == null || m.current < 3) ? 3 : (m.current ?? 0);
  const peak = demo && (m.peakToday == null || m.peakToday < 5) ? 5 : (m.peakToday ?? 0);
  document.querySelectorAll('[data-m="current"]').forEach((el) => { el.textContent = current; });
  document.querySelectorAll('[data-m="peak"]').forEach((el) => { el.textContent = peak; });
  document.querySelectorAll('[data-m="fps"]').forEach((el) => {
    el.textContent = m.fps != null ? Number(m.fps).toFixed(1) : '—';
  });
  document.querySelectorAll('[data-m="inf"]').forEach((el) => {
    el.textContent = m.inferenceMs != null ? `${Math.round(m.inferenceMs)}ms` : '—';
  });
  document.querySelectorAll('[data-m="presence"]').forEach((el) => {
    el.textContent = isFaceTab
      ? (m.recognitionActive ? 'Active' : 'None')
      : (m.presenceActive ? 'Active' : 'None');
  });
}

const isLiveTab = slug === 'person' || slug === 'face';
const isFaceTab = slug === 'face';
const isPersonTab = slug === 'person';

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

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityBadge(sev) {
  const map = {
    critical: 'ov-badge-error',
    warning: 'ov-badge-accent',
    success: 'ov-badge-success',
    info: 'ov-badge-gold',
  };
  return map[sev] || 'ov-badge-gold';
}

function statusBadge(running) {
  return running
    ? '<span class="ov-badge ov-badge-success">Running</span>'
    : '<span class="ov-badge ov-badge-error">Stopped</span>';
}

function renderAssignedCameras() {
  const cams = payload?.assignedCameras || [];
  if (!cams.length) {
    return '<p class="ov-det-empty">No cameras assigned to this model yet.</p>';
  }
  return cams
    .map(
      (cam) => `
    <div class="ov-det-assigned-row">
      <div>
        <div class="ov-det-assigned-name">${esc(cam.name)}</div>
        <div class="ov-det-assigned-meta">${esc(cam.location || 'No location')} · ${esc(cam.resolution || '—')}</div>
      </div>
      <div class="ov-det-assigned-actions">
        <!-- Preview hidden — use Camera management for stream view -->
        <!-- <button type="button" class="ov-quick-btn" data-action="preview-camera" data-id="${cam.id}">Preview</button> -->
        <button type="button" class="ov-quick-btn ov-det-remove-btn" data-action="remove-camera" data-id="${cam.id}">Remove</button>
      </div>
    </div>`
    )
    .join('');
}

function renderAddCameraSelect() {
  const available = payload?.availableCameras || [];
  if (!available.length) {
    return '<p class="ov-det-empty">All registered cameras are already assigned.</p>';
  }
  return `
    <div class="ov-det-add-cam-row">
      <select id="detAddCameraSelect" class="ov-det-select" aria-label="Select camera to assign">
        <option value="">Choose a camera…</option>
        ${available.map((c) => `<option value="${c.id}">${esc(c.name)} — ${esc(c.location || 'No location')}</option>`).join('')}
      </select>
      <button type="button" class="ov-cam-add-btn" id="detAddCameraBtn">Add to model</button>
    </div>`;
}

function renderZones() {
  const zones = payload?.state?.zones || [];
  return zones
    .map(
      (z, i) => `
    <div class="ov-det-zone-row" data-zone-index="${i}">
      <input type="text" class="ov-det-input" data-zone-name value="${esc(z.name)}" aria-label="Zone name">
      <label class="ov-cam-check-inline">
        <input type="checkbox" data-zone-enabled ${z.enabled ? 'checked' : ''}>
        <span>Enabled</span>
      </label>
      <button type="button" class="ov-quick-btn" data-action="remove-zone" data-index="${i}">Remove</button>
    </div>`
    )
    .join('');
}

function renderAlerts() {
  const options = payload?.tab?.alertOptions || [];
  const alerts = payload?.state?.alerts || {};
  return options
    .map(
      (opt) => `
    <label class="ov-det-alert-item">
      <input type="checkbox" data-alert-id="${opt.id}" ${alerts[opt.id] ? 'checked' : ''}>
      <span>${esc(opt.label)}</span>
    </label>`
    )
    .join('');
}

function renderPersonFeatures() {
  const options = payload?.tab?.featureOptions || [];
  const features = payload?.state?.features || {};
  return options
    .map(
      (opt) => `
    <label class="ov-det-feature-item ${opt.locked ? 'is-locked' : ''}">
      <input type="checkbox" data-feature-id="${opt.id}" ${features[opt.id] ? 'checked' : ''} ${opt.locked ? 'checked disabled' : ''}>
      <span class="ov-det-feature-copy">
        <strong>${esc(opt.label)}</strong>
        <small>${esc(opt.description)}</small>
      </span>
    </label>`
    )
    .join('');
}

function confidenceHint(pct) {
  if (pct < 50) return 'Sensitive — more detections, higher false-alert risk';
  if (pct < 75) return 'Balanced — recommended for most environments';
  return 'Strict — fewer false alerts, may miss distant people';
}

function renderPersonMetricsStrip() {
  const m = payload?.peopleMetrics || {};
  const r = payload?.report || {};
  return `
    <div class="ov-det-metrics-strip">
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val">${m.current ?? 0}</div>
        <div class="ov-det-metric-label">People now</div>
      </div>
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val">${r.peakPeopleToday ?? m.peakToday ?? 0}</div>
        <div class="ov-det-metric-label">Peak today</div>
      </div>
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val">${r.eventsToday ?? 0}</div>
        <div class="ov-det-metric-label">Events today</div>
      </div>
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val ov-det-metric-sm">${m.presenceActive ? 'Active' : 'None'}</div>
        <div class="ov-det-metric-label">Presence</div>
      </div>
    </div>`;
}

function renderPersonTuning() {
  const state = payload?.state || {};
  const pct = Math.round((state.confidence ?? 0.7) * 100);
  const minPx = state.minObjectSizePx ?? 48;
  const filterOn = Boolean(state.features?.filterSmallObjects);
  const tooManyOn = Boolean(state.alerts?.['too-many-people']);
  const maxPeople = state.maxPeopleAlert ?? 10;

  return `
    <div class="ov-det-tuning-grid">
      <div class="ov-det-tuning-card">
        <div class="ov-det-tuning-head">
          <span class="ov-det-tuning-title">Minimum confidence</span>
          <span class="ov-det-slider-val" id="detConfVal">${pct}%</span>
        </div>
        <div class="ov-det-slider-row">
          <input type="range" class="ov-det-range" id="detConfRange" min="25" max="95" step="1" value="${pct}" aria-label="Minimum detection confidence">
        </div>
        <p class="ov-det-tuning-hint" id="detConfHint">${confidenceHint(pct)}</p>
      </div>
      <div class="ov-det-tuning-card ${filterOn ? '' : 'is-disabled'}" id="detMinSizeCard">
        <div class="ov-det-tuning-head">
          <span class="ov-det-tuning-title">Min object size</span>
          <span class="ov-det-slider-val" id="detMinSizeVal">${minPx}px</span>
        </div>
        <div class="ov-det-slider-row">
          <input type="range" class="ov-det-range" id="detMinSizeRange" min="16" max="160" step="4" value="${minPx}" ${filterOn ? '' : 'disabled'} aria-label="Minimum object size in pixels">
        </div>
        <p class="ov-det-tuning-hint">Ignore detections smaller than this bounding-box size</p>
      </div>
    </div>
    <div class="ov-det-max-people-row ${tooManyOn ? '' : 'is-hidden'}" id="detMaxPeopleRow">
      <label for="detMaxPeople">Alert when count exceeds</label>
      <input type="number" class="ov-det-input ov-det-max-people-input" id="detMaxPeople" min="1" max="99" value="${maxPeople}">
      <span class="ov-det-max-people-suffix">people</span>
    </div>`;
}

function renderPersonControls() {
  const state = payload?.state || {};
  const running = state.inferenceRunning;
  const logsOn = Boolean(state.features?.peopleCountLogs);

  return `
    <article class="ov-card ov-det-model" id="personControlPanel">
      <div class="ov-det-model-inner">
        <div class="ov-merged-head ov-det-model-head">
          <div>
            <div class="ov-stat-headline ov-det-model-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>Person detection</span>
            </div>
            <p class="ov-det-overview-text">${esc(payload?.tab?.description || '')}</p>
          </div>
          <div class="ov-det-model-status-wrap">
            <span class="ov-det-status-label">Inference</span>
            ${statusBadge(running)}
            <button type="button" class="ov-quick-btn ${running ? 'ov-det-stop-btn' : ''}" id="detInferenceBtn">
              ${running ? 'Stop inference' : 'Start inference'}
            </button>
          </div>
        </div>

        <div class="ov-merged-divider" aria-hidden="true"></div>

        ${renderPersonMetricsStrip()}

        <section class="ov-det-section">
          <h3 class="ov-det-section-title">Detection features</h3>
          <div class="ov-det-feature-grid">${renderPersonFeatures()}</div>
        </section>

        <section class="ov-det-section">
          <h3 class="ov-det-section-title">Detection tuning</h3>
          ${renderPersonTuning()}
        </section>

        <section class="ov-det-section">
          <h3 class="ov-det-section-title">Alerts</h3>
          <div class="ov-det-alerts-grid">${renderAlerts()}</div>
        </section>

        <section class="ov-det-section">
          <div class="ov-det-section-head-row">
            <h3 class="ov-det-section-title">Restricted zones</h3>
            <button type="button" class="ov-quick-btn" id="detAddZoneBtn">Add zone</button>
          </div>
          <p class="ov-det-section-sub">Used for “Person in restricted area” alerts</p>
          <div class="ov-det-zones-list" id="detZonesList">${renderZones()}</div>
        </section>

        <section class="ov-det-section ${logsOn ? '' : 'is-hidden'}" id="detCountLogsSection">
          <h3 class="ov-det-section-title">People count logs</h3>
          ${renderLogs()}
        </section>
      </div>
      <div class="ov-merged-accent" aria-hidden="true"></div>
    </article>`;
}

function eventImageUrl(event) {
  const base = event.imageUrl || `/api/detection/events/${encodeURIComponent(event.id)}/snapshot`;
  const sid = sessionStorage.getItem('atomoSessionId');
  const sep = base.includes('?') ? '&' : '?';
  const auth = sid ? `${sep}sessionId=${encodeURIComponent(sid)}` : '';
  const bust = `${auth}${auth ? '&' : '?'}t=${encodeURIComponent(event.time || Date.now())}`;
  return `${base}${bust}`;
}

function eventSearchText(event) {
  return [
    event.title,
    event.eventType,
    event.label,
    event.camera,
    event.location,
    event.zone,
    event.severity,
    event.timeLabel,
    event.dateLabel,
    String(Math.round((event.confidence || 0) * 100)),
    event.id,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getFilteredEvents() {
  const events = payload?.events || [];
  const q = eventSearchQuery.trim().toLowerCase();
  if (!q) return events;
  return events.filter((e) => eventSearchText(e).includes(q));
}

function updateEventCountLabel() {
  const total = payload?.events?.length || 0;
  const shown = getFilteredEvents().length;
  const sub = document.getElementById('detEventCountLabel');
  if (!sub) return;

  if (eventSearchQuery.trim()) {
    sub.textContent = `${shown} of ${total} event${total === 1 ? '' : 's'} shown`;
    return;
  }

  sub.textContent = total
    ? `${total} recent detection event${total === 1 ? '' : 's'}`
    : 'No detection events yet';
}

function renderEventCard(e) {
  const bboxAttr = e.bbox && e.bbox.length >= 4
    ? ` data-bbox="${esc(JSON.stringify(e.bbox))}"`
    : '';
  const cropClass = e.bbox && e.bbox.length >= 4 ? ' has-bbox-crop' : '';
  return `
      <article class="ov-det-event-card" role="listitem" data-event-id="${esc(e.id)}" tabindex="0">
        <button type="button" class="ov-det-event-thumb-btn" data-action="open-event" data-event-id="${esc(e.id)}" aria-label="View detection: ${esc(e.title)}">
          <div class="ov-det-event-thumb">
            <img
              src="${eventImageUrl(e)}"
              alt="Detection snapshot: ${esc(e.title)}"
              class="ov-det-event-img${cropClass}"
              ${bboxAttr}
              loading="lazy"
              decoding="async"
            >
            <div class="ov-det-event-thumb-overlay">
              <span class="ov-badge ${severityBadge(e.severity)}">${esc(e.severity)}</span>
              <span class="ov-det-event-conf ov-mono">${Math.round(e.confidence * 100)}%</span>
            </div>
            <span class="ov-det-event-time-badge ov-mono">${esc(e.timeLabel)}</span>
          </div>
        </button>
        <div class="ov-det-event-details">
          <h4 class="ov-det-event-title">${esc(e.eventType || e.title)}</h4>
          <dl class="ov-det-event-meta">
            <div class="ov-det-event-meta-row">
              <dt>Type</dt>
              <dd>${esc(e.label || 'person')}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Camera</dt>
              <dd>${esc(e.camera)}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Track ID</dt>
              <dd>${e.trackingId != null ? esc(`#${e.trackingId}`) : '—'}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Location</dt>
              <dd>${esc(e.location || '—')}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Zone</dt>
              <dd>${esc(e.zone || '—')}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Captured</dt>
              <dd>${esc(e.dateLabel || '')} · ${esc(e.timeLabel)}</dd>
            </div>
          </dl>
        </div>
      </article>`;
}

function renderEventCards(events) {
  if (!events.length) {
    const q = eventSearchQuery.trim();
    return q
      ? `<p class="ov-det-empty">No events match “${esc(q)}”.</p>`
      : '<p class="ov-det-empty">No detection events yet.</p>';
  }

  return `
    <div class="ov-det-gallery" role="list">
      ${events.map((e) => renderEventCard(e)).join('')}
    </div>`;
}

function renderEventsLightbox() {
  return `
    <div class="ov-det-event-lightbox" id="detEventLightbox" hidden>
      <div class="ov-det-event-lightbox-backdrop" data-action="close-event"></div>
      <div class="ov-det-event-lightbox-dialog" role="dialog" aria-modal="true" aria-labelledby="detEventLightboxTitle">
        <button type="button" class="ov-modal-close ov-det-event-lightbox-close" data-action="close-event" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
        <div class="ov-det-event-lightbox-media" id="detEventLightboxMedia"></div>
        <div class="ov-det-event-lightbox-info" id="detEventLightboxInfo"></div>
      </div>
    </div>`;
}

function renderEventsSearchBar() {
  return `
    <label class="ov-det-events-search" for="detEventSearch">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input
        type="search"
        id="detEventSearch"
        placeholder="Search events, camera, zone…"
        value="${esc(eventSearchQuery)}"
        aria-label="Search detection events"
        autocomplete="off"
      >
    </label>`;
}

function refreshEventsGallery(force = false) {
  const host = document.getElementById('detEventsGalleryHost');
  if (!host) return;
  const events = getFilteredEvents();
  const fp = eventsFingerprint(events);
  if (!force && fp === lastEventsFingerprint) return;
  lastEventsFingerprint = fp;
  host.innerHTML = renderEventCards(events);
  updateEventCountLabel();
  wireGalleryEvents();
}

function renderEventsGallery() {
  return `${renderEventCards(getFilteredEvents())}${renderEventsLightbox()}`;
}

function openEventLightbox(eventId) {
  const event = (payload?.events || []).find((e) => e.id === eventId);
  const box = document.getElementById('detEventLightbox');
  if (!event || !box) return;

  const media = document.getElementById('detEventLightboxMedia');
  const info = document.getElementById('detEventLightboxInfo');
  if (media) {
    media.innerHTML = `<img src="${eventImageUrl(event)}" alt="Detection snapshot: ${esc(event.title)}" class="ov-det-event-lightbox-img${event.bbox ? ' has-bbox-crop' : ''}"${event.bbox ? ` data-bbox="${esc(JSON.stringify(event.bbox))}"` : ''}>`;
    applyCropToEventImages(media);
  }
  if (info) {
    info.innerHTML = `
      <h3 id="detEventLightboxTitle" class="ov-det-event-lightbox-title">${esc(event.title)}</h3>
      <div class="ov-det-event-lightbox-badges">
        <span class="ov-badge ${severityBadge(event.severity)}">${esc(event.severity)}</span>
        <span class="ov-badge ov-badge-gold ov-mono">${Math.round(event.confidence * 100)}% confidence</span>
      </div>
      <dl class="ov-det-event-meta ov-det-event-meta-lightbox">
        <div class="ov-det-event-meta-row"><dt>Camera</dt><dd>${esc(event.camera)}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Location</dt><dd>${esc(event.location || '—')}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Zone</dt><dd>${esc(event.zone || '—')}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Captured</dt><dd>${esc(event.dateLabel || '')} · ${esc(event.timeLabel)}</dd></div>
      </dl>`;
  }

  box.hidden = false;
  box.classList.add('is-open');
  document.body.classList.add('ov-modal-open');
}

function closeEventLightbox() {
  const box = document.getElementById('detEventLightbox');
  if (!box) return;
  box.hidden = true;
  box.classList.remove('is-open');
  document.body.classList.remove('ov-modal-open');
}

function renderEventsTable() {
  return renderEventsGallery();
}

function renderLogs() {
  const logs = payload?.logs || [];
  return `<div class="ov-det-logs">${logs.map((line) => `<div class="ov-det-log-line">${esc(line)}</div>`).join('')}</div>`;
}

function renderPreview() {
  const cams = payload?.assignedCameras || [];
  const selected = cams.find((c) => c.id === previewCameraId) || cams[0] || null;
  if (!selected) {
    return `
      <div class="ov-det-preview ov-det-preview-empty">
        <div class="ov-det-preview-placeholder">Assign a camera to view live preview</div>
      </div>`;
  }
  previewCameraId = selected.id;
  return `
    <div class="ov-det-preview">
      <div class="ov-det-preview-frame">
        <div class="ov-det-preview-sim" aria-hidden="true"></div>
        <div class="ov-det-preview-overlay">
          <span class="ov-badge ov-badge-success">LIVE</span>
          <span>${esc(selected.name)}</span>
        </div>
      </div>
      <div class="ov-det-preview-meta">
        <span>${esc(selected.resolution || '—')} · ${selected.fpsLimit || '—'} fps</span>
        <a href="${sessionUrl(`/cameras/${encodeURIComponent(selected.id)}`)}" class="ov-det-preview-link">Open full view</a>
      </div>
    </div>`;
}

function renderReports() {
  const r = payload?.report || {};
  return `
    <div class="ov-det-report-grid">
      <div class="ov-det-report-card">
        <div class="ov-det-report-val">${r.eventsToday ?? 0}</div>
        <div class="ov-det-report-label">Events today</div>
      </div>
      <div class="ov-det-report-card">
        <div class="ov-det-report-val">${r.avgConfidence ?? 0}%</div>
        <div class="ov-det-report-label">Avg confidence</div>
      </div>
      <div class="ov-det-report-card">
        <div class="ov-det-report-val">${r.activeCameras ?? 0}</div>
        <div class="ov-det-report-label">Active cameras</div>
      </div>
      <div class="ov-det-report-card">
        <div class="ov-det-report-val ov-det-report-sm">${esc(r.inferenceUptime || '—')}</div>
        <div class="ov-det-report-label">Inference uptime</div>
      </div>
    </div>`;
}

function renderEventsCard() {
  const events = payload?.events || [];
  const eventCountLabel = events.length
    ? `${events.length} recent detection event${events.length === 1 ? '' : 's'}`
    : 'No detection events yet';

  return `
    <article class="ov-card ov-det-events">
      <div class="ov-det-events-inner">
        <div class="ov-merged-head ov-det-events-head">
          <div class="ov-det-events-head-text">
            <div class="ov-stat-headline ov-det-events-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/></svg>
              <span>Events</span>
            </div>
            <div class="ov-merged-sub" id="detEventCountLabel">${eventCountLabel}</div>
          </div>
          ${renderEventsSearchBar()}
        </div>

        <div class="ov-merged-divider" aria-hidden="true"></div>

        <div class="ov-det-events-body" id="detEvents">
          <div id="detEventsGalleryHost">${renderEventCards(getFilteredEvents())}</div>
          ${renderEventsLightbox()}
        </div>
      </div>
      <div class="ov-merged-accent" aria-hidden="true"></div>
    </article>`;
}

function renderModelCard() {
  const root = document.getElementById('modelControl');
  if (!root || !payload) return;

  root.innerHTML = renderEventsCard();

  if (!isLiveTab) wireModelEvents();
  wireGalleryEvents();
  updateEventCountLabel();
}

function refreshPersonLiveSections() {
  if (!payload || !isLiveTab) return;
  const demo = payload.demoMode === true || document.body.classList.contains('demo-mode');
  const m = isFaceTab ? (payload.faceMetrics || {}) : (payload.peopleMetrics || {});
  const r = payload.report || {};
  const running = payload.state?.inferenceRunning;

  const vals = document.querySelectorAll('.ov-det-metrics-strip .ov-det-metric-val');
  const current = demo && (m.current == null || m.current < 3) ? 3 : (m.current ?? 0);
  const peak = demo && (r.peakPeopleToday == null && (m.peakToday == null || m.peakToday < 5))
    ? 5
    : (r.peakPeopleToday ?? m.peakToday ?? 0);
  if (vals[0]) vals[0].textContent = String(current);
  if (vals[1]) vals[1].textContent = String(peak);
  if (vals[2]) vals[2].textContent = String(r.eventsToday ?? 0);
  if (vals[3]) vals[3].textContent = isFaceTab
    ? (m.recognitionActive ? 'Active' : 'None')
    : (m.presenceActive ? 'Active' : 'None');

  const statusWrap = document.querySelector('.ov-det-model-status-wrap');
  if (statusWrap) {
    const badge = statusWrap.querySelector('.ov-badge');
    const btn = document.getElementById('detInferenceBtn');
    if (badge) {
      badge.className = `ov-badge ${running ? 'ov-badge-success' : 'ov-badge-error'}`;
      badge.textContent = running ? 'Running' : 'Stopped';
    }
    if (btn) {
      btn.textContent = running ? 'Stop inference' : 'Start inference';
      btn.classList.toggle('ov-det-stop-btn', Boolean(running));
    }
  }

  const logsSection = document.getElementById('detCountLogsSection');
  if (logsSection && !logsSection.classList.contains('is-hidden')) {
    const logsHost = logsSection.querySelector('.ov-det-logs');
    if (logsHost) logsHost.innerHTML = (payload.logs || []).map((line) => `<div class="ov-det-log-line">${esc(line)}</div>`).join('');
  }

  refreshEventsGallery();
}

function cropEventImageToBbox(img, bbox) {
  if (!bbox || bbox.length < 4 || !img.naturalWidth) return;
  const [x1, y1, x2, y2] = bbox;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const pad = 0.08;
  const bw = (x2 - x1) * W;
  const bh = (y2 - y1) * H;
  const px1 = Math.max(0, x1 * W - bw * pad);
  const py1 = Math.max(0, y1 * H - bh * pad);
  const px2 = Math.min(W, x2 * W + bw * pad);
  const py2 = Math.min(H, y2 * H + bh * pad);
  const pw = Math.max(1, px2 - px1);
  const ph = Math.max(1, py2 - py1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pw);
  canvas.height = Math.round(ph);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, px1, py1, pw, ph, 0, 0, canvas.width, canvas.height);
  try {
    img.src = canvas.toDataURL('image/jpeg', 0.92);
    img.classList.remove('has-bbox-crop');
    img.removeAttribute('data-bbox');
  } catch {
    /* cross-origin or tainted canvas */
  }
}

function applyCropToEventImages(root) {
  const scope = root || document;
  scope.querySelectorAll('.ov-det-event-img.has-bbox-crop').forEach((img) => {
    if (img.dataset.cropApplied === 'true') return;
    let bbox = null;
    try {
      bbox = JSON.parse(img.dataset.bbox || 'null');
    } catch {
      bbox = null;
    }
    if (!bbox || bbox.length < 4) return;

    const run = () => {
      if (img.dataset.cropApplied === 'true' || !img.naturalWidth) return;
      img.dataset.cropApplied = 'true';
      cropEventImageToBbox(img, bbox);
    };

    if (img.complete) run();
    else img.addEventListener('load', run, { once: true });
  });
}

function wireGalleryEvents() {
  const search = document.getElementById('detEventSearch');
  if (search && search.dataset.bound !== 'true') {
    search.dataset.bound = 'true';
    search.addEventListener('input', () => {
      eventSearchQuery = search.value;
      refreshEventsGallery();
    });
    search.addEventListener('search', () => {
      eventSearchQuery = search.value;
      refreshEventsGallery();
    });
  }
  document.querySelectorAll('[data-action="open-event"]').forEach((btn) => {
    btn.addEventListener('click', () => openEventLightbox(btn.dataset.eventId));
  });

  document.querySelectorAll('.ov-det-event-card').forEach((card) => {
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEventLightbox(card.dataset.eventId);
      }
    });
  });

  document.querySelectorAll('[data-action="close-event"]').forEach((el) => {
    el.addEventListener('click', closeEventLightbox);
  });

  if (!document.body.dataset.detLightboxBound) {
    document.body.dataset.detLightboxBound = 'true';
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeEventLightbox();
    });
  }

  applyCropToEventImages();
}

/*
  Person tab: full model controls. Other tabs: events only.
*/

function collectFeatures() {
  const features = { ...(payload?.state?.features || {}) };
  document.querySelectorAll('[data-feature-id]').forEach((el) => {
    if (el.disabled) return;
    features[el.dataset.featureId] = el.checked;
  });
  return features;
}

async function toggleInference() {
  const running = !payload?.state?.inferenceRunning;
  try {
    const res = await fetch(sessionUrl(`/api/detection/${slug}/inference`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: running ? 'start' : 'stop' }),
    });
    if (!res.ok) throw new Error();
    payload = await res.json();
    showToast(running ? 'Inference started' : 'Inference stopped');
    renderModelCard();
  } catch {
    showToast('Could not update inference');
  }
}

function schedulePersonSave(patch) {
  clearTimeout(personSaveTimer);
  personSaveTimer = setTimeout(() => saveSettings(patch, true), 350);
}

function syncPersonTuningUi() {
  const filterOn = Boolean(document.querySelector('[data-feature-id="filterSmallObjects"]')?.checked);
  const card = document.getElementById('detMinSizeCard');
  const range = document.getElementById('detMinSizeRange');
  if (card) card.classList.toggle('is-disabled', !filterOn);
  if (range) range.disabled = !filterOn;

  const tooManyOn = Boolean(document.querySelector('[data-alert-id="too-many-people"]')?.checked);
  document.getElementById('detMaxPeopleRow')?.classList.toggle('is-hidden', !tooManyOn);

  const logsOn = Boolean(document.querySelector('[data-feature-id="peopleCountLogs"]')?.checked);
  document.getElementById('detCountLogsSection')?.classList.toggle('is-hidden', !logsOn);
}

function wirePersonControls() {
  document.getElementById('detInferenceBtn')?.addEventListener('click', toggleInference);

  document.querySelectorAll('[data-feature-id]').forEach((el) => {
    el.addEventListener('change', () => {
      syncPersonTuningUi();
      saveSettings({ features: collectFeatures() }, true);
    });
  });

  document.querySelectorAll('[data-alert-id]').forEach((el) => {
    el.addEventListener('change', () => {
      syncPersonTuningUi();
      saveSettings({ alerts: collectAlerts() }, true);
    });
  });

  const confRange = document.getElementById('detConfRange');
  if (confRange) {
    confRange.addEventListener('input', () => {
      const pct = Number(confRange.value);
      const val = document.getElementById('detConfVal');
      const hint = document.getElementById('detConfHint');
      if (val) val.textContent = `${pct}%`;
      if (hint) hint.textContent = confidenceHint(pct);
    });
    confRange.addEventListener('change', () => {
      schedulePersonSave({ confidence: Number(confRange.value) / 100 });
    });
  }

  const minRange = document.getElementById('detMinSizeRange');
  if (minRange) {
    minRange.addEventListener('input', () => {
      const val = document.getElementById('detMinSizeVal');
      if (val) val.textContent = `${minRange.value}px`;
    });
    minRange.addEventListener('change', () => {
      schedulePersonSave({ minObjectSizePx: Number(minRange.value) });
    });
  }

  document.getElementById('detMaxPeople')?.addEventListener('change', (e) => {
    schedulePersonSave({ maxPeopleAlert: Number(e.target.value) });
  });

  document.getElementById('detAddZoneBtn')?.addEventListener('click', () => {
    const zones = collectZones();
    zones.push({ id: `zone-${Date.now()}`, name: `Zone ${zones.length + 1}`, enabled: true });
    saveSettings({ zones }, true);
  });

  document.querySelectorAll('[data-action="remove-zone"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      const zones = collectZones().filter((_, i) => i !== idx);
      saveSettings({ zones }, true);
    });
  });

  document.querySelectorAll('[data-zone-name], [data-zone-enabled]').forEach((el) => {
    el.addEventListener('change', () => schedulePersonSave({ zones: collectZones() }));
  });

  syncPersonTuningUi();
}

async function saveSettings(patch, silent = false) {
  try {
    await apiPatch(patch);
    if (!silent) showToast('Settings saved');
    renderModelCard();
  } catch {
    showToast('Could not save settings');
  }
}

function collectZones() {
  return Array.from(document.querySelectorAll('.ov-det-zone-row'))
    .map((row, i) => ({
      id: payload.state.zones[i]?.id || `zone-${i + 1}`,
      name: row.querySelector('[data-zone-name]')?.value || `Zone ${i + 1}`,
      enabled: Boolean(row.querySelector('[data-zone-enabled]')?.checked),
    }))
    .filter((z) => z.name.trim());
}

function collectAlerts() {
  const alerts = {};
  document.querySelectorAll('[data-alert-id]').forEach((el) => {
    alerts[el.dataset.alertId] = el.checked;
  });
  return alerts;
}

function wireModelEvents() {
  /* person controls wired in wirePersonControls */
}

async function apiPatch(body) {
  const res = await fetch(sessionUrl(`/api/detection/${slug}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Save failed');
  payload = await res.json();
}

async function loadDetectionTab() {
  if (!slug) return;
  try {
    const res = await fetch(sessionUrl(`/api/detection/${slug}`));
    if (!res.ok) {
      window.location.href = '/overview';
      return;
    }
    payload = await res.json();
    lastEventsFingerprint = eventsFingerprint(payload?.events || []);
    document.title = `${payload.tab.pageTitle} — Atomo Forge`;
    const title = document.getElementById('detectionPageTitle');
    const crumb = document.getElementById('detectionBreadcrumb');
    if (title) title.textContent = payload.tab.pageTitle;
    if (crumb) crumb.textContent = `AI detection · ${payload.tab.title}`;
    if (isLiveTab && window.PersonLive?.initFromPayload) {
      await window.PersonLive.initFromPayload(payload);
    }
    renderModelCard();
  } catch {
    showToast('Failed to load detection tab');
  }
}

function prependEvents(newEvents, nextPayload) {
  if (!newEvents?.length) return;
  if (nextPayload) {
    payload = nextPayload;
  } else if (payload) {
    const existing = new Set((payload.events || []).map((e) => e.id));
    const merged = [...newEvents.filter((e) => !existing.has(e.id)), ...(payload.events || [])].slice(0, 50);
    payload = { ...payload, events: merged };
  }
  lastEventsFingerprint = eventsFingerprint(payload?.events || []);

  const host = document.getElementById('detEventsGalleryHost');
  if (!host) return;
  const q = eventSearchQuery.trim().toLowerCase();
  const toPrepend = q
    ? newEvents.filter((e) => eventSearchText(e).includes(q))
    : newEvents;
  if (!toPrepend.length) {
    updateEventCountLabel();
    return;
  }
  let gallery = host.querySelector('.ov-det-gallery');
  if (!gallery) {
    host.innerHTML = '<div class="ov-det-gallery" role="list"></div>';
    gallery = host.querySelector('.ov-det-gallery');
  }
  host.querySelector('.ov-det-empty')?.remove();
  gallery.insertAdjacentHTML('afterbegin', toPrepend.map((e) => renderEventCard(e)).join(''));
  while (gallery.children.length > 50) {
    gallery.lastElementChild?.remove();
  }
  updateEventCountLabel();
  wireGalleryEvents();
}

function refreshEventsOnly(nextPayload) {
  if (!nextPayload) return;
  const nextEvents = nextPayload.events || [];
  const fp = eventsFingerprint(nextEvents);
  if (fp !== lastEventsFingerprint) {
    payload = nextPayload;
    refreshEventsGallery(true);
    return;
  }
  payload = { ...payload, ...nextPayload, events: payload?.events || nextEvents };
  applyLiveMetricsFromPayload(nextPayload);
}

function connectDashEventWs() {
  if (!isLiveTab || dashEventWs) return;
  try {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sid = sessionStorage.getItem('atomoSessionId');
    const q = sid ? `?slug=${encodeURIComponent(slug)}&sessionId=${encodeURIComponent(sid)}` : `?slug=${encodeURIComponent(slug)}`;
    dashEventWs = new WebSocket(`${proto}//${window.location.host}/ws/detection${q}`);
    dashEventWs.onopen = () => {
      dashWsConnected = true;
    };
    dashEventWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'metrics_update') {
          applyLiveMetricsFromPayload(msg.metrics || msg.payload);
          return;
        }
        if (msg.type !== 'detection_update' && msg.type !== 'person_update') return;
        if (msg.newEvents?.length) {
          prependEvents(msg.newEvents, msg.payload || payload);
        } else if (msg.payload) {
          refreshEventsOnly(msg.payload);
        } else if (msg.metrics) {
          applyLiveMetricsFromPayload(msg.metrics);
        }
      } catch {
        /* ignore */
      }
    };
    dashEventWs.onclose = () => {
      dashEventWs = null;
      dashWsConnected = false;
      setTimeout(connectDashEventWs, 3000);
    };
  } catch {
    /* ws unavailable */
  }
}

window.DetectionTab = {
  reload: loadDetectionTab,
  refreshEventsOnly,
  prependEvents,
  syncLivePayload(nextPayload) {
    if (!nextPayload) return;
    const currentIds = new Set((payload?.events || []).map((e) => e.id));
    const incoming = nextPayload.events || [];
    const fresh = incoming.filter((e) => !currentIds.has(e.id));
    if (fresh.length) {
      prependEvents(fresh, { ...payload, ...nextPayload, events: [...fresh, ...(payload?.events || [])].slice(0, 50) });
      return;
    }
    refreshEventsOnly(nextPayload);
  },
};

function startRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  connectDashEventWs();
  refreshTimer = setInterval(async () => {
    if (!slug || document.hidden) return;
    if (isLiveTab && dashWsConnected) return;
    try {
      const res = await fetch(sessionUrl(`/api/detection/${slug}`));
      if (!res.ok) return;
      const next = await res.json();
      payload = next;
      const search = document.getElementById('detEventSearch');
      if (search) eventSearchQuery = search.value;
      if (!isLiveTab || !document.getElementById('personWorkbench')) {
        refreshEventsGallery();
      } else if (window.PersonLive?.refresh) {
        window.PersonLive.refresh();
      }
    } catch {
      /* ignore */
    }
  }, isLiveTab ? 30000 : 8000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    loadDetectionTab();
    startRefresh();
  });
} else {
  loadDetectionTab();
  startRefresh();
}
