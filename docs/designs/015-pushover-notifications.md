# DESIGN-015: Pushover notifications for the Trash batch lifecycle

- **Status:** Accepted
- **Last updated:** 2026-07-08
- **Satisfies:** PRD-001 R-115, R-116; governed by ADR-034 (and ADR-025 pipeline / ADR-031 space
  policy for the enqueue sites). Glossary T-100 (Notification Outbox), T-101 (Delivery Window).

## Overview

A **transactional outbox** decouples the durable batch-state change from the flaky third-party
push. Batch writers enqueue a row in the SAME transaction as the transition; a periodic
`notify-outbox` sync job drains due rows to Pushover. "Quiet hours" are expressed as each row's
`earliest_send_at`, computed once at enqueue against the owner's configured window/timezone.

Lifecycle → notification map:

| Moment                                        | Enqueue site (`@hnet/domain/trash-batches.ts`) | `event_type`                  | `earliest_send_at`                 |
| --------------------------------------------- | ---------------------------------------------- | ----------------------------- | ---------------------------------- |
| Batch posted (manual + policy-proposed)       | `createBatchFromPending` tx                    | `batch_created`               | next in-window instant             |
| Green-lit → Leaving Soon (admin or skip-gate) | `promoteToLeavingSoon` tx                      | `batch_leaving_soon`          | next in-window instant             |
| — day before it leaves                        | same tx (second row)                           | `batch_leaving_soon_reminder` | window-open on `expiresAt − 1 day` |
| Sweep closed the batch                        | `expireOneBatch` close tx                      | `batch_swept`                 | next in-window instant             |

## Detailed design

### D-01 — `notification_outbox` schema (migration 0024)

```
notification_outbox (
  id                uuid   PK default gen_random_uuid(),
  channel           text   NOT NULL default 'pushover'  CHECK (channel = ANY (NOTIFY_OUTBOX_CHANNELS)),
  event_type        text   NOT NULL                     CHECK (event_type = ANY (NOTIFY_OUTBOX_EVENT_TYPES)),
  payload           jsonb  NOT NULL default '{}',
  created_at        timestamptz NOT NULL default now(),
  earliest_send_at  timestamptz NOT NULL default now(),
  sent_at           timestamptz,           -- null = undelivered
  attempts          integer NOT NULL default 0,
  last_error        text
)
-- Drainer scan: the due, not-yet-sent, not-parked rows, oldest first.
CREATE INDEX notification_outbox_due_idx
  ON notification_outbox (earliest_send_at) WHERE sent_at IS NULL;
```

`NOTIFY_OUTBOX_CHANNELS = ['pushover']`; `NOTIFY_OUTBOX_EVENT_TYPES = ['batch_created',
'batch_leaving_soon', 'batch_leaving_soon_reminder', 'batch_swept']` — text+CHECK, the const
arrays in `enums.ts` are the single source of truth (DESIGN-001 D-02). The table joins the
guarded set (single-writer only; `no-direct-state-writes` guard grows `notification_outbox` /
`notificationOutbox`). Migration 0024 also CHECK-relaxes `app_settings.key` (+ `notify_window`)
and `sync_runs.run_kind` (+ `notify-outbox`), mirroring the 0019–0022 rebuild pattern.

### D-02 — `notify_window` app setting

```ts
interface NotifyWindow {
  startHour: number;
  endHour: number;
  tz: string;
}
NOTIFY_WINDOW_DEFAULT = { startHour: 18, endHour: 22, tz: 'America/New_York' };
```

Stored under `app_settings['notify_window']`; read via `getNotifyWindow(db)` (defaults merged +
typeof-guarded, fail-safe to the default like `getSpacePolicy`); written by the audited
`setAppSetting` single-writer (`update_app_setting` permission_audit row same-tx). Bounds
(zod edge, `storage.notify.window.set`): `0 ≤ startHour < endHour ≤ 24`; `tz` is a non-empty
IANA name validated by attempting an `Intl.DateTimeFormat`. Overnight windows (`start ≥ end`)
are out of scope (rejected at the edge).

### D-03 — window math (`packages/domain/src/notify-window.ts`)

Timezone-correct without a dependency, via `Intl.DateTimeFormat` offset probing:

- `computeEarliestSend(now, window)`: if `now`'s wall-clock hour in `tz` is in
  `[startHour, endHour)` ⇒ `now` (send ASAP); if before `startHour` ⇒ today at `startHour` in
  `tz`; if at/after `endHour` ⇒ tomorrow at `startHour` in `tz`.
- `computeReminderSend(expiresAt, window, now)`: window-open (`startHour` in `tz`) on the
  `tz`-calendar date of `expiresAt` minus one day (**the day before it leaves** — the owner's
  "day it will leave", chosen so saves still matter). If that instant is `≤ now` (a window
  shorter than ~1 day), clamp to `computeEarliestSend(now, window)` so the reminder still lands
  in-window rather than being lost.
- Helper `zonedHourToUtc(tz, y, mo, d, hour)` converts a wall-clock hour in `tz` to a UTC
  `Date` by probing the zone offset at the target instant (double-pass for DST safety). Notify
  windows (evening hours) sit far from DST transitions, so this is robust.

### D-04 — enqueue (same-tx, from the batch writers)

A pure insert helper `enqueueOutbox(tx, { eventType, channel?, payload, earliestSendAt })`
inserts one row on the passed transaction (no settings read inside the tx). Each writer reads
the window and computes `earliest_send_at` **before** opening its transaction (a stale-by-
seconds window read is harmless), then enqueues INSIDE the same tx as `writeTransitionEvent`:

- `createBatchFromPending` → after the `draft|admin_review` transition event: one
  `batch_created` row `{ batchId, mediaKind, itemCount, totalBytes, source: 'manual'|'policy' }`.
  (The skip-gate path then also green-lights via `promoteToLeavingSoon`, which enqueues its own
  `batch_leaving_soon` — so a skip-gate batch legitimately pings twice: "created" then
  "leaving soon".)
- `promoteToLeavingSoon` → after the `→ leaving_soon` transition event: a `batch_leaving_soon`
  row (`earliest_send_at` = next in-window) AND a `batch_leaving_soon_reminder` row
  (`earliest_send_at` = day-before-expiry window-open), both carrying
  `{ batchId, mediaKind, pendingCount, pendingBytes, expiresAt }`.
- `expireOneBatch` close tx → a `batch_swept` row `{ batchId, mediaKind, deletedCount,
reclaimedBytes }`. Not enqueued on a circuit-breaker abort (the batch stays `leaving_soon`).

Enqueue is best-effort-wrapped only where the transition itself is already committed elsewhere;
where it shares the transition's tx it rides that tx's atomicity (ADR-034 C-01).

### D-05 — sender / `notify-outbox` sync mode

`deliverOutbox({ db, now?, sender?, limit?, logger? })`:

1. Resolve the sender: `sender ?? pushoverSenderFromEnv()`. `pushoverSenderFromEnv()` returns
   `null` when `PUSHOVER_APP_TOKEN` or `PUSHOVER_USER_KEY` is absent.
2. Select due rows: `sent_at IS NULL AND attempts < MAX_ATTEMPTS(5) AND earliest_send_at <= now`,
   oldest-first, `LIMIT` (default 100).
3. If the sender is `null` ⇒ log `pushover credentials absent — N rows left queued` and return
   `{ skipped: true, dueCount: N, sent: 0, failed: 0 }` **without touching any row** (attempts
   are NOT burned on a config-absent skip).
4. Per row: render `{ title, message, url, urlTitle }` from `event_type` + `payload`
   (`renderOutboxMessage`), `await sender(...)`. On success ⇒ `sent_at = now`. On throw ⇒
   `attempts += 1`, `last_error = message`, `earliest_send_at = now + backoff(attempts)`
   (`[15m, 1h, 4h, 12h]`); at `attempts = 5` the row is parked (excluded by the due filter).
5. Return `{ sent, failed, skipped:false, parked, dueCount }`.

`renderOutboxMessage` (owner-voiced copy):

| event_type                    | title                                | message                                                                          |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `batch_created`               | `New {Movies\|TV} batch`             | `{n} items, {bytes} — review it`                                                 |
| `batch_leaving_soon`          | `{Movies\|TV} batch is Leaving Soon` | `Leaves {date} — {n} items still slated; save window open until then`            |
| `batch_leaving_soon_reminder` | `{Movies\|TV} batch leaves {date}`   | `Last chance — {n} items still slated. Save the ones you want before it sweeps.` |
| `batch_swept`                 | `{Movies\|TV} batch swept`           | `Deleted {n} items, freed {bytes}.`                                              |

`url = https://haynesnetwork.com/trash?tab=${mediaKind === 'movie' ? 'movies' : 'tv'}`,
`urlTitle = 'Open Trash'`. `postPushover` POSTs form fields `token/user/title/message/url/
url_title` to `https://api.pushover.net/1/messages.json` (injectable `fetchImpl` for tests;
non-2xx throws with the response body).

The orchestrator adds an early-return `notify-outbox` branch (like `trash-batch-sweep` /
`space-policy`): no `--source`, no `sync_runs` row, returns an `outbox` report; the CLI `--mode`
help + parser accept it via `SYNC_RUN_KINDS`.

### D-06 — settings card (`/admin/storage` "Notifications")

A small admin-only card (mirrors the Space-policy card ceremony): number inputs for start/end
hour + a timezone select (a short IANA list incl. the default), a Save button, reflow-free
status text (ADR-015). Reads `storage.notify.window.get`; writes `storage.notify.window.set`
(the whole `NotifyWindow` object, like `targets.set`). Pure helpers in
`apps/web/lib/notify-window.ts` (validation + the human "6 PM – 10 PM ET" summary), unit-tested.

### D-07 — deploy (haynes-ops, owner-applied)

- ExternalSecret: two template lines under the existing `dataFrom: extract media-stack`
  (no new remoteRef) — `PUSHOVER_APP_TOKEN: "{{ .HAYNESNETWORK_PUSHOVER_TOKEN }}"` and
  `PUSHOVER_USER_KEY: "{{ .HAYNESNETWORK_PUSHOVER_USER_KEY }}"`.
- A `sync-notify-outbox` CronJob every 15 min (`*/13 * * * *` to stagger off the other jobs),
  `--mode=notify-outbox`, **suspend: false** (it is a safe no-op without creds, and creds are
  present). Mirrors the sweep block; the owner deploys it.

### D-08 — Amendment 2026-07-09 (owner-directed) — the configurable FINAL-WARNING ping

A fifth outbox event, `batch_final_warning` (migration 0030 relaxes the `event_type` CHECK), and a
sixth app-setting key, `final_warning` (same migration relaxes the `app_settings.key` CHECK). It is a
**configurable last-call** — distinct from the day-before `batch_leaving_soon_reminder` — that fires a
tunable N hours before the save window closes, right ahead of the sweep.

- **Setting** `final_warning` — jsonb `{ enabled: boolean, hoursBefore: number }`, **DEFAULT
  `{ enabled: true, hoursBefore: 2 }`**. Read fail-safe by `getFinalWarning` (typeof-guarded exactly like
  `getPoolRefreshAfterSave`: a non-boolean `enabled` reads ON; a non-finite / out-of-range `hoursBefore`
  clamps to `[FINAL_WARNING_HOURS_MIN=1, FINAL_WARNING_HOURS_MAX=168]` around the 2-hour default). Written
  through the same audited `setAppSetting` single-writer; surfaced in the General Trash-settings
  "Notifications" area, inside the one consolidated single-Save form (no separate Save) via
  `trash.settings.set { finalWarning }`.
- **Enqueue** — in `promoteToLeavingSoon` (green-light), alongside the existing `batch_leaving_soon` +
  `_reminder` rows. `N` (`hoursBefore`) is **read at green-light** and frozen into the row's
  `earliest_send_at = expires_at − N hours` (a later setting change never moves already-enqueued rows).
  The row is **skipped** when (a) the setting is disabled, or (b) `expires_at − N ≤ now` — i.e. the
  window is shorter than N hours (equivalently `windowDays·24 ≤ N`). Unlike the other events it is
  **NOT** passed through the delivery window (`computeEarliestSend`): a last call is deadline-relative,
  not quiet-hours-shiftable — it must land before the sweep, never after.
- **Copy** (`renderOutboxMessage`) — title `"Last call — <Kind> batch"`, message
  `"Last call: the <Kind> batch closes at <time> — N items still slated. Save anything you want to keep."`
  where `<time>` is the close time in the owner's tz and `N` is `pendingCount`; the deep link is the
  same per-kind `?tab=movies|tv`. Reuses the green-light `leavingPayload` (`{ batchId, mediaKind,
  pendingCount, pendingBytes, expiresAt }`).

## Alternatives considered

- **Reuse the `notifications` table (ADR-026) as the queue.** Rejected: that store is the
  inbound in-app FEED (webhook events, dedupe on source event id, read by the Activity tab). An
  outbound push queue has different columns (`earliest_send_at`, `attempts`, `last_error`,
  `sent_at`) and lifecycle; conflating them would muddy both. A separate small table is cleaner.
- **Enforce the window at send time** (drainer skips rows when `now` is outside the window).
  Rejected as the primary mechanism: it makes "created inside the window ⇒ ASAP" awkward and
  couples the window to the drainer cadence. Applying it at enqueue keeps the drainer a dumb
  "send what's due". (A row whose computed time slips into the past is a rare edge — C-06.)

## Test strategy

- **Window math** (pure, no DB): inside/before/after window; `America/New_York` offset;
  day-before-expiry reminder; sub-1-day-window clamp.
- **Enqueue same-tx**: `createBatchFromPending` writes a `batch_created` row; green-light writes
  `batch_leaving_soon` + `_reminder`; the space-policy proposer inherits `batch_created`; a
  rolled-back transition writes NO outbox row.
- **Sender**: due-row selection; marks `sent_at` on success (fetch stubbed); backoff +
  `last_error` + park-after-5 on failure; **no-creds ⇒ no-op, rows untouched**; deep-link URL +
  rendered copy per `event_type`.
- **Settings gating**: `setAppSetting('notify_window')` writes an `update_app_setting` audit row;
  `getNotifyWindow` merges defaults / fails safe on a garbage row.
- **Migration**: `notification_outbox` exists with the due index; the two CHECK relaxes admit the
  new values and preserve the prior ones. **0030 (D-08)**: the `event_type` CHECK admits
  `batch_final_warning` and the `app_settings.key` CHECK admits `final_warning`, both preserving the
  prior values.
- **Final-warning (D-08)**: green-light enqueues `batch_final_warning` at `expires_at − N h`; the row is
  skipped when the window is shorter than N / the setting is off; `final_warning` round-trips with an
  audit row and fails safe on a garbage value; the last-call copy renders the close time.
- **e2e (light)**: the Notifications card (delivery window + the Last-call warning row) renders on the
  General Trash-settings tab and a Save round-trips.

## Open questions

| ID   | Question                                       | Resolution                                                                         |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Q-01 | Per-event opt-out (e.g. mute `batch_swept`)?   | Deferred — ship all four; the window is the only knob for v1.                      |
| Q-02 | Prune delivered (`sent_at`-set) rows?          | Deferred (ADR-034 C-07) — bounded volume; a later housekeeping pass if it matters. |
| Q-03 | Overnight windows (`start ≥ end`, e.g. 22–02)? | Out of scope — rejected at the zod edge; revisit only if the owner asks.           |
