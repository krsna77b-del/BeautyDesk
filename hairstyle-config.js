'use strict';
// Deliberately separate from the existing Anthropic menu-matching pilot.
const MODEL = 'gemini-nano-banana-2.1';
const ANALYSIS_MODEL = 'gemini-3.5-flash-lite';
const MODEL_BINDING = MODEL + '__' + ANALYSIS_MODEL;
const PROVIDER = Object.freeze({ id: 'google', name: 'Google', origin: 'https://generativelanguage.googleapis.com' });
const LIMITS = Object.freeze({ inputBytes: 3 * 1024 * 1024, normalizedBytes: 2 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024, responseBytes: 7 * 1024 * 1024, dimension: 1024,
  timeoutMs: 90000, maxOutputTokens: 4096, cacheMs: 10 * 60 * 1000, maxSets: 2, callsPerSet: 4, reservationCents: 40, limitCents: 320, analysisOutputTokens: 1024 });
const STYLES = Object.freeze([
  { id: 'soft-waves', label: 'Soft waves', keepsLength: true, easyMaintenance: false, instruction: 'Soft flowing waves with a natural-looking finish, adapted to the original overall hair length.' },
  { id: 'sleek-bob', label: 'Sleek bob', keepsLength: false, easyMaintenance: true, instruction: 'A sleek, chin-length bob with a clean softly rounded outline.' },
  { id: 'shoulder-layers', label: 'Shoulder-length layers', keepsLength: false, easyMaintenance: true, instruction: 'Shoulder-length hair with soft, face-framing layers.' },
  { id: 'pixie-cut', label: 'Pixie cut', keepsLength: false, easyMaintenance: true, instruction: 'A short textured pixie haircut with a soft natural hairline.' },
  { id: 'box-braids', label: 'Box braids', keepsLength: true, easyMaintenance: false, instruction: 'Neat medium-width box braids with realistic sections and a natural hairline, adapted to the original overall hair length.' },
  { id: 'natural-curls', label: 'Defined curls', keepsLength: true, easyMaintenance: false, instruction: 'Defined, voluminous curls with a realistic natural hairline, adapted to the original overall hair length.' },
  { id: 'face-framing', label: 'Soft face-framing layers', keepsLength: true, easyMaintenance: true, instruction: 'Soft face-framing layers with the original overall hair length and colour retained.' },
  { id: 'sleek-straight', label: 'Smooth straight finish', keepsLength: true, easyMaintenance: true, instruction: 'A smooth straight finish, keeping the original overall hair length and colour.' },
  { id: 'half-up', label: 'Relaxed half-up style', keepsLength: true, easyMaintenance: true, instruction: 'A relaxed, simple half-up hairstyle, preserving the original hair length and colour.' },
].map(Object.freeze));
const DISCLAIMER = 'AI-generated hairstyle preview. Your face or other details may change; check the image carefully. This is an illustration, not a promised salon result or a booking.';
function configuration(env = process.env) {
  const model = env.HAIRSTYLE_PREVIEW_MODEL;
  const noticeVersion = env.HAIRSTYLE_PREVIEW_NOTICE_VERSION;
  const clientId = env.HAIRSTYLE_PREVIEW_PILOT_CLIENT_ID;
  const key = env.GOOGLE_HAIRSTYLE_API_KEY;
  let reason = null;
  if (env.HAIRSTYLE_PREVIEW_ENABLED !== 'true') reason = 'preview_disabled';
  else if (model !== MODEL) reason = 'preview_model_required';
  else if (typeof noticeVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(noticeVersion)) reason = 'preview_notice_required';
  else if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) reason = 'preview_pilot_required';
  else if (typeof key !== 'string' || key.length < 16 || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) reason = 'preview_provider_key_required';
  return { ready: reason === null, reason: reason || 'configured_not_live_verified', model, noticeVersion, clientId,
    // Keep the credential private to the adapter. Never serialize this object.
    key: typeof key === 'string' ? key : null };
}
function disclosure(config) {
  return `This optional pilot sends your chosen photo and optional styling preferences to Google (${PROVIDER.origin}), using ${ANALYSIS_MODEL} to suggest three styles and ${MODEL} to create a preview of each. Only use your own photo or a photo the pictured adult has specifically allowed you to use. Do not upload children, other people, private documents or health information. BeautyDesk processes the source photo in memory and does not save its image file. A generated preview may remain in server memory for up to 10 minutes so the same request can be viewed without another paid call. Your browser holds the preview until you clear it or leave. Google does not use paid API inputs or outputs to improve its products, but can retain prompts and outputs for 55 days for abuse monitoring, with authorized human review possible. This is not zero retention. Consent and cost-control records are retained without image files. Your face or other details can change, and the result is not a guaranteed salon outcome or a booking. Notice version: ${config.noticeVersion || 'not configured'}.`;
}
function publicStatus(env, ownerId, budget) {
  const config = configuration(env);
  const permitted = config.clientId === ownerId;
  return { accountId: ownerId, enabled: env.HAIRSTYLE_PREVIEW_ENABLED === 'true', ready: config.ready && permitted,
    reason: config.ready && !permitted ? 'preview_not_in_pilot' : config.reason,
    provider: PROVIDER.name, model: MODEL, analysisModel: ANALYSIS_MODEL, noticeVersion: config.noticeVersion || null,
    disclosure: disclosure(config), disclaimer: DISCLAIMER,
    privacyLinks: ['https://ai.google.dev/gemini-api/terms#paid-services', 'https://ai.google.dev/gemini-api/docs/usage-policies'],
    styles: STYLES.map(({ id, label }) => ({ id, label })),
    budget: { ...budget, currency: 'USD', approvedMaximumCents: 500, note: 'Each set reserves $1.60 for one suggestion call and three previews, even if interrupted. Maximum two sets. This is a conservative pilot allowance, not a report of Google charges.' } };
}
module.exports = { MODEL, ANALYSIS_MODEL, MODEL_BINDING, PROVIDER, LIMITS, STYLES, DISCLAIMER, configuration, disclosure, publicStatus };
