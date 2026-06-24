const deviceProfile = require('./device-profile');
const session = require('./session');
const { isServerlessRuntime } = require('./runtime-env');

function isOnboardingComplete(sess, meshUserId) {
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
  if (isServerlessRuntime() && sess?.onboardingComplete === true) return true;
  return false;
}

function computePostLoginRedirect(sess) {
  if (!sess) return '/login';
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

module.exports = {
  isOnboardingComplete,
  getClusterMode,
  isDeviceRegistered,
  computePostLoginRedirect,
  applySessionProgress,
  syncFromCloud,
  markOnboardingComplete,
  markClusterRole,
  markUserRole,
};
