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

export const FIX_PATHS = ['blocklist_search', 'delete_search'] as const; // AC-07 vs AC-08
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

export const SYNC_RUN_KINDS = ['full', 'incremental'] as const;
export type SyncRunKind = (typeof SYNC_RUN_KINDS)[number];

export const SYNC_RUN_STATUSES = ['running', 'succeeded', 'failed', 'aborted'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];
