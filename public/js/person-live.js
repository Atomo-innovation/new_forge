  /**
   * Person tab — in-page live stream + detection controls (above stream).
   */
  (function () {
    const slug = document.body.dataset.detectionSlug;
    if (slug !== 'person') return;

    let selectedCameraId = null;
    let payload = null;
    let frameData = null;
    let pollTimer = null;
    let simAnimTimer = null;
    let configSaveTimer = null;
    let inferenceRunning = false;
    let hlsPlayer = null;
    let whepPlayer = null;
    let detWs = null;
    let usingHlsStream = false;
    let usingWhepStream = false;
    let hlsStreamFailed = false;
    let streamResyncTimer = null;
    let streamResyncAttempts = 0;
    let lastFrameTs = 0;
    let streamLocked = false;
    let streamInitialized = false;
    let currentConfidence = 0.32;
    let pendingJpeg = null;
    let jpegDrawScheduled = false;

    const STREAM_TIMEOUT_MS = 10000;
    const WHEP_DETECTION_DELAY_MS = 300;
    const HLS_DETECTION_DELAY_MS = 2000;
    let detectionQueue = [];
    let detectionDelayTimer = null;
    let savedWhepPc = null;
    let savedHlsPlayer = null;

    function sessionUrl(path) {
      const sid = sessionStorage.getItem('atomoSessionId');
      return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
    }

    function esc(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showToast(msg) {
      const el = document.getElementById('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2600);
    }

    function confidenceHint(pct) {
      if (pct < 50) return 'Sensitive';
      if (pct < 75) return 'Balanced';
      return 'Strict';
    }

    function getRoot() {
      return document.getElementById('personLiveRoot');
    }

    function renderFeatureChips() {
      const options = payload?.tab?.featureOptions || [];
      const features = payload?.state?.features || {};
      return options
        .filter((o) => o.id !== 'detectPeople')
        .map(
          (opt) => `
        <label class="ov-plive-chip ${opt.locked ? 'is-locked' : ''}" title="${esc(opt.description)}">
          <input type="checkbox" data-feature-id="${opt.id}" ${features[opt.id] ? 'checked' : ''} ${opt.locked ? 'checked disabled' : ''}>
          <span>${esc(opt.label)}</span>
        </label>`
        )
        .join('');
    }

    function renderAlertChips() {
      const options = payload?.tab?.alertOptions || [];
      const alerts = payload?.state?.alerts || {};
      return options
        .map(
          (opt) => `
        <label class="ov-plive-alert-chip">
          <input type="checkbox" data-alert-id="${opt.id}" ${alerts[opt.id] ? 'checked' : ''}>
          <span>${esc(opt.label)}</span>
        </label>`
        )
        .join('');
    }

    function renderEmptyState() {
      return `
        <article class="ov-card ov-plive-empty">
          <div class="ov-plive-empty-inner">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
            <h2>Select a camera</h2>
            <p>Click <strong>North Gate</strong> or any camera above to open the live person detection view here.</p>
          </div>
        </article>`;
    }

    function ensureLoadingStyle() {
      if (document.getElementById('plive-spin-style')) return;
      const s = document.createElement('style');
      s.id = 'plive-spin-style';
      s.textContent = '@keyframes plive-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }

    function renderLoadingState(cameraName) {
      return `
        <article class="ov-card ov-plive-workbench" id="personWorkbench">
          <div class="ov-plive-inner">
            <div class="ov-plive-stream-wrap">
              <div class="ov-plive-stream" id="pliveStreamHost" style="background:#0f172a;min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;">
                <div style="width:48px;height:48px;border:3px solid #334155;border-top-color:#22c55e;border-radius:50%;animation:plive-spin 0.8s linear infinite;"></div>
                <div style="color:#94a3b8;font-size:14px;font-family:Inter,sans-serif;">Connecting to ${esc(cameraName || 'camera')}…</div>
                <div id="pliveLoadingStatus" style="color:#64748b;font-size:12px;font-family:Inter,sans-serif;">Registering stream</div>
              </div>
            </div>
          </div>
        </article>`;
    }

    function setLoadingStatus(msg) {
      const el = document.getElementById('pliveLoadingStatus');
      if (el) el.textContent = msg;
    }

    async function fetchLiveWithTimeout(cameraId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
      try {
        const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(cameraId)}/live`), {
          signal: controller.signal,
        });
        clearTimeout(timer);
        return res.ok ? res.json() : null;
      } catch {
        clearTimeout(timer);
        return null;
      }
    }

    function renderWorkbench() {
      if (!selectedCameraId || !payload) return renderEmptyState();

      const cam = frameData?.camera || payload.assignedCameras?.find((c) => c.id === selectedCameraId)
        || { name: 'Camera', status: 'online' };
      const state = payload.state || {};
      const m = frameData?.metrics || payload.peopleMetrics || {};
      const pct = Math.round((state.confidence ?? 0.7) * 100);
      const filterOn = Boolean(state.features?.filterSmallObjects);
      const tooManyOn = Boolean(state.alerts?.['too-many-people']);
      const streamMode = frameData?.streamMode || state.streamMode || 'preview';
      const backendConnected = Boolean(frameData?.backendConnected);
      const running = inferenceRunning || state.inferenceRunning;

      const modeLabel = running
        ? backendConnected
          ? (frameData?.workerSource === 'npu' ? 'Live AI (NPU)' : frameData?.workerSource === 'local-cpu' ? 'Live AI (CPU)' : 'Live AI')
          : 'Worker offline'
        : 'Preview';

      return `
        <article class="ov-card ov-plive-workbench" id="personWorkbench">
          <div class="ov-plive-inner">
            <div class="ov-plive-head">
              <div>
                <div class="ov-stat-headline ov-plive-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
                  <span>${esc(cam.name)}</span>
                </div>
                <p class="ov-plive-sub">${esc(cam.location || 'No location')} · ${esc(cam.resolution || '—')}</p>
              </div>
              <div class="ov-plive-head-actions">
                <span class="ov-badge ${cam.status === 'online' ? 'ov-badge-success' : 'ov-badge-error'}">${cam.status === 'online' ? 'Online' : 'Offline'}</span>
                <span class="ov-badge ov-badge-gold" id="pliveModeBadge">${modeLabel}</span>
                <button type="button" class="ov-quick-btn ${running ? 'ov-det-stop-btn' : ''}" id="pliveInferenceBtn">
                  ${running ? 'Stop detection' : 'Start detection'}
                </button>
              </div>
            </div>

            <div class="ov-plive-stats" id="pliveStats">
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="current">${m.current ?? 0}</span><span class="ov-plive-stat-lbl">People</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="peak">${m.peakToday ?? 0}</span><span class="ov-plive-stat-lbl">Peak</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="fps">${m.fps != null ? Number(m.fps).toFixed(1) : '—'}</span><span class="ov-plive-stat-lbl">FPS</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="inf">${m.inferenceMs != null ? Math.round(m.inferenceMs) + 'ms' : '—'}</span><span class="ov-plive-stat-lbl">Inference</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val ov-plive-stat-sm" data-m="presence">${m.presenceActive ? 'Active' : 'None'}</span><span class="ov-plive-stat-lbl">Presence</span></div>
            </div>

            <div class="ov-plive-toolbar">
              <div class="ov-plive-toolbar-row">
                <span class="ov-plive-toolbar-label">Features</span>
                <div class="ov-plive-chips">${renderFeatureChips()}</div>
              </div>
              <div class="ov-plive-toolbar-row ov-plive-conf-row">
                <span class="ov-plive-toolbar-label">Confidence</span>
                <input type="range" class="ov-det-range ov-plive-conf-range" id="pliveConfRange" min="25" max="95" step="1" value="${pct}" aria-label="Minimum confidence">
                <span class="ov-det-slider-val" id="pliveConfVal">${pct}%</span>
                <span class="ov-plive-conf-hint" id="pliveConfHint">${confidenceHint(pct)}</span>
              </div>
              <div class="ov-plive-toolbar-row ${filterOn ? '' : 'is-hidden'}" id="pliveMinSizeRow">
                <span class="ov-plive-toolbar-label">Min size</span>
                <input type="range" class="ov-det-range" id="pliveMinSizeRange" min="16" max="160" step="4" value="${state.minObjectSizePx ?? 48}">
                <span class="ov-det-slider-val" id="pliveMinSizeVal">${state.minObjectSizePx ?? 48}px</span>
              </div>
              <div class="ov-plive-toolbar-row">
                <span class="ov-plive-toolbar-label">Alerts</span>
                <div class="ov-plive-alert-chips">${renderAlertChips()}</div>
              </div>
              <div class="ov-plive-toolbar-row ${tooManyOn ? '' : 'is-hidden'}" id="pliveMaxPeopleRow">
                <span class="ov-plive-toolbar-label">Max people</span>
                <input type="number" class="ov-det-input ov-det-max-people-input" id="pliveMaxPeople" min="1" max="99" value="${state.maxPeopleAlert ?? 10}">
              </div>
            </div>

            <div class="ov-plive-stream-wrap">
              <div class="ov-plive-stream" id="pliveStreamHost">
                <canvas class="ov-plive-canvas" id="pliveCanvas" aria-label="Live camera stream"></canvas>
                <canvas class="ov-plive-overlay" id="pliveOverlay" aria-hidden="true"></canvas>
                <div class="ov-plive-stream-badge" id="pliveStreamBadge">${running ? 'DETECTING' : 'LIVE PREVIEW'}</div>
                <div class="ov-plive-stream-meta" id="pliveStreamMeta"></div>
              </div>
            </div>

            <p class="ov-plive-backend-note" id="pliveBackendNote"></p>
          </div>
          <div class="ov-merged-accent" aria-hidden="true"></div>
        </article>`;
    }

    function mount(skipStreamInit) {
      const root = getRoot();
      if (!root) return;

      let savedMediaStream = null;
      if (skipStreamInit && streamInitialized) {
        const oldVideo = root.querySelector('video.ov-plive-media');
        if (oldVideo?.srcObject) {
          savedMediaStream = oldVideo.srcObject;
          savedWhepPc = whepPlayer?.pc || null;
          whepPlayer = null;
        } else if (usingHlsStream && hlsPlayer) {
          savedHlsPlayer = hlsPlayer;
          hlsPlayer = null;
        }
      }

      root.hidden = false;
      root.innerHTML = renderWorkbench();
      wireControls();
      currentConfidence = payload?.state?.confidence ?? currentConfidence;
      const confRange = document.getElementById('pliveConfRange');
      if (confRange) confRange.value = Math.round(currentConfidence * 100);

      if (skipStreamInit && streamInitialized && (savedMediaStream || savedHlsPlayer)) {
        reattachStream(savedMediaStream, savedWhepPc);
      } else if (!skipStreamInit || !streamInitialized) {
        initStreamDisplay();
      }
      startPolling();
    }

    function reattachStream(mediaStream, pc) {
      const host = document.getElementById('pliveStreamHost');
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      if (!host) {
        initStreamDisplay();
        return;
      }

      stopSimAnim();
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());

      const video = document.createElement('video');
      video.className = 'ov-plive-media';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      host.insertBefore(video, host.firstChild);

      if (mediaStream) {
        video.srcObject = mediaStream;
        video.play().catch(() => {});
        if (pc) {
          whepPlayer = {
            pc,
            video,
            close() {
              try { pc.close(); } catch { /* ignore */ }
              video.srcObject = null;
            },
          };
          usingWhepStream = true;
        }
      } else if (savedHlsPlayer) {
        hlsPlayer = savedHlsPlayer;
        savedHlsPlayer = null;
        hlsPlayer.attachMedia(video);
        usingHlsStream = true;
        video.play().catch(() => {});
      } else if (frameData?.preview) {
        initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
        return;
      } else {
        initStreamDisplay();
        return;
      }

      const meta = document.getElementById('pliveStreamMeta');
      if (meta && frameData?.preview?.label) meta.textContent = frameData.preview.label;
      video.addEventListener('loadeddata', drawBoxesOverlay);
      startOverlayLoop();
      drawBoxesOverlay();
    }

    function updateStatsOnly() {
      if (!frameData?.metrics) return;
      const m = frameData.metrics;
      const map = {
        current: m.current ?? 0,
        peak: m.peakToday ?? 0,
        fps: m.fps != null ? Number(m.fps).toFixed(1) : '—',
        inf: m.inferenceMs != null ? `${Math.round(m.inferenceMs)}ms` : '—',
        presence: m.presenceActive ? 'Active' : 'None',
      };
      Object.entries(map).forEach(([key, val]) => {
        const el = document.querySelector(`[data-m="${key}"]`);
        if (el) el.textContent = val;
      });
    }

    function collectFeatures() {
      const features = { ...(payload?.state?.features || {}), detectPeople: true };
      document.querySelectorAll('[data-feature-id]').forEach((el) => {
        if (el.disabled) return;
        features[el.dataset.featureId] = el.checked;
      });
      return features;
    }

    function collectAlerts() {
      const alerts = {};
      document.querySelectorAll('[data-alert-id]').forEach((el) => {
        alerts[el.dataset.alertId] = el.checked;
      });
      return alerts;
    }

    function scheduleConfigSave(patch) {
      clearTimeout(configSaveTimer);
      configSaveTimer = setTimeout(() => saveConfig(patch), 500);
    }

    function stopWhep() {
      if (whepPlayer) {
        whepPlayer.close();
        whepPlayer = null;
      }
      usingWhepStream = false;
      savedWhepPc = null;
    }

    function clearDetectionQueue() {
      detectionQueue = [];
      if (detectionDelayTimer) {
        clearTimeout(detectionDelayTimer);
        detectionDelayTimer = null;
      }
    }

    function getDetectionDelay() {
      if (usingWhepStream) return WHEP_DETECTION_DELAY_MS;
      if (usingHlsStream) return HLS_DETECTION_DELAY_MS;
      return 0;
    }

    function applyDetections(detections, ts) {
      if (ts < lastFrameTs) return;
      lastFrameTs = ts;
      frameData = {
        ...(frameData || {}),
        detections,
        metrics: {
          ...(frameData?.metrics || {}),
          current: detections.length,
          presenceActive: detections.length > 0,
        },
      };
      drawBoxesOverlay();
      updateStatsOnly();
    }

    function enqueueDetection(detections, ts) {
      const delay = getDetectionDelay();
      if (delay <= 0) {
        applyDetections(detections, ts);
        return;
      }
      detectionQueue.push({ detections, ts, applyAt: Date.now() + delay });
      scheduleDetectionFlush();
    }

    function scheduleDetectionFlush() {
      if (detectionDelayTimer) return;
      detectionDelayTimer = setTimeout(flushDetectionQueue, 50);
    }

    function flushDetectionQueue() {
      detectionDelayTimer = null;
      const now = Date.now();
      const ready = detectionQueue.filter((item) => item.applyAt <= now);
      detectionQueue = detectionQueue.filter((item) => item.applyAt > now);
      if (ready.length) {
        const latest = ready[ready.length - 1];
        applyDetections(latest.detections, latest.ts);
      }
      if (detectionQueue.length) scheduleDetectionFlush();
    }

    function stopHls() {
      if (hlsPlayer) {
        hlsPlayer.destroy();
        hlsPlayer = null;
      }
      savedHlsPlayer = null;
      usingHlsStream = false;
    }

    function disconnectDetectionWs() {
      if (detWs) {
        detWs.close();
        detWs = null;
      }
      clearDetectionQueue();
    }

    function connectDetectionWs(wsUrl) {
      if (!wsUrl || detWs) return;
      try {
        detWs = new WebSocket(wsUrl);
        detWs.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (!data || data.error || data.connected) return;
            if (Array.isArray(data.detections)) {
              const ts = data.ts || Date.now();
              enqueueDetection(data.detections, ts);
              frameData = {
                ...(frameData || {}),
                metrics: {
                  ...(frameData?.metrics || {}),
                  fps: data.fps ?? frameData?.metrics?.fps,
                  inferenceMs: data.inference_ms ?? frameData?.metrics?.inferenceMs,
                  peakToday: frameData?.metrics?.peakToday,
                },
              };
              updateStatsOnly();
            }
          } catch {
            /* ignore malformed ws payload */
          }
        };
        detWs.onclose = () => {
          detWs = null;
        };
      } catch {
        /* ws unavailable */
      }
    }

    async function saveConfig(patch) {
      if (!selectedCameraId) return;
      try {
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/config`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.payload) payload = data.payload;
      } catch {
        showToast('Could not save settings');
      }
    }

    function syncToolbarUi() {
      const filterOn = Boolean(document.querySelector('[data-feature-id="filterSmallObjects"]')?.checked);
      document.getElementById('pliveMinSizeRow')?.classList.toggle('is-hidden', !filterOn);
      const tooManyOn = Boolean(document.querySelector('[data-alert-id="too-many-people"]')?.checked);
      document.getElementById('pliveMaxPeopleRow')?.classList.toggle('is-hidden', !tooManyOn);
    }

    function wireControls() {
      document.getElementById('pliveInferenceBtn')?.addEventListener('click', toggleInference);

      document.querySelectorAll('[data-feature-id]').forEach((el) => {
        el.addEventListener('change', () => {
          syncToolbarUi();
          saveConfig({ features: collectFeatures() });
        });
      });

      document.querySelectorAll('[data-alert-id]').forEach((el) => {
        el.addEventListener('change', () => {
          syncToolbarUi();
          saveConfig({ alerts: collectAlerts() });
        });
      });

      const confRange = document.getElementById('pliveConfRange');
      if (confRange) {
        confRange.addEventListener('input', () => {
          const pct = Number(confRange.value);
          currentConfidence = pct / 100;
          const val = document.getElementById('pliveConfVal');
          const hint = document.getElementById('pliveConfHint');
          if (val) val.textContent = `${pct}%`;
          if (hint) hint.textContent = confidenceHint(pct);
          drawBoxesOverlay();
        });
        confRange.addEventListener('change', () => {
          scheduleConfigSave({ confidence: Number(confRange.value) / 100 });
        });
      }

      const minRange = document.getElementById('pliveMinSizeRange');
      if (minRange) {
        minRange.addEventListener('input', () => {
          const val = document.getElementById('pliveMinSizeVal');
          if (val) val.textContent = `${minRange.value}px`;
        });
        minRange.addEventListener('change', () => {
          scheduleConfigSave({ minObjectSizePx: Number(minRange.value) });
        });
      }

      document.getElementById('pliveMaxPeople')?.addEventListener('change', (e) => {
        scheduleConfigSave({ maxPeopleAlert: Number(e.target.value) });
      });

      syncToolbarUi();
    }

    async function toggleInference() {
      if (!selectedCameraId) return;
      const start = !inferenceRunning;
      const path = start ? 'start' : 'stop';
      try {
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/${path}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || data.backendError || 'Could not start detection');
        inferenceRunning = start;
        streamLocked = start;
        if (data.payload) payload = data.payload;
        if (data.backendError && start) showToast(data.backendError);
        else showToast(start ? 'Person detection started' : 'Detection stopped');
        updateInferenceUi(data);
        if (start && data.wsUrl) {
          connectDetectionWs(data.wsUrl);
        } else {
          disconnectDetectionWs();
        }
        if (start && (usingWhepStream || usingHlsStream)) {
          startOverlayLoop();
        }
        if (!start) streamLocked = false;
        startPolling();
        await pollFrame();
        if (start && window.DetectionTab?.reload) window.DetectionTab.reload();
      } catch (err) {
        showToast(err.message || 'Could not update detection');
      }
    }

    function updateInferenceUi(data) {
      const btn = document.getElementById('pliveInferenceBtn');
      const badge = document.getElementById('pliveStreamBadge');
      const mode = document.getElementById('pliveModeBadge');
      const note = document.getElementById('pliveBackendNote');
      if (btn) {
        btn.textContent = inferenceRunning ? 'Stop detection' : 'Start detection';
        btn.classList.toggle('ov-det-stop-btn', inferenceRunning);
      }
      if (badge) badge.textContent = inferenceRunning ? 'DETECTING' : 'LIVE PREVIEW';
      if (mode) {
        const npu = data?.workerSource === 'npu';
        const cpu = data?.workerSource === 'local-cpu';
        mode.textContent = inferenceRunning
          ? data?.backendConnected
            ? (npu ? 'Live AI (NPU)' : cpu ? 'Live AI (CPU)' : 'Live AI')
            : 'Worker offline'
          : 'Preview';
      }
      if (note) {
        if (data?.backendError) note.textContent = data.backendError;
        else if (data?.backendConnected) {
          if (data.workerSource === 'npu') {
            note.textContent = 'Khadas NPU person detection active (YOLO26s).';
          } else if (data.workerSource === 'local-cpu') {
            note.textContent = 'CPU dev fallback active. On Khadas use NPU backend only.';
          } else {
            note.textContent = 'Connected to vision backend — real-time person inference active.';
          }
        }
        else if (inferenceRunning) note.textContent = 'Worker not responding. Restart vision backend: cd Backend_Atomo_fordge && npm run restart';
        else note.textContent = '';
      }
    }

    let overlayAnimTimer = null;

    function startOverlayLoop() {
      if (overlayAnimTimer) return;
      const tick = () => {
        drawBoxesOverlay();
        overlayAnimTimer = requestAnimationFrame(tick);
      };
      overlayAnimTimer = requestAnimationFrame(tick);
    }

    function stopOverlayLoop() {
      if (overlayAnimTimer) cancelAnimationFrame(overlayAnimTimer);
      overlayAnimTimer = null;
    }

    function stopSimAnim() {
      stopOverlayLoop();
      if (simAnimTimer) cancelAnimationFrame(simAnimTimer);
      simAnimTimer = null;
    }

    function startSimAnim(label) {
      stopSimAnim();
      const canvas = document.getElementById('pliveCanvas');
      if (!canvas) return;
      const host = document.getElementById('pliveStreamHost');
      const ctx = canvas.getContext('2d');
      let frame = 0;

      function fit() {
        const w = host?.clientWidth || 960;
        const h = Math.round(w * 9 / 16);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          const overlay = document.getElementById('pliveOverlay');
          if (overlay) {
            overlay.width = w;
            overlay.height = h;
          }
        }
      }

      function draw() {
        fit();
        const w = canvas.width;
        const h = canvas.height;
        const t = frame * 0.02;
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, `hsl(${140 + Math.sin(t) * 20}, 28%, ${22 + Math.sin(t * 0.7) * 4}%)`);
        g.addColorStop(1, `hsl(${160 + Math.cos(t) * 15}, 22%, ${14 + Math.cos(t * 0.5) * 3}%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '600 14px Inter, system-ui, sans-serif';
        ctx.fillText(label || 'Live preview', 16, h - 20);
        frame += 1;
        simAnimTimer = requestAnimationFrame(draw);
        drawBoxesOverlay();
      }
      draw();
    }

    function drawBoxesOverlay() {
      const overlay = document.getElementById('pliveOverlay');
      const host = document.getElementById('pliveStreamHost');
      const canvas = document.getElementById('pliveCanvas');
      const video = host?.querySelector('video.ov-plive-media');
      const img = host?.querySelector('img.ov-plive-media');

      let w;
      let h;
      if (video && video.videoWidth) {
        w = host.clientWidth || video.clientWidth;
        h = host.clientHeight || video.clientHeight;
      } else if (img && img.naturalWidth) {
        w = host.clientWidth || img.clientWidth;
        h = host.clientHeight || img.clientHeight;
      } else if (canvas) {
        w = canvas.width;
        h = canvas.height;
      } else {
        return;
      }

      if (!overlay) return;
      overlay.width = w;
      overlay.height = h;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, w, h);

      const showBoxes = payload?.state?.features?.boundingBoxes !== false;
      if (!showBoxes || !frameData?.detections?.length) return;

      const confThreshold = currentConfidence ?? (payload?.state?.confidence ?? 0.32);
      const filteredDets = frameData.detections.filter((d) => (d.score ?? 0) >= confThreshold);
      if (!filteredDets.length) return;

      filteredDets.forEach((det) => {
        const box = det.box || [];
        if (box.length < 4) return;
        const x1 = box[0] * w;
        const y1 = box[1] * h;
        const x2 = box[2] * w;
        const y2 = box[3] * h;
        const score = Math.round((det.score || 0) * 100);
        const tid = det.track_id != null ? `#${det.track_id}` : '';
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const label = tid ? `Person ${tid} ${score}%` : `Person ${score}%`;
        const lw = Math.max(72, label.length * 7);
        ctx.fillStyle = 'rgba(34, 197, 94, 0.85)';
        ctx.fillRect(x1, y1 - 20, lw, 20);
        ctx.fillStyle = '#fff';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillText(label, x1 + 4, y1 - 6);
      });
    }

    function scheduleStreamResync() {
      if (!selectedCameraId || streamResyncAttempts >= 5) return;
      if (streamResyncTimer) return;
      streamResyncTimer = setTimeout(async () => {
        streamResyncTimer = null;
        streamResyncAttempts += 1;
        try {
          const res = await fetch(
            sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/resync`),
            { method: 'POST' }
          );
          const data = await res.json();
          if (res.ok && data.preview) {
            hlsStreamFailed = false;
            usingHlsStream = false;
            streamResyncAttempts = 0;
            frameData = { ...(frameData || {}), preview: data.preview, camera: data.camera };
            initStreamWithPreview({ preview: data.preview, camera: data.camera });
            showToast('Stream reconnected');
            return;
          }
        } catch {
          /* retry */
        }
        if (streamResyncAttempts < 5) scheduleStreamResync();
      }, 2000);
    }

    function onHlsStreamFailed(preview) {
      usingHlsStream = false;
      hlsStreamFailed = true;
      stopHls();
      const host = document.getElementById('pliveStreamHost');
      host?.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      if (canvas) canvas.style.display = 'block';
      if (overlay) overlay.style.display = 'block';
      const meta = document.getElementById('pliveStreamMeta');
      if (meta) {
        meta.textContent = preview?.streamWarning || 'Stream unavailable — reconnecting…';
      }
      if (frameData?.jpeg && inferenceRunning) {
        showJpegFrame(frameData.jpeg);
      } else {
        const camName = frameData?.camera?.name || 'Camera';
        startSimAnim(camName);
      }
      scheduleStreamResync();
    }

    function scheduleJpegDraw(jpeg) {
      pendingJpeg = jpeg;
      if (jpegDrawScheduled) return;
      jpegDrawScheduled = true;
      requestAnimationFrame(() => {
        jpegDrawScheduled = false;
        if (pendingJpeg) showJpegFrame(pendingJpeg, true);
        pendingJpeg = null;
      });
    }

    function showJpegFrame(jpeg, skipStop) {
      if (!skipStop) stopSimAnim();
      if (!skipStop) {
        stopHls();
        stopWhep();
      }
      const host = document.getElementById('pliveStreamHost');
      host?.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      const canvas = document.getElementById('pliveCanvas');
      if (canvas) canvas.style.display = 'block';
      const overlay = document.getElementById('pliveOverlay');
      if (overlay) overlay.style.display = 'block';
      if (!canvas || !host || !jpeg) return;

      const img = new Image();
      img.onload = () => {
        const w = host.clientWidth || 960;
        const h = Math.round(w * 9 / 16);
        canvas.width = w;
        canvas.height = h;
        const ov = document.getElementById('pliveOverlay');
        if (ov) {
          ov.width = w;
          ov.height = h;
        }
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        drawBoxesOverlay();
      };
      img.src = `data:image/jpeg;base64,${jpeg}`;
    }

    function initStreamWithPreview(livePayload) {
      const host = document.getElementById('pliveStreamHost');
      const preview = livePayload?.preview;
      if (!host || !preview) {
        initStreamDisplay();
        return;
      }

      stopSimAnim();
      stopHls();
      stopWhep();
      usingHlsStream = false;
      usingWhepStream = false;
      hlsStreamFailed = false;
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');

      const fallbackSim = () => {
        if ((preview.mode === 'hls' || preview.mode === 'whep') && !preview.simulated) {
          onHlsStreamFailed(preview);
          return;
        }
        if (canvas) canvas.style.display = 'block';
        if (overlay) overlay.style.display = 'block';
        const meta = document.getElementById('pliveStreamMeta');
        if (meta) meta.textContent = preview.label || 'No live stream available';
        startSimAnim(livePayload.camera?.name || 'Camera');
      };

      if (preview.mode === 'whep' && preview.url && !preview.simulated && window.WhepPlayer) {
        if (canvas) canvas.style.display = 'none';
        if (overlay) overlay.style.display = 'block';
        const video = document.createElement('video');
        video.className = 'ov-plive-media';
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.controls = false;
        host.insertBefore(video, host.firstChild);

        const meta = document.getElementById('pliveStreamMeta');
        if (meta) meta.textContent = preview.label || 'Live WebRTC stream';

        const whepUrl = window.WhepPlayer.resolveLocalUrl(preview.url);
        window.WhepPlayer.connectWhep(whepUrl, video)
          .then((player) => {
            whepPlayer = { ...player, video };
            usingWhepStream = true;
            streamInitialized = true;
            streamLocked = true;
            video.addEventListener('loadeddata', drawBoxesOverlay);
            startOverlayLoop();
          })
          .catch(() => {
            if (preview.hlsUrl) {
              initHlsStream(preview.hlsUrl, host, canvas, overlay, fallbackSim);
            } else {
              fallbackSim();
            }
          });
        return;
      }

      if (preview.mode === 'hls' && preview.url && !preview.simulated) {
        initHlsStream(preview.url, host, canvas, overlay, fallbackSim);
        return;
      }

      if (preview.mode === 'http' && preview.url && !preview.simulated) {
        if (canvas) canvas.style.display = 'none';
        if (overlay) overlay.style.display = 'block';
        const img = document.createElement('img');
        img.className = 'ov-plive-media';
        img.alt = `${livePayload.camera?.name || 'Camera'} live stream`;
        img.src = preview.url;
        img.onerror = fallbackSim;
        host.insertBefore(img, host.firstChild);
        return;
      }

      if (preview.mode === 'video' && preview.url && !preview.simulated) {
        if (canvas) canvas.style.display = 'none';
        if (overlay) overlay.style.display = 'block';
        const video = document.createElement('video');
        video.className = 'ov-plive-media';
        video.src = preview.url;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.onerror = fallbackSim;
        host.insertBefore(video, host.firstChild);
        return;
      }

      fallbackSim();
    }

    function initHlsStream(hlsUrl, host, canvas, overlay, fallbackSim) {
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      const video = document.createElement('video');
      video.className = 'ov-plive-media';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.controls = false;
      host.insertBefore(video, host.firstChild);

      const meta = document.getElementById('pliveStreamMeta');
      if (meta) meta.textContent = 'Live HLS stream (fallback)';

      const url = window.WhepPlayer?.resolveLocalUrl(hlsUrl) || hlsUrl;
      if (window.Hls && window.Hls.isSupported()) {
        hlsPlayer = new window.Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 0,
          maxBufferLength: 2,
          maxMaxBufferLength: 4,
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 3,
          maxLiveSyncPlaybackRate: 1.5,
        });
        hlsPlayer.loadSource(url);
        hlsPlayer.attachMedia(video);
        hlsPlayer.on(window.Hls.Events.ERROR, () => fallbackSim());
        usingHlsStream = true;
        streamInitialized = true;
        streamLocked = true;
        video.addEventListener('loadeddata', drawBoxesOverlay);
        return;
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.onerror = fallbackSim;
        usingHlsStream = true;
        streamInitialized = true;
        streamLocked = true;
        video.addEventListener('loadeddata', drawBoxesOverlay);
      }
    }

    function initStreamDisplay() {
      const meta = document.getElementById('pliveStreamMeta');
      const preview = frameData?.preview;
      if (meta && preview?.label) meta.textContent = preview.label;

      if (frameData?.jpeg && !usingWhepStream && !usingHlsStream && !streamLocked) {
        showJpegFrame(frameData.jpeg);
        return;
      }

      const camName = frameData?.camera?.name || 'Camera';
      startSimAnim(camName);
    }

    async function pollFrame() {
      if (!selectedCameraId) return;
      try {
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/frame`));
        if (!res.ok) return;
        frameData = await res.json();
        inferenceRunning = Boolean(frameData.inferenceRunning);
        if (frameData.payload) {
          payload = frameData.payload;
          if (document.activeElement?.id !== 'pliveConfRange') {
            currentConfidence = payload?.state?.confidence ?? currentConfidence;
          }
        }

        if (usingWhepStream || usingHlsStream) {
          startOverlayLoop();
          drawBoxesOverlay();
        } else if (!simAnimTimer && frameData.preview?.simulated) {
          startSimAnim(frameData.camera?.name);
        } else {
          drawBoxesOverlay();
        }

        updateStatsOnly();
        updateInferenceUi(frameData);

        if (inferenceRunning && frameData.wsUrl && frameData.workerSource !== 'local-cpu' && !detWs) {
          connectDetectionWs(frameData.wsUrl);
        }
      } catch {
        /* ignore */
      }
    }

    function startPolling() {
      stopPolling();
      pollFrame();
      const ms = inferenceRunning ? (detWs ? 2000 : 1000) : 2500;
      pollTimer = setInterval(pollFrame, ms);
    }

    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }

    async function selectCamera(cameraId) {
      const cameraChanged = cameraId !== selectedCameraId;
      selectedCameraId = cameraId;
      inferenceRunning = false;
      hlsStreamFailed = false;
      streamResyncAttempts = 0;

      if (cameraChanged) {
        streamInitialized = false;
        if (streamResyncTimer) {
          clearTimeout(streamResyncTimer);
          streamResyncTimer = null;
        }
        stopSimAnim();
        stopHls();
        stopWhep();
        disconnectDetectionWs();
      }

      document.querySelectorAll('.ov-cam-tile-clickable').forEach((tile) => {
        tile.classList.toggle('is-selected', tile.dataset.id === cameraId);
      });

      ensureLoadingStyle();
      const root = getRoot();
      const camName = (payload?.assignedCameras || []).find((c) => c.id === cameraId)?.name || 'Camera';
      if (root && cameraChanged) {
        root.hidden = false;
        root.innerHTML = renderLoadingState(camName);
      }

      try {
        setLoadingStatus('Syncing camera with backend…');
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(cameraId)}/select`), {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        payload = data.payload || payload;
        if (data.preview) {
          frameData = { ...(frameData || {}), preview: data.preview, camera: data.camera };
        }
        if (data.backendReachable === false) {
          showToast('Vision backend offline — preview mode only');
        }
      } catch (err) {
        showToast(err.message || 'Could not select camera');
      }

      mount(cameraChanged ? false : true);

      if (!cameraChanged && streamInitialized) {
        if (inferenceRunning && frameData?.wsUrl && !detWs) {
          connectDetectionWs(frameData.wsUrl);
        }
        if (window.DetectionTab?.reload) window.DetectionTab.reload();
        return;
      }

      try {
        setLoadingStatus('Starting stream relay…');
        const live = await fetchLiveWithTimeout(cameraId);
        if (live?.preview) {
          setLoadingStatus('Waiting for video feed…');
          frameData = { ...(frameData || {}), preview: live.preview, camera: live.camera };
          initStreamWithPreview(live);
        } else if (frameData?.preview) {
          initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
        } else {
          initStreamDisplay();
        }
      } catch {
        if (frameData?.preview) {
          initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
        } else {
          initStreamDisplay();
        }
      }

      if (window.DetectionTab?.reload) {
        window.DetectionTab.reload();
      }
    }

    function getSelectedCameraId() {
      return selectedCameraId;
    }

    async function initFromPayload(detPayload) {
      payload = detPayload;
      currentConfidence = payload?.state?.confidence ?? 0.32;
      const activeId = detPayload?.state?.activeCameraId;
      if (activeId) {
        if (activeId === selectedCameraId && streamInitialized) {
          mount(true);
          return;
        }
        if (activeId !== selectedCameraId) {
          await selectCamera(activeId);
          return;
        }
      }
      if (!selectedCameraId) {
        const root = getRoot();
        if (root) {
          root.hidden = false;
          root.innerHTML = renderEmptyState();
        }
      }
    }

    window.PersonLive = {
      selectCamera,
      getSelectedCameraId,
      initFromPayload,
      refresh: pollFrame,
    };

    document.addEventListener('DOMContentLoaded', () => {
      const root = getRoot();
      if (root && !selectedCameraId) {
        root.hidden = false;
        root.innerHTML = renderEmptyState();
      }
    });
  })();
