# DESIGN-031: Ticket email notifications — admin alerts + user-opt-in status updates

- **Status:** Draft
- **Last updated:** 2026-07-15
- **Satisfies:** PRD-001 R-195, R-196, R-197; governed by ADR-060 (email channel), ADR-019 (creds),
  PLAN-016 outbox invariants; extends PLAN-034 tickets.

## Overview

The `notification_outbox` grows an **`email` channel** (ADR-060). Three ticket moments enqueue email
rows in the same transaction as the mutation: **create** → the admin mailbox (always), **reply** and
**state transition** → the ticket AUTHOR, only when the author has opted in and is not the actor.
The `notify-outbox` drainer routes rows to per-channel senders; email delivers over nodemailer SMTP
submission using the F-04 `SMTP_*` env contract. A profile-level toggle (default OFF) is the whole
opt-in surface.

## Detailed design

### D-01 — Schema (migration 0049)

- `NOTIFY_OUTBOX_CHANNELS = ['pushover', 'email']` (enums.ts) + rebuilt
  `notification_outbox_channel_enum` CHECK.
- New event types: `ticket_replied`, `ticket_status_changed` (CHECK rebuilt). `ticket_created`
  is reused for BOTH channels (admin email + the existing owner Pushover) — the channel column
  disambiguates.
- New table `notification_preferences` (the `library_preferences` idiom): `id` uuid PK,
  `user_id` uuid → users ON DELETE cascade **unique**, `email_ticket_updates` boolean notNull
  default false, `created_at`/`updated_at`. No audit (descriptive per-user state — hard rule 6
  exempt, the library-preferences precedent). Added to the `no-direct-state-writes` guard list;
  single-writer `setNotificationPreference`.

### D-02 — Enqueue points (`packages/domain/src/tickets.ts`, all same-tx)

- `createTicket`: alongside the existing Pushover row, enqueue
  `{ channel:'email', eventType:'ticket_created', payload:{ to: TICKET_ADMIN_EMAIL, ticketId,
  title, category, authorName, mediaTitle } }`. Admin recipient from env
  `TICKET_ADMIN_EMAIL` (default `admin@haynesnetwork.com`); resolved by the caller-facing helper,
  not read inside the tx.
- `addTicketReply`: after the reply insert, look up the ticket author's `users.email` +
  `notification_preferences.email_ticket_updates` in the SAME tx; if opted in **and
  `authorId !== reply.authorId`**, enqueue `{ channel:'email', eventType:'ticket_replied',
  payload:{ to, ticketId, title, replyAuthorName, snippet } }` (snippet = first 200 chars).
- `transitionTicket`: same author-opt-in gate (skip when the author is the actor); enqueue
  `{ channel:'email', eventType:'ticket_status_changed', payload:{ to, ticketId, title,
  fromStatus, toStatus, actorName, note } }`.
- Quiet hours apply unchanged: `earliestSendAt` computed by the caller before the tx
  (`getNotifyWindow`/`computeEarliestSend`) — an emailed reply respects the same window as a
  Pushover ping. (D-14 alternative — bypassing the window for email — rejected: one invariant.)

### D-03 — Rendering (`packages/domain/src/notify-outbox.ts`)

`renderOutboxEmail(row, tz): { subject, text } | null` — a sibling of `renderOutboxMessage`,
switching on `eventType` for the three ticket events (null for event types email doesn't render —
such a row is a bug, parked via error, never silently sent empty). Plain-text bodies (no HTML
templating layer exists; matching the Pushover idiom), each ending with the canonical deep link
`https://haynesnetwork.com/bulletin/ticket/<id>`. Subjects: `[haynesnetwork] New ticket: <title>` /
`Re: <title>` / `<title> → <status label>`.

### D-04 — Delivery routing (`deliverOutbox`)

`input.sender: OutboxSender` becomes `input.senders?: Partial<Record<NotifyOutboxChannel,
OutboxSender>>` (the old singular arg kept as a deprecated alias for the pushover channel in tests).
Production default builds `{ pushover: pushoverSenderFromEnv(), email: smtpSenderFromEnv() }`.
Per-channel disabled-safe: rows whose channel has a `null`/absent sender are **not selected** (WHERE
channel IN (...available)), so they neither fail nor burn attempts — they wait for credentials, and
`report.skippedChannels` names what was excluded. Retry/backoff/parking semantics are unchanged and
channel-agnostic.

### D-05 — SMTP sender (`smtpSenderFromEnv`)

nodemailer transport `{ host: SMTP_HOST, port: SMTP_PORT (587), secure: false (STARTTLS), auth:
{ user: SMTP_USER, pass: SMTP_PASS } }`; `from: SMTP_FROM`. Returns `null` unless ALL five are set.
The sender maps `OutboxEmail` → `transporter.sendMail({ from, to: payload.to, subject, text })`;
a rejected promise is the drainer's normal failure path (attempts+backoff). nodemailer is a new
dependency of `packages/domain` only.

### D-06 — API (`packages/api`)

`profile.notificationPreference` (query) + `profile.setNotificationPreference` (mutation,
`{ emailTicketUpdates: boolean }`) on the existing authed profile/user router — no section gate
(it's the caller's own preference; mirrors library-preferences exposure).

### D-07 — UI

One toggle row — "Email me when my tickets get replies or status changes" — on the avatar-menu
profile/settings surface, using the existing token-themed switch idiom. Default OFF. Reflow-free
(ADR-015): the toggle changes color only. No admin UI: the admin alert is unconditional (R-195).

### D-08 — e2e stub

Per the per-plan loop rule ("an e2e stub for any new external system"): a minimal `stub-smtp`
(node:net, single-connection SMTP: 220 greeting → EHLO/MAIL/RCPT/DATA/QUIT, records messages,
`/`-style recorder via an exported `messages()` accessor) wired into the hermetic stack env as
`SMTP_HOST=127.0.0.1:<port>`. e2e journey: opt in via the profile toggle → reply as admin to the
member's ticket → run the drainer → assert one recorded message to the member. `e2e` stays advisory.

## Alternatives considered

- Separate email queue/table — rejected (ADR-060, duplicate invariants).
- Recipient resolved at delivery time — rejected: delivery-time DB reads widen the drainer's
  failure surface; enqueue-time is transactionally consistent with the event (ADR-060 C-02).
- HTML/MJML templates — deferred; plain text matches the existing renderer idiom and the
  household audience. Revisit if email grows beyond tickets (ADR-060 C-07).

## Test strategy

- **Domain**: create/reply/transition enqueue shapes (channel/eventType/payload.to); the opt-in
  gate (OFF → no row; ON + self-action → no row; ON + other actor → row); same-tx atomicity
  (mutation rollback leaves no orphan row — the existing outbox test idiom); renderer snapshots
  for the three events; `deliverOutbox` channel routing (email-only creds ⇒ pushover rows
  untouched + `skippedChannels`), unchanged retry/parking.
- **API**: pref get/set roundtrip + auth gate.
- **e2e**: the D-08 journey (advisory).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Opt-in granularity — per-event-type or one switch? | **DEFAULTED 2026-07-15 (owner may veto): one switch** (`email_ticket_updates`); schema leaves room for sibling columns. |
| Q-02 | Trash pipeline email in the same release? | **DEFAULTED: follow-up release** (ADR-060 C-07 beachhead). |
| Q-03 | Admin digest vs immediate? | **DEFAULTED: immediate** — household ticket volume; the PLAN-048 nightly digest remains the separate digest surface. |
