# BeautyDesk launch checklist

This is a locally implemented modular MVP candidate, not a production launch approval. Do not interpret a passing test suite as evidence that a live provider, customer account or deployment works.

## Candidate implementation and verification

- [x] Separate B2B marketing, owner workspace and salon public booking routes
- [x] Tenant-scoped staff/service/customer/appointment/payment domain with additive migrations
- [x] Shared duration/qualification/hours/break/time-off availability, including WhatsApp integration
- [x] Explicit booking confirmation, quote revalidation, idempotent retries and concurrent capacity checks
- [x] Appointment/contact snapshots, private management tokens, reschedule/cancel policies and customer histories
- [x] Manual receipt/deposit/refund records, durable mock-only confirmation/reminder previews
- [x] Separate administrator session, audited subscription-status changes and truthful manual billing labels
- [x] Existing WhatsApp/photo consent and no-silent-booking regressions retained
- [x] Fresh Node 22 locked dependency installation and independent local domain review
- [ ] Real browser interaction, responsive visual and accessibility verification: browser launch was blocked by the execution environment; no screenshots or interaction pass are claimed

## Before a controlled live salon pilot

- [ ] Authorized final consistent database backup, private off-container hash verification, restore/integrity verification and persistent-volume cutover
- [ ] Start exactly one app process/replica; avoid overlapping WhatsApp workers during cutover
- [ ] Verify production origin, secure authentication configuration and signed webhook configuration through approved private setup
- [ ] Verify existing accounts/data after additive migration; do not replace the production database with an empty fixture
- [ ] Review the real salon's staff names, qualifications, prices, durations, hours, breaks and time off before enabling its public link
- [ ] Verify a complete customer public-booking flow in desktop/mobile browsers, including competing-slot rejection, refresh/back/cancel and private management link
- [ ] Confirm inbound WhatsApp, delivered summary, explicit confirmation and actual reply delivery using an authorized consenting test phone
- [ ] Keep photo estimates disabled until all separate PHOTO-PILOT.md consent, privacy, provider and quality checks are satisfied
- [ ] Publish/review applicable privacy and terms content; document retention, consent withdrawal, customer data access and support procedures
- [ ] Verify production alerts, recovery/support process and a safe restore drill
- [ ] Inspect actual DNS/mail zone before custom-domain routing; preserve any mail service depending on the root hostname

## Before a paid multi-salon launch

- [ ] Complete browser/visual QA and any operator acceptance fixes
- [ ] Implement/review account recovery and email verification, abuse controls and operational support
- [ ] Review production privacy/legal obligations and commercial terms
- [ ] Decide and validate payment/subscription provider implementation separately; this candidate never charges money
- [ ] Integrate/authorize approved WhatsApp templates, opt-in evidence, opt-out handling and delivery/error reconciliation before live proactive confirmations/reminders; this candidate has no live notification toggle
- [ ] Add pagination/load testing before tenant records exceed documented listing caps

Reports, promotions, loyalty and memberships remain later work. Real provider delivery, subscription charging and visual QA must never be described as complete based on mock tests.
