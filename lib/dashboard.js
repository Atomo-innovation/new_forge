// Dashboard subsystem ported from the main Atomo Forge app.
// Encapsulates the master/slave (cluster-role), user-role, and the full
// /overview dashboard (cameras + AI/detection) so it can be mounted onto the
// existing big login/registration server without touching that flow.

const path = require('path');

const session = require('./session');
const deviceProfile = require('./device-profile');
const dashboardRbac = require('./dashboard-rbac');
const masterControl = require('./master-control');
const appLayout = require('./app-layout');
const overviewData = require('./overview-data');
const cameraStore = require('./camera-store');
const detectionConfig = require('./detection-config');
const detectionStore = require('./detection-store');
const { buildSnapshotSvg } = require('./detection-snapshot');
const { validateCameraConfig } = require('./camera-validation');
const { getLiveViewPayload } = require('./camera-analytics');
const { fetchSystemStats, getLocalSystemStats } = require('./local-system-stats');
const personLive = require('./person-live');
const eventBroadcast = require('./event-broadcast');
const { isServerlessRuntime } = require('./runtime-env');
const dashboardAuth = require('./dashboard-auth');
const { isDemoMode } = require('./demo-mode');
const { ensureDemoCamera, isDemoCamera, getDemoVideoPreview } = require('./demo-cameras');
const { isDemoLockedDetectionSlug } = require('./subscription-gate');

const viewsDir = path.join(__dirname, '..', 'views');

function ensureStandaloneSessionRole(sessRecord) {
  if (!sessRecord) return;
  const mode = dashboardAuth.getClusterMode(sessRecord);
  if (mode !== 'standalone') return;
  if (session.isUserRoleConfirmed(sessRecord.sessionId)) return;
  const roleId = dashboardRbac.getDefaultRoleIdForClusterMode('standalone');
  const role = dashboardRbac.setUserRole(sessRecord.meshUserId, roleId);
  session.confirmUserRole(sessRecord.sessionId, role.id);
  dashboardAuth.markUserRole(sessRecord, role.id);
}

function postLoginRedirect(sessRecord) {
  return dashboardAuth.computePostLoginRedirect(sessRecord);
}

function register(app, { resolveSession }) {
  function requireDashboardSession(req, res) {
    if (isServerlessRuntime()) {
      return resolveSession(req);
    }
    const record = resolveSession(req);
    if (!record) {
      res.redirect('/login');
      return null;
    }
    if (!deviceProfile.isRegistered()) {
      res.redirect('/device-registration');
      return null;
    }
    if (!session.isClusterRoleConfirmed(record.sessionId)) {
      res.redirect('/cluster-role');
      return null;
    }
    ensureStandaloneSessionRole(record);
    if (deviceProfile.getClusterMode() !== 'standalone' && !session.isUserRoleConfirmed(record.sessionId)) {
      res.redirect('/user-role');
      return null;
    }
    return record;
  }

  // ---- Topology / role pages ----
  app.get('/cluster-role', (req, res) => {
    if (!isServerlessRuntime() && !resolveSession(req)) return res.redirect('/login');
    if (!isServerlessRuntime() && !deviceProfile.isRegistered()) return res.redirect('/device-registration');
    res.sendFile(path.join(viewsDir, 'cluster-role.html'));
  });

  app.get('/user-role', (req, res) => {
    if (isServerlessRuntime()) {
      return res.sendFile(path.join(viewsDir, 'user-role.html'));
    }
    const sess = resolveSession(req);
    if (!sess) return res.redirect('/login');
    if (!deviceProfile.isRegistered()) return res.redirect('/device-registration');
    const record = session.getSessionRecord(sess.sessionId);
    if (record && !session.isClusterRoleConfirmed(record.sessionId)) {
      return res.redirect('/cluster-role');
    }
    if (deviceProfile.getClusterMode() === 'standalone') {
      ensureStandaloneSessionRole(record);
      return res.redirect('/overview');
    }
    res.sendFile(path.join(viewsDir, 'user-role.html'));
  });

  app.get('/api/cluster-role', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    return res.json({
      clusterMode: dashboardAuth.getClusterMode(sess) || 'slave',
      clusterRoleConfirmed: sess.clusterRoleConfirmed === true,
      sessionId: sess.sessionId,
    });
  });

  app.post('/api/cluster-role', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const registered = dashboardAuth.isDeviceRegistered(sess)
      || await dashboardAuth.ensureDeviceRegistered(sess);
    if (!registered) {
      return res.status(400).json({
        error: 'Device must be registered first.',
        redirectTo: '/device-registration',
      });
    }
    try {
      const requested = req.body?.clusterMode;
      let mode;
      if (deviceProfile.isRegistered()) {
        mode = deviceProfile.setClusterMode(requested);
      } else {
        mode = String(requested || 'slave').trim().toLowerCase();
        if (!['master', 'slave', 'standalone'].includes(mode)) {
          return res.status(400).json({ error: 'Invalid cluster mode. Use master, slave, or standalone.' });
        }
      }
      session.confirmClusterRole(sess.sessionId);
      dashboardAuth.markClusterRole(sess, mode);
      if (mode === 'standalone') {
        ensureStandaloneSessionRole(sess);
        const updated = session.getSessionRecord(sess.sessionId);
        return res.json({
          success: true,
          clusterMode: mode,
          redirectTo: dashboardAuth.computePostLoginRedirect(updated),
          skipUserRole: true,
        });
      }
      const updated = session.getSessionRecord(sess.sessionId);
      return res.json({
        success: true,
        clusterMode: mode,
        redirectTo: dashboardAuth.computePostLoginRedirect(updated),
      });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message || 'Failed to save cluster mode.' });
    }
  });

  app.get('/api/user-role', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const clusterMode = dashboardAuth.getClusterMode(sess);
    if (clusterMode === 'standalone') {
      ensureStandaloneSessionRole(sess);
      const updated = session.getSessionRecord(sess.sessionId);
      return res.json({
        clusterMode,
        skipUserRole: true,
        redirectTo: dashboardAuth.computePostLoginRedirect(updated),
        roles: [],
        userRole: dashboardRbac.getRolePayload(dashboardRbac.getDefaultRoleIdForClusterMode('standalone')),
        userRoleConfirmed: true,
      });
    }
    const saved = dashboardRbac.getUserRole(sess.meshUserId);
    const roles = dashboardRbac.listRolesForClusterMode(clusterMode);
    const defaultRoleId = dashboardRbac.getDefaultRoleIdForClusterMode(clusterMode);
    const savedRoleId = saved?.id;
    const activeRoleId =
      savedRoleId && roles.some((role) => role.id === savedRoleId) ? savedRoleId : defaultRoleId;
    return res.json({
      clusterMode,
      roles: roles.map((role) => dashboardRbac.getRolePayload(role.id)),
      userRole: dashboardRbac.getRolePayload(activeRoleId),
      userRoleConfirmed: session.isUserRoleConfirmed(sess.sessionId),
    });
  });

  app.post('/api/user-role', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    if (!session.isClusterRoleConfirmed(sess.sessionId)) {
      return res.status(400).json({ error: 'Complete master/slave setup first.' });
    }
    const clusterMode = dashboardAuth.getClusterMode(sess);
    if (clusterMode === 'standalone') {
      ensureStandaloneSessionRole(sess);
      const updated = session.getSessionRecord(sess.sessionId);
      return res.json({
        success: true,
        userRole: dashboardRbac.getRolePayload(dashboardRbac.getDefaultRoleIdForClusterMode('standalone')),
        redirectTo: dashboardAuth.computePostLoginRedirect(updated),
      });
    }
    try {
      const roleId = req.body?.roleId;
      if (!dashboardRbac.isRoleAllowedForClusterMode(clusterMode, roleId)) {
        return res.status(400).json({
          error:
            clusterMode === 'master'
              ? 'Master nodes only support Admin and Viewer roles.'
              : 'Invalid role for the current cluster mode.',
        });
      }
      const role = dashboardRbac.setUserRole(sess.meshUserId, roleId);
      session.confirmUserRole(sess.sessionId, role.id);
      dashboardAuth.markUserRole(sess, role.id);
      const updated = session.getSessionRecord(sess.sessionId);
      return res.json({
        success: true,
        userRole: dashboardRbac.getRolePayload(role.id),
        redirectTo: dashboardAuth.computePostLoginRedirect(updated),
      });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message || 'Failed to save user role.' });
    }
  });

  app.get('/api/master/public-state', (_req, res) => {
    res.json({
      platform: masterControl.getPlatformState(),
      masterControlEnabled: masterControl.isFlagEnabled('master_control'),
    });
  });

  // ---- Dashboard pages ----
  app.get('/overview', (req, res) => {
    if (!isServerlessRuntime() && !requireDashboardSession(req, res)) return;
    res.type('html').send(appLayout.renderPage('overview.html'));
  });

  app.get('/cameras/:id', (req, res) => {
    if (!isServerlessRuntime() && !requireDashboardSession(req, res)) return;
    const camera = cameraStore.getCamera(req.params.id);
    if (!camera) {
      res.redirect('/overview');
      return;
    }
    res.type('html').send(appLayout.renderPage('camera-live.html'));
  });

  app.get('/settings', (req, res) => {
    if (!isServerlessRuntime() && !requireDashboardSession(req, res)) return;
    res.type('html').send(appLayout.renderPage('settings.html'));
  });

  app.get('/detection/:slug', (req, res) => {
    if (!isServerlessRuntime() && !requireDashboardSession(req, res)) return;
    if (isDemoLockedDetectionSlug(req.params.slug)) {
      res.type('html').send(appLayout.renderPage('subscription-required.html'));
      return;
    }
    const tab = detectionConfig.getTab(req.params.slug);
    if (!tab) {
      res.redirect('/overview');
      return;
    }
    const html = appLayout.renderDetectionPage(req.params.slug);
    if (!html) {
      res.redirect('/overview');
      return;
    }
    res.type('html').send(html);
  });

  // ---- Detection APIs ----
  app.get('/api/detection/events/:eventId/snapshot', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const snap = detectionStore.getEventSnapshot(req.params.eventId);
    if (snap?.jpeg) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(Buffer.from(snap.jpeg, 'base64'));
    }
    const event = detectionStore.getSnapshotEvent(req.params.eventId);
    if (!event) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buildSnapshotSvg(event));
  });

  app.get('/api/detection/:slug', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    if (isDemoMode() && (req.params.slug === 'person' || req.params.slug === 'face')) {
      ensureDemoCamera();
    }
    const payload = detectionStore.getPayload(req.params.slug);
    if (!payload) return res.status(404).json({ error: 'Detection model not found.' });
    return res.json({ ...payload, demoMode: isDemoMode() });
  });

  app.patch('/api/detection/:slug', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const payload = detectionStore.updateSettings(req.params.slug, req.body || {});
    if (!payload) return res.status(404).json({ error: 'Detection model not found.' });
    return res.json(payload);
  });

  app.post('/api/detection/:slug/inference', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const running = req.body?.action === 'start';
    const payload = detectionStore.setInference(req.params.slug, running);
    if (!payload) return res.status(404).json({ error: 'Detection model not found.' });
    return res.json(payload);
  });

  app.post('/api/detection/:slug/live/:cameraId/select', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const slug = req.params.slug;
    if (slug !== 'person' && slug !== 'face') {
      return res.status(404).json({ error: 'Live detection not available for this model.' });
    }
    try {
      const result = await personLive.selectCamera(req.params.cameraId, slug);
      if (!result.ok) return res.status(404).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not select camera' });
    }
  });

  app.post('/api/detection/:slug/live/:cameraId/start', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const slug = req.params.slug;
    if (slug !== 'person' && slug !== 'face') {
      return res.status(404).json({ error: 'Live detection not available for this model.' });
    }
    try {
      const result = await personLive.startLive(req.params.cameraId, slug);
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not start inference' });
    }
  });

  app.post('/api/detection/:slug/live/:cameraId/stop', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const slug = req.params.slug;
    if (slug !== 'person' && slug !== 'face') {
      return res.status(404).json({ error: 'Live detection not available for this model.' });
    }
    try {
      const result = await personLive.stopLive(req.params.cameraId, slug);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not stop inference' });
    }
  });

  app.get('/api/detection/:slug/live/:cameraId/frame', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const slug = req.params.slug;
    if (slug !== 'person' && slug !== 'face') {
      return res.status(404).json({ error: 'Live detection not available for this model.' });
    }
    try {
      const result = await personLive.getLiveFrame(req.params.cameraId, slug);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not load frame' });
    }
  });

  app.post('/api/detection/:slug/live/:cameraId/resync', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const slug = req.params.slug;
    if (slug !== 'person' && slug !== 'face') {
      return res.status(404).json({ error: 'Live detection not available for this model.' });
    }
    try {
      const result = await personLive.resyncStream(req.params.cameraId, slug);
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not resync stream' });
    }
  });

  app.patch('/api/detection/:slug/live/:cameraId/config', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const slug = req.params.slug;
    if (slug !== 'person' && slug !== 'face') {
      return res.status(404).json({ error: 'Live detection not available for this model.' });
    }
    try {
      const result = await personLive.updateLiveConfig(req.params.cameraId, req.body || {}, slug);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not update settings' });
    }
  });

  app.post('/api/detection/:slug/cameras', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const result = detectionStore.assignCamera(req.params.slug, req.body?.cameraId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result.payload);
  });

  app.delete('/api/detection/:slug/cameras/:cameraId', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const result = detectionStore.unassignCamera(req.params.slug, req.params.cameraId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result.payload);
  });

  app.get('/api/detection/:slug/export', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const exported = detectionStore.exportData(req.params.slug, format);
    if (!exported) return res.status(404).json({ error: 'Detection model not found.' });
    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return res.send(exported.body);
  });

  // ---- Overview + system + cameras APIs ----
  app.get('/api/overview', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    return res.json(overviewData.getOverviewPayload(sess));
  });

  app.get('/api/system/stats', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    try {
      const stats = await fetchSystemStats();
      if (stats) return res.json({ ...stats, _fromBoard: true });
      if (isDemoMode()) return res.json(getLocalSystemStats({ demo: true }));
      return res.json(getLocalSystemStats());
    } catch (err) {
      console.warn('[system/stats]', err.message);
      if (isDemoMode()) return res.json(getLocalSystemStats({ demo: true }));
      return res.json(getLocalSystemStats());
    }
  });

  app.get('/api/cameras', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    if (isDemoMode()) ensureDemoCamera();
    const cameras = cameraStore.listCameras();
    return res.json({
      cameras,
      stats: cameraStore.cameraStats(),
      demoMode: isDemoMode(),
    });
  });

  app.get('/api/cameras/:id/live', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    let camera = cameraStore.getCamera(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found.' });
    if (isDemoCamera(camera)) {
      return res.json({
        ...getLiveViewPayload(camera),
        preview: getDemoVideoPreview(true),
        demoMode: isDemoMode(),
      });
    }
    try {
      const { syncDashboardCamera } = require('./backend-cameras');
      const sync = await syncDashboardCamera(camera);
      camera = cameraStore.getCamera(req.params.id) || camera;
      const payload = getLiveViewPayload(camera);
      payload.streamSync = sync;
      if (sync.hlsReady === false && payload.preview?.mode === 'hls') {
        payload.preview.streamWarning = 'MediaMTX path not ready yet — starting relay…';
      }
      return res.json(payload);
    } catch (err) {
      console.warn('[cameras/live] sync failed:', err.message);
      return res.json(getLiveViewPayload(camera));
    }
  });

  app.post('/api/cameras/validate', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const result = validateCameraConfig(req.body || {});
    return res.json(result);
  });

  app.post('/api/cameras', async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const body = req.body || {};
    const validation = validateCameraConfig(body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error, checks: validation.checks });
    }

    let camera = cameraStore.addCamera({
      name: String(body.name || '').trim(),
      type: body.type || 'rtsp',
      rtspUrl: body.rtspUrl || '',
      username: body.username || '',
      ipAddress: body.ipAddress || '',
      port: body.port || '',
      location: body.location || '',
      zoneFloor: body.zoneFloor || '',
      department: body.department || '',
      group: body.group || '',
      resolution: body.resolution || validation.detected?.resolution || '1920x1080',
      fpsLimit: Number(body.fpsLimit) || validation.detected?.fps || 25,
      aiModels: Array.isArray(body.aiModels) ? body.aiModels : [],
      modelConfidence: {},
      recording: Boolean(body.recording),
      alertRules: Array.isArray(body.alertRules) ? body.alertRules : [],
      validation: validation.detected,
    });

    try {
      const { syncDashboardCamera } = require('./backend-cameras');
      const sync = await syncDashboardCamera(camera);
      if (sync.synced) {
        camera = cameraStore.getCamera(camera.id) || camera;
      }
    } catch (err) {
      console.warn('[cameras] backend sync failed:', err.message);
    }

    const aiModels = Array.isArray(camera.aiModels) ? camera.aiModels : [];
    if (aiModels.includes('yolov8-perimeter')) {
      try {
        detectionStore.assignCamera('person', camera.id);
      } catch {
        /* ignore */
      }
    }

    return res.status(201).json({ camera, stats: cameraStore.cameraStats() });
  });

  app.patch('/api/cameras/:id', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const existing = cameraStore.getCamera(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Camera not found.' });

    const patch = {};
    if (req.body?.modelConfidence && typeof req.body.modelConfidence === 'object') {
      const merged = { ...(existing.modelConfidence || {}) };
      for (const [modelId, value] of Object.entries(req.body.modelConfidence)) {
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        merged[modelId] = Math.round(Math.max(0.25, Math.min(0.95, n)) * 100) / 100;
      }
      patch.modelConfidence = merged;
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    const camera = cameraStore.updateCamera(req.params.id, patch);
    return res.json({ camera });
  });

  app.delete('/api/cameras/:id', (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const removed = cameraStore.removeCamera(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Camera not found.' });
    return res.json({ ok: true, stats: cameraStore.cameraStats() });
  });

  return { requireDashboardSession };
}

function setupWebsocket(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/ws/detection') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const slug = url.searchParams.get('slug') || 'person';
          eventBroadcast.addClient(ws, slug);
        });
        return;
      }
    } catch {
      /* fall through */
    }
    socket.destroy();
  });
  return wss;
}

module.exports = {
  register,
  setupWebsocket,
  ensureStandaloneSessionRole,
  postLoginRedirect,
  masterControl,
  cameraStore,
};
