# BeautyDesk modular salon MVP

A local, verified candidate built additively on the reviewed BeautyDesk photo/WhatsApp pilot. **Not deployed. New notification automation is mock-only; payments and subscription status are manual records.**

Start with [`MODULAR-MVP.md`](MODULAR-MVP.md) for architecture, implemented scope and launch gates, and [`TEST-RESULTS.md`](TEST-RESULTS.md) for measured verification.

## Run locally

Use Node 22 (see `.nvmrc`). Install the locked dependencies with `npm ci`. Set a disposable local `DB_PATH`, a private `JWT_SECRET` of at least 32 bytes, and `ADMIN_PASSCODE` of at least 12 characters. Then run `npm start`.

- `/`: main BeautyDesk website
- `/signup` and `/login`: salon-owner workspace
- `/book/:slug`: a configured salon’s public booking page
- `/manage/:token`: private appointment-management link
- `/platform`: separate administrator login
- `/pilot`: authenticated photo catalogue and setup workspace; historical hash bookmarks retain their existing gated destinations
- `/pilot/controls`: WhatsApp/photo controls behind the existing salon session
- `/pilot/admin`: pilot administration behind the separate administrator session

`npm run build` generates a readable static marketing homepage from the shared UI renderer. `npm run check` checks all application JavaScript syntax. `npm test` runs disposable local fixtures and mocked providers. No production account or real provider credentials are needed for testing.

## Safety and release boundaries

Existing data and authentication are retained through additive migrations. Production requires the existing database on the persistent mounted volume; it refuses to silently create an empty replacement. Follow the authorized final-backup and restore/cutover procedure before deployment. Never copy only a live database file while ignoring SQLite’s WAL.

The shared booking domain supports qualified staff, hours, breaks, time off, real availability, explicit confirmation, customer history, calendar/status updates, cancellation and rescheduling. Manual payment records, event/outbox previews and separate platform subscription administration are included.

No real payment processing, automated subscription billing, live proactive notifications or newly configured photo provider is included. The existing live WhatsApp reply path remains separately configured and unchanged in its provider safety gates. Reports, promotions, loyalty and memberships remain later work. See `MODULAR-MVP.md` before making customer-facing promises.

The original baseline documentation is retained in `PILOT-README.md`, `PILOT-READINESS.md`, `PILOT-AI-NOTES.md` and `PHOTO-PILOT.md`. Their scope descriptions apply to the old pilot; the modular document above describes this extension.

## Approved presentation release — 6 October 2026

The current design includes the reviewed login Back link, photo catalogue workspace, clear WhatsApp example, limits/next steps, no-JavaScript marketing, scripted demonstration chat and homepage shortcuts. The original hero and real account signup remain. The published price is R799/month; PayFast and recurring billing remain pending, and no payment is collected by signup. Fees and commercial limits not yet agreed are not promised as included.

The photo screen supports catalogue preparation and switching an existing saved setting off. Enabling photo processing requires the separate reviewed provider/privacy backend release and a real acceptance test. This presentation release does not add a database migration, provider credential, payment integration, live reminder or generated hairstyle preview. Existing booking/authentication/WhatsApp handlers and the gated legacy controls/admin routes are preserved from production commit afae8cce2be9d5101c8edbd2136ce1aa57ca56fd.

The chat is a local scripted demonstration with no message delivery or booking action. The desktop/mobile preview switch belongs to the separate review page, not the customer application.
