const fs = require('fs');
const path = require('path');

function isServerlessRuntime() {
  return Boolean(
    process.env.VERCEL
    || process.env.AWS_LAMBDA_FUNCTION_NAME
    || process.env.VERCEL_ENV
  );
}

function getWritableDataDir() {
  if (process.env.ATOMO_DATA_DIR) {
    return path.resolve(process.env.ATOMO_DATA_DIR);
  }
  if (isServerlessRuntime()) {
    return path.join('/tmp', 'atomo-forge');
  }
  return path.join(__dirname, '..', 'data');
}

function ensureWritableDataDir() {
  const dir = getWritableDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sqliteJournalMode() {
  // WAL needs sibling -wal/-shm files; DELETE is safer on read-only deploy roots.
  return isServerlessRuntime() ? 'DELETE' : 'WAL';
}

module.exports = {
  isServerlessRuntime,
  getWritableDataDir,
  ensureWritableDataDir,
  sqliteJournalMode,
};
