# BeautyDesk photo-to-service candidate

Local continuation of the reviewed first-salon candidate, 1 October 2026. This is **not deployed or live-verified**. All provider traffic in tests is mocked or blocked.

## Customer journey

1. Customer sends a JPEG or PNG to the salon's WhatsApp number. The signed, number-scoped webhook saves only a temporary media identifier and digest, never the photo or caption.
2. Salon and host must both have opted in, with at least one explicitly eligible service. Otherwise the customer gets a text-booking/consultation fallback.
3. Before retrieval or analysis, the customer sees the named provider (Anthropic), privacy notice and retention caveat, then must reply `I AGREE` after that prompt was accepted. Queued or same-second consent cannot authorize analysis.
4. Customer identifies the image as `REFERENCE` or `CURRENT`, then describes desired result and current styling context. Unknown condition or suitability belongs with the salon; the model must not diagnose or infer protected characteristics.
5. A bounded Meta download is validated, decoded, resized and stripped of metadata in memory. The provider can return only one to three approved service IDs, category and confidence. No model-generated price or prose enters the customer reply.
6. Customer sees each actual menu service, its saved price/duration and the salon's description of included work/exclusions. Uncertainty, missing menu coverage, sensitive text or provider failure leads to consultation, with no booking.
7. `BOOK 1` selects a candidate. Existing deterministic booking checks collect day, available time and name. An accepted summary and a later explicit confirmation are still required. Photo appointments retain `quote_kind=photo_menu_estimate` and the session ID; the estimate caveat remains in the final message.

The estimate is not a guaranteed price or treatment-suitability assessment. The salon must check the work and agree price changes before starting. A photo does not establish damage, medical conditions or extra labour.

## Salon controls

Each service has separate photo eligibility, category (`hair`, `nails`, non-medical `beauty`) and a 10–400 character description covering included work and exclusions. Owner settings cannot alter another salon's services. Enabling the salon toggle requires a configured host and eligible menu. Disabling it clears temporary photo sessions/references.

The UI identifies configuration as configuration, not proof of a successful live test. Existing service prices remain the sole pricing source. No combined/add-on prices are guessed. Over 50 eligible services fails to consultation until the catalogue is deliberately narrowed.

## Host configuration (all off by default)

- `PHOTO_ESTIMATES_ENABLED=true` only after launch authorization and privacy review
- `PHOTO_VISION_MODEL=claude-haiku-4-5` (allowlisted adapter model; verify availability in the authorized account before launch)
- `ANTHROPIC_API_KEY` securely configured by the owner, never placed in source/chat
- `PHOTO_PRIVACY_URL` pointing to the salon's reviewed HTTPS privacy notice
- Existing signed webhook secret, WhatsApp number/token, Node 22 and persistent database requirements still apply

No credentials have been configured by this task. The source package has no customer images, database, credentials or node_modules. `sharp` is the new decoder dependency; the lockfile is included. Install on the target Node 22 platform and verify native module compatibility.

## Security and retention

- Existing raw-body signatures, tenant/number scoping, persistent queue, replay protection, origin IDs, receipt states and review-on-uncertainty remain in place
- Image captions are ignored; media identifiers never enter normal chat history or model prompts
- Temporary media references and sessions expire after 30 minutes, with cleanup during queue processing. Source/normalized bytes are memory-only and buffers are cleared after use; JavaScript/provider/library copies cannot promise forensic zeroization
- Free-form style details are removed from the incoming message after attempted analysis; customer phone, consent events, ordinary WhatsApp messages and appointment records follow the existing application's storage behavior
- Provider retention is separate from this application's retention. Do not claim zero provider retention unless the contracted account terms actually support it
- Network retrieval uses exact allowlisted Meta hosts/paths, no redirects, bounded bytes/time, MIME/hash/length checks and bounded decoding. Endpoint changes fail closed to consultation
- Crash/uncertain delivery remains an owner-review case; there are no blind paid-analysis or message retries
- Session expiry, cancellation or disablement cannot resurrect an old photo booking summary

## Mandatory production gates

1. Obtain authorization to configure the real vision provider, transmit customer photos after customer consent, and publish/deploy this candidate
2. Review salon/privacy-provider terms, lawful processing basis, customer notice, retention/deletion practice and consent wording; use only photos the customer may share
3. Owner marks accurate actual menu services/prices/durations/descriptions and exclusions; exclude medical services and uncertain work
4. Install the locked dependencies in Node 22, back up the existing mounted SQLite database, test additive migration/rollback and run the complete regression suite
5. Perform an authorized real WhatsApp test with a non-sensitive consenting test image: signed callback, fresh consent, Meta retrieval, model output, estimate, booking summary, explicit confirmation and owner dashboard record
6. Test provider failure, stale consent, repeated webhook, menu price changes, interrupted generation/send, delayed receipt, session timeout and host/salon disablement in staging
7. Have the salon approve the estimate disclaimer and consultation handling. Keep the existing single-process/single-capacity limitations; multi-staff allocation and guaranteed quotes are out of scope

Read `PILOT-READINESS.md` for the original booking/authentication/database release gates. They remain required.
