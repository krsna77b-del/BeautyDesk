const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-modular-review-'));
process.env.DB_PATH = path.join(directory, 'review.db');
process.env.JWT_SECRET = 'review-only-jwt-secret-at-least-32-characters';
const salon = require('../modules/salon');
const db = salon.db;
after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const id = crypto.randomUUID();
  const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(day => [day, '09:00-18:00']));
  db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,created_at,hours) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'Review Salon ' + id, 'Original Technician', id + '@example.invalid', 'unused', new Date().toISOString(), JSON.stringify(hours));
  salon.ensureSalon(id);
  const staff = salon.staff(id)[0];
  const service = salon.saveService(id, { name: 'Original Service', price: 300, durationMins: 60, depositAmount: 50, staffIds: [staff.id] });
  const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  return { id, staff, service, date };
}

function quote(f, overrides = {}) {
  return salon.createQuote(f.id, { serviceId: f.service.id, staffId: f.staff.id, date: f.date, time: '10:00', customerName: 'Public Caller', customerPhone: '27820001234', ...overrides });
}

function confirm(f, q, idempotencyKey = crypto.randomUUID()) {
  return salon.confirmQuote(f.id, { quoteId: q.quoteId, confirmed: true, idempotencyKey });
}

function concurrent(action, id, bodies) {
  const modulePath = path.resolve(__dirname, '../modules/salon');
  return Promise.all(bodies.map(body => new Promise((resolve, reject) => {
    const source = `const d=require(${JSON.stringify(modulePath)});try{const result=d[${JSON.stringify(action)}](${JSON.stringify(id)},${JSON.stringify(body)});console.log(JSON.stringify({ok:true,id:result.id}));}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}finally{d.db.close();}`;
    const child = spawn(process.execPath, ['-e', source], { cwd: path.dirname(modulePath), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value);
    child.stderr.on('data', value => stderr += value);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `Child exited ${code}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
  })));
}

test('public booking without email does not disclose or overwrite a matching private CRM contact', () => {
  const f = fixture();
  const customer = salon.upsertCustomer(f.id, { name: 'Private Existing Customer', phone: '27820001234', email: 'private-history@example.invalid', whatsappOptIn: true });
  const result = confirm(f, quote(f));
  assert.equal(result.booking.customerName, 'Public Caller');
  assert.equal(result.booking.customerEmail || '', '');
  const stored = db.prepare('SELECT name,email,whatsapp_opt_in FROM customers WHERE client_id=? AND id=?').get(f.id, customer.id);
  assert.deepEqual(stored, { name: 'Private Existing Customer', email: 'private-history@example.invalid', whatsapp_opt_in: 1 });
  assert.equal(salon.fromToken(result.manageToken).booking.customerEmail || '', '');
});

test('public booking retains its supplied email without changing an existing CRM identity or consent', () => {
  const f = fixture();
  const customer = salon.upsertCustomer(f.id, { name: 'Private Existing Customer', phone: '27820001234', email: 'private-history@example.invalid', whatsappOptIn: false });
  const result = confirm(f, quote(f, { customerEmail: 'caller@example.invalid', whatsappOptIn: true }));
  assert.equal(result.booking.customerName, 'Public Caller');
  assert.equal(result.booking.customerEmail, 'caller@example.invalid');
  const stored = db.prepare('SELECT name,email,whatsapp_opt_in FROM customers WHERE client_id=? AND id=?').get(f.id, customer.id);
  assert.deepEqual(stored, { name: 'Private Existing Customer', email: 'private-history@example.invalid', whatsapp_opt_in: 0 });
  salon.upsertCustomer(f.id, { name: 'Private Revised Customer', phone: '27820001234', email: 'private-new@example.invalid' });
  assert.equal(salon.fromToken(result.manageToken).booking.customerEmail, 'caller@example.invalid');
});

test('a public quote cannot confirm a silently renamed service or technician', () => {
  for (const change of ['service', 'staff']) {
    const f = fixture();
    const q = quote(f);
    if (change === 'service') salon.saveService(f.id, { name: 'Changed Service' }, f.service.id);
    else salon.saveStaff(f.id, { name: 'Changed Technician' }, f.staff.id);
    assert.throws(() => confirm(f, q), error => error.status === 409);
    assert.equal(db.prepare('SELECT count(*) n FROM appointments WHERE client_id=?').get(f.id).n, 0);
  }
});

test('invalid legacy service durations fail closed before advertising or booking capacity', () => {
  for (const duration of [0, -30, 721, 'invalid']) {
    const f = fixture();
    db.prepare('UPDATE services SET duration_mins=? WHERE client_id=? AND id=?').run(duration, f.id, f.service.id);
    assert.equal(salon.checkSlot(f.id, f.service.id, f.date, '10:00').ok, false, String(duration));
    assert.throws(() => quote(f));
    assert.equal(db.prepare('SELECT count(*) n FROM appointments WHERE client_id=?').get(f.id).n, 0);
  }
});

test('quotes are tenant scoped, expire, and retain immutable price/duration/deposit snapshots', () => {
  const f = fixture(), other = fixture();
  const q = quote(f);
  assert.throws(() => confirm(other, q), error => error.status === 404);
  const a = confirm(f, q).booking;
  salon.saveService(f.id, { price: 500, durationMins: 90, depositAmount: 100 }, f.service.id);
  const persisted = salon.appointment(f.id, a.id);
  assert.equal(persisted.price, 300);
  assert.equal(persisted.durationMins, 60);
  assert.equal(persisted.depositAmount, 50);
  assert.equal(confirm(f, q).booking.id, a.id);
  const expiring = quote(other);
  db.prepare('UPDATE booking_quotes SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expiring.quoteId);
  assert.throws(() => confirm(other, expiring), error => error.message === 'quote_expired');
  assert.equal(db.prepare('SELECT count(*) n FROM appointments WHERE client_id=?').get(other.id).n, 0);
});

test('cancellation atomically supersedes queued notifications and never processes an old reminder', () => {
  const f = fixture();
  const a = confirm(f, quote(f, { whatsappOptIn: true })).booking;
  const previous = db.prepare('SELECT id FROM notification_outbox WHERE client_id=? AND appointment_id=?').all(f.id, a.id);
  assert.equal(previous.length, 2);
  const cancelled = salon.changeAppointment(f.id, a.id, { status: 'cancelled', version: a.version });
  assert.equal(cancelled.version, 2);
  const future = new Date(Date.parse(`${f.date}T10:00:00+02:00`) + 86400000);
  salon.processMockNotifications(future);
  const rows = db.prepare('SELECT * FROM notification_outbox WHERE client_id=? AND appointment_id=?').all(f.id, a.id);
  for (const old of previous) assert.equal(rows.find(row => row.id === old.id).status, 'superseded');
  const cancellation = rows.filter(row => row.kind === 'cancelled');
  assert.equal(cancellation.length, 1);
  assert.equal(cancellation[0].status, 'mock_ready');
  assert.match(cancellation[0].body, /Status: cancelled/);
  assert(rows.every(row => !['sent', 'delivered'].includes(row.status)));
  salon.changeAppointment(f.id, a.id, { status: 'cancelled', version: a.version });
  salon.processMockNotifications(future);
  assert.equal(db.prepare('SELECT count(*) n FROM notification_outbox WHERE client_id=? AND appointment_id=?').get(f.id, a.id).n, rows.length);
});

test('independent SQLite connections cannot double-book one technician or duplicate a retry', async () => {
  const f = fixture();
  const base = { serviceId: f.service.id, staffId: f.staff.id, date: f.date, time: '10:00', customerName: 'Race Customer', customerPhone: '27820001234', confirmed: true };
  const attempts = await concurrent('createAppointment', f.id, Array.from({ length: 4 }, () => ({ ...base, idempotencyKey: crypto.randomUUID() })));
  assert.equal(attempts.filter(value => value.ok).length, 1, JSON.stringify(attempts));
  assert(attempts.filter(value => !value.ok).every(value => value.error === 'slot_taken'), JSON.stringify(attempts));
  const retryBody = { ...base, time: '12:00', idempotencyKey: crypto.randomUUID() };
  const retries = await concurrent('createAppointment', f.id, Array.from({ length: 4 }, () => retryBody));
  assert(retries.every(value => value.ok), JSON.stringify(retries));
  assert.equal(new Set(retries.map(value => value.id)).size, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments WHERE client_id=?').get(f.id).n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM appointment_events WHERE client_id=?').get(f.id).n, 2);
});

test('concurrent manual receipts and refunds cannot exceed the booking value or paid balance', async () => {
  const f = fixture();
  const a = confirm(f, quote(f)).booking;
  const receipt = { appointmentId: a.id, amount: 150, kind: 'payment', method: 'cash' };
  const receipts = await concurrent('recordPayment', f.id, Array.from({ length: 3 }, () => ({ ...receipt, idempotencyKey: crypto.randomUUID() })));
  assert.equal(receipts.filter(value => value.ok).length, 2, JSON.stringify(receipts));
  assert.equal(receipts.find(value => !value.ok).error, 'payment_exceeds_booking_value');
  assert.equal(salon.appointment(f.id, a.id).paidAmount, 300);
  const refund = { appointmentId: a.id, amount: 100, kind: 'refund', method: 'cash' };
  const refunds = await concurrent('recordPayment', f.id, Array.from({ length: 4 }, () => ({ ...refund, idempotencyKey: crypto.randomUUID() })));
  assert.equal(refunds.filter(value => value.ok).length, 3, JSON.stringify(refunds));
  assert.equal(refunds.find(value => !value.ok).error, 'refund_exceeds_payments');
  assert.equal(salon.appointment(f.id, a.id).paidAmount, 0);
});
