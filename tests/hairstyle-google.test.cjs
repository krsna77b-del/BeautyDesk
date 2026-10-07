'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createGooglePreview, normalizeInput, decodeBase64, allowedStyles, readSuggestions, PreviewProviderError } = require('../hairstyle-google');
const { MODEL, ANALYSIS_MODEL, LIMITS, STYLES, configuration, publicStatus } = require('../hairstyle-config');
const KEY = 'synthetic-google-fixture-key-only';
const PREFS = { keepLength: false, easyMaintenance: false };
let image;
const originalFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = async () => { throw Error('External network forbidden in preview adapter tests'); };
  image = { mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ddbbbb' } }).jpeg().toBuffer() };
});
after(() => { image.buffer.fill(0); globalThis.fetch = originalFetch; });
const reply = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
const imagePayload = () => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: image.buffer.toString('base64') }] }] });
const suggestionPayload = (value = { usable_photo: true, style_ids: ['soft-waves', 'sleek-bob', 'face-framing'] }) => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(value) }] }] });
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof PreviewProviderError && error.code === code);

test('preview stays off unless all dedicated host settings and allowed salon are configured', () => {
  const env = { HAIRSTYLE_PREVIEW_ENABLED: 'true', HAIRSTYLE_PREVIEW_MODEL: MODEL,
    HAIRSTYLE_PREVIEW_NOTICE_VERSION: 'pilot-v1', HAIRSTYLE_PREVIEW_PILOT_CLIENT_ID: 'salon', GOOGLE_HAIRSTYLE_API_KEY: KEY };
  assert.equal(configuration({}).reason, 'preview_disabled');
  for (const field of Object.keys(env)) assert.equal(configuration({ ...env, [field]: '' }).ready, false);
  assert.equal(configuration({ ...env, HAIRSTYLE_PREVIEW_MODEL: 'another-model' }).ready, false);
  const status = publicStatus(env, 'salon', { remainingSets: 2 });
  assert.equal(status.ready, true); assert.equal(status.analysisModel, ANALYSIS_MODEL);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-google-fixture/);
  assert.match(status.disclosure, /55 days/); assert.match(status.disclosure, /not zero retention/);
  assert.equal(publicStatus(env, 'other-salon', {}).reason, 'preview_not_in_pilot');
});

test('analysis uses pinned structured Google Interactions request with no storage, tools, retry or freeform instructions', async () => {
  let calls = 0, dispatches = 0, captured;
  const adapter = createGooglePreview({ fetchImpl: async (url, options) => {
    calls++; captured = structuredClone(JSON.parse(options.body));
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], KEY); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    return reply(suggestionPayload());
  } });
  const styles = await adapter.suggest({ image, key: KEY, preferences: PREFS, beforeSend: () => dispatches++ });
  assert.equal(calls, 1); assert.equal(dispatches, 1); assert.equal(styles.length, 3);
  assert.equal(captured.model, ANALYSIS_MODEL); assert.equal(captured.store, false); assert.equal(captured.background, false);
  assert.equal(captured.stream, false); assert.equal(captured.service_tier, 'standard');
  assert.equal(captured.generation_config.max_output_tokens, 1024);
  assert.equal(captured.generation_config.thinking_level, 'minimal');
  assert.equal(captured.response_format.mime_type, 'application/json');
  assert.deepEqual(captured.response_format.schema.properties.style_ids.items.enum, STYLES.map(style => style.id));
  for (const key of ['tools', 'previous_interaction_id', 'history']) assert.equal(captured[key], undefined);
  assert.match(captured.input[0].text, /Do not infer identity, ethnicity, age, gender, health/);
  assert.doesNotMatch(JSON.stringify(captured), /synthetic-google-fixture-key/);
});

test('each edit starts from original image and fixed trusted style, returns one validated metadata-free JPEG', async () => {
  let captured, calls = 0;
  const adapter = createGooglePreview({ fetchImpl: async (_, options) => { calls++; captured = JSON.parse(options.body); return reply(imagePayload()); } });
  const result = await adapter.generate({ image, styleId: 'face-framing', preferences: { keepLength: true, easyMaintenance: true }, key: KEY });
  assert.equal(calls, 1); assert.equal(captured.model, MODEL); assert.equal(captured.generation_config.max_output_tokens, 4096);
  assert.deepEqual(captured.response_format, { type: 'image', mime_type: 'image/jpeg', image_size: '1K', aspect_ratio: '1:1', delivery: 'inline' });
  assert.equal(captured.input[1].data, image.buffer.toString('base64'));
  assert.match(captured.input[0].text, /Preserve the original overall hair length/);
  assert.equal(result.mimeType, 'image/jpeg'); const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 80); assert.equal(meta.exif, undefined); result.buffer.fill(0);
});

for (const value of [
  null, {}, { usable_photo: true, style_ids: ['soft-waves'] },
  { usable_photo: true, style_ids: ['soft-waves', 'soft-waves', 'sleek-bob'] },
  { usable_photo: true, style_ids: ['soft-waves', 'sleek-bob', 'medical-advice'] },
  { usable_photo: true, style_ids: ['soft-waves', 'sleek-bob', 'pixie-cut'], diagnosis: 'not allowed' },
  { usable_photo: false, style_ids: ['soft-waves'] },
  { usable_photo: 'yes', style_ids: ['soft-waves', 'sleek-bob', 'pixie-cut'] },
]) test('invalid or untrusted suggestion output fails closed: ' + JSON.stringify(value), () => {
  assert.throws(() => readSuggestions(suggestionPayload(value), PREFS), error => error.code === 'suggestions_invalid');
});
test('unusable photograph stops before image edits; optional preferences constrain every returned ID', () => {
  assert.throws(() => readSuggestions(suggestionPayload({ usable_photo: false, style_ids: [] }), PREFS), error => error.code === 'invalid_image');
  const prefs = { keepLength: true, easyMaintenance: true };
  assert.equal(allowedStyles(prefs).length, 3);
  assert.throws(() => readSuggestions(suggestionPayload(), prefs), error => error.code === 'suggestions_invalid');
  const valid = allowedStyles(prefs).map(style => style.id);
  assert.deepEqual(readSuggestions(suggestionPayload({ usable_photo: true, style_ids: valid }), prefs).map(style => style.id), valid);
});
for (const mutate of [
  payload => payload.status = 'in_progress',
  payload => payload.steps = [],
  payload => payload.steps[0].content[0].data = 'https://external.invalid/photo.jpg',
  payload => payload.steps[0].content[0].mime_type = 'text/html',
  payload => payload.steps[0].content.push(payload.steps[0].content[0]),
]) test('invalid image response never becomes a usable preview', async () => {
  const payload = imagePayload(); mutate(payload);
  const adapter = createGooglePreview({ fetchImpl: async () => reply(payload) });
  await assert.rejects(adapter.generate({ image, styleId: 'soft-waves', key: KEY }), error => error instanceof PreviewProviderError);
});
for (const [status, code] of [[401, 'preview_provider_access'], [403, 'preview_provider_access'], [429, 'preview_provider_limit'], [500, 'preview_unavailable']]) {
  test('HTTP ' + status + ' is sanitized and never retried', async () => {
    let calls = 0;
    const adapter = createGooglePreview({ fetchImpl: async () => { calls++; return new Response('private provider payload ' + KEY, { status }); } });
    await rejects(adapter.generate({ image, styleId: 'soft-waves', key: KEY }), code); assert.equal(calls, 1);
  });
}
test('timeout and prior cancellation never initiate an automatic retry', async () => {
  let calls = 0;
  const adapter = createGooglePreview({ timeoutMs: 10, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await rejects(adapter.generate({ image, styleId: 'soft-waves', key: KEY }), 'preview_timeout'); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await rejects(adapter.generate({ image, styleId: 'soft-waves', key: KEY, signal: controller.signal }), 'preview_interrupted'); assert.equal(calls, 1);
});
test('configuration/cost check at dispatch boundary can stop all network transmission', async () => {
  let calls = 0;
  const adapter = createGooglePreview({ fetchImpl: async () => { calls++; return reply(imagePayload()); } });
  await rejects(adapter.generate({ image, styleId: 'soft-waves', key: KEY, beforeSend: () => { throw new PreviewProviderError('preview_interrupted'); } }), 'preview_interrupted');
  assert.equal(calls, 0);
});
test('redirects and oversized JSON are rejected without exposing raw response text', async () => {
  const redirected = reply(imagePayload()); Object.defineProperty(redirected, 'redirected', { value: true });
  const adapter = createGooglePreview({ fetchImpl: async () => redirected });
  await rejects(adapter.generate({ image, styleId: 'soft-waves', key: KEY }), 'invalid_provider_response');
  const oversized = new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(LIMITS.responseBytes + 1) } });
  await rejects(createGooglePreview({ fetchImpl: async () => oversized }).generate({ image, styleId: 'soft-waves', key: KEY }), 'invalid_provider_response');
});
test('input normalization rejects malformed, unsupported or noncanonical payloads before provider use', async () => {
  for (const value of ['', 'a', 'data:image/jpeg;base64,YWJj', 'YWJj\n', '%%%%']) assert.throws(() => decodeBase64(value, 100), error => error.code === 'invalid_image');
  await rejects(normalizeInput({ mimeType: 'image/gif', data: 'YWJj' }), 'unsupported_image');
  await rejects(normalizeInput({ mimeType: 'image/jpeg', data: Buffer.from('not an image').toString('base64') }), 'invalid_image');
  const normalized = await normalizeInput({ mimeType: 'image/jpeg', data: image.buffer.toString('base64') });
  assert.equal(normalized.mimeType, 'image/jpeg'); assert.ok(normalized.buffer.length <= LIMITS.normalizedBytes); normalized.buffer.fill(0);
});
test('invalid key, style and preference inputs fail before network', async () => {
  let calls = 0;
  const adapter = createGooglePreview({ fetchImpl: async () => { calls++; return reply(imagePayload()); } });
  await rejects(adapter.generate({ image, styleId: 'bad-style', key: KEY }), 'invalid_style');
  await rejects(adapter.generate({ image, styleId: 'soft-waves', key: 'short' }), 'preview_provider_key_required');
  await rejects(adapter.generate({ image, styleId: 'soft-waves', key: KEY, preferences: { keepLength: 'yes', easyMaintenance: false } }), 'invalid_image');
  assert.equal(calls, 0);
});
