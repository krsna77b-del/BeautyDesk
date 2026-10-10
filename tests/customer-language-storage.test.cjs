// Disposable migration/backup/restore rehearsal. Never opens the configured app
// database, loads checkout .env, starts a server, or contacts any provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const preload = path.join(__dirname, 'network-mocks.cjs');
const copy = require('../customer-copy');

function child(file, args, production = false) {
  // An explicit environment prevents inherited DB paths, Railway variables,
  // provider keys, and user credentials from entering this rehearsal.
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    DB_PATH: file,
    NODE_ENV: production ? 'production' : 'test',
    WHATSAPP_CUSTOMER_LANGUAGES: '0'
  };
  return spawnSync(process.execPath, ['--require', preload, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30000
  });
}
function migrate(file, production = false) {
  const result = child(file, ['-e', "const db=require('./db'); if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('integrity'); db.close();"], production);
  assert.equal(result.status, 0, result.stderr || String(result.error || ''));
}
function backup(file, destination) {
  const result = child(file, ['scripts/backup.cjs', destination]);
  assert.equal(result.status, 0, result.stderr || String(result.error || ''));
  assert.match(result.stdout, /Consistent backup created and integrity checked/);
}
function snapshot(db, tables) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function checkIntegrity(db) {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}
function restoreVerifiedBackup(backupFile, destination) {
  // The source is a completed SQLite backup, never the live database or its WAL.
  assert.equal(fs.existsSync(destination), false);
  fs.copyFileSync(backupFile, destination, fs.constants.COPYFILE_EXCL);
}

test('disposable legacy migration and SQLite backups restore WAL data, language preferences and confirmation context', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-language-restore-'));
  const file = path.join(dir, 'legacy.sqlite');
  const beforeBackup = path.join(dir, 'before-migration.sqlite');
  const beforeRestore = path.join(dir, 'restored-before.sqlite');
  const afterBackup = path.join(dir, 'after-migration.sqlite');
  const afterRestore = path.join(dir, 'restored-after.sqlite');
  const source = new Database(file);
  t.after(() => { if (source.open) source.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  source.pragma('journal_mode = WAL');
  source.pragma('wal_autocheckpoint = 0');
  // Recognized legacy schema, including accepted WhatsApp context, before any
  // customer-language table or columns exist. All rows are synthetic.
  source.exec(`
    CREATE TABLE clients(id TEXT PRIMARY KEY,salon TEXT NOT NULL,owner TEXT NOT NULL,email TEXT NOT NULL UNIQUE,phone TEXT,city TEXT,password_hash TEXT NOT NULL,whatsapp_enabled INTEGER NOT NULL DEFAULT 1,greeting TEXT,plan_status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL);
    CREATE TABLE services(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,name TEXT NOT NULL,price INTEGER NOT NULL,duration_mins INTEGER NOT NULL DEFAULT 60,created_at TEXT NOT NULL);
    CREATE TABLE appointments(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,customer_name TEXT NOT NULL,customer_phone TEXT,service_name TEXT NOT NULL,starts_at TEXT NOT NULL,duration_mins INTEGER NOT NULL DEFAULT 60,status TEXT NOT NULL DEFAULT 'confirmed',source TEXT NOT NULL DEFAULT 'manual',created_at TEXT NOT NULL,origin_message_id TEXT,price_at_booking INTEGER);
    CREATE TABLE messages(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,customer_phone TEXT NOT NULL,customer_name TEXT,direction TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,wa_message_id TEXT,delivery_status TEXT,delivery_error_code TEXT,accepted_at TEXT);
    CREATE TABLE whatsapp_jobs(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,customer_phone TEXT NOT NULL,customer_name TEXT NOT NULL,sender_phone_number_id TEXT,incoming_id TEXT NOT NULL,outgoing_id TEXT,state TEXT NOT NULL DEFAULT 'queued',error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,reply_context_id TEXT,UNIQUE(client_id,incoming_id));
    INSERT INTO clients VALUES('legacy','Fixture Salon','Fixture Owner','fixture@example.invalid','27820000000','Johannesburg','fixture-hash-not-a-credential',1,'Fixture greeting','active','2031-01-01T00:00:00Z');
    INSERT INTO clients VALUES('other','Other Fixture Salon','Other Owner','other@example.invalid','27820000002','Cape Town','other-fixture-hash',0,'Other greeting','active','2031-01-01T00:00:00Z');
    INSERT INTO services VALUES('service','legacy','Braids',350,90,'2031-01-01T00:00:00Z');
    INSERT INTO appointments VALUES('appointment','legacy','Fixture Customer','27820000001','Braids','2031-10-02T10:00:00+02:00',90,'confirmed','whatsapp','2031-10-01T07:00:04Z','inbound-confirmation',350);
    INSERT INTO messages VALUES('summary','legacy','27820000001','Fixture Customer','out','Please confirm your booking:\nService: Braids\nDate: 2031-10-02\nTime: 10:00 (South Africa)\nName: Fixture Customer\nPrice: R350\nDuration: 90 min\nReply YES to book, or tell me what to change.','2031-10-01T07:00:00Z','outbound-summary','accepted',NULL,'2031-10-01T07:00:01Z');
    INSERT INTO messages VALUES('confirmation','legacy','27820000001','Fixture Customer','in','YES','2031-10-01T07:00:03Z','inbound-confirmation',NULL,NULL,NULL);
    INSERT INTO whatsapp_jobs VALUES('job','legacy','27820000001','Fixture Customer','fixture-sender','inbound-confirmation',NULL,'review','fixture-review','2031-10-01T07:00:03Z','2031-10-01T07:00:04Z','summary');
  `);
  const legacyTables = ['clients','services','appointments','messages','whatsapp_jobs'];
  const legacySnapshot = snapshot(source, legacyTables);
  assert.ok(fs.statSync(file + '-wal').size > 32, 'source must have a live WAL');
  backup(file, beforeBackup);
  const baselineBackup = new Database(beforeBackup, { readonly: true, fileMustExist: true });
  try {
    checkIntegrity(baselineBackup);
    assert.deepEqual(snapshot(baselineBackup, legacyTables), legacySnapshot);
    assert.equal(baselineBackup.prepare("SELECT 1 FROM sqlite_master WHERE name='whatsapp_customer_languages'").get(), undefined);
    assert.equal(baselineBackup.pragma('table_info(messages)').some(column => column.name === 'canonical_body'), false);
  } finally { baselineBackup.close(); }

  restoreVerifiedBackup(beforeBackup, beforeRestore);
  // Check both migration of the live disposable fixture and migration of a
  // restored pre-migration backup, including repeat startup/idempotency.
  for (const target of [file, beforeRestore]) { migrate(target); migrate(target, true); }
  for (const target of [file, beforeRestore]) {
    const db = new Database(target);
    try {
      checkIntegrity(db);
      for (const table of legacyTables) {
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
        for (const [index, oldRow] of legacySnapshot[table].entries()) {
          for (const [column, value] of Object.entries(oldRow)) assert.equal(rows[index][column], value, `${table}.${column}`);
        }
      }
      assert.equal(db.prepare('SELECT count(*) n FROM whatsapp_customer_languages').get().n, 0, 'migration must not infer preferences');
      assert.equal(db.prepare('SELECT count(*) n FROM salon_settings').get().n, 0, 'migration must not initialize legacy modular booking');
      for (const table of ['customers','payments','notification_outbox']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n, 2);
    } finally { db.close(); }
  }

  source.transaction(() => {
    for (const [index, language] of ['en','zu','af','xh'].entries()) {
      source.prepare('INSERT INTO whatsapp_customer_languages(client_id,customer_phone,language,choosing,updated_at_ms) VALUES(?,?,?,0,?)')
        .run('legacy','2782000000'+index,language,1948604400000+index);
    }
    source.prepare("INSERT INTO whatsapp_customer_languages VALUES('other','27820000001','af',1,1948604400005,'fixture-photo')").run();
    for (const [id,client,optIn] of [['customer','legacy',1],['other-customer','other',0]]) {
      source.prepare('INSERT INTO customers(id,client_id,name,phone,notes,whatsapp_opt_in,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,client,'Fixture Customer','27820000001','Synthetic private note',optIn,'2031-01-01T00:00:00Z','2031-01-01T00:00:00Z');
    }
    const format = copy.m`Hi! Welcome to ${'Fixture Salon'}.\n1. Book Appointment\n2. View Services\n3. My Appointment\n4. Contact Salon\nReply with an option.`;
    source.prepare(`INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,wa_message_id,delivery_status,accepted_at,canonical_body,message_format_json,customer_language,language_control)
      VALUES('localized','legacy','27820000001','out',?,'2031-10-01T08:00:00Z','localized-provider-id','accepted','2031-10-01T08:00:01Z',?,?,'zu',0)`)
      .run(copy.render(format,'zu'),copy.render(format,'en'),JSON.stringify(format));
    source.prepare("UPDATE whatsapp_jobs SET reply_context_id='localized' WHERE id='job'").run();
  })();

  const tables = [...legacyTables,'whatsapp_customer_languages','customers','schema_migrations'];
  const upgradedSnapshot = snapshot(source, tables);
  backup(file, afterBackup); // Source remains open with committed WAL changes.
  const backupHash = crypto.createHash('sha256').update(fs.readFileSync(afterBackup)).digest('hex');
  assert.notEqual(child(file, ['scripts/backup.cjs', afterBackup]).status, 0, 'backup must refuse an existing destination');
  assert.notEqual(child(file, ['scripts/backup.cjs', file]).status, 0, 'backup must refuse the live source as destination');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(afterBackup)).digest('hex'), backupHash);
  assert.deepEqual(snapshot(source, tables), upgradedSnapshot, 'refused backups must leave source records unchanged');
  // Prove the restored snapshot is independent of later source changes.
  source.prepare("UPDATE whatsapp_customer_languages SET language='en' WHERE client_id='legacy' AND customer_phone='27820000001'").run();
  restoreVerifiedBackup(afterBackup, afterRestore);
  migrate(afterRestore, true);
  migrate(afterRestore, true);
  const restored = new Database(afterRestore, { readonly: true, fileMustExist: true });
  try {
    checkIntegrity(restored);
    assert.deepEqual(snapshot(restored, tables), upgradedSnapshot);
    const row = restored.prepare("SELECT * FROM messages WHERE id='localized'").get();
    assert.equal(copy.render(JSON.parse(row.message_format_json),'zu'),row.body);
    assert.equal(copy.render(JSON.parse(row.message_format_json),'en'),row.canonical_body);
    assert.equal(restored.prepare("SELECT reply_context_id FROM whatsapp_jobs WHERE id='job'").get().reply_context_id,'localized');
    assert.equal(restored.prepare("SELECT language FROM whatsapp_customer_languages WHERE client_id='legacy' AND customer_phone='27820000001'").get().language,'zu');
    assert.equal(restored.prepare("SELECT language FROM whatsapp_customer_languages WHERE client_id='other' AND customer_phone='27820000001'").get().language,'af');
    assert.equal(restored.prepare('SELECT count(*) n FROM notification_outbox').get().n,0);
    assert.equal(restored.prepare('SELECT count(*) n FROM appointments').get().n,1);
  } finally { restored.close(); }
});
