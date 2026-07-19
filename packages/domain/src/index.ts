// @hnet/domain — the ONLY allowed write path to role/permission tables (DESIGN-001
// D-12, CLAUDE.md hard rule 6) and to the Phase 2 media-ledger tables (DESIGN-005
// D-12). Every helper mutates and writes its audit row in one transaction; a CI guard
// test forbids direct writes from anywhere else.
export * from './errors';
export * from './url-assert';
export * from './roles';
export * from './catalog';
export * from './effective-apps';
// ADR-021 / DESIGN-009 — section-level role permissions (Ledger + reserved Trash) single-writer
export * from './section-permissions';
// ADR-037 / DESIGN-016 (PLAN-017) — the per-role metrics access level (full|limited) single-writer
export * from './metrics-level';
// ADR-023 / DESIGN-010 — Trash (Maintainerr) fine-grained action grants + the notification store
export * from './trash-permissions';
export * from './notifications';
// ADR-026 / DESIGN-012 — Bulletin: message action grants (post/moderate — since PLAN-034 they gate
// the Helpdesk: create tickets / drive ticket transitions)
export * from './message-permissions';
// ADR-049 / DESIGN-012 amend (PLAN-027) — Bulletin SUB-VIEW (feed/messages) visibility single-writer
export * from './bulletin-view-permissions';
// ADR-050 / DESIGN-012 D-10..D-13 (PLAN-034) — the Helpdesk ticket single-writers (replaced the
// ADR-026 Messages board writers; `messages` dropped in migration 0040)
export * from './tickets';
// ADR-023 / DESIGN-010 — Trash orchestrators over Maintainerr (confined write surface — guard test)
export * from './maintainerr-clients';
export * from './trash-flow';
// ADR-035 / DESIGN-010 amendment — the Trash candidate read-model (snapshot refresher + the
// snapshot-backed pending page/candidates/count reads; single writer for trash_candidates*)
export * from './trash-candidates';
// ADR-025 / DESIGN-011 — Trash curation pipeline: generic app settings + batch state machine
export * from './app-settings';
// DESIGN-014 amendment (build D) — the shared batch-selection ranking (walls' "Next up" = the batch pick)
export * from './trash-strategy';
export * from './trash-batches';
// DESIGN-010/014 amendment (build D) — debounced post-save Maintainerr rule re-execution + the honest
// pool re-evaluation cadence surfaced on the walls.
export * from './pool-refresh';
export * from './pool-cadence';
// ADR-034 / DESIGN-015 (PLAN-016) — Pushover batch-lifecycle notifications: delivery-window math +
// the transactional outbox (enqueue same-tx from the batch writers; drained by the notify-outbox mode)
export * from './notify-window';
export * from './notify-outbox';
// ADR-040 / DESIGN-020 (PLAN-019) — the SMART-alert transition detector + single-writer (the
// smart-alerts sync mode enqueues a smart_degraded/smart_recovered outbox row same-tx with the
// smart_drive_state update; baseline-on-first-sight never pages the known bad state).
export * from './smart-alerts';
// ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor: cap-aware torrent-fallback pacer +
// single-writer (the mam-governor sync mode counts unsatisfied torrents in qBittorrent and toggles the
// MyAnonaMouse Prowlarr indexer's enable flag near the rank cap; enqueues a gate-transition outbox row
// same-tx with the mam_gate_state upsert). The Prowlarr WRITE surface @hnet/downloads/write stays confined
// to this package (guard test). resolveGovernorConfig is the PLAN-040 limit/buffer seam.
export * from './mam-governor';
export * from './mam-clients';
// DESIGN-010 amendment — the Trash Overview landing aggregate (composes the reads above)
export * from './trash-overview';
export * from './storage-metrics';
// ADR-031 / DESIGN-014 (PLAN-014) — space-driven policy (propose-only) + rules-tuning report
export * from './space-policy';
export * from './trash-tuning';
// ADR-027 / DESIGN-004 D-15 (PLAN-010) — Message-of-the-Day: reader + single-writers over app_settings
export * from './motd';
// DESIGN-005 Phase 2 — media ledger single-writers (D-12)
export * from './sync-runs';
export * from './media-sync';
// ADR-018 / DESIGN-008 Phase 4 — metadata harvest single-writer + *arr-tag semantics (D-12/D-07)
export * from './media-metadata';
// ADR-052 / DESIGN-026 D-06 (PLAN-029) — per-user Library preferences store + URL-precedence resolver.
export * from './library-preferences';
export * from './notification-preferences';
export * from './book-fix';
export * from './book-force-search';
// ADR-067 / DESIGN-039 (PLAN-055) — the shared Google Books quota circuit breaker (single-row
// gb_quota_state single-writers + the guardedGbResolve seam every GB call site consults).
export * from './gb-quota-breaker';
// ADR-053 / DESIGN-026 D-07 (PLAN-029) — per-user watch/read-state seam: the app-user↔account mapping,
// the per-user video watch read-model, and the per-user ABS book read-state (single-writers, no audit).
export * from './user-account-map';
export * from './user-media-watch';
export * from './user-book-progress';
export * from './ledger-ingest';
export * from './fix-requests';
export * from './restore-runs';
// DESIGN-005 Phase 2 — fix/restore orchestration over @hnet/arr (D-15/D-16; the
// mutating *arr surface stays confined to this package — D-12/D-18 guard test)
export * from './arr-clients';
export * from './action-scope';
export * from './fix-reasons';
export * from './media-children';
export * from './fix-flow';
export * from './search-requests';
export * from './search-flow';
// ADR-071 owner ruling 2026-07-19 — the bulk movies/TV collection Force Search (fans out the per-item
// runForceSearch over a collection's missing members, capped; gated exactly as the per-item path).
export * from './collection-arr-search';
// ADR-028 / DESIGN-005 D-20 (PLAN-015) — the Action Feedback projection: derive live *arr
// action phases on demand from the queue + ledger milestones (read-only; no writes, no migration)
export * from './action-progress';
export * from './restore-flow';
// ADR-017 / DESIGN-007 Phase 3 — Plex library self-service single-writers + orchestrators
// (the mutating Plex surface @hnet/plex/write stays confined to this package — guard test).
export * from './plex-clients';
export * from './effective-allowed-libraries';
export * from './role-libraries';
export * from './plex-registry';
export * from './plex-shares';
// fix/plex-identity-mapping — the users.plex_email/plex_username override single-writer.
export * from './user-identity';
// ADR-043 / DESIGN-021 (PLAN-024) — the Peloton poster GUARD single-writer (drift-restore of durable
// override posters on k8plex; the confined @hnet/plex/write poster upload stays in this package).
export * from './poster-guard';
// ADR-044 / DESIGN-022 (PLAN-021) — the AI usage single-writer (syncAiUsage upserts the Open WebUI chat
// mirror) + the level-gated AI usage read model (getAiUsage) the Metrics → AI sub-tab renders.
export * from './ai-usage';
// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik role portal: the confined Authentik/OWUI client bundle,
// the group-portal write orchestrators (provisionSyncedTier / assignRolePortal / the owned-groups
// guardrail), and the directory mirror single-writer + /admin/users read model.
export * from './authentik-clients';
export * from './authentik-portal';
export * from './authentik-users';
// ADR-046 / DESIGN-024 (PLAN-023) — the books ledger single-writer (syncBooks upserts the synced Kavita +
// Audiobookshelf mirror books_items and tombstones vanished rows). READ-ONLY against the book servers.
export * from './books';
// ADR-047 / DESIGN-025 (PLAN-028) — the Library access GATE (resolveLibraryAccessGate — reuses the ADR-024
// effective-library resolver; THE INVARIANT) + the Plex deep-link builder, and the *arr→Plex match cache
// single-writer (syncPlexMatches, the plex-match sync mode's writer).
export * from './library-access';
export * from './plex-match';
// ADR-064 / DESIGN-035 (PLAN-037) — the mirrored Plex collections single-writer (syncPlexCollections,
// the collections-sync mode's writer). External software is always the collections source of truth.
export * from './plex-collections';
// ADR-066 / DESIGN-038 (PLAN-051) — the books collections mirror single-writer (syncBooksCollections,
// the books-collections-sync mode's writer). Kavita/ABS are always the collections source of truth;
// member refs resolve opportunistically against the fresh books_items mirror (run after books-sync).
export * from './books-collections';
// DESIGN-035 D-10' — the versioned label-driven category derivation (pure; the sync writer
// recomputes the plex_collections.category annotation from the collection's labels at every upsert).
export * from './collection-category';
// Collection PROVENANCE — "what software created this collection" (owner directive 2026-07-16). The
// pure derivation both collection syncs call at every upsert (Kometa labels / Libretto marker →
// created_by), plus the badge display mapping the API layer resolves for the walls.
export * from './collection-provenance';
// ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the Integration single-writers (link/unlink
// audited, shelf-mirror upsert, request mint/reconcile + audited manual re-search), the goodreads-sync
// orchestrator, and the confined LazyLibrarian client bundle (@hnet/lazylibrarian/write stays in this
// package — the arr-write-import-guard, extended for it).
export * from './user-integrations';
export * from './integration-shelf-items';
export * from './book-requests';
export * from './goodreads-sync';
// DESIGN-038 D-13 — the collection Wanted-tiles pass: Libretto-managed collections' missing members
// minted as origin='collection' book_requests (the books-collections-sync mode's Wanted-tile step).
export * from './collection-wants-sync';
// ADR-072 / DESIGN-043 D-14 (PLAN-052 PR4c) — the cron FORCE-SEARCH leg for the find-missing knob: the
// app-side acquisition that drives LazyLibrarian over a find-missing collection's origin='collection' wants.
export * from './collection-force-search';
// ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook pairing) — the conservative matcher, the
// books_format_pairs single-writer, and the PACED estate-wide system-want mint + run orchestrator
// (the format-pairing sync mode's body).
export * from './format-pairing';
export * from './lazylibrarian-clients';
// ADR-056 (PLAN-046 — Kapowarr comics acquisition) — the confined Kapowarr client bundle for comic routing +
// the comic force-search (@hnet/kapowarr/write stays in this package — the arr-write-import-guard, extended).
export * from './kapowarr-clients';
// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the source-agnostic read-model contract +
// aggregator, the BOOKS adapter (LazyLibrarian + SABnzbd), the durable failure-ledger single-writer +
// audited retry-import / force-research actions (the confined LL write stays in this package), and the
// fine-grained Activity action grant seam (setRoleActivityActions, the ADR-023 machinery).
export * from './activity';
export * from './activity-permissions';
// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the confined @hnet/libretto client bundle
// (@hnet/libretto/write stays in this package — the arr-write-import-guard, extended), the
// collections-manager orchestrator the tRPC layer fronts (overview / preview / upsert / apply / delete /
// materialize — direct-add, cap-gated, audited same-tx), the fine-grained collection action grants
// (setRoleCollectionActions — rebuilt to `find_missing`), and the over-cap ticket lifecycle
// (createCollectionOverrideTicket → approve materializes / decline; in tickets.ts, audited same-tx).
export * from './libretto-clients';
export * from './collections-manager';
export * from './collection-permissions';
export * from './collection-size-cap';
// ADR-072 / DESIGN-042 (PLAN-052 PR4b — Kometa auto-merge write path for Movies/TV) — the pure recipe →
// managed-include compiler, the confined @hnet/haynesops git-write bundle (@hnet/haynesops/write stays in
// this package — the arr-write-import-guard, extended), and the Kometa collections orchestrator (overview /
// direct-add + auto-merge / materialize / delete — mirror-only, audited same-tx).
export * from './kometa-compiler';
export * from './haynesops-clients';
export * from './kometa-collections';
// DESIGN-044 (collection builder page) — the search-first ref lookup + the live member preview split
// held/missing against the app's own mirrors (books_items / media_items). Read-only, confined-client only.
export * from './collection-builder';
