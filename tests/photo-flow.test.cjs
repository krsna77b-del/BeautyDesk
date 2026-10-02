// Fully offline consent/state-machine tests. Provider hooks only see synthetic bytes.
const { test, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-photo-flow-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'test.sqlite');
process.env.PHOTO_PRIVACY_URL = 'https://salon.example.invalid/photo-privacy';
delete process.env.ANTHROPIC_API_KEY;
const db = require('../db');
const { createPhotoFlow, eligibleServices, cleanup, bindReply, snapshot, TTL_MS } = require('../photo-flow');
const PHONE = '27820000001';
const OTHER_PHONE = '27820000002';
const DETAILS = 'I want a neat shoulder-length cut; my current hair is long with no colour or extensions.';
let base, sequence;
const nextId = prefix => `${prefix}.${++sequence}`;
const stamp = ms => new Date(ms).toISOString();
function client(id = 'salon-a') { return db.prepare('SELECT * FROM clients WHERE id=?').get(id); }
function service(id = 'cut') { return db.prepare('SELECT * FROM services WHERE id=?').get(id); }
function session(id = 'salon-a', phone = PHONE) {
  return db.prepare('SELECT * FROM photo_sessions WHERE client_id=? AND customer_phone=?').get(id, phone);
}
function uploads(id = 'salon-a', phone = PHONE) {
  return db.prepare('SELECT * FROM photo_uploads WHERE client_id=? AND customer_phone=?').all(id, phone);
}
function appointmentCount() { return db.prepare('SELECT count(*) AS n FROM appointments').get().n; }
function addUpload({ id = 'salon-a', phone = PHONE, incomingId = nextId('image'), expiresAt = stamp(base + TTL_MS), mediaId = nextId('media'), sha256 = 'fake-digest' } = {}) {
  db.prepare('INSERT INTO photo_uploads(client_id,customer_phone,incoming_id,media_id,sha256,expires_at) VALUES(?,?,?,?,?,?)')
    .run(id, phone, incomingId, mediaId, sha256, expiresAt);
  return incomingId;
}
function harness(options = {}) {
  const id = options.id || 'salon-a', phone = options.phone || PHONE;
  const calls = { retrieve: [], analyze: [], status: 0 }, images = [];
  let clock = base, latestPrompt;
  const flow = createPhotoFlow({
    status: () => { calls.status++; return options.status ? options.status() : { ready: true }; },
    retrieve: async args => {
      calls.retrieve.push(args);
      const image = { buffer: Buffer.from('synthetic image bytes only'), mimeType: 'image/jpeg' };
      images.push(image);
      if (options.retrieve) return options.retrieve(args, image);
      return image;
    },
    analyze: async (image, catalog, context) => {
      calls.analyze.push({ image, catalog, context });
      if (options.analyze) return options.analyze(image, catalog, context);
      return { confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'] };
    },
  });
  function input(text, extra = {}) {
    clock += 3000;
    const value = {
      client: client(id), customerPhone: phone, incomingType: 'text', incomingMessage: text,
      incomingMessageId: nextId('in'), confirmationMessageId: latestPrompt,
      messageAt: stamp(clock), receivedAt: stamp(clock + 100), now: new Date(clock + 100),
      ...extra,
    };
    db.prepare('INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,wa_message_id,incoming_type) VALUES(?,?,?,?,?,?,?,?)')
      .run(nextId('message'), value.client.id, value.customerPhone, 'in', String(value.incomingMessage || ''), value.messageAt, value.incomingMessageId, value.incomingType);
    return value;
  }
  function accept(result, extra = {}) {
    if (!result?.text) return;
    const outgoingId = nextId('out');
    const outgoing = { clientId: id, phone, direction: 'out', acceptedAt: stamp(clock + 200), status: 'accepted', ...extra };
    db.prepare('INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,accepted_at,delivery_status) VALUES(?,?,?,?,?,?,?,?)')
      .run(outgoingId, outgoing.clientId, outgoing.phone, outgoing.direction, result.text, stamp(clock + 200), outgoing.acceptedAt, outgoing.status);
    bindReply(result.photoSessionId, id, phone, outgoingId);
    latestPrompt = outgoingId;
    return outgoingId;
  }
  async function send(text, extra = {}, acceptOptions) {
    const value = input(text, extra), result = await flow.handle(value);
    if (acceptOptions !== false) accept(result, acceptOptions);
    return result;
  }
  async function image(extra = {}) {
    const incomingId = addUpload({ id, phone, ...extra.upload });
    return send('', { incomingType: 'image', incomingMessageId: incomingId, ...extra.input });
  }
  async function toDetails(role = 'REFERENCE') {
    await image(); await send('I AGREE'); await send(role);
    assert.equal(session(id, phone).stage, 'details');
  }
  async function estimate() { await toDetails(); return send(DETAILS); }
  return { flow, calls, images, send, input, accept, image, toDetails, estimate, id, phone, get latestPrompt() { return latestPrompt; } };
}
function assertNoProcessing(h) {
  assert.equal(h.calls.retrieve.length, 0, 'media retrieval must not happen yet');
  assert.equal(h.calls.analyze.length, 0, 'vision analysis must not happen yet');
  assert.equal(appointmentCount(), 0);
}
function assertEnded(h) {
  assert.equal(session(h.id, h.phone), undefined);
  assert.deepEqual(uploads(h.id, h.phone), []);
  assert.equal(appointmentCount(), 0);
}
function assertConsultation(result) {
  assert.match(result.text, /consultation/i);
  assert.match(result.text, /No appointment has been made/);
  assert.equal(result.photoSelection, undefined);
  assert.doesNotMatch(result.text, /estimated R/);
}
function assertZeroed(h) {
  for (const image of h.images) assert.ok(image.buffer.every(byte => byte === 0), 'retrieved bytes must be zeroed');
}
beforeEach(() => {
  mock.restoreAll();
  // Reject accidental live networking even if a future implementation forgets a hook.
  mock.method(global, 'fetch', async () => { throw Error('Network forbidden in photo-flow tests'); });
  base = Math.ceil(Date.now() / 1000) * 1000 + 60_000;
  sequence = 0;
  for (const table of ['photo_sessions', 'photo_uploads', 'messages', 'appointments', 'services', 'clients']) db.prepare(`DELETE FROM ${table}`).run();
  for (const id of ['salon-a', 'salon-b']) {
    db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,created_at,photo_estimates_enabled,whatsapp_enabled,wa_phone_number_id,wa_access_token) VALUES(?,?,?,?,?,?,1,1,?,?)')
      .run(id, `Fixture ${id}`, 'Fixture Owner', `${id}@example.invalid`, 'unused', stamp(base), `${id}-phone-id`, `${id}-fake-token`);
  }
  for (const [id, tenant, name, price, duration, category, eligible] of [
    ['cut', 'salon-a', 'Precision Cut', 350, 60, 'hair', 1],
    ['colour', 'salon-a', 'Root Colour', 650, 90, 'hair', 1],
    ['braids', 'salon-a', 'Simple Braids', 450, 120, 'hair', 1],
    ['nails', 'salon-a', 'Gel Nails', 250, 45, 'nails', 1],
    ['hidden', 'salon-a', 'Private Menu Item', 999, 60, 'hair', 0],
    ['foreign', 'salon-b', 'Other Tenant Secret', 777, 90, 'hair', 1],
  ]) {
    db.prepare('INSERT INTO services(id,client_id,name,price,duration_mins,created_at,photo_category,photo_eligible,photo_description) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, tenant, name, price, duration, stamp(base), category, eligible, `${name} service from the approved salon menu`);
  }
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('unrelated text without a photo session falls through without provider calls', async () => {
  const h = harness();
  assert.equal(await h.send('Bookings'), null);
  assertNoProcessing(h);
});
test('photo prompt discloses provider, privacy link, expiry and exact consent without retrieving bytes', async () => {
  const h = harness(), result = await h.image();
  for (const pattern of [/Anthropic/, /style details/, /https:\/\/salon\.example\.invalid\/photo-privacy/, /30 minutes/, /I AGREE/, /does not book/i]) assert.match(result.text, pattern);
  assert.equal(result.mode, 'photo_guided');
  assert.equal(session().stage, 'consent');
  assert.equal(session().consent_at, null);
  assert.equal(uploads().length, 1);
  assertNoProcessing(h);
});
for (const text of ['yes', 'ok', 'agree', 'I consent', 'I AGREE to everything', 'I AGREE\nBOOK 1']) {
  test(`consent rejects an ambiguous or compound answer: ${JSON.stringify(text)}`, async () => {
    const h = harness(); await h.image(); const result = await h.send(text);
    assert.match(result.text, /Reply I AGREE/);
    assert.equal(session().stage, 'consent'); assert.equal(session().consent_at, null); assertNoProcessing(h);
  });
}
for (const role of ['REFERENCE', 'current.']) {
  test(`separate explicit consent, role and details gates: ${role}`, async () => {
    const h = harness(); await h.image();
    const consent = await h.send('i agree!');
    assert.match(consent.text, /REFERENCE.*CURRENT/); assert.equal(session().stage, 'role');
    assert.ok(session().consent_at); assert.match(session().consent_message_id, /^in\./); assertNoProcessing(h);
    await h.send(role);
    assert.equal(session().stage, 'details'); assert.equal(session().photo_role, role.startsWith('current') ? 'current' : 'reference');
    assertNoProcessing(h);
    const result = await h.send(DETAILS);
    assert.match(result.text, /estimated R350, 60 min/); assert.equal(session().stage, 'choose');
    assert.equal(h.calls.retrieve.length, 1); assert.equal(h.calls.analyze.length, 1); assert.equal(appointmentCount(), 0);
    assert.deepEqual(h.calls.analyze[0].context, { photoRole: session().photo_role, details: DETAILS });
    assertZeroed(h);
  });
}
for (const text of ['my hair', 'both', 'reference and current', 'REFERENCE\nBOOK 1', 'yes']) {
  test(`role gate rejects ${JSON.stringify(text)}`, async () => {
    const h = harness(); await h.image(); await h.send('I AGREE');
    assert.match((await h.send(text)).text, /Reply REFERENCE or CURRENT/);
    assert.equal(session().stage, 'role'); assertNoProcessing(h);
  });
}
for (const text of ['', 'short', 'x'.repeat(1001), `${DETAILS}\nmore`, `${DETAILS}\u200b`]) {
  test(`details gate rejects invalid length/control data (${text.length} chars)`, async () => {
    const h = harness(); await h.toDetails();
    assert.match((await h.send(text)).text, /In one message/);
    assert.equal(session().stage, 'details'); assertNoProcessing(h);
  });
}
for (const stage of ['consent', 'role', 'details', 'choose']) {
  for (const failure of ['missing snapshot', 'wrong snapshot', 'same second', 'received before prompt', 'invalid sent time', 'failed prompt']) {
    test(`${stage} requires a fresh accepted-prompt snapshot: ${failure}`, async () => {
      const h = harness(); await h.image();
      if (stage !== 'consent') await h.send('I AGREE');
      if (['details', 'choose'].includes(stage)) await h.send('REFERENCE');
      if (stage === 'choose') await h.send(DETAILS);
      const accepted = Date.parse(db.prepare('SELECT accepted_at FROM messages WHERE id=?').get(h.latestPrompt).accepted_at);
      const extra = failure === 'missing snapshot' ? { confirmationMessageId: null }
        : failure === 'wrong snapshot' ? { confirmationMessageId: 'unrelated-prompt' }
        : failure === 'same second' ? { messageAt: stamp(accepted + 100) }
        : failure === 'received before prompt' ? { receivedAt: stamp(accepted - 1) }
        : failure === 'invalid sent time' ? { messageAt: 'invalid-time' } : {};
      if (failure === 'failed prompt') db.prepare("UPDATE messages SET delivery_status='failed' WHERE id=?").run(h.latestPrompt);
      const before = h.calls.analyze.length;
      const result = await h.send({ consent: 'I AGREE', role: 'REFERENCE', details: DETAILS, choose: 'BOOK 1' }[stage], extra);
      assert.match(result.text, /wait two seconds/); assert.equal(session().stage, stage);
      assert.equal(h.calls.analyze.length, before); assert.equal(appointmentCount(), 0);
      if (stage !== 'choose') assertNoProcessing(h);
    });
  }
}
for (const status of ['accepted', 'sent', 'delivered', 'read']) {
  test(`fresh response accepts ${status} prompt delivery state`, async () => {
    const h = harness(); await h.image();
    db.prepare('UPDATE messages SET delivery_status=? WHERE id=?').run(status, h.latestPrompt);
    await h.send('I AGREE'); assert.equal(session().stage, 'role'); assertNoProcessing(h);
  });
}
test('the previous prompt snapshot cannot advance the next stage', async () => {
  const h = harness(); await h.image(); const consentPrompt = h.latestPrompt;
  await h.send('I AGREE'); await h.send('REFERENCE', { confirmationMessageId: consentPrompt });
  assert.equal(session().stage, 'role'); assertNoProcessing(h);
});
test('reply evidence is scoped to the same salon, customer and outbound direction', async () => {
  const h = harness(); await h.image();
  for (const [column, value] of [['client_id', 'salon-b'], ['customer_phone', OTHER_PHONE], ['direction', 'in']]) {
    const promptId = h.latestPrompt;
    db.prepare(`UPDATE messages SET ${column}=? WHERE id=?`).run(value, promptId);
    assert.match((await h.send('I AGREE')).text, /wait two seconds/);
    assert.equal(session().stage, 'consent');
  }
  assertNoProcessing(h);
});
test('bindReply refuses a mismatched tenant/customer or session ID', async () => {
  const h = harness(); await h.image(); const reply = session().reply_id;
  for (const args of [[session().id, 'salon-b', PHONE], [session().id, 'salon-a', OTHER_PHONE], ['absent', 'salon-a', PHONE], [null, 'salon-a', PHONE]]) bindReply(...args, 'malicious-reply');
  assert.equal(session().reply_id, reply);
});

test('only the current tenant approved catalog is sent; output prices/durations come only from that catalog', async () => {
  const h = harness({ analyze: async () => ({ confidence: 0.91, category: 'hair', candidateServiceIds: ['colour', 'cut'], price: 1, duration_mins: 1, response: 'Guaranteed free treatment', candidates: [{ name: 'Injected' }] }) });
  const result = await h.estimate();
  assert.match(result.text, /1\. Root Colour: estimated R650, 90 min/);
  assert.match(result.text, /2\. Precision Cut: estimated R350, 60 min/);
  assert.doesNotMatch(result.text, /Injected|Guaranteed|Secret|Private Menu/);
  assert.deepEqual(h.calls.analyze[0].catalog.map(s => s.id).sort(), ['braids', 'colour', 'cut', 'nails']);
  assert.ok(h.calls.analyze[0].catalog.every(s => s.client_id === 'salon-a' && s.photo_eligible === 1));
  assert.deepEqual(h.calls.retrieve[0], { mediaId: h.calls.retrieve[0].mediaId, phoneNumberId: 'salon-a-phone-id', accessToken: 'salon-a-fake-token', expectedSha256: 'fake-digest' });
  assert.deepEqual(JSON.parse(session().candidates_json), [snapshot(service('colour')), snapshot(service('cut'))]);
  assert.equal(appointmentCount(), 0); assertZeroed(h);
});
test('eligibleServices excludes other tenants, unapproved categories, invalid prices, durations and names', () => {
  const good = service();
  const bad = [
    { client_id: 'salon-b' }, { photo_eligible: 0 }, { photo_eligible: true }, { photo_category: 'medical' },
    { photo_description: '' }, { photo_description: 'too short' }, { photo_description: ' '.repeat(30) }, { photo_description: 'x'.repeat(401) }, { photo_description: null },
    { name: 'x'.repeat(81) }, { name: 'Bad\nName' }, { name: 'Bad\u200bName' }, { name: null },
    { price: -1 }, { price: 100001 }, { price: 1.5 }, { price: '350' }, { duration_mins: 4 }, { duration_mins: 721 }, { duration_mins: 60.5 },
  ];
  for (const change of bad) assert.deepEqual(eligibleServices('salon-a', [{ ...good, ...change }]), [], JSON.stringify(change));
  for (const change of [{ price: 0, duration_mins: 5 }, { price: 100000, duration_mins: 720 }, { photo_category: 'nails' }, { photo_category: 'beauty' }]) assert.equal(eligibleServices('salon-a', [{ ...good, ...change }]).length, 1);
});
for (const [name, result] of [
  ['low confidence', { confidence: 0.79 }], ['missing confidence', { confidence: undefined }], ['NaN confidence', { confidence: NaN }], ['infinite confidence', { confidence: Infinity }],
  ['string confidence', { confidence: '0.99' }], ['missing IDs', { candidateServiceIds: undefined }], ['nonarray IDs', { candidateServiceIds: 'cut' }],
  ['empty IDs', { candidateServiceIds: [] }], ['duplicate IDs', { candidateServiceIds: ['cut', 'cut'] }], ['too many IDs', { candidateServiceIds: ['cut', 'colour', 'braids', 'nails'] }],
  ['unknown service', { candidateServiceIds: ['invented-service'] }], ['unapproved service', { candidateServiceIds: ['hidden'] }], ['foreign service', { candidateServiceIds: ['foreign'] }],
  ['category mismatch', { category: 'nails', candidateServiceIds: ['cut'] }], ['unknown category', { category: 'medical' }], ['mixed categories', { candidateServiceIds: ['cut', 'nails'] }],
]) {
  test(`uncertain/invalid model result goes to consultation: ${name}`, async () => {
    const h = harness({ analyze: async () => ({ confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'], ...result }) });
    const answer = await h.estimate(); assertConsultation(answer); assertEnded(h); assertZeroed(h);
  });
}
for (const result of [null, undefined, 'not structured', {}]) {
  test(`malformed model result fails safely (${String(result)})`, async () => {
    const h = harness({ analyze: async () => result });
    assertConsultation(await h.estimate()); assertEnded(h); assertZeroed(h);
  });
}
test('confidence exactly 0.8 and three approved same-category candidates are accepted', async () => {
  const h = harness({ analyze: async () => ({ confidence: 0.8, category: 'hair', candidateServiceIds: ['cut', 'colour', 'braids'] }) });
  assert.match((await h.estimate()).text, /BOOK 3/); assert.equal(JSON.parse(session().candidates_json).length, 3); assertZeroed(h);
});
test('selection requires an explicit listed BOOK number and does not create an appointment', async () => {
  const h = harness(); await h.estimate();
  for (const text of ['yes', '1', 'BOOK 2', 'BOOK 4', 'BOOK 1 tomorrow', 'book cut']) {
    assert.match((await h.send(text)).text, /Photo-based menu estimate/); assert.equal(session().stage, 'choose');
  }
  const selected = await h.send('BOOK 1');
  assert.equal(selected.photoSelection.service.id, 'cut'); assert.equal(selected.photoSelection.service.price, 350);
  assert.equal(session().stage, 'booking'); assert.equal(session().candidates_json, null);
  assert.deepEqual(JSON.parse(session().selected_json), snapshot(service()));
  assert.equal(appointmentCount(), 0); assert.equal(h.calls.analyze.length, 1);
  assert.equal((await h.send('tomorrow')).photoSelection.service.id, 'cut');
  assert.equal(h.calls.analyze.length, 1);
});
test('details are redacted after success while unrelated messages and tenants are untouched', async () => {
  const h = harness(); await h.toDetails();
  const input = h.input(DETAILS);
  db.prepare('INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,wa_message_id) VALUES(?,?,?,?,?,?,?)')
    .run('other-tenant-message', 'salon-b', PHONE, 'in', 'Other tenant retained', stamp(base), input.incomingMessageId);
  const answer = await h.flow.handle(input); h.accept(answer);
  assert.equal(db.prepare("SELECT body FROM messages WHERE client_id='salon-a' AND wa_message_id=?").get(input.incomingMessageId).body, '[Photo style details provided; removed after processing]');
  assert.equal(db.prepare("SELECT body FROM messages WHERE id='other-tenant-message'").get().body, 'Other tenant retained');
  assert.equal(uploads().length, 0); assertZeroed(h);
  assert.doesNotMatch(JSON.stringify(session()), /shoulder-length|synthetic image/);
});
for (const at of ['retrieve', 'analyze']) {
  test(`${at} failure produces safe consultation and redacts supplied details`, async () => {
    const options = { [at]: async () => { throw Error('provider error containing fake secret or image data'); } };
    const h = harness(options); await h.toDetails();
    const input = h.input(DETAILS), answer = await h.flow.handle(input);
    assertConsultation(answer); assert.doesNotMatch(answer.text, /secret|provider error/); assertEnded(h);
    assert.equal(db.prepare('SELECT body FROM messages WHERE wa_message_id=?').get(input.incomingMessageId).body, '[Photo style details provided; removed after processing]');
    if (at === 'retrieve') assert.equal(h.calls.analyze.length, 0); else assertZeroed(h);
  });
}

for (const phase of ['retrieve', 'analyze']) {
  for (const change of ['price', 'duration', 'description', 'category', 'unapproved', 'deleted', 'new service', 'name']) {
    test(`catalog ${change} change during ${phase} invalidates the estimate`, async () => {
      function mutate() {
        if (change === 'deleted') db.prepare("DELETE FROM services WHERE id='cut'").run();
        else if (change === 'new service') db.prepare("UPDATE services SET photo_eligible=1 WHERE id='hidden'").run();
        else {
          const [column, value] = { price: ['price', 351], duration: ['duration_mins', 65], description: ['photo_description', 'A changed service description'], category: ['photo_category', 'beauty'], unapproved: ['photo_eligible', 0], name: ['name', 'Changed Cut'] }[change];
          db.prepare(`UPDATE services SET ${column}=? WHERE id='cut'`).run(value);
        }
      }
      const h = harness(phase === 'retrieve' ? { retrieve: async (args, image) => { mutate(); return image; } }
        : { analyze: async () => { mutate(); return { confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'] }; } });
      assertConsultation(await h.estimate()); assertEnded(h); assertZeroed(h);
      assert.equal(h.calls.analyze.length, phase === 'retrieve' ? 0 : 1);
    });
  }
}
for (const stage of ['choose', 'booking']) {
  for (const change of ['price', 'duration', 'description', 'name', 'unapproved', 'deleted']) {
    test(`${stage} rejects a changed selected-service snapshot (${change})`, async () => {
      const h = harness(); await h.estimate(); if (stage === 'booking') await h.send('BOOK 1');
      if (change === 'deleted') db.prepare("DELETE FROM services WHERE id='cut'").run();
      else {
        const [column, value] = { price: ['price', 351], duration: ['duration_mins', 65], description: ['photo_description', 'A changed menu description'], name: ['name', 'Changed Cut'], unapproved: ['photo_eligible', 0] }[change];
        db.prepare(`UPDATE services SET ${column}=? WHERE id='cut'`).run(value);
      }
      const result = await h.send(stage === 'choose' ? 'BOOK 1' : 'tomorrow');
      assert.match(result.text, /changed/); assert.equal(result.photoSelection, undefined); assertEnded(h); assert.equal(h.calls.analyze.length, 1);
    });
  }
}
test('other tenant catalog changes do not invalidate a local estimate', async () => {
  const h = harness({ analyze: async () => {
    db.prepare("UPDATE services SET price=888 WHERE client_id='salon-b'").run();
    return { confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'] };
  } });
  assert.match((await h.estimate()).text, /estimated R350/); assert.equal(session().stage, 'choose'); assertZeroed(h);
});
for (const kind of ['salon disabled', 'provider unavailable', 'no approved catalog']) {
  test(`new image fails closed with ${kind}`, async () => {
    if (kind === 'salon disabled') db.prepare("UPDATE clients SET photo_estimates_enabled=0 WHERE id='salon-a'").run();
    if (kind === 'no approved catalog') db.prepare("UPDATE services SET photo_eligible=0 WHERE client_id='salon-a'").run();
    const h = harness({ status: () => ({ ready: kind !== 'provider unavailable' }) });
    assert.match((await h.image()).text, /not enabled/); assertEnded(h); assertNoProcessing(h);
  });
}
test('missing, foreign-tenant and foreign-customer uploads are never retrieved', async () => {
  for (const source of [null, { id: 'salon-b', phone: PHONE }, { id: 'salon-a', phone: OTHER_PHONE }]) {
    const h = harness(), incomingId = source ? addUpload(source) : nextId('missing');
    const answer = await h.send('', { incomingType: 'image', incomingMessageId: incomingId });
    assert.match(answer.text, /unavailable or unsupported/); assertNoProcessing(h); assert.equal(session(), undefined);
  }
});
for (const flag of ['bookingNeedsReview', 'latestBooking']) {
  test(`photo input preserves an existing appointment when ${flag} is set`, async () => {
    const h = harness(), input = { [flag]: flag === 'latestBooking' ? { id: 'old' } : true };
    assert.match((await h.image({ input })).text, /existing appointment is unchanged/); assertNoProcessing(h); assertEnded(h);
  });
}
test('explicit additional-booking context allows a new photo while an appointment exists', async () => {
  const h = harness();
  assert.match((await h.image({ input: { latestBooking: { id: 'old' }, allowAdditionalBooking: true } })).text, /I AGREE/); assertNoProcessing(h);
});
for (const phase of ['retrieve', 'analyze']) {
  for (const change of ['photo disabled', 'status unavailable']) {
    test(`${change} during ${phase} invalidates analysis`, async () => {
      let ready = true;
      const mutate = () => { if (change === 'photo disabled') db.prepare("UPDATE clients SET photo_estimates_enabled=0 WHERE id='salon-a'").run(); else ready = false; };
      const h = harness({ status: () => ({ ready }), ...(phase === 'retrieve' ? { retrieve: async (args, image) => { mutate(); return image; } } : { analyze: async () => { mutate(); return { confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'] }; } }) });
      assertConsultation(await h.estimate()); assertEnded(h); assertZeroed(h);
    });
  }
}
for (const change of ["whatsapp_enabled=0", "wa_phone_number_id='changed-phone'"]) {
  test(`sender configuration change during retrieval fails closed (${change})`, async () => {
    const h = harness({ retrieve: async (args, image) => { db.prepare(`UPDATE clients SET ${change} WHERE id='salon-a'`).run(); return image; } });
    assertConsultation(await h.estimate()); assert.equal(h.calls.analyze.length, 0); assertEnded(h); assertZeroed(h);
  });
}

for (const stage of ['consent', 'role', 'details', 'choose', 'booking']) {
  for (const text of ['NO', 'CANCEL', 'CONSULTATION']) {
    test(`${text} ends ${stage} without requiring reply freshness`, async () => {
      const h = harness(); await h.image();
      if (stage !== 'consent') await h.send('I AGREE');
      if (['details', 'choose', 'booking'].includes(stage)) await h.send('REFERENCE');
      if (['choose', 'booking'].includes(stage)) await h.send(DETAILS);
      if (stage === 'booking') await h.send('BOOK 1');
      const before = h.calls.analyze.length;
      const result = await h.send(text, { confirmationMessageId: null, messageAt: 'invalid' });
      assert.match(result.text, text === 'CONSULTATION' ? /consultation/i : /stopped this booking request/);
      assertEnded(h); assert.equal(h.calls.analyze.length, before);
      assert.equal(await h.send('I AGREE'), null);
    });
  }
}
test('cancel and redaction do not remove another tenant or another customer session/upload', async () => {
  const a = harness(), b = harness({ id: 'salon-b' }), c = harness({ phone: OTHER_PHONE });
  await a.image(); await b.image(); await c.image();
  const originalB = session('salon-b'), originalC = session('salon-a', OTHER_PHONE);
  await a.send('CANCEL'); assertEnded(a);
  assert.deepEqual(session('salon-b'), originalB); assert.deepEqual(session('salon-a', OTHER_PHONE), originalC);
  assert.equal(uploads('salon-b').length, 1); assert.equal(uploads('salon-a', OTHER_PHONE).length, 1);
});
test('cleanup expires only records at or before the cutoff and never contacts a provider', async () => {
  const a = harness(), b = harness({ id: 'salon-b' }); await a.image(); await b.image();
  db.prepare("UPDATE photo_sessions SET expires_at=? WHERE client_id='salon-a'").run(stamp(base));
  db.prepare("UPDATE photo_uploads SET expires_at=? WHERE client_id='salon-a'").run(stamp(base));
  cleanup(new Date(base)); assertEnded(a);
  assert.ok(session('salon-b')); assert.equal(uploads('salon-b').length, 1); assertNoProcessing(a); assertNoProcessing(b);
});
test('expired session cannot process a late consent or detail response', async () => {
  const h = harness(); await h.toDetails();
  const result = await h.send(DETAILS, { now: new Date(base + TTL_MS + 1) });
  assert.equal(result, null); assertEnded(h); assertNoProcessing(h);
});
test('missing or expired upload after consent leads to fresh-photo instructions without retrieval', async () => {
  const h = harness(); await h.toDetails(); db.prepare('DELETE FROM photo_uploads').run();
  assert.match((await h.send(DETAILS)).text, /reference expired/); assertEnded(h); assertNoProcessing(h);
});
test('details stage without recorded consent cannot retrieve bytes', async () => {
  const h = harness(); await h.toDetails(); db.prepare('UPDATE photo_sessions SET consent_at=NULL').run();
  assert.match((await h.send(DETAILS)).text, /reference expired/); assertEnded(h); assertNoProcessing(h);
});
test('expiry while analysis is outstanding invalidates its result and clears bytes', async () => {
  const h = harness({ analyze: async () => { mock.method(Date, 'now', () => base + TTL_MS + 1); return { confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'] }; } });
  assertConsultation(await h.estimate()); assertEnded(h); assertZeroed(h);
});
test('analysis-start is durable before retrieval and a recovered analysing stage never repeats a paid call', async () => {
  const h = harness({ retrieve: async (args, image) => { assert.equal(session().stage, 'analysing'); return image; } });
  await h.estimate(); assert.equal(h.calls.analyze.length, 1);
  db.prepare("UPDATE photo_sessions SET stage='analysing'").run();
  assert.match((await h.send(DETAILS)).text, /fresh start/); assertEnded(h); assert.equal(h.calls.analyze.length, 1);
});
test('a replacement image starts a fresh consent flow and preserves only its new upload', async () => {
  const h = harness(); await h.toDetails(); const prior = session().id;
  const result = await h.image();
  assert.match(result.text, /Reply I AGREE/);
  assert.equal(session().stage, 'consent'); assert.notEqual(session().id, prior);
  assert.equal(session().consent_at, null); assert.equal(session().photo_role, null);
  assert.equal(uploads().length, 1); assert.equal(uploads()[0].incoming_id, session().source_message_id); assertNoProcessing(h);
});

test('catalog removed before details never retrieves or analyzes the image', async () => {
  const h = harness(); await h.toDetails();
  db.prepare("UPDATE services SET photo_eligible=0 WHERE client_id='salon-a'").run();
  const result = await h.send(DETAILS);
  assert.match(result.text, /consultation|not enabled|menu.*changed/i);
  assertEnded(h); assertNoProcessing(h);
});
test('expiry during retrieval prevents transmission to the vision provider', async () => {
  const h = harness({ retrieve: async (args, image) => { mock.method(Date, 'now', () => base + TTL_MS + 1); return image; } });
  assertConsultation(await h.estimate());
  assert.equal(h.calls.analyze.length, 0, 'expired image must never be submitted for analysis');
  assertEnded(h); assertZeroed(h);
});
for (const change of ["whatsapp_enabled=0", "wa_phone_number_id='changed-phone'"]) {
  test(`sender configuration change during analysis fails closed (${change})`, async () => {
    const h = harness({ analyze: async () => {
      db.prepare(`UPDATE clients SET ${change} WHERE id='salon-a'`).run();
      return { confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'] };
    } });
    assertConsultation(await h.estimate()); assertEnded(h); assertZeroed(h);
  });
}

for (const age of ['older', 'same timestamp']) {
  test(`${age} image never replaces the current consent/details request`, async () => {
    const h = harness(); await h.toDetails();
    const prior = session(), priorUpload = uploads()[0];
    const sourceTime = Date.parse(db.prepare('SELECT created_at FROM messages WHERE wa_message_id=?').get(prior.source_message_id).created_at);
    const incomingId = addUpload();
    const result = await h.send('', { incomingType: 'image', incomingMessageId: incomingId, messageAt: stamp(sourceTime - (age === 'older' ? 1000 : 0)) });
    assert.match(result.text, /has not replaced your current request/);
    assert.match(result.text, /In one message/);
    assert.equal(session().id, prior.id); assert.equal(session().stage, 'details');
    assert.equal(session().source_message_id, prior.source_message_id); assert.equal(session().consent_at, prior.consent_at);
    assert.deepEqual(uploads(), [priorUpload]); assertNoProcessing(h);
  });
}
for (const stage of ['consent', 'details', 'choose', 'booking']) {
  test(`an unavailable newer image preserves the current ${stage} request`, async () => {
    const h = harness(); await h.image();
    if (stage !== 'consent') { await h.send('I AGREE'); await h.send('REFERENCE'); }
    if (['choose', 'booking'].includes(stage)) await h.send(DETAILS);
    if (stage === 'booking') await h.send('BOOK 1');
    const prior = session(), priorUploads = uploads(), before = h.calls.analyze.length;
    const result = await h.send('', { incomingType: 'image', incomingMessageId: nextId('unsupported-image') });
    assert.match(result.text, /unavailable photo has not replaced/);
    assert.equal(session().id, prior.id); assert.equal(session().stage, stage);
    assert.equal(session().source_message_id, prior.source_message_id); assert.equal(session().selected_json, prior.selected_json);
    assert.equal(session().candidates_json, prior.candidates_json); assert.equal(session().consent_at, prior.consent_at);
    assert.deepEqual(uploads(), priorUploads); assert.equal(h.calls.analyze.length, before); assert.equal(appointmentCount(), 0);
  });
}
test('two image references staged together survive processing A then B, and B requires fresh consent', async () => {
  const h = harness(), a = addUpload(), b = addUpload();
  const first = h.input('', { incomingType: 'image', incomingMessageId: a });
  const second = h.input('', { incomingType: 'image', incomingMessageId: b });
  const firstReply = await h.flow.handle(first); h.accept(firstReply);
  const firstSession = session().id;
  assert.match(firstReply.text, /Reply I AGREE/); assert.equal(session().source_message_id, a);
  assert.deepEqual(uploads().map(row => row.incoming_id).sort(), [a, b].sort());
  const secondReply = await h.flow.handle(second); h.accept(secondReply);
  assert.match(secondReply.text, /Reply I AGREE/); assert.equal(session().source_message_id, b);
  assert.notEqual(session().id, firstSession); assert.equal(session().stage, 'consent'); assert.equal(session().consent_at, null);
  assert.deepEqual(uploads().map(row => row.incoming_id), [b]); assertNoProcessing(h);
});
for (const outcome of ['success', 'retrieve failure', 'analyze failure', 'cancel']) {
  test(`a future queued upload survives cleanup of the active photo (${outcome})`, async () => {
    const h = harness(outcome === 'retrieve failure' ? { retrieve: async () => { throw Error('mock retrieve failure'); } }
      : outcome === 'analyze failure' ? { analyze: async () => { throw Error('mock analysis failure'); } } : {});
    await h.toDetails(); const current = session().source_message_id;
    const future = addUpload();
    const futureInput = h.input('', { incomingType: 'image', incomingMessageId: future });
    await h.send(outcome === 'cancel' ? 'CANCEL' : DETAILS);
    assert.equal(uploads().some(upload => upload.incoming_id === current), false);
    assert.deepEqual(uploads().map(upload => upload.incoming_id), [future]);
    const next = await h.flow.handle(futureInput); h.accept(next);
    assert.match(next.text, /Reply I AGREE/); assert.equal(session().source_message_id, future); assert.equal(session().consent_at, null);
    assert.equal(appointmentCount(), 0);
    if (outcome === 'success' || outcome === 'analyze failure') assertZeroed(h);
    if (outcome === 'cancel') assertNoProcessing(h);
  });
}
for (const phase of ['retrieve', 'analyze']) {
  test(`cancellation during ${phase} prevents a stale estimate and zeroes retrieved bytes`, async () => {
    let h;
    const cancel = async () => {
      const result = await h.send('CANCEL', { confirmationMessageId: null });
      assert.match(result.text, /stopped this booking request/);
    };
    h = harness(phase === 'retrieve' ? { retrieve: async (args, image) => { await cancel(); return image; } }
      : { analyze: async () => { await cancel(); return { confidence: 0.95, category: 'hair', candidateServiceIds: ['cut'] }; } });
    assertConsultation(await h.estimate()); assertEnded(h); assertZeroed(h);
    assert.equal(h.calls.analyze.length, phase === 'retrieve' ? 0 : 1);
  });
}
test('late photo reply with photo history returns explicit expired-flow guidance', async () => {
  const h = harness(); await h.toDetails(); const photoSessionId = session().id;
  const result = await h.send(DETAILS, { now: new Date(base + TTL_MS + 1), history: [{ direction: 'out', photo_session_id: photoSessionId }] });
  assert.match(result.text, /ended or expired/); assert.match(result.text, /new photo.*Bookings/); assert.match(result.text, /Existing appointments are unchanged/);
  assert.equal(result.photoSessionId, photoSessionId); assertEnded(h); assertNoProcessing(h);
});
for (const text of ['Bookings', 'Booking', 'new booking', 'another booking.']) {
  test(`explicit ${JSON.stringify(text)} exits expired-photo guidance into ordinary text booking`, async () => {
    const h = harness();
    assert.equal(await h.send(text, { history: [{ photo_session_id: 'expired' }] }), null); assertNoProcessing(h);
  });
}
test('older photo history does not trap an already resumed ordinary conversation', async () => {
  const h = harness();
  assert.equal(await h.send('Haircut', { history: [{ photo_session_id: 'expired' }, { direction: 'out', body: 'Choose a service' }] }), null); assertNoProcessing(h);
});

test('repeated replies to an expired request remain tagged and redacted until explicit text booking', async () => {
  const h = harness(); await h.toDetails();
  const photoSessionId = session().id;
  let history = [{ direction: 'out', photo_session_id: photoSessionId }];
  for (const text of [DETAILS, 'My current hair is shoulder length and I want a trim', 'I AGREE']) {
    const input = h.input(text, { now: new Date(base + TTL_MS + 1), history });
    const result = await h.flow.handle(input); h.accept(result);
    assert.match(result.text, /ended or expired/); assert.equal(result.photoSessionId, photoSessionId);
    const stored = db.prepare('SELECT body,photo_session_id FROM messages WHERE client_id=? AND wa_message_id=?').get(h.id, input.incomingMessageId);
    assert.equal(stored.body, '[Expired photo reply removed]'); assert.equal(stored.photo_session_id, photoSessionId);
    history = [{ direction: 'out', body: result.text, photo_session_id: result.photoSessionId }];
  }
  assert.equal(await h.send('Bookings', { history, now: new Date(base + TTL_MS + 1) }), null);
  assert.equal(session(), undefined); assertNoProcessing(h);
  assert.equal(await h.send('Precision Cut', { history: [{ direction: 'out', body: 'Which service would you like?' }], now: new Date(base + TTL_MS + 1) }), null);
});
