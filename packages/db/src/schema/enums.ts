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
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export const LEDGER_EVENT_SOURCES = ['sonarr', 'radarr', 'lidarr', 'seerr', 'app'] as const;
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
export const SYNC_RUN_KINDS = ['full', 'incremental', 'metadata-refresh'] as const;
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
