const { getSessionTtlMs } = require('./device-config');
const { isServerlessRuntime } = require('./runtime-env');
const sessionToken = require('./session-token');

const ID_COOKIE = 'atomo_session';

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

function cookieFlags(maxAgeSec) {
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  if (isServerlessRuntime() || process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function setCookie(res, name, value, maxAgeSec) {
  if (!res || !value) return;
  const encoded = encodeURIComponent(value);
  res.append('Set-Cookie', `${name}=${encoded}; ${cookieFlags(maxAgeSec)}`);
}

function clearCookie(res, name) {
  if (!res) return;
  res.append('Set-Cookie', `${name}=; ${cookieFlags(0)}`);
}

function getSessionIdFromRequest(req) {
  const cookies = parseCookies(req);
  return (
    cookies[ID_COOKIE]
    || req.headers['x-session-id']
    || req.body?.sessionId
    || req.query?.sessionId
    || null
  );
}

function getSignedSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[sessionToken.COOKIE_NAME];
  return sessionToken.verify(token);
}

function setSessionCookie(res, sessionId) {
  if (!sessionId) return;
  setCookie(res, ID_COOKIE, sessionId, Math.floor(getSessionTtlMs() / 1000));
}

function setSignedSessionCookie(res, sessionRecord) {
  const tokenRecord = sessionToken.toTokenRecord(sessionRecord);
  if (!tokenRecord) return;
  const token = sessionToken.sign(tokenRecord);
  setCookie(res, sessionToken.COOKIE_NAME, token, Math.floor(getSessionTtlMs() / 1000));
}

function attachSessionCookies(res, sessionRecord) {
  if (!sessionRecord?.sessionId) return;
  setSessionCookie(res, sessionRecord.sessionId);
  setSignedSessionCookie(res, sessionRecord);
}

function clearSessionCookies(res) {
  clearCookie(res, ID_COOKIE);
  clearCookie(res, sessionToken.COOKIE_NAME);
}

module.exports = {
  ID_COOKIE,
  parseCookies,
  getSessionIdFromRequest,
  getSignedSessionFromRequest,
  setSessionCookie,
  setSignedSessionCookie,
  attachSessionCookies,
  clearSessionCookies,
};
