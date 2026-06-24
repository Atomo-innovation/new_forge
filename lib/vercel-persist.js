const fs = require('fs');
const path = require('path');
const { ensureWritableDataDir, getWritableDataDir, isServerlessRuntime } = require('./runtime-env');
const { FILE_NAMES, blobPath } = require('./persisted-files');

function isBlobPersistenceEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function hydrateFromBlob() {
  if (!isServerlessRuntime() || !isBlobPersistenceEnabled()) {
    return false;
  }

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
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(dir, name), buf);
    }
    return true;
  } catch (err) {
    console.warn('[VercelPersist] hydrate failed:', err.message);
    return false;
  }
}

async function flushToBlob() {
  if (!isServerlessRuntime() || !isBlobPersistenceEnabled()) {
    return false;
  }

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
      const body = fs.readFileSync(localPath);
      await put(blobPath(name), body, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    }
    return true;
  } catch (err) {
    console.warn('[VercelPersist] flush failed:', err.message);
    return false;
  }
}

module.exports = {
  isBlobPersistenceEnabled,
  hydrateFromBlob,
  flushToBlob,
};
