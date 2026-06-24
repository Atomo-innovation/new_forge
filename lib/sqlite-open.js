const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureWritableDataDir, sqliteJournalMode } = require('./runtime-env');

const connections = new Map();

function openSqliteDatabase(dbPath) {
  const resolved = path.resolve(dbPath);
  const cached = connections.get(resolved);
  if (cached) return cached;

  ensureWritableDataDir();
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma(`journal_mode = ${sqliteJournalMode()}`);
  db.pragma('busy_timeout = 5000');
  connections.set(resolved, db);
  return db;
}

function closeAllConnections() {
  for (const db of connections.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  connections.clear();
}

module.exports = { openSqliteDatabase, closeAllConnections };
