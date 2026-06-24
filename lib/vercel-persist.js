const fs = require('fs');
const path = require('path');
const { ensureWritableDataDir, getWritableDataDir, isServerlessRuntime } = require('./runtime-env');
const { FILE_NAMES, blobPath } = require('./persisted-files');

const KV_SNAPSHOT_KEY = 'atomo-forge:snapshot';

function isBlobPersistenceEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function isKvPersistenceEnabled() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function readLocalSnapshot() {
  const dir = getWritableDataDir();
  const snapshot = {};
  for (const name of FILE_NAMES) {
    const localPath = path.join(dir, name);
    if (!fs.existsSync(localPath)) continue;
    snapshot[name] = fs.readFileSync(localPath).toString('base64');
  }
  return snapshot;
}

function writeLocalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  ensureWritableDataDir();
  const dir = getWritableDataDir();
  for (const name of FILE_NAMES) {
    if (!snapshot[name]) continue;
    fs.writeFileSync(path.join(dir, name), Buffer.from(snapshot[name], 'base64'));
  }
}

async function hydrateFromKv() {
  if (!isServerlessRuntime() || !isKvPersistenceEnabled()) return false;
  try {
    const { kv } = require('@vercel/kv');
    const snapshot = await kv.get(KV_SNAPSHOT_KEY);
    if (!snapshot) return false;
    writeLocalSnapshot(snapshot);
    return true;
  } catch (err) {
    console.warn('[VercelPersist] KV hydrate failed:', err.message);
    return false;
  }
}

async function flushToKv() {
  if (!isServerlessRuntime() || !isKvPersistenceEnabled()) return false;
  try {
    const { kv } = require('@vercel/kv');
    const snapshot = readLocalSnapshot();
    if (!Object.keys(snapshot).length) return false;
    await kv.set(KV_SNAPSHOT_KEY, snapshot);
    return true;
  } catch (err) {
    console.warn('[VercelPersist] KV flush failed:', err.message);
    return false;
  }
}

async function hydrateFromBlob() {
  if (!isServerlessRuntime() || !isBlobPersistenceEnabled()) return false;

  ensureWritableDataDir();
  const dir = getWritableDataDir();

  let list;
  try {
    ({ list } = require('@vercel/blob'));
  } catch (err) {
    console.warn('[VercelPersist] @vercel/blob not available:', err.message);
    return false;
  }

  try {
    const { blobs } = await list({ prefix: 'atomo-forge/' });
    const byName = new Map();
    for (const blob of blobs || []) {
      const name = path.basename(blob.pathname || '');
      if (name) byName.set(name, blob);
    }

    for (const name of FILE_NAMES) {
      const blob = byName.get(name);
      if (!blob?.url) continue;
      const res = await fetch(blob.url);
      if (!res.ok) continue;
      fs.writeFileSync(path.join(dir, name), Buffer.from(await res.arrayBuffer()));
    }
    return true;
  } catch (err) {
    console.warn('[VercelPersist] blob hydrate failed:', err.message);
    return false;
  }
}

async function flushToBlobOnly() {
  if (!isServerlessRuntime() || !isBlobPersistenceEnabled()) return false;

  const dir = getWritableDataDir();
  let put;
  try {
    ({ put } = require('@vercel/blob'));
  } catch (err) {
    console.warn('[VercelPersist] @vercel/blob not available:', err.message);
    return false;
  }

  try {
    for (const name of FILE_NAMES) {
      const localPath = path.join(dir, name);
      if (!fs.existsSync(localPath)) continue;
      await put(blobPath(name), fs.readFileSync(localPath), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    }
    return true;
  } catch (err) {
    console.warn('[VercelPersist] blob flush failed:', err.message);
    return false;
  }
}

async function hydrateFromRemote() {
  if (await hydrateFromKv()) return true;
  return hydrateFromBlob();
}

async function flushToRemote() {
  if (await flushToKv()) return true;
  return flushToBlobOnly();
}

module.exports = {
  isBlobPersistenceEnabled,
  isKvPersistenceEnabled,
  hydrateFromBlob: hydrateFromRemote,
  flushToBlob: flushToRemote,
};
