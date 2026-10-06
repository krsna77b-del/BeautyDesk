'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { domHarness, pause, response } = require('./support.cjs');
const waitUntil = async (predicate, label, timeout = 2500) => { const start = Date.now(); while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Timed out: ' + label); await pause(10); } };
for (const width of [320, 390, 768, 1440]) {
  test(`homepage menu/chat/hash history interactions at width setting ${width} (no geometry)`, async t => {
    const h = domHarness({ width }); t.after(h.close); const { q, d, w } = h;
    assert.equal(q('.hero h1').textContent, 'Your salon.Your bookings.Automaticallymanaged.');
    const menu = () => q('.bd-shortcuts'), toggle = () => q('.bd-shortcuts-toggle');
    assert.equal(menu().open, false);
    for (let i = 0; i < 3; i++) {
      toggle().click(); assert.equal(menu().open, true); assert.equal(d.activeElement, q('#bd-shortcuts-menu a'));
      h.press('Escape'); assert.equal(menu().open, false); assert.equal(d.activeElement, toggle());
    }
    toggle().click(); q('.hero h1').click(); assert.equal(menu().open, false);
    toggle().click(); q('.bd-launcher').click(); assert.equal(menu().open, false);
    assert.equal(q('.bd-panel').hidden, false); assert.ok(q('#app').hasAttribute('inert'));
    assert.equal(d.activeElement, q(width <= 600 ? '.bd-close' : '.bd-input'));
    q('.bd-send').focus(); h.press('Tab'); assert.equal(d.activeElement, q('.bd-close'));
    h.press('Tab', true); assert.equal(d.activeElement, q('.bd-send'));
    q('.bd-input').value = 'Pricing'; h.submit(q('.bd-composer'));
    await waitUntil(() => q('.bd-body').textContent.includes('R799 per month'), 'scripted pricing reply');
    h.press('Escape'); assert.equal(q('.bd-panel').hidden, true); assert.equal(q('#app').hasAttribute('inert'), false); assert.equal(d.body.style.position, '');
    const widget = q('#bd-assistant-widget'), conversation = q('.bd-body').textContent;
    for (const hash of ['#features', '#pricing', '#questions', '#whatsapp-demo', '#main']) {
      if (hash !== '#main') toggle().click();
      q('a[href="' + hash + '"]').click(); await pause(15);
      assert.equal(w.location.hash, hash); assert.equal(d.activeElement.id, hash.slice(1));
      assert.equal(q('#bd-assistant-widget'), widget); assert.equal(q('.bd-body').textContent, conversation);
      assert.equal(menu().open, false);
    }
    w.BeautyDeskAssistantWidget.open(); w.history.back();
    await waitUntil(() => w.location.hash === '#whatsapp-demo', 'hash Back');
    assert.equal(d.activeElement.id, 'whatsapp-demo'); assert.equal(q('.bd-panel').hidden, true);
    assert.equal(q('#app').hasAttribute('inert'), false); assert.equal(d.body.style.position, '');
    assert.equal(q('#bd-assistant-widget'), widget); assert.equal(q('.bd-body').textContent, conversation);
    w.history.forward(); await waitUntil(() => w.location.hash === '#main', 'hash Forward'); assert.equal(d.activeElement.id, 'main');
    assert.equal(q('#bd-assistant-widget'), widget);
    // The real authentication guard must run after leaving the public page.
    toggle().click(); q('#bd-shortcuts-menu a[href="/pilot"]').click();
    await waitUntil(() => w.location.pathname === '/login', 'photo guard');
    assert.equal(w.location.search, '?next=%2Fpilot'); assert.equal(q('#bd-assistant-widget'), null);
    assert.equal(q('#auth-form').dataset.mode, 'login'); assert.ok(q('.auth-back'));
    q('.auth-back').click(); assert.equal(w.location.pathname, '/'); assert.ok(q('#bd-assistant-widget'));
    assert.equal(d.querySelectorAll('#bd-assistant-widget').length, 1);
    w.history.back(); await waitUntil(() => w.location.pathname === '/login', 'route Back'); assert.equal(q('#bd-assistant-widget'), null);
    w.history.forward(); await waitUntil(() => w.location.pathname === '/', 'route Forward'); assert.ok(q('#bd-assistant-widget'));
    assert.equal(h.requests.filter(request => request.method !== 'GET').length, 0, 'homepage and scripted chat never mutate APIs');
    assert.deepEqual(h.errors, []);
  });
}
test('scripted answers are accurate, queued, injection-safe and never submitted as support', async t => {
  const h = domHarness(); t.after(h.close); const { q, w } = h; w.BeautyDeskAssistantWidget.open();
  const cases = [['Pricing', /R799.*month/], ['How it works', /real account.*provider setup.*not live.*photo estimates are off/], ['Book a demo', /cannot create an account, arrange a walkthrough or make a booking/], ['WhatsApp', /provider setup, verification and end-to-end testing/], ['sign up', /real account is required/], ['payments', /manual payment records/], ['reminders', /Automated reminders are not live/], ['upload photo', /Photo estimates are off/], ['<img src=x onerror=alert(1)>', /scripted demo/]];
  for (const [question] of cases) { q('.bd-input').value = question; h.submit(q('.bd-composer')); }
  await waitUntil(() => q('.bd-body').querySelectorAll('.bd-message-system').length === cases.length + 1, 'all queued replies', 8000);
  const replies = [...q('.bd-body').querySelectorAll('.bd-message-system')].slice(1);
  cases.forEach(([, pattern], index) => assert.match(replies[index].textContent, pattern));
  assert.equal(q('.bd-body img'), null); assert.equal(q('.bd-body').querySelectorAll('.bd-message-customer').length, cases.length);
  q('.bd-input').value = '  '; h.submit(q('.bd-composer')); await pause(20); assert.equal(q('.bd-body').querySelectorAll('.bd-message-customer').length, cases.length);
  q('.bd-input').value = 'x'.repeat(1200); h.submit(q('.bd-composer')); assert.equal(q('.bd-body').querySelector('.bd-message-customer:last-child').textContent.length, 1000);
  assert.equal(h.requests.length, 0);
});
for (const pathname of ['/dashboard', '/pilot', '/onboarding', '/subscription']) test('signed-out route is guarded: ' + pathname, async t => {
  const h = domHarness({ pathname }); t.after(h.close);
  await waitUntil(() => h.w.location.pathname === '/login', 'owner authentication');
  assert.equal(h.q('#auth-form').dataset.mode, 'login'); assert.equal(h.q('#bd-assistant-widget'), null);
  assert.equal(h.w.location.search, pathname.startsWith('/pilot') ? '?next=%2Fpilot' : '');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, '/api/v1/session');
  assert.equal(h.q('.sidebar'), null); assert.deepEqual(h.errors, []);
});
test('duplicate login submits are suppressed and errors leave a retryable real form', async t => {
  let release;
  const h = domHarness({ pathname: '/login', fetcher: () => new Promise(resolve => { release = resolve; }) }); t.after(h.close);
  h.q('#email').value = 'ui-regression@example.test'; h.q('#password').value = 'test-only-fictional-password';
  const form = h.q('#auth-form'); h.submit(form); h.submit(form);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, '/api/v1/auth/login');
  assert.equal(h.q('button[type=submit]').disabled, true);
  release(response({ error: 'invalid_credentials' }, 401));
  await waitUntil(() => !h.q('button[type=submit]').disabled, 'form re-enabled');
  assert.match(h.q('.form-error').textContent, /doesn.t match/); assert.equal(h.w.location.pathname, '/login');
});
test('late login result cannot replace newer home navigation', async t => {
  let release;
  const h = domHarness({ pathname: '/login?next=%2Fpilot', fetcher: () => new Promise(resolve => { release = resolve; }) }); t.after(h.close);
  h.q('#email').value = 'stale-ui@example.test'; h.q('#password').value = 'test-only-fictional-password';
  h.submit(h.q('#auth-form')); h.q('.auth-back').click(); const widget = h.q('#bd-assistant-widget');
  release(response({ user: { id: 'synthetic-ui' }, salon: { id: 'synthetic-ui', name: 'Synthetic Test Salon' } })); await pause(30);
  assert.equal(h.w.location.pathname, '/'); assert.equal(h.q('#bd-assistant-widget'), widget); assert.equal(h.requests.length, 1); assert.deepEqual(h.errors, []);
});
test('late session response cannot restore an abandoned guarded route', async t => {
  let release;
  const h = domHarness({ pathname: '/pilot', fetcher: () => new Promise(resolve => { release = resolve; }) }); t.after(h.close);
  h.w.history.pushState({}, '', '/'); h.w.dispatchEvent(new h.w.PopStateEvent('popstate')); const widget = h.q('#bd-assistant-widget');
  release(response({ error: 'unauthorized' }, 401)); await pause(30);
  assert.equal(h.w.location.pathname, '/'); assert.equal(h.q('#bd-assistant-widget'), widget); assert.deepEqual(h.errors, []);
});
test('route changes cancel pending widget replies, release locks and remount once', async t => {
  const h = domHarness(); t.after(h.close); const { q, w } = h;
  const old = q('#bd-assistant-widget'); w.BeautyDeskAssistantWidget.open(); q('.bd-input').value = 'Pricing'; h.submit(q('.bd-composer'));
  w.history.pushState({}, '', '/login'); w.dispatchEvent(new w.PopStateEvent('popstate'));
  assert.equal(q('#bd-assistant-widget'), null); assert.equal(q('#app').hasAttribute('inert'), false); assert.equal(h.d.body.style.position, '');
  await pause(600); assert.equal(old.querySelectorAll('.bd-message-system').length, 1, 'pending reply was cancelled');
  q('.auth-back').click(); const fresh = q('#bd-assistant-widget'); assert.notEqual(fresh, old);
  w.BeautyDeskAssistantWidget.mount(); w.BeautyDeskAssistantWidget.mount(); assert.equal(h.d.querySelectorAll('#bd-assistant-widget').length, 1);
  assert.equal(fresh.querySelectorAll('.bd-message-customer').length, 0); assert.deepEqual(h.errors, []);
});
for (const [width, height] of [[768, 375], [1280, 500]]) test(`short-height compact style contract at ${width}x${height} (no geometry)`, async t => {
  const h = domHarness({ width, height, includeCSS: true }); t.after(h.close); h.w.BeautyDeskAssistantWidget.open();
  const panel = h.q('.bd-panel'); assert.equal(panel.style.maxHeight, (height - 24) + 'px'); assert.equal(panel.style.bottom, '12px');
  assert.equal(parseFloat(h.w.getComputedStyle(h.q('.bd-body')).minHeight), 0);
  assert.equal(h.w.getComputedStyle(h.q('.bd-quick-replies')).display, 'none'); assert.equal(h.w.getComputedStyle(h.q('.bd-launcher')).visibility, 'hidden');
  h.viewport.height = 300; h.viewport.offsetTop = 20; h.viewport.dispatchEvent(new h.w.Event('resize')); await pause(30);
  assert.equal(panel.style.maxHeight, '276px'); assert.equal(panel.style.bottom, Math.max(0, height - 20 - 300) + 12 + 'px');
  h.w.BeautyDeskAssistantWidget.close(); assert.equal(panel.style.maxHeight, ''); assert.equal(h.q('#bd-assistant-widget').hasAttribute('data-bd-short'), false);
});
for (const pathname of ['/signup', '/login']) for (const lower of [false, true]) test(`${pathname} ${lower ? 'lower' : 'upper'} Back link opens current home`, async t => {
  const h = domHarness({ pathname }); t.after(h.close);
  const selector = lower ? '.auth-footer a[href="/"]' : '.auth-back';
  assert.ok(h.q(selector)); h.q(selector).click();
  await waitUntil(() => h.w.location.pathname === '/' && h.q('.hero'), 'current home');
  assert.equal(h.q('#view-site'), null); assert.equal(h.q('#signupModal'), null); assert.ok(h.q('#bd-assistant-widget'));
  assert.equal(h.requests.length, 0); assert.deepEqual(h.errors, []);
});
test('authenticated subscription displays R799 monthly with pending PayFast and no charge action', async t => {
  const h = domHarness({ pathname: '/subscription', fetcher: async url => {
    if (url === '/api/v1/session') return response({ user: { id: 'synthetic-user', name: 'Fictional Owner' }, salon: { name: 'Fictional Subscription QA', slug: 'fictional-subscription-qa' } });
    if (url === '/api/v1/subscription') return response({ status: 'trial', paymentProvider: 'not_connected' });
    throw Error('Unexpected test request ' + url);
  } }); t.after(h.close);
  await waitUntil(() => h.q('#main')?.textContent.includes('R799 per month'), 'subscription pricing');
  assert.match(h.q('#main').textContent, /PayFast activation is pending/);
  assert.match(h.q('#main').textContent, /No checkout or automatic billing is enabled/);
  assert.equal(h.q('#main input'), null); assert.equal(h.q('#main form'), null);
  assert.equal(h.q('#bd-assistant-widget'), null); assert.ok(h.requests.every(request => request.method === 'GET')); assert.deepEqual(h.errors, []);
});
