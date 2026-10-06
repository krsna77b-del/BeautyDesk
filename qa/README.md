# Approved presentation release QA, 2026-10-06

This independent suite reuses the reviewed 2026-10-03 JSDOM harness and immutable approved/production fixtures. It validates the presentation release integrated onto production afae8cc. Fixtures remain historical evidence, not a replacement application or public assets. `fixtures/provenance.json` records their source and hashes.

## Run

Use Node 22. Install pinned test dependencies with `npm ci --prefix qa`, leaving the app package and lockfile unchanged. Then run:

    node --test qa/*.test.cjs tests/marketing-navigation.test.cjs tests/frontend.test.cjs tests/frontend-http.test.cjs tests/modular-ui.test.cjs

`BD_JSDOM_PATH` can reference an already installed jsdom 30.1.1 package. `BD_NODE` selects the isolated HTTP server Node executable; otherwise the current executable is used. `BD_CANDIDATE`, `BD_EXPECTED` and `BD_BASELINE` override application and fixture directories.

## Release assertions

- Original hero and real signup form match historical production exactly; signup remains open and creates an empty disposable workspace
- Upper and lower Back links remain on login/signup, approved shell/widget styles are exact, scripted widget changes are limited to explicit price/payment/photo copy and PayFast recognition
- Shared renderer exactly equals shipped no-JavaScript marketing; R799 monthly price and pending PayFast billing appear honestly
- Bare `/pilot` is the modern authenticated catalogue, with photo ON withheld even if a fixture reports full provider readiness; catalogue preparation and turning an existing saved setting OFF remain usable
- Every historical `/pilot#...` bookmark retains afae routing: client/cl- hashes to `/pilot/controls`, admin/adm- hashes to `/pilot/admin`, unknown/marketing hashes to current `/`
- Legacy controls/admin remain separate session-gated pages; salon cookies cannot access admin and admin cookies cannot access salon controls; the old public landing is absent
- Login continuations are allowlisted, signup/login duplicate and stale responses are guarded, public and legacy copy contains no AI promotion
- Menu/chat repeat, Close/Escape, focus, inert/scroll cleanup, hash and route Back/Forward, queue cancellation, literal text rendering and compact viewport style behavior
- Photo OFF and catalogue request guards, failed retryable drafts, refresh during saves, navigation interruption and session expiry
- Strict static/CSP boundaries and private-source 404s; HTTP signup/login/session/logout use the unchanged local backend

Superseded historical assertions about undecided pricing, `/pilot-tools`, and enabled modern photo opt-in were replaced with explicit current-release behavior. Production navigation regression tests remain active. Backend code/tests are not modified by this suite.

## Isolation and limits

HTTP tests launch a fresh temporary SQLite database with explicitly synthetic environment values, refuse to run next to `.env`, preload a non-loopback network block, and disable photo processing. Databases and servers are removed at completion. No production data, external providers, or real credentials are used.

JSDOM has no rendered geometry. Width/height tests exercise focus and style code paths, not true device layout or keyboard presentation. `tests/modular-ui.test.cjs` includes an optional real-browser flow enabled by `RUN_BROWSER_UI=1` and `PLAYWRIGHT_MODULE`; it is skipped in the default command. Actual browser attempts and their limitations must be reported separately, never inferred from DOM success.
