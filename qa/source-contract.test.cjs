'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { fs, path, JSDOM, root, expected, baseline, read, renderPages } = require('./support.cjs');
test('reviewed shell and widget styles are retained exactly', () => {
  for (const file of ['ui.html', 'assistant-widget.css']) assert.equal(read(file), read(file, expected));
});
test('reviewed widget differs only in approved price, payment and photo answer copy', () => {
  const original = read('assistant-widget.js', expected), actual = read('assistant-widget.js');
  const originalLines = original.split('\n'), actualLines = actual.split('\n');
  assert.equal(actualLines.length, originalLines.length, 'pricing edit retains widget implementation');
  const changes = actualLines.map((line, i) => line === originalLines[i] ? null : [originalLines[i], line]).filter(Boolean);
  assert.equal(changes.length, 4, 'three bounded answer changes and PayFast answer recognition');
  for (const [before, after] of changes) {
    if (before.trim().startsWith('if (')) { assert.equal(after.replace('payfast|', ''), before); continue; }
    assert.match(before, /^\s*(?:pricing|payments|photo):/);
    assert.match(after, /R799|PayFast|1–3 text suggestions/);
  }
});
test('original hero is unchanged from approved snapshot and recovered production', () => {
  const hero = source => source.slice(source.indexOf('<section class="hero">'), source.indexOf('${whatsappDemo()}', source.indexOf('<section class="hero">')));
  assert.equal(hero(read('ui.js')), hero(read('ui.js', baseline)));
  assert.equal(crypto.createHash('sha256').update(hero(read('ui.js'))).digest('hex'), '4396ecc5462f031965e04192d11dc36d245d110dbd69ceddcc1ef435dd112ec5');
});
test('signup form is preserved, real and separate from marketing demo', () => {
  const doc = html => new JSDOM(html).window.document;
  const actual = doc(renderPages().signup), original = doc(renderPages(baseline).signup);
  assert.equal(actual.querySelector('#auth-form').outerHTML, original.querySelector('#auth-form').outerHTML);
  assert.equal(actual.querySelector('#auth-form').dataset.mode, 'signup');
  assert.equal(actual.querySelector('input[name=password]').minLength, 12);
  assert.deepEqual([...actual.querySelectorAll('#auth-form input')].map(el => el.name), ['name', 'salonName', 'email', 'password']);
  assert.match(read('ui.js'), /api\('\/auth\/\s*'\+f\.dataset\.mode|api\('\/auth\/'\+f\.dataset\.mode/);
});
test('upper and original lower home links exist before/after login and signup forms', () => {
  for (const kind of ['login', 'signup']) {
    const d = new JSDOM(renderPages()[kind]).window.document;
    const links = [...d.querySelectorAll('a[href="/"]')].filter(el => el.textContent.includes('Back to BeautyDesk'));
    assert.equal(links.length, 2); assert.ok(links[0].classList.contains('auth-back'));
    assert.ok(links[0].compareDocumentPosition(d.querySelector('#auth-form')) & 4);
    assert.ok(d.querySelector('#auth-form').compareDocumentPosition(links[1]) & 4);
  }
});
test('marketing is fully readable without JavaScript and equals shared renderer', () => {
  const dom = new JSDOM(read('marketing.html')), d = dom.window.document;
  const raw = read('marketing.html'), start = raw.indexOf('<div id="app">') + '<div id="app">'.length, end = raw.indexOf('</div><div id="toast"', start);
  assert.equal(raw.slice(start, end), renderPages().home);
  for (const id of ['main', 'features', 'whatsapp-demo', 'how-it-works', 'pricing', 'questions']) assert.ok(d.getElementById(id)?.textContent.trim(), id);
  assert.equal(d.querySelector('.bd-shortcuts').tagName, 'DETAILS');
  assert.equal(d.querySelector('.bd-launcher'), null);
  assert.equal(d.querySelectorAll('script:not([src])').length, 0);
  assert.deepEqual([...d.querySelectorAll('script[src]')].map(el => el.getAttribute('src')), ['/assistant-widget.js', '/ui.js']);
  assert.ok([...d.querySelectorAll('a[href="/signup"]')].length >= 2);
  assert.match(d.querySelector('#pricing').textContent, /R799/);
  assert.match(d.querySelector('#pricing').textContent, /month/i);
  assert.match(d.querySelector('#pricing').textContent, /PayFast.*(?:pending|not.*(?:active|live|enabled|connected))/i);
  assert.doesNotMatch(d.querySelector('#pricing').textContent, /Pricing to be confirmed|unlimited/i);
  assert.match(d.querySelector('#questions').textContent, /Account recovery and email verification are not yet available/);
  assert.match(d.querySelector('#whatsapp-demo').textContent, /Illustrative demo only/);
  dom.window.close();
});
test('production UI includes no preview adapter, fictional salon or fake fetch override', () => {
  const ui = read('ui.js'), shell = read('ui.html') + read('marketing.html');
  assert.doesNotMatch(ui, /DEMO_BASE|demoNavigate|demo-init|demo-adapter|preview-adapter|window\.fetch\s*=|fetch\s*=|\blocalStorage\b/);
  assert.doesNotMatch(shell, /demo-init|preview-adapter|demo-adapter|Try a demo salon|fictional salon/i);
  assert.doesNotMatch(shell, /(?:src|href)="\/demo\//);
});
test('widget is isolated, scripted and local without storage, network or unsafe conversation HTML', () => {
  const js = read('assistant-widget.js'), css = read('assistant-widget.css');
  assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie|<script|<style/);
  assert.match(js, /bubble\.textContent = text/);
  assert.doesNotMatch(css, /@import|url\(/);
  assert.match(js, /Nothing is sent or saved outside this page/);
  assert.match(js, /role="dialog" aria-modal="true"/);
});
