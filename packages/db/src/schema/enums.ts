// DESIGN-001 D-02 — enum value sets. Enums are `text` + CHECK constraint in SQL
// (not Postgres enum types); these const arrays are the single source of truth,
// typed into columns via `$type<...>()`.

// ADR-012 — roles are DB-backed rows (the `roles` table), no longer a fixed enum.
// "who assigned a role" is still one of these kinds (a user never sets their own role).
export const ROLE_INITIATOR_KINDS = ['system', 'admin'] as const; // R-02 system, R-04 admin
export type RoleInitiatorKind = (typeof ROLE_INITIATOR_KINDS)[number];

export const PERMISSION_AUDIT_ACTIONS = [
  'create_role',
  'update_role',
  'delete_role', // ADR-012 role management (supersedes the tag/grant/family actions)
  'create_app',
  'update_app',
  'delete_app', // R-11 catalog edits
  'update_role_libraries', // ADR-017 D-07 — a role's Plex library grants were replaced
  'update_section_permission', // ADR-021 C-02 — a role's section access level was changed
  'update_trash_actions', // ADR-023 C-03 — a role's fine-grained Trash action grants were replaced
  'update_app_setting', // ADR-025 C-06 — a generic app_settings key was changed (skip-gate, window default)
  'update_message_actions', // ADR-026 C-04 — a role's fine-grained Bulletin message action grants were replaced
  'update_role_metrics_level', // ADR-037 C-01 — a role's metrics access level (full|limited) was changed
] as const;
export type PermissionAuditAction = (typeof PERMISSION_AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// DESIGN-005 Phase 2 — media ledger enums (D-05, D-07, D-09, D-10, D-11).
// The permission_audit action CHECK above is untouched by Phase 2 (D-12: BC-03
// aggregates are their own audit records).
// ---------------------------------------------------------------------------

export const ARR_KINDS = ['sonarr', 'radarr', 'lidarr'] as const; // DDD-001 T-22
export type ArrKind = (typeof ARR_KINDS)[number];

export const LEDGER_EVENT_TYPES = [
  'grabbed',
  'imported',
  'deleted',
  'download_failed', // from *arr history (normalized per the D-07 map)
  'requested', // from Seerr
  'fix_requested',
  'fix_actioned',
  'fix_completed',
  'fix_failed', // Fix lifecycle (D-09)
  'restored', // Restore write-back (D-16)
  'search_requested', // Force Search — search-only action for missing content (D-17; migration 0004)
  // ADR-023 / DESIGN-010 — Trash (Maintainerr) attribution markers (migration 0016). Each is an
  // app-initiated Trash action, source 'maintainerr': trash_excluded (Save/whitelist an item to
  // Maintainerr's exclusion list), trash_expedited (an item's deletion was hastened via the
  // collection handler), trash_restored (a recently-deleted item was re-added via executeRestore).
  'trash_excluded',
  'trash_expedited',
  'trash_restored',
  // ADR-025 / DESIGN-011 — Trash CURATION PIPELINE (migration 0017). A batch's state-machine
  // transition (create / green-light / cancel / expiry-complete) appends one of these with the
  // before/after state + per-item counts in the payload (mediaItemId null — it is batch-scoped,
  // not tied to one media item). Per-item deletions during the expiry sweep reuse 'trash_expedited'
  // (same intent-first discipline); item saves/unsaves reuse 'trash_excluded' + the dedicated
  // trash_batch_saves tuning table — so only this one new type is added.
  'trash_batch_transition',
  // ADR-031 / DESIGN-014 (PLAN-014 space-driven policy). The space-policy sync mode PROPOSES a batch
  // (never deletes) when a media array is over its space target; it appends this batch-scoped event
  // (mediaItemId null) explaining WHY — payload carries { batchId, mediaKind, array, usedPct, target,
  // candidateCount, candidateBytes, gateSkipped } — so Bulletin/Activity can show "policy proposed a
  // batch". Migration 0022 rebuilds the ledger_events.event_type CHECK to admit it.
  'trash_space_policy',
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

// ADR-023 / DESIGN-010 — 'maintainerr' joins the source set: Trash's exclusion/expedite/restore
// markers are attributed to Maintainerr (the deletion system of record). migration 0016.
export const LEDGER_EVENT_SOURCES = [
  'sonarr',
  'radarr',
  'lidarr',
  'seerr',
  'app',
  'maintainerr',
] as const;
export type LedgerEventSource = (typeof LEDGER_EVENT_SOURCES)[number];

export const FIX_REASONS = [
  'wont_play_corrupt',
  'wrong_language',
  'wrong_version_quality',
  'missing_subtitles',
  'wrong_content',
  'other',
] as const; // R-45; DDD-001 T-30
export type FixReason = (typeof FIX_REASONS)[number];

export const FIX_STATUSES = [
  'pending',
  'actioned',
  'search_triggered',
  'failed',
  'completed',
  // Two terminal outcomes for fixes that never reach a confirmed import (migration 0025 relaxes
  // the status CHECK): 'timed_out' is the never-stuck safety net — a fix (incl. fire-and-forget
  // bazarr_subtitle fixes, which completeFixRequests deliberately never closes) auto-closes after
  // FIX_TIMEOUT_HORIZON_MS (48h) so it stops blocking the one-open-fix-per-target rule. Neither is
  // an OPEN_FIX_STATUS, so both release the block. 'closed_manually' is the admin/requester escape
  // hatch (fix.close). Both are honest: we stopped tracking, we did NOT claim completed/failed.
  'timed_out',
  'closed_manually',
] as const; // Fix Lifecycle, DDD-001 T-43
export type FixStatus = (typeof FIX_STATUSES)[number];

// AC-07 (blocklist_search) vs AC-08 (delete_search); ADR-016/D-19 added 'bazarr_subtitle'
// — the missing_subtitles Fix routes to Bazarr's subtitle search (no blocklist, no delete,
// no *arr re-grab; the media file is untouched). Migration 0009 relaxes the CHECK.
export const FIX_PATHS = ['blocklist_search', 'delete_search', 'bazarr_subtitle'] as const;
export type FixPath = (typeof FIX_PATHS)[number];

// DESIGN-005 D-09 (hierarchy-actions amendment) — the SCOPE a Fix Request targets.
// 'item' = the radarr movie / whole unit (child null); 'episode' / 'album' = a single
// sonarr episode / lidarr album (child id set); 'season' = a whole sonarr season
// (target_season set, child null). Whole-show / whole-artist are Force-Search-only
// (no fix_requests row — DESIGN-005 D-15), so they are NOT scopes here.
export const FIX_TARGET_SCOPES = ['item', 'season', 'episode', 'album'] as const;
export type FixTargetScope = (typeof FIX_TARGET_SCOPES)[number];

export const RESTORE_RUN_STATUSES = [
  'running',
  'completed',
  'completed_with_errors',
  'failed',
] as const;
export type RestoreRunStatus = (typeof RESTORE_RUN_STATUSES)[number];

export const SYNC_SOURCES = ['sonarr', 'radarr', 'lidarr', 'seerr'] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

// ADR-018 / DESIGN-008 D-03 — 'metadata-refresh' is the metadata-enrichment harvest mode
// (ratings/genres/runtime/posters from the *arrs, watch-stats from Tautulli, computed props
// from Maintainerr, holes from direct TMDB/TVDB). It is a DISTINCT run from full/incremental
// sync (which never touch media_metadata); sync_runs.run_kind is CHECK-constrained to this set,
// so migration 0012 relaxes that CHECK when this value lands.
// ADR-025 / DESIGN-011 — 'trash-batch-sweep' is the batch-expiry sync mode: it acts ONLY on
// `leaving_soon` trash_batches whose save window has expired, deleting survivors via the existing
// per-item guarded loop (live exclusions + guardian + SAFE audit re-run at sweep time). It touches
// NO *arr source (it drives Maintainerr), so it never writes a sync_runs row — its audit trail is
// the ledger (trash_batch_transition + trash_expedited) + the batch columns, exactly like expedite.
// It joins SYNC_RUN_KINDS so the CLI `--mode` parser + `SyncMode` accept it (migration 0017 rebuilds
// the sync_runs.run_kind CHECK to keep the const array and CHECK in parity).
// ADR-031 / DESIGN-014 — 'space-policy' is the space-driven PROPOSAL sync mode: it reads
// getUtilization() and, for each array over its space target with no open batch for the backing
// kind(s), PROPOSES a draft batch (createBatchFromPending — the normal admin_review path; it NEVER
// greenlights, NEVER sweeps). Like trash-batch-sweep it touches NO *arr source (it reads *arr
// /diskspace + drives Maintainerr through the batch orchestrator), so it writes NO sync_runs row —
// its audit trail is the trash_space_policy ledger event + the space_policy notification + the
// proposed batch's own transition events. It joins SYNC_RUN_KINDS so the CLI `--mode` parser +
// `SyncMode` accept it (migration 0022 rebuilds the sync_runs.run_kind CHECK to keep parity).
// ADR-034 / DESIGN-015 — 'notify-outbox' is the Pushover DRAINER sync mode: it reads DUE rows from
// the notification_outbox (sent_at IS NULL AND attempts < 5 AND earliest_send_at <= now) and delivers
// them to Pushover, marking sent_at / backing off on failure. Like trash-batch-sweep + space-policy it
// touches NO *arr source (no --source) and writes NO sync_runs row — its audit trail IS the outbox
// rows. It joins SYNC_RUN_KINDS so the CLI `--mode` parser + `SyncMode` accept it (migration 0024
// rebuilds the sync_runs.run_kind CHECK to keep the const array and CHECK in parity).
// ADR-040 / DESIGN-020 — 'smart-alerts' is the SMART-health transition detector sync mode (PLAN-019):
// it reads the smartctl series through @hnet/metrics and, per drive, compares to the persisted
// smart_drive_state, enqueuing ONE notification_outbox row on a CRITICAL transition (pass→FAIL,
// media_errors 0→n, available_spare crossing threshold margin, a NEW critical_warning bit, or the
// critical appdata pool wear crossing 80/90 %) in the SAME transaction as the state update. First
// sight of a drive records a baseline and pages nothing (so the known staging-pool bad state never
// pages). Like trash-batch-sweep/space-policy/notify-outbox it touches NO *arr source (no --source)
// and writes NO sync_runs row — its trail is the outbox rows + the smart_drive_state table. It joins
// SYNC_RUN_KINDS so the CLI --mode parser + SyncMode accept it (migration 0033 rebuilds the
// sync_runs.run_kind CHECK to keep the const array and CHECK in parity).
// ADR-043 / DESIGN-021 (PLAN-024) — 'poster-guard' is the Peloton poster drift-restore sync mode: it
// reads the HOps Peloton library from k8plex, resolves each show/season to its durable override poster
// (baked into the image, ADR-043 C-01), and RE-APPLIES only the targets that drifted since the last
// apply (owner ruling R-137). Each re-apply appends one poster_guard_applications ledger row (the drift
// baseline + audit) in the SAME transaction (CLAUDE.md hard rule 6). It joins SYNC_RUN_KINDS so the CLI
// --mode parser + SyncMode accept it AND so the run is bracketed by a sync_runs row (migration 0034
// rebuilds the sync_runs.run_kind CHECK to keep the const array and CHECK in parity).
// ADR-044 / DESIGN-022 (PLAN-021) — 'ai-usage-sync' is the Open WebUI usage ingestion sync mode: it
// polls OWUI's admin API (GET /api/v1/chats/all/db + /api/v1/users/, api-key auth) and UPSERTS one row
// per chat into the ai_usage_chats mirror (the Metrics → AI sub-tab's substrate). Read-only against
// OWUI (never mutates it). Like smart-alerts/notify-outbox it touches NO *arr source (no --source) and
// writes NO sync_runs row — its trail is the ai_usage_chats table. It joins SYNC_RUN_KINDS so the CLI
// --mode parser + SyncMode accept it (migration 0035 rebuilds the sync_runs.run_kind CHECK to keep the
// const array and CHECK in parity).
export const SYNC_RUN_KINDS = [
  'full',
  'incremental',
  'metadata-refresh',
  'trash-batch-sweep',
  'space-policy',
  'notify-outbox',
  'smart-alerts',
  'poster-guard',
  'ai-usage-sync',
] as const;
export type SyncRunKind = (typeof SYNC_RUN_KINDS)[number];

// ADR-043 / DESIGN-021 (PLAN-024) — the two Plex metadata targets the poster guard applies art to: a
// SHOW poster (the class-type series art) or a SEASON poster (the duration art, keyed by season index).
export const POSTER_GUARD_TARGET_KINDS = ['show', 'season'] as const;
export type PosterGuardTargetKind = (typeof POSTER_GUARD_TARGET_KINDS)[number];

// ADR-043 / DESIGN-021 — why a re-apply happened, recorded on each poster_guard_applications ledger row:
//   'initial'       — no prior applied row for this target (first apply / re-seed).
//   'drift'         — the live Plex thumb no longer matches the baseline we recorded at last apply.
//   'asset-updated' — the mapped durable asset's bytes changed (owner swapped the PNG); re-push it.
export const POSTER_GUARD_REASONS = ['initial', 'drift', 'asset-updated'] as const;
export type PosterGuardReason = (typeof POSTER_GUARD_REASONS)[number];

export const SYNC_RUN_STATUSES = ['running', 'succeeded', 'failed', 'aborted'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

// ---------------------------------------------------------------------------
// ADR-017 / DESIGN-007 Phase 3 — Plex library self-service enums (D-01, D-02).
// The plex_share_audit action CHECK is these events; BC-04 aggregates own their
// own audit rows (like the BC-03 media aggregates — D-12), so share events are a
// separate table, not permission_audit.
// ---------------------------------------------------------------------------

// The three Plex servers of record (OPS-002; canonical owner slugs). `plex_servers.slug`
// is CHECK-constrained to this set. Note the subdomain↔slug mismatch (plexops↔haynesops,
// k8plex↔hayneskube) — code uses the SLUGS everywhere; the subdomains are ingress detail.
export const PLEX_SERVER_SLUGS = ['haynestower', 'haynesops', 'hayneskube'] as const;
export type PlexServerSlug = (typeof PLEX_SERVER_SLUGS)[number];

// The Plex library `type` values observed live 2026-07-06 against `GET /library/sections`
// on all three servers (ADR-017 D-06). Only these four appear — HAYNESTOWER's family
// libraries report as `movie` (HNet Home Videos) and `photo` (HNet Photos); Plex has no
// distinct `homevideo` section type. New values arrive only if a future library reports a
// new `type`; relax this CHECK if that happens.
export const PLEX_MEDIA_TYPES = ['movie', 'show', 'artist', 'photo'] as const;
export type PlexMediaType = (typeof PLEX_MEDIA_TYPES)[number];

// Plex-share ledger events (ADR-017 D-07 / ADR-024). A per-section library share was applied
// (share_added) or revoked (share_removed); OR the server-wide all-libraries flag was turned on
// (share_all_enabled) or off (share_all_disabled) for a user's account (ADR-024 role-scoped
// all-libraries self-service — the all events carry no plex_library_id, they are server-scoped).
export const PLEX_SHARE_EVENTS = [
  'share_added',
  'share_removed',
  'share_all_enabled',
  'share_all_disabled',
] as const;
export type PlexShareEvent = (typeof PLEX_SHARE_EVENTS)[number];

// ---------------------------------------------------------------------------
// ADR-021 / DESIGN-009 — Section-level Role Permissions (Ledger + reserved Trash).
// A role carries one access LEVEL per top-level SECTION (role_section_permissions).
// These const arrays are the single source of truth for TS + the SQL CHECKs (migration
// 0013). PLAN-005 owns the base model; PLAN-006 (Trash) reuses 'trash' + layers its finer
// per-action grants on top — it does NOT create a second base table.
// ---------------------------------------------------------------------------

// ADR-026 / DESIGN-012 — 'bulletin' joins the section set (PLAN-009 Bulletin: Feed + Messages).
// ADR-037 / DESIGN-016 — 'metrics' joins the section set (PLAN-017 Metrics section foundation).
// ADR-038 / DESIGN-017 — 'ytdlsub' joins the section set (PLAN-022 ytdl-sub Library sub-tabs). It gates
// the Peloton/YouTube sub-tabs INSIDE the (universal, ungated) Library section — Library itself has no
// section id; this is the visibility knob for its ytdl-sub content only.
export const SECTION_IDS = ['ledger', 'trash', 'bulletin', 'metrics', 'ytdlsub'] as const; // 'trash' PLAN-006; 'bulletin' PLAN-009; 'metrics' PLAN-017; 'ytdlsub' PLAN-022
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_PERMISSION_LEVELS = ['edit', 'read_only', 'disabled'] as const;
export type SectionPermissionLevel = (typeof SECTION_PERMISSION_LEVELS)[number];

// ADR-037 C-01 / DESIGN-016 (PLAN-017) — a role's METRICS access level (T-107). A single scalar per
// role (like `roles.grants_all`), stored on `roles.metrics_level`; text + CHECK, this const array is
// the single source of truth for the TS type AND the SQL CHECK. `full` sees user-aware + fine-grained
// metrics; `limited` sees the aggregate/usage-only subset. Admin implies `full` via the session
// short-circuit. Default (column + no-row) is `limited`.
export const METRICS_LEVELS = ['full', 'limited'] as const;
export type MetricsLevel = (typeof METRICS_LEVELS)[number];

/** limited < full — the rank a `metricsProcedure` gates on (mirrors SECTION_LEVEL_RANK). */
export const METRICS_LEVEL_RANK: Record<MetricsLevel, number> = { limited: 0, full: 1 };

/**
 * The no-row fallback per section (ADR-021 C-01, Q-03 resolved). Ledger defaults to
 * `disabled` — **ADR-032 (2026-07-07) flipped it from ADR-021's original `read_only`**:
 * the Ledger is operator tooling reached from the user menu, hidden for members unless a
 * role opts them in (a role row `read_only`/`edit` restores access; admins imply `edit`).
 * `trash` defaults to `disabled` (reserved by PLAN-006's rollout — a role row opts users
 * in). An `is_admin` role implies `edit` on every section with NO rows (ADR-021 C-03).
 * NOTE: these are CODE defaults (the no-row fallback) — no SQL default exists, so the flip
 * needs no migration; a LIVE role with a stored `ledger` row keeps its stored level.
 */
export const SECTION_DEFAULT_LEVELS: Record<SectionId, SectionPermissionLevel> = {
  ledger: 'disabled',
  trash: 'disabled',
  // ADR-026 C-02 — the Bulletin Feed is for everyone: an authenticated member reads the Feed +
  // Messages out of the box (no admin touch), while POSTING/MODERATING stay opt-in per-action
  // grants (message action grants, T-87). `disabled` hides the whole section from that role.
  bulletin: 'read_only',
  // ADR-037 C-02 (PLAN-017 Metrics) — `metrics` defaults to `disabled`, the trash/ledger rollout
  // pattern: the section ships Admin-only (an is_admin role implies `edit`; every other role needs a
  // stored row to opt in). The owner opens it to the Default role (`read_only`) after his morning review.
  metrics: 'disabled',
  // ADR-038 C-04 (PLAN-022 ytdl-sub Library) — `ytdlsub` defaults to `disabled`, the same ship-Admin-only
  // rollout: the Peloton/YouTube Library sub-tabs are hidden for non-admins until a role row opts them in
  // (an is_admin role implies `edit`). The owner flips visibility per role after his screenshot review.
  ytdlsub: 'disabled',
};

/** disabled < read_only < edit — the total order `sectionProcedure` gates on (ADR-021). */
export const SECTION_LEVEL_RANK: Record<SectionPermissionLevel, number> = {
  disabled: 0,
  read_only: 1,
  edit: 2,
};

// ---------------------------------------------------------------------------
// ADR-023 / DESIGN-010 — Trash (Maintainerr) fine-grained per-action grants. A role's
// coarse `trash` section level (SECTION_IDS above) still gates VIEW (read_only ⇒ can browse
// the pending tables / rules / recently-deleted); each ACTION below is an EXPLICIT extra grant
// (a row in role_trash_action_grants ⇒ granted). Viewing is NOT an action — it is section
// read_only (ADR-023 C-03). Section edit-level implies NOTHING extra: every action is opt-in.
// An is_admin role implies ALL actions (like it implies section edit) with NO rows.
// ---------------------------------------------------------------------------

export const TRASH_ACTIONS = [
  'save_exclude', // Save/whitelist an item → add it to Maintainerr's exclusion list (R-83)
  'remove_exclude', // Un-save → remove the Maintainerr exclusion
  'expedite_item', // Hasten one item's deletion (destructive; R-84)
  'expedite_all', // Hasten the whole pending set's deletion (destructive; R-84)
  'edit_rules', // Create/update/delete Maintainerr rule groups (R-81; needs section edit too)
  'restore_deleted', // Re-add a recently-deleted item via executeRestore (R-85)
  // ADR-025 / DESIGN-011 — the curation-pipeline grants (migration 0017 rebuilds the CHECK):
  'save_leaving_soon', // A user rescues an item during the Leaving-Soon window (Q-04 — NOT seeded)
  'manage_batches', // Admin batch lifecycle: create / green-light / cancel / expire-now (Q-04; admin ⇒ all)
] as const;
export type TrashAction = (typeof TRASH_ACTIONS)[number];

// ---------------------------------------------------------------------------
// ADR-025 / DESIGN-011 — Trash CURATION PIPELINE (migration 0017). Batches are the
// deletion unit: a snapshot of the current pending set an admin curates (poster review),
// green-lights into a Plex "Leaving Soon" collection, and a windowed sweep deletes. These
// const arrays are the single source of truth for TS + the SQL CHECKs (text+CHECK, never
// Postgres enum types — DESIGN-001 D-02).
// ---------------------------------------------------------------------------

/** The two media kinds a batch covers (never mixed, mirroring the never-combined tabs; music
 *  is never batchable — R-87). CHECK on trash_batches.media_kind. */
export const TRASH_MEDIA_KINDS = ['movie', 'tv'] as const;
export type TrashMediaKind = (typeof TRASH_MEDIA_KINDS)[number];

/**
 * The batch state machine (ADR-025 C-01). `draft` (staged; the skip-gate path starts here) →
 * `admin_review` (poster curation) → `leaving_soon` (green-lit; the Plex collection is up and the
 * user save window is running) → `deleted` (the windowed sweep ran). Any non-terminal state may go
 * to `cancelled`. INVARIANT: only `leaving_soon` expires, and only `greenlightBatch` OR the audited
 * `gate_skipped` path reaches `leaving_soon` — a batch NEVER deletes without the admin gate.
 */
export const TRASH_BATCH_STATES = [
  'draft',
  'admin_review',
  'leaving_soon',
  'deleted',
  'cancelled',
] as const;
export type TrashBatchState = (typeof TRASH_BATCH_STATES)[number];

/** The non-terminal ("open") batch states — at most ONE open batch per media kind (enforced by a
 *  partial unique index). Terminal = `deleted` | `cancelled`. */
export const TRASH_BATCH_OPEN_STATES = ['draft', 'admin_review', 'leaving_soon'] as const;

/**
 * A batch item's lifecycle. `pending` (proposed for deletion) ⇄ `saved` (rescued: permanently
 * excluded in Maintainerr, leaves the batch). At sweep time a survivor becomes `deleted`; an item
 * the guardian keeps (dnd/watched/requester/unevaluable) or a failed delete lands `skipped`;
 * `protected` records an item that was tag-protected at snapshot time (never a delete candidate).
 */
export const TRASH_BATCH_ITEM_STATES = [
  'pending',
  'saved',
  'deleted',
  'skipped',
  'protected',
] as const;
export type TrashBatchItemState = (typeof TRASH_BATCH_ITEM_STATES)[number];

/** A save-event row's direction (Q-07 — the trash_batch_saves tuning dataset). */
export const TRASH_SAVE_ACTIONS = ['save', 'unsave'] as const;
export type TrashSaveAction = (typeof TRASH_SAVE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// ADR-025 C-06 — generic app_settings key/value store (Q-06). A small audited key→jsonb
// table; the single-writer `setAppSetting` co-writes an `update_app_setting` permission_audit
// row in the same tx. Reusable — PLAN-010 (MOTD) and PLAN-013/014 (space target / tuning knobs)
// add keys here. CHECK on app_settings.key.
// ---------------------------------------------------------------------------

export const APP_SETTING_KEYS = [
  'trash_skip_admin_gate', // bool — when true, createBatch auto-green-lights (audited gate_skipped)
  'trash_default_window_days', // int — the default save-window length copied onto a batch at green-light
  // ADR-027 / DESIGN-004 D-15 (PLAN-010 MOTD) — the Message-of-the-Day record (jsonb object:
  // { message, severity, enabled, startsAt, endsAt, updatedBy }). The dashboard banner reuses the
  // generic audited store rather than a bespoke `motd` table (Open decision #1 resolved to reuse).
  // The app_settings.key CHECK is relaxed to admit this value in migration 0019.
  'motd',
  // ADR-030 / DESIGN-013 (PLAN-013 disk + reclaim metrics) — the per-Plex-server space TARGETS
  // (jsonb object keyed by plex_servers slug → percent-used ceiling, e.g. { haynestower: 80 }). The
  // Storage utilization surface draws the target as a reference line; PLAN-014 later acts on it (C-05,
  // Q-03 split: 013 stores + displays, 014 enforces). Reuses the generic audited store; the
  // app_settings.key CHECK is relaxed to admit this value in migration 0021.
  'space_targets',
  // ADR-031 / DESIGN-014 (PLAN-014 space-driven policy) — the space-policy CONFIG (jsonb object:
  // { enabled, mode, cooldownDays, minCandidates, perArray: { <arrayKey>: { enabled, cooldownDays?,
  // minCandidates? } }, perKind: { movie|tv: { maxItems:{enabled,value}, targetBytes:{enabled,value} } } }).
  // DEFAULT OFF (enabled:false), mode 'over-target', no per-kind caps. When on, the space-policy sync mode
  // proposes (never deletes) a draft batch: over-target mode fires only over the space_targets ceiling;
  // continuous mode fires on candidates+cooldown alone (DESIGN-014 amendment 2026-07-09, build A).
  // getSpacePolicy migrates the retired flat `targetBytesPerBatch` key into per-kind targetBytes caps.
  // Admin-gated + audited through the same setAppSetting single-writer; migration 0022 relaxed the CHECK.
  'space_policy',
  // ADR-034 / DESIGN-015 (PLAN-016 Pushover batch notifications) — the DELIVERY WINDOW (jsonb object:
  // { startHour, endHour, tz }; DEFAULT ALL-DAY { 0, 24, 'America/New_York' } — no gating, every push
  // leaves ASAP (build-A owner change 2026-07-09; was { 18, 22 }). `endHour` is EXCLUSIVE ([start,end)),
  // so 24 = through 23:59:59.999. The owner's quiet-hours control: enqueue computes each
  // notification_outbox row's earliest_send_at against it (in-window ⇒ ASAP; outside ⇒ next window-open).
  // Admin-gated + audited through the same setAppSetting single-writer; migration 0024 relaxes the CHECK.
  'notify_window',
  // DESIGN-010/014 amendment (2026-07-09, build D) — POOL REFRESH AFTER SAVE (jsonb object:
  // { enabled, delayMinutes }; DEFAULT { enabled:true, delayMinutes:5 }). When on, a save/un-save on a
  // pending wall enqueues a debounced Maintainerr RULE re-execution `delayMinutes` later (coalesced per
  // kind via the pending_pool_refresh marker + an in-process timer; the incremental sync is the crash-safe
  // backstop) so shielded items leave the pending list quickly. Rule runs are heavy — the helper text
  // steers the delay ≥ a few minutes. Admin-gated + audited through setAppSetting; migration 0029 relaxes
  // the CHECK (and adds the pending_pool_refresh marker table).
  'pool_refresh_after_save',
  // DESIGN-015 amendment (2026-07-09) — the FINAL-WARNING push config (jsonb object:
  // { enabled, hoursBefore }; DEFAULT { enabled:true, hoursBefore:2 }). When on, green-light enqueues a
  // `batch_final_warning` outbox row `hoursBefore` hours before the window closes (a configurable
  // "last call" ahead of the sweep). Read fail-safe by `getFinalWarning` (typeof-guarded — a garbage
  // jsonb row can't disable the gate into a truthy string / yield a NaN lead time). Admin-gated +
  // audited through setAppSetting; migration 0030 relaxes the CHECK.
  'final_warning',
  // ADR-037 C-06 / DESIGN-016 (PLAN-017 Metrics) — the WAN link capacities the Metrics Overview charts
  // usage against (Mbps ints). `upload_capacity_mbps` seeds 300 (the owner's practical Plex outbound cap);
  // `download_capacity_mbps` seeds 2256 (the live provider figure — PROVISIONAL, owner to confirm Q-02).
  // Admin-editable + audited through the same setAppSetting single-writer; migration 0031 relaxes the CHECK.
  'upload_capacity_mbps',
  'download_capacity_mbps',
] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

// ADR-027 / DESIGN-004 D-15 (PLAN-010) — a MOTD's severity, driving the banner's token palette
// (`--color-info` / `--color-warning`) and its ARIA role (status vs alert). Stored inside the
// `motd` app_settings jsonb value (no DB CHECK of its own); this const array is the single source
// of truth for the TS type + the API zod enum. `critical` is intentionally out of scope (Open #4).
export const MOTD_SEVERITIES = ['info', 'warning'] as const;
export type MotdSeverity = (typeof MOTD_SEVERITIES)[number];

// ADR-023 / DESIGN-010 (addendum c) — the notification store's source set. PLAN-006 shipped the
// generic receiver with Maintainerr as source #1; ADR-026 / DESIGN-012 (PLAN-009 Bulletin) WIDENS
// it with Seerr + Tautulli adapters (migration 0018 rebuilds the notifications source CHECK).
// 'seerr' is the single canonical name for BOTH Overseerr and Seerr (one deployment, one source
// name — the Overseerr webhook agent posts here). text+CHECK, single source of truth for TS + the
// notifications SQL CHECK.
//
// 'trash' (migration 0020) is the APP itself as an event source: an app-initiated Trash deletion
// (Expedite / batch sweep) writes its own Activity notification here so it surfaces in the Activity
// tab independent of Maintainerr's webhook — Maintainerr does NOT webhook our API-triggered per-item
// `/collections/media/handle` calls, so app-expedited deletions would otherwise never reach Activity.
export const NOTIFICATION_SOURCES = ['maintainerr', 'seerr', 'tautulli', 'trash'] as const;
export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

// ---------------------------------------------------------------------------
// ADR-026 / DESIGN-012 — Bulletin: Messages board enums (migration 0018). A Message is a
// user-posted durable board entry; MESSAGE_STATUSES is its moderation lifecycle and
// MESSAGE_ACTIONS the fine-grained per-action grants (mirroring TRASH_ACTIONS). text+CHECK,
// single source of truth for TS + the SQL CHECKs (DESIGN-001 D-02).
// ---------------------------------------------------------------------------

// A Message's moderation status. 'visible' (posted, shown in the board); 'hidden' (moderator
// soft-hide — content preserved, filtered from the default board); 'deleted' (moderator
// soft-delete — content preserved for audit, never rendered). Content is NEVER physically
// removed by a status change (soft states preserve the row for the audit trail).
export const MESSAGE_STATUSES = ['visible', 'hidden', 'deleted'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

// The fine-grained Bulletin message actions layered on top of the coarse `bulletin` section level
// (which gates READ). 'post' = create/edit one's OWN messages; 'moderate' = hide/delete/restore
// ANY message. A ROW in role_message_action_grants = the action is granted (presence is the grant;
// no boolean — mirrors TRASH_ACTIONS / role_trash_action_grants). Admin implies both with no rows.
export const MESSAGE_ACTIONS = ['post', 'moderate'] as const;
export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

// ADR-022 C-01 — how an *arr-add run was initiated (restore_runs.reason, migration 0014).
// `restore` = the admin-only diff-driven failsafe (searches OFF, skip-if-present); `ledger_add`
// = the Ledger section's bulk Add-&-search (monitors present-but-unmonitored items, searches ON).
export const ARR_ADD_REASONS = ['restore', 'ledger_add'] as const;
export type ArrAddReason = (typeof ARR_ADD_REASONS)[number];

// ---------------------------------------------------------------------------
// ADR-018 / DESIGN-008 Phase 4 — Library metadata enrichment enums (D-01).
// media_metadata is a separate 1:1 sibling of media_items (ADR-018) carrying the
// volatile, multi-source, refreshed descriptive/quality data. These const arrays are
// the single source of truth for both the TS types and the SQL CHECK constraints
// (DESIGN-001 D-02 / HARD RULE — enums are text+CHECK, never Postgres enum types).
// ---------------------------------------------------------------------------

// Which harvest tier contributed a metadata row's PRIMARY descriptive fields. The
// per-tier `sources` jsonb records EVERY tier that landed (arr + tautulli + …); this
// scalar records the winning descriptive source in priority order (*arr first, then the
// *arr lookup for tombstoned/hole rows, then direct TMDB/TVDB). Tautulli/Maintainerr are
// additive (watch-stats / computed props) and ride `sources`, not this scalar — but are
// listed so a metadata row harvested ONLY from them still validates.
export const METADATA_SOURCES = [
  'arr', // the live *arr item list (ratings/images/genres/runtime/added)
  'arr_lookup', // the *arr /lookup endpoint (tombstoned / never-listed rows) — no re-add
  'tautulli', // watch-stats only
  'maintainerr', // computed rule-props only
  'tmdb', // direct TMDB fallback for holes the *arrs can't fill
  'tvdb', // direct TVDB fallback for holes
] as const;
export type MetadataSource = (typeof METADATA_SOURCES)[number];

// The quality/resolution tier of a Media Item, derived from the *arr's target quality
// profile (DESIGN-008 D-02 — approximate: it reflects the profile the *arr targets, not the
// exact on-disk file, which would cost a per-item file fetch across ~17.7k items). 'unknown'
// covers range/any profiles (e.g. "Any", "HD - 720p/1080p") that don't pin one resolution.
export const RESOLUTIONS = ['2160p', '1080p', '720p', '576p', '480p', 'sd', 'unknown'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

// Where the poster PROXY route streams a Media Item's poster from (ADR-019 — posters are
// proxied, never stored: no PVC, no image processing). 'arr' → the owning *arr's pre-resized
// MediaCover variant (server-side, API-key header); 'tmdb' → the TMDB CDN (w342) for
// tombstoned / lookup-sourced rows. Nullable on the row: null ⇒ the UI shows the KindIcon.
export const POSTER_SOURCES = ['arr', 'tmdb'] as const;
export type PosterSource = (typeof POSTER_SOURCES)[number];

// ---------------------------------------------------------------------------
// ADR-034 / DESIGN-015 — Pushover batch-lifecycle notifications: the transactional
// OUTBOX enums (migration 0024). text+CHECK, single source of truth for TS + the SQL
// CHECKs (DESIGN-001 D-02 / HARD RULE — enums are text+CHECK, never Postgres enum types).
// ---------------------------------------------------------------------------

// The delivery channel of an outbox row. Only 'pushover' ships; the column leaves room for a
// future email/SMS channel without a schema change (the sender switches on it).
export const NOTIFY_OUTBOX_CHANNELS = ['pushover'] as const;
export type NotifyOutboxChannel = (typeof NOTIFY_OUTBOX_CHANNELS)[number];

// The batch-lifecycle moment a row notifies (the sender renders title/message/url per type):
//   batch_created               — a batch was posted (manual OR space-policy-proposed): "review it".
//   batch_leaving_soon          — a batch was green-lit into Leaving Soon (deadline date carried).
//   batch_leaving_soon_reminder — the DAY BEFORE expiry: last chance to save.
//   batch_final_warning         — DESIGN-015 amendment (2026-07-09) — the CONFIGURABLE last-call ping,
//                                 enqueued at green-light with `earliest_send_at = expires_at − N hours`
//                                 (N = the `final_warning.hoursBefore` setting, READ at green-light). It
//                                 is skipped when that instant is already past / the window is shorter
//                                 than N. "Last call: … closes at <time> — N items still slated."
//   batch_swept                 — the windowed sweep closed the batch (summary).
//   smart_degraded              — ADR-040 / DESIGN-020 (PLAN-019) — a drive crossed a CRITICAL SMART
//                                 threshold since the last check (pass→FAIL, media_errors 0→n, spare
//                                 crossing threshold margin, a NEW critical_warning bit, or the
//                                 critical appdata pool wear crossing 80/90 %). Enqueued by
//                                 evaluateSmartAlerts in the SAME tx as the smart_drive_state update;
//                                 the renderer deep-links `…/metrics?tab=hardware`. Baseline-on-first-
//                                 sight never enqueues, so the known staging-pool bad state never pages.
//   smart_recovered             — a drive returned to health (FAIL→pass) — a low-noise recovery ping.
export const NOTIFY_OUTBOX_EVENT_TYPES = [
  'batch_created',
  'batch_leaving_soon',
  'batch_leaving_soon_reminder',
  'batch_final_warning',
  'batch_swept',
  'smart_degraded',
  'smart_recovered',
] as const;
export type NotifyOutboxEventType = (typeof NOTIFY_OUTBOX_EVENT_TYPES)[number];
