const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-booking-'));
process.env.DB_PATH = path.join(directory, 'test.sqlite');
delete process.env.ANTHROPIC_API_KEY;
const db = require('../db');
const ai = require('../ai');
const crypto = require('node:crypto');
const generate = input => ai.generateReply({ incomingMessageId: crypto.randomUUID(), ...input });
const now = new Date('2031-10-01T07:00:00Z'); // Wednesday, 09:00 South Africa.
const phone = '27821234567';
let client, services;
beforeEach(() => {
  db.prepare('DELETE FROM appointments').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM clients').run();
  db.prepare(`INSERT INTO clients (id,salon,owner,email,password_hash,created_at,hours) VALUES ('salon','Test Salon','Owner','owner@example.test','unused',?,?)`).run(now.toISOString(), db.DEFAULT_HOURS);
  db.prepare(`INSERT INTO services (id,client_id,name,price,duration_mins,created_at) VALUES ('braids','salon','Braids',350,90,?), ('nails','salon','Gel Nails',250,60,?)`).run(now.toISOString(), now.toISOString());
  client = db.prepare('SELECT * FROM clients').get();
  services = db.prepare('SELECT * FROM services ORDER BY id').all();
});
after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const count = () => db.prepare('SELECT count(*) AS n FROM appointments').get().n;
function chat(extra = {}) {
  const history = [];
  let tick = 0;
  return async message => {
    const currentTime = new Date(new Date(extra.now || now).getTime() + (++tick) * 1000);
    const reply = await generate({ client, services, history, incomingMessage: message, customerPhone: phone, ...extra, now: currentTime });
    history.push({ direction: 'in', body: message, created_at: currentTime.toISOString() }, { direction: 'out', body: reply.text, created_at: currentTime.toISOString(), accepted_at: currentTime.toISOString() });
    return reply.text;
  };
}
function book(overrides = {}) {
  return ai.bookAppointment('salon', { customerName: 'Lerato', customerPhone: phone, serviceName: 'Braids', durationMins: 90, dateStr: '2031-10-02', time: '10:00', now, incomingMessageId: crypto.randomUUID(), ...overrides });
}
function seed(start, duration = 90, extra = {}) {
  db.prepare(`INSERT INTO appointments (id,client_id,customer_name,customer_phone,service_name,starts_at,duration_mins,status,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(extra.id || 'existing', extra.clientId || 'salon', 'Existing', '27820000000', 'Braids', start, duration, extra.status || 'confirmed', 'test', now.toISOString());
}

test('Bookings prompts a service and never creates an appointment', async () => {
  const send = chat();
  assert.match(await send('Bookings'), /Which service.*Braids/);
  assert.equal(count(), 0);
});
test('full split-message booking preserves chosen service, date, time, name and phone; requires final confirmation', async () => {
  const send = chat();
  await send('Bookings');
  assert.match(await send('Braids'), /What day/);
  assert.match(await send('tomorrow'), /Available times.*2031-10-02/);
  assert.match(await send('11:30'), /What name.*11:30/);
  assert.match(await send('Lerato Molefe'), /Please confirm your booking:[\s\S]*Name: Lerato Molefe/);
  assert.equal(count(), 0);
  const reply = await send('YES');
  assert.match(reply, /You're booked!.*11:30/);
  const row = db.prepare('SELECT * FROM appointments').get();
  assert.equal(row.customer_phone, phone);
  assert.equal(row.customer_name, 'Lerato Molefe');
  assert.equal(row.starts_at, '2031-10-02T11:30:00+02:00');
  assert.equal(row.service_name, 'Braids');
  assert.equal(await send('YES'), reply);
  assert.equal(count(), 1);
});
test('service/day never silently books first slot', async () => {
  const send = chat({ customerName: 'Lerato' });
  assert.match(await send('Braids tomorrow'), /What time/);
  assert.equal(count(), 0);
});
test('one-message details still need summary and explicit confirmation', async () => {
  const send = chat();
  assert.match(await send('Book Braids on 2031-10-02 at 2pm. My name is Lerato'), /Time: 14:00[\s\S]*Name: Lerato/);
  assert.equal(count(), 0);
  assert.match(await send('confirm'), /You're booked/);
  assert.equal(count(), 1);
});
test('changing a proposed time causes fresh confirmation', async () => {
  const send = chat({ customerName: 'Lerato' });
  await send('Braids tomorrow at 10:00');
  assert.match(await send('Actually at 14:30'), /Time: 14:30/);
  assert.equal(count(), 0);
  await send('yes');
  assert.equal(db.prepare('SELECT starts_at FROM appointments').get().starts_at, '2031-10-02T14:30:00+02:00');
});
test('simulator full conversation never creates real appointments', async () => {
  const send = chat({ customerPhone: 'simulator', customerName: 'Lerato', dryRun: true });
  assert.match(await send('Braids tomorrow at 10:00'), /simulator; no appointment will be saved/);
  assert.match(await send('yes'), /Preview complete:.*No appointment was saved/);
  assert.equal(count(), 0);
});
test('simulator marker forces dry run even when caller omitted dryRun', () => {
  assert.equal(book({ customerPhone: 'simulator' }).dryRun, true);
  assert.equal(count(), 0);
});
test('dry run with real phone never writes', () => {
  assert.equal(book({ dryRun: true }).dryRun, true);
  assert.equal(count(), 0);
});
test('profile name is included for customer to explicitly confirm', async () => {
  const send = chat({ customerName: 'Naledi' });
  assert.match(await send('Braids tomorrow at 10am'), /Name: Naledi/);
  assert.equal(count(), 0);
});
test('generic profile placeholder is not accepted as a booking name', async () => {
  assert.match(await chat({ customerName: 'WhatsApp customer' })('Braids tomorrow at 10am'), /What name/);
});
test('invalid and past dates cannot be booked', async () => {
  assert.equal(book({ dateStr: '2031-02-30' }).reason, 'bad_datetime');
  assert.equal(book({ dateStr: '2031-09-30' }).reason, 'past_datetime');
  assert.match(await chat()('Braids on 2031-02-30 at 10am'), /date is not valid/);
  assert.match(await chat()('Braids yesterday at 10am'), /already passed/);
  assert.equal(count(), 0);
});
test('past slots today are excluded using South Africa time', () => {
  const slots = ai.getAvailableSlots('salon', client, 90, '2031-10-01', { now: new Date('2031-10-01T08:15:00Z') });
  assert.equal(slots[0], '10:30');
  assert.equal(book({ dateStr: '2031-10-01', time: '10:00', now: new Date('2031-10-01T08:15:00Z') }).reason, 'past_datetime');
});
test('relative today/tomorrow use salon date across UTC midnight', async () => {
  const send = chat({ now: new Date('2031-10-01T23:30:00Z'), customerName: 'Lerato' });
  assert.match(await send('Braids tomorrow at 10am'), /Date: 2031-10-03/);
});
test('invalid duration, unknown service, and service duration mismatch rejected', () => {
  assert.equal(book({ durationMins: -30 }).reason, 'invalid_duration');
  assert.equal(book({ durationMins: 30 }).reason, 'invalid_duration');
  assert.equal(book({ serviceName: 'Not a service' }).reason, 'unknown_service');
  assert.equal(count(), 0);
});
test('missing or placeholder phone cannot create live appointments', () => {
  assert.equal(book({ customerPhone: '' }).reason, 'missing_customer_phone');
  assert.equal(book({ customerPhone: 'whatsapp-ai' }).reason, 'missing_customer_phone');
  assert.equal(count(), 0);
});
test('closed days and appointments extending beyond close rejected', () => {
  assert.equal(book({ dateStr: '2031-10-05' }).reason, 'closed');
  assert.equal(book({ time: '08:30' }).reason, 'outside_hours');
  assert.equal(book({ time: '17:00' }).reason, 'outside_hours');
  assert.equal(count(), 0);
});
test('hours validator rejects missing days, invalid times, backwards/overnight ranges and arrays', () => {
  const original = JSON.parse(db.DEFAULT_HOURS);
  assert.equal(ai.validateHours(original).ok, true);
  for (const value of [{ mon: '09:00-18:00' }, [], { ...original, mon: '25:00-26:00' }, { ...original, mon: '18:00-09:00' }, { ...original, extra: 'closed' }, 'not json']) {
    assert.equal(ai.validateHours(value).ok, false);
  }
});
test('malformed saved hours fail closed rather than use defaults', () => {
  db.prepare("UPDATE clients SET hours='bad json'").run();
  assert.equal(book().reason, 'invalid_hours');
  const broken = db.prepare('SELECT * FROM clients').get();
  assert.deepEqual(ai.getAvailableSlots('salon', broken, 90, '2031-10-02', { now }), []);
});
test('conflicts compare instants across offsets and honor legacy salon-local records', () => {
  seed('2031-10-02T08:00:00Z'); // 10:00 South Africa
  assert.equal(book().reason, 'slot_taken');
  db.prepare('DELETE FROM appointments').run();
  seed('2031-10-02T10:00:00');
  assert.equal(book().reason, 'slot_taken');
  assert.equal(book({ time: '11:30' }).ok, true);
});
test('cross-day appointments block overlapping morning slots', () => {
  seed('2031-10-01T23:00:00+02:00', 720);
  assert.equal(book().reason, 'slot_taken');
  assert.equal(book({ time: '11:00' }).ok, true);
});
test('cancelled appointments and another salon do not block slots', () => {
  seed('2031-10-02T10:00:00+02:00', 90, { status: 'cancelled' });
  seed('2031-10-02T10:00:00+02:00', 90, { id: 'other', clientId: 'other-salon' });
  assert.equal(book().ok, true);
});
test('transaction prevents two bookings for one slot', () => {
  assert.equal(book().ok, true);
  assert.equal(book({ customerName: 'Other', customerPhone: '27829876543' }).reason, 'slot_taken');
  assert.equal(count(), 1);
});
test('availability is rechecked after confirmation, not trusted from offered list', async () => {
  const send = chat({ customerName: 'Lerato' });
  await send('Braids tomorrow at 10am');
  seed('2031-10-02T10:00:00+02:00');
  assert.match(await send('yes'), /no longer available/);
  assert.equal(count(), 1);
});
test('informational detour does not treat yes as confirmation until summary is shown again', async () => {
  const send = chat({ customerName: 'Lerato' });
  await send('Braids tomorrow at 10am');
  await send('What are your hours?');
  assert.match(await send('yes'), /Please confirm/);
  assert.equal(count(), 0);
});
test('unknown service is never substituted with first service', async () => {
  const send = chat({ customerName: 'Lerato' });
  assert.match(await send('Book lashes tomorrow at 10am'), /Which service/);
  assert.equal(count(), 0);
});
test('cancel draft does not create or claim cancellation of an existing appointment', async () => {
  const send = chat({ customerName: 'Lerato' });
  await send('Braids tomorrow at 10am');
  assert.match(await send('cancel'), /stopped this booking request.*Existing appointments are unchanged/);
  assert.equal(count(), 0);
  assert.doesNotMatch(await send('yes'), /You're booked/);
});
test('AI key cannot bypass deterministic confirmation or introduce external side effects', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-unused-no-network';
  try {
    const send = chat({ customerName: 'Lerato' });
    assert.match(await send('Braids tomorrow at 10am'), /Please confirm/);
    assert.equal(count(), 0);
    assert.match(await send('yes'), /You're booked/);
    assert.equal(count(), 1);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});
test('changed service price or duration requires a fresh summary before confirming', async () => {
  const history = [];
  async function send(message) {
    services = db.prepare('SELECT * FROM services ORDER BY id').all();
    const currentTime = new Date(now.getTime() + (history.length + 1) * 1000);
    const reply = await generate({ client, services, history, incomingMessage: message, customerName: 'Lerato', customerPhone: phone, now: currentTime });
    history.push({ direction: 'in', body: message, created_at: currentTime.toISOString() }, { direction: 'out', body: reply.text, created_at: currentTime.toISOString(), accepted_at: currentTime.toISOString() });
    return reply.text;
  }
  await send('Braids tomorrow at 10am');
  db.prepare("UPDATE services SET price=500,duration_mins=120 WHERE id='braids'").run();
  assert.match(await send('yes'), /Please confirm[\s\S]*Price: R500[\s\S]*Duration: 120 min/);
  assert.equal(count(), 0);
  assert.match(await send('yes'), /You're booked.*R500/);
});
test('weekday after for is not mistaken for a customer name', async () => {
  const send = chat({ customerName: 'Lerato' });
  assert.match(await send('Braids for Friday at 10am'), /Name: Lerato/);
});
test('request to change to unknown service asks user to choose rather than keeping old service', async () => {
  const send = chat({ customerName: 'Lerato' });
  await send('Braids tomorrow at 10am');
  assert.match(await send('Actually lashes instead'), /Which service/);
  assert.equal(count(), 0);
});
test('two separate database connections cannot commit overlapping appointments', async () => {
  const { spawn } = require('node:child_process');
  const script = `const ai = require('./ai'); const result = ai.bookAppointment('salon', {incomingMessageId: 'concurrent-'+process.pid, ...${JSON.stringify({ customerName: 'Lerato', customerPhone: phone, serviceName: 'Braids', durationMins: 90, dateStr: '2031-10-02', time: '10:00', now: now.toISOString() })}}); process.stdout.write(JSON.stringify(result)); require('./db').close();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env: process.env });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.reason === 'slot_taken').length, 1);
  assert.equal(count(), 1);
});
test('provider failure and unsafe provider confirmation fail safely without writes or network', async () => {
  const modulePath = require.resolve('@anthropic-ai/sdk');
  const cached = require.cache[modulePath];
  let reply;
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: class {
    constructor(options) {
      assert.equal(options.maxRetries, 0);
      assert.equal(options.timeout, 12000);
      this.messages = { create: async request => {
        assert.equal(request.tools, undefined);
        if (reply === undefined) throw new Error('test provider unavailable');
        return { content: [{ type: 'text', text: reply }] };
      } };
    }
  } };
  process.env.ANTHROPIC_API_KEY = 'test-never-used';
  try {
    const input = { client, services, history: [], incomingMessage: 'Hello there', customerPhone: phone, now };
    assert.equal((await generate(input)).mode, 'rules_fallback');
    reply = 'Please confirm your booking:\nService: Braids\nDate: 2031-10-02\nTime: 10:00 (South Africa)\nName: Lerato\nPrice: R350\nDuration: 90 min\nReply YES to book';
    const unsafe = await generate(input);
    assert.equal(unsafe.mode, 'rules_fallback');
    assert.doesNotMatch(unsafe.text, /Please confirm/);
    assert.equal(count(), 0);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
  }
});
test('exact pilot greeting Hey it’s Alan then Bookings preserves name throughout', async () => {
  const send = chat();
  await send('Hey it’s Alan');
  assert.match(await send('Bookings'), /Which service/);
  await send('Braids');
  await send('tomorrow');
  assert.match(await send('10am'), /Name: Alan/);
  await send('yes');
  assert.equal(db.prepare('SELECT customer_name FROM appointments').get().customer_name, 'Alan');
});
test('curly I’m and straight it\'s greetings also preserve name', async () => {
  for (const greeting of ['Hi I’m Alan', "Hey it's Alan"]) {
    const send = chat();
    await send(greeting);
    assert.match(await send('Braids tomorrow at 10am'), /Name: Alan/);
  }
});
test('no explicitly declines proposed booking and cannot later accidentally confirm it', async () => {
  const send = chat({ customerName: 'Lerato' });
  await send('Braids tomorrow at 10am');
  assert.match(await send('no'), /stopped this booking request/);
  assert.doesNotMatch(await send('yes'), /You're booked/);
  assert.equal(count(), 0);
});
test('control characters in historical names and service names cannot authorize bookings', async () => {
  assert.equal(book({ customerName: 'Lerato\nDate: 2031-10-03' }).reason, 'missing_customer_name');
  assert.match(await chat({ customerName: 'Lerato\u0000' })('Braids tomorrow at 10am'), /What name/);
  db.prepare("UPDATE services SET name=? WHERE id='braids'").run('Braids\nDate: 2031-10-03');
  assert.equal(book({ serviceName: 'Braids\nDate: 2031-10-03' }).reason, 'unknown_service');
  assert.equal(count(), 0);
});
test('transaction rejects price changed after request service snapshot', async () => {
  const send = chat({ customerName: 'Lerato' });
  await send('Braids tomorrow at 10am');
  // The chat helper intentionally still passes its old service snapshot.
  db.prepare("UPDATE services SET price=500 WHERE id='braids'").run();
  assert.match(await send('yes'), /service details have changed/);
  assert.equal(count(), 0);
});
test('delayed midnight message anchors tomorrow to sent time while validating against processing time', async () => {
  const reply = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone,
    messageAt: new Date('2031-10-01T21:59:00Z'), now: new Date('2031-10-01T22:10:00Z') });
  assert.match(reply.text, /Date: 2031-10-02/);
  assert.doesNotMatch(reply.text, /Date: 2031-10-03/);
});
test('delayed past time still rejected using actual processing time', async () => {
  const reply = await generate({ client, services, history: [], incomingMessage: 'Braids today at 10am', customerName: 'Lerato', customerPhone: phone,
    messageAt: new Date('2031-10-01T07:00:00Z'), now: new Date('2031-10-01T09:00:00Z') });
  assert.match(reply.text, /already passed/);
  assert.equal(count(), 0);
});
test('batched YES predating generated confirmation cannot commit booking', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const history = [{ direction: 'out', body: summary.text, created_at: '2031-10-01T07:00:03Z', accepted_at: '2031-10-01T07:00:03Z' }];
  const reply = await generate({ client, services, history, incomingMessage: 'yes', customerName: 'Lerato', customerPhone: phone,
    messageAt: new Date('2031-10-01T07:00:01Z'), now: new Date('2031-10-01T07:00:04Z') });
  assert.match(reply.text, /Please confirm/);
  assert.equal(count(), 0);
  history.push({ direction: 'in', body: 'yes', created_at: '2031-10-01T07:00:01Z' }, { direction: 'out', body: reply.text, created_at: '2031-10-01T07:00:04Z', accepted_at: '2031-10-01T07:00:04Z' });
  const later = await generate({ client, services, history, incomingMessage: 'yes', customerName: 'Lerato', customerPhone: phone,
    messageAt: new Date('2031-10-01T07:00:10Z'), now: new Date('2031-10-01T07:00:10Z') });
  assert.match(later.text, /You're booked/);
  assert.equal(count(), 1);
});
test('failed reply to a correction cannot make later YES book the stale earlier summary', async () => {
  const initial = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const history = [
    { direction: 'out', body: initial.text, created_at: now.toISOString(), accepted_at: now.toISOString() },
    { direction: 'in', body: 'Actually at 11am', created_at: now.toISOString() },
    // The outbound correction is absent because Meta failed delivery.
  ];
  const reply = await generate({ client, services, history, incomingMessage: 'yes', customerName: 'Lerato', customerPhone: phone, now });
  assert.match(reply.text, /Please confirm[\s\S]*Time: 11:00/);
  assert.equal(count(), 0);
});
test('same-second real reply received after acceptance is conservatively re-prompted', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const reply = await generate({ client, services, history: [{ direction: 'out', body: summary.text, created_at: '2031-10-01T07:00:03.500Z', accepted_at: '2031-10-01T07:00:03.500Z' }],
    incomingMessage: 'yes', customerPhone: phone, customerName: 'Lerato', messageAt: new Date('2031-10-01T07:00:03.000Z'), receivedAt: new Date('2031-10-01T07:00:03.700Z'), now: new Date('2031-10-01T07:00:04Z') });
  assert.match(reply.text, /Please confirm/);
  assert.equal(count(), 0);
});
test('same-second batched YES is rejected when server received it before summary existed', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const reply = await generate({ client, services, history: [{ direction: 'out', body: summary.text, created_at: '2031-10-01T07:00:03.500Z', accepted_at: '2031-10-01T07:00:03.500Z' }],
    incomingMessage: 'yes', customerPhone: phone, customerName: 'Lerato', messageAt: new Date('2031-10-01T07:00:03.000Z'), receivedAt: new Date('2031-10-01T07:00:03.100Z'), now: new Date('2031-10-01T07:00:04Z') });
  assert.match(reply.text, /Please confirm/);
  assert.equal(count(), 0);
});
test('opening-hours question with a date is answered without starting a booking', async () => {
  const send = chat();
  assert.match(await send('Are you open tomorrow?'), /open on 2031-10-02 from 09:00 to 18:00/);
  assert.match(await send('Are you open Sunday?'), /closed on 2031-10-05/);
  assert.equal(count(), 0);
});
test('real YES must follow actual Meta acceptance rather than summary creation', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const history = [{ id: 'summary', direction: 'out', body: summary.text, created_at: '2031-10-01T07:00:01Z', accepted_at: '2031-10-01T07:00:03Z' }];
  const reply = await generate({ client, services, history, incomingMessage: 'yes', customerPhone: phone, customerName: 'Lerato',
    messageAt: new Date('2031-10-01T07:00:02Z'), receivedAt: new Date('2031-10-01T07:00:02.500Z'), now: new Date('2031-10-01T07:00:04Z') });
  assert.match(reply.text, /Please confirm/);
  assert.equal(count(), 0);
});
test('legacy summary without acceptance timestamp cannot authorize a real booking', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const reply = await generate({ client, services, history: [{ direction: 'out', body: summary.text, created_at: now.toISOString() }], incomingMessage: 'yes', customerPhone: phone, now });
  assert.match(reply.text, /Please confirm/);
  assert.equal(count(), 0);
});
test('immutable arrival context rejects null, old or mismatched summary IDs, even at same millisecond', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const history = [{ id: 'current-summary', direction: 'out', body: summary.text, created_at: now.toISOString(), accepted_at: now.toISOString() }];
  for (const confirmationMessageId of [null, 'old-summary']) {
    const reply = await generate({ client, services, history, incomingMessage: 'yes', customerPhone: phone, confirmationMessageId, now: new Date(now.getTime() + 1000) });
    assert.match(reply.text, /Please confirm/);
    assert.equal(count(), 0);
  }
  assert.match((await generate({ client, services, history, incomingMessage: 'yes', customerPhone: phone, confirmationMessageId: 'current-summary', now: new Date(now.getTime() + 1000) })).text, /You're booked/);
  assert.equal(count(), 1);
});
test('durable origin makes repeated same booking idempotent and changed details fail closed', () => {
  const first = book({ incomingMessageId: 'unique-customer-yes' });
  assert.equal(first.ok, true);
  const again = book({ incomingMessageId: 'unique-customer-yes' });
  assert.equal(again.alreadyBooked, true);
  assert.equal(again.id, first.id);
  assert.equal(book({ incomingMessageId: 'unique-customer-yes', time: '14:00' }).reason, 'origin_already_used');
  assert.equal(book({ incomingMessageId: 'unique-customer-yes', customerPhone: '27829876543' }).reason, 'origin_already_used');
  assert.equal(count(), 1);
  assert.equal(db.prepare('SELECT origin_message_id FROM appointments').get().origin_message_id, 'unique-customer-yes');
});
test('missing real WhatsApp origin cannot create an untraceable booking', () => {
  assert.equal(book({ incomingMessageId: undefined }).reason, 'missing_message_id');
  assert.equal(count(), 0);
});
test('failed final confirmation cannot leave old draft usable for a second appointment', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  book({ incomingMessageId: 'committed-yes' });
  const latestBooking = db.prepare('SELECT * FROM appointments').get();
  const history = [
    { direction: 'out', body: summary.text, accepted_at: now.toISOString(), created_at: now.toISOString() },
    { direction: 'in', body: 'yes', wa_message_id: 'committed-yes', created_at: now.toISOString() },
    // The real appointment exists, but its failed/unknown outbound reply is excluded.
  ];
  const context = { client, services, history, customerPhone: phone, latestBooking, allowAdditionalBooking: false, now };
  assert.match((await generate({ ...context, incomingMessage: 'Actually at 14:00' })).text, /already recorded.*contact the salon/i);
  assert.match((await generate({ ...context, incomingMessage: 'YES' })).text, /already recorded/);
  assert.equal(count(), 1);
});
test('unresolved committed booking blocks even explicit separate booking; information stays available', async () => {
  book({ incomingMessageId: 'committed-yes' });
  const latestBooking = db.prepare('SELECT * FROM appointments').get();
  const context = { client, services, history: [], customerPhone: phone, customerName: 'Lerato', latestBooking, allowAdditionalBooking: true, bookingNeedsReview: true, now };
  assert.match((await generate({ ...context, incomingMessage: 'new booking Braids tomorrow at 14:00' })).text, /needs to review/);
  assert.match((await generate({ ...context, incomingMessage: 'prices' })).text, /Here's what we offer/);
  assert.equal(count(), 1);
});
test('explicit separate appointment after resolved commit starts a clean draft and still requires accepted summary', async () => {
  book({ incomingMessageId: 'committed-yes' });
  const latestBooking = db.prepare('SELECT * FROM appointments').get();
  const later = new Date('2031-10-01T07:01:00Z');
  const context = { client, services, customerPhone: phone, customerName: 'Lerato', latestBooking, allowAdditionalBooking: true, bookingNeedsReview: false, now: later };
  const reply = await generate({ ...context, history: [], incomingMessage: 'new booking Braids tomorrow at 14:00' });
  assert.match(reply.text, /Please confirm[\s\S]*Time: 14:00/);
  const confirmed = await generate({ ...context, history: [{ direction: 'out', id: 'new-summary', body: reply.text, created_at: later.toISOString(), accepted_at: later.toISOString() }],
    incomingMessage: 'YES', incomingMessageId: 'new-yes', confirmationMessageId: 'new-summary', now: new Date(later.getTime() + 1000) });
  assert.match(confirmed.text, /You're booked/);
  assert.equal(count(), 2);
});
test('cancelled latest booking cannot resurrect an old draft or its origin', async () => {
  book({ incomingMessageId: 'committed-yes' });
  db.prepare("UPDATE appointments SET status='cancelled'").run();
  const latestBooking = db.prepare('SELECT * FROM appointments').get();
  assert.match((await generate({ client, services, history: [], latestBooking, allowAdditionalBooking: false, customerPhone: phone, incomingMessage: 'Actually at 14:00', now })).text, /was cancelled/);
  assert.equal(book({ incomingMessageId: 'committed-yes' }).reason, 'origin_already_used');
  assert.equal(count(), 1);
});
test('cross-tenant committed booking context is neither exposed nor used to authorize a write', async () => {
  book();
  const latestBooking = { ...db.prepare('SELECT * FROM appointments').get(), client_id: 'another-salon', service_name: 'Private service' };
  const reply = await generate({ client, services, history: [], latestBooking, allowAdditionalBooking: true, customerPhone: phone, incomingMessage: 'YES', now });
  assert.match(reply.text, /cannot verify/i);
  assert.doesNotMatch(reply.text, /Private service/);
  assert.equal(count(), 1);
});
test('additional booking intent is explicit, tri-state and safely revocable', () => {
  for (const phrase of ['new booking', 'I want another appointment', 'Please make a separate booking']) assert.equal(ai.additionalBookingIntent(phrase), true);
  for (const phrase of ['not a new booking', "don't make another booking", 'no separate appointment', 'cancel', 'no', 'stop', 'please cancel this request', "don't book"]) assert.equal(ai.additionalBookingIntent(phrase), false);
  for (const phrase of ['Hello', 'Braids', '14:00', 'YES', 'prices']) assert.equal(ai.additionalBookingIntent(phrase), null);
});
test('local separate-booking intent is revoked by a later no or negation', async () => {
  book({ incomingMessageId: 'committed-yes' });
  const latestBooking = db.prepare('SELECT * FROM appointments').get();
  for (const cancel of ['no', 'not a new booking']) {
    const history = [
      { direction: 'in', body: 'new booking', created_at: '2031-10-01T07:00:01Z' },
      { direction: 'in', body: cancel, created_at: '2031-10-01T07:00:02Z' },
    ];
    const reply = await generate({ client, services, history, latestBooking, customerPhone: phone, incomingMessage: 'Braids tomorrow at 14:00', now: new Date('2031-10-01T07:00:03Z') });
    assert.match(reply.text, /already recorded/);
  }
  assert.equal(count(), 1);
});
test('idempotent origin preserves committed price and rejects changed expected price', () => {
  assert.equal(book({ incomingMessageId: 'unique-yes', expectedPrice: 350 }).ok, true);
  assert.equal(db.prepare('SELECT price_at_booking FROM appointments').get().price_at_booking, 350);
  db.prepare("UPDATE services SET price=500 WHERE id='braids'").run();
  const repeated = book({ incomingMessageId: 'unique-yes', expectedPrice: 350 });
  assert.equal(repeated.alreadyBooked, true);
  assert.equal(repeated.price, 350);
  assert.equal(book({ incomingMessageId: 'unique-yes', expectedPrice: 500 }).reason, 'origin_already_used');
  assert.equal(count(), 1);
});
test('same-second delayed pre-acceptance YES cannot authorize despite matching receipt snapshot', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const history = [{ id: 'summary', direction: 'out', body: summary.text, created_at: '2031-10-01T07:00:03.100Z', accepted_at: '2031-10-01T07:00:03.700Z' }];
  const reply = await generate({ client, services, history, incomingMessage: 'YES', customerPhone: phone, confirmationMessageId: 'summary',
    messageAt: new Date('2031-10-01T07:00:03Z'), receivedAt: new Date('2031-10-01T07:00:03.900Z'), now: new Date('2031-10-01T07:00:04Z') });
  assert.match(reply.text, /Please confirm/);
  assert.equal(count(), 0);
});
test('real next-second confirmation succeeds when original timestamp, receipt and snapshot all agree', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const history = [{ id: 'summary', direction: 'out', body: summary.text, created_at: '2031-10-01T07:00:03.100Z', accepted_at: '2031-10-01T07:00:03.700Z' }];
  const reply = await generate({ client, services, history, incomingMessage: 'YES', customerPhone: phone, confirmationMessageId: 'summary',
    messageAt: new Date('2031-10-01T07:00:04Z'), receivedAt: new Date('2031-10-01T07:00:04.100Z'), now: new Date('2031-10-01T07:00:04.200Z') });
  assert.match(reply.text, /You're booked/);
  assert.equal(count(), 1);
});
test('simulator retains same-second preview confirmation without a real appointment write', async () => {
  const context = { client, services, customerName: 'Lerato', customerPhone: 'simulator', dryRun: true, now };
  const summary = await generate({ ...context, history: [], incomingMessage: 'Braids tomorrow at 10am' });
  const reply = await generate({ ...context, history: [{ direction: 'out', body: summary.text, created_at: now.toISOString() }], incomingMessage: 'YES' });
  assert.match(reply.text, /Preview complete/);
  assert.equal(count(), 0);
});
test('timing retry explains the wait; repeated fast replies never write and later reply books once', async () => {
  const summary = await generate({ client, services, history: [], incomingMessage: 'Braids tomorrow at 10am', customerName: 'Lerato', customerPhone: phone, now });
  const history = [{ id: 'summary-0', direction: 'out', body: summary.text, created_at: '2031-10-01T07:00:03.100Z', accepted_at: '2031-10-01T07:00:03.700Z' }];
  for (let i = 0; i < 3; i++) {
    const reply = await generate({ client, services, history, incomingMessage: 'YES', customerPhone: phone, confirmationMessageId: `summary-${i}`,
      messageAt: new Date('2031-10-01T07:00:03Z'), receivedAt: new Date('2031-10-01T07:00:03.900Z'), now: new Date('2031-10-01T07:00:03.900Z') });
    assert.match(reply.text, /^Please confirm your booking:/);
    assert.match(reply.text, /Please check these details, wait two seconds, then reply YES again/);
    assert.equal(count(), 0);
    history.push({ direction: 'in', body: 'YES', created_at: '2031-10-01T07:00:03Z' },
      { id: `summary-${i + 1}`, direction: 'out', body: reply.text, created_at: '2031-10-01T07:00:03.900Z', accepted_at: '2031-10-01T07:00:03.900Z' });
  }
  const confirmed = await generate({ client, services, history, incomingMessage: 'YES', customerPhone: phone, confirmationMessageId: 'summary-3',
    messageAt: new Date('2031-10-01T07:00:06Z'), receivedAt: new Date('2031-10-01T07:00:06.100Z'), now: new Date('2031-10-01T07:00:06.100Z') });
  assert.match(confirmed.text, /You're booked/);
  assert.equal(count(), 1);
});
