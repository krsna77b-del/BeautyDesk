'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let jsdom; try { jsdom = require('jsdom'); } catch (error) { if (!process.env.BD_JSDOM_PATH) throw error; jsdom = require(process.env.BD_JSDOM_PATH); }
const { JSDOM, VirtualConsole } = jsdom;
const root = path.resolve(process.env.BD_CANDIDATE || path.join(__dirname, fs.existsSync(path.join(__dirname, '../ui.js')) ? '..' : '../beautydesk-reconstructed-candidate'));
const expected = path.resolve(process.env.BD_EXPECTED || path.join(__dirname, 'fixtures/approved'));
const baseline = path.resolve(process.env.BD_BASELINE || path.join(__dirname, 'fixtures/production'));
const read = (file, dir = root) => fs.readFileSync(path.join(dir, file), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function renderPages(dir = root) {
  const source = read('ui.js', dir);
  const start = source.indexOf('const $ ='), end = source.indexOf('const navItems=');
  if (start < 0 || end < start) throw new Error('Could not locate marketing/auth source boundaries');
  const context = { document: { title: '' }, location: { search: '' }, URLSearchParams };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.pages={home:marketing(),login:authPage(),signup:authPage(true)};', context, { timeout: 1000 });
  return context.pages;
}
function domHarness({ pathname = '/', width = 390, height = 844, fetcher, dir = root, includeCSS = false } = {}) {
  const errors = [], requests = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(read(pathname === '/' ? 'marketing.html' : 'ui.html', dir), {
    url: 'http://127.0.0.1:32101' + pathname, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc
  });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, 'innerWidth', { value: width, writable: true });
  Object.defineProperty(w, 'innerHeight', { value: height, writable: true });
  w.scrollTo = value => { w.lastScroll = value; };
  w.HTMLElement.prototype.scrollIntoView = function () { w.lastScrolledElement = this; };
  // JSDOM has no layout: this allows focus-loop behavior tests only, never geometry claims.
  w.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden],[inert]') || (this.closest('.bd-quick-replies') && this.closest('[data-bd-compact="true"]')) ? [] : [{ width: 44, height: 44 }];
  };
  const media = new w.EventTarget(); media.matches = width <= 600; w.matchMedia = () => media;
  const viewport = new w.EventTarget(); viewport.height = height; viewport.offsetTop = 0; w.visualViewport = viewport;
  let handler = fetcher || (async () => response({ error: 'unauthorized' }, 401));
  w.fetch = async (url, options = {}) => {
    const resolved = new URL(url, w.location.origin);
    if (resolved.origin !== w.location.origin) throw new Error('Unexpected nonlocal test request: ' + resolved.origin);
    const request = { path: resolved.pathname, search: resolved.search, method: options.method || 'GET', options };
    requests.push(request);
    return handler(url, options, request);
  };
  if (includeCSS) { const style = d.createElement('style'); style.textContent = read('assistant-widget.css', dir); d.head.append(style); }
  for (const script of d.querySelectorAll('script[src]')) {
    const asset = script.getAttribute('src').replace(/^\//, '');
    if (!['assistant-widget.js', 'ui.js'].includes(asset)) throw new Error('Unexpected script included in candidate: ' + asset);
    w.eval(read(asset, dir));
  }
  const q = selector => d.querySelector(selector);
  const submit = form => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const press = (key, shiftKey = false) => d.dispatchEvent(new w.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  return { dom, w, d, q, requests, errors, media, viewport, submit, press, setFetcher: value => { handler = value; }, close: () => dom.window.close() };
}
module.exports = { fs, path, vm, JSDOM, root, expected, baseline, read, pause, response, renderPages, domHarness };
