'use strict';

// Offline only: temporary SQLite, synthetic metadata, no credentials/providers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const {
  createPreviewStore, PreviewStoreError, MAX_SETS, CALLS_PER_SET, MAX_ATTEMPTS,
  RESERVATION_CENTS, SET_RESERVATION_CENTS, LIMIT_CENTS, CONSENT_TTL_MS,
} = require('../hairstyle-store');

const BASE = Date.UTC(2026, 9, 7, 7, 0, 0);
const BINDING = Object.freeze({
  clientId: 'synthetic-salon', imageDigest: 'a'.repeat(64),
  preferences: Object.freeze({ keepLength: false, easyMaintenance: false }),
  model: 'gemini-nano-banana-2.1__gemini-3.5-flash-lite', noticeVersion: 'preview-google-v1',
});
function fixture(t, { file = false } = {}) {
  let time = BASE;
  const directory = file ? fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-hairstyle-store-')) : null;
  const filename = directory ? path.join(directory, 'ledger.sqlite') : ':memory:';
  const db = new Database(filename), connections = [db];
  t.after(() => {
    for (const connection of connections) if (connection.open) connection.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = createPreviewStore(db, { now: () => time });
  return {
    db, store, filename, advance: ms => { time += ms; },
    connect() {
      const connection = new Database(filename);
      connections.push(connection);
      return { db: connection, store: createPreviewStore(connection, { now: () => time }) };
    },
  };
}
function consent(store, changes = {}) {
  return store.createConsent({ ...BINDING, adult: true, ownsPhoto: true, googleProcessing: true, ...changes });
}
function request(store, id = 'request-1', changes = {}) {
  const binding = { ...BINDING, ...changes };
  return { ...binding, requestId: id, consentId: consent(store, binding).id };
}
function expectCode(action, code) {
  assert.throws(action, error => error instanceof PreviewStoreError && error.code === code && error.message === code);
}
function expectedBudget(setsUsed) {
  return { maxSets: 2, setsUsed, remainingSets: 2 - setsUsed, callsPerSet: 4,
    maxAttempts: 8, attemptsUsed: setsUsed * 4, remainingAttempts: 8 - setsUsed * 4,
    reservedCents: setsUsed * 160, limitCents: 320 };
}
function completeCall(store, clientId, requestId) {
  store.markDispatched(clientId, requestId);
  return store.finish(clientId, requestId, 'completed');
}
function terminalSet(store, id, state = 'failed') {
  const input = request(store, id), result = store.reserveSet(input);
  if (state === 'completed') for (const childId of result.attempts) completeCall(store, input.clientId, childId);
  store.updateSet(input.clientId, id, state);
  return input;
}
function childStates(store, result) {
  return result.attempts.map(id => store.findAttempt(result.set.clientId, id).state);
}
function raceWorkers(filename, tasks) {
  const gate = new SharedArrayBuffer(4), signal = new Int32Array(gate);
  const modulePath = require.resolve('../hairstyle-store'), sqlitePath = require.resolve('better-sqlite3');
  let ready = 0;
  const workers = [];
  const work = tasks.map(task => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.sqlitePath);
      const { createPreviewStore } = require(workerData.modulePath);
      const gate = new Int32Array(workerData.gate);
      parentPort.postMessage({ ready: true });
      Atomics.wait(gate, 0, 0);
      let db;
      try {
        db = new Database(workerData.filename);
        const store = createPreviewStore(db, { now: () => workerData.now });
        const task = workerData.task;
        if (task.init) parentPort.postMessage({ result: { budget: store.budget() } });
        else {
          const result = store.reserveSet(task.request);
          if (task.finish && result.fresh) store.updateSet(task.request.clientId, task.request.requestId, 'failed');
          parentPort.postMessage({ result });
        }
      } catch (error) { parentPort.postMessage({ result: { error: error.code || error.message } }); }
      finally { if (db) db.close(); }
    `, { eval: true, workerData: { filename, task, gate, modulePath, sqlitePath, now: BASE } });
    workers.push(worker);
    worker.once('error', reject);
    worker.on('message', message => {
      if (message.ready) {
        if (++ready === tasks.length) { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
      } else resolve(message.result);
    });
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Offline worker exited ${code}`)); });
  }));
  return Promise.all(work).finally(() => Promise.all(workers.map(worker => worker.terminate())));
}

test('initialization is additive, isolated, repeatable and fixes a two-set/$3.20 pilot ceiling', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE clients (id TEXT PRIMARY KEY, note TEXT); INSERT INTO clients VALUES ('legacy', 'untouched')");
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='clients'").get();
  const a = createPreviewStore(db), b = createPreviewStore(db);
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='clients'").get(), before);
  assert.deepEqual(db.prepare('SELECT * FROM clients').all(), [{ id: 'legacy', note: 'untouched' }]);
  assert.deepEqual(a.budget(), expectedBudget(0));
  assert.deepEqual(a.budget(), b.budget());
  assert.deepEqual([MAX_SETS, CALLS_PER_SET, MAX_ATTEMPTS, RESERVATION_CENTS, SET_RESERVATION_CENTS, LIMIT_CENTS], [2, 4, 8, 40, 160, 320]);
  assert.ok(LIMIT_CENTS <= 500);
  assert.equal(CONSENT_TTL_MS, 600000);
});

test('consent creates random opaque IDs and exact combined-model/preferences binding with ISO expiry', t => {
  const { db, store } = fixture(t);
  const a = consent(store), b = consent(store);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(a).sort(), ['expiresAt', 'id']);
  assert.equal(a.expiresAt, new Date(BASE + CONSENT_TTL_MS).toISOString());
  const row = db.prepare('SELECT * FROM hairstyle_preview_consents WHERE id=?').get(a.id);
  assert.equal(row.provider, 'google');
  assert.equal(row.model, BINDING.model);
  assert.equal(row.image_digest, BINDING.imageDigest);
  assert.deepEqual([row.keep_length, row.easy_maintenance, row.adult, row.owns_photo, row.google_processing], [0, 0, 1, 1, 1]);
  assert.equal(row.consumed_at, null);
});

for (const flag of ['adult', 'ownsPhoto', 'googleProcessing']) {
  test(`consent requires literal true for ${flag}`, t => {
    const { db, store } = fixture(t);
    for (const value of [false, undefined, null, 1, 'true', [], {}]) {
      expectCode(() => consent(store, { [flag]: value }), 'consent_invalid');
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM hairstyle_preview_consents').get().n, 0);
  });
}

test('invalid binding identifiers, SHA256 values and malformed/freeform preferences never enter the ledger', t => {
  const { store } = fixture(t);
  for (const changes of [
    { clientId: '' }, { clientId: 'contains whitespace' }, { imageDigest: 'base64:photo' },
    { imageDigest: 'A'.repeat(64) }, { model: 'https://provider/?key=secret' },
    { noticeVersion: '<script>' }, { preferences: null }, { preferences: {} },
    { preferences: { keepLength: 1, easyMaintenance: false } },
    { preferences: { keepLength: true, easyMaintenance: false, prompt: 'freeform text' } },
  ]) expectCode(() => consent(store, changes), 'consent_invalid');
  assert.deepEqual(store.budget(), expectedBudget(0));
});

test('one atomic reservation consumes consent and reserves analysis plus three stable preview IDs', t => {
  const { db, store } = fixture(t);
  const input = request(store), result = store.reserveSet(input);
  assert.equal(result.fresh, true);
  assert.equal(result.set.requestId, input.requestId);
  assert.equal(result.set.state, 'reserved');
  assert.equal(result.set.reservedCents, 160);
  assert.equal(result.set.createdAt, new Date(BASE).toISOString());
  assert.equal(result.set.startedAt, null);
  assert.equal(result.set.finishedAt, null);
  assert.equal(result.set.errorCode, null);
  assert.equal(result.set.metadata, null);
  assert.equal(new Set(result.attempts).size, 4);
  assert.deepEqual(result.attempts, result.set.attempts);
  const attempts = result.attempts.map(id => store.findAttempt(input.clientId, id));
  assert.deepEqual(attempts.map(value => value.kind), ['analysis', 'preview', 'preview', 'preview']);
  assert.deepEqual(attempts.map(value => value.ordinal), [0, 1, 2, 3]);
  assert.ok(attempts.every(value => value.state === 'reserved' && value.reservedCents === 40));
  assert.deepEqual(store.budget(), expectedBudget(1));
  const row = db.prepare('SELECT * FROM hairstyle_preview_consents WHERE id=?').get(input.consentId);
  assert.equal(row.consumed_at, BASE);
  assert.equal(row.consumed_request_id, input.requestId);
});

test('exact duplicate set returns original four IDs before busy/expiry and never spends again', t => {
  const { store, advance } = fixture(t);
  const input = request(store), first = store.reserveSet(input);
  advance(CONSENT_TTL_MS + 1);
  assert.deepEqual(store.reserveSet(input), { ...first, fresh: false });
  assert.deepEqual(store.budget(), expectedBudget(1));
});

test('duplicate key with changed image/preferences/model/version/consent conflicts without mutation', t => {
  const { store } = fixture(t);
  const input = request(store), original = store.reserveSet(input).set;
  for (const changes of [
    { imageDigest: 'b'.repeat(64) }, { preferences: { keepLength: true, easyMaintenance: false } },
    { preferences: { keepLength: false, easyMaintenance: true } }, { model: 'other-model' },
    { noticeVersion: 'notice-v2' }, { consentId: consent(store).id },
  ]) expectCode(() => store.reserveSet({ ...input, ...changes }), 'request_conflict');
  assert.deepEqual(store.findSet(input.clientId, input.requestId), original);
  assert.deepEqual(store.budget(), expectedBudget(1));
});

for (const changes of [
  { imageDigest: 'b'.repeat(64) }, { model: 'other-model' }, { noticeVersion: 'notice-v2' },
  { preferences: { keepLength: true, easyMaintenance: false } },
  { preferences: { keepLength: false, easyMaintenance: true } },
]) {
  test(`consent binds ${JSON.stringify(changes)} and mismatch does not consume it`, t => {
    const { store } = fixture(t);
    const input = request(store);
    expectCode(() => store.reserveSet({ ...input, ...changes }), 'consent_changed');
    assert.deepEqual(store.budget(), expectedBudget(0));
    assert.equal(store.reserveSet(input).fresh, true);
  });
}

test('consent expires exactly at ten minutes and fails before issuance', t => {
  const { store, advance } = fixture(t);
  const input = request(store);
  advance(-1);
  expectCode(() => store.reserveSet(input), 'consent_invalid');
  advance(CONSENT_TTL_MS + 1);
  expectCode(() => store.reserveSet(input), 'consent_expired');
  assert.deepEqual(store.budget(), expectedBudget(0));
});

test('consent works immediately before expiry', t => {
  const { store, advance } = fixture(t);
  const input = request(store);
  advance(CONSENT_TTL_MS - 1);
  assert.equal(store.reserveSet(input).fresh, true);
});

test('consent is single use even after failure/cancellation', t => {
  const { store } = fixture(t);
  for (const state of ['failed', 'cancelled']) {
    const input = terminalSet(store, `set-${state}`, state);
    expectCode(() => store.reserveSet({ ...input, requestId: `reuse-${state}` }), 'consent_invalid');
  }
  assert.deepEqual(store.budget(), expectedBudget(2));
});

test('foreign owners cannot read or mutate sets, child calls or consent', t => {
  const { store } = fixture(t);
  const input = request(store);
  expectCode(() => store.reserveSet({ ...input, clientId: 'other-owner' }), 'consent_invalid');
  const result = store.reserveSet(input);
  assert.equal(store.findSet('other-owner', input.requestId), null);
  assert.equal(store.findAttempt('other-owner', result.attempts[0]), null);
  expectCode(() => store.reserveSet({ ...input, clientId: 'other-owner' }), 'request_conflict');
  expectCode(() => store.markDispatched('other-owner', result.attempts[0]), 'attempt_state_invalid');
  expectCode(() => store.finish('other-owner', result.attempts[0], 'unknown'), 'attempt_state_invalid');
  expectCode(() => store.updateSet('other-owner', input.requestId, 'unknown'), 'set_state_invalid');
  assert.deepEqual(store.findSet(input.clientId, input.requestId), result.set);
});

test('one globally active set blocks another owner without consuming their consent', t => {
  const { store } = fixture(t);
  const first = request(store, 'first'), second = request(store, 'second', { clientId: 'salon-b' });
  const result = store.reserveSet(first);
  expectCode(() => store.reserveSet(second), 'preview_busy');
  store.markDispatched(first.clientId, result.attempts[0]);
  expectCode(() => store.reserveSet(second), 'preview_busy');
  store.updateSet(first.clientId, first.requestId, 'failed', 'preview_unavailable');
  assert.equal(store.reserveSet(second).fresh, true);
  assert.deepEqual(store.budget(), expectedBudget(2));
});

test('analysis must complete before edits; dispatch is a single compare-and-set', t => {
  const { store, advance } = fixture(t);
  const input = request(store), result = store.reserveSet(input);
  expectCode(() => store.markDispatched(input.clientId, result.attempts[1]), 'attempt_state_invalid');
  advance(25);
  const call = store.markDispatched(input.clientId, result.attempts[0]);
  assert.equal(call.dispatchedAt, new Date(BASE + 25).toISOString());
  assert.equal(store.findSet(input.clientId, input.requestId).state, 'running');
  expectCode(() => store.markDispatched(input.clientId, result.attempts[0]), 'attempt_state_invalid');
  expectCode(() => store.markDispatched(input.clientId, result.attempts[1]), 'attempt_state_invalid');
  store.finish(input.clientId, result.attempts[0], 'completed');
  assert.equal(store.markDispatched(input.clientId, result.attempts[1]).state, 'dispatched');
  assert.equal(store.reserveSet(input).fresh, false);
});

test('child states prevent premature success and post-dispatch cancellation or terminal overwrite', t => {
  const { store, advance } = fixture(t);
  const input = request(store), result = store.reserveSet(input), id = result.attempts[0];
  expectCode(() => store.finish(input.clientId, id, 'completed'), 'attempt_state_invalid');
  expectCode(() => store.finish(input.clientId, id, 'reserved'), 'attempt_state_invalid');
  store.markDispatched(input.clientId, id);
  expectCode(() => store.finish(input.clientId, id, 'cancelled'), 'attempt_state_invalid');
  advance(100);
  const done = store.finish(input.clientId, id, 'completed', null, { inputTokens: 12, outputTokens: 34, totalTokens: 46 });
  assert.equal(done.finishedAt, new Date(BASE + 100).toISOString());
  advance(200);
  assert.deepEqual(store.finish(input.clientId, id, 'completed', null, { totalTokens: 900 }), done);
  for (const state of ['failed', 'unknown', 'cancelled']) expectCode(() => store.finish(input.clientId, id, state), 'attempt_state_invalid');
  expectCode(() => store.markDispatched(input.clientId, id), 'attempt_state_invalid');
});

test('set completion requires all four successful calls and terminal metadata cannot be rewritten', t => {
  const { store, advance } = fixture(t);
  const input = request(store), result = store.reserveSet(input);
  expectCode(() => store.updateSet(input.clientId, input.requestId, 'completed'), 'set_state_invalid');
  for (let i = 0; i < result.attempts.length; i++) {
    completeCall(store, input.clientId, result.attempts[i]);
    const progress = store.updateSet(input.clientId, input.requestId, 'running', null, { suggestionCount: 3, completedPreviews: i });
    assert.equal(progress.metadata.completedPreviews, i);
    if (i < 3) expectCode(() => store.updateSet(input.clientId, input.requestId, 'completed'), 'set_state_invalid');
  }
  advance(100);
  const done = store.updateSet(input.clientId, input.requestId, 'completed', null, { suggestionCount: 3, completedPreviews: 3 });
  assert.equal(done.finishedAt, new Date(BASE + 100).toISOString());
  assert.deepEqual(store.updateSet(input.clientId, input.requestId, 'completed', null, { completedPreviews: 0 }), done);
  for (const state of ['running', 'failed', 'unknown', 'cancelled']) expectCode(() => store.updateSet(input.clientId, input.requestId, state), 'set_state_invalid');
  assert.deepEqual(store.budget(), expectedBudget(1));
});

for (const state of ['failed', 'unknown', 'cancelled']) {
  test(`${state} set closes pending children, preserves completed/uncertain calls and keeps all $1.60`, t => {
    const { store } = fixture(t);
    const input = request(store), result = store.reserveSet(input);
    completeCall(store, input.clientId, result.attempts[0]);
    completeCall(store, input.clientId, result.attempts[1]);
    store.markDispatched(input.clientId, result.attempts[2]);
    store.updateSet(input.clientId, input.requestId, state, 'preview_interrupted', { suggestionCount: 3, completedPreviews: 1 });
    assert.deepEqual(childStates(store, result), ['completed', 'completed', 'unknown', state]);
    expectCode(() => store.markDispatched(input.clientId, result.attempts[3]), 'attempt_state_invalid');
    expectCode(() => store.finish(input.clientId, result.attempts[2], 'completed'), 'attempt_state_invalid');
    assert.deepEqual(store.budget(), expectedBudget(1));
    assert.equal(store.reserveSet(request(store, 'next')).fresh, true);
  });
}

test('two full reservations exhaust the budget, including cancelled or failed sets; duplicates remain free', t => {
  const { db, store, advance } = fixture(t);
  const first = terminalSet(store, 'first', 'cancelled');
  terminalSet(store, 'second', 'failed');
  const extra = request(store, 'third', { clientId: 'another-salon' });
  expectCode(() => store.reserveSet(extra), 'budget_exhausted');
  assert.deepEqual(store.budget(), expectedBudget(2));
  assert.equal(db.prepare('SELECT consumed_at FROM hairstyle_preview_consents WHERE id=?').get(extra.consentId).consumed_at, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM hairstyle_preview_attempts').get().n, 8);
  advance(CONSENT_TTL_MS + 1);
  assert.equal(store.reserveSet(first).fresh, false);
});

test('startup recovery atomically marks interrupted sets/children unknown with no replay or refund', t => {
  const { store } = fixture(t);
  for (const state of ['reserved', 'dispatched']) {
    const input = request(store, `interrupted-${state}`), result = store.reserveSet(input);
    if (state === 'dispatched') store.markDispatched(input.clientId, result.attempts[0]);
    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(store.findSet(input.clientId, input.requestId).state, 'unknown');
    assert.ok(childStates(store, result).every(value => value === 'unknown'));
    assert.equal(store.findAttempt(input.clientId, result.attempts[0]).errorCode, 'preview_interrupted');
    assert.equal(store.reserveSet(input).fresh, false);
    expectCode(() => store.markDispatched(input.clientId, result.attempts[0]), 'attempt_state_invalid');
    assert.equal(store.recoverInterrupted(), 0);
  }
  assert.deepEqual(store.budget(), expectedBudget(2));
});

test('recovery preserves completed children and their numeric usage metadata', t => {
  const { store } = fixture(t);
  const input = request(store), result = store.reserveSet(input);
  store.markDispatched(input.clientId, result.attempts[0]);
  const done = store.finish(input.clientId, result.attempts[0], 'completed', null, { totalTokens: 24 });
  store.markDispatched(input.clientId, result.attempts[1]);
  assert.equal(store.recoverInterrupted(), 1);
  assert.deepEqual(store.findAttempt(input.clientId, result.attempts[0]), done);
  assert.deepEqual(childStates(store, result), ['completed', 'unknown', 'unknown', 'unknown']);
});

test('sets/consent/budget survive reopening without implicit recovery or reset', t => {
  const { db, store, connect } = fixture(t, { file: true });
  const input = request(store), result = store.reserveSet(input);
  db.close();
  const next = connect().store;
  assert.deepEqual(next.budget(), expectedBudget(1));
  assert.equal(next.findSet(input.clientId, input.requestId).state, 'reserved');
  assert.deepEqual(next.reserveSet(input).attempts, result.attempts);
  assert.equal(next.recoverInterrupted(), 1);
  assert.equal(connect().store.findSet(input.clientId, input.requestId).state, 'unknown');
});

test('independent SQLite connections share exact set/child state and cannot duplicate a dispatch', t => {
  const { store, connect } = fixture(t, { file: true });
  const input = request(store), result = store.reserveSet(input), other = connect().store;
  assert.equal(other.findSet(input.clientId, input.requestId).state, 'reserved');
  assert.equal(other.reserveSet(input).fresh, false);
  other.markDispatched(input.clientId, result.attempts[0]);
  expectCode(() => store.markDispatched(input.clientId, result.attempts[0]), 'attempt_state_invalid');
  store.updateSet(input.clientId, input.requestId, 'unknown', 'preview_timeout');
  assert.equal(other.findSet(input.clientId, input.requestId).state, 'unknown');
  assert.deepEqual(other.budget(), expectedBudget(1));
});

test('simultaneous first initialization on two SQLite connections is safe', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-hairstyle-init-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const results = await raceWorkers(path.join(directory, 'fresh.sqlite'), [{ init: true }, { init: true }]);
  assert.ok(results.every(result => result.budget?.setsUsed === 0), JSON.stringify(results));
});

test('simultaneous identical sets reserve exactly four calls once across two connections', async t => {
  const { db, store, filename } = fixture(t, { file: true });
  const input = request(store);
  const results = await raceWorkers(filename, [{ request: input }, { request: input }]);
  assert.deepEqual(results.map(result => result.fresh).sort(), [false, true]);
  assert.deepEqual(results[0].attempts, results[1].attempts);
  assert.deepEqual(store.budget(), expectedBudget(1));
  assert.equal(db.prepare('SELECT count(*) AS n FROM hairstyle_preview_attempts').get().n, 4);
});

test('simultaneous new sets allow only one global active reservation', async t => {
  const { db, store, filename } = fixture(t, { file: true });
  const inputs = [request(store, 'first'), request(store, 'second', { clientId: 'second-salon' })];
  const results = await raceWorkers(filename, inputs.map(input => ({ request: input })));
  assert.equal(results.filter(result => result.fresh).length, 1);
  assert.equal(results.filter(result => result.error === 'preview_busy').length, 1);
  assert.deepEqual(store.budget(), expectedBudget(1));
  assert.equal(db.prepare('SELECT count(*) AS n FROM hairstyle_preview_consents WHERE consumed_at IS NOT NULL').get().n, 1);
});

test('racing for the final set cannot overrun two sets/eight calls/$3.20', async t => {
  const { db, store, filename } = fixture(t, { file: true });
  terminalSet(store, 'prior');
  const inputs = [request(store, 'last-a'), request(store, 'last-b', { clientId: 'other-salon' })];
  const results = await raceWorkers(filename, inputs.map(input => ({ request: input, finish: true })));
  assert.equal(results.filter(result => result.fresh).length, 1);
  assert.equal(results.filter(result => result.error === 'budget_exhausted').length, 1);
  assert.deepEqual(store.budget(), expectedBudget(2));
  assert.equal(db.prepare('SELECT count(*) AS n FROM hairstyle_preview_attempts').get().n, 8);
});

test('failure inserting the fourth call rolls back the whole set, prior calls and consent consumption', t => {
  const { db, store } = fixture(t);
  const input = request(store);
  db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON hairstyle_preview_attempts WHEN NEW.ordinal=3 BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => store.reserveSet(input), /synthetic failure/);
  assert.deepEqual(store.budget(), expectedBudget(0));
  assert.equal(db.prepare('SELECT count(*) AS n FROM hairstyle_preview_attempts').get().n, 0);
  assert.equal(db.prepare('SELECT consumed_at FROM hairstyle_preview_consents WHERE id=?').get(input.consentId).consumed_at, null);
  db.exec('DROP TRIGGER synthetic_failure');
  assert.equal(store.reserveSet(input).fresh, true);
});

test('held SQLite write lock maps to preview_busy without consuming consent or budget', t => {
  const { db, store, connect } = fixture(t, { file: true });
  const input = request(store), other = connect();
  other.db.pragma('busy_timeout = 1');
  db.exec('BEGIN IMMEDIATE');
  try { expectCode(() => other.store.reserveSet(input), 'preview_busy'); }
  finally { db.exec('ROLLBACK'); }
  assert.deepEqual(store.budget(), expectedBudget(0));
  assert.equal(other.store.reserveSet(input).fresh, true);
});

test('only allowlisted numeric result/usage metadata and safe error codes are retained', t => {
  const { db, store } = fixture(t);
  const secret = 'synthetic-secret-do-not-persist';
  const input = request(store, 'metadata', { image: secret, prompt: secret, apiKey: secret, error: secret });
  const result = store.reserveSet({ ...input, imageBase64: secret, generatedImage: secret }), child = result.attempts[0];
  store.markDispatched(input.clientId, child);
  for (const usage of [
    { apiKey: secret }, { image: secret }, { prompt: secret }, { inputTokens: secret },
    { inputTokens: -1 }, { outputTokens: 1.5 }, { totalTokens: NaN },
    { totalTokens: Infinity }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 }, [1], secret, new Date(),
  ]) expectCode(() => store.finish(input.clientId, child, 'completed', null, usage), 'metadata_invalid');
  for (const metadata of [{ prompt: secret }, { suggestions: [secret] }, { completedPreviews: 4 }, { suggestionCount: -1 }, { suggestionCount: '3' }]) {
    expectCode(() => store.updateSet(input.clientId, input.requestId, 'running', null, metadata), 'metadata_invalid');
  }
  expectCode(() => store.finish(input.clientId, child, 'failed', secret), 'metadata_invalid');
  expectCode(() => store.updateSet(input.clientId, input.requestId, 'failed', secret), 'metadata_invalid');
  const done = store.finish(input.clientId, child, 'completed', null, { inputTokens: 0, outputTokens: 20 });
  assert.deepEqual(done.usage, { inputTokens: 0, outputTokens: 20 });
  for (const table of ['hairstyle_preview_consents', 'hairstyle_preview_sets', 'hairstyle_preview_attempts']) {
    assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), new RegExp(secret));
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
    assert.equal(columns.some(column => /^(image|photo|prompt|api_key|payload|response|error_message)$/.test(column)), false);
  }
});

test('missing/invalid identifiers cannot manufacture calls or sets', t => {
  const { store } = fixture(t);
  assert.equal(store.findSet(BINDING.clientId, 'absent'), null);
  assert.equal(store.findAttempt(BINDING.clientId, 'absent'), null);
  expectCode(() => store.markDispatched(BINDING.clientId, 'absent'), 'attempt_state_invalid');
  expectCode(() => store.finish(BINDING.clientId, 'absent', 'failed'), 'attempt_state_invalid');
  expectCode(() => store.updateSet(BINDING.clientId, 'absent', 'failed'), 'set_state_invalid');
  expectCode(() => store.reserveSet({ ...BINDING, requestId: 'no-consent' }), 'consent_invalid');
  expectCode(() => store.findAttempt('', 'absent'), 'request_conflict');
  assert.deepEqual(store.budget(), expectedBudget(0));
});

for (const code of ['preview_model_required', 'preview_notice_required', 'preview_pilot_required', 'preview_provider_key_required']) {
  test(`configuration change ${code} can close a reserved/running set without retaining a busy lock`, t => {
    const { store } = fixture(t);
    const input = request(store), result = store.reserveSet(input);
    store.markDispatched(input.clientId, result.attempts[0]);
    store.finish(input.clientId, result.attempts[0], 'failed', code);
    const finished = store.updateSet(input.clientId, input.requestId, 'failed', code);
    assert.equal(finished.errorCode, code);
    assert.ok(childStates(store, result).every(state => state === 'failed'));
    assert.equal(store.reserveSet(request(store, 'after-config-change')).fresh, true);
    assert.deepEqual(store.budget(), expectedBudget(2));
  });
}
