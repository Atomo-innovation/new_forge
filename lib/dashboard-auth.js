const deviceProfile = require('./device-profile');
const session = require('./session');
const { isServerlessRuntime } = require('./runtime-env');
const { resolveOnboardingFromCloud } = require('./cloud-registration');
const { isDemoMode } = require('./demo-mode');

function isOnboardingComplete(sess, meshUserId) {
  if (isDemoMode()) {
    return sess?.onboardingComplete === true;
  }
  const uid = meshUserId || sess?.meshUserId;
  if (uid && deviceProfile.isUserOnboarded(uid)) return true;
  if (sess?.onboardingComplete === true) return true;
  return false;
}

function getClusterMode(sess) {
  const fromDb = deviceProfile.getClusterMode();
  if (fromDb) return fromDb;
  if (sess?.clusterMode) return sess.clusterMode;
  return null;
}

function isStandalone(sess) {
  return getClusterMode(sess) === 'standalone';
}

function isDeviceRegistered(sess) {
  if (deviceProfile.isRegistered()) return true;
  return isOnboardingComplete(sess, sess?.meshUserId);
}

function computePostLoginRedirect(sess) {
  if (!sess) return '/login';
  if (isDemoMode()) {
    if (sess.onboardingComplete !== true) return '/device-registration';
    return '/overview';
  }
  if (!isOnboardingComplete(sess, sess.meshUserId)) return '/device-registration';
  if (sess.clusterRoleConfirmed !== true) return '/cluster-role';
  const mode = getClusterMode(sess);
  if (mode === 'standalone') return '/overview';
  if (sess.userRoleConfirmed !== true) return '/user-role';
  return '/overview';
}

function applySessionProgress(sessionId, patch) {
  if (!sessionId) return null;
  const updated = session.patchSession(sessionId, patch);
  return updated;
}

function syncFromCloud(sess, cloudResult) {
  if (!sess || !cloudResult) return sess;
  const patch = {};
  if (cloudResult.onboardingComplete === true) {
    patch.onboardingComplete = true;
  }
  return applySessionProgress(sess.sessionId, patch) || sess;
}

function markOnboardingComplete(sess, email) {
  if (!sess) return null;
  return applySessionProgress(sess.sessionId, { onboardingComplete: true, email: email || sess.email });
}

function markClusterRole(sess, clusterMode) {
  if (!sess) return null;
  const patch = { clusterRoleConfirmed: true };
  if (clusterMode) patch.clusterMode = clusterMode;
  return applySessionProgress(sess.sessionId, patch);
}

function markUserRole(sess, roleId) {
  if (!sess) return null;
  return applySessionProgress(sess.sessionId, {
    userRoleConfirmed: true,
    userRole: roleId || sess.userRole || null,
  });
}

async function ensureDeviceRegistered(sess) {
  if (!sess) return false;
  if (isDemoMode()) return false;
  if (isDeviceRegistered(sess)) return true;
  if (!isServerlessRuntime()) return false;

  try {
    const meshcentralStatus = require('./meshcentral-status');
    const online = await meshcentralStatus.isReachableFast({ maxWaitMs: 8000 });
    if (!online) return false;

    const cloud = await resolveOnboardingFromCloud({
      meshUserId: sess.meshUserId,
      username: sess.username,
    });
    if (!cloud.onboardingComplete) return false;
    markOnboardingComplete(sess, sess.email);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isOnboardingComplete,
  getClusterMode,
  isDeviceRegistered,
  ensureDeviceRegistered,
  computePostLoginRedirect,
  applySessionProgress,
  syncFromCloud,
  markOnboardingComplete,
  markClusterRole,
  markUserRole,
};
