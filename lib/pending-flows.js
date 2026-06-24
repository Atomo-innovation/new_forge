const fs = require('fs');
const path = require('path');
const { getWritableDataDir, isServerlessRuntime } = require('./runtime-env');

const signups = new Map();
const resets = new Map();
const TTL_MS = 15 * 60 * 1000;

function storePath() {
  return path.join(getWritableDataDir(), 'pending-flows.json');
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function purgeExpired() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, value] of signups.entries()) {
    if (value.createdAt < cutoff) signups.delete(key);
  }
  for (const [key, value] of resets.entries()) {
    if (value.createdAt < cutoff) resets.delete(key);
  }
}

function save() {
  purgeExpired();
  try {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          signups: Object.fromEntries(signups),
          resets: Object.fromEntries(resets),
        },
        null,
        2
      )
    );
  } catch (err) {
    console.warn('[PendingFlows] save failed:', err.message);
  }
}

function load() {
  signups.clear();
  resets.clear();
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    for (const [key, value] of Object.entries(raw.signups || {})) {
      signups.set(key, value);
    }
    for (const [key, value] of Object.entries(raw.resets || {})) {
      resets.set(key, value);
    }
    purgeExpired();
  } catch {
    // no saved flows yet
  }
}

function setSignup(key, value) {
  signups.set(key, value);
  if (isServerlessRuntime()) save();
}

function getSignup(key) {
  purgeExpired();
  return signups.get(key) || null;
}

function deleteSignup(key) {
  signups.delete(key);
  if (isServerlessRuntime()) save();
}

function setReset(key, value) {
  resets.set(key, value);
  if (isServerlessRuntime()) save();
}

function getReset(key) {
  purgeExpired();
  return resets.get(key) || null;
}

function deleteReset(key) {
  resets.delete(key);
  if (isServerlessRuntime()) save();
}

if (!isServerlessRuntime()) {
  load();
}

module.exports = {
  load,
  save,
  purgeExpired,
  normalizeUsername,
  setSignup,
  getSignup,
  deleteSignup,
  setReset,
  getReset,
  deleteReset,
};
