const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

const { getMeshcentralUrl, offlineLoginEnabled, singleUserPerDevice } = require('./lib/device-config');
const { proxyJson, checkHealth, isNetworkError } = require('./lib/meshcentral-client');
const meshcentralStatus = require('./lib/meshcentral-status');
const { login: authLogin, completeSignupBind } = require('./lib/auth-service');
const { canAutoInstall } = require('./lib/mesh-agent-install');
const { runAtomicRegistration } = require('./lib/registration-pipeline');
const { saveDeviceProfileToCloud } = require('./lib/meshcentral-register');
const cloudSync = require('./lib/cloud-sync');
const passwordSync = require('./lib/password-sync');
const deviceBinding = require('./lib/device-binding');
const deviceProfile = require('./lib/device-profile');
const cameraStore = require('./lib/camera-store');
const { syncOnboardingWithCloud } = require('./lib/cloud-registration');
const session = require('./lib/session');
const dashboard = require('./lib/dashboard');
const masterControl = require('./lib/master-control');
const dashboardRbac = require('./lib/dashboard-rbac');
const { isServerlessRuntime, getProxyTimeoutMs } = require('./lib/runtime-env');
const serverlessLifecycle = require('./lib/serverless-lifecycle');
const pendingFlows = require('./lib/pending-flows');
const sessionCookie = require('./lib/session-cookie');
const dashboardAuth = require('./lib/dashboard-auth');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const meshcentralUrl = getMeshcentralUrl();
if (!meshcentralUrl) {
  const msg = 'meshcentralUrl is required in app-config.json (or set MESHCENTRAL_URL).';
  const example = 'Example: "meshcentralUrl": "https://3.108.185.253:4434"';
  if (require.main === module && !isServerlessRuntime()) {
    console.error(msg);
    console.error(example);
    process.exit(1);
  }
  console.warn(`[Startup] ${msg}`);
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const pendingSignups = {
  get: (key) => pendingFlows.getSignup(key),
  set: (key, value) => pendingFlows.setSignup(key, value),
  delete: (key) => pendingFlows.deleteSignup(key),
};
const pendingPasswordResets = {
  get: (key) => pendingFlows.getReset(key),
  set: (key, value) => pendingFlows.setReset(key, value),
  delete: (key) => pendingFlows.deleteReset(key),
};

function normalizeUsername(username) {
  return pendingFlows.normalizeUsername(username);
}

function sendProxy(res, { status, data }) {
  if (data?.htmlResponse) {
    return res.status(503).json({
      error: data.error || 'Atomic Center API is not available.',
      code: 'atomic_api_html',
    });
  }
  return res.status(status).json(data);
}

function validateOnboardingEmail(sessRecord, formEmail) {
  const accountEmail = sessRecord.email;
  const normalizedForm = formEmail ? String(formEmail).trim() : null;

  if (accountEmail && normalizedForm) {
    if (!deviceProfile.emailsMatch(accountEmail, normalizedForm)) {
      return {
        ok: false,
        error: `Registration email must match your account email (${accountEmail}).`,
      };
    }
  } else if (accountEmail && !normalizedForm) {
    return {
      ok: false,
      error: `Enter your account email (${accountEmail}) to complete one-time device registration.`,
    };
  }

  return {
    ok: true,
    email: normalizedForm || accountEmail || null,
  };
}

function markOnboardingComplete(sessRecord, formEmail) {
  const validated = validateOnboardingEmail(sessRecord, formEmail);
  if (!validated.ok) return validated;
  deviceProfile.markUserOnboarded({
    meshUserId: sessRecord.meshUserId,
    email: validated.email,
  });
  dashboardAuth.markOnboardingComplete(sessRecord, validated.email);
  return { ok: true };
}

function deviceStatusPayload() {
  const binding = deviceBinding.getBinding();
  return {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: deviceBinding.getDeviceSerial(),
    bound: deviceBinding.isBound(),
    boundUser: binding
      ? { username: binding.username, userId: binding.meshUserId, email: binding.email }
      : null,
    deviceRegistered: deviceProfile.isRegistered(),
    singleUserPerDevice: singleUserPerDevice(),
    offlineLoginEnabled: offlineLoginEnabled(),
    activeSession: session.getActiveSession()
      ? { username: session.getActiveSession().username }
      : null,
  };
}

// Atomic Center sends the verification email synchronously before responding,
// and SMTP delivery can take well over the default proxy timeout. Use a longer
// timeout for email-sending routes so we wait for the real response instead of
// reporting a false "offline" error while the email is actually being sent.
const EMAIL_PROXY_TIMEOUT_MS = 25000;

const SIGNUP_OFFLINE_ERROR =
  'Account creation requires an internet connection to Atomic Center. Please connect and try again.';

const PASSWORD_RESET_OFFLINE_ERROR =
  'Password reset requires an internet connection to Atomic Center. Please connect and try again.';

async function probeAtomicCenterOnline() {
  const timeoutMs = getProxyTimeoutMs(8000);
  try {
    const health = await checkHealth(timeoutMs);
    if (health.ok) {
      meshcentralStatus.markReachable(health.data);
      return { online: true, health: health.data };
    }
    meshcentralStatus.markUnreachable();
    return { online: false, health: health.data || null };
  } catch (e) {
    meshcentralStatus.markUnreachable();
    return { online: false, error: e.message };
  }
}

async function buildAuthConnectivityPayload() {
  const probe = await probeAtomicCenterOnline();
  const cloudPortal = isServerlessRuntime();
  return {
    ...deviceStatusPayload(),
    online: probe.online,
    meshcentralReachable: probe.online,
    cloudPortal,
    meshcentralUrl,
    emailVerificationEnabled: probe.health?.emailVerificationEnabled === true,
    passwordResetEnabled: probe.health?.passwordResetEnabled === true,
    connectivityError: probe.error || null,
  };
}

async function isAtomicCenterOnline() {
  if (!meshcentralStatus.isStale() && meshcentralStatus.getReachable()) {
    return true;
  }
  const probe = await probeAtomicCenterOnline();
  return probe.online;
}

async function requireOnlineForPasswordReset(res) {
  const online = await isAtomicCenterOnline();
  if (online) return true;
  res.status(503).json({ error: PASSWORD_RESET_OFFLINE_ERROR });
  return false;
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readCpuPercentApprox() {
  // Approximation: 1-min load normalized by CPU cores.
  const cores = os.cpus()?.length || 1;
  const load1 = os.loadavg?.()[0] || 0;
  const pct = Math.round(Math.min(1, load1 / Math.max(1, cores)) * 100);
  return { percent: pct, load1, cores };
}

function readRamPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const percent = total > 0 ? Math.round((used / total) * 100) : null;
  return { percent, totalBytes: total, usedBytes: used };
}

function readRootDiskPercent() {
  try {
    const out = execSync('df -P /', { encoding: 'utf8' }).trim().split('\n');
    // Filesystem 1024-blocks Used Available Capacity Mounted on
    const parts = out[out.length - 1].trim().split(/\s+/);
    const cap = parts[4] || '';
    const percent = cap.endsWith('%') ? parseInt(cap.slice(0, -1), 10) : null;
    return { percent };
  } catch {
    return { percent: null };
  }
}

let lastNetSample = null;
function readNetworkUsage() {
  const raw = safeReadText('/proc/net/dev');
  if (!raw) return { rxBps: null, txBps: null };
  const lines = raw.split('\n').slice(2).filter(Boolean);
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const [ifacePart, rest] = line.split(':');
    const iface = String(ifacePart || '').trim();
    if (!iface || iface === 'lo') continue;
    const cols = String(rest || '').trim().split(/\s+/);
    const rxBytes = parseInt(cols[0] || '0', 10);
    const txBytes = parseInt(cols[8] || '0', 10);
    if (!Number.isNaN(rxBytes)) rx += rxBytes;
    if (!Number.isNaN(txBytes)) tx += txBytes;
  }
  const now = Date.now();
  let rxBps = null;
  let txBps = null;
  if (lastNetSample) {
    const dt = (now - lastNetSample.t) / 1000;
    if (dt > 0.2) {
      rxBps = Math.max(0, (rx - lastNetSample.rx) / dt);
      txBps = Math.max(0, (tx - lastNetSample.tx) / dt);
    }
  }
  lastNetSample = { t: now, rx, tx };
  return { rxBps, txBps };
}

function readDeviceTemperatureC() {
  const candidates = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/class/thermal/thermal_zone1/temp',
  ];
  for (const p of candidates) {
    const t = safeReadText(p);
    if (!t) continue;
    const v = parseInt(String(t).trim(), 10);
    if (!Number.isFinite(v)) continue;
    // Many systems expose millidegrees C.
    if (v > 1000) return Math.round((v / 1000) * 10) / 10;
    return Math.round(v * 10) / 10;
  }
  return null;
}

function readPowerStatus() {
  // Best-effort on Linux (may be absent on servers).
  const base = '/sys/class/power_supply';
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
    const battery = entries.find((e) => e.name.toLowerCase().includes('bat'));
    if (!battery) return { status: 'unknown' };
    const status = safeReadText(path.join(base, battery.name, 'status'));
    const capacity = safeReadText(path.join(base, battery.name, 'capacity'));
    return {
      status: status ? String(status).trim().toLowerCase() : 'unknown',
      batteryPercent: capacity ? parseInt(String(capacity).trim(), 10) : null,
    };
  } catch {
    return { status: 'unknown' };
  }
}

function readFirmwareVersion() {
  const osRelease = safeReadText('/etc/os-release') || '';
  const pretty = osRelease
    .split('\n')
    .find((l) => l.startsWith('PRETTY_NAME='));
  if (pretty) return pretty.split('=').slice(1).join('=').replace(/^\"|\"$/g, '');
  return `${os.type()} ${os.release()}`;
}

function readSyncStatus() {
  const online = meshcentralStatus.getReachable();
  const pending = cloudSync.getPendingCount();
  return {
    online,
    pendingQueue: pending,
    status: online ? (pending > 0 ? 'sync_pending' : 'synced') : 'offline',
  };
}

async function requireOnlineForSignup(res) {
  if (await isAtomicCenterOnline()) return true;
  res.status(503).json({ error: SIGNUP_OFFLINE_ERROR });
  return false;
}

async function verifyMeshCentralOnStartup() {
  try {
    const online = await meshcentralStatus.refresh();
    if (online) {
      console.log('MeshCentral reachable at', meshcentralUrl);
      return true;
    }
    console.warn('[Startup] MeshCentral health check failed.');
    return false;
  } catch (e) {
    const detail = e.cause?.message || e.message;
    meshcentralStatus.markUnreachable();
    console.warn('[Startup] Atomic Center not reachable — app runs locally (offline login if bound).');
    console.warn('[Startup]', detail);
    if (offlineLoginEnabled() && deviceBinding.isBound()) {
      const b = deviceBinding.getBinding();
      console.warn(`[Startup] Offline login ready for "${b.username}" (${b.meshUserId})`);
    }
    return false;
  }
}

function resolveSession(req) {
  const signed = sessionCookie.getSignedSessionFromRequest(req);
  if (signed) {
    session.restoreSessionRecord(signed);
    const sess = session.getSessionRecord(signed.sessionId);
    if (sess) return sess;
  }

  const sessionId = sessionCookie.getSessionIdFromRequest(req);
  if (sessionId) {
    const sess = session.getSessionRecord(sessionId);
    if (sess) return sess;
  }
  return null;
}

function attachSessionCookie(res, payload) {
  const data = payload?.data || payload;
  if (!data?.sessionId) return;
  const record = session.getSessionRecord(data.sessionId);
  if (record) {
    sessionCookie.attachSessionCookies(res, session.sanitizeSession(record));
  }
}

app.use(express.json());
app.use(masterControl.attachMasterContext);
serverlessLifecycle.registerExpressHooks(app);

app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const sess = resolveSession(req);
    if (sess) {
      sessionCookie.attachSessionCookies(res, session.sanitizeSession(
        session.getSessionRecord(sess.sessionId) || sess
      ));
    }
    return origJson(body);
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/master', masterControl.routes);

// Mount the master/slave + full dashboard subsystem (ported from the main app).
// Registered before the legacy routes below so its camera/overview handlers win.
dashboard.register(app, { resolveSession });

app.get('/', (_req, res) => {
  res.redirect('/login');
});

app.get('/login', async (_req, res) => {
  const boot = await buildAuthConnectivityPayload();
  const htmlPath = path.join(__dirname, 'views', 'login.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const bootScript = `<script>window.__AF_LOGIN_BOOT__=${JSON.stringify(boot)};</script>`;
  html = html.replace('<!--AF_LOGIN_BOOT-->', bootScript);
  res.type('html').send(html);
});

app.get('/signup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

async function buildPasswordResetModePayload() {
  const probe = await probeAtomicCenterOnline();
  const online = probe.online;
  const health = probe.health || {};
  const binding = deviceBinding.getBinding();
  const cloudPortal = isServerlessRuntime();
  const cloudPasswordReset = online && (
    health.passwordResetEnabled === true || cloudPortal
  );

  let mode = 'blocked';
  if (online && cloudPasswordReset) {
    mode = 'cloud';
  } else if (binding && offlineLoginEnabled() && !cloudPortal) {
    mode = 'local';
  }

  return {
    online,
    cloudPortal,
    cloudPasswordReset,
    mode,
    meshcentralUrl,
    boundUser: binding
      ? { username: binding.username, email: binding.email || null, userId: binding.meshUserId }
      : null,
  };
}

app.get('/forgot-password', async (_req, res) => {
  const boot = await buildPasswordResetModePayload();
  const htmlPath = path.join(__dirname, 'views', 'forgot-password.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const bootScript = [
    '<script>',
    `window.__AF_RESET_BOOT__=${JSON.stringify(boot)};`,
    'document.documentElement.classList.add("af-reset-ready");',
    '</script>',
    '<style>html.af-reset-ready #resetLoading{display:none!important}html.af-reset-ready #resetContent{display:block!important}</style>',
  ].join('');
  html = html.replace('<!--AF_RESET_BOOT-->', bootScript);
  res.type('html').send(html);
});

app.get('/api/password-reset/mode', async (_req, res) => {
  res.json(await buildPasswordResetModePayload());
});

app.post('/api/password-reset/local', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');

  if (!username || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Username and a new password are required.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  // Forgot-password: the user does not know their current password, so we set a
  // new one directly on this device (no old password required).
  const result = await deviceBinding.setBoundPassword({
    username,
    newPassword: password,
  });

  if (!result.ok) {
    if (result.reason === 'wrong_user') {
      return res.status(403).json({ error: 'This device is registered to another user.' });
    }
    if (result.reason === 'not_bound') {
      return res.status(404).json({ error: 'No user is registered on this device.' });
    }
    return res.status(400).json({ error: 'Could not update password on this device.' });
  }

  // Queue the change so Atomic Center's database is updated too, then try to push
  // it right away if we can reach Atomic Center. If offline, the background loop
  // will sync it automatically once the connection is restored.
  deviceBinding.queuePendingPasswordSync({
    username: result.username,
    meshUserId: result.meshUserId,
    newPassword: password,
  });

  let syncedToCloud = false;
  if (await isAtomicCenterOnline()) {
    try {
      const sync = await passwordSync.syncPending();
      syncedToCloud = sync.synced === true;
    } catch (e) {
      console.error('[API] password sync after local change failed:', e.message);
    }
  }

  res.json({
    success: true,
    message: syncedToCloud
      ? 'Password updated on this device and on Atomic Center.'
      : 'Password updated on this device. It will sync to Atomic Center automatically when you are back online.',
    localOnly: !syncedToCloud,
    pendingCloudSync: !syncedToCloud,
  });
});

app.get('/device-registration', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'device-registration.html'));
});

app.get('/dashboard', (_req, res) => {
  res.redirect('/overview');
});

app.get('/api/session', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) {
    return res.status(401).json({ authenticated: false });
  }

  let onboardingComplete = dashboardAuth.isOnboardingComplete(sess, sess.meshUserId);
  let cloudRegistrationReset = false;

  const online = await isAtomicCenterOnline();
  if (online) {
    if (onboardingComplete) {
      const cloudSyncResult = await syncOnboardingWithCloud({
        meshUserId: sess.meshUserId,
        username: sess.username,
      });
      const synced = dashboardAuth.syncFromCloud(sess, cloudSyncResult);
      if (synced) {
        session.restoreSessionRecord(session.sanitizeSession(synced));
      }
      onboardingComplete = dashboardAuth.isOnboardingComplete(
        session.getSessionRecord(sess.sessionId),
        sess.meshUserId
      );
      cloudRegistrationReset = cloudSyncResult.reset === true;
    } else {
      const restored = await dashboardAuth.ensureDeviceRegistered(sess);
      if (restored) {
        onboardingComplete = true;
      }
    }
  }

  const current = session.getSessionRecord(sess.sessionId) || sess;
  const profile = deviceProfile.getProfile();
  dashboard.ensureStandaloneSessionRole(current);
  const clusterRoleConfirmed = current.clusterRoleConfirmed === true;
  const userRoleConfirmed = current.userRoleConfirmed === true;
  const sessionRoleId = current.userRole || null;
  const savedRole = dashboardRbac.getUserRole(current.meshUserId);
  const activeRoleId = sessionRoleId || savedRole?.id || null;
  masterControl.bootstrapMasterControl({
    meshUserId: current.meshUserId,
    username: current.username,
    organizationName: profile?.organizationName,
  });
  const redirectTo = onboardingComplete
    ? dashboard.postLoginRedirect(current)
    : '/device-registration';

  sessionCookie.attachSessionCookies(res, session.sanitizeSession(current));

  res.json({
    authenticated: true,
    username: current.username,
    userId: current.meshUserId,
    email: current.email || null,
    sessionId: current.sessionId,
    deviceRegistered: dashboardAuth.isDeviceRegistered(current),
    onboardingComplete,
    clusterRoleConfirmed,
    clusterMode: dashboardAuth.getClusterMode(current),
    userRoleConfirmed,
    userRole: activeRoleId ? dashboardRbac.getRolePayload(activeRoleId) : null,
    cloudRegistrationReset,
    redirectTo,
    profile,
    masterControl: {
      enabled: masterControl.isFlagEnabled('master_control', { userId: current.meshUserId }),
      platform: masterControl.getPlatformState(),
      role: req.masterRole || null,
    },
  });
});

// NOTE: Camera APIs (/api/cameras*) are provided by the dashboard subsystem
// (lib/dashboard.js), which is registered earlier in this file.

app.get('/api/device/profile', (_req, res) => {
  const profile = deviceProfile.getProfile();
  res.json({
    registered: deviceProfile.isRegistered(),
    profile,
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: deviceBinding.getDeviceSerial(),
    meshcentralUrl,
    cloudPortal: isServerlessRuntime(),
  });
});

// Legacy /api/dashboard/stats removed — the /overview dashboard uses
// /api/overview and /api/system/stats from the dashboard subsystem instead.

app.post('/api/device/register', async (req, res) => {
  const sessRecord = resolveSession(req);
  if (!sessRecord) {
    return res.status(401).json({ error: 'You must be signed in to register this device.' });
  }

  const {
    deviceSerial,
    deviceName,
    deviceType,
    operatingSystem,
    organizationName,
    adminName,
    adminRole,
    email,
    phone,
    country,
    city,
    registerMeshCentral,
    meshGroupName,
    sudoPassword,
    atomicPassword: bodyAtomicPassword,
  } = req.body;

  const serverless = isServerlessRuntime();
  const atomicPassword = sessRecord.password || bodyAtomicPassword || null;

  const missing = [];
  if (!deviceName) missing.push('Device Name');
  if (!deviceType) missing.push('Device Type');
  if (!operatingSystem) missing.push('Operating System');
  if (!organizationName) missing.push('Organization Name');
  if (!adminName) missing.push('Administrator Name');
  if (!adminRole) missing.push('Role / Designation');
  if (!country) missing.push('Country');
  if (!city) missing.push('City');
  if (registerMeshCentral && !meshGroupName) missing.push('MeshCentral Device Group Name');
  if (
    registerMeshCentral
    && !serverless
    && canAutoInstall(operatingSystem)
    && !sudoPassword
  ) {
    missing.push('Device password (sudo)');
  }

  if (missing.length) {
    return res.status(400).json({ error: `Required fields missing: ${missing.join(', ')}.` });
  }

  if (deviceProfile.isUserOnboarded(sessRecord.meshUserId)) {
    markOnboardingComplete(sessRecord, email || sessRecord.email);
    return res.json({
      success: true,
      alreadyRegistered: true,
      message: 'You have already completed device registration.',
      profile: deviceProfile.getProfile(),
      onboardingComplete: true,
      redirectTo: '/cluster-role',
    });
  }

  const onboardingCheck = validateOnboardingEmail(sessRecord, email);
  if (!onboardingCheck.ok) {
    return res.status(400).json({ error: onboardingCheck.error });
  }

  const serial = deviceSerial || deviceBinding.getDeviceSerial();
  const profilePayload = {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: serial,
    deviceName: String(deviceName).trim(),
    deviceType: String(deviceType).trim(),
    operatingSystem: String(operatingSystem).trim(),
    organizationName: String(organizationName).trim(),
    adminName: String(adminName).trim(),
    adminRole: String(adminRole).trim(),
    email: email ? String(email).trim() : null,
    phone: phone ? String(phone).trim() : null,
    country: String(country).trim(),
    city: String(city).trim(),
    registerMeshCentral: !!registerMeshCentral,
    meshGroupName: meshGroupName ? String(meshGroupName).trim() : null,
    registeredBy: sessRecord.username,
  };

  try {
    const profile = deviceProfile.saveProfile(profilePayload);

    if (!registerMeshCentral) {
      let cloudSave = { ok: false };
      if (await isAtomicCenterOnline()) {
        cloudSave = await saveDeviceProfileToCloud({
          userId: sessRecord.meshUserId,
          username: sessRecord.username,
          profilePayload,
        });
        if (cloudSave.ok) {
          console.log('[API] Device profile saved to AWS database:', cloudSave.deviceRecordId);
        } else {
          console.warn('[API] AWS profile save failed:', cloudSave.error);
        }
      } else {
        cloudSave = { ok: false, error: 'Atomic Center is offline. Profile saved locally only.' };
      }

      if (!cloudSave.ok) {
        try {
          const queued = cloudSync.enqueueDeviceProfile({
            userId: sessRecord.meshUserId,
            username: sessRecord.username,
            profilePayload,
            reason: cloudSave.error || 'Cloud save failed',
          });
          console.warn('[API] Queued device profile for AWS sync:', queued.id);
        } catch (e) {
          console.warn('[API] Failed to queue AWS sync:', e.message);
        }
      }

      markOnboardingComplete(sessRecord, profilePayload.email);
      return res.json({
        success: true,
        message: cloudSave.ok
          ? 'Device registered and saved to Atomic Center database.'
          : 'Device registered locally. Cloud save failed — see cloudSaveError.',
        profile,
        onboardingComplete: true,
        redirectTo: '/cluster-role',
        sessionId: sessRecord.sessionId,
        profileStoredOnCloud: cloudSave.ok,
        deviceRecordId: cloudSave.deviceRecordId || null,
        cloudSaveError: cloudSave.ok ? null : cloudSave.error,
      });
    }

    if (!atomicPassword) {
      return res.status(serverless ? 400 : 401).json({
        error: serverless
          ? 'Enter your Atomo sign-in password to register this device on Atomic Center.'
          : 'Your details were saved, but the session expired. Sign in again to register on Atomic Center.',
        profile,
        requiresAtomicPassword: true,
        cloudPortal: serverless,
        sessionId: sessRecord.sessionId,
      });
    }

    try {
      const result = await runAtomicRegistration({
        username: sessRecord.username,
        atomicPassword,
        userId: sessRecord.meshUserId,
        profilePayload,
        operatingSystem,
        sudoPassword: serverless ? undefined : sudoPassword,
        skipAgentInstall: serverless,
      });

      session.clearSessionPassword(sessRecord.sessionId);
      markOnboardingComplete(sessRecord, profilePayload.email);

      const meshCloudOk = result.meshCentral?.profileStoredOnCloud === true;

      return res.json({
        success: true,
        partial: result.partial,
        cloudPortal: serverless,
        message: result.message,
        profile,
        phases: result.phases,
        meshCentral: result.meshCentral,
        agentInstall: result.agentInstall,
        onboardingComplete: true,
        redirectTo: '/cluster-role',
        sessionId: sessRecord.sessionId,
        profileStoredOnCloud: meshCloudOk,
        deviceRecordId: result.meshCentral?.deviceRecordId || null,
        cloudSaveError: meshCloudOk ? null : result.meshCentral?.cloudSaveError || null,
      });
    } catch (e) {
      console.error('[API] Atomic Center registration failed:', e.message);
      let cloudSave = { ok: false };
      if (await isAtomicCenterOnline()) {
        cloudSave = await saveDeviceProfileToCloud({
          userId: sessRecord.meshUserId,
          username: sessRecord.username,
          profilePayload,
        });
      }
      if (cloudSave.ok) {
        markOnboardingComplete(sessRecord, profilePayload.email);
      }
      return res.status(cloudSave.ok ? 200 : 503).json({
        success: cloudSave.ok,
        partial: true,
        cloudPortal: serverless,
        error: e.message,
        message: cloudSave.ok
          ? 'Profile saved to AWS. MeshCentral device group setup failed — retry registration or sign in again.'
          : e.message,
        profile,
        phases: e.phases || [],
        onboardingComplete: cloudSave.ok,
        redirectTo: cloudSave.ok ? '/cluster-role' : undefined,
        sessionId: sessRecord.sessionId,
        profileStoredOnCloud: cloudSave.ok,
        deviceRecordId: cloudSave.deviceRecordId || null,
        cloudSaveError: cloudSave.ok ? null : cloudSave.error,
      });
    }
  } catch (e) {
    console.error('[API] POST /api/device/register failed:', e.message);
    return res.status(500).json({ error: 'Failed to save device registration.' });
  }
});

app.get('/api/device/status', async (_req, res) => {
  res.json(await buildAuthConnectivityPayload());
});

app.get('/api/device/cloud-sync', async (_req, res) => {
  try {
    const online = await isAtomicCenterOnline();
    res.json({
      online,
      pending: cloudSync.getPendingCount(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force-sync the currently saved local device profile to AWS.
// Useful after an admin deletes AWS registrations but the device is already onboarded.
app.post('/api/device/cloud-sync/enqueue-current', async (req, res) => {
  let sessRecord = resolveSession(req);
  // Easy fallback: if the device is already bound (single-user device),
  // allow a forced cloud sync using the bound user identity.
  if (!sessRecord && deviceBinding.isBound()) {
    const binding = deviceBinding.getBinding();
    // Prefer the username that originally registered the device (if present),
    // because AWS will reject unknown/mismatched users.
    const localProfile = deviceProfile.getProfile();
    const preferredUsername = String(localProfile?.registeredBy || binding?.username || '').trim();
    const fallbackUser = String(binding?.username || '').trim();
    const chosen = preferredUsername || fallbackUser;
    sessRecord = chosen
      ? {
          meshUserId: binding?.meshUserId || `user//${chosen.toLowerCase()}`,
          username: chosen,
          email: binding?.email || null,
        }
      : null;
  }
  if (!sessRecord) return res.status(401).json({ ok: false, error: 'You must be signed in.' });

  const profile = deviceProfile.getProfile();
  if (!profile) {
    return res.status(400).json({ ok: false, error: 'No local device registration found to sync.' });
  }

  const profilePayload = {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: profile.deviceSerial || deviceBinding.getDeviceSerial(),
    deviceName: profile.deviceName,
    deviceType: profile.deviceType,
    operatingSystem: profile.operatingSystem,
    organizationName: profile.organizationName,
    adminName: profile.adminName,
    adminRole: profile.adminRole,
    email: profile.email || null,
    phone: profile.phone || null,
    country: profile.country,
    city: profile.city,
    registerMeshCentral: !!profile.registerMeshCentral,
    meshGroupName: profile.meshGroupName || null,
    registeredBy: profile.registeredBy || sessRecord.username,
  };

  // Try immediate save first if online, else queue.
  try {
    if (await isAtomicCenterOnline()) {
      const cloudSave = await saveDeviceProfileToCloud({
        userId: sessRecord.meshUserId,
        username: sessRecord.username,
        profilePayload,
      });
      if (cloudSave.ok) {
        return res.json({
          ok: true,
          synced: true,
          deviceRecordId: cloudSave.deviceRecordId || null,
          message: 'Profile synced to AWS.',
        });
      }
      // fall through and queue below
      cloudSync.enqueueDeviceProfile({
        userId: sessRecord.meshUserId,
        username: sessRecord.username,
        profilePayload,
        reason: cloudSave.error || 'Cloud save failed',
      });
      return res.status(202).json({
        ok: true,
        synced: false,
        queued: true,
        message: 'AWS sync queued (cloud save failed).',
        error: cloudSave.error || null,
      });
    }

    cloudSync.enqueueDeviceProfile({
      userId: sessRecord.meshUserId,
      username: sessRecord.username,
      profilePayload,
      reason: 'Atomic Center offline',
    });
    return res.status(202).json({
      ok: true,
      synced: false,
      queued: true,
      message: 'AWS is offline — sync queued.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/device/cloud-sync/run', async (_req, res) => {
  try {
    if (!(await isAtomicCenterOnline())) {
      return res.status(503).json({ ok: false, error: 'Atomic Center is offline.' });
    }
    const result = await cloudSync.processNext({ saveDeviceProfileToCloud });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const sessionId = sessionCookie.getSessionIdFromRequest(req) || req.body?.sessionId;
  session.destroySession(sessionId);
  sessionCookie.clearSessionCookies(res);
  res.json({ success: true });
});

app.get('/api/health', async (_req, res) => {
  const device = deviceStatusPayload();
  try {
    const remote = await checkHealth();
    res.json({
      ok: remote.ok,
      meshcentralUrl,
      meshcentralReachable: true,
      ...device,
      remote: remote.data,
      deviceIp: getLocalIp(),
    });
  } catch (e) {
    console.error('[API] GET /api/health failed:', e.message, e.cause?.message || '');
    const canWorkOffline = offlineLoginEnabled() && deviceBinding.isBound();
    res.status(canWorkOffline ? 200 : 503).json({
      ok: canWorkOffline,
      meshcentralUrl,
      meshcentralReachable: false,
      ...device,
      error: e.message,
      deviceIp: getLocalIp(),
    });
  }
});

app.get('/api/config', async (_req, res) => {
  try {
    const payload = await buildAuthConnectivityPayload();
    res.json(payload);
  } catch (e) {
    console.error('[API] GET /api/config failed:', e.message, e.cause?.message || '');
    res.status(503).json({
      emailVerificationEnabled: false,
      online: false,
      meshcentralReachable: false,
      cloudPortal: isServerlessRuntime(),
      error: e.message,
      ...deviceStatusPayload(),
    });
  }
});

app.post('/api/signup/init', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const { password, confirmPassword } = req.body;

  if (!username || !email || !password || !confirmPassword) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/init', 'POST', {
      username,
      email,
      password,
      confirmPassword,
    }, {}, EMAIL_PROXY_TIMEOUT_MS);

    if (result.status >= 200 && result.status < 300 && result.data.otpId) {
      pendingSignups.set(normalizeUsername(username), {
        username,
        email,
        password,
        otpId: result.data.otpId,
        createdAt: Date.now(),
      });
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/init failed:', e.message, e.cause?.message || '');
    const msg = isNetworkError(e)
      ? 'Signup requires internet to reach Atomic Center and send the verification email.'
      : e.message;
    return res.status(503).json({ error: msg });
  }
});

app.post('/api/signup/resend', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const pending = pendingSignups.get(normalizeUsername(username));

  if (!pending || !pending.otpId) {
    return res.status(404).json({ error: 'Signup session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/resend', 'POST', {
      otpId: pending.otpId,
    }, {}, EMAIL_PROXY_TIMEOUT_MS);
    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/resend failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/signup/verify-2fa', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const { token } = req.body;

  if (!username || !token) {
    return res.status(400).json({ error: 'Username and verification code are required.' });
  }

  const pending = pendingSignups.get(normalizeUsername(username));
  if (!pending) {
    return res.status(404).json({ error: 'Signup session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/verify', 'POST', {
      otpId: pending.otpId,
      token,
      username: pending.username,
    });

    if (result.status >= 200 && result.status < 300 && result.data.success) {
      try {
        const bindResult = await completeSignupBind({
          username: pending.username,
          email: pending.email,
          password: pending.password,
          userId: result.data.userId,
        });
        pendingSignups.delete(normalizeUsername(username));
        attachSessionCookie(res, bindResult);
        return sendProxy(res, bindResult);
      } catch (bindErr) {
        console.error('[Auth] Signup bind failed:', bindErr.message);
        return res.status(500).json({ error: 'Account created on server but device binding failed.' });
      }
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/verify-2fa failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/password-reset/init', async (req, res) => {
  if (!(await requireOnlineForPasswordReset(res))) return;

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();

  if (!username || !email) {
    return res.status(400).json({ error: 'Username and email are required.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/password-reset/init', 'POST', {
      username,
      email,
    }, {}, EMAIL_PROXY_TIMEOUT_MS);

    if (result.status >= 200 && result.status < 300 && result.data.sent && result.data.otpId) {
      pendingPasswordResets.set(normalizeUsername(username), {
        username: result.data.username || username,
        email: result.data.email || email,
        otpId: result.data.otpId,
        createdAt: Date.now(),
      });
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/password-reset/init failed:', e.message, e.cause?.message || '');
    const msg = isNetworkError(e)
      ? PASSWORD_RESET_OFFLINE_ERROR
      : e.message;
    return res.status(503).json({ error: msg });
  }
});

app.post('/api/password-reset/resend', async (req, res) => {
  if (!(await requireOnlineForPasswordReset(res))) return;

  const username = String(req.body.username || '').trim();
  const pending = pendingPasswordResets.get(normalizeUsername(username));

  if (!pending || !pending.otpId) {
    return res.status(404).json({ error: 'Password reset session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/password-reset/resend', 'POST', {
      otpId: pending.otpId,
    }, {}, EMAIL_PROXY_TIMEOUT_MS);
    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/password-reset/resend failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/password-reset/verify', async (req, res) => {
  if (!(await requireOnlineForPasswordReset(res))) return;

  const username = String(req.body.username || '').trim();
  const { token, password, confirmPassword } = req.body;

  if (!username || !token || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Username, verification code and new password are required.' });
  }

  const pending = pendingPasswordResets.get(normalizeUsername(username));
  if (!pending) {
    return res.status(404).json({ error: 'Password reset session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/password-reset/verify', 'POST', {
      otpId: pending.otpId,
      token,
      password,
      confirmPassword,
      username: pending.username,
    });

    if (result.status >= 200 && result.status < 300 && result.data.success) {
      pendingPasswordResets.delete(normalizeUsername(username));

      const binding = deviceBinding.getBinding();
      if (
        binding
        && binding.username.toLowerCase() === String(pending.username || username).trim().toLowerCase()
      ) {
        deviceBinding.bindUser({
          meshUserId: binding.meshUserId,
          username: binding.username,
          email: binding.email || pending.email || null,
          password,
        }).catch((bindErr) => {
          console.warn('[Auth] Local offline password update after reset failed:', bindErr.message);
        });
      }
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/password-reset/verify failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const { password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const result = await authLogin(username, password);
    attachSessionCookie(res, result);
    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/login failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

if (!isServerlessRuntime()) {
  setInterval(() => {
    pendingFlows.purgeExpired();
  }, 60 * 1000);
}

async function startServer() {
  const device = deviceStatusPayload();
  console.log('Device ID:', device.deviceId);
  if (device.bound) {
    console.log(`Device bound to: ${device.boundUser.username} (${device.boundUser.userId})`);
  } else {
    console.log('Device not bound yet — first signup/login will bind this device.');
  }

  meshcentralStatus.markUnreachable();

  const server = http.createServer(app);
  dashboard.setupWebsocket(server);

  server.listen(PORT, HOST, () => {
    const ip = getLocalIp();
    console.log(`Atomo Forge listening on ${HOST}:${PORT}`);
    console.log(`  On this device:  http://localhost:${PORT}`);
    console.log(`  On your network: http://${ip}:${PORT}`);
    console.log(`  Vision board:    ${process.env.BACKEND_API_URL || 'http://localhost:3001'}`);
    console.log(`  MeshCentral:     ${meshcentralUrl || '(not configured)'}`);
    if (offlineLoginEnabled()) {
      console.log(`  Offline login:   ${device.bound ? 'ready' : 'needs one online bind first'}`);
    }
  });

  meshcentralStatus.startBackgroundRefresh();
  verifyMeshCentralOnStartup().catch(() => {});

  cloudSync.startBackgroundSync({
    isOnline: isAtomicCenterOnline,
    saveDeviceProfileToCloud,
    intervalMs: 15000,
    maxPerTick: 3,
  });

  passwordSync.startBackgroundSync({
    isOnline: isAtomicCenterOnline,
    intervalMs: 20000,
  });
}

module.exports = app;

if (require.main === module) {
  startServer();
}
