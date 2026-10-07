'use strict';
// Authenticated, allowlisted pilot. Image bytes remain in memory only. The
// durable store contains consent bindings and conservative cost reservations.
const crypto = require('node:crypto');
const { MODEL_BINDING, LIMITS, DISCLAIMER, configuration, publicStatus } = require('./hairstyle-config');
const { createGooglePreview, normalizeInput, decodeBase64 } = require('./hairstyle-google');
const { createPreviewStore } = require('./hairstyle-store');
const PREFIX = '/api/client/hairstyle-preview';
const ERROR_MESSAGES = Object.freeze({
  preview_disabled: 'Hairstyle previews are not switched on yet.',
  preview_model_required: 'The approved Google image model still needs configuration.',
  preview_notice_required: 'The reviewed preview notice still needs configuration.',
  preview_pilot_required: 'The private pilot salon has not been selected yet.',
  preview_provider_key_required: 'The Google image provider still needs secure setup.',
  preview_not_in_pilot: 'This salon is not in the private hairstyle pilot.',
  preview_provider_access: 'Google did not accept this request. Check API access and paid billing before trying a new set.',
  preview_provider_limit: 'Google reported a usage or billing limit. No automatic retry was made.',
  preview_timeout: 'Google did not finish in time. The attempt may have been charged; no automatic retry was made.',
  preview_interrupted: 'The preview request was interrupted. Any call already sent may still be charged.',
  preview_unavailable: 'A preview could not be created safely. No automatic retry was made.',
  invalid_provider_response: 'The provider response could not be safely used. No automatic retry was made.',
  suggestions_invalid: 'Three safe hairstyle ideas could not be selected from this photo. No image edits were started.',
  invalid_image: 'Use one clear JPEG or PNG with your face and hair visible, up to 3 MiB.',
  unsupported_image: 'Choose a JPEG or PNG image.',
  invalid_request: 'Check the photo and preferences, then try again.',
  consent_invalid: 'Please read the notice and confirm permission for this photo.',
  consent_expired: 'Photo permission expired. Please read and accept the current notice again.',
  consent_changed: 'The photo, preferences or processing notice changed. Please give fresh permission.',
  request_conflict: 'This request ID has already been used for another photo request.',
  budget_exhausted: 'The private pilot allowance is used up. No further paid call was made.',
  preview_busy: 'Another preview set is being created. Please wait until it finishes.',
  preview_expired: 'These preview images have expired from memory. No new paid call was made.',
  request_not_found: 'That preview request could not be found for this salon.',
});
function validPreferences(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'easyMaintenance,keepLength'
    && typeof value.keepLength === 'boolean' && typeof value.easyMaintenance === 'boolean';
}
function exactFields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function error(code) { const e = new Error(code); e.code = code; return e; }
function mountHairstylePreview(app, { db, requireClient, env = process.env, provider = createGooglePreview(), now = () => Date.now(), schedule = setImmediate } = {}) {
  if (!db || typeof requireClient !== 'function') throw new TypeError('Preview requires the existing authenticated database');
  // An off-by-default source rollout must not migrate the live database. The
  // three pilot tables are initialized only on an explicitly enabled startup,
  // after the operator's backup/release gate. Existing ledgers are preserved.
  const hasLedger = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hairstyle_preview_sets'").get();
  const store = env.HAIRSTYLE_PREVIEW_ENABLED === 'true' || hasLedger ? createPreviewStore(db, { now }) : {
    budget: () => ({ maxSets: 2, setsUsed: 0, remainingSets: 2, attemptsUsed: 0, reservedCents: 0, limitCents: 320 }),
    findSet: () => null,
    createConsent: () => { throw error('preview_disabled'); },
    reserveSet: () => { throw error('preview_disabled'); },
  };
  if (store.recoverInterrupted) store.recoverInterrupted();
  const cache = new Map();
  let stopped = false;
  const ownerConfig = clientId => {
    const config = configuration(env);
    if (!config.ready) throw error(config.reason);
    if (config.clientId !== clientId) throw error('preview_not_in_pilot');
    return config;
  };
  const sameConfig = (clientId, previous) => {
    const current = ownerConfig(clientId);
    if (current.key !== previous.key || current.model !== previous.model || current.noticeVersion !== previous.noticeVersion
        || current.clientId !== previous.clientId) throw error('consent_changed');
  };
  function clearEntry(requestId, abort = true) {
    const entry = cache.get(requestId);
    if (!entry) return;
    if (abort) entry.controller.abort();
    entry.source?.buffer?.fill(0); entry.source = null;
    for (const preview of entry.previews) preview.buffer.fill(0);
    entry.previews.length = 0;
    clearTimeout(entry.timer); cache.delete(requestId);
  }
  function expireLater(requestId, entry) {
    clearTimeout(entry.timer);
    // The first accepted upload establishes the absolute retention deadline.
    // Completing another preview or failing must never extend earlier images.
    if (!Number.isFinite(entry.expiresAt)) entry.expiresAt = now() + LIMITS.cacheMs;
    const remaining = entry.expiresAt - now();
    if (remaining <= 0) { clearEntry(requestId); return; }
    entry.timer = setTimeout(() => clearEntry(requestId), remaining);
    entry.timer.unref?.();
  }
  function responseFor(clientId, requestId) {
    const set = store.findSet(clientId, requestId);
    if (!set) throw error('request_not_found');
    const entry = cache.get(requestId);
    if (entry && entry.expiresAt <= now()) clearEntry(requestId);
    const current = cache.get(requestId);
    const terminal = ['completed', 'failed', 'unknown', 'cancelled'].includes(set.state);
    const expired = terminal && set.state === 'completed' && !current;
    return { requestId, state: expired ? 'expired' : set.state === 'reserved' ? 'running' : set.state,
      progress: { completed: current?.previews.length || set.metadata?.completedPreviews || 0, total: 3 },
      suggestions: current?.suggestions.map(({ id, label }) => ({ styleId: id, label })) || [],
      previews: (current?.previews || []).map(preview => ({ styleId: preview.styleId, label: preview.label,
        image: { mimeType: 'image/jpeg', data: preview.buffer.toString('base64') } })),
      disclaimer: DISCLAIMER, expiresAt: current ? new Date(current.expiresAt).toISOString() : null,
      ...(expired ? { error: 'preview_expired', message: ERROR_MESSAGES.preview_expired }
        : set.errorCode ? { error: set.errorCode, message: ERROR_MESSAGES[set.errorCode] || ERROR_MESSAGES.preview_unavailable } : {}) };
  }
  function sendError(res, failure, status) {
    const code = typeof failure?.code === 'string' && ERROR_MESSAGES[failure.code] ? failure.code : 'preview_unavailable';
    const codeStatus = ['preview_not_in_pilot'].includes(code) ? 403 : code === 'request_not_found' ? 404
      : ['budget_exhausted', 'preview_busy', 'request_conflict'].includes(code) ? 409
      : code.startsWith('consent_') || ['invalid_image', 'unsupported_image', 'invalid_request'].includes(code) ? 400 : 503;
    res.status(status || codeStatus).json({ error: code, message: ERROR_MESSAGES[code] });
  }
  async function runSet({ clientId, requestId, attempts, source, preferences, config, entry }) {
    let activeAttempt;
    const stillAllowed = () => {
      if (stopped || entry.controller.signal.aborted) throw error('preview_interrupted');
      if (now() >= entry.expiresAt) { clearEntry(requestId); throw error('preview_expired'); }
      sameConfig(clientId, config);
      if (!['reserved', 'running'].includes(store.findSet(clientId, requestId)?.state)) throw error('preview_interrupted');
    };
    const dispatch = attemptId => {
      stillAllowed();
      const marked = store.markDispatched(clientId, attemptId);
      if (!marked) throw error('request_conflict');
      activeAttempt = attemptId;
    };
    try {
      stillAllowed();
      const suggestions = await provider.suggest({ image: source, preferences, key: config.key,
        signal: entry.controller.signal, beforeSend: () => dispatch(attempts[0]) });
      stillAllowed();
      // The real adapter only returns server-owned styles; preserve this boundary
      // even when tests or a future adapter inject a response.
      const { allowedStyles } = require('./hairstyle-google');
      const allowed = allowedStyles(preferences);
      if (!Array.isArray(suggestions) || suggestions.length !== 3 || new Set(suggestions.map(style => style?.id)).size !== 3
          || suggestions.some(style => !allowed.some(item => item.id === style?.id))) throw error('suggestions_invalid');
      store.finish(clientId, attempts[0], 'completed'); activeAttempt = null;
      entry.suggestions = suggestions.map(style => allowed.find(item => item.id === style.id));
      store.updateSet(clientId, requestId, 'running', null, { suggestionCount: 3, completedPreviews: 0 });
      for (let index = 0; index < 3; index++) {
        stillAllowed();
        const style = entry.suggestions[index];
        const result = await provider.generate({ image: source, styleId: style.id, preferences, key: config.key,
          signal: entry.controller.signal, beforeSend: () => dispatch(attempts[index + 1]) });
        try { stillAllowed(); } catch (failure) { result?.buffer?.fill(0); throw failure; }
        if (!Buffer.isBuffer(result?.buffer) || result.mimeType !== 'image/jpeg' || result.buffer.length > LIMITS.outputBytes) {
          result?.buffer?.fill(0); throw error('invalid_provider_response');
        }
        store.finish(clientId, attempts[index + 1], 'completed'); activeAttempt = null;
        entry.previews.push({ styleId: style.id, label: style.label, buffer: result.buffer });
        store.updateSet(clientId, requestId, 'running', null, { suggestionCount: 3, completedPreviews: entry.previews.length });
      }
      store.updateSet(clientId, requestId, 'completed', null, { suggestionCount: 3, completedPreviews: 3 });
      expireLater(requestId, entry);
    } catch (failure) {
      const code = typeof failure?.code === 'string' && ERROR_MESSAGES[failure.code] ? failure.code : 'preview_unavailable';
      const state = ['preview_timeout', 'preview_interrupted'].includes(code) ? 'unknown' : 'failed';
      try {
        if (activeAttempt) store.finish(clientId, activeAttempt, state, code);
        const existing = store.findSet(clientId, requestId);
        if (['reserved', 'running'].includes(existing?.state)) store.updateSet(clientId, requestId, state, code,
          { suggestionCount: entry.suggestions.length, completedPreviews: entry.previews.length });
      } catch { /* Never expose request data or retry a possibly paid operation. */ }
      if (cache.has(requestId)) expireLater(requestId, entry);
    } finally {
      source.buffer.fill(0); entry.source = null;
    }
  }
  app.get(PREFIX + '/status', requireClient, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(publicStatus(env, req.clientId, store.budget()));
  });
  app.post(PREFIX + '/consent', requireClient, (req, res) => {
    try {
      const config = ownerConfig(req.clientId), body = req.body;
      if (!exactFields(body, ['adult', 'ownsPhoto', 'googleProcessing', 'noticeVersion', 'imageDigest', 'preferences'])
          || !validPreferences(body.preferences)) throw error('invalid_request');
      if (body.noticeVersion !== config.noticeVersion) throw error('consent_changed');
      const consent = store.createConsent({ ...body, clientId: req.clientId, model: MODEL_BINDING });
      res.status(201).json({ consentId: consent.id, expiresAt: consent.expiresAt });
    } catch (failure) { sendError(res, failure); }
  });
  app.post(PREFIX + '/generate', requireClient, async (req, res) => {
    let source;
    try {
      const config = ownerConfig(req.clientId), body = req.body;
      if (!exactFields(body, ['requestId', 'consentId', 'preferences', 'image']) || !validPreferences(body.preferences)
          || !exactFields(body.image, ['mimeType', 'data'])) throw error('invalid_request');
      const bytes = decodeBase64(body.image.data, LIMITS.inputBytes);
      const imageDigest = crypto.createHash('sha256').update(bytes).digest('hex'); bytes.fill(0);
      source = await normalizeInput(body.image);
      body.image.data = '';
      sameConfig(req.clientId, config);
      if (stopped) throw error('preview_interrupted');
      const reservation = store.reserveSet({ clientId: req.clientId, requestId: body.requestId, consentId: body.consentId,
        imageDigest, preferences: body.preferences, model: MODEL_BINDING, noticeVersion: config.noticeVersion });
      if (!reservation.fresh) {
        source.buffer.fill(0); source = null;
        return res.status(['reserved', 'running'].includes(reservation.set.state) ? 202 : 200).json(responseFor(req.clientId, body.requestId));
      }
      const entry = { clientId: req.clientId, controller: new AbortController(), source, suggestions: [], previews: [], timer: null, expiresAt: now() + LIMITS.cacheMs };
      cache.set(body.requestId, entry); expireLater(body.requestId, entry);
      const context = { clientId: req.clientId, requestId: body.requestId, attempts: reservation.attempts, source,
        preferences: { ...body.preferences }, config, entry };
      source = null; // runSet now owns and clears this buffer.
      schedule(() => { void runSet(context); });
      res.status(202).json({ requestId: body.requestId, state: 'running', progress: { completed: 0, total: 3 }, disclaimer: DISCLAIMER });
    } catch (failure) { source?.buffer?.fill(0); sendError(res, failure); }
    finally { if (req.body?.image) req.body.image.data = ''; }
  });
  app.get(PREFIX + '/result/:requestId', requireClient, (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(responseFor(req.clientId, req.params.requestId)); }
    catch (failure) { sendError(res, failure); }
  });
  app.post(PREFIX + '/cancel/:requestId', requireClient, (req, res) => {
    try {
      const set = store.findSet(req.clientId, req.params.requestId);
      if (!set) throw error('request_not_found');
      clearEntry(req.params.requestId);
      if (['reserved', 'running'].includes(set.state)) store.updateSet(req.clientId, req.params.requestId, 'cancelled', 'preview_interrupted',
        { suggestionCount: set.metadata?.suggestionCount || 0, completedPreviews: set.metadata?.completedPreviews || 0 });
      res.json({ requestId: req.params.requestId, state: 'cancelled', message: 'Remaining preview work is stopped and server-held preview images are cleared. Data already sent to Google cannot be recalled; reservations are not refunded.' });
    } catch (failure) { sendError(res, failure); }
  });
  return { store, stop() {
    stopped = true;
    for (const [requestId, entry] of cache) {
      const set = store.findSet(entry.clientId, requestId);
      clearEntry(requestId);
      if (['reserved', 'running'].includes(set?.state)) try { store.updateSet(set.clientId, requestId, 'unknown', 'preview_interrupted'); } catch {}
    }
  } };
}
module.exports = { mountHairstylePreview, validPreferences, ERROR_MESSAGES };
