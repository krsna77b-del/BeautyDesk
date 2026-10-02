# BeautyDesk first-salon pilot patch

Prepared 1 October 2026 against inspected GitHub main `4ef1444d60e038b0d50d5db0a3efdac1ede3ffb1`.

**This is a locally tested candidate, not a deployed release or a claim that production is ready.** Existing WhatsApp replies were confirmed by the user, but the existing fallback repeated the greeting for “Bookings” and could auto-book an arbitrary first slot. This patch repairs that flow and the most consequential pilot blockers while retaining the existing interface and account model.

## Photo-to-service extension

This candidate now adds an opt-in, consent-first photo-to-service flow. Read `PHOTO-PILOT.md` for behavior, configuration, data handling and mandatory live-launch gates. Images are tested locally with mocked providers only.

## Main changes

- Guided multi-turn booking works without an AI key: service → day → selected time → name → price/duration summary → explicit confirmation
- Real phone/name retained; no first-slot auto-booking, unknown-service substitution, past/out-of-hours appointments, or overlap
- South African time used consistently; legacy timestamps and records preserved
- Simulator never creates/reserves appointments; old simulator-labelled appointments remain visible and blocked because older code used those markers even for some real WhatsApp bookings
- Optional Claude answers general questions only and has no booking mutation tools; failure cannot repeat a booking side effect
- Signed Meta callbacks, sender-number scoping, raw-body signature check, persistent inbox/outbox before acknowledgement, batch deduplication, bounded recent conversation context
- Arrival-time accepted-reply snapshots stop premature queued consent; committed appointment origin IDs and saved prices survive failed replies and prevent corrections becoming duplicate bookings
- Safe queued/prepared work resumes; interrupted generation or uncertain sends require explicit manual review, never blind retries
- Old/delayed callbacks beyond the free-form reply window are quarantined before booking; relative dates use original message time; pre-summary batched YES cannot provide consent
- Required server secrets, no default login credentials, login throttling, JSON/origin checks, scoped sessions and password-change revocation
- Partial settings updates, validated hours/services, normalized email signup/login, duplicate submit guards
- Dashboard cancellation, delivery review/acknowledgement, refresh, password change, mobile navigation, honest configuration and billing labels
- Persistent-storage startup checks, additive/repeatable database migration, tested consistent SQLite backup utility

See `PILOT-READINESS.md` for the release gates and feature inventory, and `PILOT-AI-NOTES.md` for supported booking phrases and limitations.

## Local development

Use Node 22 (tested 22.23.3), then `npm ci`. Native better-sqlite3 dependencies must be installed for that Node version. The photo extension adds the locked `sharp` image decoder dependency. `.nvmrc` and package engines pin Node 22.

Set private environment values for `JWT_SECRET` (at least 32 bytes) and `ADMIN_PASSCODE` (at least 12 characters), use a disposable local `DB_PATH`, and run `npm start`. `META_APP_SECRET` is required to accept real webhook POSTs. Without it, POST callbacks return 503; the rest of the app starts. Do not put secrets into chat, source control or screenshots.

`npm run check` checks JavaScript syntax. `npm test` uses disposable fixture databases and mocked/blocked providers, with no live Meta or Anthropic requests. Test credentials are explicit fake-only values.

## Database safety

Migrations only add fields, tables and indexes. Existing account hashes, numbers, credentials, conversations and appointment records are not deleted or replaced. Auth-version defaults preserve accounts, but changed JWT policy requires a new login after rollout. Do not rename the production DB file or point the service at a new empty path.

In production the database file must already exist at an absolute path. On Railway, a persistent volume must be detected and the file must be within that mount. The guard deliberately refuses to create an empty replacement when an existing volume/database is missing. This patch is for an existing deployment; brand-new installations require an intentional database provisioning step.

Run `DB_PATH=/absolute/existing/beautydesk.db node scripts/backup.cjs /absolute/new/backup.db` only in an authorized environment. It uses SQLite's online backup facility, verifies integrity and refuses to overwrite an existing destination. Do not copy a live `.db` alone while ignoring its WAL. The database/backups contain personal information and stored Meta tokens; protect them and do not upload them with the source bundle.

## Scope boundaries

One salon-wide booking capacity; one server process/replica with no overlapping workers. No multi-staff calendar, client self-service rescheduling, reminders, templates, real billing, voice processing or automated account recovery. Do not promise those features to the pilot salon. See the readiness checklist before publication.
