const { proxyJson, checkHealth, isNetworkError } = require('./meshcentral-client');
const meshcentralStatus = require('./meshcentral-status');
const deviceBinding = require('./device-binding');
const deviceProfile = require('./device-profile');
const { syncOnboardingWithCloud, resolveOnboardingFromCloud } = require('./cloud-registration');
const session = require('./session');
const dashboardAuth = require('./dashboard-auth');
const { isDemoMode } = require('./demo-mode');
const { offlineLoginEnabled } = require('./device-config');
const { getProxyTimeoutMs } = require('./runtime-env');

function guessMeshUserId(username) {
  return `user//${String(username).trim().toLowerCase()}`;
}

function resolveAccountEmail({ email, username }) {
  if (email) return email;
  const binding = deviceBinding.getBinding();
  if (binding?.username?.toLowerCase() === String(username || '').trim().toLowerCase()) {
    return binding.email || null;
  }
  return null;
}

function buildLoginSuccess({ username, meshUserId, mode, offline, password, email, onboardingComplete }) {
  const accountEmail = resolveAccountEmail({ email, username });
  const sess = session.createSession({
    meshUserId,
    username,
    password,
    email: accountEmail,
  });
  const prefix = offline ? '(offline) ' : '';
  let complete = false;
  if (!isDemoMode()) {
    complete = onboardingComplete != null
      ? onboardingComplete
      : deviceProfile.isUserOnboarded(meshUserId);
  }
  if (complete && !isDemoMode()) {
    dashboardAuth.applySessionProgress(sess.sessionId, { onboardingComplete: true });
  }
  const record = session.getSessionRecord(sess.sessionId);
  return {
    status: 200,
    data: {
      success: true,
      message: `${prefix}Welcome back, ${username}!`,
      username,
      userId: meshUserId,
      email: accountEmail,
      offline: !!offline,
      mode,
      sessionId: sess.sessionId,
      onboardingComplete: complete,
      redirectTo: dashboardAuth.computePostLoginRedirect(record),
    },
  };
}

async function bindAfterAuth({ meshUserId, username, email, password }) {
  const uid = meshUserId || guessMeshUserId(username);
  const existing = deviceBinding.getBinding();

  // Online login: bind on first use, refresh hash for same user; other users may sign in without rebinding.
  if (existing && existing.meshUserId !== uid) {
    return null;
  }

  await deviceBinding.bindUser({
    meshUserId: uid,
    username,
    email: email || existing?.email || null,
    password,
  });

  return null;
}

async function tryOfflineLogin(username, password) {
  const allowed = deviceBinding.checkUserAllowed(username);
  if (!allowed.ok) {
    return { status: allowed.status, data: { error: allowed.error } };
  }

  const local = await deviceBinding.authenticateBound(username, password);
  if (local.ok) {
    const accountEmail = resolveAccountEmail({ username: local.username });
    return buildLoginSuccess({
      username: local.username,
      meshUserId: local.meshUserId,
      mode: 'offline',
      offline: true,
      password,
      email: accountEmail,
    });
  }

  if (local.reason === 'not_bound') {
    return {
      status: 503,
      data: {
        error:
          'No internet and this device has no registered user. Sign up or log in once while online.',
      },
    };
  }

  if (local.reason === 'wrong_user') {
    const binding = deviceBinding.getBinding();
    return {
      status: 403,
      data: {
        error: `This device is registered to "${binding.username}". Only that user can sign in here.`,
      },
    };
  }

  return {
    status: 401,
    data: { error: 'Invalid username or password.' },
  };
}

async function login(username, password) {
  if (offlineLoginEnabled() && deviceBinding.isBound() && !meshcentralStatus.getReachable()) {
    console.warn('[Auth] Atomic Center offline (cached) — offline login for bound user');
    return tryOfflineLogin(username, password);
  }

  try {
    const result = await proxyJson('/api/atomoforge/login', 'POST', { username, password }, {}, getProxyTimeoutMs(2500));

    if (result.status >= 200 && result.status < 300 && result.data.success) {
      meshcentralStatus.markReachable();
      const meshUserId = result.data.userId || guessMeshUserId(result.data.username || username);
      const loggedInUsername = result.data.username || username;
      const accountEmail = resolveAccountEmail({
        email: result.data.email,
        username: loggedInUsername,
      });
      await bindAfterAuth({
        meshUserId,
        username: loggedInUsername,
        email: accountEmail,
        password,
      });

      let onboardingComplete = false;
      if (!isDemoMode()) {
        onboardingComplete = deviceProfile.isUserOnboarded(meshUserId);
        if (onboardingComplete) {
          const cloudSync = await syncOnboardingWithCloud({
            meshUserId,
            username: loggedInUsername,
          });
          onboardingComplete = cloudSync.onboardingComplete;
        } else {
          const cloudOnboard = await resolveOnboardingFromCloud({
            meshUserId,
            username: loggedInUsername,
          });
          onboardingComplete = cloudOnboard.onboardingComplete;
        }
      }

      return buildLoginSuccess({
        username: loggedInUsername,
        meshUserId,
        mode: 'remote',
        offline: false,
        password,
        email: accountEmail,
        onboardingComplete,
      });
    }

    return result;
  } catch (e) {
    if (!offlineLoginEnabled() || !isNetworkError(e)) {
      throw e;
    }

    meshcentralStatus.markUnreachable();
    console.warn('[Auth] MeshCentral unreachable — offline login for bound user');

    return tryOfflineLogin(username, password);
  }
}

async function completeSignupBind({ username, email, password, userId }) {
  const meshUserId = userId || guessMeshUserId(username);
  await bindAfterAuth({ meshUserId, username, email, password });
  return buildLoginSuccess({
    username,
    meshUserId,
    mode: 'remote',
    offline: false,
    password,
    email,
    onboardingComplete: false,
  });
}

module.exports = {
  login,
  completeSignupBind,
};
