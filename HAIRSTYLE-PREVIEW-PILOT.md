# Private hairstyle preview pilot — 7 October 2026

## What is implemented

A separate authenticated `/hairstyle-preview` page accepts one authorized adult photograph, with optional keep-length/easy-maintenance preferences. Google Gemini 3.5 Flash-Lite selects three distinct IDs from a server-owned hairstyle catalogue using visible hair only. Gemini Nano Banana 2.1 then makes three separate edits, each from the same original normalized photo. Trusted labels and prompts come from the application, never from model-generated prose.

This is image generation, separate from the existing Anthropic photo-to-menu matching feature. Matching remains untouched and off. The new flow creates no appointment, quote, message to a third party, payment or signup. It does not infer identity, ethnicity, age, gender, health, personality, attractiveness or face shape. A preview can alter facial details and cannot promise the salon outcome.

## Current verification and limits

- Build and JavaScript syntax checks passed
- Application tests: 457 passed, 0 failed, 1 optional browser skip
- Separate DOM/HTTP QA: 72 passed, 0 failed
- Combined offline verification: 529 passed, 0 failed, 1 skipped
- Focused preview checks: 112 passed
- Independent review identified and verified fixes for extended image retention and mixed-case API origin/JSON bypass; review regressions are included
- Catalogue keep-length conflicts and absolute-expiry dispatch checks were corrected
- Browser pixel checks are NOT verified: local Chromium startup and cloud-browser localhost access were blocked
- No real Google inference or production activation has been performed by this code-preparation task

Source base is production `32ad43cbe8b7446c379631ba41a94840c0357938`, tree `6bcc23899301327a3b2ff0ee45dbc4b65552a0cb`. Unapproved visual changes and interrupted hostguard work are excluded. Recheck main before any release and preserve later approved changes deliberately.

## Exact secure configuration

The owner enters `GOOGLE_HAIRSTYLE_API_KEY` directly in the private Railway BeautyDesk production service. Never read it into a report, chat, source file, browser JavaScript, command history or test fixture. The code has no fallback to another provider credential.

Other values, only after the release gates:

- `HAIRSTYLE_PREVIEW_ENABLED=true`
- `HAIRSTYLE_PREVIEW_MODEL=gemini-nano-banana-2.1`
- `HAIRSTYLE_PREVIEW_PILOT_CLIENT_ID=<exact existing salon account ID>`
- `HAIRSTYLE_PREVIEW_NOTICE_VERSION=<explicit approved notice version, such as 2026-10-07-v1>`

The analysis model is pinned in source to `gemini-3.5-flash-lite`; consent binds both model names and the notice version. The authenticated status endpoint returns only the caller's `accountId`, for allowlist setup, never the configured key or another account's ID. A configured status is not evidence of active billing or a successful image generation.

Keep `HAIRSTYLE_PREVIEW_ENABLED` absent or false during a disabled source/UI rollout. When no prior preview ledger exists, disabled startup does NOT create any of the three new tables. An explicitly enabled startup creates the isolated consent/set/attempt tables after the operator's backup gate. No existing table is altered by the preview module. Existing preview ledgers are preserved, and interrupted work is marked unknown rather than replayed.

## Consent and privacy

Before any Google transmission, the user confirms the picture is theirs or used with the pictured adult's specific permission, all pictured people are adults, and that Google may process the chosen photo for three suggestions/previews. The consent is bound to a SHA-256 digest of the exact uploaded bytes, both preferences, the signed-in account, both models and the notice version. It expires after ten minutes and can authorize one set only. Changing the image/preferences or notice requires fresh consent.

Input is JPEG/PNG only, maximum 3 MiB. Bounded in-memory normalization strips metadata and reduces it to JPEG with a 1024-pixel long edge. The source is never saved as an image file or put in normal chat history. Each edit uses that same source; edits are not chained through earlier generated faces.

Server-held source/output bytes share one absolute ten-minute deadline from acceptance; successful later steps never extend it. Source bytes are cleared when processing finishes or is stopped. The browser holds its selected photo/previews in memory and clears them on page leave or explicit clear; it uses no localStorage/sessionStorage for images. Buffer clearing is not a guarantee of forensic zeroization. Consent hashes and conservative cost/idempotency records remain in SQLite without image files or free-form prompts.

Google paid-service content is not used to improve products, but abuse-monitoring retention can be 55 days with authorized human review. `store=false` disables retrievable Interaction state, not abuse monitoring. There are no File API uploads, Google Search tools, previous interactions, automatic retries or model-generated instructions passed to later calls.

## Budget and retry controls

The owner's approved Google pilot maximum is US$5. The app is more conservative:

- One set reserves FOUR calls atomically: one structured analysis and three image edits
- US$0.40 reserved per call; US$1.60 per set
- Maximum TWO sets for this persisted pilot, US$3.20 total reservation
- No reset/refund endpoint, no automatic paid retries, no second active set
- Duplicate request IDs return existing state/results without another reservation or paid call
- Failed, cancelled, interrupted and uncertain attempts retain their reservation
- Startup recovery marks active work unknown; it never resumes a possibly charged request

Using the full documented model input capacities and the enforced 1024/4096 output-token ceilings, one complete set has a conservative modeled Standard token-charge upper bound of US$1.2755968; two sets US$2.5511936. This is a pricing-based calculation, not observed billing. It excludes taxes, currency conversion and calls made elsewhere. A dedicated project/key and no other callers are required for the pilot budget assumption. Verify current prices before activation.

Google's provider caps/prepaid balance are not an instant hard stop because billing can lag. A new Prepay account requires at least US$5 credit, credits are non-refundable and expire after a year; auto-reload must remain off. Stop at checkout if the final charged amount exceeds the owner's approved total. Do not make a second payment just because access is not yet active.

## Activation and live acceptance gates

1. Review the exact source changes and current production baseline. Preserve pending user-approved changes; do not include the interrupted domain-guard work or unapproved visual proposal as a workaround.
2. Confirm one application instance/worker. Recovery assumes coordinated startup, not concurrent replicas independently recovering each other's work.
3. Before enabling table initialization, verify a consistent online backup of the existing mounted SQLite database, private off-container preservation and an isolated restore/integrity check. Do not copy only a live database file and omit WAL. A synthetic rehearsal is not proof of production backup safety.
4. Preserve current authentication and require the existing salon login. Select the exact authorized account ID; no demo login bypass or public/wildcard access is provided.
5. Confirm Google billing is active, the intended project/key is on paid service, and auto-reload is off. Key presence alone proves neither billing recovery nor model access.
6. Approve the displayed notice and its explicit version. The currently authorized first photo belongs to the user and is for Google-generated hairstyle previews; do not add other people or publish the original.
7. After an approved disabled deployment, check the real browser layout, auth, navigation and off-state. Then enable only the authorized pilot and run ONE authorized set first.
8. Verify actual Google completion, exactly three images, correct source person, requested hair changes, no unexpected changes to face/skin/body/background, safe labels and actual reservation counts. Review the outputs before using them in the demonstration. These are previews, not guaranteed salon results.
9. Verify cancellation, reload/uncertain-result guidance, exact expiry and signed-out access. Do not re-run generation silently when a response is lost or a result expires.
10. Turn the host flag off when the bounded pilot ends. Keep reservations and evidence; do not reset them to obtain extra calls without a new approved budget/plan.

The frontend instructs users to keep the page open. It polls GET results only, and it never automatically repeats a generation POST. A cancelled or expired set cannot be restarted under the same request ID. Partial results may remain viewable until expiry, clearly labelled incomplete.

## Testing locally

Use Node 22. Install locked application and separate QA dependencies with `npm ci` and `npm ci --prefix qa`. Run `npm run build`, `npm run check`, `npm test`, and `npm --prefix qa test`. Test fixtures are synthetic and mock/block all external networking. Never substitute the owner's real photo, API key or production database into the offline tests.

## Official sources checked 7 October 2026

- [Interactions API contract](https://ai.google.dev/api/interactions-api)
- [Image generation/editing and raw output format](https://ai.google.dev/gemini-api/docs/image-generation)
- [Nano Banana 2.1 capabilities and limits](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1)
- [Flash-Lite analysis capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Structured output schema](https://ai.google.dev/gemini-api/docs/structured-output)
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Output ceiling including thinking](https://ai.google.dev/gemini-api/docs/thinking#token-limits-and-max_output_tokens)
- [Billing](https://ai.google.dev/gemini-api/docs/billing)
- [Paid-service terms](https://ai.google.dev/gemini-api/terms#paid-services)
- [Abuse monitoring](https://ai.google.dev/gemini-api/docs/usage-policies)
