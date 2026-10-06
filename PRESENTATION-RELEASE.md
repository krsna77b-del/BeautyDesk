# Approved presentation release — 6 October 2026

Based on verified production `afae8cce2be9d5101c8edbd2136ce1aa57ca56fd` (tree `456887816aa651b15c1e7a5c8526015f0d428b29`). Reviewed presentation assets were recovered from the preserved source archive, not redesigned.

## Included

- Original hero and real account signup remain; no demonstration auto-login
- Upper and lower Back links, modern photo catalogue workspace, WhatsApp explanation and clearly labelled illustrative conversation
- R799/month; PayFast and billing remain pending, with undecided fees/limits not represented as included
- Limits/next steps, static homepage readable without JavaScript, homepage shortcuts and a local scripted chat
- Existing historical pilot hashes and session-gated `/pilot/controls` and `/pilot/admin` routes remain; old public marketing and promotional AI labels stay retired
- Bare `/pilot` opens the authenticated modern catalogue. Enabling photo processing is withheld; catalogue preparation and switching a saved setting off remain possible

## Verification

Node 22.23.3: combined `node --test tests/*.test.cjs qa/*.test.cjs` completed with **417 passed, 0 failed, 1 optional rendered-browser suite skipped** (418 total). Application syntax and static-marketing build passed. The combined count includes the independent UI/HTTP checks without double-counting.

Coverage includes real local signup/session/isolation, old and new login return paths, catalogue persistence, all attempted photo ON rejection, overlapping save/refresh handling, Back/Forward, shortcut focus/close, chat lifecycle/literal output, R799/PayFast statements and exact no-JavaScript renderer output. Tests use disposable synthetic data with mocked or blocked provider transport.

CUA localhost rendering was blocked by the browser client, so physical browser geometry and mobile keyboard rendering are not established by these tests. Public visual smoke checks follow deployment. JSDOM width settings test code paths, not device geometry.

## Release boundary

The backend, database schema/migrations, authentication, existing signup handlers, WhatsApp/photo provider code, runtime dependency lock, credentials and provider settings are unchanged. The only server edits select static marketing for `/` and explicitly expose the two chat assets. No photo/provider/payment activation or real customer test is included. The photo capability remains a separately configured approved-menu matching flow, not generated hairstyle images or guaranteed quotations.

The separate review site's desktop/mobile preview control is not added to the customer application. No review-site sharing or external messages are part of this release.

Rollback can restore the prior presentation tree with a new source commit; no database rollback is needed because this release adds no migration. Preserve any newer unrelated commits when applying a rollback.

## Public desktop verification

After deployment, the public homepage, scripted chat, shortcuts, signup form, both Back links and old/current pilot/admin login routes were checked in the cloud browser without creating an account or booking. A screenshot exposed the upper Back link sharing a line with the auth subtitle; a one-rule CSS correction gives it its own row. The 43 additional UI/HTTP tests were rerun for that correction. Mobile/device geometry and an authenticated live workspace remain unverified.
