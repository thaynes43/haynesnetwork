# ADR-023: Trash section — Maintainerr integration, per-action grants, and the safety gate

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · authored AND ratified by Fable 5 (autonomous run, PLAN-006
  KICKOFF mandate + the 2026-07-06 live-recon Decisions of Record)

## Context and problem statement

PLAN-006 adds a top-level **Trash** section: a friendly front-end over the estate's newly-deployed
**Maintainerr** (3.17.0, `maintainerr.media.svc.cluster.local:6246`), which owns the rule engine,
the "collections" of items pending deletion, the exclusion/whitelist, and deletion execution. The
owner wants pending-deletion tables (Movies / TV, per-item space + when-it-deletes + a total),
Save/whitelist, Expedite, a Rules editor, and Recently-Deleted with Restore — with **fine-grained
per-role permissions** and a **hard safety gate** (audit before anything destructive is armed).

Live recon (2026-07-06): Maintainerr has **zero rules/collections/exclusions** (nothing armed);
Plex/Radarr/Sonarr/Tautulli/Seerr integrations connected; **no Lidarr** (music structurally
undeletable); reads are keyless, writes use `x-api-key`; **no Swagger** (write endpoints derived
from the maintainerr/maintainerr v3.17.0 source); **no deletion-history API**. This ADR resolves
DDD-002 **BC-03 `Q-04`** ("Maintainerr is a follow-on") and records the binding decisions.

## Decision drivers

1. **Maintainerr is the deletion system of record** — Trash is read-through + a confined write
   surface, never a re-implementation (CLAUDE.md hard rule 4 — the *arrs/Maintainerr own the truth).
2. Consistency with the existing entitlement + write-confinement discipline (ADR-008/011/012/021):
   const-array enums, single-writer + same-tx `permission_audit`, session-carried gating,
   import-confined mutating clients.
3. **Safety first** (owner's load-bearing instruction): nothing destructive is reachable unless a
   recorded audit says the install is safe; music is never deletable; watched/requested media is
   never silently trashed.

## Decision

- **C-01 — Client: EXTEND `@hnet/arr` (no new package).** The read-side `MaintainerrClient` grows
  the Trash reads (collections + paged per-item content with `sizeBytes`, rules, `GET /rules/constants`,
  exclusions, settings subset, `GET /app/status`, `GET /settings/test/plex`). A new confined
  `MaintainerrWriteClient` in **`@hnet/arr/write`** adds the mutations (add/remove exclusion, rule-group
  CRUD, the collection **handle** expedite triggers, the settings `PATCH` that enables Radarr/Sonarr
  tag exclusions). The existing `arr-write-import-guard` already confines `@hnet/arr/write` to
  `packages/domain`, so **no new guard test** is needed. Endpoints were derived from the v3.17.0
  source (route decorators + DTO/Zod bodies) and validated statically — see DESIGN-010 D-02.

- **C-02 — Read-through, no mirror tables.** Pending = `listTrashPending` merges Maintainerr's
  collections+media with our `media_items`/`media_metadata` by tmdbId (movie→radarr) / tvdbId
  (tv→sonarr) at read time; an item unknown to our ledger is still listed with Maintainerr's own
  fields. Recently-Deleted = OUR ledger's **tombstoned rows** (`deleted_from_arr_at`, T-41) — the
  durable, restore-able set (Maintainerr exposes no deletion history); Restore reuses the existing
  `executeRestore` failsafe path unchanged, plus a `trash_restored` marker event.

- **C-03 — Two-layer permission model: coarse section level + fine-grained action grants.** The
  coarse `role_section_permissions` `trash` level (ADR-021; default `disabled`) gates **VIEW**
  (Read-Only browses pending/collections/rules/recently-deleted/activity). Each destructive/mutating
  action is an **explicit** extra grant: `TRASH_ACTIONS = [save_exclude, remove_exclude,
  expedite_item, expedite_all, edit_rules, restore_deleted]` stored in
  **`role_trash_action_grants`** (`role_id` FK cascade, `action` CHECK, PK `(role_id, action)`) —
  **a row is the grant** (presence = granted; no boolean). **Viewing is NOT an action** (it is
  section read_only); **section edit-level implies NOTHING extra** (every action is opt-in); Admin
  implies every action with no rows. Written by the `@hnet/domain` `setRoleTrashActions` single-writer
  (replace-set + a same-tx `permission_audit` `update_trash_actions` row; Admin immutable →
  `ROLE_IMMUTABLE`). Sessions carry `SessionRole.trashActions`; the API gate is
  `trashActionProcedure(action[, minLevel])` composed on `sectionProcedure('trash','read_only')`
  (rule editing passes `minLevel:'edit'`). Migration **0015** adds the table + rebuilds the
  `permission_audit.action` CHECK for `update_trash_actions`.

- **C-04 — The safety gate.** `auditMaintainerr` returns `{ safe, reachable, version, integrations,
  armedRules, activeCollections }` — SAFE = reachable AND the required integrations (Plex, Radarr,
  Sonarr, Tautulli, Seerr) connected (derived, GET-only/keyless, from `app/status` + `settings/test/plex`
  + `rules/constants`'s configured-integration application list). Every **destructive** path
  (`expedite*`) re-runs the audit first and refuses with `MaintainerrUnsafeError` →
  `PRECONDITION_FAILED` if the install looks misconfigured. Exclusion writes need only reachability
  (the write fails closed on its own). All Maintainerr call failures map like `ArrUpstreamError`:
  `MaintainerrUpstreamError` → `BAD_GATEWAY` (fail closed).

- **C-05 — Write ordering (documented, DESIGN-010 D-05).** Save/remove exclusion are **protective**
  → external Maintainerr call FIRST, then the `trash_excluded` audit event (a crash leaves the item
  genuinely protected; we never write a phantom protective event before a failed call). Expedite is
  **destructive** → the `trash_expedited` intent event is committed FIRST, then the Maintainerr
  handle call (the Fix D-09 discipline — a lost response must never hide an initiated deletion).
  `LEDGER_EVENT_TYPES += trash_excluded|trash_expedited|trash_restored`; `LEDGER_EVENT_SOURCES +=
  maintainerr`.

- **C-06 — No music deletion (R-87).** Trash exposes Movies (Radarr) + TV (Sonarr) only; the media
  param is `movie|tv`; Lidarr is rejected at the orchestrator (`TrashMusicUnsupportedError`), not
  just the UI.

- **C-07 — Cross-server watch + requester guardian (addendum a / the *arr-tag addendum).** Before
  any expedite (and surfaced as a pending flag), items watched on ANY of the three Plex servers
  within `RECENTLY_WATCHED_WINDOW_DAYS` (default 30; `media_metadata.last_viewed_at` = cross-server
  MAX, PLAN-004) — or carrying a Seerr **requester** tag — are auto-whitelisted in Maintainerr
  (protected) instead of deleted. The protective `dnd` tag is **Maintainerr-managed** (enabled via
  the settings `PATCH`, a deploy step, with "remove tag on un-exclude" ON); we READ it from
  `media_items.arrTags` as the first-class "protected" signal and never hand-apply it.

- **C-08 — Restore nav retirement + the notification receiver.** The Admin → Restore nav item is
  removed and `/admin/restore` redirects to `/trash` (`restoreRouter` stays callable — it powers
  `trash.restoreDeleted`). A **generic** `notifications` table + `POST /api/webhooks/<source>`
  receiver (Maintainerr as source #1, shared-secret `MAINTAINERR_WEBHOOK_SECRET`) feeds Trash's
  Activity tab; PLAN-009 (Bulletin) extends the same store.

## Consequences

**Good:** one deletion brain (no re-implemented rule engine); every Save/Expedite/Restore is
audited; a hard, recorded safety gate + per-action grants + the watch/requester guardian make an
accidental or misconfigured deletion structurally hard; the receiver is the generic Bulletin base.

**Bad / trade-offs:** a hard runtime dependency on Maintainerr uptime + its (Swagger-less) API
stability (mitigated by fail-closed error mapping and static endpoint derivation from source); the
SAFE audit is a **manual, point-in-time** gate (it is re-checked on every destructive call, but a
between-check regression is possible — the guardian + confirm UX are the backstops); the pending
merge does N Maintainerr reads per collection (household scale — currently zero collections).

## Alternatives considered

- **A new `@hnet/maintainerr` package** (the plan's original sketch) — rejected in favour of
  extending `@hnet/arr` (C-01): Maintainerr rides the same HTTP taxonomy + write-confinement guard,
  so a second package is pure ceremony.
- **A thin `trash_deletions` mirror** for Recently-Deleted — rejected (C-02): our tombstoned ledger
  rows are already the durable, restore-able record; Maintainerr has no deletion-history API to
  mirror.
- **A uniform 3-level matrix** for every Trash action — rejected (C-03): binary per-action grants
  layered on the coarse VIEW level match the owner's "toggle per user-action" ask and keep Admin/
  section-edit semantics simple.
