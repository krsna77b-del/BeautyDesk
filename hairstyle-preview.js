/* BeautyDesk private hairstyle preview. No credentials, persistent images, or automatic generation retries. */
(() => {
  'use strict';
  const API = '/api/client/hairstyle-preview';
  const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
  const POLL_MS = 1800;
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries([
    'availability', 'availability-title', 'availability-message', 'signin-link', 'refresh-status',
    'preview-form', 'photo-file', 'upload-empty', 'photo-selected', 'original-image', 'photo-name',
    'remove-photo', 'photo-error', 'preferences', 'keep-length', 'easy-maintenance', 'adult-consent',
    'google-consent', 'provider-disclosure', 'privacy-links', 'notice-version', 'action-error',
    'generate-button', 'generate-label', 'generate-help', 'budget-message', 'results-title',
    'results-count', 'results-description', 'progress-panel', 'progress-spinner', 'progress-label',
    'generation-progress', 'progress-detail', 'check-results', 'cancel-generation', 'preview-grid',
    'empty-explanation', 'results-actions', 'clear-results', 'result-disclaimer'
  ].map(id => [id, $(id)]));
  const emptyCards = Array.from(ui['preview-grid'].children).map(node => node.cloneNode(true));
  const initialDisclaimer = ui['result-disclaimer'].textContent;
  let status = null;
  let source = null;
  let active = null;
  let epoch = 0;
  let statusSequence = 0;
  let pollTimer = null;
  let pollInFlight = false;
  let disposed = false;
  let phase = 'idle';
  let renderedSignature = '';
  const controllers = new Set();

  const safeText = (value, limit = 6000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const preferences = () => ({ keepLength: ui['keep-length'].checked, easyMaintenance: ui['easy-maintenance'].checked });
  const remainingSets = () => Number.isInteger(status?.budget?.remainingSets) && status.budget.remainingSets >= 0 ? status.budget.remainingSets : null;
  const noticeReady = () => typeof status?.noticeVersion === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(status.noticeVersion) && typeof status?.disclosure === 'string' && status.disclosure.length > 0;
  const ready = () => status?.ready === true && status?.enabled === true && status?.provider === 'Google' && noticeReady() && remainingSets() !== null;
  const isCurrent = request => !disposed && active === request && request.epoch === epoch;
  const canGenerate = () => !disposed && !active && phase !== 'reading' && ready() && remainingSets() > 0 && source?.imageReady === true && !!source?.digest && ui['adult-consent'].checked && ui['google-consent'].checked;

  function showError(id, message) {
    ui[id].textContent = message || '';
    ui[id].hidden = !message;
  }
  function resetConsent() {
    ui['adult-consent'].checked = false;
    ui['google-consent'].checked = false;
  }
  function stopPolling() {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  function restoreEmptyCards() {
    ui['preview-grid'].replaceChildren(...emptyCards.map(node => node.cloneNode(true)));
    renderedSignature = '';
    ui['empty-explanation'].hidden = false;
    ui['results-count'].textContent = '3 looks, chosen for you';
    ui['results-title'].textContent = 'Meet your possibilities';
    ui['results-description'].textContent = 'Your three suggested looks will appear here. No need to choose a hairstyle first.';
    ui['results-actions'].hidden = true;
    ui['result-disclaimer'].textContent = safeText(status?.disclaimer) || initialDisclaimer;
  }
  function clearLocalPhoto({ clearPreferences = false } = {}) {
    source = null;
    ui['original-image'].removeAttribute('src');
    ui['photo-file'].value = '';
    ui['photo-name'].textContent = '';
    ui['photo-selected'].hidden = true;
    ui['upload-empty'].hidden = false;
    if (clearPreferences) {
      ui['keep-length'].checked = false;
      ui['easy-maintenance'].checked = false;
    }
    resetConsent();
    restoreEmptyCards();
  }
  function clearAll() {
    if (active) return;
    epoch += 1;
    phase = 'idle';
    clearLocalPhoto({ clearPreferences: true });
    ui['progress-panel'].hidden = true;
    showError('photo-error', '');
    showError('action-error', '');
    updateControls();
    ui['photo-file'].focus();
  }
  function updateControls() {
    const locked = !!active;
    ui['photo-file'].disabled = locked;
    ui['remove-photo'].disabled = locked;
    ui.preferences.disabled = locked;
    ui['adult-consent'].disabled = locked || !noticeReady();
    ui['google-consent'].disabled = locked || !noticeReady();
    document.querySelector('.studio-layout').classList.toggle('busy', locked);
    ui['generate-button'].disabled = !canGenerate();
    ui['generate-label'].textContent = active ? (phase === 'consenting' ? 'Preparing your set…' : 'Creating your 3 looks…') : (phase === 'completed' ? 'Suggest 3 new styles' : 'Suggest 3 styles');
    if (active) ui['generate-help'].textContent = 'One set is in progress. A second set won’t start automatically.';
    else if (phase === 'reading') ui['generate-help'].textContent = 'Checking your photo on this device…';
    else if (!source) ui['generate-help'].textContent = 'Choose a photo to get started.';
    else if (!source.imageReady) ui['generate-help'].textContent = 'Checking that your photo can be displayed…';
    else if (!ready()) ui['generate-help'].textContent = 'Your photo is ready on this device. Preview setup must be complete before it can be sent.';
    else if (remainingSets() === 0) ui['generate-help'].textContent = 'This pilot’s set allowance has been used. No new set can be started.';
    else if (!ui['adult-consent'].checked || !ui['google-consent'].checked) ui['generate-help'].textContent = 'Read the notice and confirm both choices above to continue.';
    else ui['generate-help'].textContent = phase === 'completed' ? 'A new set uses another allowance. It starts only when you choose this button.' : 'This sends your photo to Google and uses one three-style set.';
    const left = remainingSets();
    const total = Number.isInteger(status?.budget?.maxSets) && status.budget.maxSets > 0 ? status.budget.maxSets : null;
    ui['budget-message'].textContent = left === null ? '' : `${left} ${left === 1 ? 'set' : 'sets'} remaining${total ? ` of ${total}` : ''} in this private pilot. Each set contains 3 previews.`;
  }

  const setupMessages = {
    preview_disabled: 'Google photo previews haven’t been enabled for this pilot yet. You can choose a photo locally, but it won’t be sent.',
    preview_model_required: 'The Google image model still needs to be configured and verified. No photo can be sent yet.',
    preview_notice_required: 'The photo-processing notice still needs to be configured. No photo can be sent yet.',
    preview_pilot_required: 'The private pilot account still needs to be configured. No photo can be sent yet.',
    preview_provider_key_required: 'The private Google API connection still needs to be set up. No photo can be sent yet.',
    preview_not_in_pilot: 'This account isn’t enabled for the private hairstyle preview pilot. No photo can be sent.',
    preview_budget_exhausted: 'This pilot’s set allowance has been used. No new set can be started.',
    preview_unavailable: 'Google previews are unavailable right now. Your selected photo stays on this device.',
    provider_not_verified: 'The Google connection still needs to be verified. No photo can be sent yet.',
    budget_exhausted: 'This pilot’s set allowance has been used. No new set can be started.'
  };
  function showAvailability(title, message, kind = '') {
    ui.availability.className = `availability${kind ? ` ${kind}` : ''}`;
    ui['availability-title'].textContent = title;
    ui['availability-message'].textContent = message;
  }
  function showSignedOut() {
    stopPolling();
    epoch += 1;
    active = null;
    status = null;
    phase = 'idle';
    clearLocalPhoto();
    ui['progress-panel'].hidden = true;
    ui['provider-disclosure'].textContent = 'Sign in to view the current privacy notice. No new photo can be sent.';
    ui['notice-version'].textContent = '';
    ui['privacy-links'].replaceChildren();
    showAvailability('Please sign in again', 'Your session has ended. Photos have been cleared from this page. Any request already sent to Google may still finish.', 'error');
    ui['signin-link'].hidden = false;
    ui['refresh-status'].hidden = false;
    updateControls();
  }
  function renderPrivacy(data) {
    ui['provider-disclosure'].textContent = (typeof data.disclosure === 'string' ? data.disclosure : '') || 'The privacy notice is not ready. No photo can be sent.';
    ui['notice-version'].textContent = noticeReady() ? `Notice ${safeText(data.noticeVersion, 80)}` : '';
    ui['privacy-links'].replaceChildren();
    const links = Array.isArray(data.privacyLinks) ? data.privacyLinks : [];
    for (const [index, entry] of links.slice(0, 4).entries()) {
      const value = typeof entry === 'string' ? entry : entry?.url;
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 'ai.google.dev' || url.username || url.password) continue;
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = (typeof entry === 'object' && safeText(entry.label, 100)) || (index === 0 ? 'Google API terms' : 'Google usage policy');
        ui['privacy-links'].append(link);
      } catch { /* Invalid links are never rendered. */ }
    }
    ui['result-disclaimer'].textContent = safeText(data.disclaimer) || initialDisclaimer;
  }
  class ApiError extends Error {
    constructor(code, httpStatus = 0) { super(code); this.code = code; this.httpStatus = httpStatus; }
  }
  async function requestJson(path, { method = 'GET', body, timeout = 20000 } = {}) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${API}${path}`, {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (response.status === 401) throw new ApiError('signed_out', 401);
      let data;
      try { data = await response.json(); } catch { throw new ApiError('invalid_response', response.status); }
      if (!response.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : typeof data?.error?.code === 'string' ? data.error.code : 'request_failed', response.status);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('invalid_response', response.status);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error?.name === 'AbortError' ? 'request_timeout' : 'connection_lost');
    } finally {
      window.clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  async function loadStatus() {
    const sequence = ++statusSequence;
    ui['refresh-status'].disabled = true;
    try {
      const data = await requestJson('/status');
      if (disposed || sequence !== statusSequence) return;
      const noticeChanged = status && (data.noticeVersion !== status.noticeVersion || data.disclosure !== status.disclosure);
      status = data;
      if (noticeChanged) resetConsent();
      ui['signin-link'].hidden = true;
      renderPrivacy(data);
      if (ready() && remainingSets() > 0) showAvailability('Ready when you are', 'Your photo stays on this device until you confirm both choices and choose “Suggest 3 styles”.', 'ready');
      else if (ready() && remainingSets() === 0) showAvailability('Pilot allowance used', setupMessages.budget_exhausted);
      else showAvailability('Preview setup pending', setupMessages[data.reason] || 'The Google connection, privacy notice, or pilot allowance is not ready. No photo can be sent yet.');
      ui['refresh-status'].hidden = ready() && remainingSets() > 0;
    } catch (error) {
      if (disposed || sequence !== statusSequence) return;
      if (error.httpStatus === 401) { showSignedOut(); return; }
      status = null;
      resetConsent();
      showAvailability('Couldn’t check availability', 'The preview service could not be reached. Your photo stays on this device. Try “Check again” when you’re connected.', 'error');
      ui['refresh-status'].hidden = false;
    } finally {
      if (!disposed && sequence === statusSequence) {
        ui['refresh-status'].disabled = false;
        updateControls();
      }
    }
  }

  function readBytes(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(new Error('file_read_failed'));
      reader.onabort = () => reject(new Error('file_read_failed'));
      reader.readAsArrayBuffer(file);
    });
  }
  function detectedType(bytes) {
    if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    return null;
  }
  function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
  async function selectPhoto() {
    if (active || disposed) return;
    const file = ui['photo-file'].files?.[0];
    if (!file) return;
    const token = ++epoch;
    clearLocalPhoto();
    showError('photo-error', '');
    showError('action-error', '');
    ui['progress-panel'].hidden = true;
    phase = 'reading';
    updateControls();
    try {
      if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Choose a JPEG or PNG photo. HEIC, GIF, and other files aren’t supported in this pilot.');
      if (!file.size || file.size > MAX_PHOTO_BYTES) throw new Error('Choose a photo no larger than 3 MiB. If needed, export a smaller JPEG or PNG first.');
      if (!window.crypto?.subtle || !window.crypto?.randomUUID) throw new Error('This browser needs a secure connection to prepare your photo. Open BeautyDesk over HTTPS and try again.');
      const bytes = await readBytes(file);
      if (disposed || token !== epoch) return;
      if (detectedType(bytes) !== file.type) throw new Error('This file doesn’t match its photo format. Choose an original JPEG or PNG photo.');
      const hash = await window.crypto.subtle.digest('SHA-256', bytes);
      if (disposed || token !== epoch) return;
      const digest = Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('');
      const base64 = toBase64(bytes);
      source = { mimeType: file.type, base64, digest, imageReady: false };
      ui['original-image'].src = `data:${source.mimeType};base64,${source.base64}`;
      ui['photo-name'].textContent = safeText(file.name, 200);
      ui['photo-selected'].hidden = false;
      ui['upload-empty'].hidden = true;
      phase = 'idle';
      updateControls();
    } catch (error) {
      if (disposed || token !== epoch) return;
      phase = 'idle';
      clearLocalPhoto();
      showError('photo-error', error.message === 'file_read_failed' ? 'This photo couldn’t be opened. Choose it again or try another JPEG or PNG.' : error.message);
      updateControls();
    }
  }
  ui['original-image'].addEventListener('load', () => {
    if (!source || disposed || ui['original-image'].getAttribute('src') !== `data:${source.mimeType};base64,${source.base64}`) return;
    source.imageReady = true;
    updateControls();
  });
  ui['original-image'].addEventListener('error', () => {
    if (!source || active || disposed) return;
    epoch += 1;
    clearLocalPhoto();
    phase = 'idle';
    showError('photo-error', 'Your browser couldn’t display this photo. Try a different JPEG or PNG. Nothing has been sent.');
    updateControls();
  });

  function setProgress(label, detail, { completed = 0, uncertain = false } = {}) {
    ui['progress-panel'].hidden = false;
    ui['progress-label'].textContent = label;
    ui['progress-detail'].textContent = detail;
    ui['generation-progress'].value = Math.max(0, Math.min(3, completed));
    ui['progress-spinner'].hidden = uncertain;
    ui['check-results'].hidden = !uncertain;
    ui['cancel-generation'].disabled = phase === 'stopping';
    ui['cancel-generation'].textContent = phase === 'stopping' ? 'Stopping…' : 'Stop and clear';
  }
  function validImage(image) {
    return image && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) && typeof image.data === 'string' && image.data.length > 0 && image.data.length <= 6 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) && image.data.length % 4 === 0;
  }
  function textNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }
  function renderResults(data) {
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(0, 3) : [];
    const previews = Array.isArray(data.previews) ? data.previews.slice(0, 3) : [];
    const seen = new Set();
    const records = [...suggestions, ...previews].filter(item => {
      if (!item || typeof item.styleId !== 'string' || !item.styleId || item.styleId.length > 100 || seen.has(item.styleId)) return false;
      seen.add(item.styleId);
      return true;
    }).slice(0, 3);
    if (!records.length) return 0;
    const signature = `${data.state}|` + records.map(item => `${safeText(item.styleId, 100)}:${safeText(item.label, 200)}:${previews.some(preview => preview && preview.styleId === item.styleId && validImage(preview.image))}`).join('|');
    const completeCount = records.filter(item => previews.some(preview => preview && preview.styleId === item.styleId && validImage(preview.image))).length;
    if (signature === renderedSignature) return completeCount;
    renderedSignature = signature;
    ui['preview-grid'].replaceChildren();
    ui['empty-explanation'].hidden = true;
    ui['results-description'].textContent = 'Three ideas from your photo. Compare each preview with your original, then discuss your favourites with your stylist.';
    ui['results-count'].textContent = `${completeCount} of 3 previews ready`;
    const originalUrl = source ? `data:${source.mimeType};base64,${source.base64}` : null;
    for (const [index, suggestion] of records.entries()) {
      const label = safeText(suggestion.label, 200) || `Hairstyle idea ${index + 1}`;
      const preview = previews.find(item => item && item.styleId === suggestion.styleId && validImage(item.image));
      const card = document.createElement('article');
      card.className = 'idea-card generated-card';
      const caption = document.createElement('div');
      caption.className = 'idea-caption';
      caption.append(textNode('span', 'eyebrow', `LOOK 0${index + 1}`), textNode('h3', '', label));
      if (preview) {
        const generatedUrl = `data:${preview.image.mimeType};base64,${preview.image.data}`;
        const frame = document.createElement('div');
        frame.className = 'generated-frame';
        const image = document.createElement('img');
        image.src = generatedUrl;
        image.alt = `AI-generated ${label} preview; compare with your original photo`;
        const badge = textNode('span', 'image-badge', 'AI preview');
        frame.append(image, badge);
        card.append(frame);
        caption.append(textNode('p', '', 'AI-generated preview • result may differ; check your face and details.'));
        if (originalUrl) {
          const controls = document.createElement('div');
          controls.className = 'compare-controls';
          controls.setAttribute('role', 'group');
          controls.setAttribute('aria-label', `Compare ${label}`);
          const originalButton = textNode('button', '', 'Original');
          const previewButton = textNode('button', '', 'Preview');
          for (const button of [originalButton, previewButton]) button.type = 'button';
          originalButton.setAttribute('aria-pressed', 'false');
          previewButton.setAttribute('aria-pressed', 'true');
          originalButton.addEventListener('click', () => {
            image.src = originalUrl;
            image.alt = 'Your original photo, unchanged';
            badge.textContent = 'Your original';
            originalButton.setAttribute('aria-pressed', 'true');
            previewButton.setAttribute('aria-pressed', 'false');
          });
          previewButton.addEventListener('click', () => {
            image.src = generatedUrl;
            image.alt = `AI-generated ${label} preview; compare with your original photo`;
            badge.textContent = 'AI preview';
            originalButton.setAttribute('aria-pressed', 'false');
            previewButton.setAttribute('aria-pressed', 'true');
          });
          controls.append(originalButton, previewButton);
          const reference = document.createElement('div');
          reference.className = 'original-reference';
          const thumbnail = document.createElement('img');
          thumbnail.src = originalUrl;
          thumbnail.alt = 'Your original photo';
          reference.append(thumbnail, textNode('span', '', 'Your photo · tap Original to compare'));
          caption.append(controls, reference);
        }
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'pending-style';
        placeholder.append(textNode('span', 'idea-number-static', `0${index + 1}`), textNode('span', '', data.state === 'running' ? 'Your preview is on its way' : 'No preview returned'));
        card.append(placeholder);
        caption.append(textNode('p', '', 'Suggested style only. A generated preview is not available yet.'));
      }
      card.append(caption);
      ui['preview-grid'].append(card);
    }
    return completeCount;
  }
  function schedulePoll(request) {
    stopPolling();
    if (!isCurrent(request) || document.hidden || phase !== 'running') return;
    pollTimer = window.setTimeout(() => pollResult(request), POLL_MS);
  }
  function makeUncertain(request, detail) {
    if (!isCurrent(request)) return;
    stopPolling();
    phase = 'uncertain';
    setProgress('We couldn’t confirm the result', detail || 'The request may already have reached Google. We won’t submit it again. Check for results, or stop and clear this set.', { uncertain: true, completed: request.completed || 0 });
    updateControls();
  }
  const resultFailureMessages = {
    preview_provider_access: 'Google did not accept this request. API access and paid billing need checking before another set.',
    preview_provider_limit: 'Google reported a usage or billing limit.',
    preview_timeout: 'Google did not finish in time. A call already sent may have been charged.',
    preview_interrupted: 'This request was interrupted. A call already sent may have been charged.',
    suggestions_invalid: 'Three safe hairstyle ideas could not be selected from this photo. No image edits were started.',
    invalid_provider_response: 'Google’s response could not be safely used.'
  };
  async function finish(request, data) {
    if (!isCurrent(request)) return;
    stopPolling();
    const count = renderResults(data);
    active = null;
    phase = data.state;
    resetConsent();
    ui['progress-panel'].hidden = true;
    ui['results-actions'].hidden = false;
    ui['result-disclaimer'].textContent = safeText(data.disclaimer) || safeText(status?.disclaimer) || initialDisclaimer;
    if (data.state === 'completed' && count === 3) {
      showError('action-error', '');
      ui['results-title'].textContent = 'Your three possibilities';
      ui['results-count'].textContent = 'Your 3 previews are ready';
      ui['results-title'].focus({ preventScroll: true });
      ui['results-title'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (data.state === 'cancelled') {
      clearLocalPhoto();
      showError('action-error', 'This set was stopped and photos were cleared from this page. Information already sent to Google cannot be recalled; any set allowance already reserved is not refunded.');
    } else {
      phase = 'failed';
      const failureDetail = resultFailureMessages[data.error] ? `${resultFailureMessages[data.error]} ` : '';
      showError('action-error', failureDetail + (data.state === 'expired' ? 'These preview images have expired from server memory. No new set has been started. A new set needs fresh permission and remaining allowance.' : count ? `Only ${count} of 3 previews were returned. This set stopped without retrying. An allowance may already have been used.` : 'This set couldn’t be completed. It has stopped, and no new set will start automatically. An allowance may already have been used.'));
    }
    // Block a new set until the authoritative remaining allowance has been refreshed.
    if (status?.budget) status = { ...status, budget: { ...status.budget, remainingSets: null } };
    updateControls();
    await loadStatus();
  }
  async function applyResult(request, data) {
    if (!isCurrent(request)) return;
    if (data.requestId && data.requestId !== request.id) { makeUncertain(request); return; }
    if (request.cancelRequested) { await cancelRequest(request); return; }
    if (['completed', 'failed', 'unknown', 'expired', 'cancelled'].includes(data.state)) { await finish(request, data); return; }
    if (data.state !== 'running') { makeUncertain(request); return; }
    phase = 'running';
    const count = renderResults(data);
    const reported = Number.isInteger(data.progress?.completed) ? Math.max(0, Math.min(3, data.progress.completed)) : count;
    request.completed = Math.max(count, reported);
    const hasIdeas = Array.isArray(data.suggestions) && data.suggestions.length > 0;
    setProgress(hasIdeas || request.completed ? `Creating previews ${Math.min(request.completed + 1, 3)} of 3` : 'Finding ideas', hasIdeas ? 'Your three styles are chosen. Your photo is being used to create a preview of each.' : 'Google is suggesting three styles from your photo. Keep this page open.', { completed: request.completed });
    updateControls();
    schedulePoll(request);
  }
  async function pollResult(request) {
    if (!isCurrent(request) || pollInFlight || phase === 'stopping') return;
    stopPolling();
    pollInFlight = true;
    ui['check-results'].disabled = true;
    try {
      const data = await requestJson(`/result/${encodeURIComponent(request.id)}`);
      if (isCurrent(request)) await applyResult(request, data);
    } catch (error) {
      if (!isCurrent(request)) return;
      if (error.httpStatus === 401) { showSignedOut(); return; }
      makeUncertain(request);
    } finally {
      pollInFlight = false;
      ui['check-results'].disabled = false;
    }
  }
  async function cancelRequest(request) {
    if (!isCurrent(request) || request.cancelling) return;
    request.cancelRequested = true;
    stopPolling();
    phase = 'stopping';
    setProgress('Stopping this set', 'We’re asking the server to stop remaining previews. Information already sent to Google cannot be recalled; reserved allowance is not refunded.', { completed: request.completed || 0 });
    updateControls();
    if (request.submitting) return; // Wait for the single generation POST to settle before cancelling it.
    if (!request.submitted) {
      active = null;
      epoch += 1;
      phase = 'cancelled';
      clearLocalPhoto();
      ui['progress-panel'].hidden = true;
      showError('action-error', 'Stopped before your photo was sent. Photos have been cleared from this page.');
      updateControls();
      return;
    }
    request.cancelling = true;
    try {
      const data = await requestJson(`/cancel/${encodeURIComponent(request.id)}`, { method: 'POST', body: {} });
      if (!isCurrent(request)) return;
      if (data.requestId && data.requestId !== request.id) { makeUncertain(request); return; }
      if (data.state !== 'cancelled' && data.cancelled !== true) {
        makeUncertain(request, 'The server has not confirmed cancellation. No new set will start. Use “Stop and clear” to ask again, or check for results.');
        return;
      }
      active = null;
      epoch += 1;
      phase = 'cancelled';
      clearLocalPhoto();
      ui['progress-panel'].hidden = true;
      showError('action-error', 'This set was stopped and photos were cleared from this page. Information already sent to Google cannot be recalled; any set allowance already reserved is not refunded.');
      if (status?.budget) status = { ...status, budget: { ...status.budget, remainingSets: null } };
      updateControls();
      await loadStatus();
    } catch (error) {
      if (!isCurrent(request)) return;
      if (error.httpStatus === 401) { showSignedOut(); return; }
      makeUncertain(request, 'We couldn’t confirm cancellation. The request may still finish. No new set will start; you can check for results or try “Stop and clear” again.');
    } finally {
      request.cancelling = false;
    }
  }
  const friendlyErrors = {
    consent_invalid: 'Fresh photo permission is required. Review the notice and confirm both choices again.',
    consent_changed: 'The photo, preferences, or processing notice changed. Please review the current notice and confirm both choices again.',
    preview_busy: 'Another preview set is already being created. No second set was started. Wait until that set has finished before trying again.',
    consent_expired: 'Your photo permission expired before it could be used. Review the notice and confirm both choices again.',
    consent_required: 'Fresh photo permission is required. Review the notice and confirm both choices again.',
    consent_mismatch: 'Your photo or choices no longer match the permission. Review the notice and confirm both choices again.',
    notice_version_mismatch: 'The privacy notice has changed. Read the updated notice and confirm both choices again.',
    invalid_notice_version: 'The privacy notice has changed. Read the updated notice and confirm both choices again.',
    preview_budget_exhausted: 'This pilot’s set allowance has been used. No new set was started.',
    budget_exhausted: 'This pilot’s set allowance has been used. No new set was started.',
    preview_disabled: 'Google previews are not enabled. No new set was started.',
    preview_not_in_pilot: 'This account isn’t enabled for the private preview pilot. No new set was started.',
    image_too_large: 'This photo is too large for the preview service. Choose a smaller JPEG or PNG.',
    invalid_image: 'The preview service couldn’t use this photo. Choose a different JPEG or PNG.'
  };
  async function generate(event) {
    event.preventDefault();
    if (!canGenerate()) return;
    const request = { id: window.crypto.randomUUID(), epoch, submitted: false, submitting: false, cancelRequested: false, completed: 0 };
    const chosen = source;
    const choices = preferences();
    const noticeVersion = status.noticeVersion;
    active = request;
    phase = 'consenting';
    showError('action-error', '');
    restoreEmptyCards();
    setProgress('Preparing your set', 'Recording your photo permission. Your image has not been sent yet.');
    updateControls();
    try {
      const consent = await requestJson('/consent', { method: 'POST', body: { adult: true, ownsPhoto: true, googleProcessing: true, noticeVersion, imageDigest: chosen.digest, preferences: choices } });
      if (!isCurrent(request)) return;
      if (request.cancelRequested) { await cancelRequest(request); return; }
      if (typeof consent.consentId !== 'string' || !consent.consentId) throw new ApiError('invalid_consent');
      request.submitted = true;
      request.submitting = true;
      phase = 'running';
      setProgress('Finding ideas', 'Your photo is being sent to Google to suggest three hairstyles. Keep this page open.');
      updateControls();
      let result;
      try {
        result = await requestJson('/generate', { method: 'POST', timeout: 30000, body: { requestId: request.id, consentId: consent.consentId, preferences: choices, image: { mimeType: chosen.mimeType, data: chosen.base64 } } });
      } finally { request.submitting = false; }
      if (!isCurrent(request)) return;
      await applyResult(request, result);
    } catch (error) {
      if (!isCurrent(request)) return;
      request.submitting = false;
      if (error.httpStatus === 401) { showSignedOut(); return; }
      if (request.cancelRequested) { await cancelRequest(request); return; }
      if (request.submitted && error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 429].includes(error.httpStatus) && error.code !== 'request_conflict') {
        active = null;
        phase = 'failed';
        resetConsent();
        ui['progress-panel'].hidden = true;
        showError('action-error', friendlyErrors[error.code] || 'The server declined this set before starting it. No new set will start automatically. Check the notice and remaining allowance before trying again.');
        if (status?.budget) status = { ...status, budget: { ...status.budget, remainingSets: null } };
        updateControls();
        await loadStatus();
        return;
      }
      if (request.submitted) {
        // A lost response does not prove the paid request failed. Recover by GET only.
        makeUncertain(request);
        await pollResult(request);
        return;
      }
      active = null;
      phase = 'failed';
      resetConsent();
      ui['progress-panel'].hidden = true;
      showError('action-error', friendlyErrors[error.code] || 'Your permission could not be recorded, so your photo was not sent. Check your connection, review the notice, and try again.');
      updateControls();
      await loadStatus();
    }
  }

  ui['photo-file'].addEventListener('change', selectPhoto);
  ui['remove-photo'].addEventListener('click', clearAll);
  ui['clear-results'].addEventListener('click', clearAll);
  ui['refresh-status'].addEventListener('click', loadStatus);
  ui['preview-form'].addEventListener('submit', generate);
  for (const id of ['adult-consent', 'google-consent']) ui[id].addEventListener('change', updateControls);
  for (const id of ['keep-length', 'easy-maintenance']) ui[id].addEventListener('change', () => {
    if (active) return;
    epoch += 1;
    resetConsent();
    restoreEmptyCards();
    ui['results-title'].textContent = 'Meet your possibilities';
    showError('action-error', '');
    phase = 'idle';
    updateControls();
  });
  ui['check-results'].addEventListener('click', () => { if (active) { active.cancelRequested = false; pollResult(active); } });
  ui['cancel-generation'].addEventListener('click', () => { if (active) cancelRequest(active); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else if (active && phase === 'running') pollResult(active);
  });
  window.addEventListener('beforeunload', event => {
    if (active) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    disposed = true;
    epoch += 1;
    statusSequence += 1;
    stopPolling();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    active = null;
    clearLocalPhoto({ clearPreferences: true });
    ui['progress-panel'].hidden = true;
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    disposed = false;
    phase = 'idle';
    status = null;
    updateControls();
    loadStatus();
  });
  updateControls();
  loadStatus();
})();
