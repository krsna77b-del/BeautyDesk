const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/beautydesk.db';
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
addColumnIfMissing('clients', "wa_phone_number_id TEXT");
addColumnIfMissing('clients', "wa_access_token TEXT");
addColumnIfMissing('clients', "wa_verify_token TEXT");

// Existing rows stay unverified; old outbound logs are not delivery evidence.
addColumnIfMissing('messages', "wa_message_id TEXT");
addColumnIfMissing('messages', "delivery_status TEXT");
addColumnIfMissing('messages', "delivery_error_code TEXT");
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

const DEFAULT_HOURS = JSON.stringify({
  mon: '09:00-18:00', tue: '09:00-18:00', wed: '09:00-18:00', thu: '09:00-18:00',
  fri: '09:00-18:00', sat: '09:00-14:00', sun: 'closed',
});

module.exports = db;
module.exports.DEFAULT_HOURS = DEFAULT_HOURS;
