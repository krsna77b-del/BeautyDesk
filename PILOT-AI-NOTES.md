# Pilot booking responder notes

## What is implemented

Bookings, service prices and opening hours use deterministic rules, with or without an Anthropic key. The optional provider handles general questions only. It has no tools that can create, change or cancel appointments; failure returns the guided greeting without replaying a mutation. Its timeout is 12 seconds with SDK retries disabled.

The booking flow gathers an exact configured service, date, chosen time and customer name, then shows a summary including price and duration. Only a subsequent explicit confirmation can write the appointment. The customer's actual WhatsApp number is retained. Mentioning a service and day never books the first available slot.

Examples of supported messages:

- `Hey it’s Alan`, `Hi I’m Alan`, `My name is Alan`, or a plain name when asked
- `Bookings`, followed by an exact service name from the salon's menu
- `today`, `tomorrow`, `Friday`, `2031-10-02`, `02/10/2031`, or `2 October 2031`
- `10:30`, `10am`, `2pm`, `14h30`, or `at 14`; a bare hour is also accepted after the time question
- `Actually at 11am` to revise a proposed time
- `YES`, `confirm`, `book it`, or `go ahead` after the summary
- `no`, `no thanks`, `cancel`, or `stop` to stop an unfinished request
- `prices`, `hours`, or `Are you open tomorrow?`

Times without AM/PM use 24-hour interpretation. Use an explicit date for ambiguous requests and one service/date/time at a time. No unknown service is replaced with a different menu item.

## Integration contract

`generateReply` accepts `client`, `services`, `history`, `incomingMessage`, `customerPhone`, `customerName`, `dryRun`, durable confirmation/booking context, and three optional dates:

- `now`: actual processing time, used to reject past appointments
- `messageAt`: original customer-message time, used for relative dates
- `receivedAt`: server receipt/staging time, used to ensure a queued YES did not arrive before the summary existed

Historical message dates anchor historical relative phrases. A real confirmation must match the latest eligible outbound summary, its Meta API `accepted_at`, and the immutable `confirmationMessageId` captured when the inbound event was staged. Both original message time (second precision) and server receipt time are checked against acceptance time. A real confirmation must be sent in a strictly later timestamp second; an ambiguous fast reply gets a fresh summary with a clear instruction to wait two seconds and reply YES again. Repeated fast replies do not write; a later valid reply completes normally. A summary that finishes sending later cannot retroactively authorize an earlier YES. The simulator may use creation time because it has no booking side effects. API acceptance is not proof of handset delivery. A failed reply to a customer correction cannot authorize the stale earlier summary. A changed price/duration requires a new summary; price and duration are also checked against live service data during the write.

`booking.js` exports `validateHours`, `getAvailableSlots`, `checkRequestedSlot` and `bookAppointment`; `ai.js` re-exports them. `validateHours` returns `{ok, hours}` or `{ok:false, reason}`. It requires all seven day keys, each `closed` or a valid same-day `HH:MM-HH:MM` range. Invalid saved hours fail closed.

All scheduling uses Africa/Johannesburg. New appointment timestamps include `+02:00`; older naive timestamps are interpreted as South African wall-clock time. Conflict checking compares instants, including appointments crossing midnight and timestamps with other offsets. Booking validation and insertion run in an immediate SQLite transaction. The exact requested time is checked; displayed suggestions are in 30-minute steps.

Real booking writes require `incomingMessageId`, stored as a unique tenant-scoped `origin_message_id`. Exact replay returns the original result; changed/cancelled origins cannot create another appointment. `price_at_booking` retains the validated quote. `latestBooking` is authoritative independently of reply delivery or bounded history. `bookingNeedsReview` blocks further booking writes until an interrupted/uncertain committed operation is reviewed. `allowAdditionalBooking` is computed from explicit separate-booking requests after the durable commit; cancellation or negation revokes it. Corrections to an existing booking are directed to the salon, not silently treated as a second booking.

Simulator mode is forced by `dryRun: true`, customer phone `simulator`, or booking source `simulator`. It reads availability but never inserts an appointment, even after confirmation. Its final response explicitly says no appointment was saved.

## Tests and audit findings

61 isolated booking/conversation tests pass on Node 22.23.3, under both UTC and America/Los_Angeles process timezones. They use temporary SQLite databases and no external APIs. Coverage includes the original `Hey it’s Alan` then `Bookings` flow, phone/name retention, explicit confirmation, chosen-time changes, stale summaries, updated price/duration, simulator isolation, invalid/past dates, hours, overlap and cross-midnight checks, separate-process booking contention, delayed midnight processing, premature batched YES, same-second real-message re-prompting and later valid confirmation, and mocked provider failures/unsafe output.

The accompanying backend audit identified original-event-time loss, stale 24-hour free-form reply windows, pre-summary batched confirmations and late delivery receipts leaving stale failed-job indicators. The server implementation includes those corrections, with separate HTTP integration regressions. This note does not claim real Meta delivery, a production deployment, or live provider verification.

## Explicit pilot limits

- One salon-wide appointment capacity at a time. There are no separate staff, chair or resource calendars
- Same-day business hours only; no overnight shifts. Configured service duration must be at most 720 minutes
- Conversation state is reconstructed from bounded recent history. Long or ambiguous conversations may need details repeated
- The chat does not cancel/reschedule existing appointments, send reminders, collect deposits, or send approved WhatsApp templates. Existing appointment changes are directed to the salon
- Only text-message booking is implemented. Voice notes, images and other media are not interpreted
- Free-form WhatsApp replies require the active customer-service window; stale queued work must be quarantined for review rather than processed as a new booking
- The durable worker is a single-process, single-replica pilot design. Do not run overlapping workers, including during deployment. It has no distributed owner/lease recovery protocol
- Interrupted generation or ambiguous send outcomes require owner review. They must not be blindly replayed
