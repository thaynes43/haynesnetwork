export * from './enums';
export * from './roles';
export * from './role-app-grants';
// ADR-021 / DESIGN-009 — section-level role permissions (Ledger + reserved Trash)
export * from './role-section-permissions';
// ADR-023 / DESIGN-010 — Trash (Maintainerr) fine-grained per-action role grants
export * from './role-trash-action-grants';
// ADR-026 / DESIGN-012 — Bulletin (Messages) fine-grained per-action role grants
export * from './role-message-action-grants';
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
// ADR-026 / DESIGN-012 — Bulletin Messages board (user-posted durable board entries)
export * from './messages';
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
