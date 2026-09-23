# ADR-090: Import failures notify only through the nightly digest — retire the per-failure outbox row

- **Status:** Accepted (implements the standing owner ruling of PLAN-048 — "NO push per-event (owner
  ruled in-app only for now)", recorded again in DESIGN-030 D-07 and the `NOTIFY_OUTBOX_EVENT_TYPES`
  comment; Accept authority per the plan-loop, `.agents/plans/README.md`)
- **Date:** 2026-09-23
- **Deciders:** Tom Haynes (owner ruling 2026-07-14, PLAN-048) · executed by an autonomous run
  ([issue #556](https://github.com/thaynes43/haynesnetwork/issues/556))
- **Supersedes in part:** [ADR-059](059-activity-in-flight-read-model.md) — the decision-outcome clause
  that `activity-scan` "enqueues one `activity_import_failed` notification-outbox row in the same
  transaction" for each new failure ("first sight of a failure records it and (per row) pages once"),
  the matching decision driver ("a failure transition must enqueue the notification outbox"), and
  consequence **C-03**. Everything else in ADR-059 **stands**: the live poll-through read (Q-01), the
  thin `activity_import_failures` ledger and its durable failure identity, the role-gated actions, the
  `ActivityItem` contract, and C-01/C-02/C-04..C-08 (C-08's "its trail is the failure ledger + outbox
  rows" now reads "the failure ledger").
- **Relates:** [DESIGN-030](../designs/030-activity-in-flight-surfaces.md) D-07a (the design amendment)
  and D-08c (the whole-queue read that makes the scan safe to schedule),
  [ADR-034](034-pushover-batch-notifications.md) / [DESIGN-015](../designs/015-pushover-notifications.md)
  (the outbox + the Pushover renderer), [ADR-060](060-email-notification-channel.md) /
  [DESIGN-031](../designs/031-ticket-email-notifications.md) (the email channel + the nightly failure
  digest), PRD-001 R-194 / R-198, glossary T-100 / T-172.

## Context and problem statement

ADR-059 had the `activity-scan` mode enqueue one `activity_import_failed` outbox row per newly seen
import failure, "for the future admin digest". Verified on 2026-09-23 (issue #556):

1. `evaluateActivityFailures` enqueued the row with no channel, so it took the default, `pushover`. The
   `notify-outbox` drainer (every 13 minutes, Pushover credentials present) delivers every due Pushover
   row, up to 100 per run, whatever its event type.
2. `renderOutboxMessage` had no `activity_import_failed` case. Its `default` branch rendered the Trash
   copy, so each push would have read "Trash batch update — A Trash batch changed state." and linked to
   `/trash?tab=tv`.
3. The digest the row was meant to feed was built another way (the ADR-060 follow-up, 2026-07-15):
   `runFailureDigest` reads the OPEN `activity_import_failures` rows directly. Nothing ever read the
   per-failure rows.

So the per-failure row was a Pushover page the owner had ruled out, labelled as Trash, with no consumer.
`activity-scan` was never scheduled, so none was ever sent. A first run against the live queues on
2026-09-23 (Radarr 10, Sonarr 200 of a 212-item queue, Lidarr 57 `import_blocked`; books 0) would have
sent about 267 of them within about 40 minutes, and re-sent Sonarr's tail every time it flapped (the
single-page queue read, fixed in DESIGN-030 D-08c).

## Decision drivers

- The owner ruling: import failures are in-app only, with no per-event push. The nightly digest (R-198)
  is the notification he ruled in.
- The row has no consumer. The digest reads the ledger, so an outbox row nothing renders or reads is a
  liability, not a record.
- Defence in depth. No event type should be able to reach Pushover dressed as a Trash message.
- No destructive migration for a column or an enum value that simply goes dead.

## Considered options

1. **Drop the enqueue; the ledger is the only record** (chosen).
2. **Keep the row on a channel the drainer never delivers** (a new record-only channel). Rejected: a new
   CHECK value and a migration to store rows nothing reads. The ledger already carries every fact: first
   and last seen, kind, reason, title, and resolution.
3. **Move the row to the `email` channel.** Rejected: that is one email per failure, the same per-event
   notification the ruling forbids on another channel. The digest already reads the ledger.
4. **Give `activity_import_failed` a real Pushover renderer.** Rejected: it contradicts the ruling.

## Decision outcome

Chosen option: **1 — the ledger is the only record, and the nightly digest is the only notification.**

- `evaluateActivityFailures` upserts, re-opens and closes ledger rows in one transaction and enqueues
  nothing. Its report is `{ seen, opened, resolved }`.
- `activity_import_failures.notified_at` is **retired**. Nothing writes or reads it, and every row written
  since is null. The nullable column stays; there is no destructive migration. Production held 0 rows, so
  there is no legacy data to reconcile.
- `activity_import_failed` stays in `NOTIFY_OUTBOX_EVENT_TYPES` only for CHECK parity. No writer enqueues
  it.
- **The Pushover renderer loses its generic fallback.** `renderOutboxMessage` returns `null` for every
  event type without an explicit Pushover case: the retired type, the email-only types, and any type this
  build does not know. A compile-time exhaustiveness check makes a new event type fail typecheck until
  its Pushover rendering is decided. The drainer never sends a null-rendered row. It fails it through the
  ordinary path (attempts, `last_error`, backoff, parked at 5 — the channel-agnostic DESIGN-031 D-04 path
  unrenderable email rows already take) under its own warn line,
  `notify-outbox: unrenderable row — not delivered`.
- **The first run is not special-cased.** With no push there is nothing to baseline. The first run records
  the backlog silently, and the next nightly digest lists it.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: scheduling `activity-scan` sends no push. The first run records the backlog (about 270 rows at the 2026-09-23 count), and the next nightly digest reports it as "N stuck imports need attention", with the oldest 20 listed. |
| C-02 | Good: the ledger is the one source of truth for failure notification. The digest cannot miss or invent a failure, because it reads the ledger the scan reconciles. That was ADR-059 C-03's intent, now met without an outbox row. |
| C-03 | Good: no event type can reach Pushover as a Trash message, and a new event type forces its Pushover decision at compile time. |
| C-04 | Bad/accepted: between two digests a new failure is visible only in-app (the Activity **Failed** chip and the failure detail page) until the next nightly digest. That is the owner's ruling. |
| C-05 | Neutral: `notified_at` and the `activity_import_failed` enum value are dead weight, kept to avoid a destructive migration. A later cleanup migration may drop both together. |
| C-06 | Neutral: an unrenderable row retries on backoff before it parks, instead of parking on first sight. A row written by a newer build than the drainer that first sees it still delivers once the newer image drains it. |

## More information

- Issue [#556](https://github.com/thaynes43/haynesnetwork/issues/556) — the finding, the live counts,
  and the remaining step: the `sync-activity-scan` CronJob in haynes-ops, added after this ships in a
  release. PLAN-048 (`.agents/plans/completed/048-activity-in-flight.md`) records what to expect when it
  is scheduled.
- DESIGN-030 D-07a / D-08c, DESIGN-015 D-09 (the renderer and drainer change), the PRD-001 R-194 note,
  glossary T-100 / T-172.
