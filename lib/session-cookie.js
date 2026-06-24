const { getSessionTtlMs } = require('./device-config');
const { isServerlessRuntime } = require('./runtime-env');

const COOKIE_NAME = 'atomo_session';

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function getSessionIdFromRequest(req) {
  const cookies = parseCookies(req);
  return (
    req.body?.sessionId
    || req.query?.sessionId
    || req.headers['x-session-id']
    || cookies[COOKIE_NAME]
    || null
  );
}

function setSessionCookie(res, sessionId) {
  if (!sessionId || !res) return;
  const maxAgeSec = Math.floor(getSessionTtlMs() / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isServerlessRuntime() || process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  if (!res) return;
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isServerlessRuntime() || process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  getSessionIdFromRequest,
  setSessionCookie,
  clearSessionCookie,
};
