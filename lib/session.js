const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { singleSessionEnabled, getSessionTtlMs, getWritableDataDir } = require('./device-config');
const { isServerlessRuntime } = require('./runtime-env');

let activeSession = null;

function getSessionFile() {
  return path.join(getWritableDataDir(), 'active-session.json');
}

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(getSessionFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    // Never persist password. Session is for UI auth + cloud sync after restarts.
    if (parsed.password) delete parsed.password;
    if (parsed.sessionId && parsed.meshUserId && parsed.username && parsed.expiresAt) {
      activeSession = parsed;
    }
  } catch {
    // ignore
  }
}

function saveToDisk() {
  try {
    const sessionFile = getSessionFile();
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const safe = activeSession ? sanitizeSession(activeSession) : null;
    if (!safe) return;
    fs.writeFileSync(sessionFile, JSON.stringify(safe, null, 2));
    if (isServerlessRuntime()) {
      const { flushToBlob } = require('./vercel-persist');
      flushToBlob().catch((err) => {
        console.warn('[Session] blob flush failed:', err.message);
      });
    }
  } catch {
    // ignore
  }
}

function clearOnDisk() {
  try {
    fs.unlinkSync(getSessionFile());
  } catch {
    // ignore
  }
}

loadFromDisk();

function reloadFromDisk() {
  activeSession = null;
  loadFromDisk();
}

function createSession({ meshUserId, username, password, email }) {
  if (!singleSessionEnabled()) {
    return { sessionId: null, meshUserId, username, email: email || null };
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  activeSession = {
    sessionId,
    meshUserId,
    username,
    email: email || null,
    password: password || null,
    clusterRoleConfirmed: false,
    userRoleConfirmed: false,
    userRole: null,
    createdAt: now,
    expiresAt: now + getSessionTtlMs(),
  };
  saveToDisk();
  return sanitizeSession(activeSession);
}

function sanitizeSession(sess) {
  if (!sess) return null;
  const { password, ...safe } = sess;
  return { ...safe };
}

function getSessionRecord(sessionId) {
  if (!singleSessionEnabled() || !activeSession) return null;
  if (sessionId && activeSession.sessionId !== sessionId) return null;
  if (Date.now() > activeSession.expiresAt) {
    activeSession = null;
    clearOnDisk();
    return null;
  }
  return activeSession;
}

function getSession(sessionId) {
  return sanitizeSession(getSessionRecord(sessionId));
}

function clearSessionPassword(sessionId) {
  const sess = getSessionRecord(sessionId);
  if (!sess) return;
  delete sess.password;
}

function destroySession(sessionId) {
  if (!activeSession) return false;
  if (sessionId && activeSession.sessionId !== sessionId) return false;
  activeSession = null;
  clearOnDisk();
  return true;
}

function getActiveSession() {
  return getSession(activeSession?.sessionId);
}

function destroyAllSessions() {
  activeSession = null;
  clearOnDisk();
  return true;
}

function confirmClusterRole(sessionId) {
  const sess = getSessionRecord(sessionId);
  if (!sess) return false;
  sess.clusterRoleConfirmed = true;
  saveToDisk();
  return true;
}

function isClusterRoleConfirmed(sessionId) {
  const sess = getSessionRecord(sessionId);
  return sess ? sess.clusterRoleConfirmed === true : false;
}

function confirmUserRole(sessionId, roleId) {
  const sess = getSessionRecord(sessionId);
  if (!sess) return false;
  sess.userRoleConfirmed = true;
  sess.userRole = roleId;
  saveToDisk();
  return true;
}

function isUserRoleConfirmed(sessionId) {
  const sess = getSessionRecord(sessionId);
  return sess ? sess.userRoleConfirmed === true : false;
}

function getSessionUserRole(sessionId) {
  const sess = getSessionRecord(sessionId);
  return sess?.userRole || null;
}

module.exports = {
  createSession,
  getSession,
  getSessionRecord,
  clearSessionPassword,
  destroySession,
  destroyAllSessions,
  getActiveSession,
  confirmClusterRole,
  isClusterRoleConfirmed,
  confirmUserRole,
  isUserRoleConfirmed,
  getSessionUserRole,
  reloadFromDisk,
};
