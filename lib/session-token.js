const crypto = require('crypto');

const COOKIE_NAME = 'atomo_sess';

function getSecret() {
  return (
    process.env.SESSION_SECRET
    || process.env.ATOMOFORGE_API_KEY
    || 'atomo-forge-session-dev-only'
  );
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data?.sessionId || !data?.meshUserId || !data?.username || !data?.expiresAt) return null;
    if (Date.now() > data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}

function toTokenRecord(sess) {
  if (!sess?.sessionId) return null;
  return {
    sessionId: sess.sessionId,
    meshUserId: sess.meshUserId,
    username: sess.username,
    email: sess.email || null,
    clusterRoleConfirmed: sess.clusterRoleConfirmed === true,
    userRoleConfirmed: sess.userRoleConfirmed === true,
    userRole: sess.userRole || null,
    onboardingComplete: sess.onboardingComplete === true,
    clusterMode: sess.clusterMode || null,
    createdAt: sess.createdAt,
    expiresAt: sess.expiresAt,
  };
}

module.exports = {
  COOKIE_NAME,
  sign,
  verify,
  toTokenRecord,
};
