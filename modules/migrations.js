// Additive, transactional migrations. Legacy tenant identity remains clients.id.
module.exports = function migrate(db) {
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const add = (table, field) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === field.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${field}`); };
  db.transaction(() => {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version=1').get()) return;
    for (const field of ["category TEXT NOT NULL DEFAULT 'General'", "description TEXT NOT NULL DEFAULT ''", 'deposit_amount INTEGER NOT NULL DEFAULT 0', 'active INTEGER NOT NULL DEFAULT 1']) add('services', field);
    for (const field of ['service_id TEXT', 'staff_id TEXT', 'customer_id TEXT', 'deposit_amount INTEGER NOT NULL DEFAULT 0', 'version INTEGER NOT NULL DEFAULT 1', 'manage_nonce TEXT', 'updated_at TEXT']) add('appointments',field);
    db.exec(`
      CREATE TABLE salon_settings(client_id TEXT PRIMARY KEY REFERENCES clients(id),slug TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',cancellation_hours INTEGER NOT NULL DEFAULT 24,reschedule_hours INTEGER NOT NULL DEFAULT 24,booking_enabled INTEGER NOT NULL DEFAULT 0,onboarded INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'Africa/Johannesburg',created_at TEXT NOT NULL);
      CREATE TABLE staff(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),name TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,hours TEXT NOT NULL,breaks TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,UNIQUE(client_id,id));
      CREATE TABLE staff_services(client_id TEXT NOT NULL,staff_id TEXT NOT NULL,service_id TEXT NOT NULL,PRIMARY KEY(client_id,staff_id,service_id),FOREIGN KEY(client_id,staff_id) REFERENCES staff(client_id,id));
      CREATE TABLE staff_time_off(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,staff_id TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',FOREIGN KEY(client_id,staff_id) REFERENCES staff(client_id,id));
      CREATE TABLE customers(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,opt_in_at TEXT,opt_out_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(client_id,phone),UNIQUE(client_id,id));
      CREATE TABLE payments(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),appointment_id TEXT NOT NULL,customer_id TEXT,amount INTEGER NOT NULL CHECK(amount>0),kind TEXT NOT NULL CHECK(kind IN ('deposit','payment','refund')),method TEXT NOT NULL CHECK(method IN ('cash','bank_transfer','card_external')),reference TEXT NOT NULL DEFAULT '',idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(client_id,idempotency_key));
      CREATE TABLE appointment_events(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,appointment_id TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(client_id,appointment_id,version,kind));
      CREATE TABLE notification_outbox(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,appointment_id TEXT NOT NULL,event_id TEXT NOT NULL,kind TEXT NOT NULL,due_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',reason TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,processed_at TEXT,UNIQUE(event_id,kind));
      CREATE TABLE booking_quotes(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,appointment_id TEXT);
      CREATE TABLE booking_requests(client_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,appointment_id TEXT NOT NULL,PRIMARY KEY(client_id,idempotency_key));
      CREATE TABLE subscriptions(client_id TEXT PRIMARY KEY REFERENCES clients(id),status TEXT NOT NULL CHECK(status IN ('trial','active','payment_failed','cancelled')),plan_label TEXT NOT NULL DEFAULT 'R799/month example offer',billing_mode TEXT NOT NULL DEFAULT 'manual',trial_ends_at TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE admin_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,client_id TEXT,action TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX staff_tenant ON staff(client_id,active);
      CREATE INDEX customer_tenant_search ON customers(client_id,name);
      CREATE INDEX appointments_staff_time ON appointments(client_id,staff_id,starts_at);
      CREATE INDEX outbox_due ON notification_outbox(status,due_at);
      CREATE INDEX events_tenant ON appointment_events(client_id,created_at);
    `);
    db.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run('Modular salon management, shared booking and mock notifications',new Date().toISOString());
  }).immediate();
  db.transaction(() => {
    if(db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) return;
    add('appointments',"customer_email TEXT NOT NULL DEFAULT ''");
    db.prepare('INSERT INTO schema_migrations VALUES(2,?,?)').run('Appointment contact snapshots protect public confirmation privacy',new Date().toISOString());
  }).immediate();
};
