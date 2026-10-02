# First-salon readiness and staged rollout

Prepared 1 October 2026. Status: **local candidate prepared; deployment and real-customer launch still gated**.

## Completed in this candidate

1. Reliable guided booking including the exact “Hey it’s Alan” → “Bookings” case. It asks for missing information, offers actual availability, respects the selected time and requires a fresh explicit confirmation.
2. Validation and transactional clash prevention; real customer phone retained; all appointment times use Africa/Johannesburg. No simulator appointment writes.
3. Webhook authentication, sender scoping, durable inbox/outbox, duplicate suppression, batch ordering, crash/stale-work review and monotonic delivery status. Consent is bound to the reply already accepted when the input arrived. Committed appointment origins/prices survive uncertain final replies; a correction cannot silently create another appointment.
4. Strong required host credentials, limited login attempts, restricted sessions, password changes, cross-tenant endpoint tests, JSON/origin checks and secure production cookies.
5. Dashboard refresh, cancel-with-warning, explicit failed-message review and no automatic resend; setting/service input checks and mobile navigation.
6. Removal of fabricated social proof/live metrics, false PayFast/renewal statements, and misleading payment status. R799/month is a published price, not a collected subscription.
7. Additive migrations, persistent-path protection, single-process shutdown handling, backup command and deployment guidance.

## Before any code is deployed

- Recheck GitHub main against the base commit above and reconcile any newer changes. Deploy the candidate as one coherent revision, including new booking.js and tests/docs; do not replace only one file.
- Inspect the actual Railway runtime and volume settings using owner-authorized access. Preserve the existing database and verify its current absolute location. The present production volume, backup history, runtime and environment configuration have not been inspected.
- Create a consistent backup and test restoration in a disposable location. Check existing record counts and integrity before and after migration. Do not restore an old database over new activity.
- If the database is currently on ephemeral storage, back it up before attaching/changing a volume. Mounting over the current directory can hide the existing file. Migrate the consistent backup deliberately and verify it before changing DB_PATH.
- Confirm exactly one server process/replica and no overlapping workers, including deployment/restart. This worker has no distributed leases; concurrent replicas are unsupported even though appointment conflict transactions are tested across SQLite processes.
- Check for duplicate legacy Phone Number ID links between the old and new salon accounts before enabling real customer use. Existing links can still rotate credentials, but new duplicate claims are rejected. Resolve which account owns the callback; do not erase or reassign records automatically.
- Review host settings securely: NODE_ENV=production, Node22, existing absolute DB_PATH, detected Railway volume mount, PUBLIC_BASE_URL equal to the actual HTTPS origin, strong independent JWT_SECRET and ADMIN_PASSCODE, and the correct Meta app's META_APP_SECRET. ANTHROPIC_API_KEY is optional.
- Do not generate/change credentials or permissions as part of an unreviewed rollout. An owner must configure them through the secure host/Meta flow. Never paste them into chat or source control.
- Missing/short JWT/admin values, absent existing database, wrong volume path or absent production HTTPS origin intentionally stop startup. Missing META_APP_SECRET returns 503 for POST callbacks. Configure and validate prerequisites **before** publishing; otherwise active test replies will stop.
- Changing JWT signing settings invalidates current browser sessions; keep a verified owner/salon sign-in route available. Password change requires the existing password; no email reset system exists.
- Obtain explicit approval to push/deploy. No production files, Meta settings, paid services or credentials were changed during this preparation.

## Controlled deployment and acceptance

1. With backup/configuration/approval verified, ship one revision and confirm the exact commit on Railway, startup logs and /healthz. Do not interpret health alone as WhatsApp readiness.
2. Sign in using authorized accounts. Verify existing salon profile, services/hours, historical messages and appointment counts survived. Legacy simulator/whatsapp-ai appointment markers must be reviewed with the salon; do not delete them automatically or release their slots based on the marker alone.
3. Verify generated callback uses HTTPS and points to the intended client. Confirm Meta's app secret, subscribed messages field and phone-number ID match that callback. Unsigned or wrong-secret requests must be rejected.
4. With a specifically designated consenting test number, complete greeting → Bookings → configured service → explicit future date → selected available time → customer name → summary → YES. If asked to reconfirm, wait two seconds after the new summary arrives before replying YES. Verify one appointment, correct customer number, price/duration and South African time, plus reply receipt on the phone.
5. Repeat an inbound callback or repeat YES; it must not create/send duplicates. Try an occupied/past/closed time and an invalid service; no incorrect appointment should be written.
6. Verify a final booking reply with failed/unknown delivery still leaves exactly one saved appointment and a review warning. Subsequent corrections must not create another appointment. Marking reviewed does not cancel the original; a separate appointment requires explicit new-booking intent. Complete a simulator booking through YES; confirm no appointment was saved. Review a failed/unknown fixture separately; acknowledgement must not send any message or change a booking.
7. Test two salon logins for isolation, password-change old-session invalidation, mobile forms/navigation and a real browser visual pass. Browser visual QA of this candidate remains unverified in the available environment.
8. Confirm one known backup can be restored offline and the operator knows how to review uncertain sends. Only then start a closely supervised first salon pilot.

Rollback: prefer code rollback only when schema compatibility is verified; keep additive columns/tables. Do not delete durable queue/history rows or restore a stale database. A code rollback to the old release also reintroduces the old security/booking bugs and is not a safe long-term state. Pause real customer use and resolve configuration rather than bypassing the new safeguards.

## Meta production setup checklist

- The current test sender/allowed-recipient test is evidence of the test conversation only. Choose an authorized real business number and verify ownership, display name/account status, app permissions, number registration and asset access in the actual Meta account. No account-specific eligibility, approval or charging status was inspected.
- Own-business testing and onboarding unrelated salon businesses are different release paths. For external customer assets, review the applicable Tech Provider/Embedded Signup and App Review/Advanced Access requirements; a working developer test does not establish approval to onboard customers. Meta's maintained [Embedded Signup reference](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) describes the external-customer onboarding path and review gates. Exact permissions depend on the chosen flow; verify them in the current [Meta app-review guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review/).
- Decide whether to use a dedicated number or retain an existing WhatsApp Business app workflow. Check account-specific eligibility for [Meta's Business App coexistence onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) before migrating or deleting any app registration. This candidate does not implement Embedded Signup, coexistence history/echo synchronization or multi-app secret routing. Do not promise that an existing app will keep working, or that migration must always disconnect it. Direct Meta developer pages were rate-limited during this review; eligibility/details remain to be checked in the account.
- Replace a temporary development token through an authorized secure setup with the appropriate production access. Meta's official [Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api) distinguishes short-lived user tokens from system-user options; record actual expiry, asset assignments and revocation recovery. A token described as non-expiring can still be revoked. No token was generated, read or changed here.
- Ordinary free-form replies are for the customer-service window. Later/business-initiated messages require the appropriate approved templates and permissions/consent. This patch sends no templates/reminders and quarantines work older than the safe reply window. Maintain a clear human escalation option and published privacy information. See the [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy/preview?lang=en_US).
- Configure HTTPS callback, correct verify token, matching app secret and messages subscription. One configured app secret/number-to-client callback is supported for this pilot; do not scale onboarding to multiple unrelated Meta apps without a routing/secret design.

## Full feature inventory

### Public website
- Existing landing-page design and product/pricing explanation, with explicitly illustrative examples
- Contact/enquiry form saved for manual owner follow-up
- Pilot/signup request form saved for manual activation; no automatic email or charge

### Owner portal
- Passcode login/logout/session check
- Enquiry list and new/contacted/converted/lost status updates
- Signup list and idempotent activation into a client account; temporary password only returned for a newly created account
- Actual enquiry/signup counts; no payment revenue analytics

### Salon portal
- Email/password login, logout, profile/configuration view
- Password change with current-password check and prior-session invalidation; no self-service lost-password recovery
- Service list/add/delete, price and duration; no service editing endpoint
- Weekly same-day hours, greeting and receptionist on/off
- Phone Number ID/token connection settings, masked credential inputs, HTTPS callback and verify token
- Real configuration/readiness labels, latest delivery/error, recent incoming messages
- Upcoming appointments, South African time, explicit cancellation that releases the slot without notifying the customer
- Failed/interrupted/unknown WhatsApp message review and acknowledgement; no resend button
- Guided/optional-AI mode, test conversation, reset, isolated preview booking
- Visible periodic/manual refresh and mobile dashboard navigation
- Billing disclosure only; no PayFast, payments, renewals or paid-status verification

### WhatsApp backend
- Text messages only, guided new booking, price/hour answers, optional general-question AI
- One salon-wide capacity; no independent staff/chair calendars
- Request-scoped identity and persisted true phone, service, time and name
- Signature verification, duplicate handling, durable processing, delivery receipt/error tracking, stale/interrupted-work review
- No cancellation/reschedule via chat, outbound templates, reminder campaigns, email/SMS/push notifications, voice notes, image understanding or human-chat inbox replies

### Operations / remaining release limits
- SQLite WAL, additive schema upgrades, tested backup command; actual host volume/off-host backup schedule is still unverified
- No distributed multi-replica worker, high-availability database, external calendar sync, integrated billing, staff permissions, full audit/export/retention tools, self-serve onboarding or password-recovery service
- Saved Meta tokens are still in the restricted application database. Restrict host/backup access and decide an encrypted-secret storage strategy before broader multi-salon rollout
- A real privacy notice, support contact/escalation process, pilot commercial terms and data-retention decision need the operator's review before real-customer launch. No legal compliance certification is implied

## Storage reference

Railway documents that [volumes](https://docs.railway.com/volumes) supply the persistent mount and that a relative ./data path resolves under /app. Its [backup feature](https://docs.railway.com/volumes/backups) supports volume snapshots. Those capabilities do not prove this deployment already has either configured. No backup subscription or paid storage change was enabled here.
