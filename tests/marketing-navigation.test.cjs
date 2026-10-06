const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');
const pilot = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function pilotRouter({ signedIn = true, pathname = '/pilot/controls' } = {}) {
  const nodes = new Map(), listeners = {}, calls = [], renders = [], redirects = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, addEventListener() {} });
    return nodes.get(id);
  };
  const context = {
    location: { hash: '', pathname, search: '', replace(url) { redirects.push(url); } },
    history: { pushState() {} },
    window: { scrollTo() {}, addEventListener(name, handler) { listeners[name] = handler; } },
    document: { hidden: false, addEventListener() {} }, byId: node,
    api: async (method, url) => {
      calls.push({ method, url });
      if (!signedIn) throw Object.assign(new Error('not_authenticated'), { status: 401 });
      return { id: 'fixture', salon: 'Test salon' };
    },
    renderClient: async me => { renders.push(me.id); },
    setInterval: () => 1, clearInterval() {},
    toast(message) { throw new Error(message); }, errorMessage: error => error.message,
  };
  vm.createContext(context);
  vm.runInContext(pilot.slice(pilot.indexOf('let ACTIVE_VIEW'), pilot.indexOf('/* ============ OWNER PORTAL')), context);
  return { context, nodes, listeners, calls, renders, redirects };
}

test('Photo pilot links enter session-protected controls without SPA interception', () => {
  const links = [...ui.matchAll(/<a\b[^>]*href="\/pilot\/controls"[^>]*>/g)].map(match => match[0]);
  assert.equal(links.length, 3, 'marketing footer, workspace sidebar and Messages link');
  for (const link of links) assert.doesNotMatch(link, /data-nav/);
  assert.match(ui, /href="\/pilot\/admin"/);
});

test('authenticated pilot controls survive anchors, reload and history restore without marketing', async () => {
  const { context, nodes, renders, listeners } = pilotRouter();
  context.go(context.viewForHash(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('view-client').hidden, false);
  assert.equal(nodes.get('client-dash').hidden, false);
  assert.deepEqual(renders, ['fixture']);
  context.location.hash = '#pricing'; listeners.popstate();
  assert.equal(context.viewForHash(), 'client');
  listeners.pagehide(); assert.equal(nodes.get('view-client').hidden, true);
  listeners.pageshow({ persisted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('view-client').hidden, false);
  assert.equal(renders.length, 2);
  assert.doesNotMatch(html, /id="view-site"|id="signupModal"/);
});

test('expired salon sessions redirect to current login; Back to site always uses current home', async () => {
  const { context, nodes, redirects } = pilotRouter({ signedIn: false });
  context.go(context.viewForHash(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('client-dash').hidden, true);
  assert.deepEqual(redirects, ['/login?next=photo-pilot']);
  context.go('site');
  assert.equal(redirects.at(-1), '/');
  const backLinks = [...html.matchAll(/<a[^>]*>[^<]*(?:← )?Back to site<\/a>/g)];
  assert.equal(backLinks.length, 2);
  assert.ok(backLinks.every(link => /href="\/"/.test(link[0])));
  assert.match(html, /href="\/signup"[^>]*>Request pilot access/);
  assert.match(html, /id="photoEstimatesPanel"/);
});

test('old bookmarks resolve safely and login continuation is allowlisted', () => {
  const context = { URLSearchParams, location: { search: '' } };
  vm.createContext(context);
  vm.runInContext(ui.slice(ui.indexOf('function pilotDestination'), ui.indexOf('async function renderRoute')), context);
  for (const hash of ['', '#', '#pricing', '#/other', '#/client-malicious']) assert.equal(context.pilotDestination(hash), '/');
  for (const hash of ['#/client', '#cl-whatsapp']) assert.equal(context.pilotDestination(hash), '/pilot/controls');
  for (const hash of ['#/admin', '#adm-inquiries']) assert.equal(context.pilotDestination(hash), '/pilot/admin');
  for (const search of ['', '?next=https://example.invalid', '?next=//example.invalid', '?next=/pilot/admin']) {
    context.location.search = search; assert.equal(context.afterLoginDestination(), '');
  }
  context.location.search = '?next=photo-pilot'; assert.equal(context.afterLoginDestination(), '/pilot/controls');
});

test('visible pages and pilot status labels contain no promotional AI wording', () => {
  for (const source of [html, ui, pilot]) assert.doesNotMatch(source.replaceAll('whatsapp-ai', ''), /\bAI\b|artificial intelligence|Claude configured|Claude AI/i);
  assert.match(fs.readFileSync(path.join(root, 'photo-flow.js'), 'utf8'), /send this photo.*to Anthropic/);
});

test('homepage renders an accessible WhatsApp example with honest setup and photo limits', () => {
  // Execute the shipped rendering functions and helpers without running application startup.
  const context = { document: { title: '' } };
  vm.createContext(context);
  vm.runInContext(ui.slice(ui.indexOf('const $ ='), ui.indexOf('function authPage(')) + '\nglobalThis.page = marketing();', context);
  const page = context.page;
  assert.match(page, /Your salon, with a WhatsApp receptionist/);
  assert.match(page, /href="#whatsapp-demo">See WhatsApp demo/);
  assert.match(page, /id="whatsapp-demo" aria-labelledby="whatsapp-demo-title"/);
  assert.match(page, /<ol class="whatsapp-demo-messages" aria-label="Example conversation">/);
  assert.equal((page.match(/class="demo-speaker"/g) || []).length, 4);
  assert.match(page, /<figcaption id="whatsapp-demo-caption">Illustrative demo only/);
  assert.match(page, /No message is sent and no appointment is booked/);
  assert.match(page, /Setup required/);
  assert.match(page, /Automated reminders are not enabled/);
  assert.match(page, /Photo estimates are unavailable until provider and privacy setup/);
  assert.match(page, /no browser photo-upload tool/);
  assert.doesNotMatch(page, /<input|<textarea|data-action="send|wa\.me\//);
  const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'generated homepage IDs are unique');
});

test('preview card and badge stay upright, while the WhatsApp demo has bounded responsive layout', () => {
  for (const selector of ['.preview-card', '.floating-note']) {
    const rule = css.match(new RegExp('\\' + selector + '\\{([^}]+)\\}'));
    assert.ok(rule, selector);
    assert.match(rule[1], /transform:none/);
    const allRules = [...css.matchAll(new RegExp('\\' + selector + '\\{([^}]+)\\}', 'g'))];
    assert.ok(allRules.every(match => !/transform:rotate/.test(match[1])), 'no responsive tilt override');
  }
  assert.match(css, /\.whatsapp-demo\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(css, /@media\(max-width:700px\)\{\.whatsapp-demo\{grid-template-columns:1fr/);
  assert.match(css, /\.hero-actions\{flex-wrap:wrap\}/);
  assert.match(css, /@media\(max-width:380px\)[^\n]*\.hero-actions\{flex-direction:column;align-items:stretch\}/);
  assert.match(css, /\.whatsapp-photo-note summary\{[^}]*min-height:44px/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});
