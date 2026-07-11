# PLAN-035: Ticket email notifications — admin alerts + user-opt-in status updates

- **Status:** Backlogged (owner 2026-07-11) — **BLOCKED BY suite-wide SMTP integration (F-04)**
  and by PLAN-034 (the ticket system it notifies about). Deliberately parked "until a lot of
  other work is done but I do not want to lose track" (owner, verbatim).
- **Relates:** PLAN-034 (Helpdesk/Tickets), F-04 SMTP relay (Google Workspace +
  noreply@haynesnetwork.com alias — the enabling plan, still unplanned), PLAN-016-era
  `notification_outbox` (the transactional-outbox pattern email should ride — add an email
  channel next to Pushover, not a second queue).

## Owner intent (2026-07-11)

- **Admin side:** admin@haynesnetwork.com gets an email when a ticket is created — an admin
  knows without visiting the site.
- **User side:** users can OPT IN to email status updates on their tickets (state transitions,
  replies).
- **Beyond tickets:** this is the beachhead for using email more across the app — e.g. trash
  batch notifications gaining an email channel after the integration lands.

## Shape (sketch only — design when unblocked)

`notification_outbox` grows an email delivery channel (same enqueue-in-tx invariant); per-user
email-opt-in preference (profile-level, default OFF); templates themed like the site; sender =
the F-04 relay (1Password + ExternalSecret, ADR-019 posture for creds).

## Open questions (defer until unblocked)

- Q-01: opt-in granularity — per-event-type (created/replied/state-changed) or one switch?
- Q-02: does the trash pipeline gain email in the same release or a follow-up?
- Q-03: digest vs immediate for admins if ticket volume grows?
