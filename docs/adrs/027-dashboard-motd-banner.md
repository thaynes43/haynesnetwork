# ADR-027: Dashboard Message-of-the-Day banner

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner stretch request 2026-07-05) · authored + ratified by Fable 5
- **Builds on:** [ADR-025](025-trash-curation-pipeline.md) C-06 (the generic audited `app_settings`
  key→jsonb store) — the MOTD is its **second consumer**, not a new table.

## Context and problem statement

The owner wants an optional **Message-of-the-Day (MOTD)** — a single banner at the top of the
dashboard to broadcast notices (downtime, newly-added apps) to every signed-in user. PLAN-010 sketched
this as a bespoke `motd` singleton table with its own `set_motd`/`clear_motd` audit actions and a
`motd_severity` CHECK. Between that sketch and execution, ADR-025 C-06 shipped `app_settings`: a
small, audited key→jsonb store whose single writer (`setAppSetting`) co-writes an `update_app_setting`
`permission_audit` row in the same transaction (hard rule 6), explicitly advertised as reusable by
future features. The MOTD is exactly that shape — one small, admin-owned config record. The open
question (PLAN-010 Open decision #1) was: bespoke table vs. reuse the generic store.

## Decision drivers

- **Reuse over re-invention.** ADR-025 built the audited store for precisely this; a bespoke table
  duplicates the writer, the audit action, the CHECK, and a guard-list entry for no functional gain.
- **Least schema churn.** A single-key add is a one-line CHECK relax vs. a new table + FK + two new
  audit actions + guard changes.
- **Every constraint still holds:** audited single-writer (hard rule 6), no raw hex (hard rule 2),
  destructive Clear behind the two-step confirm (hard rule 8), no interaction reflow (hard rule 9).

## Considered options

1. **Store the MOTD as a `motd` key in the existing `app_settings` store** (jsonb record), reusing the
   `setAppSetting` writer and the `update_app_setting` audit action. (Chosen.)
2. **A bespoke `motd` singleton table** with `set_motd`/`clear_motd` actions and a severity CHECK (the
   original PLAN-010 sketch). Rejected: duplicates the audited-store machinery ADR-025 already ships.
3. **A `motd_dismissals` table** (durable, cross-device dismissals). Rejected for v1: per-user
   localStorage keyed by a content version is zero-schema and adequate (Out of scope in PLAN-010).

## Decision

- **Storage (Open #1 → reuse).** A new `app_settings` key **`motd`** holds the whole record as one
  jsonb value: `{ message, severity, enabled, startsAt, endsAt, updatedBy }` (timestamps as ISO-8601
  strings). `app_settings.key` is CHECK-constrained to `APP_SETTING_KEYS`, so admitting `motd` is a
  **CHECK-relax migration** (`0019_motd_app_setting.sql` — drop + re-add with the third value,
  mirroring the 0018 rebuilds). No new table, no FK, no new audit action, no guard-list change
  (`app_settings` is already guarded).
- **Writers (`packages/domain/src/motd.ts`).** `setMotd` / `clearMotd` delegate to the shared
  `setAppSetting` single-writer, so each write co-writes an `update_app_setting` `permission_audit`
  row (before/after snapshot) in the **same transaction**. `clearMotd` flips `enabled=false`
  (preserving the message so a re-enable is one edit). `getActiveMotd` is the read: it returns the
  record only when **active** = `enabled AND message non-blank AND (startsAt IS NULL OR now >=
  startsAt) AND (endsAt IS NULL OR now < endsAt)` — **inclusive start, exclusive end**.
- **Message format (Open #2).** Sanitized **plain text**, `<= 280` chars, rendered as text (React
  escapes it) — no HTML/markdown, no injection surface.
- **Severity (Open #4).** `MOTD_SEVERITIES = ['info','warning']` (no `critical`). It drives the ARIA
  role (`info`→`status`, `warning`→`alert`) and the banner palette.
- **Tokens (Open #5 → reuse).** The banner is styled from the existing `--color-info` /
  `--color-warning` tokens via `color-mix()` — **no new tokens, no raw hex** (hard rule 2). No
  `tokenContract` change.
- **Dismiss (Open #3 → localStorage).** Per-user `localStorage['hnet-motd-dismissed']` keyed to the
  MOTD **version** (a hash of the row's `updated_at` + content). It hides only when the stored version
  equals the current one, so an admin edit/re-enable (which bumps `updated_at`) **re-shows** it. No
  table. Collapsing on dismiss is an ADR-015-sanctioned **deliberate removal** (like the catalog
  inline editor), not an interaction reflow of neighbors.
- **API (Open #6).** A dedicated `motd` router: `getActive` (authedProcedure — every user's
  dashboard), `get`/`set`/`clear` (adminProcedure → the app-settings writer).
- **PLAN-009 tie-in (Open #7).** Not pursued — MOTD stays a standalone transient banner; it does not
  emit into the Bulletin Feed.

## Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: an owner broadcast channel with **zero new deps, no new table, no new audit action, no new token, no e2e stub** — the only schema change is a one-line CHECK relax (migration 0019). |
| C-02 | Good: the write is audited exactly like every other guarded mutation (`update_app_setting`, before/after in `detail`) via the shared same-tx single-writer; `app_settings` is already on the no-direct-writes guard list. |
| C-03 | Neutral: the MOTD record shares the `update_app_setting` audit action with the Trash skip-gate/window keys — audit consumers distinguish by `detail.key` (`'motd'`), which the writer already records. |
| C-04 | Neutral/limitation: dismissal is **client-only** (localStorage) in v1 — not audited, not cross-device. A cleared browser re-shows a still-active MOTD (acceptable; the `motd_dismissals` table remains the future durable option). |
| C-05 | Neutral: `getActiveMotd` reads the `app_settings` row directly (value + `updated_at`) rather than through `getAppSetting`, because the dismiss version needs `updated_at`; the shallow-typed `AppSettingValueMap['motd']` still governs the write path. |

## More information

PRD R-105 (Dashboard & app catalog) · DESIGN-004 D-15 · glossary T-89 · PLAN-010 · migration
`0019_motd_app_setting.sql`. Reuses ADR-025 C-06 (`app_settings`) and honors hard rules 2, 6, 8, 9.
