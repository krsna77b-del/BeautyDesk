# Login compatibility follow-up — 1 October 2026, 21:02 UTC

This local follow-up supersedes the aggregate counts immediately below. It is not deployed and does not establish the cause of any production account's login failure.

- Runtime: Node 22.23.3; `npm run check` passed, including new `auth-email.js`
- Final `TZ=UTC npm test`: **363 passed, 0 failed, 1 skipped optional browser suite** (364 total; 20.19 seconds)
- Both pilot and modular logins accept uniquely matched migrated mixed-case/outer-whitespace emails using one consistent JavaScript normalizer; SQLite records, tenant IDs and stored credentials are not rewritten
- Normalized collisions return the same generic 401 as absent accounts or incorrect passwords, set no session cookie, and cannot cause arbitrary account selection or merging
- Signup prevents normalized duplicates; owner activation rejects ambiguous matches and retains credentials on unique existing-account reuse
- Passwords are neither trimmed nor case-folded; incorrect passwords remain rejected
- HTTP regressions verify preserved fixture client rows, original tenant IDs, unchanged activation records on collision, no authentication cookies on failures, and no credential disclosure
- Pilot and modular frontend tests distinguish generic 401, throttling, server failure and network failure without exposing internal server diagnostics
- The first run caught an outdated assertion that expected 15 frontend check groups after adding the 16th; corrected before the final clean aggregate pass
- Dependencies and lockfile are unchanged. The earlier fresh-install verification below remains historical; this follow-up used the existing locked local install
- Browser visual/E2E QA remains unverified as described below. No production data, provider credentials, external calls, upload, push or deployment was used

---

# Modular MVP verification — 1 October 2026

This section supersedes the older photo/pilot counts below for the expanded local candidate. No production deployment or real provider calls were performed.

- Runtime: Node 22.23.3, matching `.nvmrc` and package engines
- Fresh locked install: `npm ci` succeeded in a disposable clean directory (136 packages)
- Final source, syntax checks and aggregate tests re-run against that clean install: **360 passed, 0 failed, 1 explicitly skipped optional browser suite** (361 total; 19.21 seconds)
- Final working-candidate run: **360 passed, 0 failed, 1 explicitly skipped optional browser suite** (19.68 seconds)
- Application JavaScript syntax checks passed after every final code change
- Independent read-only review: 51/51 targeted HTTP, identity, concurrency and WhatsApp tests; 2/2 storage/migration tests; 13 additional synthetic edge assertions. No additional blocking domain/security defect found
- Additive old-schema migration preserves existing client/service/appointment columns, is repeatable and does not activate public booking, payment records or notification sends
- Concurrent SQLite tests prevent technician double-booking, duplicate request insertion, overpayment and excess refund records
- Public booking protects existing CRM identity/consent, tenant-scopes quotes, revalidates quoted catalog/staff details and preserves appointment contact snapshots
- Production preflight rejects a missing, empty or unrelated database before writable initialization. Empty/unrelated regression cases preserve original bytes without WAL/schema creation
- Existing consent-first photo and WhatsApp tests are retained; all provider responses remain mocked

## Browser QA

Seven deterministic frontend/VM regressions passed: enabled public response, stale availability responses, closed/replaced customer modal, duplicate submit, navigation during pending save, refresh preserving a newer modal, and owner reschedule exclusion. The public response omits `bookingEnabled`; the UI now treats only explicit `false` as paused. Owner availability now tenant-validates an optional current appointment ID before excluding it from conflicts.

Real browser execution was **blocked before page interaction**: native Chromium failed OS socket permission even on an admitted escalation; the supported cloud browser rejected localhost with `ERR_BLOCKED_BY_CLIENT`. No browser screenshots, responsive visual inspection or end-to-end browser pass are claimed. The optional browser harness is retained for another authorized environment and skipped by default. Run `RUN_BROWSER_UI=1 PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node --test tests/modular-ui.test.cjs` with an installed browser; all fixture HTTP traffic is restricted to localhost. This is a required remaining release gate.

## Unverified release gates

Real salon onboarding and staff qualification/hours; live end-to-end WhatsApp delivery; optional photo-provider quality/privacy approval; final verified production backup/restore and persistent storage cutover; real domain/mail routing; privacy/terms and retention/access procedures; production monitoring and account recovery. Payment entries and subscription status are manual. New proactive notifications are permanently mock-only in this implementation; no live send switch exists.

---

# Photo extension verification — 1 October 2026

Supersedes the test count below; original baseline evidence is retained afterward.

- Final aggregate count: **286/286 passed**, zero failures/skips (18.17 seconds). Includes 167 photo-state tests; syntax checks also passed.
- Node 22.23.3; locked dependencies, disposable SQLite databases, synthetic image buffers and injected/mock providers
- JavaScript syntax: server, database, AI, booking, frontend and all three photo modules passed
- Original 85 booking/authentication/frontend/HTTP tests retained and passing
- New signed WhatsApp end-to-end test: photo → fresh I AGREE → REFERENCE → details → exact menu estimate → BOOK 1 → date/time → summary → YES → one confirmed estimated-price appointment; repeated YES creates no duplicate
- New tenant-scoped settings API and frontend toggle tests cover host/catalog gates, validation, duplicate saves, failure draft preservation, disabling while blocked, and honest unverified status
- Owner appointment display marks photo-derived pricing as an estimate, with work/price-change review warning
- Photo-state tests cover consent timing, queued replies, tenant isolation, catalog mutation, provider ambiguity/failures, expiry, cancellation, byte clearing and text redaction
- Vision tests cover strict approved-ID schema, model/configuration opt-in, local sensitive-text rejection, bounded request, timeout, errors and no retries
- Media tests cover bounded decoding, metadata stripping, exact Meta allowlist, redirects, digest/length/MIME checks, malformed/oversize/animated input, and timeouts
- Independent read-only review: six state/expiry regressions plus 17 media-security checks passed; no remaining observed defect. Out-of-order/batched media and in-flight consent expiry findings were fixed and retested

No live Meta download, Anthropic image request, real customer photograph, deployment, credential configuration or production database mutation was used. Live model visual quality and real end-to-end WhatsApp behavior remain launch gates. Frontend coverage is local mocked DOM/HTTP interaction, not a new screenshot-based browser visual audit.

Default system Node 24 cannot load the existing Node 22 SQLite native binary. Verification deliberately used Node 22 matching package engines. Reinstall locked dependencies for the target runtime/platform rather than copying node_modules.

---

# Local verification — 1 October 2026

Final candidate verification:
- `npm run check`: passed for server.js, db.js, ai.js, booking.js and app.js
- `TZ=UTC npm test`: **85 tests passed, 0 failed/skipped**
- `TZ=America/Los_Angeles node --test tests/booking-conversation.test.cjs`: **61 tests passed, 0 failed/skipped**
- Additional HTTP-backed frontend run passed login/dashboard, simulator/reset, cancellation, manual-review acknowledgement and logout on a disposable fixture
- HTML duplicate-ID/handler checks and 15 frontend validation/rendering/duplicate-submit check groups passed

The 85-test aggregate comprises 61 booking/conversation tests, 22 HTTP/backend/operations tests, one frontend test containing 15 check groups, and one HTTP-backed frontend test covering five flows. Do not add nested assertions to the test total.

Runtime: Node 22.23.3, Linux x64. Locked dependencies used: @anthropic-ai/sdk 0.124.0, bcryptjs 2.4.3, better-sqlite3 11.10.0, cookie-parser 1.4.7, dotenv 16.6.1, express 4.22.2, jsonwebtoken 9.0.3. No package versions changed; the lockfile only gains the root Node engine declaration. Native SQLite binding was matched to Node22. Default Node24 could not reuse that compiled binding, so it was not used for the final checks.

## Covered behavior

- Exact repeated-greeting regression, split-message booking, customer identity/phone, time changes, explicit/no/ambiguous confirmation, refreshed price/duration, safe provider failure/output
- Arrival-time accepted-reply ID snapshots and acceptance timestamps; YES received during an unaccepted summary send cannot become consent retroactively. Delayed same-second YES is refused too; repeated fast replies never write, and a later valid reply books exactly once
- Durable booking origin IDs and saved prices; unknown/failed final replies or crash after commit cannot erase a booking and create a second one through a correction; cancelled/negated separate-booking intent is revoked
- No simulator booking writes, original relative-date time, Johannesburg time at UTC boundaries, invalid/past dates, closed/outside hours, exact service/duration and transactional overlap checks including a two-process race
- Malformed/unsigned callbacks rejected; correct signatures and sender scoping; batches and duplicate callbacks; correctly ordered conversation history; pre-summary batched YES refused until later consent
- Persistent jobs before ACK, restart resume for safe queued/prepared work, interrupted processing/send quarantine, stale service-window handling, review isolation and no resend on acknowledgement
- API rejection/transport uncertainty saved visibly without retries; receipt-before-send-response and late failed→delivered→read handling
- Signup/email normalization, client/owner authentication, cross-tenant services/cancellation/reviews, password validation and old-session invalidation, login throttling, origin/JSON checks, source-file non-exposure
- Production secure cookie/HSTS behavior; missing security/env/path/mount startup refusal; valid existing-volume startup
- Additive legacy migration twice with original records/hash/timestamps preserved; SQLite consistent backup integrity and overwrite refusal
- Actual Anthropic SDK import with provider traffic mocked; booking stays guided even when an AI key is configured
- Frontend repeated-submit protection, hours/password validation, safe escaping, setting/mode copy, calendar visibility, manual review, forms/mobile navigation and API-backed refresh/logout flows

## Not verified / not claimed

- No code push, deployment, production database access, real credentials, customer messages, paid setup or Meta account mutation
- No real Meta/Anthropic endpoint traffic; provider requests were mocked and other outgoing clients blocked
- No production Railway runtime, volume, snapshot/off-host backup, token validity/expiry, account permissions or number eligibility verification
- No browser visual/pixel QA: the cloud browser blocked the local preview URL; DOM and real local HTTP tests are not a substitute for a real browser acceptance pass
- No full penetration test, dependency vulnerability audit, multi-replica worker verification, load test, legal/privacy certification or completed billing integration

GitHub main was rechecked after implementation and still points to base commit `4ef1444d60e038b0d50d5db0a3efdac1ede3ffb1`. Recheck again immediately before any authorized publication.

Additional consent-race regression fixtures also pass independently: slow/unaccepted summary + premature YES leaves zero appointments; uncertain final confirmation + correction leaves the original single appointment. The independently reproduced delayed same-second callback is also rejected. Real customers receive an explicit two-second wait/reconfirmation instruction when ordering is ambiguous; simulator preview permits same-second responses. API acceptance is not proof of handset delivery; the local tests do not claim that it is.

Final independent verification: all 85 aggregate tests, syntax checks, 61 booking tests in America/Los_Angeles, and four additional HTTP fixtures passed against unchanged core source hashes. The additional fixtures cover unaccepted summary timing, uncertain final reply, delayed same-second callback, and receipt/recovery/separate-booking flows. This is a bounded local verification, not a production certification.
