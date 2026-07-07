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
export const SYNC_RUN_KINDS = [
  'full',
  'incremental',
  'metadata-refresh',
  'trash-batch-sweep',
] as const;
export type SyncRunKind = (typeof SYNC_RUN_KINDS)[number];

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

export const SECTION_IDS = ['ledger', 'trash'] as const; // 'trash' reserved for PLAN-006
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_PERMISSION_LEVELS = ['edit', 'read_only', 'disabled'] as const;
export type SectionPermissionLevel = (typeof SECTION_PERMISSION_LEVELS)[number];

/**
 * The no-row fallback per section (ADR-021 C-01, Q-03 resolved). Ledger defaults to
 * `read_only`: an authenticated member browses/exports the whole ledger without an admin
 * touching their role, while the mutating Add-&-search stays Edit-gated. `trash` defaults
 * to `disabled` (reserved for PLAN-006 — hidden until that plan builds the section). An
 * `is_admin` role implies `edit` on every section with NO rows (ADR-021 C-03).
 */
export const SECTION_DEFAULT_LEVELS: Record<SectionId, SectionPermissionLevel> = {
  ledger: 'read_only',
  trash: 'disabled',
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
] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

// ADR-023 / DESIGN-010 (addendum c) — the notification store's source set. PLAN-006 ships the
// generic receiver with Maintainerr as source #1; PLAN-009 (Bulletin) extends this with Seerr /
// Tautulli adapters. text+CHECK, single source of truth for TS + the notifications SQL CHECK.
export const NOTIFICATION_SOURCES = ['maintainerr'] as const;
export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

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
