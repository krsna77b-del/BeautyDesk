/* BeautyDesk scripted assistant. Load as a same-origin external script with assistant-widget.css.
 * No automatic mount: the app mounts only on the marketing homepage and destroys on navigation.
 * The stable API survives destroy so returning to the homepage can mount a fresh conversation.
 * No network calls, persistent storage, real support messages, authentication or bookings.
 */
(function () {
  'use strict';
  if (window.BeautyDeskAssistantWidget) return;
  var instance = null;
  var markup = '<button class="bd-launcher" type="button" aria-label="Open BeautyDesk demo assistant" aria-controls="bd-assistant-chat-panel" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-5 3 1.5-5.5A7.5 7.5 0 0 1 3 12V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M7 8h9M7 12h6"/></svg><span>Hi, how can we help?</span></button>\n<section class="bd-panel" id="bd-assistant-chat-panel" role="dialog" aria-modal="true" aria-labelledby="bd-assistant-chat-title" aria-describedby="bd-assistant-chat-notice" hidden>\n<header class="bd-header"><span class="bd-avatar" aria-hidden="true">B</span><div class="bd-heading"><h2 class="bd-title" id="bd-assistant-chat-title">BeautyDesk Assistant</h2><p class="bd-status"><span class="bd-status-dot" aria-hidden="true"></span>Demo • instant sample replies</p></div><button class="bd-close" type="button" aria-label="Close BeautyDesk demo assistant">×</button></header>\n<div class="bd-body" role="log" aria-label="Demo conversation" aria-live="polite" aria-relevant="additions" tabindex="0"><p class="bd-message bd-message-system">Demo: I’m the BeautyDesk assistant. These are sample replies, not a live support chat. What would you like to know?</p></div>\n<div class="bd-quick-replies" role="group" aria-label="Suggested questions"><button type="button">Pricing</button><button type="button">How it works</button><button type="button">Book a demo</button><button type="button">Does it use WhatsApp?</button></div>\n<form class="bd-composer"><label class="bd-sr-only" for="bd-assistant-chat-input">Message the demo assistant</label><div class="bd-input-row"><input class="bd-input" id="bd-assistant-chat-input" type="text" placeholder="Type your question…" maxlength="1000" autocomplete="off" autocapitalize="sentences" enterkeyhint="send"><button class="bd-send" type="submit" aria-label="Send demo message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 19 9-19 9 4-9zM7 12h15"/></svg></button></div><p class="bd-disclaimer" id="bd-assistant-chat-notice">Scripted demo. Don’t enter personal or sensitive details.<br>Nothing is sent or saved outside this page.</p><span class="bd-sr-only bd-queue-status" role="status" aria-live="polite"></span></form>\n</section>';

  function createInstance() {
    var root = document.createElement('div');
    root.id = 'bd-assistant-widget';
    root.setAttribute('data-bd-assistant-widget', '');
    // The template is constant. Conversation text is always assigned with textContent.
    root.innerHTML = markup;
    document.body.appendChild(root);
    var launcher = root.querySelector('.bd-launcher');
    var panel = root.querySelector('.bd-panel');
    var closer = root.querySelector('.bd-close');
    var log = root.querySelector('.bd-body');
    var input = root.querySelector('.bd-input');
    var form = root.querySelector('.bd-composer');
    var queueStatus = root.querySelector('.bd-queue-status');
    var media = window.matchMedia('(max-width: 600px)');
    var viewport = window.visualViewport;
    var opened = false, destroyed = false, replyTimer = null, frame = null;
    var queue = [], cleanup = [], inertNodes = [], previousFocus = null, scrollLock = null;
    var replies = {
      pricing: 'Pricing has not been decided. This demo does not offer checkout or take payments.',
      how: 'BeautyDesk has a salon workspace for services, staff, hours, customers and appointments. You need a real account through Get started or Create your workspace, or you can log in to an existing account. WhatsApp needs provider setup and verification before customer use. Automated reminders and online payments are not live; photo estimates are off.',
      demo: 'This is a scripted chat demonstration. To use the workspace, sign up through Get started or Create your workspace, or log in with your existing account. This widget cannot create an account, arrange a walkthrough or make a booking, and it does not send your details to the team.',
      whatsapp: 'BeautyDesk supports a separately configured WhatsApp booking reply flow. Each salon needs provider setup, verification and end-to-end testing before inviting customers. Automated reminders are not live, and this chat does not send WhatsApp messages.',
      account: 'A real account is required to use the workspace. Choose Get started or Create your workspace to sign up, or Log in if you already have an account. This scripted chat cannot sign you in or create an account.',
      payments: 'Online payments, deposit collection and recurring subscription billing are not live. The workspace can keep manual payment records; recording a payment does not move money or verify a bank transfer.',
      reminders: 'Automated reminders are not live. Message previews in the workspace are unsent; no customer receives a reminder from this demo.',
      photo: 'Photo estimates are off. This chat cannot receive or analyse photos, and photo features require separate provider, privacy and consent setup before use.',
      fallback: 'This is a scripted demo with sample answers about pricing, how BeautyDesk works, demos and WhatsApp. For anything else, contact the BeautyDesk team directly. This widget does not deliver messages to the team.'
    };
    function answerFor(text) {
      var value = text.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
      if (/\b(photos?|pictures?|images?|upload|vision)\b/.test(value)) return replies.photo;
      if (/\b(reminders?|notifications?|notify)\b/.test(value)) return replies.reminders;
      if (/\b(payments?|pay|deposits?|billing|refunds?|checkout)\b/.test(value)) return replies.payments;
      if (/\b(sign ?up|sign ?in|log ?in|account|workspace|register)\b/.test(value)) return replies.account;
      if (/\b(pric(?:e|es|ing)|cost|costs|fee|fees|plan|plans|subscription)\b|\bhow much\b/.test(value)) return replies.pricing;
      if (/\bdemo\b|\bwalkthrough\b/.test(value)) return replies.demo;
      if (/whats\s*app|\bwa\b/.test(value)) return replies.whatsapp;
      if (/\bhow\b|\bwork(?:s|ing)?\b|\bfeatures?\b/.test(value)) return replies.how;
      return replies.fallback;
    }
    function on(target, event, fn, opts) {
      target.addEventListener(event, fn, opts);
      cleanup.push(function () { target.removeEventListener(event, fn, opts); });
    }
    function scrollConversation() { log.scrollTop = log.scrollHeight; }
    function append(text, kind) {
      var bubble = document.createElement('p');
      bubble.className = 'bd-message bd-message-' + kind;
      bubble.textContent = text;
      log.appendChild(bubble);
      scrollConversation();
    }
    function deliverNext() {
      if (destroyed || replyTimer !== null || !queue.length) return;
      queueStatus.textContent = 'Preparing a sample reply.';
      replyTimer = window.setTimeout(function () {
        replyTimer = null;
        if (destroyed) return;
        append(queue.shift(), 'system');
        queueStatus.textContent = queue.length ? 'Preparing the next sample reply.' : '';
        deliverNext();
      }, 550);
    }
    function submit(text) {
      var message = String(text || '').trim().slice(0, 1000);
      if (!message || destroyed) return;
      append(message, 'customer');
      queue.push(answerFor(message));
      deliverNext();
    }
    function viewportSize() {
      if (!opened) return;
      var height = Math.max(0, viewport ? viewport.height : window.innerHeight);
      var top = Math.max(0, viewport ? viewport.offsetTop : 0);
      // Landscape windows and an on-screen keyboard can be short at any width.
      // Keep the card above the visible viewport's bottom, not behind the keyboard.
      var shortDesktop = !media.matches && height < 600;
      var bottomGap = shortDesktop ? 12 : 94;
      var available = media.matches ? height : Math.max(0, height - bottomGap - (shortDesktop ? 12 : 24));
      var compact = media.matches ? height < 430 : available < 500;
      panel.setAttribute('data-bd-compact', compact ? 'true' : 'false');
      root.setAttribute('data-bd-short', shortDesktop ? 'true' : 'false');
      if (media.matches) {
        panel.style.height = height + 'px';
        panel.style.top = top + 'px';
        panel.style.bottom = 'auto';
        panel.style.removeProperty('max-height');
      } else {
        panel.style.removeProperty('height');
        panel.style.removeProperty('top');
        panel.style.bottom = Math.max(0, window.innerHeight - top - height) + bottomGap + 'px';
        panel.style.setProperty('max-height', available + 'px');
      }
      scrollConversation();
    }
    function scheduleViewport() {
      if (!opened || destroyed) return;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(function () { frame = null; viewportSize(); });
    }
    function lockPage() {
      var body = document.body, html = document.documentElement;
      var props = ['overflow', 'position', 'top', 'left', 'width'];
      scrollLock = { x: window.scrollX, y: window.scrollY, body: {}, htmlOverflow: html.style.getPropertyValue('overflow'), htmlPriority: html.style.getPropertyPriority('overflow') };
      props.forEach(function (key) { scrollLock.body[key] = [body.style.getPropertyValue(key), body.style.getPropertyPriority(key)]; });
      body.style.setProperty('overflow', 'hidden');
      body.style.setProperty('position', 'fixed');
      body.style.setProperty('top', -scrollLock.y + 'px');
      body.style.setProperty('left', -scrollLock.x + 'px');
      body.style.setProperty('width', '100%');
      html.style.setProperty('overflow', 'hidden');
      Array.prototype.forEach.call(body.children, function (node) {
        if (node === root || /^(SCRIPT|STYLE|LINK)$/.test(node.tagName)) return;
        inertNodes.push({ node: node, attribute: node.getAttribute('inert') });
        node.setAttribute('inert', '');
      });
    }
    function unlockPage() {
      inertNodes.forEach(function (item) { if (item.attribute === null) item.node.removeAttribute('inert'); else item.node.setAttribute('inert', item.attribute); });
      inertNodes = [];
      if (!scrollLock) return;
      var saved = scrollLock; scrollLock = null;
      Object.keys(saved.body).forEach(function (key) { var value = saved.body[key]; if (value[0]) document.body.style.setProperty(key, value[0], value[1]); else document.body.style.removeProperty(key); });
      if (saved.htmlOverflow) document.documentElement.style.setProperty('overflow', saved.htmlOverflow, saved.htmlPriority); else document.documentElement.style.removeProperty('overflow');
      window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
    }
    function open() {
      if (opened || destroyed) return;
      opened = true; previousFocus = document.activeElement;
      panel.hidden = false; launcher.setAttribute('aria-expanded', 'true');
      lockPage(); viewportSize();
      (media.matches ? closer : input).focus({ preventScroll: true });
    }
    function close(restoreFocus) {
      if (!opened) return;
      opened = false; panel.hidden = true; launcher.setAttribute('aria-expanded', 'false');
      unlockPage();
      if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; }
      ['height', 'top', 'bottom', 'max-height'].forEach(function (key) { panel.style.removeProperty(key); });
      panel.removeAttribute('data-bd-compact');
      root.removeAttribute('data-bd-short');
      if (restoreFocus === false) return;
      var target = previousFocus && previousFocus.isConnected && previousFocus !== document.body ? previousFocus : launcher;
      target.focus({ preventScroll: true });
    }
    function keydown(event) {
      if (!opened) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      event.stopImmediatePropagation();
      var focusable = Array.prototype.filter.call(panel.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex="0"]'), function (el) { return !el.hidden && !el.closest('[inert]') && el.getClientRects().length > 0; });
      if (!focusable.length) { event.preventDefault(); return; }
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (focusable.indexOf(document.activeElement) === -1) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    on(launcher, 'click', function () { opened ? close() : open(); });
    on(closer, 'click', function () { close(); });
    on(form, 'submit', function (event) { event.preventDefault(); event.stopPropagation(); var text = input.value; input.value = ''; submit(text); });
    on(root.querySelector('.bd-quick-replies'), 'click', function (event) { var button = event.target.closest('button'); if (button) submit(button.textContent); });
    on(document, 'keydown', keydown, true);
    on(window, 'resize', scheduleViewport);
    if (viewport) { on(viewport, 'resize', scheduleViewport); on(viewport, 'scroll', scheduleViewport); }
    if (media.addEventListener) on(media, 'change', scheduleViewport);
    else { media.addListener(scheduleViewport); cleanup.push(function () { media.removeListener(scheduleViewport); }); }
    function destroy() {
      if (destroyed) return;
      close(false); destroyed = true;
      if (replyTimer !== null) window.clearTimeout(replyTimer);
      if (frame !== null) window.cancelAnimationFrame(frame);
      queue = []; cleanup.forEach(function (fn) { fn(); }); cleanup = [];
      root.remove();
    }

    return { root: root, open: open, close: close, destroy: destroy };
  }

  function mount() {
    if (instance && instance.root.isConnected) return api;
    if (instance) { instance.destroy(); instance = null; }
    if (document.body) instance = createInstance();
    return api;
  }
  var api = {
    mount: mount,
    open: function () { if (instance) instance.open(); },
    close: function () { if (instance) instance.close(); },
    destroy: function () {
      if (!instance) return;
      var current = instance;
      instance = null;
      current.destroy();
    }
  };
  window.BeautyDeskAssistantWidget = api;
})();
