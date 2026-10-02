# BeautyDesk modular MVP candidate

Status: local implementation and verification only. This source bundle has not been pushed, deployed, connected to new live providers, or used to send real messages. The existing pilot remains available at `/pilot`; the new main website is `/`.

## Product surfaces

- `/`: B2B BeautyDesk marketing, truthful example offer and product walkthrough
- `/signup`, `/login`, `/onboarding`: salon owner account and setup
- Owner workspace: dashboard, day/week/month calendar, appointments, customers, services, staff, payments, messages, settings, subscription status
- `/book/:slug`: each enabled salon's customer booking flow, separate from the B2B site
- `/manage/:token`: private appointment management link with configured cancellation/rescheduling notice
- `/platform`: separate platform administrator session; subscription changes require a reason and are audited
- `/pilot`: retained pilot settings, WhatsApp connection/simulator and consent-first photo controls

## Shared architecture

`clients.id` remains the tenant identity so that no existing account, hash or foreign key is replaced. In the domain/UI it represents a salon. Every new resource lookup scopes its tenant explicitly. The platform administrator uses a separate cookie/role and does not impersonate owners.

- `modules/migrations.js`: transactional, versioned additive schema changes
- `modules/salon.js`: salon/catalog/staff/customer domain; shared availability and appointment mutation services; payments; quote confirmation; event/outbox handling
- `modules/routes.js`: tenant and public HTTP APIs, role checks, explicit-confirmation boundaries and safe serializers
- `booking.js` + `ai.js`: retained reviewed WhatsApp flow, augmented with staff-aware scheduling for initialized modular salons
- `ui.html`, `ui.css`, `ui.js`: branded marketing/owner/customer interface

The booking domain checks service duration and price integrity, active status, qualified active staff, salon and staff opening hours, recurring breaks, time off, existing confirmed/pending appointments, future time and a one-year booking horizon. South Africa time is used throughout. Staffless historical appointments conservatively block every technician until reviewed. `BEGIN IMMEDIATE` protects the final availability check plus insert across SQLite connections. Multiple technicians can take simultaneous appointments only when each is qualified and free.

Staff and services are archived rather than physically removed through modular APIs. Archived records remain in appointment history. A catalog update never rewrites saved appointment price or duration.

## Account/setup migration

Startup adds schema only. Existing salons remain on the reviewed legacy booking path until an owner opens the modular workspace. Initialization creates a default owner/team capacity and links the pre-existing menu to preserve the original salon-wide capacity; owners must verify the actual technician name, qualifications, hours, breaks and time off before enabling/sharing public booking. Unknown historic staff assignments are not invented.

New owner signups start with a recorded 14-day trial, no payment method, and public booking disabled. At least one active service with qualified active staff is required to enable it. Account recovery, email verification, additional owner accounts and staff logins are not implemented in this iteration. These are production hardening/product gates, not implied completed features.

## Public and WhatsApp confirmation

Public booking is service → technician/any qualified → date → current availability → customer details → expiring quote → explicit confirmation. A quote reserves nothing. Confirmation rechecks the actual technician, labels, price, duration, deposit and capacity; a competing booking or changed quoted detail requires a fresh choice/summary. Confirmed-quote retries return the existing booking while the quote is retained; confirmed quotes older than 24 hours are cleaned up on later quote creation.

Unverified public callers cannot read or overwrite an existing customer's CRM identity or consent by entering the same phone number. Appointment name/email are snapshots of the information supplied for that booking. CRM recognition in WhatsApp uses the tenant and verified incoming sender number. Customer notes remain owner-only.

WhatsApp preserves delivered-summary timing and origin-message idempotency, including photo-consent protections. A specific technician is included in the accepted summary and rechecked at the final transaction. The simulator never creates appointments. Private management links are generated only for configured HTTPS public origins. Customers should keep management links private; anyone holding one can view and manage that appointment within the salon's rules. Changing `JWT_SECRET` invalidates old management links and sessions.

Cancellations and reschedules update a version and create an idempotent domain event in the same transaction. Old queued notifications are superseded. Repeated identical mutation targets do not create duplicate events. Public cancellation/reschedule respects salon notice settings; owners can make ordinary corrections without that public cutoff. Completed/no-show status cannot be applied before the appointment starts.

## Money, messages and subscription truth

Prices and receipts use the original integer-rand schema. No payment provider is integrated. Deposit/payment/refund entries are manual records, not bank verification or money movement. Collected revenue is receipts less refunds. Appointment value is shown separately. Receipts cannot exceed the saved booking value and refunds cannot exceed the net recorded receipts, even across concurrent processes.

Verified WhatsApp sender commands `STOP`, `STOP REMINDERS`, and `UNSUBSCRIBE` remove reminder opt-in for the matching tenant customer. `START REMINDERS` explicitly records a preference only; it does not enable a live provider. Simulator/dry-run commands cannot change consent.

New confirmations/reminders create a durable outbox and process automatically in **mock-only mode**. The module has no live-send implementation or toggle. It checks opt-in again at processing time; no opt-in means blocked. `mock_ready` means an unsent preview, never provider acceptance or delivery. Original pilot conversation replies retain their existing separately configured Meta path. Platform billing status is manually recorded; trial/active/payment_failed/cancelled does not claim a charge took place.

Before adding live reminders, separately integrate and validate provider-approved templates, opt-in evidence, opt-out handling, sender/account approval, delivery receipts, template category/rate policies, uncertain-send handling and an authorized operational rollout. No code here silently enables that integration.

## Limits and launch gates

- This is a single-node SQLite deployment. Booking/payment transactions are concurrency-tested across local SQLite connections, but the existing WhatsApp reply worker still requires one app process/replica with no overlapping worker deployment
- No real salon configuration, sender onboarding, image provider, delivery, payment processing or recurring subscription charging has been tested by this implementation
- The existing consent-first image feature is still separately opt-in and subject to every gate in `PHOTO-PILOT.md`
- Calendar/booking reads return the most recent 1,000 appointments; customer search returns up to 500 matches; payment history returns up to 1,000 records. Dashboard totals read the full tenant dataset. These listing caps need pagination before large-scale use
- No bulk import, staff logins, client login portal, multi-location resource modeling, waitlists, gift cards or online refunds
- Reports, promotions, loyalty and memberships are explicitly later features
- Production volume cutover, final verified backup, DNS and domain/mail settings are independent operational work. This bundle performs none of them
- Privacy/terms content, retention/access procedures, alerting, restore drill, email/account recovery and production abuse/rate capacity require operator review before a paid multi-salon launch

## Verification/run

Use Node 22 (`.nvmrc`). `npm ci`, `npm run check`, and `npm test` use the locked dependency graph. Local testing uses disposable fixture databases and fake credentials with network providers mocked. Do not ship those fixture databases.

Local development needs a disposable `DB_PATH`, a private `JWT_SECRET` of at least 32 bytes and `ADMIN_PASSCODE` of at least 12 characters. Production still refuses an absent/empty replacement database or a Railway database path outside a mounted persistent volume. Take and verify the final authorized online backup before production changes. Never copy only the live SQLite database while ignoring its WAL.

`TEST-RESULTS.md` contains the final measured test/QA result for this candidate. The prior pilot readiness documents describe the retained legacy baseline and should be read together with this file; this file is authoritative about the new modular scope.
