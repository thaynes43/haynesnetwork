# PLAN-035: Ticket email notifications — admin alerts + user-opt-in status updates

- **Status:** Completed — shipped v0.58.0 (2026-07-15, #292; ADR-060 / DESIGN-031 / migration 0049).
  F-04 unblocked same morning (owner's 1P `smtp` item + haynes-ops #2063). LIVE-VALIDATED on prod:
  a real validation ticket delivered the admin email over the Google relay (`sent:2, failed:0`;
  ticket 5c94e8e1 — "safe to close"). Owner defaults recorded (DESIGN-031 Q-01..Q-03): one opt-in
  switch / trash email follow-up / admin immediate. Admin recipient = admin@haynesnetwork.com
  (owner-confirmed the only deliverable mailbox). Was: Backlogged (owner 2026-07-11), blocked by
  F-04 + PLAN-034.
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
