'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-preview-http-'));
const SECRET = 'synthetic-preview-test-jwt-at-least-thirty-two-characters';
const PREFS = { keepLength: false, easyMaintenance: false };
let image, digest;
before(async () => {
  const bytes = await sharp({ create: { width: 90, height: 120, channels: 3, background: '#bcaabb' } }).jpeg().toBuffer();
  digest = crypto.createHash('sha256').update(bytes).digest('hex');
  image = { mimeType: 'image/jpeg', data: bytes.toString('base64') }; bytes.fill(0);
});
after(() => { image.data = ''; fs.rmSync(directory, { recursive: true, force: true }); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch(t, overrides = {}) {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const databasePath = path.join(directory, crypto.randomUUID() + '.sqlite');
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'hairstyle-network-fixture.cjs'), 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), DB_PATH: databasePath,
      JWT_SECRET: SECRET, ADMIN_PASSCODE: 'synthetic-admin-passcode', HAIRSTYLE_PREVIEW_ENABLED: 'true',
      HAIRSTYLE_PREVIEW_MODEL: 'gemini-nano-banana-2.1', HAIRSTYLE_PREVIEW_NOTICE_VERSION: 'http-notice-v1',
      HAIRSTYLE_PREVIEW_PILOT_CLIENT_ID: 'pilot-owner', GOOGLE_HAIRSTYLE_API_KEY: 'synthetic-google-key-for-tests-only', ...overrides },
  });
  let output = '', db;
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } db?.close(); });
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error('Synthetic app startup failed: ' + output);
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await delay(30);
  }
  db = new Database(databasePath);
  for (const id of ['pilot-owner', 'other-owner']) db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'Synthetic ' + id, 'Fixture', id + '@example.invalid', 'unused', new Date().toISOString());
  const cookie = owner => 'bd_client=' + jwt.sign({ role: 'client', clientId: owner, version: 0 }, SECRET,
    { algorithm: 'HS256', issuer: 'beautydesk', audience: 'beautydesk-app', expiresIn: '10m' });
  async function request(method, suffix, body, owner = 'pilot-owner', extraHeaders = {}) {
    const response = await fetch(base + '/api/client/hairstyle-preview' + suffix, { method,
      headers: { 'Content-Type': 'application/json', ...(owner ? { cookie: cookie(owner) } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function consent(preferences = PREFS, photoDigest = digest, overrides = {}) {
    return request('POST', '/consent', { adult: true, ownsPhoto: true, googleProcessing: true, noticeVersion: 'http-notice-v1', imageDigest: photoDigest, preferences, ...overrides });
  }
  async function start(preferences = PREFS) {
    const permission = await consent(preferences); assert.equal(permission.status, 201);
    const requestId = crypto.randomUUID(), body = { requestId, consentId: permission.data.consentId, preferences, image };
    return { requestId, body, response: await request('POST', '/generate', body) };
  }
  async function terminal(requestId) {
    for (let count = 0; count < 100; count++) {
      const result = await request('GET', '/result/' + requestId);
      if (result.status !== 200 || result.data.state !== 'running') return result;
      await delay(25);
    }
    throw Error('Synthetic preview never reached terminal state: ' + output);
  }
  return { request, consent, start, terminal, db, base, cookie, output: () => output };
}

test('authenticated pilot returns actual configured status without exposing key; others cannot start it', async t => {
  const h = await launch(t);
  assert.equal((await h.request('GET', '/status', undefined, null)).status, 401);
  const status = await h.request('GET', '/status'); assert.equal(status.status, 200); assert.equal(status.data.ready, true);
  assert.equal(status.data.budget.remainingSets, 2); assert.match(status.data.disclosure, /55 days/);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-google-key/);
  assert.equal((await h.request('GET', '/status', undefined, 'other-owner')).data.ready, false);
  assert.equal((await h.request('POST', '/consent', {}, 'other-owner')).status, 403);
});

test('one consented original photo produces three fixed-label previews with exactly four reserved calls', async t => {
  const h = await launch(t); const run = await h.start(); assert.equal(run.response.status, 202);
  const result = await h.terminal(run.requestId);
  assert.equal(result.status, 200); assert.equal(result.data.state, 'completed'); assert.equal(result.data.previews.length, 3);
  assert.equal(result.data.suggestions.length, 3); assert.equal(result.data.progress.completed, 3);
  assert.match(result.data.disclaimer, /face or other details may change/);
  for (const preview of result.data.previews) {
    assert.equal(preview.image.mimeType, 'image/jpeg'); assert.ok(Buffer.from(preview.image.data, 'base64').length > 100);
  }
  const attempts = h.db.prepare('SELECT * FROM hairstyle_preview_attempts').all();
  assert.equal(attempts.length, 4); assert.ok(attempts.every(row => row.state === 'completed'));
  assert.equal(attempts.reduce((sum, row) => sum + row.reserved_cents, 0), 160);
  const records = h.db.prepare('SELECT * FROM hairstyle_preview_sets').all();
  assert.doesNotMatch(JSON.stringify(records), new RegExp(image.data.slice(0, 100)));
  assert.equal(h.db.prepare('SELECT count(*) n FROM appointments').get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
  assert.doesNotMatch(h.output(), /synthetic-google-key|\/9j\//);
});

test('repeat and concurrent same-ID submissions never repeat a paid set; third new set is refused', async t => {
  const h = await launch(t, { TEST_PREVIEW_DELAY_MS: '30' });
  const first = await h.start();
  const duplicates = await Promise.all([h.request('POST', '/generate', first.body), h.request('POST', '/generate', first.body)]);
  assert.ok(duplicates.every(response => [200, 202].includes(response.status)));
  assert.equal((await h.terminal(first.requestId)).data.state, 'completed');
  assert.equal((await h.request('POST', '/generate', first.body)).data.previews.length, 3);
  assert.equal(h.db.prepare('SELECT count(*) n FROM hairstyle_preview_attempts').get().n, 4);
  const second = await h.start({ keepLength: true, easyMaintenance: true });
  assert.equal(second.response.status, 202); assert.equal((await h.terminal(second.requestId)).data.state, 'completed');
  const third = await h.start(); assert.equal(third.response.status, 409); assert.equal(third.response.data.error, 'budget_exhausted');
  assert.equal(h.db.prepare('SELECT count(*) n FROM hairstyle_preview_attempts').get().n, 8);
  assert.equal((await h.request('GET', '/status')).data.budget.reservedCents, 320);
});

test('changed photo or preferences cannot reuse consent; negative permissions make no reservation', async t => {
  const h = await launch(t);
  for (const field of ['adult', 'ownsPhoto', 'googleProcessing']) assert.equal((await h.consent(PREFS, digest, { [field]: false })).status, 400);
  const permission = await h.consent();
  const requestId = crypto.randomUUID();
  const rejected = await h.request('POST', '/generate', { requestId, consentId: permission.data.consentId,
    preferences: { keepLength: true, easyMaintenance: false }, image });
  assert.equal(rejected.status, 400); assert.equal(rejected.data.error, 'consent_changed');
  const wrongPhoto = await h.consent(PREFS, 'a'.repeat(64));
  assert.equal((await h.request('POST', '/generate', { requestId, consentId: wrongPhoto.data.consentId, preferences: PREFS, image })).data.error, 'consent_changed');
  assert.equal(h.db.prepare('SELECT count(*) n FROM hairstyle_preview_attempts').get().n, 0);
});

test("foreign owner cannot read, cancel or retry another owner's previews", async t => {
  const h = await launch(t); const run = await h.start(); await h.terminal(run.requestId);
  assert.equal((await h.request('GET', '/result/' + run.requestId, undefined, 'other-owner')).status, 404);
  assert.equal((await h.request('POST', '/cancel/' + run.requestId, {}, 'other-owner')).status, 404);
  assert.equal((await h.request('POST', '/generate', run.body, 'other-owner')).status, 403);
});

test('cancel stops remaining calls, clears images and never refunds or silently replays the set', async t => {
  const h = await launch(t, { TEST_PREVIEW_DELAY_MS: '150' }); const run = await h.start();
  const cancelled = await h.request('POST', '/cancel/' + run.requestId, {});
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.state, 'cancelled');
  await delay(200);
  const result = await h.request('GET', '/result/' + run.requestId);
  assert.equal(result.data.state, 'cancelled'); assert.equal(result.data.previews.length, 0);
  assert.equal((await h.request('POST', '/generate', run.body)).data.state, 'cancelled');
  assert.equal((await h.request('GET', '/status')).data.budget.reservedCents, 160);
  assert.ok(h.db.prepare("SELECT count(*) n FROM hairstyle_preview_attempts WHERE dispatched_at IS NOT NULL").get().n <= 1);
});
for (const [mode, state, code, dispatched] of [['analysis', 'failed', 'preview_provider_access', 1], ['edit', 'unknown', 'preview_timeout', 2], ['suggestions', 'failed', 'suggestions_invalid', 1]]) {
  test('provider ' + mode + ' failure ends the set without further calls or retry', async t => {
    const h = await launch(t, { TEST_PREVIEW_FAILURE: mode }); const run = await h.start(); const result = await h.terminal(run.requestId);
    assert.equal(result.data.state, state); assert.equal(result.data.error, code);
    assert.equal(h.db.prepare("SELECT count(*) n FROM hairstyle_preview_attempts WHERE dispatched_at IS NOT NULL").get().n, dispatched);
    assert.equal((await h.request('GET', '/status')).data.budget.reservedCents, 160);
    assert.equal((await h.request('POST', '/generate', run.body)).data.state, state);
  });
}
test('host-off and cross-origin requests cannot start work; private backend files are never static assets', async t => {
  const h = await launch(t, { HAIRSTYLE_PREVIEW_ENABLED: 'false' });
  assert.equal((await h.request('GET', '/status')).data.ready, false);
  assert.equal((await h.consent()).data.error, 'preview_disabled');
  assert.equal((await h.request('POST', '/consent', {}, 'pilot-owner', { origin: 'https://untrusted.invalid' })).status, 403);
  for (const name of ['hairstyle-routes.js', 'hairstyle-store.js', 'hairstyle-google.js', 'hairstyle-config.js', '.env', 'db.js']) {
    assert.equal((await fetch(h.base + '/' + name)).status, 404);
  }
  const page = await fetch(h.base + '/hairstyle-preview', { redirect: 'manual' }); assert.equal(page.status, 302); assert.equal(page.headers.get('location'), '/login');
});

test('mixed-case API paths keep JSON, origin and cache protections before cancellation', async t => {
  const h = await launch(t, { TEST_PREVIEW_DELAY_MS: '80' }); const run = await h.start();
  const endpoint = h.base + '/API/CLIENT/HAIRSTYLE-PREVIEW/CANCEL/' + run.requestId;
  const form = await fetch(endpoint, { method: 'POST', headers: { cookie: h.cookie('pilot-owner'), 'content-type': 'application/x-www-form-urlencoded', origin: 'https://untrusted.invalid' }, body: 'anything=1' });
  assert.equal(form.status, 415); assert.equal(form.headers.get('cache-control'), 'no-store');
  const crossOrigin = await fetch(endpoint, { method: 'POST', headers: { cookie: h.cookie('pilot-owner'), 'content-type': 'application/json', origin: 'https://untrusted.invalid' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await h.terminal(run.requestId)).data.state, 'completed');
});

test('disabled source rollout does not create preview tables or consume any allowance', async t => {
  const h = await launch(t, { HAIRSTYLE_PREVIEW_ENABLED: 'false' });
  assert.equal((await h.request('GET', '/status')).data.ready, false);
  assert.equal((await h.consent()).data.error, 'preview_disabled');
  assert.deepEqual(h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'hairstyle_preview_%'").all(), []);
});
