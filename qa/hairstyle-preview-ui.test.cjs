'use strict';
// Offline only. Synthetic one-pixel fixtures, stubbed same-origin API, no provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto, createHash, randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'hairstyle-preview.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'hairstyle-preview.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'hairstyle-preview.css'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqV4AAAAASUVORK5CYII=', 'base64');
const BASE = '/api/client/hairstyle-preview';
const STATUS = Object.freeze({ enabled: true, ready: true, reason: 'configured_not_live_verified', provider: 'Google', model: 'test-image', analysisModel: 'test-analysis', noticeVersion: 'test-v1', disclosure: 'OFFLINE TEST NOTICE: Send this photo to Google for three suggestions and previews. Test images are not real people.', disclaimer: 'AI-generated preview; results may differ.', budget: { remainingSets: 2, maxSets: 2, reservedCents: 0, limitCents: 320 }, privacyLinks: ['https://ai.google.dev/gemini-api/terms#paid-services', 'https://ai.google.dev/gemini-api/docs/usage-policies'] });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate, message = 'Expected UI state') {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await pause(); }
  assert.fail(message);
}
function fixtureResults(id, overrides = {}) {
  const suggestions = [1, 2, 3].map(n => ({ styleId: `style-${n}`, label: `Suggested look ${n}` }));
  return { requestId: id, state: 'completed', progress: { completed: 3, total: 3 }, suggestions, previews: suggestions.map(item => ({ ...item, image: { mimeType: 'image/png', data: PNG.toString('base64') } })), disclaimer: 'Test-only AI result disclaimer.', ...overrides };
}
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function harness(t, handler) {
  const dom = new JSDOM(html, { url: 'https://beautydesk.test/hairstyle-preview', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  const q = id => d.getElementById(id);
  const requests = [], polls = new Map(), jsErrors = [];
  let timerId = 100000, hidden = false;
  const realSetTimeout = w.setTimeout.bind(w), realClearTimeout = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => { if (ms === 1800) { const id = ++timerId; polls.set(id, () => fn(...args)); return id; } return realSetTimeout(fn, ms, ...args); };
  w.clearTimeout = id => { if (polls.has(id)) polls.delete(id); else realClearTimeout(id); };
  Object.defineProperty(d, 'hidden', { get: () => hidden });
  Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle });
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  Object.defineProperty(w, 'localStorage', { get() { throw new Error('Persistent photo storage forbidden'); } });
  Object.defineProperty(w, 'sessionStorage', { get() { throw new Error('Persistent photo storage forbidden'); } });
  w.HTMLElement.prototype.scrollIntoView = function () { w.lastScrolledElement = this; };
  w.addEventListener('error', event => jsErrors.push(event.error));
  let status = structuredClone(STATUS);
  const defaultHandler = async req => {
    if (req.path === `${BASE}/status`) return response(status);
    if (req.path === `${BASE}/consent`) return response({ consentId: 'test-consent', expiresAt: '2030-01-01T00:00:00Z' }, 201);
    if (req.path === `${BASE}/generate`) return response({ requestId: req.body.requestId, state: 'running' }, 202);
    if (req.path.includes('/result/')) return response(fixtureResults(req.path.split('/').pop()));
    if (req.path.includes('/cancel/')) return response({ requestId: req.path.split('/').pop(), state: 'cancelled' });
    throw new Error(`Unstubbed path ${req.path}`);
  };
  w.fetch = async (url, options) => {
    const parsed = new URL(url, w.location.origin);
    assert.equal(parsed.origin, w.location.origin, 'No third-party call permitted');
    assert.ok(parsed.pathname.startsWith(BASE + '/'), 'Only preview API calls permitted');
    const req = { path: parsed.pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null, options };
    requests.push(req);
    return handler ? handler(req, defaultHandler) : defaultHandler(req);
  };
  w.eval(js);
  const change = (id, value) => { q(id).checked = value; q(id).dispatchEvent(new w.Event('change', { bubbles: true })); };
  const submit = () => q('preview-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const consent = () => { change('adult-consent', true); change('google-consent', true); };
  const choose = async (bytes = PNG, { type = 'image/png', name = 'my-own-photo.png', load = true } = {}) => {
    Object.defineProperty(q('photo-file'), 'files', { configurable: true, value: [new w.File([bytes], name, { type })] });
    q('photo-file').dispatchEvent(new w.Event('change', { bubbles: true }));
    await until(() => !!q('original-image').getAttribute('src') || !q('photo-error').hidden, 'Photo read did not settle');
    if (load && q('original-image').getAttribute('src')) q('original-image').dispatchEvent(new w.Event('load'));
  };
  const poll = async () => { const next = polls.entries().next().value; assert.ok(next, 'Expected scheduled read-only poll'); polls.delete(next[0]); next[1](); await pause(); };
  const ready = () => until(() => q('availability-title').textContent !== 'Checking preview availability');
  const start = async () => { await ready(); await choose(); consent(); submit(); await until(() => requests.some(req => req.path === `${BASE}/generate`)); await until(() => polls.size > 0 || !q('check-results').hidden || !q('action-error').hidden); };
  const visibility = value => { hidden = value; d.dispatchEvent(new w.Event('visibilitychange')); };
  return { w, d, q, requests, polls, ready, choose, change, consent, submit, poll, start, jsErrors, visibility, setStatus: data => { status = data; } };
}

test('isolated mobile-first markup has no required style selector, unchecked consent, or live sample previews', () => {
  const dom = new JSDOM(html), d = dom.window.document;
  assert.equal(d.querySelectorAll('select,textarea').length, 0);
  assert.equal(d.querySelectorAll('input[type="checkbox"]:checked').length, 0);
  assert.equal(d.querySelectorAll('.empty-card').length, 3);
  assert.equal(d.querySelectorAll('.empty-card img').length, 0);
  assert.match(d.getElementById('empty-explanation').textContent, /aren’t generated previews/);
  assert.equal(d.getElementById('photo-file').accept, 'image/jpeg,image/png');
  assert.equal(d.querySelectorAll('script').length, 1);
  assert.equal(d.querySelector('script').getAttribute('src'), '/hairstyle-preview.js');
  assert.match(css, /max-width:720px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|console\.(?:log|error|debug)|innerHTML/);
  dom.window.close();
});

test('setup pending is explicit; selected photo stays local and sending remains disabled', async t => {
  const h = harness(t, (req, fallback) => req.path.endsWith('/status') ? response({ ...STATUS, enabled: false, ready: false, reason: 'preview_provider_key_required' }) : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit(); await pause();
  assert.match(h.q('availability-message').textContent, /Google API connection/);
  assert.equal(h.q('generate-button').disabled, true);
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 0);
  assert.ok(h.q('original-image').src.startsWith('data:image/png;base64,'));
});

test('MIME, signature, and 3 MiB limit reject unsupported photos without network transmission', async t => {
  const h = harness(t); await h.ready();
  await h.choose(PNG, { type: 'image/heic' }); assert.match(h.q('photo-error').textContent, /JPEG or PNG/);
  await h.choose(Buffer.from('not a PNG')); assert.match(h.q('photo-error').textContent, /doesn’t match/);
  await h.choose(Buffer.alloc(3 * 1024 * 1024 + 1)); assert.match(h.q('photo-error').textContent, /3 MiB/);
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 0);
  assert.equal(h.q('original-image').hasAttribute('src'), false);
});

test('photo must decode successfully before generation is enabled', async t => {
  const h = harness(t); await h.ready(); await h.choose(PNG, { load: false }); h.consent();
  assert.equal(h.q('generate-button').disabled, true);
  h.q('original-image').dispatchEvent(new h.w.Event('error'));
  assert.match(h.q('photo-error').textContent, /couldn’t display/);
  assert.equal(h.q('original-image').hasAttribute('src'), false);
});

test('explicit submit binds exact original bytes, preferences, and disclosed version; photo is not sent with consent', async t => {
  const h = harness(t); await h.ready(); await h.choose(); h.change('keep-length', true); h.consent();
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 0);
  h.submit(); await until(() => h.requests.some(req => req.path.endsWith('/generate')));
  const consent = h.requests.find(req => req.path.endsWith('/consent'));
  assert.deepEqual(consent.body, { adult: true, ownsPhoto: true, googleProcessing: true, noticeVersion: 'test-v1', imageDigest: createHash('sha256').update(PNG).digest('hex'), preferences: { keepLength: true, easyMaintenance: false } });
  assert.equal(JSON.stringify(consent.body).includes(PNG.toString('base64')), false);
  const generate = h.requests.find(req => req.path.endsWith('/generate'));
  assert.deepEqual(generate.body.image, { mimeType: 'image/png', data: PNG.toString('base64') });
  assert.equal(generate.body.consentId, 'test-consent');
  assert.match(generate.body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(generate.options.credentials, 'same-origin');
  assert.equal(generate.options.cache, 'no-store');
});

test('rapid double submit sends exactly one consent and one generation POST', async t => {
  const gate = deferred();
  const h = harness(t, (req, fallback) => req.path.endsWith('/consent') ? gate.promise : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit(); h.submit(); h.submit();
  assert.equal(h.requests.filter(req => req.path.endsWith('/consent')).length, 1);
  gate.resolve(response({ consentId: 'test-consent' }));
  await until(() => h.requests.some(req => req.path.endsWith('/generate')));
  h.submit();
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
  assert.equal(h.q('photo-file').disabled, true);
  assert.equal(h.q('preferences').disabled, true);
});

test('changing photo or preferences resets both consents', async t => {
  const h = harness(t); await h.ready(); await h.choose(); h.consent();
  assert.equal(h.q('generate-button').disabled, false);
  h.change('easy-maintenance', true);
  assert.equal(h.q('adult-consent').checked, false); assert.equal(h.q('google-consent').checked, false);
  h.consent(); await h.choose(PNG, { name: 'second-photo.png' });
  assert.equal(h.q('adult-consent').checked, false); assert.equal(h.q('google-consent').checked, false);
});

test('completed result renders three safe labels, per-card original comparison, and fresh permission for a new set', async t => {
  const hostile = '<img src=x onerror=alert(1)> Fresh layers';
  const h = harness(t, (req, fallback) => {
    if (!req.path.includes('/result/')) return fallback(req);
    const data = fixtureResults(req.path.split('/').pop()); data.suggestions[0].label = hostile;
    return response(data);
  });
  await h.start(); await h.poll(); await until(() => h.q('results-count').textContent === 'Your 3 previews are ready');
  assert.equal(h.d.querySelectorAll('.generated-card').length, 3);
  assert.equal(h.d.querySelector('.generated-card h3').textContent, hostile);
  assert.equal(h.d.querySelectorAll('[onerror]').length, 0);
  assert.equal(h.d.querySelectorAll('.original-reference img').length, 3);
  const controls = h.d.querySelector('.compare-controls'), frame = h.d.querySelector('.generated-frame');
  controls.children[0].click(); assert.equal(frame.querySelector('.image-badge').textContent, 'Your original');
  assert.equal(controls.children[0].getAttribute('aria-pressed'), 'true');
  controls.children[1].click(); assert.equal(frame.querySelector('.image-badge').textContent, 'AI preview');
  assert.equal(h.q('adult-consent').checked, false);
  assert.equal(h.q('google-consent').checked, false);
  assert.equal(h.q('generate-button').disabled, true);
  assert.equal(h.polls.size, 0);
  assert.equal(h.d.activeElement.id, 'results-title');
});

test('provider disclosure and links cannot inject HTML or unsafe URLs', async t => {
  const h = harness(t, (req, fallback) => req.path.endsWith('/status') ? response({ ...STATUS, disclosure: '<script>bad()</script> exact notice', privacyLinks: ['javascript:alert(1)', 'https://evil.test', 'https://ai.google.dev/gemini-api/terms#paid-services'] }) : fallback(req));
  await h.ready();
  assert.equal(h.q('provider-disclosure').textContent, '<script>bad()</script> exact notice');
  assert.equal(h.q('provider-disclosure').children.length, 0);
  assert.equal(h.q('privacy-links').children.length, 1);
  assert.equal(h.q('privacy-links').firstChild.hostname, 'ai.google.dev');
});

test('consent failure or malformed consent response never sends the image', async t => {
  const h = harness(t, (req, fallback) => req.path.endsWith('/consent') ? response({ error: 'consent_changed' }, 400) : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit();
  await until(() => !h.q('action-error').hidden);
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 0);
  assert.match(h.q('action-error').textContent, /processing notice changed/);
  assert.equal(h.q('adult-consent').checked, false);
});

test('lost generation response recovers through GET and never repeats POST', async t => {
  const h = harness(t, (req, fallback) => req.path.endsWith('/generate') ? Promise.reject(new Error('network')) : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit();
  await until(() => h.q('results-count').textContent === 'Your 3 previews are ready');
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
  assert.equal(h.requests.filter(req => req.path.includes('/result/')).length, 1);
  assert.equal(h.polls.size, 0);
});

test('terminal unknown result keeps partial previews, stops polling, and never retries generation', async t => {
  const h = harness(t, (req, fallback) => {
    if (!req.path.includes('/result/')) return fallback(req);
    const data = fixtureResults(req.path.split('/').pop(), { state: 'unknown' }); data.previews = data.previews.slice(0, 1);
    return response(data);
  });
  await h.start(); await h.poll(); await until(() => !h.q('action-error').hidden);
  assert.equal(h.d.querySelectorAll('.generated-frame').length, 1);
  assert.match(h.q('action-error').textContent, /Only 1 of 3/);
  assert.equal(h.polls.size, 0);
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
  assert.equal(h.q('adult-consent').checked, false);
});

test('expired result stops cleanly and explains expiry without automatic regeneration', async t => {
  const h = harness(t, (req, fallback) => req.path.includes('/result/') ? response({ requestId: req.path.split('/').pop(), state: 'expired', suggestions: [], previews: [] }) : fallback(req));
  await h.start(); await h.poll(); await until(() => !h.q('action-error').hidden);
  assert.match(h.q('action-error').textContent, /expired from server memory/);
  assert.equal(h.polls.size, 0);
  assert.equal(h.q('photo-file').disabled, false);
});

test('401 clears all local image references and provides a normal sign-in link', async t => {
  const h = harness(t, (req, fallback) => req.path.includes('/result/') ? response({ error: 'unauthorized' }, 401) : fallback(req));
  await h.start(); await h.poll(); await until(() => !h.q('signin-link').hidden);
  assert.equal(h.q('signin-link').getAttribute('href'), '/login');
  assert.equal(h.d.querySelectorAll('img[src]').length, 0);
  assert.equal(h.q('generate-button').disabled, true);
  assert.equal(h.polls.size, 0);
});

test('cancel while consent is pending clears locally and prevents image submission when consent resolves', async t => {
  const gate = deferred();
  const h = harness(t, (req, fallback) => req.path.endsWith('/consent') ? gate.promise : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit(); h.q('cancel-generation').click();
  assert.equal(h.d.querySelectorAll('img[src]').length, 0);
  gate.resolve(response({ consentId: 'late-consent' })); await pause();
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 0);
  assert.match(h.q('action-error').textContent, /before your photo was sent/);
});

test('cancel during generation POST waits for acknowledgement then stops exactly that set', async t => {
  const gate = deferred();
  const h = harness(t, (req, fallback) => req.path.endsWith('/generate') ? gate.promise : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit();
  await until(() => h.requests.some(req => req.path.endsWith('/generate')));
  const id = h.requests.find(req => req.path.endsWith('/generate')).body.requestId;
  h.q('cancel-generation').click();
  assert.equal(h.requests.filter(req => req.path.includes('/cancel/')).length, 0);
  gate.resolve(response({ requestId: id, state: 'running' }, 202));
  await until(() => h.requests.some(req => req.path.includes('/cancel/')));
  await until(() => h.d.querySelectorAll('img[src]').length === 0);
  assert.equal(h.requests.filter(req => req.path.includes('/cancel/')).length, 1);
  assert.equal(h.requests.find(req => req.path.includes('/cancel/')).path, `${BASE}/cancel/${id}`);
  assert.match(h.q('action-error').textContent, /cannot be recalled/);
  assert.equal(h.polls.size, 0);
});

test('late read response cannot restore images after confirmed cancellation', async t => {
  const gate = deferred();
  const h = harness(t, (req, fallback) => req.path.includes('/result/') ? gate.promise : fallback(req));
  await h.start(); await h.poll();
  const id = h.requests.find(req => req.path.endsWith('/generate')).body.requestId;
  h.q('cancel-generation').click(); await until(() => h.d.querySelectorAll('img[src]').length === 0);
  gate.resolve(response(fixtureResults(id))); await pause();
  assert.equal(h.d.querySelectorAll('img[src]').length, 0);
  assert.equal(h.d.querySelectorAll('.generated-card').length, 0);
});

test('visibility pauses polling; returning reads the same request without another generation', async t => {
  let reads = 0;
  const h = harness(t, (req, fallback) => req.path.includes('/result/') ? (reads++, response({ requestId: req.path.split('/').pop(), state: 'running' })) : fallback(req));
  await h.start(); assert.equal(h.polls.size, 1);
  h.visibility(true); assert.equal(h.polls.size, 0);
  h.visibility(false); await until(() => reads === 1); await until(() => h.polls.size === 1);
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
});

test('page exit clears images and stale completions; back-forward restoration requires fresh photo and consent', async t => {
  const gate = deferred();
  const h = harness(t, (req, fallback) => req.path.includes('/result/') ? gate.promise : fallback(req));
  await h.start(); await h.poll();
  const id = h.requests.find(req => req.path.endsWith('/generate')).body.requestId;
  h.w.dispatchEvent(new h.w.PageTransitionEvent('pagehide'));
  assert.equal(h.d.querySelectorAll('img[src]').length, 0);
  gate.resolve(response(fixtureResults(id))); await pause();
  assert.equal(h.d.querySelectorAll('img[src]').length, 0);
  h.w.dispatchEvent(new h.w.PageTransitionEvent('pageshow', { persisted: true })); await pause();
  assert.equal(h.q('generate-button').disabled, true);
  assert.equal(h.q('adult-consent').checked, false);
  assert.equal(h.polls.size, 0);
});

test('exhausted authoritative budget prevents a new set even with fresh explicit consent', async t => {
  const h = harness(t); await h.start();
  h.setStatus({ ...STATUS, budget: { ...STATUS.budget, remainingSets: 0, reservedCents: 320 } });
  await h.poll(); await until(() => h.q('availability-title').textContent === 'Pilot allowance used');
  h.consent(); h.submit();
  assert.equal(h.q('generate-button').disabled, true);
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
  assert.match(h.q('budget-message').textContent, /0 sets remaining of 2/);
});

test('privacy notice refresh resets earlier acceptance and uses only the new disclosed version', async t => {
  const h = harness(t); await h.ready(); await h.choose(); h.consent();
  h.setStatus({ ...STATUS, noticeVersion: 'test-v2', disclosure: 'Updated offline privacy notice.' });
  h.q('refresh-status').click();
  await until(() => h.q('notice-version').textContent.includes('test-v2'));
  assert.equal(h.q('adult-consent').checked, false); assert.equal(h.q('google-consent').checked, false);
  h.consent(); h.submit(); await until(() => h.requests.some(req => req.path.endsWith('/consent')));
  assert.equal(h.requests.find(req => req.path.endsWith('/consent')).body.noticeVersion, 'test-v2');
});

test('explicit new set receives a fresh request ID only after fresh consent', async t => {
  const h = harness(t); await h.start(); await h.poll();
  await until(() => h.q('results-count').textContent === 'Your 3 previews are ready');
  await until(() => h.q('budget-message').textContent.includes('2 sets'));
  h.submit(); assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
  h.consent(); h.submit(); await until(() => h.requests.filter(req => req.path.endsWith('/generate')).length === 2);
  const ids = h.requests.filter(req => req.path.endsWith('/generate')).map(req => req.body.requestId);
  assert.notEqual(ids[0], ids[1]);
});

test('clear photos removes source and all generated DOM images without modifying bookings', async t => {
  const h = harness(t); await h.start(); await h.poll();
  await until(() => !h.q('results-actions').hidden);
  h.q('clear-results').click();
  assert.equal(h.d.querySelectorAll('img[src]').length, 0);
  assert.equal(h.q('google-consent').checked, false);
  assert.equal(h.q('photo-selected').hidden, true);
  assert.equal(h.d.activeElement.id, 'photo-file');
  assert.equal(h.jsErrors.length, 0);
});

test('explicit generation rejection releases the form, resets consent, and refreshes allowance without polling or retry', async t => {
  const h = harness(t, (req, fallback) => req.path.endsWith('/generate') ? response({ error: 'budget_exhausted' }, 409) : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit();
  await until(() => !h.q('action-error').hidden);
  assert.match(h.q('action-error').textContent, /allowance is used|allowance has been used/);
  assert.equal(h.q('photo-file').disabled, false);
  assert.equal(h.q('google-consent').checked, false);
  assert.equal(h.requests.filter(req => req.path.includes('/result/')).length, 0);
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
});

test('uncertain cancellation keeps new generation locked and supports read-only result checking', async t => {
  const h = harness(t, (req, fallback) => req.path.includes('/cancel/') ? Promise.reject(new Error('offline')) : fallback(req));
  await h.start(); h.q('cancel-generation').click();
  await until(() => !h.q('check-results').hidden);
  assert.match(h.q('progress-detail').textContent, /couldn’t confirm cancellation/);
  assert.equal(h.q('generate-button').disabled, true);
  assert.equal(h.q('photo-file').disabled, true);
  h.q('check-results').click();
  await until(() => h.q('results-count').textContent === 'Your 3 previews are ready');
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 1);
});

test('mismatched result ID never renders someone else’s result', async t => {
  const h = harness(t, (req, fallback) => req.path.includes('/result/') ? response(fixtureResults('not-this-request')) : fallback(req));
  await h.start(); await h.poll();
  await until(() => !h.q('check-results').hidden);
  assert.equal(h.d.querySelectorAll('.generated-frame').length, 0);
  assert.equal(h.q('generate-button').disabled, true);
});

test('malformed output images and duplicate style IDs cannot claim three completed previews', async t => {
  const h = harness(t, (req, fallback) => {
    if (!req.path.includes('/result/')) return fallback(req);
    const data = fixtureResults(req.path.split('/').pop());
    data.suggestions[2] = data.suggestions[0];
    data.previews[1].image = { mimeType: 'text/html', data: PNG.toString('base64') };
    data.previews[2] = data.previews[0];
    return response(data);
  });
  await h.start(); await h.poll(); await until(() => !h.q('action-error').hidden);
  assert.equal(h.d.querySelectorAll('.generated-frame').length, 1);
  assert.match(h.q('action-error').textContent, /Only 1 of 3/);
  assert.notEqual(h.q('results-count').textContent, 'Your 3 previews are ready');
});

test('long exact disclosure is shown without truncation before acceptance', async t => {
  const disclosure = 'Exact notice. '.repeat(1600) + 'Final important sentence.';
  const h = harness(t, (req, fallback) => req.path.endsWith('/status') ? response({ ...STATUS, disclosure }) : fallback(req));
  await h.ready();
  assert.equal(h.q('provider-disclosure').textContent, disclosure);
});

test('malformed consent response never triggers generation', async t => {
  const h = harness(t, (req, fallback) => req.path.endsWith('/consent') ? response({ success: true }) : fallback(req));
  await h.ready(); await h.choose(); h.consent(); h.submit();
  await until(() => !h.q('action-error').hidden);
  assert.equal(h.requests.filter(req => req.path.endsWith('/generate')).length, 0);
  assert.match(h.q('action-error').textContent, /photo was not sent/);
});
