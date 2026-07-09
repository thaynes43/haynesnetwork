# PLAN-016: Pushover notifications for the Trash batch lifecycle (outbox + delivery window)

- **Status:** In progress (2026-07-08) — owner-directed. Docs-first per CLAUDE.md.
- **Satisfies:** new **ADR-034**, **DESIGN-015**; PRD-001 new **R-115/R-116**; glossary
  **T-100/T-101**; migration **0024**. New `notify-outbox` sync kind + `notify_window` app
  setting + `notification_outbox` table (all CHECK-relaxed / created in 0024). Numbers verified
  next-free at authoring (ceilings on `main` @ v0.21.0: ADR-033, DESIGN-014, migration 0023,
  PRD R-114, glossary T-99).
- **Depends on:** the Trash curation pipeline (PLAN-012 / ADR-025 — `createBatchFromPending`,
  `promoteToLeavingSoon`, `sweepExpiredBatches`) and the app-settings store (T-80). Soft cross-
  ref: the space policy (PLAN-014 / ADR-031) reuses `createBatchFromPending`, so it inherits the
  `batch_created` ping with no extra wiring.
- **TODO source:** owner directive 2026-07-08 (verbatim intent quoted in Goal).

## Goal

The owner asked (verbatim intent): _"integrate pushover so I get a notification when a new batch
is posted and the day it will leave — with a configurable time range the notification can be
sent, like 6PM-10PM when I am home and can spend time saving items."_

Deliver a durable, disabled-safe push path:

1. A **transactional outbox** (`notification_outbox`) that batch writers enqueue in the SAME tx
   as the transition — on **batch created** (manual + policy-proposed) and **green-lit / leaving
   soon** (incl. a **day-before-expiry reminder**), plus a **swept** summary.
2. A **delivery window** (`notify_window` = `{startHour, endHour, tz}`, default 18–22
   `America/New_York`), admin-editable + audited; enqueue computes each row's `earliest_send_at`
   from it (in-window ⇒ ASAP; outside ⇒ next window-open; reminder ⇒ day-before-expiry
   window-open).
3. A **`notify-outbox` sync mode** (15-min CronJob) that drains due rows to Pushover — **no env
   ⇒ a clean no-op that leaves rows queued**, so the build never blocks on credentials.

## Credentials (recon outcome — resolved)

Reuse, no owner action outstanding. The Pushover creds live in the `HaynesKube` 1Password item
**`media-stack`** (fields `HAYNESNETWORK_PUSHOVER_TOKEN` / `HAYNESNETWORK_PUSHOVER_USER_KEY`),
which the app ExternalSecret already pulls via `dataFrom: extract media-stack`. Deploy adds two
template lines mapping them to env `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY` — no new remoteRef.
(In-cluster the same Pushover account backs gatus + the upgrade-agent; this app registers as its
own Pushover application via the `HAYNESNETWORK_*` token so pushes read as "haynesnetwork".)

## Shape of the work

- **@hnet/db**: `notification_outbox` table + `NOTIFY_OUTBOX_CHANNELS`/`_EVENT_TYPES` enums;
  `notify_window` → `APP_SETTING_KEYS`; `notify-outbox` → `SYNC_RUN_KINDS`; migration 0024
  (CREATE TABLE + due index + two CHECK relaxes) + `_journal.json` entry.
- **@hnet/domain**: `NotifyWindow` type + default + `getNotifyWindow`; `notify-window.ts` window
  math; `notify-outbox.ts` (`enqueueOutbox`, `deliverOutbox`, `pushoverSenderFromEnv`,
  `renderOutboxMessage`, `postPushover`); enqueue hooks in `trash-batches.ts`.
- **@hnet/sync**: `notify-outbox` orchestrator branch + CLI `--mode` wiring.
- **@hnet/api**: `storage.notify.window.{get,set}` (adminProcedure; audited via `setAppSetting`).
- **apps/web**: a "Notifications" card on `/admin/storage`; pure helpers in
  `lib/notify-window.ts`.
- **Guard**: `notification_outbox` → the `no-direct-state-writes` FORBIDDEN_PATTERNS.

## Verification + DoD

Full gate (`lint`, `lint:css`, `typecheck`, `test`, `build`) + `e2e`. New unit tests: window
math, enqueue-same-tx (incl. rollback ⇒ no row + policy-inherits-created), sender
marks/backoff/park/**no-creds no-op**, settings audit + fail-safe. e2e: the Notifications card
renders + saves. DoD: docs above ratified; migration 0024 applied + asserted; gate/e2e green;
PR squash-merged; the CronJob spec handed to the owner for deploy; plan moved to `completed/`.

## Out of scope

Per-event opt-out (Q-01), pruning delivered rows (Q-02), overnight windows (Q-03), any second
channel (email/SMS) — the outbox `channel` column leaves room but only `pushover` ships.

## Rollback

Feature is inert without the CronJob + creds. To disable live: suspend `sync-notify-outbox`
(rows queue harmlessly) or set the window; nothing destructive. Schema is additive (a new table

- two CHECK relaxes) — a down-migration drops the table and reverts the CHECKs.
