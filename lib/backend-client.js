/**
 * Shared Vision Backend (Backend_Atomo_fordge) HTTP client.
 */

const BACKEND_URL = (process.env.BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');

let cachedToken = process.env.BACKEND_API_TOKEN || null;
let tokenExpiresAt = 0;

async function loginForToken() {
  const username = process.env.BACKEND_API_USER || 'admin';
  const password = process.env.BACKEND_API_PASSWORD || 'admin123';

  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    throw new Error(`Backend login failed (${res.status})`);
  }

  const data = await res.json();
  if (!data.token) {
    throw new Error('Backend login did not return a token');
  }

  cachedToken = data.token;
  tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

async function getBackendToken() {
  if (process.env.BACKEND_API_TOKEN) {
    return process.env.BACKEND_API_TOKEN;
  }
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }
  return loginForToken();
}

async function backendFetch(path, options = {}) {
  const token = await getBackendToken();
  const url = path.startsWith('http') ? path : `${BACKEND_URL}${path.startsWith('/') ? path : `/${path}`}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body && !(options.headers || {})['Content-Type']
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(options.headers || {}),
    },
    body:
      options.body && typeof options.body === 'object' && !(options.body instanceof Buffer)
        ? JSON.stringify(options.body)
        : options.body,
  });

  if (res.status === 401 && !process.env.BACKEND_API_TOKEN) {
    cachedToken = null;
    tokenExpiresAt = 0;
    const retryToken = await loginForToken();
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${retryToken}`,
        ...(options.body && typeof options.body === 'object'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(options.headers || {}),
      },
      body:
        options.body && typeof options.body === 'object' && !(options.body instanceof Buffer)
          ? JSON.stringify(options.body)
          : options.body,
    });
  }

  return res;
}

async function backendJson(path, options = {}) {
  const res = await backendFetch(path, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = data?.error || data?.message || `Backend request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function isBackendReachable() {
  try {
    await backendJson('/api/detect/status');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  BACKEND_URL,
  backendFetch,
  backendJson,
  isBackendReachable,
};
