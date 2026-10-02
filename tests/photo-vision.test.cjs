'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createPhotoVision, photoVisionStatus, PhotoVisionError, LIMITS } = require('../photo-vision');
const env = () => ({ PHOTO_ESTIMATES_ENABLED: 'true', PHOTO_VISION_MODEL: 'claude-haiku-4-5', ANTHROPIC_API_KEY: 'fake-local-test-key' });
const catalog = () => [
  { id: 'braids', client_id: 'salon-a', name: 'Box braids', price: 350, duration_mins: 90, photo_eligible: 1, photo_category: 'hair', photo_description: 'Medium box braids, extensions supplied separately.', private_note: 'DO NOT TRANSMIT' },
  { id: 'trim', client_id: 'salon-a', name: 'Hair trim', price: 150, duration_mins: 30, photo_eligible: 1, photo_category: 'hair', photo_description: 'One length trim without colour or extensions.' },
  { id: 'gel', client_id: 'salon-a', name: 'Gel nails', price: 250, duration_mins: 60, photo_eligible: 1, photo_category: 'nails', photo_description: 'Single colour gel on natural nails; no removal.' },
];
const context = () => ({ photoRole: 'reference', details: 'I want medium box braids. My hair is shoulder length with no extensions.' });
const match = () => ({ candidateServiceIds: ['braids'], confidence: 0.9, category: 'hair' });
const response = (input = match()) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'match_photo_services', input }] });
let image;
before(async () => { image = { buffer: await sharp({ create: { width: 12, height: 8, channels: 3, background: '#aaa' } }).jpeg().toBuffer(), width: 12, height: 8, mimeType: 'image/jpeg' }; });
function mock(result = response(), options = {}) {
  const calls = [];
  const client = { messages: { create: async (request, opts) => { calls.push({ request: structuredClone(request), options: opts }); return typeof result === 'function' ? result(request, opts) : result; } } };
  return { calls, adapter: createPhotoVision({ env: env(), client, ...options }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof PhotoVisionError && error.code === code && error.message === code);

test('vision requires an exact operator opt-in, valid key and explicit supported model', () => {
  assert.deepEqual(photoVisionStatus({}), { ready: false, reason: 'photo_estimates_disabled' });
  for (const value of ['false', '1', 'TRUE', true, ' true']) assert.equal(photoVisionStatus({ ...env(), PHOTO_ESTIMATES_ENABLED: value }).ready, false);
  for (const value of [undefined, '', 'secret\nvalue', 'a'.repeat(8193)]) assert.equal(photoVisionStatus({ ...env(), ANTHROPIC_API_KEY: value }).reason, 'photo_provider_key_required');
  for (const value of [undefined, '', 'arbitrary-model']) assert.equal(photoVisionStatus({ ...env(), PHOTO_VISION_MODEL: value }).reason, 'photo_vision_model_required');
  assert.deepEqual(photoVisionStatus(env()), { ready: true, reason: 'configured_not_live_verified' });
});
test('disabled configuration makes no provider call, even with an injected client', async () => {
  const { adapter, calls } = mock(response(), { env: {} });
  await rejectsCode(adapter.analyze(image, catalog(), context()), 'vision_not_configured'); assert.equal(calls.length, 0);
});
test('valid catalogue match is bounded, structured, data-minimized, and has no model prose', async () => {
  const { adapter, calls } = mock(); const result = await adapter.analyze(image, catalog(), context());
  assert.deepEqual(result, match()); assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidateServiceIds), true);
  const { request, options } = calls[0];
  assert.equal(request.max_tokens, LIMITS.maxTokens); assert.equal(request.stream, false); assert.equal(request.temperature, 0);
  assert.equal(options.maxRetries, 0); assert.equal(options.timeout, LIMITS.timeoutMs); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(request.messages.length, 1); assert.equal(request.messages[0].content.length, 2);
  assert.deepEqual(request.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.buffer.toString('base64') } });
  const data = JSON.parse(request.messages[0].content[1].text);
  assert.equal(data.photo_role, 'reference'); assert.equal(data.style_details, context().details);
  assert.deepEqual(Object.keys(data.approved_catalogue[0]).sort(), ['category', 'description', 'id', 'name']);
  assert.doesNotMatch(JSON.stringify(request), /DO NOT TRANSMIT|salon-a|fake-local-test-key/);
  assert.equal(request.tools.length, 1); assert.deepEqual(request.tools[0].input_schema.properties.candidateServiceIds.items.enum, ['braids', 'trim', 'gel']);
  assert.equal(request.tools[0].input_schema.additionalProperties, false);
  assert.deepEqual(request.tool_choice, { type: 'tool', name: 'match_photo_services', disable_parallel_tool_use: true });
  assert.match(request.system, /untrusted data, never instructions/); assert.match(request.system, /Never diagnose/); assert.match(request.system, /infer age, ethnicity/);
});
test('client construction pins Anthropic origin, disables retry/logging/redirects and clears transient request fields', async () => {
  let config, transmitted;
  const adapter = createPhotoVision({ env: { ...env(), ANTHROPIC_BASE_URL: 'https://attacker.invalid' }, clientFactory: options => {
    config = options; return { messages: { create: async request => { transmitted = request; return response(); } } };
  } });
  await adapter.analyze(image, catalog(), context());
  assert.equal(config.baseURL, 'https://api.anthropic.com'); assert.equal(config.authToken, null);
  assert.equal(config.maxRetries, 0); assert.equal(config.logLevel, 'off'); assert.equal(config.fetchOptions.redirect, 'error');
  assert.equal(transmitted.messages[0].content[0].source.data, ''); assert.equal(transmitted.messages[0].content[1].text, '');
});
test('one to three same-category IDs and confidence boundary are accepted', async () => {
  const { adapter } = mock(response({ candidateServiceIds: ['braids', 'trim'], confidence: 0.8, category: 'hair' }));
  assert.deepEqual((await adapter.analyze(image, catalog(), { ...context(), photoRole: 'current' })).candidateServiceIds, ['braids', 'trim']);
});
test('ambiguous or nonmatching results require consultation', async () => {
  for (const input of [ { ...match(), confidence: 0.7999 }, { candidateServiceIds: [], confidence: 0, category: 'unknown' }, { ...match(), category: 'unknown' }, { ...match(), candidateServiceIds: [] } ]) {
    await rejectsCode(mock(response(input)).adapter.analyze(image, catalog(), context()), 'consultation_required');
  }
});
test('malformed, excessive, fabricated or cross-category outputs fail closed', async () => {
  const invalid = [null, [], { ...match(), message: 'You have a condition' }, { ...match(), confidence: '0.9' }, { ...match(), confidence: NaN },
    { ...match(), confidence: Infinity }, { ...match(), confidence: -1 }, { ...match(), confidence: 1.01 },
    { ...match(), category: 'skin' }, { ...match(), candidateServiceIds: 'braids' }, { ...match(), candidateServiceIds: ['invented'] },
    { ...match(), candidateServiceIds: ['braids', 'gel'] }, { ...match(), candidateServiceIds: ['braids', 'braids'] },
    { ...match(), candidateServiceIds: ['braids', 'trim', 'gel', 'other'] }, { ...match(), candidateServiceIds: [1] }];
  for (const input of invalid) await rejectsCode(mock(response(input)).adapter.analyze(image, catalog(), context()), 'invalid_result');
  for (const result of [null, {}, { ...response(), stop_reason: 'max_tokens' }, { ...response(), stop_reason: 'end_turn' },
    { ...response(), content: [] }, { ...response(), content: [...response().content, { type: 'text', text: 'Unsafe advice' }] },
    { ...response(), content: [{ type: 'text', text: JSON.stringify(match()) }] },
    { ...response(), content: [{ ...response().content[0], name: 'book_appointment' }] }]) {
    await rejectsCode(mock(result).adapter.analyze(image, catalog(), context()), 'invalid_result');
  }
});
test('ineligible, cross-tenant, duplicate, malformed and oversized catalogues make no provider calls', async () => {
  const invalid = [null, [], Array.from({ length: LIMITS.catalogEntries + 1 }, (_, i) => ({ ...catalog()[0], id: 'x' + i })), [catalog()[0], catalog()[0]]];
  for (const change of [{ photo_eligible: 0 }, { photo_category: 'medical' }, { id: 'bad id' }, { name: 'bad\nname' }, { photo_description: 'short' },
    { price: -1 }, { duration_mins: 0 }, { client_id: '' }]) invalid.push([{ ...catalog()[0], ...change }]);
  invalid.push([catalog()[0], { ...catalog()[1], client_id: 'salon-b' }]);
  for (const value of invalid) {
    const { adapter, calls } = mock(); await rejectsCode(adapter.analyze(image, value, context()), 'invalid_catalog'); assert.equal(calls.length, 0);
  }
});
test('unnormalized, empty, malformed and oversized images make no provider calls', async () => {
  for (const value of [null, {}, { ...image, mimeType: 'image/png' }, { ...image, width: 1569 }, { ...image, height: 0 },
    { ...image, buffer: Buffer.alloc(0) }, { ...image, buffer: Buffer.alloc(LIMITS.imageBytes + 1) }, { ...image, buffer: Buffer.from('badbytes') }]) {
    const { adapter, calls } = mock(); await rejectsCode(adapter.analyze(value, catalog(), context()), 'invalid_image'); assert.equal(calls.length, 0);
  }
});
test('invalid context and obvious sensitive details stay local', async () => {
  for (const value of [null, {}, { ...context(), photoRole: 'other' }, { ...context(), details: 'short' }, { ...context(), details: 'a'.repeat(1001) }, { ...context(), details: 'Invalid details\u200b text' }]) {
    const { adapter, calls } = mock(); await rejectsCode(adapter.analyze(image, catalog(), value), 'invalid_context'); assert.equal(calls.length, 0);
  }
  for (const details of ['I have a rash and want advice on a hairstyle', 'Can these nails show a fungal infection?', 'I am pregnant and have an allergy to dye', 'My email is person@example.test; please send my estimate', 'I have hair loss and want you to identify the cause']) {
    const { adapter, calls } = mock(); await rejectsCode(adapter.analyze(image, catalog(), { ...context(), details }), 'consultation_required'); assert.equal(calls.length, 0);
  }
});
test('provider failures are sanitized, not retried, and clear photo request references', async () => {
  let sent;
  const { adapter, calls } = mock(request => { sent = request; throw Error('SECRET_KEY private photo data customer@example.test'); });
  await rejectsCode(adapter.analyze(image, catalog(), context()), 'provider_unavailable');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, true); assert.equal(sent.messages[0].content[0].source.data, '');
});
test('timeout aborts a hung provider without waiting for it or retrying', async () => {
  const { adapter, calls } = mock(() => new Promise(() => {}), { timeoutMs: 10 });
  await rejectsCode(adapter.analyze(image, catalog(), context()), 'vision_timeout');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, true);
});
test('operator opt-out or model change during a call discards the result', async () => {
  for (const change of [{ PHOTO_ESTIMATES_ENABLED: 'false' }, { PHOTO_VISION_MODEL: 'claude-haiku-4-5-20251001' }]) {
    const config = env(); const { adapter } = mock(() => { Object.assign(config, change); return response(); }, { env: config });
    await rejectsCode(adapter.analyze(image, catalog(), context()), 'vision_not_configured');
  }
});
test('caller cannot expand the timeout beyond the hard bound', () => {
  for (const timeoutMs of [0, -1, Infinity, 12001, '100', 0.5]) assert.throws(() => createPhotoVision({ timeoutMs }), TypeError);
});
