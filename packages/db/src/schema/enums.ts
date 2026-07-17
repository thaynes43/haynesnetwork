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
  'assign_pending_role', // ADR-045 C-05 (PLAN-026) — a role was assigned to an Authentik-only identity that has no app user row yet; the intent is parked in pending_role_assignments and consumed on that identity's first app login
  'update_bulletin_views', // ADR-049 C-01 (PLAN-027) — a role's Bulletin SUB-VIEW visibility grants (feed/messages) were replaced
  // ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the three USER-initiated Integration
  // actions that co-write a permission_audit row (actorId = the acting user; roleId null — these are NOT
  // role/permission mutations; subjectUserId = the same user). Sync-driven mutations of the integration
  // read-model (shelf-item upsert, request minting, LL-status reconcile) write NO audit row (the
  // synced-content exemption, exactly like books_items / media_items). `link_integration` /
  // `unlink_integration` record a user linking / unlinking an external account; `request_book_search`
  // records a manual "Search again" on a Missing book request (the confined LazyLibrarian `searchBook` write).
  'link_integration',
  'unlink_integration',
  'request_book_search',
  // ADR-062 / DESIGN-033 (PLAN-041) — the books Fix (audited request) + its grant management.
  'request_book_fix',
  'update_book_actions',
  // ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the two USER-initiated Activity actions on
  // an import failure that co-write a permission_audit row (actorId = the acting Admin/granted user;
  // roleId null — these are NOT role/permission mutations; subjectUserId null — they target a media
  // pipeline item, not a user). `activity_retry_import` records a retry of a stuck import (the confined
  // LazyLibrarian `forceProcess`); `activity_force_search` records a force re-search (the confined
  // `searchBook`, the recordManualSearch precedent). The `activity-scan` sync mode's failure upsert is
  // UNaudited (synced/derived — the mam_gate_state class).
  'activity_retry_import',
  'activity_force_search',
  // ADR-059 / DESIGN-030 (PLAN-048) — a role's fine-grained Activity action grants were replaced (the
  // update_trash_actions analog; written by setRoleActivityActions with before/after action lists).
  'update_activity_actions',
  // ADR-069 / DESIGN-042 (PLAN-052 — collection manager). `update_collection_actions` records a role's
  // fine-grained collection action grants being replaced (the update_book_actions analog; written by
  // setRoleCollectionActions). `create_collection_suggestion` records a member proposing a collection
  // (actorId = the suggesting user; roleId null — not a role mutation; subjectUserId = the same user).
  // `review_collection_suggestion` records a manage admin approving/declining a suggestion (actorId = the
  // reviewing admin). The suggestion lifecycle rows commit in the SAME tx as the mutation they record.
  'update_collection_actions',
  'create_collection_suggestion',
  'review_collection_suggestion',
] as const;
export type PermissionAuditAction = (typeof PERMISSION_AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the fine-grained Activity ACTION grants,
// layered on the (universal, ungated) Library section exactly as TRASH_ACTIONS layer on `trash`. A ROW in
// role_activity_action_grants = the action is GRANTED (presence is the grant; no boolean — ADR-023 C-03);
// an is_admin role implies EVERY action with NO rows. R2: import-failure actions ship Admin-only; a role
// row opens one to others later. text+CHECK, single source of truth for the TS type + the SQL CHECK.
// ---------------------------------------------------------------------------
export const ACTIVITY_ACTIONS = [
  'retry_import', // re-run the importer for a stuck download (LazyLibrarian forceProcess)
  'force_research', // force a fresh search for a dead-end grab (searchBook)
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

// ADR-059 / DESIGN-030 — the failure CLASS of an activity_import_failures row (the UI + actions switch on
// it). `stranded_import` = downloaded/completed at the client but never imported (the OPS-013 §11 42-book
// incident — LL row still Snatched while SAB shows Completed); `postprocess_failed` = the importer ran and
// failed (LL `Failed`/`DLResult`); `download_failed` = the download itself failed (SAB dead nzb / par2);
// `import_blocked` = a content/type mismatch the importer refuses (an ebook grab against an audiobook want).
// text+CHECK, single source of truth for the TS type + the activity_import_failures CHECK.
export const ACTIVITY_FAILURE_KINDS = [
  'stranded_import',
  'postprocess_failed',
  'download_failed',
  'import_blocked',
] as const;
export type ActivityFailureKind = (typeof ACTIVITY_FAILURE_KINDS)[number];

// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik group-portal write ledger. haynesnetwork writes
// Authentik group MEMBERSHIP for the groups it OWNS (the owned-groups allowlist), and pre-creates the
// synced-tier group in Authentik AND Open WebUI. Because these are EXTERNAL side-effects (Authentik /
// OWUI REST), they cannot co-commit with a local DB row — so, exactly like plex_share_audit (BC-04),
// each successful external write appends one authentik_group_audit row AFTER the apply (never a
// permission_audit row). `add_member`/`remove_member` flip owned-group membership; `create_group`
// pre-creates the Authentik tier group; `ensure_owui_group` pre-creates the same-named Open WebUI group.
export const AUTHENTIK_GROUP_AUDIT_ACTIONS = [
  'add_member',
  'remove_member',
  'create_group',
  'ensure_owui_group',
] as const;
export type AuthentikGroupAuditAction = (typeof AUTHENTIK_GROUP_AUDIT_ACTIONS)[number];

// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik user `type` values observed live 2026-07-10 against
// `GET /api/v3/core/users/`: `external` (Plex-source social-login identities, path goauthentik.io/sources/*),
// `internal` (native Authentik accounts), `internal_service_account` (outposts + the hnet-portal SA). The
// authentik_users mirror stores this so /admin/users can render a source badge without re-deriving it.
export const AUTHENTIK_USER_TYPES = ['external', 'internal', 'internal_service_account'] as const;
export type AuthentikUserType = (typeof AUTHENTIK_USER_TYPES)[number];

// ---------------------------------------------------------------------------
// DESIGN-005 Phase 2 — media ledger enums (D-05, D-07, D-09, D-10, D-11).
// The permission_audit action CHECK above is untouched by Phase 2 (D-12: BC-03
// aggregates are their own audit records).
// ---------------------------------------------------------------------------

export const ARR_KINDS = ['sonarr', 'radarr', 'lidarr'] as const; // DDD-001 T-22
export type ArrKind = (typeof ARR_KINDS)[number];

// ---------------------------------------------------------------------------
// ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks) — the books ledger enums. Books are a
// SEPARATE ledger from the *arr media_items (they have no monitored/quality/root-folder/Fix
// semantics — ADR-046 rejects overloading media_items); they get their own books_items mirror.
// text+CHECK, these const arrays are the single source of truth for the TS types + the SQL CHECKs.
// ---------------------------------------------------------------------------

/** The two book servers of record (books_items.source). Kavita serves Books+Comics; ABS serves Audio Books. */
export const BOOKS_SOURCES = ['kavita', 'audiobookshelf'] as const;
export type BooksSource = (typeof BOOKS_SOURCES)[number];

/** The app media kind of a books_items row (books_items.media_kind) — the three Library sub-tabs. */
export const BOOKS_MEDIA_KINDS = ['book', 'comic', 'audiobook'] as const;
export type BooksMediaKind = (typeof BOOKS_MEDIA_KINDS)[number];

/**
 * ADR-066 / DESIGN-038 D-01 (PLAN-051 — books collections mirror) — the KIND of a mirrored books
 * collection (`books_collections.kind`). A Kavita READING LIST is a distinct id space from Kavita
 * collections (both mirror; reading lists render as ORDERED collections — PLAN-051 Q-01), so kind
 * is part of the row identity `(source, external_id, kind)`. ABS exposes only `collection`.
 * text+CHECK; this const array is the single source of truth for the TS type + the SQL CHECK.
 */
export const BOOKS_COLLECTION_KINDS = ['collection', 'reading_list'] as const;
export type BooksCollectionKind = (typeof BOOKS_COLLECTION_KINDS)[number];

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
  // ADR-045 / DESIGN-023 (PLAN-026) — 'authentik-users' is the one-way Authentik directory read sync: it
  // pages `GET /api/v3/core/users/` (incl. external / never-logged-in identities) + `GET .../groups/` and
  // UPSERTS the snapshot into the authentik_users mirror via the domain syncAuthentikUsers single-writer.
  // Read-only against Authentik. Like ai-usage-sync it is a standalone mode (no --source, writes NO
  // sync_runs row — its trail is the authentik_users table). It joins SYNC_RUN_KINDS so the CLI `--mode`
  // parser + `SyncMode` accept it (migration 0036 rebuilds the sync_runs.run_kind CHECK).
  'authentik-users',
  // ADR-046 / DESIGN-024 (PLAN-023) — 'books-sync' is the Kavita + Audiobookshelf ledger ingestion
  // mode: it pages the two book servers READ-ONLY (Kavita `/api/Series/all-v2` per library, ABS
  // `/api/libraries/{id}/items`) and UPSERTS the snapshot into the books_items mirror via the domain
  // syncBooks single-writer, tombstoning rows no longer served. Like ai-usage-sync it is a standalone
  // mode (no --source, writes NO sync_runs row — its trail is books_items). It joins SYNC_RUN_KINDS so
  // the CLI `--mode` parser + `SyncMode` accept it (migration 0037 rebuilds the sync_runs.run_kind CHECK).
  'books-sync',
  // ADR-047 / DESIGN-025 (PLAN-028 — Library deep links) — 'plex-match' resolves each *arr ledger
  // media_item to the exact Plex {library, ratingKey} by shared-GUID match and UPSERTS the
  // media_plex_matches derived cache via the domain syncPlexMatches single-writer. Reads DB media_items
  // (their tmdb/tvdb/imdb/musicbrainz ids, already synced) + Plex libraries READ-ONLY — no *arr call, no
  // write to Plex. Standalone mode (no --source, writes NO sync_runs row — its trail is
  // media_plex_matches). It joins SYNC_RUN_KINDS so the CLI --mode parser + SyncMode accept it (migration
  // 0038 rebuilds the sync_runs.run_kind CHECK to keep the const array + CHECK in parity).
  'plex-match',
  // ADR-054 / DESIGN-027 (PLAN-039 — MAM compliance governor) — 'mam-governor' counts UNSATISFIED
  // torrents locally in qBittorrent (`books-mam`, seeding_time < 72h + still-downloading — ZERO MAM API
  // surface) and, near the rank cap (unsatisfied ≥ limit − buffer), PAUSES the LazyLibrarian MAM Torznab
  // provider via LL's own changeProvider API (resumes when headroom returns). It upserts the single-row
  // mam_gate_state via the domain evaluateMamGovernor single-writer and enqueues a notification_outbox row
  // on a gate transition / >48h zero-headroom (same-tx). Fail-closed: a failed count ⇒ gate closed. Like
  // smart-alerts/notify-outbox it touches NO *arr source (no --source) and writes NO sync_runs row — its
  // trail is the outbox rows + mam_gate_state. It joins SYNC_RUN_KINDS so the CLI --mode parser + SyncMode
  // accept it (migration 0041 rebuilds the sync_runs.run_kind CHECK to keep the const array + CHECK in parity).
  'mam-governor',
  // ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — 'goodreads-sync' polls each linked user's
  // PUBLIC Goodreads shelf RSS (read-only; no OAuth, no secret), mirrors the shelf into
  // integration_shelf_items, matches each want against the books_items library mirror (ISBN → title/author),
  // mints book_requests for the unmatched, and pushes BOTH formats to LazyLibrarian via the proven paced
  // pattern (GB-volume/ISBN → addBook → queueBook → searchBook) through the domain single-writer +
  // confined LL write bundle, then reconciles LL statuses back to per-format request states. Standalone
  // like books-sync: no --source, writes NO sync_runs row (its trail is the integration tables). It joins
  // SYNC_RUN_KINDS so the CLI --mode parser + SyncMode accept it (migration 0045 rebuilds the
  // sync_runs.run_kind CHECK to keep the const array + CHECK in parity).
  'goodreads-sync',
  // ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — 'activity-scan' polls each source family's
  // queue/import state (SLICE 1: LazyLibrarian wanted-table + SABnzbd queue/history), computes the current
  // OPEN import-failure set (incl. the stranded_import class), and via the domain evaluateActivityFailures
  // single-writer UPSERTS the activity_import_failures ledger AND — for each NEWLY-seen failure — enqueues
  // one 'activity_import_failed' notification_outbox row in the SAME transaction (ADR-034 C-01; first sight
  // pages once, a cleared failure is closed). The Activity tab + wall badges read LIVE (ADR-059 Q-01), so
  // this mode owns ONLY the durable failure ledger + the outbox transition. Like mam-governor/notify-outbox
  // it touches NO *arr source (no --source) and writes NO sync_runs row — its trail is the failure ledger +
  // the outbox rows. It joins SYNC_RUN_KINDS so the CLI --mode parser + SyncMode accept it (migration 0048
  // rebuilds the sync_runs.run_kind CHECK to keep the const array + CHECK in parity).
  'activity-scan',
  // ADR-060 follow-up (PLAN-048 tail, 2026-07-15) — 'failure-digest' reads OPEN
  // activity_import_failures (resolved_at IS NULL) and enqueues ONE email-channel
  // notification_outbox row (`activity_failure_digest`) to the admin mailbox — none when the
  // ledger is clean. Nightly CronJob; the notify-outbox drainer delivers. Like notify-outbox it
  // touches NO *arr source and writes NO sync_runs row — its trail is the outbox row. It joins
  // SYNC_RUN_KINDS so the CLI --mode parser + SyncMode accept it (migration 0050 rebuilds the CHECK).
  'failure-digest',
  // ADR-064 / DESIGN-035 (PLAN-037 — mirrored Plex collections) — 'collections-sync' mirrors the HOps
  // Plex server's collections (charts included — owner R3) into the plex_collections /
  // plex_collection_members derived cache via the domain syncPlexCollections single-writer: the
  // fetcher pages each registered movie/show section's /collections + each collection's children
  // READ-ONLY (slug haynesops only — owner R4), the writer upserts + reconcile-deletes scoped to
  // fully-read sections/collections. External software is ALWAYS the collections source of truth
  // (owner doctrine R1); no write to Plex ever. Like plex-match it is a standalone mode (no --source,
  // writes NO sync_runs row — its trail is the mirror tables). It joins SYNC_RUN_KINDS so the CLI
  // --mode parser + SyncMode accept it (migration 0053 rebuilds the sync_runs.run_kind CHECK).
  'collections-sync',
  // ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook pairing) — 'format-pairing' rebuilds the
  // books_format_pairs derived cache from the books_items mirror (the conservative normTitle+author
  // matcher, comics excluded), then mints the PACED estate-wide system wants for unpaired items'
  // missing formats (book_requests origin='pairing', capped at PAIRING_MINT_CAP_PER_RUN attempts/run,
  // missing-format-only confined LL push) and reconciles the open pairing wants against ONE LL
  // getAllBookStatuses read. Fetches NO external snapshot — it derives from books_items, so its
  // CronJob runs AFTER books-sync. Standalone like plex-match: no --source, writes NO sync_runs row —
  // its trail is books_format_pairs + the pairing book_requests rows. It joins SYNC_RUN_KINDS so the
  // CLI --mode parser + SyncMode accept it (migration 0054 rebuilds the sync_runs.run_kind CHECK).
  'format-pairing',
  // ADR-066 / DESIGN-038 (PLAN-051 — books collections mirror) — 'books-collections-sync' mirrors the
  // BOOK sources' collections (Kavita collections + Kavita reading lists as ORDERED collections + ABS
  // collections) into the books_collections / books_collection_members derived cache via the domain
  // syncBooksCollections single-writer: the fetcher reads both servers READ-ONLY through the SAME
  // BooksSyncBundle as books-sync, the writer upserts + reconcile-deletes scoped to fully-read
  // (source, kind) families and fully-read collections (a partial read never tombstones), resolving
  // member refs opportunistically against the fresh books_items mirror — so its CronJob runs AFTER
  // books-sync. External software is ALWAYS the collections source of truth (owner doctrine R1); no
  // write to Kavita/ABS ever (@hnet/books has no write surface). Like collections-sync it is a
  // standalone mode (no --source, writes NO sync_runs row — its trail is the mirror tables). It joins
  // SYNC_RUN_KINDS so the CLI --mode parser + SyncMode accept it (migration 0056 rebuilds the
  // sync_runs.run_kind CHECK).
  'books-collections-sync',
] as const;
export type SyncRunKind = (typeof SYNC_RUN_KINDS)[number];

// DESIGN-035 D-10 / R-214 (PLAN-053 — Collection Type facet) — the six owner-ruled kind buckets a
// mirrored Plex collection is annotated with (2026-07-16 rulings, FINAL: producer/writer fold into
// 'director'; anything the versioned classifier can't place explicitly is honestly 'other').
// Stored on plex_collections.collection_type (migration 0055 CHECK — kept in parity with this
// array) and RECOMPUTED from the title at every collections-sync upsert (a rebuildable annotation,
// never migrated state). The ledger.collectionGroups `ctype` facet + typeCounts speak these values.
export const COLLECTION_TYPES = [
  'trilogy',
  'franchise_universe',
  'director',
  'actor',
  'list',
  'other',
] as const;
export type CollectionType = (typeof COLLECTION_TYPES)[number];

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

// ADR-047 / DESIGN-025 (PLAN-028 — Library "Watch/Listen/Read here" deep links) — the shared external
// GUID a media_items row and a Plex title BOTH carry, used to resolve the *arr → Plex match (which Plex
// library the item lives in + its ratingKey). Radarr matches on tmdb/imdb, Sonarr on tvdb/imdb, Lidarr
// on musicbrainz. `media_plex_matches.matched_via` is CHECK-constrained to this set.
export const PLEX_MATCH_GUID_SOURCES = ['tmdb', 'imdb', 'tvdb', 'musicbrainz'] as const;
export type PlexMatchGuidSource = (typeof PLEX_MATCH_GUID_SOURCES)[number];

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
// ADR-046 / DESIGN-024 — 'books' joins the section set (PLAN-023 Books & Audiobooks). Like 'ytdlsub' it
// gates NEW Library sub-tabs (Books / Audiobooks / Comics) INSIDE the (universal, ungated) Library
// section — Library itself has no section id; this is the visibility knob for the books walls only,
// defaulting to `disabled` so they ship Admin-only until the owner opts a role in after screenshot review.
// ADR-055 / DESIGN-028 — 'integrations' joins the section set (PLAN-044 Goodreads requests MVP). It gates
// the NEW top-level Integrations tab (link external accounts → shelf sync → requests/Missing wall),
// defaulting to `disabled` so it ships Admin-only until the owner opts a role in after screenshot review —
// the same rollout as metrics/ytdlsub/books.
export const SECTION_IDS = [
  'ledger',
  'trash',
  'bulletin',
  'metrics',
  'ytdlsub',
  'books',
  'integrations',
] as const; // 'trash' PLAN-006; 'bulletin' PLAN-009; 'metrics' PLAN-017; 'ytdlsub' PLAN-022; 'books' PLAN-023; 'integrations' PLAN-044
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
  // ADR-046 C-04 (PLAN-023 Books & Audiobooks) — `books` defaults to `disabled`, the same ship-Admin-only
  // rollout as ytdlsub: the Books/Audiobooks/Comics Library sub-tabs are hidden for non-admins until a role
  // row opts them in (an is_admin role implies `edit`). The owner flips visibility per role after review.
  books: 'disabled',
  // ADR-055 C-04 (PLAN-044 Goodreads requests MVP) — `integrations` defaults to `disabled`, the same
  // ship-Admin-only rollout: the Integrations tab (link accounts, shelf sync, requests/Missing) is hidden
  // for non-admins until a role row opts them in (an is_admin role implies `edit`). Owner opens it per role.
  integrations: 'disabled',
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
  // ADR-045 / DESIGN-023 (PLAN-026 Authentik role portal) — the two guardrail settings that scope which
  // Authentik groups the app may write. `authentik_owned_groups` (jsonb string[] of group NAMES; DEFAULT
  // ['family']) is the allowlist: membership writes are REFUSED for any group not in it, so the portal can
  // never touch authentik-admin-managed groups (authentik Admins, mfa-exempt, …). `authentik_group_map`
  // (jsonb object roleId → group name; DEFAULT {}) records each synced tier's role→Authentik-group binding
  // so a later role RENAME doesn't orphan the group (absent entry falls back to name.toLowerCase()).
  // Both are admin-mutated + audited through the same setAppSetting single-writer; migration 0036 relaxes
  // the CHECK. Auto-creating a synced tier appends its group to the allowlist + records the map entry.
  'authentik_owned_groups',
  'authentik_group_map',
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
// ADR-050 / DESIGN-012 D-10 (PLAN-034 Helpdesk) — Bulletin: HELPDESK TICKET enums (migration
// 0040). A Ticket is a household media-issue report with a state machine, an append-only event
// history and a flat reply thread; it REPLACES the ADR-026 Messages board (the `messages` table
// and its visible/hidden/deleted moderation lifecycle were dropped in 0040 — owner ruling Q-03).
// text+CHECK, single source of truth for TS + the SQL CHECKs (DESIGN-001 D-02).
// ---------------------------------------------------------------------------

// A Ticket's state (requirement 5): 'open' (filed, nobody on it yet) → 'in_progress' (staff picked
// it up — absorbs the old "Triage" concept) → 'complete' (fixed/answered — TERMINAL; a recurrence
// is a new ticket) | 'rejected' (won't-do / duplicate / GitHub-bound — RE-OPENABLE, the analog of
// the old hide). The allowed edges live in @hnet/domain `TICKET_TRANSITIONS` (the single matrix
// `transitionTicket` enforces); every transition appends a ticket_events row with an optional
// household-visible note.
export const TICKET_STATUSES = ['open', 'in_progress', 'complete', 'rejected'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// The Helpdesk intake taxonomy (ADR-050 option D — deliberately NOT FIX_REASONS: intake is broader
// and member-facing; a category never routes an automated action). Drives the icon tile a
// non-media ticket gets on the wall and the category glyph on media tiles:
//   playback  — won't play, buffering, errors mid-stream
//   audio     — no sound, out of sync, wrong language
//   subtitles — missing, wrong, or out-of-sync subtitles
//   quality   — bad quality or the wrong version/cut
//   missing   — an episode/season/title that should be in the library but isn't
//   other     — anything else about media or playback
// ADR-061 / DESIGN-032 D-01 (PLAN-038 — ticket media precision) — the LOCATOR kind qualifying a
// ticket's media link: which level of the title's hierarchy the ticket targets. NULL on the
// column = the whole title (the pre-locator meaning, unchanged). text+CHECK (migration 0051).
export const TICKET_TARGET_KINDS = ['season', 'episode', 'album', 'track'] as const;
export type TicketTargetKind = (typeof TICKET_TARGET_KINDS)[number];

// ---------------------------------------------------------------------------
// ADR-062 / DESIGN-033 (PLAN-041 — books/audiobooks/comics Fix). text+CHECK (DESIGN-001 D-02).
// ---------------------------------------------------------------------------

// The books Fix reason taxonomy (C-06). reason_text is required IFF 'other' (CHECKed).
export const BOOK_FIX_REASONS = ['wrong_language', 'corrupt_file', 'wrong_edition', 'bad_quality', 'other'] as const;
export type BookFixReason = (typeof BOOK_FIX_REASONS)[number];

// The acquisition route a books Fix takes — derived from media_kind (book/audiobook → LL; comic → Kapowarr).
export const BOOK_FIX_ROUTES = ['lazylibrarian', 'kapowarr'] as const;
export type BookFixRoute = (typeof BOOK_FIX_ROUTES)[number];

// Lifecycle (D-02): pending (audited row committed BEFORE any external call) → search_triggered →
// completed (async — the landed replacement observed) | failed. No blocklist/actioned step: LL and
// Kapowarr have no *arr mark-failed analog (ADR-062 C-02).
// ADR-067 / DESIGN-039 (PLAN-055) — 'queued' joins the set (migration 0057 rebuilds the CHECK): a
// fix whose GB identity resolve met the OPEN quota breaker (or tripped it) parks here instead of
// failing — an OPEN status (the one-open-per-(item, kind) dedupe holds) completed automatically by
// the goodreads-sync-hosted retryQueuedBookFixes pass. Quota weather ONLY: permanent failures
// (GB no-match, non-429 errors, LL step errors) still land 'failed' honestly.
export const BOOK_FIX_STATUSES = ['pending', 'queued', 'search_triggered', 'failed', 'completed'] as const;
export type BookFixStatus = (typeof BOOK_FIX_STATUSES)[number];

// The honest stale-file seam (ADR-062 C-03): v1 never moves library files; 'owner_quarantine'
// flags a fix whose bad copy needs the owner-side OPS-013 quarantine (the deferred Mode-2 signal).
export const BOOK_STALE_FILE_ACTIONS = ['none', 'owner_quarantine'] as const;
export type BookStaleFileAction = (typeof BOOK_STALE_FILE_ACTIONS)[number];

// The fine-grained books actions a role may be granted (the ADR-023/059 idiom; a ROW is the grant;
// Admin implies all). Ships UNGRANTED (Admin-only) for the owner's test window — then the Q-01
// ruling FLIPS it to all roles (tracked post-validation step; do not forget).
export const BOOK_ACTIONS = ['fix_book'] as const;
export type BookAction = (typeof BOOK_ACTIONS)[number];

// ---------------------------------------------------------------------------
// ADR-069 / DESIGN-042 (PLAN-052 — collection manager + member contributions). text+CHECK
// (DESIGN-001 D-02): these const arrays are the single source of truth for the TS types AND the
// SQL CHECKs. The collection manager binds to Libretto's provider-parity API (DESIGN-037 D-10) —
// nothing here is a local recipe/collection store; the ONLY durable local state is the role grants
// (role_collection_action_grants) + the pending member suggestions (collection_suggestions).
// ---------------------------------------------------------------------------

// The fine-grained collection-manager actions a role may be granted (the ADR-023/059/062 idiom; a
// ROW is the grant; Admin implies all). Ships UNGRANTED (Admin-only) — the owner opens each per role
// after review (the books-Fix precedent). `suggest` = propose a collection (the member contribution);
// `manage` = create/edit/delete recipes + apply runs; `acquire` = flip acquisitionEnabled — THE
// content-pulling knob, a DISTINCT grant a `manage` role does not automatically hold (ADR-069 C-04).
export const COLLECTION_ACTIONS = ['suggest', 'manage', 'acquire'] as const;
export type CollectionAction = (typeof COLLECTION_ACTIONS)[number];

// The collection-manager PROVIDER discriminator (R2 — integration parity). 'libretto' is the books
// provider bound now; 'kometa' (the movies/TV leg, designed in parallel — DESIGN-037 Appendix A)
// joins the enum + a second adapter behind the SAME router, no schema change (ADR-069 C-06).
export const COLLECTION_PROVIDERS = ['libretto'] as const;
export type CollectionProvider = (typeof COLLECTION_PROVIDERS)[number];

// The Libretto v1 builder set (DESIGN-037 D-05) — what SOURCE a recipe's collection is built from.
export const COLLECTION_BUILDER_TYPES = [
  'static_ids',
  'hardcover_series',
  'nyt_list',
  'wikidata_award',
] as const;
export type CollectionBuilderType = (typeof COLLECTION_BUILDER_TYPES)[number];

// A recipe's reconcile mode (DESIGN-037 D-08): `sync` reconciles full membership + order to the
// builder output (adds/removes/repositions); `append` adds only, never removes.
export const COLLECTION_SYNC_MODES = ['append', 'sync'] as const;
export type CollectionSyncMode = (typeof COLLECTION_SYNC_MODES)[number];

// A member suggestion's lifecycle (ADR-069 C-05): `pending` (filed; applies nothing) → `approved`
// (a manage admin materialized the recipe via the confined writer) | `declined` (with a reason).
export const COLLECTION_SUGGESTION_STATUSES = ['pending', 'approved', 'declined'] as const;
export type CollectionSuggestionStatus = (typeof COLLECTION_SUGGESTION_STATUSES)[number];

export const TICKET_CATEGORIES = [
  'playback',
  'audio',
  'subtitles',
  'quality',
  'missing',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

// The fine-grained Bulletin message actions layered on top of the coarse `bulletin` section level
// (which gates READ). Since PLAN-034 (ADR-050 option H) these gate the HELPDESK: 'post' = create
// tickets; 'moderate' = drive ticket state transitions (staff triage — Q-02). Replies need NEITHER
// (any member with the `messages` sub-view grant may reply). The STORED values are unchanged from
// ADR-026 so no grant row migrates; only display labels changed. A ROW in
// role_message_action_grants = the action is granted (presence is the grant; no boolean — mirrors
// TRASH_ACTIONS / role_trash_action_grants). Admin implies both with no rows.
export const MESSAGE_ACTIONS = ['post', 'moderate'] as const;
export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

// ADR-049 / DESIGN-012 amend (PLAN-027) — the two Bulletin SUB-VIEWS a role's visibility can be
// scoped to, layered on top of the coarse `bulletin` section level (which gates the section as a
// whole). A ROW in role_bulletin_view_grants means that view is granted (presence is the grant;
// mirrors MESSAGE_ACTIONS / role_message_action_grants in SHAPE). Unlike the message-action grants,
// the RESOLUTION is default-ON: because "Bulletin is for everyone" (ADR-026 C-02) a role with NO
// rows resolves to BULLETIN_VIEW_DEFAULTS (both views) — the section-default pattern, since these
// gate VISIBILITY (not additive powers). Present rows are the exact narrowing allowlist; the owner's
// Default role is narrowed to `messages` only (feed carries Family/Friends-oriented ops chatter). The
// server gates the feed/messages tRPC surfaces on the resolved set, so a role without a view gets
// FORBIDDEN — never a client-only hide. Admin implies BOTH with no rows. text+CHECK, single source.
export const BULLETIN_VIEWS = ['feed', 'messages'] as const;
export type BulletinView = (typeof BULLETIN_VIEWS)[number];

/**
 * ADR-049 C-02 — the no-row fallback for a role's Bulletin views (ADR-026 C-02 "Bulletin is for
 * everyone"). A role with ZERO role_bulletin_view_grants rows resolves to BOTH views; any present
 * rows are the exact allowlist (a narrowing). This differs from MESSAGE_ACTIONS (which default OFF)
 * BECAUSE views gate VISIBILITY of a section that ships visible, not an opt-in power — so absence is
 * "unconfigured ⇒ show all", like SECTION_DEFAULT_LEVELS, not "deny". Admin implies both via the
 * session short-circuit (no rows). Immutable snapshot so callers can't mutate the shared array.
 */
export const BULLETIN_VIEW_DEFAULTS: readonly BulletinView[] = ['feed', 'messages'] as const;

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

// The delivery channel of an outbox row. 'email' opened by ADR-060 (PLAN-035, migration 0049):
// email rows carry their resolved recipient in payload.to (enqueue-time, same-tx — ADR-060 C-02)
// and deliver over the F-04 SMTP relay; the drainer routes rows to per-channel senders and skips
// (never fails) a channel whose credentials are absent.
export const NOTIFY_OUTBOX_CHANNELS = ['pushover', 'email'] as const;
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
//   ticket_created              — ADR-050 / DESIGN-012 D-13 (PLAN-034 Helpdesk) — a household member
//                                 filed a Helpdesk ticket. Enqueued by createTicket in the SAME tx as
//                                 the ticket + creation-event inserts (ADR-034 C-01), so the admins'
//                                 Pushover ping commits with the ticket or not at all. The renderer
//                                 deep-links the ticket detail page. Migration 0040 rebuilds the CHECK.
//   mam_gate_paused             — ADR-054 / DESIGN-027 (PLAN-039 MAM governor) — the governor PAUSED the
//                                 LazyLibrarian MAM Torznab provider because unsatisfied torrents reached
//                                 the rank-cap threshold (limit − buffer) OR the qBittorrent count failed
//                                 (fail-closed). Enqueued by evaluateMamGovernor in the SAME tx as the
//                                 mam_gate_state upsert (ADR-034 C-01). Transitions-only (open→paused).
//   mam_gate_resumed            — the governor RE-ENABLED the MAM provider because headroom returned
//                                 (unsatisfied dropped below the threshold). Transitions-only (paused→open).
//   mam_gate_stuck              — headroom has been PINNED at 0 (unsatisfied ≥ the hard limit) for > 48h:
//                                 demand far exceeds the ~rank-limit-per-72h throughput (the owner may want
//                                 to prioritise the wanted list / push a rank bump). Fires ONCE per stuck
//                                 episode (deduped by mam_gate_state.pinned_alerted_at). Migration 0041
//                                 rebuilds the CHECK.
export const NOTIFY_OUTBOX_EVENT_TYPES = [
  'batch_created',
  'batch_leaving_soon',
  'batch_leaving_soon_reminder',
  'batch_final_warning',
  'batch_swept',
  'smart_degraded',
  'smart_recovered',
  'ticket_created',
  'mam_gate_paused',
  'mam_gate_resumed',
  'mam_gate_stuck',
  //   activity_import_failed      — ADR-059 / DESIGN-030 (PLAN-048 Activity/In-Flight) — a media item's
  //                                 acquisition FAILED to import (incl. the stranded_import class: the
  //                                 download completed but never landed — the OPS-013 §11 42-book incident).
  //                                 Enqueued by evaluateActivityFailures in the SAME tx as the
  //                                 activity_import_failures upsert, ONCE per newly-seen failure (dedupe via
  //                                 the row's notified_at). Feeds the future admin digest (PLAN-035 channel,
  //                                 post-SMTP) — NO per-event push in v1 (owner ruled in-app only). The
  //                                 renderer deep-links the failure detail page. Migration 0048 rebuilds the CHECK.
  'activity_import_failed',
  //   ticket_replied / ticket_status_changed — ADR-060 / DESIGN-031 D-02 (PLAN-035) — the ticket
  //                                 AUTHOR's opt-in email moments (email channel only; never enqueued
  //                                 for the author's own action). Migration 0049 rebuilds the CHECK.
  'ticket_replied',
  'ticket_status_changed',
  //   activity_failure_digest     — ADR-060 follow-up (PLAN-048 tail, 2026-07-15) — the NIGHTLY admin
  //                                 email summarizing OPEN activity_import_failures (email channel only;
  //                                 the failure-digest sync mode enqueues ONE row per run, none when the
  //                                 ledger is clean). Migration 0050 rebuilds the CHECK.
  'activity_failure_digest',
] as const;
export type NotifyOutboxEventType = (typeof NOTIFY_OUTBOX_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// ADR-051/052/053 / DESIGN-026 (PLAN-029 — Library views, grouping & the S&F overhaul).
// text+CHECK, single source of truth for the TS types + the SQL CHECKs (DESIGN-001 D-02).
// ---------------------------------------------------------------------------

// ADR-052 / DESIGN-026 D-06 — the Library "wall" a per-user preference row is keyed by (one row
// per (user_id, wall)). One entry per Library kind sub-tab: the *arr walls (movies / tv / music),
// the live-Plex walls (peloton / youtube) and the book walls (books / audiobooks / comics). This
// is the presentation scope — NOT a section id (SECTION_IDS gates VISIBILITY; a wall is a tab a
// role can already see). library_preferences.wall is CHECK-constrained to this set.
export const LIBRARY_WALLS = [
  'movies',
  'tv',
  'music',
  'peloton',
  'youtube',
  'books',
  'audiobooks',
  'comics',
] as const;
export type LibraryWall = (typeof LIBRARY_WALLS)[number];

// ADR-051 / DESIGN-026 D-01 — the three view SHAPES a wall renders in: 'flat' (the current poster
// grid, one card per item), 'grouped' (aggregate cards keyed by a grouping dimension — Author /
// Series / Channel / Exercise), 'hierarchy' (the existing TV Shows → Seasons → Episodes drill-in,
// unchanged). library_preferences.view is CHECK-constrained to this set.
export const LIBRARY_VIEW_SHAPES = ['flat', 'grouped', 'hierarchy'] as const;
export type LibraryViewShape = (typeof LIBRARY_VIEW_SHAPES)[number];

// ADR-052 / DESIGN-026 D-06 — a stored sort direction. Mirrors the D-09 librarySortShape wire enum
// so a stored preference round-trips 1:1 with the URL `?sort=field:dir` segment (D-10).
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP). The Integration enums.
// text+CHECK, these const arrays are the single source of truth for the TS types + the SQL
// CHECKs (DESIGN-001 D-02 / HARD RULE — enums are text+CHECK, never Postgres enum types).
// ---------------------------------------------------------------------------

// The external providers a user can link (user_integrations.provider). v1 ships 'goodreads' only —
// PUBLIC shelf RSS, no OAuth, no secret (the Goodreads API was retired 2020; shelf RSS is the durable
// path per .agents/context/2026-07-11-books-list-sources-research.md). The framework phase (PLAN-043)
// generalizes to a provider registry; the column leaves room for Hardcover/Trakt without a type change.
export const INTEGRATION_PROVIDERS = ['goodreads'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

// A linked integration's lifecycle status (user_integrations.status). 'linked' = actively synced;
// 'unlinked' = the user removed it (row retained for audit; re-link flips it back to 'linked'); 'error'
// = the last sync could not reach / parse the public shelf (last_sync_error carries the human message).
export const INTEGRATION_STATUSES = ['linked', 'unlinked', 'error'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

// ADR-057 (PLAN-045 — all shelves acquire, owner ruling A1-overruled). The Goodreads shelves a linked
// integration syncs, in CANONICAL order (the chip/filter order + the request-attribution priority when one
// book sits on several shelves). The first three are Goodreads BUILT-IN exclusive shelves (they exist on
// every account, even empty); 'did-not-finish' is the conventional CUSTOM shelf slug — absent on most
// accounts, so the sync tolerates a 404 for it (A3) and the UI populated-value-gates its chip. This is the
// user_integrations.shelves DEFAULT (jsonb string[], no CHECK — a future provider phase may carry other
// slugs); migration 0047 backfills existing want-shelf-only rows.
export const GOODREADS_SHELVES = ['to-read', 'currently-reading', 'read', 'did-not-finish'] as const;
export type GoodreadsShelf = (typeof GOODREADS_SHELVES)[number];

// A book_requests per-FORMAT status (book_requests.ebook_status / audio_status / comic_status). Books queue
// BOTH ebook+audio formats (owner ruling — "we grab both so it's one for all"); a COMIC request (ADR-056 /
// PLAN-046) tracks the SINGLE comic_status instead (comics are Kapowarr's domain, never LazyLibrarian's).
// Each format tracks its own lifecycle:
//   requested — minted locally from an unmatched shelf want; not yet pushed to LazyLibrarian / Kapowarr.
//   wanted    — books: pushed to LL + monitored Wanted (addBook → queueBook → searchBook). comics: the volume
//               is added + MONITORED in Kapowarr. The *arr "Missing" analog: monitored, searching, not on disk.
//   grabbed   — books: LL reports a release Snatched. comics: some of the volume's issues are downloading.
//   landed    — the format Open/Have in LL OR it appears in our books_items mirror; comics: all issues on disk.
//   missing   — could not obtain the format (LL Skipped/Ignored; comics: no ComicVine match / search exhausted).
//               The per-format Missing entry that supports the manual "Search again" (R3 — the *arr idiom).
export const BOOK_REQUEST_STATUSES = [
  'requested',
  'wanted',
  'grabbed',
  'landed',
  'missing',
] as const;
export type BookRequestStatus = (typeof BOOK_REQUEST_STATUSES)[number];

// The FORMATS a request tracks. Books queue ebook+audiobook (always both); a COMIC (ADR-056 / PLAN-046) is a
// third routed format tracked by book_requests.comic_status + routed to KAPOWARR (never LL — the ebook/audio
// LL push is skipped for a comic). The comic leg has no DB CHECK referencing this const (comic_status reuses
// BOOK_REQUEST_STATUSES); this array documents the three request formats + gates the manual-search dispatch.
export const BOOK_REQUEST_FORMATS = ['ebook', 'audiobook', 'comic'] as const;
export type BookRequestFormat = (typeof BOOK_REQUEST_FORMATS)[number];

// ADR-065 / DESIGN-036 (PLAN-050) — WHO minted a book_requests row:
//   goodreads — a user's shelf want (the ADR-055 path; shelf_item_id/integration_id NOT NULL).
//   pairing   — the ESTATE's system want for an unpaired library title's missing format (no user, no
//               shelf; pairing_books_item_id names the anchor library item). The origin↔keys coherence
//               is CHECK-enforced (migration 0054).
export const BOOK_REQUEST_ORIGINS = ['goodreads', 'pairing'] as const;
export type BookRequestOrigin = (typeof BOOK_REQUEST_ORIGINS)[number];

// ADR-065 C-02 — HOW a books_format_pairs row was matched. v1 has exactly the conservative
// normalized-title + author-agreement matcher; an identifier-backed matcher (ISBN/ASIN — DESIGN-036
// Q-02) would join this const + relax the CHECK.
export const FORMAT_PAIR_MATCH_KINDS = ['title_author'] as const;
export type FormatPairMatchKind = (typeof FORMAT_PAIR_MATCH_KINDS)[number];
