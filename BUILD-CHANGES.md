# Source/build changes

The candidate extends the reviewed photo/WhatsApp pilot rather than replacing its authentication, tenant identifiers or data.

## Login compatibility follow-up

- Shared `auth-email.js` matches legacy and new account emails consistently without rewriting records; both login routes fail closed on normalized collisions
- Signup and owner activation cannot silently reuse an ambiguous account
- Pilot and modular sign-in feedback separates generic credential failures from server, network and throttling problems
- Added HTTP and frontend regressions; final aggregate: 363 passed, 0 failed, 1 optional browser suite skipped

## New files and surfaces

- `modules/migrations.js`: versioned additive salon schema and appointment contact snapshots
- `modules/salon.js`: shared salon, staff, catalog, availability, booking, customer, payment, token and mock-outbox domain
- `modules/routes.js`: owner/public/platform APIs with role and tenant boundaries
- `ui.html`, `ui.css`, `ui.js`: unified cream/gold marketing, owner workspace, public booking and management interfaces
- `assets/favicon.svg`: branded static asset; reviewed pilot kept at `/pilot`
- Modular tests cover schema upgrades, HTTP roles, public privacy, concurrency, WhatsApp handoff, storage and frontend regressions

## Existing files updated

- `server.js`: mounts modular APIs/UI and connects retained legacy operations to the shared booking domain where initialized
- `db.js`: additive migrations and read-only production database recognition/integrity preflight before writable startup
- `booking.js`, `ai.js`: staff-aware shared availability and final confirmation while preserving delivered-summary, origin-message and photo-consent safeguards
- `package.json` and lockfile metadata: version 0.2.0 and expanded syntax checks; production dependency families unchanged from the reviewed photo candidate
- Documentation and manifest describe the expanded scope, measured tests and remaining launch gates

The source package excludes node_modules, all databases/WAL files, credentials, environment files other than the blank example, logs and browser fixtures. Reinstall with `npm ci` under Node 22; do not copy another machine's native node_modules.

`SOURCE-CHANGES.patch` compares application files with the locally reviewed photo-pilot baseline. `SOURCE-MANIFEST.json` records candidate file hashes. These are local source artifacts, not deployed commit identifiers.
