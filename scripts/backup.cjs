// Usage: DB_PATH=/existing/volume/beautydesk.db node scripts/backup.cjs /safe/path/backup.db
// SQLite backup includes committed WAL changes; never copy a live .db file alone.
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
(async () => {
  const source = process.env.DB_PATH, destination = process.argv[2];
  if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) throw Error('Specify absolute DB_PATH and backup destination.');
  if (path.resolve(source) === path.resolve(destination) || fs.existsSync(destination)) throw Error('Refusing to overwrite a source or existing backup.');
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); } finally { db.close(); }
  fs.chmodSync(destination, 0o600);
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try { if (backup.pragma('quick_check', { simple: true }) !== 'ok') throw Error('Backup failed integrity check.'); }
  finally { backup.close(); }
  console.log('Consistent backup created and integrity checked. Store an authorized off-host copy securely.');
})().catch(() => { console.error('Backup failed. Check source/destination paths, permissions, free space and integrity. Existing database is unchanged.'); process.exitCode = 1; });
