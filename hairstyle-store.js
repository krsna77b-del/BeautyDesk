'use strict';

// Additive, opt-in ledger. No source/generated images, prompts or provider error
// bodies are retained. A set reserves its entire analysis + three-preview cost.
const { randomUUID } = require('node:crypto');

const MAX_SETS = 2;
const CALLS_PER_SET = 4;
const MAX_ATTEMPTS = MAX_SETS * CALLS_PER_SET;
const RESERVATION_CENTS = 40;
const SET_RESERVATION_CENTS = CALLS_PER_SET * RESERVATION_CENTS;
const LIMIT_CENTS = MAX_SETS * SET_RESERVATION_CENTS;
const CONSENT_TTL_MS = 10 * 60 * 1000;
const PROVIDER = 'google';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TERMINAL_STATES = new Set(['completed', 'failed', 'unknown', 'cancelled']);
const ERROR_CODES = new Set([
  'preview_timeout', 'preview_interrupted', 'preview_provider_access',
  'preview_provider_limit', 'preview_unavailable', 'invalid_provider_response',
  'consent_changed', 'preview_disabled', 'suggestions_invalid', 'invalid_image',
  'preview_not_in_pilot', 'preview_expired',
  'preview_model_required', 'preview_notice_required', 'preview_pilot_required',
  'preview_provider_key_required',
]);
const USAGE_FIELDS = new Set(['inputTokens', 'outputTokens', 'totalTokens']);
const SET_METADATA_FIELDS = new Set(['suggestionCount', 'completedPreviews']);

class PreviewStoreError extends Error {
  constructor(code) {
    super(code); // Never echo arguments, credentials or provider diagnostics.
    this.name = 'PreviewStoreError';
    this.code = code;
  }
}
function fail(code) { throw new PreviewStoreError(code); }
function validId(value) { return typeof value === 'string' && ID.test(value); }
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function validateOwnerRequest(clientId, requestId) {
  if (!validId(clientId) || !validId(requestId)) fail('request_conflict');
}
function validateBinding(value) {
  if (!value || !validId(value.clientId) ||
      typeof value.imageDigest !== 'string' || !DIGEST.test(value.imageDigest) ||
      typeof value.model !== 'string' || !MODEL.test(value.model) ||
      !validId(value.noticeVersion) || !plainObject(value.preferences) ||
      typeof value.preferences.keepLength !== 'boolean' ||
      typeof value.preferences.easyMaintenance !== 'boolean' ||
      Object.keys(value.preferences).some(key => !['keepLength', 'easyMaintenance'].includes(key))) {
    fail('consent_invalid');
  }
}
function matchesBinding(row, value) {
  return row.client_id === value.clientId && row.image_digest === value.imageDigest &&
    row.keep_length === Number(value.preferences.keepLength) &&
    row.easy_maintenance === Number(value.preferences.easyMaintenance) &&
    row.provider === PROVIDER && row.model === value.model && row.notice_version === value.noticeVersion;
}
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function safeMetadata(value, fields, maximum = Number.MAX_SAFE_INTEGER) {
  if (value == null) return null;
  if (!plainObject(value)) fail('metadata_invalid');
  const safe = {};
  for (const key of Object.keys(value)) {
    if (!fields.has(key) || !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > maximum) {
      fail('metadata_invalid');
    }
    safe[key] = value[key];
  }
  return JSON.stringify(safe);
}
function validateErrorCode(errorCode) {
  if (errorCode !== null && !ERROR_CODES.has(errorCode)) fail('metadata_invalid');
}
function publicAttempt(row) {
  if (!row) return null;
  return {
    requestId: row.request_id, setRequestId: row.set_request_id, clientId: row.client_id,
    kind: row.kind, ordinal: row.ordinal, provider: row.provider, model: row.model,
    state: row.state, reservedCents: row.reserved_cents, createdAt: iso(row.created_at),
    dispatchedAt: iso(row.dispatched_at), finishedAt: iso(row.finished_at),
    errorCode: row.error_code, usage: row.usage_json == null ? null : JSON.parse(row.usage_json),
  };
}

function createPreviewStore(db, { now = () => Date.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000 - CONSENT_TTL_MS) {
      throw new TypeError('now must return valid epoch milliseconds');
    }
    return value;
  }
  function immediate(action) {
    const transaction = db.transaction(action);
    return (...args) => {
      try { return transaction.immediate(...args); }
      catch (error) {
        if (['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'].includes(error.code)) fail('preview_busy');
        throw error;
      }
    };
  }

  // Immediate DDL and mutation transactions serialize independent connections.
  // Construction must NOT recover another connection's legitimately active set.
  immediate(() => db.exec(`
    CREATE TABLE IF NOT EXISTS hairstyle_preview_consents (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, image_digest TEXT NOT NULL,
      keep_length INTEGER NOT NULL CHECK (keep_length IN (0,1)),
      easy_maintenance INTEGER NOT NULL CHECK (easy_maintenance IN (0,1)),
      provider TEXT NOT NULL CHECK (provider = 'google'), model TEXT NOT NULL,
      notice_version TEXT NOT NULL,
      adult INTEGER NOT NULL CHECK (adult = 1),
      owns_photo INTEGER NOT NULL CHECK (owns_photo = 1),
      google_processing INTEGER NOT NULL CHECK (google_processing = 1),
      issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      consumed_at INTEGER, consumed_request_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS hairstyle_preview_sets (
      request_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, consent_id TEXT NOT NULL UNIQUE,
      image_digest TEXT NOT NULL,
      keep_length INTEGER NOT NULL CHECK (keep_length IN (0,1)),
      easy_maintenance INTEGER NOT NULL CHECK (easy_maintenance IN (0,1)),
      provider TEXT NOT NULL CHECK (provider = 'google'), model TEXT NOT NULL,
      notice_version TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','running','completed','failed','unknown','cancelled')),
      reserved_cents INTEGER NOT NULL CHECK (reserved_cents = ${SET_RESERVATION_CENTS}),
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      error_code TEXT, metadata_json TEXT
    );
    CREATE TABLE IF NOT EXISTS hairstyle_preview_attempts (
      request_id TEXT PRIMARY KEY, set_request_id TEXT NOT NULL, client_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('analysis','preview')),
      ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
      provider TEXT NOT NULL CHECK (provider = 'google'), model TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','dispatched','completed','failed','unknown','cancelled')),
      reserved_cents INTEGER NOT NULL CHECK (reserved_cents = ${RESERVATION_CENTS}),
      created_at INTEGER NOT NULL, dispatched_at INTEGER, finished_at INTEGER,
      error_code TEXT, usage_json TEXT,
      UNIQUE (set_request_id, ordinal),
      CHECK ((kind = 'analysis' AND ordinal = 0) OR (kind = 'preview' AND ordinal BETWEEN 1 AND 3))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hairstyle_preview_single_active_set
      ON hairstyle_preview_sets ((1)) WHERE state IN ('reserved','running');
    CREATE INDEX IF NOT EXISTS hairstyle_preview_set_owner
      ON hairstyle_preview_sets (client_id, request_id);
    CREATE INDEX IF NOT EXISTS hairstyle_preview_attempt_owner
      ON hairstyle_preview_attempts (client_id, request_id);
  `))();

  const getSet = db.prepare('SELECT * FROM hairstyle_preview_sets WHERE request_id = ?');
  const getOwnedSet = db.prepare('SELECT * FROM hairstyle_preview_sets WHERE client_id = ? AND request_id = ?');
  const getOwnedAttempt = db.prepare('SELECT * FROM hairstyle_preview_attempts WHERE client_id = ? AND request_id = ?');
  const getAttempts = db.prepare('SELECT * FROM hairstyle_preview_attempts WHERE client_id = ? AND set_request_id = ? ORDER BY ordinal');
  const getConsent = db.prepare('SELECT * FROM hairstyle_preview_consents WHERE id = ? AND client_id = ?');
  const getBudget = db.prepare('SELECT COUNT(*) AS sets_used, COALESCE(SUM(reserved_cents),0) AS reserved_cents FROM hairstyle_preview_sets');
  const getActive = db.prepare("SELECT request_id FROM hairstyle_preview_sets WHERE state IN ('reserved','running') LIMIT 1");
  const insertConsent = db.prepare(`INSERT INTO hairstyle_preview_consents
    (id,client_id,image_digest,keep_length,easy_maintenance,provider,model,notice_version,adult,owns_photo,google_processing,issued_at,expires_at)
    VALUES (@id,@clientId,@imageDigest,@keepLength,@easyMaintenance,'google',@model,@noticeVersion,1,1,1,@issuedAt,@expiresAt)`);
  const consumeConsent = db.prepare(`UPDATE hairstyle_preview_consents
    SET consumed_at = ?, consumed_request_id = ? WHERE id = ? AND client_id = ? AND consumed_at IS NULL`);
  const insertSet = db.prepare(`INSERT INTO hairstyle_preview_sets
    (request_id,client_id,consent_id,image_digest,keep_length,easy_maintenance,provider,model,notice_version,state,reserved_cents,created_at)
    VALUES (@requestId,@clientId,@consentId,@imageDigest,@keepLength,@easyMaintenance,'google',@model,@noticeVersion,'reserved',${SET_RESERVATION_CENTS},@createdAt)`);
  const insertAttempt = db.prepare(`INSERT INTO hairstyle_preview_attempts
    (request_id,set_request_id,client_id,kind,ordinal,provider,model,state,reserved_cents,created_at)
    VALUES (?, ?, ?, ?, ?, 'google', ?, 'reserved', ${RESERVATION_CENTS}, ?)`);
  const startSet = db.prepare(`UPDATE hairstyle_preview_sets SET state = 'running', started_at = COALESCE(started_at, ?)
    WHERE client_id = ? AND request_id = ? AND state IN ('reserved','running')`);
  const dispatch = db.prepare(`UPDATE hairstyle_preview_attempts SET state = 'dispatched', dispatched_at = ?
    WHERE client_id = ? AND request_id = ? AND state = 'reserved'`);
  const completeAttempt = db.prepare(`UPDATE hairstyle_preview_attempts
    SET state = ?, finished_at = ?, error_code = ?, usage_json = ?
    WHERE client_id = ? AND request_id = ? AND state = ?`);
  const completeSet = db.prepare(`UPDATE hairstyle_preview_sets
    SET state = ?, finished_at = ?, error_code = ?, metadata_json = COALESCE(?, metadata_json)
    WHERE client_id = ? AND request_id = ? AND state IN ('reserved','running')`);

  function publicSet(row) {
    if (!row) return null;
    return {
      requestId: row.request_id, clientId: row.client_id, consentId: row.consent_id,
      imageDigest: row.image_digest,
      preferences: { keepLength: Boolean(row.keep_length), easyMaintenance: Boolean(row.easy_maintenance) },
      provider: row.provider, model: row.model, noticeVersion: row.notice_version,
      state: row.state, reservedCents: row.reserved_cents, createdAt: iso(row.created_at),
      startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), errorCode: row.error_code,
      metadata: row.metadata_json == null ? null : JSON.parse(row.metadata_json),
      attempts: getAttempts.all(row.client_id, row.request_id).map(attempt => attempt.request_id),
    };
  }
  function bindingColumns(value) {
    return {
      clientId: value.clientId, imageDigest: value.imageDigest,
      keepLength: Number(value.preferences.keepLength), easyMaintenance: Number(value.preferences.easyMaintenance),
      model: value.model, noticeVersion: value.noticeVersion,
    };
  }

  const createConsent = immediate(value => {
    validateBinding(value);
    if (value.adult !== true || value.ownsPhoto !== true || value.googleProcessing !== true) fail('consent_invalid');
    const issuedAt = timestamp(), expiresAt = issuedAt + CONSENT_TTL_MS, id = randomUUID();
    insertConsent.run({ ...bindingColumns(value), id, issuedAt, expiresAt });
    return { id, expiresAt: iso(expiresAt) };
  });

  const reserveSet = immediate(value => {
    validateBinding(value);
    validateOwnerRequest(value.clientId, value.requestId);
    if (!validId(value.consentId)) fail('consent_invalid');
    const existing = getSet.get(value.requestId);
    // Look up duplicates before expiry/budget/busy checks. A duplicate NEVER
    // resumes execution, including after a crash or a lost client response.
    if (existing) {
      if (!matchesBinding(existing, value) || existing.consent_id !== value.consentId) fail('request_conflict');
      const set = publicSet(existing);
      return { fresh: false, set, attempts: set.attempts };
    }
    const consent = getConsent.get(value.consentId, value.clientId);
    if (!consent || consent.consumed_at != null) fail('consent_invalid');
    if (!matchesBinding(consent, value)) fail('consent_changed');
    const createdAt = timestamp();
    if (createdAt < consent.issued_at) fail('consent_invalid');
    if (createdAt >= consent.expires_at) fail('consent_expired');
    const budget = getBudget.get();
    if (budget.sets_used >= MAX_SETS || budget.reserved_cents + SET_RESERVATION_CENTS > LIMIT_CENTS) fail('budget_exhausted');
    if (getActive.get()) fail('preview_busy');
    if (consumeConsent.run(createdAt, value.requestId, value.consentId, value.clientId).changes !== 1) fail('consent_invalid');
    insertSet.run({ ...bindingColumns(value), requestId: value.requestId, consentId: value.consentId, createdAt });
    for (let ordinal = 0; ordinal < CALLS_PER_SET; ordinal++) {
      insertAttempt.run(randomUUID(), value.requestId, value.clientId, ordinal === 0 ? 'analysis' : 'preview', ordinal, value.model, createdAt);
    }
    const set = publicSet(getOwnedSet.get(value.clientId, value.requestId));
    return { fresh: true, set, attempts: set.attempts };
  });

  const markDispatched = immediate((clientId, requestId) => {
    validateOwnerRequest(clientId, requestId);
    const attempt = getOwnedAttempt.get(clientId, requestId);
    if (!attempt || attempt.state !== 'reserved') fail('attempt_state_invalid');
    const set = getOwnedSet.get(clientId, attempt.set_request_id);
    if (!set || TERMINAL_STATES.has(set.state)) fail('attempt_state_invalid');
    // The provider must finish valid analysis before any of its three edits.
    if (attempt.kind === 'preview' && getAttempts.all(clientId, attempt.set_request_id)[0]?.state !== 'completed') {
      fail('attempt_state_invalid');
    }
    const time = timestamp();
    if (dispatch.run(time, clientId, requestId).changes !== 1) fail('attempt_state_invalid');
    startSet.run(time, clientId, attempt.set_request_id);
    return publicAttempt(getOwnedAttempt.get(clientId, requestId));
  });

  const finish = immediate((clientId, requestId, state, errorCode = null, usage = null) => {
    validateOwnerRequest(clientId, requestId);
    if (!TERMINAL_STATES.has(state)) fail('attempt_state_invalid');
    validateErrorCode(errorCode);
    const usageJson = safeMetadata(usage, USAGE_FIELDS);
    const existing = getOwnedAttempt.get(clientId, requestId);
    if (!existing) fail('attempt_state_invalid');
    if (TERMINAL_STATES.has(existing.state)) {
      if (existing.state !== state) fail('attempt_state_invalid');
      return publicAttempt(existing); // Repeat finalization cannot rewrite metadata.
    }
    const set = getOwnedSet.get(clientId, existing.set_request_id);
    if (!set || TERMINAL_STATES.has(set.state)) fail('attempt_state_invalid');
    if ((state === 'completed' && existing.state !== 'dispatched') ||
        (state === 'cancelled' && existing.state !== 'reserved')) fail('attempt_state_invalid');
    if (completeAttempt.run(state, timestamp(), errorCode, usageJson, clientId, requestId, existing.state).changes !== 1) fail('attempt_state_invalid');
    return publicAttempt(getOwnedAttempt.get(clientId, requestId));
  });

  const updateSet = immediate((clientId, requestId, state, errorCode = null, metadata = null) => {
    validateOwnerRequest(clientId, requestId);
    if (state !== 'running' && !TERMINAL_STATES.has(state)) fail('set_state_invalid');
    validateErrorCode(errorCode);
    const metadataJson = safeMetadata(metadata, SET_METADATA_FIELDS, 3);
    const existing = getOwnedSet.get(clientId, requestId);
    if (!existing) fail('set_state_invalid');
    if (TERMINAL_STATES.has(existing.state)) {
      if (existing.state !== state) fail('set_state_invalid');
      return publicSet(existing);
    }
    const time = timestamp();
    if (state === 'running') {
      if (errorCode !== null) fail('metadata_invalid');
      startSet.run(time, clientId, requestId);
      if (metadataJson !== null) db.prepare('UPDATE hairstyle_preview_sets SET metadata_json = ? WHERE client_id = ? AND request_id = ?').run(metadataJson, clientId, requestId);
    } else {
      const attempts = getAttempts.all(clientId, requestId);
      if (state === 'completed' && (attempts.length !== CALLS_PER_SET || attempts.some(attempt => attempt.state !== 'completed'))) fail('set_state_invalid');
      // A failed set may contain an interrupted in-flight call. Do not relabel
      // that call as definitely failed/cancelled; preserve uncertainty forever.
      for (const attempt of attempts) {
        if (TERMINAL_STATES.has(attempt.state)) continue;
        const childState = state === 'unknown' || attempt.state === 'dispatched' ? 'unknown' : state;
        completeAttempt.run(childState, time, errorCode, null, clientId, attempt.request_id, attempt.state);
      }
      completeSet.run(state, time, errorCode, metadataJson, clientId, requestId);
    }
    return publicSet(getOwnedSet.get(clientId, requestId));
  });

  function findAttempt(clientId, requestId) {
    validateOwnerRequest(clientId, requestId);
    return publicAttempt(getOwnedAttempt.get(clientId, requestId));
  }
  function findSet(clientId, requestId) {
    validateOwnerRequest(clientId, requestId);
    return publicSet(getOwnedSet.get(clientId, requestId));
  }
  function budget() {
    const value = getBudget.get();
    return {
      maxSets: MAX_SETS, setsUsed: value.sets_used, remainingSets: Math.max(0, MAX_SETS - value.sets_used),
      callsPerSet: CALLS_PER_SET, maxAttempts: MAX_ATTEMPTS, attemptsUsed: value.sets_used * CALLS_PER_SET,
      remainingAttempts: Math.max(0, MAX_ATTEMPTS - value.sets_used * CALLS_PER_SET),
      reservedCents: value.reserved_cents, limitCents: LIMIT_CENTS,
    };
  }
  // Call once before accepting requests at startup, never per request/connection.
  // A coordinated single application instance owns recovery, not each replica.
  const recoverInterrupted = immediate(() => {
    const time = timestamp();
    db.prepare(`UPDATE hairstyle_preview_attempts SET state = 'unknown', finished_at = ?, error_code = 'preview_interrupted'
      WHERE state IN ('reserved','dispatched') AND set_request_id IN
        (SELECT request_id FROM hairstyle_preview_sets WHERE state IN ('reserved','running'))`).run(time);
    return db.prepare(`UPDATE hairstyle_preview_sets SET state = 'unknown', finished_at = ?, error_code = 'preview_interrupted'
      WHERE state IN ('reserved','running')`).run(time).changes;
  });

  return Object.freeze({ createConsent, reserveSet, markDispatched, finish, updateSet, findAttempt, findSet, budget, recoverInterrupted });
}

module.exports = {
  createPreviewStore, PreviewStoreError, MAX_SETS, CALLS_PER_SET, MAX_ATTEMPTS,
  RESERVATION_CENTS, SET_RESERVATION_CENTS, LIMIT_CENTS, CONSENT_TTL_MS,
};
