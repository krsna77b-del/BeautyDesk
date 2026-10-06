'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { JSDOM, read, domHarness, pause, response } = require('./support.cjs');
const waitUntil = async (predicate, label, timeout = 2500) => { const start = Date.now(); while (!predicate()) { if (Date.now() - start > timeout) throw Error('Timed out: ' + label); await pause(10); } };
const service = { id: 'synthetic-photo-service', client_id: 'synthetic-photo-owner', name: 'Synthetic fixture manicure', price: 250, duration_mins: 45, active: 1, photo_eligible: 1, photo_category: 'nails', photo_description: 'Single colour only; no removal.' };
function fixture(extra = {}) { return { saved: false, host: { ready: true, reason: 'configured_not_live_verified' }, services: [{ ...service }], ...extra }; }
async function openPhoto(kind, state) {
  const requests = [];
  const fetcher = async (url, options = {}) => {
    assert.equal(new URL(url, 'http://127.0.0.1').origin, 'http://127.0.0.1', 'all requests stay local');
    requests.push({ url, options });
    if (url === '/api/v1/session') return response({ user: { id: service.client_id, name: 'Fictional Owner' }, salon: { name: 'Fictional Photo QA', slug: 'fictional-photo-qa', timezone: 'Africa/Johannesburg' } });
    if (url === '/api/client/me') {
      const me = { id: service.client_id, salon: 'Fictional Photo QA', photo_estimates_enabled: state.saved, photo_estimates_status: state.host };
      return state.readMe ? state.readMe(me) : response(me);
    }
    if (url === '/api/client/services') return response(state.services);
    if (['/api/client/appointments', '/api/client/recent-messages', '/api/client/simulator/messages', '/api/client/whatsapp-reviews'].includes(url)) return response([]);
    if (url.endsWith('/photo-settings') && options.method === 'PATCH') {
      if (state.cataloguePatch) return state.cataloguePatch(JSON.parse(options.body));
      const body = JSON.parse(options.body); Object.assign(state.services[0], { photo_eligible: Number(body.photoEligible), photo_category: body.photoCategory, photo_description: body.photoDescription }); return response({ ok: true });
    }
    if (url === '/api/client/settings' && options.method === 'PATCH') {
      if (state.patch) return state.patch(JSON.parse(options.body));
      state.saved = JSON.parse(options.body).photoEstimatesEnabled;
      return response({ ok: true });
    }
    throw Error('Unexpected test request ' + url);
  };
  let h;
  if (kind === 'modern') h = domHarness({ pathname: '/pilot', fetcher });
  else {
    // Only the shipped local script is evaluated. No external resources are loaded.
    // Enabling inline handlers here exercises the actual legacy button/change wiring.
    const dom = new JSDOM(read('index.html').replace(/<script\b[^>]*src="[^"]*"[^>]*><\/script>/g, ''), { url: 'http://127.0.0.1/pilot/controls#/client', runScripts: 'dangerously' });
    const w = dom.window; w.scrollTo = () => {}; w.fetch = fetcher; w.eval(read('app.js'));
    h = { w, d: w.document, q: selector => w.document.querySelector(selector), close: () => w.close() };
  }
  const modern = kind === 'modern';
  const toggle = () => h.q(modern ? '[name=photoEstimatesEnabled]' : '#photoEstimatesToggle');
  const button = () => h.q(modern ? '#photo-settings-form button[type=submit]' : '#savePhotoSettingsButton');
  const feedback = () => h.q(modern ? '#photo-setting-feedback' : '#photoSettingsFeedback').textContent;
  const error = () => h.q(modern ? '#photo-settings-form .form-error' : '#photoSettingsFeedback').textContent;
  const savedLabel = () => h.q(modern ? '.photo-facts' : '#photoEstimatesStatus').textContent;
  await waitUntil(() => modern ? h.q('#photo-settings-form') : h.q('#servicesList form'), 'photo controls loaded');
  return { ...h, toggle, button, feedback, error, savedLabel, requests,
    writes: () => requests.filter(r => r.options.method === 'PATCH'),
    choose: value => { toggle().checked = value; toggle().dispatchEvent(new h.w.Event('change', { bubbles: true })); },
    forceSave: () => modern ? h.submit(h.q('#photo-settings-form')) : h.w.savePhotoSettings(),
    refresh: async () => { if (modern) { const old = h.q('#photo-settings-form'); h.q('[data-action=photo-refresh]').click(); await waitUntil(() => h.q('#photo-settings-form') !== old, 'photo status refreshed'); } else await h.w.refreshClientData(true); }
  };
}

for (const host of [{ ready: true, reason: 'configured_not_live_verified' }, { ready: false, reason: 'photo_estimates_disabled' }, { ready: false, reason: 'photo_provider_key_required' }]) {
  test(`modern presentation cannot enable photo analysis even with host ${host.reason}`, async t => {
    const h = await openPhoto('modern', fixture({ host })); t.after(h.close);
    assert.equal(h.toggle().checked, false); assert.equal(h.toggle().disabled, true); assert.equal(h.button().disabled, true);
    assert.doesNotMatch(h.d.body.textContent, /Ready to enable|You can enable this salon/);
    h.choose(true); await h.forceSave(); await pause(15);
    assert.equal(h.writes().length, 0, 'a forced checkbox and submit cannot reach settings API');
    assert.equal(h.button().disabled, true);
    assert.match(h.d.body.textContent, /(?:activation|enable|availability|available)/i);
    assert.equal(h.q('input[type=file]'), null);
    assert.equal(h.q('a[href="/pilot/controls"]').hasAttribute('data-nav'), false, 'legacy support is a full page session-gated route');
  });
}
test('modern catalogue remains editable while ON is withheld; new reads cannot enable it', async t => {
  const state = fixture({ services: [{ ...service, photo_eligible: 0 }] }), h = await openPhoto('modern', state); t.after(h.close);
  const form = h.q('[data-photo-service]');
  form.elements.photoEligible.checked = true; form.elements.photoCategory.value = 'nails'; form.elements.photoDescription.value = 'Single colour manicure. Removal is extra.';
  form.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  h.submit(form); h.submit(form);
  await waitUntil(() => h.q('.photo-service-feedback').textContent.includes('saved'), 'catalogue save');
  assert.equal(h.writes().length, 1); assert.ok(h.writes()[0].url.endsWith('/photo-settings'));
  assert.deepEqual(JSON.parse(h.writes()[0].options.body), { photoEligible: true, photoCategory: 'nails', photoDescription: 'Single colour manicure. Removal is extra.' });
  assert.equal(h.toggle().disabled, true); assert.equal(state.saved, false);
  await h.refresh(); assert.equal(h.toggle().disabled, true); assert.equal(h.toggle().checked, false);
});
test('modern catalogue rejects incomplete enabled descriptions before a write', async t => {
  const h = await openPhoto('modern', fixture()); t.after(h.close);
  const form = h.q('[data-photo-service]'); form.elements.photoEligible.checked = true;
  for (const description of ['Short', 'x'.repeat(401)]) {
    form.elements.photoDescription.value = description; h.submit(form); await pause(10);
    assert.equal(h.writes().length, 0); assert.ok(h.q('[data-photo-service] .form-error').textContent);
  }
});
test('modern saved-on accounts can save OFF once, including with unavailable host/catalogue', async t => {
  const state = fixture({ saved: true, host: { ready: false, reason: 'photo_estimates_disabled' }, services: [] }); let release;
  state.patch = body => new Promise(resolve => { release = () => { state.saved = body.photoEstimatesEnabled; resolve(response({ ok: true })); }; });
  const h = await openPhoto('modern', state); t.after(h.close);
  assert.equal(h.toggle().checked, true); assert.equal(h.toggle().disabled, false); assert.equal(h.button().disabled, true);
  h.choose(false); h.button().click(); h.forceSave();
  assert.equal(h.writes().length, 1); assert.deepEqual(JSON.parse(h.writes()[0].options.body), { photoEstimatesEnabled: false });
  assert.equal(h.toggle().disabled, true); assert.equal(h.button().disabled, true);
  const pendingForm = h.q('#photo-settings-form');
  assert.equal(h.q('[data-action=photo-refresh]').disabled, true); h.q('[data-action=photo-refresh]').click(); await pause(15);
  assert.equal(h.q('#photo-settings-form'), pendingForm); assert.equal(h.toggle().disabled, true); h.forceSave(); assert.equal(h.writes().length, 1);
  release(); await waitUntil(() => /saved off/i.test(h.feedback()), 'OFF persisted');
  assert.equal(h.toggle().checked, false); assert.equal(h.toggle().disabled, true);
  assert.equal(h.q('[data-action=photo-refresh]').disabled, false);
  delete state.patch; const reload = await openPhoto('modern', state); t.after(reload.close);
  assert.equal(reload.toggle().checked, false); assert.equal(reload.toggle().disabled, true);
});
test('modern failed OFF save stays retryable without claiming success', async t => {
  const state = fixture({ saved: true }), h = await openPhoto('modern', state); t.after(h.close); h.choose(false);
  for (const failure of [() => response({ error: 'request_failed' }, 500), () => { throw Error('offline'); }]) {
    state.patch = failure; h.button().click(); await waitUntil(() => h.error() && !h.button().disabled, 'retryable OFF error');
    assert.equal(state.saved, true); assert.equal(h.toggle().checked, false); assert.doesNotMatch(h.feedback(), /saved off/i);
  }
  await h.refresh(); assert.equal(h.toggle().checked, false); assert.equal(h.button().disabled, false);
  delete state.patch; h.button().click(); await waitUntil(() => !state.saved && h.button().disabled, 'OFF retry');
});
test('modern a late OFF save cannot replace newer navigation; expired session returns to photo login', async t => {
  for (const stale of [true, false]) {
    const state = fixture({ saved: true }); let release; state.patch = () => new Promise(resolve => { release = resolve; });
    const h = await openPhoto('modern', state); t.after(h.close); h.choose(false); h.button().click();
    if (stale) { h.w.history.pushState({}, '', '/'); h.w.dispatchEvent(new h.w.PopStateEvent('popstate')); }
    release(stale ? response({ ok: true }) : response({ error: 'unauthorized' }, 401));
    await waitUntil(() => stale ? h.q('.hero') : h.q('#auth-form'), 'current navigation'); await pause(20);
    assert.equal(h.w.location.pathname, stale ? '/' : '/login'); assert.equal(h.q('#photo-settings-form'), null);
    if (!stale) assert.equal(h.w.location.search, '?next=%2Fpilot');
  }
});

test('modern pending catalogue save blocks refresh and duplicate writes until confirmed', async t => {
  const state = fixture(); let release; state.cataloguePatch = () => new Promise(resolve => { release = resolve; });
  const h = await openPhoto('modern', state); t.after(h.close);
  const form = h.q('[data-photo-service]'); form.elements.photoDescription.value = 'Simple shape and single colour. No removal.';
  h.submit(form); h.submit(form); assert.equal(h.writes().length, 1);
  assert.equal(h.q('[data-action=photo-refresh]').disabled, true); h.q('[data-action=photo-refresh]').click(); await pause(15);
  assert.equal(h.q('[data-photo-service]'), form);
  release(response({ ok: true })); await waitUntil(() => h.q('.photo-service-feedback').textContent.includes('saved'), 'catalogue saved');
  assert.equal(h.q('[data-action=photo-refresh]').disabled, false); assert.equal(h.toggle().disabled, true);
});
