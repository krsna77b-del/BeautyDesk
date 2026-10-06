'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), net = require('node:net'), { spawn } = require('node:child_process');
const { fs, path, root, read, JSDOM, domHarness, pause } = require('./support.cjs');
const waitUntil = async (condition, label, timeout = 8000) => { const start = Date.now(); while (!condition()) { if (Date.now() - start > timeout) throw new Error('Timed out: ' + label); await pause(20); } };
test('fresh isolated server: HTTP/CSP/static boundaries, real signup/session and modern photo routing', { timeout: 40000 }, async t => {
  assert.equal(fs.existsSync(path.join(root, '.env')), false, 'Refusing to launch test server beside a .env file');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-new-reconstruction-http-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.env.BD_NODE || process.execPath, ['--require', path.join(__dirname, 'network-isolation.cjs'), 'server.js'], {
    cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), DB_PATH: path.join(dir, 'fictional-fixture.db'), JWT_SECRET: 'fictional-only-reconstruction-jwt-over-32-bytes', ADMIN_PASSCODE: 'fictional-only-reconstruction-admin', PHOTO_ESTIMATES_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt++) { if (child.exitCode !== null) throw new Error('Test server exited: ' + logs); try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {} await pause(25); }
  assert.ok(ready, 'Server failed to start: ' + logs);
  await t.test('static marketing, scripts and security headers are served correctly', async () => {
    const res = await fetch(base + '/'), html = await res.text(); assert.equal(res.status, 200); assert.equal(html, read('marketing.html'));
    const csp = res.headers.get('content-security-policy'); assert.match(csp, /script-src 'self';/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff'); assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const staticDoc = new JSDOM(html); assert.ok(staticDoc.window.document.querySelector('#questions')); assert.match(staticDoc.window.document.querySelector('#main').textContent, /Your salon/); staticDoc.window.close();
    for (const asset of ['ui.js', 'ui.css', 'assistant-widget.js', 'assistant-widget.css']) { const response = await fetch(base + '/' + asset); assert.equal(response.status, 200, asset); assert.equal(await response.text(), read(asset)); }
    for (const route of ['/login', '/signup', '/dashboard', '/pilot', '/subscription']) { const response = await fetch(base + route); assert.equal(response.status, 200, route); assert.equal(await response.text(), read('ui.html')); assert.equal(response.headers.get('content-security-policy'), csp); }
    for (const [route, target] of [['/pilot/controls', '/login?next=photo-pilot'], ['/pilot/admin', '/platform?next=pilot-admin']]) { const guarded = await fetch(base + route, { redirect: 'manual' }); assert.equal(guarded.status, 302, route); assert.equal(guarded.headers.get('location'), target); }
  });
  await t.test('private source, database and development files are never exposed', async () => {
    for (const file of ['/db.js', '/server.js', '/package.json', '/.env', '/.git/config', '/tests/frontend.test.cjs', '/scripts/backup.cjs', '/data/beautydesk.db', '/verification/baseline-manifest.json', '/modules/routes.js', '/source-snapshots/selected-candidate/ui.js', '/qa/support.cjs', '/qa/fixtures/approved/ui.js', '/reconstruction/PROVENANCE.json']) assert.equal((await fetch(base + file)).status, 404, file);
  });
  await t.test('owner APIs reject signed-out callers and unsafe origins', async () => {
    for (const route of ['/api/v1/session', '/api/v1/dashboard', '/api/v1/customers', '/api/client/me', '/api/client/services']) assert.equal((await fetch(base + route)).status, 401, route);
    const invalid = await fetch(base + '/api/v1/auth/signup', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(invalid.status, 403);
    const weak = await fetch(base + '/api/v1/auth/signup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Fictional owner', salonName: 'Fictional QA Salon', email: 'weak@example.test', password: 'short' }) }); assert.equal(weak.status, 400); assert.equal((await weak.json()).error, 'weak_password');
  });
  await t.test('shipped signup UI creates only a real disposable account and uses it for the guarded photo workspace', async () => {
    let cookie = '';
    const h = domHarness({ pathname: '/signup', fetcher: async (url, options = {}) => {
      const response = await fetch(base + url, { ...options, headers: { ...(options.headers || {}), Origin: base, ...(cookie ? { Cookie: cookie } : {}) } });
      const value = response.headers.get('set-cookie'); if (value) cookie = value.split(';')[0]; return response;
    } });
    try {
      for (const [key, value] of Object.entries({ name: 'Fictional regression owner', salonName: 'Fictional Reconstruction QA', email: 'reconstruction-ui@example.test', password: 'fictional-regression-password' })) h.q('#auth-form').elements[key].value = value;
      h.submit(h.q('#auth-form')); h.submit(h.q('#auth-form'));
      await waitUntil(() => h.w.location.pathname === '/onboarding' && h.q('#salon-form'), 'real signup/onboarding');
      assert.equal(h.requests.filter(request => request.path === '/api/v1/auth/signup').length, 1);
      assert.ok(cookie.startsWith('bd_client='));
      const legacy = await fetch(base + '/pilot/controls', { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(legacy.status, 200); assert.equal(await legacy.text(), read('index.html'));
      assert.doesNotMatch(read('index.html'), /id="view-site"|id="signupModal"/);
      const adminDenied = await fetch(base + '/pilot/admin', { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(adminDenied.status, 302); assert.equal(adminDenied.headers.get('location'), '/platform?next=pilot-admin');

      const apiGet = async route => { const response = await fetch(base + route, { headers: { Cookie: cookie } }); assert.equal(response.status, 200, route); return response.json(); };
      const session = await apiGet('/api/v1/session'); assert.equal(session.salon.name, 'Fictional Reconstruction QA'); assert.equal(session.salon.bookingEnabled, false);
      for (const resource of ['services', 'customers', 'bookings', 'payments']) assert.deepEqual(await apiGet('/api/v1/' + resource), [], 'new account must not contain demo ' + resource);
      h.w.history.pushState({}, '', '/pilot'); h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));
      await waitUntil(() => h.q('#photo-settings-form'), 'authenticated photo workspace');
      assert.ok(h.q('.sidebar')); assert.equal(h.q('#bd-assistant-widget'), null); assert.equal(h.q('#photo-settings-form').elements.photoEstimatesEnabled.disabled, true);
      assert.match(h.q('#app').textContent, /Photo analysis is off|separate reviewed.*release/i); assert.equal(h.q('input[type=file]'), null);
      const mutationCount = h.requests.filter(request => request.method !== 'GET').length;
      h.q('#photo-settings-form').elements.photoEstimatesEnabled.checked = true; h.submit(h.q('#photo-settings-form')); await pause(25);
      assert.equal(h.requests.filter(request => request.method !== 'GET').length, mutationCount, 'forcing the photo checkbox cannot enable analysis');
      h.q('[data-action=logout]').click(); await waitUntil(() => h.w.location.pathname === '/login', 'logout');
      assert.equal((await fetch(base + '/api/v1/session', { headers: { Cookie: cookie } })).status, 401);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
  await t.test('legacy administrator page requires a separate administrator session and has no old landing', async () => {
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'fictional-only-reconstruction-admin' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    const page = await fetch(base + '/pilot/admin', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(page.status, 200); assert.equal(await page.text(), read('index.html'));
    const salonDenied = await fetch(base + '/pilot/controls', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(salonDenied.status, 302); assert.equal(salonDenied.headers.get('location'), '/login?next=photo-pilot');
  });
  assert.doesNotMatch(logs, /NONLOCAL_NETWORK_BLOCKED/, 'no external provider call should have been attempted');
});
