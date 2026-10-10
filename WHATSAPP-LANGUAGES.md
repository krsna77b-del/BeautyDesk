# Customer WhatsApp language selector — draft, not released

Based on main d793d54514381af0a5c5b8fdb84069ce1acbd587. No deployment, customer message, credential, account permission, billing or production-data changes are part of this work.

## Behavior and boundaries

The real WhatsApp reply worker uses a four-option numbered text menu: English (en), isiZulu (zu), Afrikaans (af), isiXhosa (xh). Send LANGUAGE at any time, or LANGUAGE followed by a number/name/code. The aliases ulimi, taal and ulwimi also open the selector. Numbers only select languages while a language menu is open. First contact requests a choice; old customers without a preference are asked once on their next contact. A substantive first text booking request is resumed after selection.

A new additive whatsapp_customer_languages table keys preferences by salon ID and normalized verified WhatsApp sender, before any CRM record exists and for legacy salons. Existing customer records and reminder consent are not backfilled or changed. The simulator does not persist language preferences.

Translated message formats keep salon/customer names, service names, staff references, money, ISO dates, times and offered slots as opaque values. Stored display text is separate from canonical English parser text. Message IDs, acceptance timestamps, confirmation context and receipt handling are retained. Language inputs are control events, never booking consent. A switch regenerates the current prompt/summary and requires a later explicit confirmation. Failed switch responses cannot expose an older summary as the latest consent context.

Guided customer copy includes booking, availability, contact, appointment lookup, reminder controls and photo guidance/consent. Freeform AI generation and arbitrary salon greetings are bypassed for this localized customer path so unreviewed generated text cannot contradict deterministic booking facts. The existing English path remains available when the feature is disabled. The dashboard, owner alerts, signup, public booking UI and authentication are not translated.

Localized exact short answers (including yebo/ja/ewe, cha/nee/hayi, selected date/menu words) are supported. English command tokens shown in the translated prompts remain valid. Photo consent still requires the literal I AGREE; YES or language selection never supplies photo consent. Service descriptions entered by salons remain verbatim factual content. This is a guided flow, not unrestricted natural-language translation.

## Release gate

WHATSAPP_CUSTOMER_LANGUAGES must be explicitly set to 1 to enable the selector. It is OFF by default. No environment variable was changed during development.

All new isiZulu, Afrikaans and isiXhosa wording is DRAFT and pending fluent review, including grammatical agreement around dynamic names and all consent/privacy language. Require fluent review of complete rendered conversations, not just isolated catalog entries, before enabling. English copy changes and translated aliases also require product acceptance.

Required before release:
- Pass the Node 22 syntax, application regression and QA suites in a working environment.
- Review the additive schema and verify backup/restore and preference persistence with a disposable copy of the database.
- Verify real WhatsApp four-language conversations using authorized test numbers, including failed sends and late/duplicate inputs.
- Review first-contact photos and legacy conversations. A first photo is deferred using only its existing temporary reference; after language selection the original photo consent/expiry checks apply.
- Obtain explicit rollout authorization; do not deploy this draft.

## Reminders and Meta templates

The proactive notification outbox remains mock-only. This change adds no template send implementation, invented template name, or fallback freeform send. Existing customer-reply window checks before preparation and immediately before delivery remain in place.

Any future out-of-window reminder requires a separately verified, approved Meta template in the actual requested language, plus the existing opt-in/provider gates. isiZulu and isiXhosa template-language availability and account approval are UNVERIFIED. Do not substitute English or send freeform messages outside the window. This is a separate release gate, not a claim of template support.

## Verification

Local shell execution was blocked by: helper_unknown_error: setup refresh had errors.
No Node/SQLite suite is claimed to have passed locally.

The orchestration V8 runtime parsed the changed JavaScript and rendered 118 catalog entries in all four languages (472 render checks), preserving every placeholder. This is only syntax/catalog evidence; it is not Node, SQLite, HTTP, migration, concurrency or fluent-language verification.

New tests/customer-language.test.cjs exercises the real SQLite domain with synthetic fixtures and no real providers. The draft PR includes a test-only Node 22 GitHub Actions workflow (read-only repository token, no secrets, no deployment), running npm ci, npm run check, npm test, npm run build, static build consistency and the qa suite. Use its actual run result as the runtime evidence.

Regression suites include booking-conversation, modular-whatsapp, server and photo-flow. Existing provider mocks remain in use; nothing sends customer messages.
