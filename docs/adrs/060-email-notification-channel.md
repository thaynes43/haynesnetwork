# ADR-060: Email notification channel rides the transactional outbox (SMTP submission via Google Workspace)

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Tom Haynes (owner intent 2026-07-11, PLAN-035; SMTP credentials landed 2026-07-15 — F-04)

## Context and problem statement

PLAN-034 shipped the Helpdesk/Tickets vertical; the only notification it emits is a Pushover ping to
the owner on `ticket_created`. The owner wants (a) an email to the admin mailbox when a ticket is
created — an admin knows without visiting the site — and (b) users able to OPT IN to email updates on
their own tickets (replies, state changes). F-04 (Google Workspace SMTP relay +
`noreply@haynesnetwork.com` alias) was the blocker; its credentials now live in the 1Password `smtp`
item and are synced into `haynesnetwork-secret` (haynes-ops #2063). How should email delivery enter
the architecture?

## Decision drivers

- **One queue, one invariant.** PLAN-016's `notification_outbox` already guarantees
  enqueue-in-the-same-transaction, quiet-hours as row data, bounded retries with parking, and
  disabled-safe skipping. A second email queue would duplicate all of that.
- **Recipient correctness over recipient freshness.** The recipient must be derivable when the row is
  rendered — but user emails can change between enqueue and delivery. Simplicity wins at this scale.
- **Disabled-safe by construction** (the ADR-019 posture): missing SMTP credentials must degrade to
  "email rows wait", never crash the drainer or park rows spuriously.
- Household scale: minutes-later delivery via the existing `notify-outbox` CronJob cadence is fine;
  no synchronous send on the request path.

## Considered options

1. **Grow `notification_outbox` with an `email` channel** — new channel enum value; rows carry the
   resolved recipient in `payload`; the drainer routes rows to per-channel senders.
2. A separate `email_outbox` table + its own drainer.
3. Synchronous send inside the ticket mutation (no queue).

## Decision outcome

Chosen option: **1 — grow the outbox**, because it inherits every hard-won delivery property for free
and keeps a single audit trail of everything the app ever sent.

- **C-01** `NOTIFY_OUTBOX_CHANNELS` gains `'email'` (CHECK-constraint migration). The `channel`
  column (defaulted `'pushover'` since PLAN-016) becomes load-bearing for the first time.
- **C-02** **Recipients are resolved at ENQUEUE time, inside the same transaction** as the domain
  mutation (the user's email is one join away on every ticket path), and stored in
  `payload.to`. A later email change does not retarget queued rows — accepted at this scale.
- **C-03** Transport is **nodemailer** SMTP submission using the `SMTP_HOST/PORT/USER/PASS/FROM` env
  contract (the F-04 ExternalSecret). `smtpSenderFromEnv()` returns `null` when any var is absent —
  the drainer's existing disabled path, now **per channel**: a missing sender skips THAT channel's
  rows and never counts an attempt.
- **C-04** The admin recipient is env-configured: `TICKET_ADMIN_EMAIL`, default
  `admin@haynesnetwork.com` (owner intent verbatim).
- **C-05** Per-user opt-in lives in a new `notification_preferences` table (one row per user,
  `email_ticket_updates` default **false**), written by a dedicated single-writer with **no audit
  row** — descriptive per-user state, the `library_preferences` precedent (hard rule 6 exempt).
- **C-06** Bad: email bodies are rendered at delivery time from `payload` snapshots — a ticket
  renamed after enqueue is emailed under its old title. Accepted (same is true of Pushover today).
- **C-07** This is the beachhead (owner): trash-batch / digest emails later become "another
  `enqueueOutbox(channel: 'email')` call site", no new machinery. Explicitly OUT of this release.

## More information

PRD R-195..R-197 (this change). DESIGN-031 (the vertical). PLAN-035. ADR-019 (creds posture),
PLAN-016 outbox (`docs/designs/` D-16 era), OPS-004 §5 (1Password secret contract). Owner defaults
recorded 2026-07-15: single opt-in switch (Q-01), trash follow-up (Q-02), admin immediate (Q-03).
