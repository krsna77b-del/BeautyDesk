const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/beautydesk.db';
if (process.env.NODE_ENV === 'production') {
  if (!path.isAbsolute(DB_PATH)) throw new Error('Production DB_PATH must be absolute.');
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if ((process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PUBLIC_DOMAIN) && !mount) throw new Error('Railway persistent volume is not mounted; refusing ephemeral storage.');
  if (mount) {
    const relative = path.relative(path.resolve(mount), path.resolve(DB_PATH));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('DB_PATH must be a file inside the mounted Railway volume.');
  }
  if (!fs.existsSync(DB_PATH)) throw new Error('Existing production database not found. Verify the mount and restore/migrate the existing database; refusing to create an empty replacement.');
  // Validate the restored file before opening a writable connection or applying migrations.
  // An existing zero-byte/unrelated SQLite file must not become a fresh production account store.
  const existing = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const required = { clients: ['id', 'salon', 'owner', 'email', 'password_hash'], services: ['id', 'client_id', 'name'], appointments: ['id', 'client_id', 'starts_at'] };
    for (const [table, columns] of Object.entries(required)) {
      const present = existing.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      if (columns.some(column => !present.includes(column))) throw new Error('Existing production database is not a recognized BeautyDesk database. Restore the verified backup before starting.');
    }
    if (existing.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Existing production database failed integrity check.');
  } finally { existing.close(); }

}
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  salon TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signups (
  id TEXT PRIMARY KEY,
  salon TEXT NOT NULL,
  owner TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'R799/mo',
  status TEXT NOT NULL DEFAULT 'pending',
  client_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  salon TEXT NOT NULL,
  owner TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  city TEXT,
  password_hash TEXT NOT NULL,
  whatsapp_enabled INTEGER NOT NULL DEFAULT 1,
  greeting TEXT,
  plan_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  duration_mins INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  service_name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  duration_mins INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// --- lightweight migrations: add columns to `clients` if this DB predates them ---
function addColumnIfMissing(table, columnDef) {
  const colName = columnDef.split(' ')[0];
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === colName);
  if (!existing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}
addColumnIfMissing('clients', "hours TEXT");
addColumnIfMissing('clients', "auth_version INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing('clients', "wa_phone_number_id TEXT");
addColumnIfMissing('clients', "wa_access_token TEXT");
addColumnIfMissing('clients', "wa_verify_token TEXT");

// Existing rows stay unverified; old outbound logs are not delivery evidence.
addColumnIfMissing('messages', "wa_message_id TEXT");
addColumnIfMissing('messages', "delivery_status TEXT");
addColumnIfMissing('messages', "delivery_error_code TEXT");
addColumnIfMissing('messages', "accepted_at TEXT");
addColumnIfMissing('appointments', "origin_message_id TEXT");
addColumnIfMissing('appointments', "price_at_booking INTEGER");
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS appointments_origin_message
  ON appointments(client_id, origin_message_id) WHERE origin_message_id IS NOT NULL`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_id
  ON messages(client_id, direction, wa_message_id) WHERE wa_message_id IS NOT NULL`);

// Receipts can arrive before the POST /messages response returns its message ID.
db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_receipts (
  client_id TEXT NOT NULL,
  wa_message_id TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  delivery_error_code TEXT,
  PRIMARY KEY (client_id, wa_message_id)
)`);

// Durable inbox/outbox: a webhook is acknowledged only after this transaction commits.
db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  sender_phone_number_id TEXT,
  incoming_id TEXT NOT NULL,
  outgoing_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, incoming_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_jobs_state ON whatsapp_jobs(state, created_at);
CREATE INDEX IF NOT EXISTS appointment_client_time ON appointments(client_id, starts_at);
CREATE INDEX IF NOT EXISTS message_conversation ON messages(client_id, customer_phone, created_at);`);

addColumnIfMissing('whatsapp_jobs', 'sender_phone_number_id TEXT');
addColumnIfMissing('whatsapp_jobs', 'reply_context_id TEXT');

// Photo workflow is opt-in at host, salon and service levels. No image bytes,
// media URLs or free-form vision response are stored in this database.
addColumnIfMissing('clients', 'photo_estimates_enabled INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('services', 'photo_eligible INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('services', 'photo_category TEXT');
addColumnIfMissing('services', 'photo_description TEXT');
addColumnIfMissing('messages', "incoming_type TEXT NOT NULL DEFAULT 'text'");
addColumnIfMissing('messages', 'photo_session_id TEXT');
addColumnIfMissing('appointments', "quote_kind TEXT NOT NULL DEFAULT 'menu_price'");
addColumnIfMissing('appointments', 'photo_session_id TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS photo_uploads (
  client_id TEXT NOT NULL, customer_phone TEXT NOT NULL, incoming_id TEXT NOT NULL,
  media_id TEXT NOT NULL, sha256 TEXT, expires_at TEXT NOT NULL,
  PRIMARY KEY(client_id,incoming_id)
);
CREATE TABLE IF NOT EXISTS photo_sessions (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, customer_phone TEXT NOT NULL,
  source_message_id TEXT NOT NULL, stage TEXT NOT NULL, expires_at TEXT NOT NULL,
  reply_id TEXT, consent_at TEXT, consent_message_id TEXT, photo_role TEXT,
  candidates_json TEXT, selected_json TEXT, selection_message_id TEXT,
  UNIQUE(client_id,customer_phone)
);
CREATE INDEX IF NOT EXISTS photo_uploads_expiry ON photo_uploads(expires_at);
CREATE INDEX IF NOT EXISTS photo_sessions_expiry ON photo_sessions(expires_at);`);

const DEFAULT_HOURS = JSON.stringify({
  mon: '09:00-18:00', tue: '09:00-18:00', wed: '09:00-18:00', thu: '09:00-18:00',
  fri: '09:00-18:00', sat: '09:00-14:00', sun: 'closed',
});

module.exports = db;
module.exports.DEFAULT_HOURS = DEFAULT_HOURS;

require('./modules/migrations')(db);
