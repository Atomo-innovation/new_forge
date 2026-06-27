(function () {
  const SETTINGS_SECTION_KEY = 'atomoSettingsSection';
  let sessionId = sessionStorage.getItem('atomoSessionId');
  let meshcentralUrl = null;
  let demoMode = false;
  let cameras = [];

  function sessionUrl(path) {
    if (window.AFSession?.sessionUrl) return window.AFSession.sessionUrl(path);
    if (!sessionId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}sessionId=${encodeURIComponent(sessionId)}`;
  }

  function setInput(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '';
  }

  function escapeHtml(str) {
    return String(str ?? '')
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

  function populateSettings(sessionData) {
    const profile = sessionData.profile || {};
    const loc = [profile.city, profile.country].filter(Boolean).join(', ');
    setInput('setDeviceName', profile.deviceName || '');
    setInput('setDeviceSerial', profile.deviceSerial || '');
    setInput('setDeviceType', profile.deviceType || '');
    setInput('setOs', profile.operatingSystem || '');
    setInput('setOrgName', profile.organizationName || '');
    setInput('setLocation', loc);
    setInput('setAdminName', profile.adminName || sessionData.username || '');
    setInput('setNotifyEmail', profile.email || sessionData.email || '');
    setInput('setMeshGroup', profile.meshGroupName || '');
    setText('setCurrentUser', sessionData.username || profile.adminName || '—');
    setInput('setMasterSlaveRole', profile.deviceType || sessionData.clusterMode || '—');
    setInput('setLicenseStatus', demoMode ? 'Demo' : 'Active');
  }

  function showSettingsSection(sectionId) {
    document.querySelectorAll('.settings-link').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.settings === sectionId);
    });
    document.querySelectorAll('.settings-section').forEach((panel) => {
      panel.classList.toggle('is-hidden', panel.dataset.settingsPanel !== sectionId);
    });
    try {
      sessionStorage.setItem(SETTINGS_SECTION_KEY, sectionId);
    } catch {
      /* ignore */
    }
  }

  function wireSettingsNav() {
    document.querySelectorAll('.settings-link').forEach((btn) => {
      btn.addEventListener('click', () => showSettingsSection(btn.dataset.settings));
    });
    const saved = sessionStorage.getItem(SETTINGS_SECTION_KEY) || 'device';
    showSettingsSection(saved);

    document.getElementById('settingsSyncBtn')?.addEventListener('click', () => requestCloudSync());
    document.getElementById('settingsOpenAtomicBtn')?.addEventListener('click', () => {
      if (meshcentralUrl) {
        window.open(meshcentralUrl, '_blank', 'noopener,noreferrer');
      } else {
        showToast('Atomic Centre URL is not configured on this device.');
      }
    });
    document.getElementById('settingsFactoryResetBtn')?.addEventListener('click', () => {
      showToast('Run scripts/reset-local-data.sh on the device to factory reset.');
    });
  }

  function renderSettingsCameras() {
    const empty = document.getElementById('settingsCamerasEmpty');
    const tableWrap = document.getElementById('settingsCamerasTableWrap');
    const tbody = document.getElementById('settingsCamerasBody');
    if (!empty || !tableWrap || !tbody) return;

    const hasCameras = cameras.length > 0;
    empty.classList.toggle('is-hidden', hasCameras);
    tableWrap.classList.toggle('is-hidden', !hasCameras);

    if (!hasCameras) {
      tbody.innerHTML = '';
      return;
    }

    tbody.innerHTML = cameras.map((cam) => {
      const online = cam.status === 'online' || cam.status === 'active';
      return `<tr>
        <td>${escapeHtml(cam.name)}</td>
        <td>${escapeHtml(cam.type || '—')}</td>
        <td>${escapeHtml(cam.zone || '—')}</td>
        <td><span class="settings-badge ${online ? 'is-ok' : ''}">${online ? 'Online' : 'Offline'}</span></td>
      </tr>`;
    }).join('');
  }

  async function loadCameras() {
    try {
      const res = await fetch(sessionUrl('/api/cameras'));
      if (!res.ok) return;
      const data = await res.json();
      cameras = data.cameras || [];
      renderSettingsCameras();
    } catch {
      /* ignore */
    }
  }

  async function loadDeviceProfile() {
    try {
      const res = await fetch(sessionUrl('/api/device/profile'));
      if (!res.ok) return;
      const data = await res.json();
      meshcentralUrl = data.meshcentralUrl || data.profile?.meshcentralUrl || null;
      setInput('setAtomicUrl', meshcentralUrl || '');
    } catch {
      /* ignore */
    }
  }

  async function loadSystemStats() {
    try {
      const res = await fetch(sessionUrl('/api/system/stats'));
      if (!res.ok) return;
      const data = await res.json();
      const storage = data.storage ?? data.disk ?? null;
      setInput('setStoragePct', storage != null ? `${Math.round(storage)}% used` : '—');
      setInput('setSyncStatus', data._demo ? 'Demo' : 'Online');
    } catch {
      /* ignore */
    }
  }

  async function requestCloudSync() {
    const syncBtn = document.getElementById('settingsSyncBtn');
    const original = syncBtn?.textContent;
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
    }
    try {
      const res = await fetch(sessionUrl('/api/device/cloud-sync/enqueue-current'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.ok) {
        showToast(data.error || 'Sync request failed.');
        return;
      }
      showToast(data.message || (data.synced ? 'Profile synced.' : 'Sync queued.'));
      setInput('setSyncStatus', data.synced ? 'Synced' : 'Queued');
    } catch (err) {
      showToast(err.message || 'Sync failed.');
    } finally {
      if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.textContent = original;
      }
    }
  }

  function openAddCameraModal() {
    const modal = document.getElementById('addCameraModal');
    const form = document.getElementById('addCameraForm');
    const errorEl = document.getElementById('addCameraError');
    if (!modal || !form) return;
    form.reset();
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('is-hidden');
    }
    modal.hidden = false;
    document.body.classList.add('ov-modal-open');
    document.getElementById('cameraName')?.focus();
  }

  function closeAddCameraModal() {
    const modal = document.getElementById('addCameraModal');
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('ov-modal-open');
  }

  async function submitAddCamera(e) {
    e.preventDefault();
    const errorEl = document.getElementById('addCameraError');
    const submitBtn = document.getElementById('addCameraSubmitBtn');
    const name = document.getElementById('cameraName')?.value.trim();
    const type = document.getElementById('cameraType')?.value.trim();
    const zone = document.getElementById('cameraZone')?.value.trim();
    const rtspUrl = document.getElementById('cameraRtspUrl')?.value.trim();

    const showError = (msg) => {
      if (!errorEl) return;
      errorEl.textContent = msg;
      errorEl.classList.remove('is-hidden');
    };

    if (!name || !type || !rtspUrl) {
      showError('Please fill in camera name, type and RTSP URL.');
      return;
    }
    if (!/^rtsps?:\/\//i.test(rtspUrl)) {
      showError('RTSP URL must start with rtsp:// or rtsps://.');
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch(sessionUrl('/api/cameras'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, rtspUrl, zone: zone || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || 'Failed to add camera.');
        return;
      }
      closeAddCameraModal();
      showToast(`Camera "${name}" added.`);
      await loadCameras();
    } catch {
      showError('Network error — could not save camera.');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function wireAddCameraModal() {
    const addBtn = document.getElementById('settingsAddCameraBtn');
    if (demoMode && addBtn) addBtn.hidden = true;

    document.getElementById('settingsAddCameraBtn')?.addEventListener('click', openAddCameraModal);
    document.getElementById('addCameraForm')?.addEventListener('submit', submitAddCamera);
    document.querySelectorAll('[data-action="close-add-camera"]').forEach((el) => {
      el.addEventListener('click', closeAddCameraModal);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('addCameraModal')?.hidden) {
        closeAddCameraModal();
      }
    });
  }

  async function ensureSession() {
    const res = await fetch(sessionUrl('/api/session'), { credentials: 'same-origin' });
    if (!res.ok) {
      window.location.href = '/login';
      return null;
    }
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login';
      return null;
    }
    if (data.sessionId) {
      sessionId = data.sessionId;
      sessionStorage.setItem('atomoSessionId', sessionId);
    }
    demoMode = data.demoMode === true;
    populateSettings(data);
    return data;
  }

  async function init() {
    if (window.AFSession?.requireAuth) {
      const ok = await window.AFSession.requireAuth({ allowPaths: ['/settings', '/overview'] });
      if (!ok) return;
    }
    const session = await ensureSession();
    if (!session) return;
    wireSettingsNav();
    wireAddCameraModal();
    await Promise.all([loadDeviceProfile(), loadCameras(), loadSystemStats()]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
