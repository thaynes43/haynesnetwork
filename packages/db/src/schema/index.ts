export * from './enums';
export * from './roles';
export * from './role-app-grants';
// ADR-021 / DESIGN-009 — section-level role permissions (Ledger + reserved Trash)
export * from './role-section-permissions';
// ADR-023 / DESIGN-010 — Trash (Maintainerr) fine-grained per-action role grants
export * from './role-trash-action-grants';
// ADR-026 / DESIGN-012 — Bulletin (Messages) fine-grained per-action role grants
export * from './role-message-action-grants';
// ADR-049 / DESIGN-012 amend (PLAN-027) — Bulletin SUB-VIEW visibility grants (Feed vs Messages)
export * from './role-bulletin-view-grants';
export * from './users';
export * from './session';
export * from './account';
export * from './verification';
export * from './user-role-transitions';
export * from './app-catalog';
export * from './permission-audit';
export * from './media-items';
// ADR-018 / DESIGN-008 Phase 4 — harvested descriptive/quality metadata (1:1 sibling of media_items)
export * from './media-metadata';
export * from './ledger-events';
export * from './wanted-items';
export * from './fix-requests';
export * from './restore-runs';
export * from './sync-runs';
export * from './sync-state';
// ADR-017 / DESIGN-007 Phase 3 — Plex library self-service (BC-04 registry + role grants + share ledger)
export * from './plex-servers';
export * from './plex-libraries';
export * from './role-library-grants';
// ADR-024 — role-scoped all-libraries-on-server grants (sits alongside role-library-grants)
export * from './role-plex-server-all-grants';
export * from './plex-share-audit';
// ADR-023 / DESIGN-010 (addendum c) — generic in-app notification store (Maintainerr source #1);
// ADR-026 / DESIGN-012 (PLAN-009) widens it (Seerr + Tautulli) into the durable Bulletin Feed store
export * from './notifications';
// ADR-050 / DESIGN-012 D-10 (PLAN-034) — Bulletin Helpdesk tickets (state machine + event history
// + reply thread; replaced the ADR-026 Messages board — `messages` dropped in migration 0040)
export * from './tickets';
// ADR-025 / DESIGN-011 — Trash curation pipeline: generic app settings + batches/items/save events
export * from './app-settings';
export * from './trash-batches';
export * from './trash-batch-items';
export * from './trash-batch-saves';
export * from './trash-candidates';
// DESIGN-010/014 amendment (2026-07-09) — the debounced pool-refresh-after-save marker (pending_pool_refresh)
export * from './pending-pool-refresh';
// ADR-034 / DESIGN-015 (PLAN-016) — the Pushover notification outbox (transactional; drained by the
// notify-outbox sync mode). Enqueued same-tx by the batch writers; guarded single-writer table.
export * from './notification-outbox';
// ADR-040 / DESIGN-020 (PLAN-019) — the per-drive last-known SMART state the smart-alerts sync mode
// diffs against for transition detection. Guarded single-writer table (evaluateSmartAlerts).
export * from './smart-drive-state';
// ADR-043 / DESIGN-021 (PLAN-024) — the append-only Peloton poster apply ledger the poster-guard sync
// mode writes (drift baseline + audit). Guarded single-writer table (runPelotonPosterGuard).
export * from './poster-guard-applications';
// ADR-044 / DESIGN-022 (PLAN-021) — the synced Open WebUI chat-usage mirror the ai-usage-sync mode
// upserts (the Metrics → AI sub-tab's substrate). Guarded single-writer table (syncAiUsage).
export * from './ai-usage-chats';
// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik role portal: the synced Authentik-directory mirror
// (authentik-users sync), the parked role intents for Authentik-only identities (consumed on first
// login), and the append-only external group-write ledger. All guarded single-writer tables.
export * from './authentik-users';
export * from './pending-role-assignments';
export * from './authentik-group-audit';
// ADR-046 / DESIGN-024 (PLAN-023) — the books LEDGER: the synced Kavita + Audiobookshelf mirror the
// Library Books/Audiobooks/Comics walls read (books-sync mode). Guarded single-writer table (syncBooks).
export * from './books-items';
// ADR-047 / DESIGN-025 (PLAN-028) — the *arr → Plex match cache: per media_item {plex_library, ratingKey}
// resolved by shared-GUID match (plex-match mode). The Library access gate + "Watch on Plex" deep-link
// substrate. Guarded single-writer table (syncPlexMatches).
export * from './plex-match';
// ADR-064 / DESIGN-035 (PLAN-037) — the mirrored Plex collections: one row per HOps collection +
// its RAW membership (collections-sync mode). External software is always the collections source of
// truth (owner doctrine R1); guarded single-writer tables (syncPlexCollections), no audit — the
// media_plex_matches derived-cache class.
export * from './plex-collections';
// ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor's single-row gate state the mam-governor
// sync mode upserts (the LL MAM-provider gate + the counts/limit that drove it). Guarded single-writer
// table (evaluateMamGovernor); its transition trail is the notification_outbox rows (smart-alerts class).
export * from './mam-gate-state';
// ADR-052 / DESIGN-026 D-06 (PLAN-029) — the per-user, per-wall Library preferences (last view +
// group-by + sort). First per-user store; guarded single-writer table (setLibraryPreference), no audit.
export * from './library-preferences';
// ADR-060 C-05 / DESIGN-031 D-01 (PLAN-035) — the per-user notification opt-ins (first field:
// email_ticket_updates). Guarded single-writer table (setNotificationPreference), no audit —
// the library_preferences class.
export * from './notification-preferences';
// ADR-053 / DESIGN-026 D-07 (PLAN-029) — the per-user watch/read-state seam: the app-user↔account
// mapping (user_account_map), the per-user video watch read-model (user_media_watch), and the per-user
// ABS book read-state (user_book_progress). All guarded single-writer tables (no audit — synced/
// descriptive, the media_metadata class). ADDITIVE — the household aggregates on media_metadata stay.
export * from './user-account-map';
export * from './user-media-watch';
export * from './user-book-progress';
// ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the Integration tables: one row per
// (user, provider) link (user_integrations), the synced shelf-RSS mirror (integration_shelf_items), and
// the request / Missing ledger tracking both formats (book_requests). All guarded single-writer tables;
// user link/unlink + manual re-search are audited (permission_audit), sync-driven writes are not.
export * from './user-integrations';
export * from './integration-shelf-items';
export * from './book-requests';
// ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook pairing) — the FORMAT PAIR derived cache: one row
// per conservatively-matched Kavita-book ⇄ ABS-audiobook pair (format-pairing mode). The dual consume
// buttons, the coverage badge, and the pairing-want mint all read it. Guarded single-writer table
// (syncFormatPairs); rebuildable, no audit — the media_plex_matches class.
export * from './books-format-pairs';
// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the fine-grained Activity ACTION grants (the
// role_trash_action_grants idiom, ADR-023; single-writer setRoleActivityActions, audited) and the DURABLE
// import-failure ledger the `activity-scan` sync mode upserts (the ONLY persisted activity state — the tab
// + wall badges read LIVE per ADR-059 Q-01). Guarded single-writer table (evaluateActivityFailures); its
// transition trail is the notification_outbox rows (the mam_gate_state / smart-alerts class).
export * from './role-activity-action-grants';
export * from './activity-import-failures';
// ADR-062 / DESIGN-033 (PLAN-041 — books Fix) — the audited landed-bad-copy fix aggregate + the
// fine-grained books action grants (fix_book — Admin-only until the Q-01 all-roles flip). Both
// guarded single-writer tables (createBookFixRequest / setRoleBookActions).
export * from './book-fix-requests';
export * from './role-books-action-grants';
