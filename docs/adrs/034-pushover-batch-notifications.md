# ADR-034: Pushover notifications for the Trash batch lifecycle (outbox + delivery window)

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Tom Haynes

## Context and problem statement

The owner runs the Trash curation pipeline (ADR-025) mostly from his phone. A batch is
worth acting on at two moments: **when it is posted** (there is a fresh candidate set to
review/curate) and **as its Leaving-Soon window closes** (last chance to rescue items before
the sweep deletes them). Today those moments are only visible if he opens the app. He asked
(2026-07-08, verbatim intent):

> "integrate pushover so I get a notification when a new batch is posted and the day it will
> leave — with a configurable time range the notification can be sent, like 6PM-10PM when I am
> home and can spend time saving items."

Two forces shape the design:

1. **Reliability without a resident process.** The app's write paths (manual batch create,
   admin green-light, and the space-policy proposer — ADR-031) run in request handlers and in
   short-lived sync CronJobs. There is no always-on worker to "fire a notification later at
   6 PM". A fire-and-forget `fetch` from the mutation would also couple a durable state change
   (the batch transition) to a flaky third-party HTTP call.
2. **Quiet hours.** The owner only wants to be pinged inside a window he can act in, in his own
   timezone — and the "day it leaves" reminder must land the day _before_ expiry so saves still
   matter.

## Decision drivers

- Same-transaction durability: a notification for "batch created" must be enqueued in the SAME
  transaction as the batch transition (no lost or phantom pings), mirroring the audit/ledger
  single-writer discipline (CLAUDE.md hard rule 6).
- No new always-on service; reuse the existing sync CronJob pattern (ADR-025 sweep / ADR-031
  space-policy) for delivery.
- Disabled-safe: the feature must ship and the build must be green even if the Pushover
  credentials are not yet in the cluster — no env ⇒ a clean no-op, never a crash.
- Owner-configurable delivery window (start/end hour + timezone), audited like every other
  app setting (ADR-025 C-06).

## Considered options

1. **Fire-and-forget `fetch` from the mutation.** Rejected: couples a durable transition to a
   third-party HTTP call; a Pushover blip would either fail the user's action or silently drop
   the ping; and it cannot defer to a delivery window without a resident timer.
2. **A resident notification worker (long-running Deployment with an internal scheduler).**
   Rejected: a whole new always-on service + its own liveness/rollout surface for what is a
   handful of messages per batch cycle. The estate already runs everything batch-adjacent as
   short CronJobs.
3. **Transactional outbox + a periodic drainer CronJob (chosen).** Writers enqueue a row into
   a `notification_outbox` table in the SAME transaction as the state change; a 15-minute
   `notify-outbox` sync mode reads _due_ rows and delivers them to Pushover, marking each sent
   (or backing it off on failure). The delivery window is applied at ENQUEUE time by computing
   each row's `earliest_send_at`.

## Decision outcome

Chosen option: **transactional outbox + periodic drainer**, because it gives same-transaction
durability, needs no new resident process (reuses the CronJob pattern), degrades cleanly to a
no-op without credentials, and expresses "quiet hours" as data (`earliest_send_at`) rather than
as a timer.

- **Outbox table `notification_outbox`** (migration 0024): `id`, `channel` (`'pushover'`),
  `event_type`, `payload` jsonb, `created_at`, `earliest_send_at`, `sent_at` (nullable),
  `attempts`, `last_error`. It joins the guarded single-writer tables (no direct writes outside
  `@hnet/domain`).
- **Enqueue, same-tx, from the batch writers** (`@hnet/domain/trash-batches.ts`):
  - `batch_created` on `createBatchFromPending` (manual AND space-policy-proposed — the space
    policy calls the same writer, so it inherits the ping for free).
  - `batch_leaving_soon` on the `→ leaving_soon` promotion (`promoteToLeavingSoon`, covering
    both the admin green-light and the audited skip-gate), carrying the deadline date; PLUS a
    second `batch_leaving_soon_reminder` row targeted at the day BEFORE expiry.
  - `batch_swept` on the expiry-sweep close (summary; nice-to-have, same-tx).
- **Delivery window** = app setting `notify_window` (jsonb `{ startHour, endHour, tz }`, default
  `{18, 22, 'America/New_York'}`), admin-editable + audited via the `setAppSetting`
  single-writer, on a small "Notifications" card on `/admin/storage` (next to the Space-policy
  card — both are owner-facing batch-lifecycle controls). Enqueue computes `earliest_send_at`:
  inside the window ⇒ now (ASAP); outside ⇒ the next window-open in `tz`. The `→ leaving_soon`
  reminder targets window-open on `expiry_date − 1 day`.
- **Sender** = new `notify-outbox` `@hnet/sync` mode: reads rows with `sent_at IS NULL AND
attempts < 5 AND earliest_send_at <= now`, POSTs to `https://api.pushover.net/1/messages.json`
  (`token`/`user` from env, title/message + a deep-link `url` to
  `https://haynesnetwork.com/trash?tab=<movies|tv>`), sets `sent_at` on success, or increments
  `attempts` + records `last_error` + pushes `earliest_send_at` out on a backoff (parked after
  5 tries). **No env ⇒ the sender no-ops with a clear log and leaves the rows queued.**
- **Env contract:** `PUSHOVER_APP_TOKEN` + `PUSHOVER_USER_KEY`. Credentials already exist in the
  `HaynesKube` 1Password item **`media-stack`** (fields `HAYNESNETWORK_PUSHOVER_TOKEN` /
  `HAYNESNETWORK_PUSHOVER_USER_KEY`), which the app's ExternalSecret already pulls via
  `dataFrom: extract media-stack` — so the deploy adds two template lines, no new remoteRef.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Good: the "batch created" / "leaving soon" pings are durable — enqueued in the SAME tx as the transition, so they can neither be lost (mutation committed, ping dropped) nor phantom (ping sent, mutation rolled back).                                                                                                         |
| C-02 | Good: no new resident service. Delivery is a 15-min CronJob mirroring the sweep/space-policy jobs; it writes NO `sync_runs` row (like those two) — its trail is the outbox rows themselves.                                                                                                                                     |
| C-03 | Good: disabled-safe. Missing `PUSHOVER_*` ⇒ the sender logs and no-ops; the whole vertical builds and passes gate with zero credentials. Enqueue always runs (the outbox fills regardless), so turning creds on later delivers the backlog of still-due rows.                                                                   |
| C-04 | Good: quiet hours are DATA, not a timer — `earliest_send_at` is computed once at enqueue against the owner's `tz`. The sender is a dumb "send what's due" drainer.                                                                                                                                                              |
| C-05 | Bad/accepted: delivery is **at-least-once**. A crash between a successful POST and the `sent_at` write re-sends on the next run. Acceptable for a notification; single job + `concurrencyPolicy: Forbid` keeps it single-sender.                                                                                                |
| C-06 | Bad/accepted: the window is enforced at enqueue, not at send. A row whose `earliest_send_at` fell in the past (e.g. a reminder for a batch with a sub-1-day window) is delivered on the next drainer run rather than being dropped; enqueue clamps such reminders forward to the next window-open so they still land in-window. |
| C-07 | Bad/accepted: if credentials are never supplied, the outbox grows unboundedly. Bounded in practice (a few rows per batch cycle) and moot now that creds exist; a future prune of old `sent_at`-set rows is noted, not built.                                                                                                    |
| C-08 | Neutral: `notify-outbox` joins `SYNC_RUN_KINDS` and `notify_window` joins `APP_SETTING_KEYS`; migration 0024 relaxes both CHECKs (parity pattern from 0019–0022) and creates the outbox table.                                                                                                                                  |

## More information

- Requirements: PRD-001 **R-115** (Pushover batch-lifecycle notifications) and **R-116**
  (configurable delivery window).
- Design: **DESIGN-015** (schema, window math, sender, CronJob, the settings card).
- Glossary: **T-100** Notification Outbox, **T-101** Delivery Window.
- Sibling ADRs: ADR-025 (curation pipeline / sweep), ADR-031 (space policy — the propose path
  that reuses `createBatchFromPending` and so inherits the `batch_created` ping), ADR-026
  (the in-app `notifications` feed — a DISTINCT store: that is the inbound/in-app feed, this is
  the outbound push queue).
