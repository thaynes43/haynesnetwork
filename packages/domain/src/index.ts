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
// ADR-023 / DESIGN-010 — Trash (Maintainerr) fine-grained action grants + the notification store
export * from './trash-permissions';
export * from './notifications';
// ADR-023 / DESIGN-010 — Trash orchestrators over Maintainerr (confined write surface — guard test)
export * from './maintainerr-clients';
export * from './trash-flow';
// ADR-025 / DESIGN-011 — Trash curation pipeline: generic app settings + batch state machine
export * from './app-settings';
export * from './trash-batches';
// DESIGN-005 Phase 2 — media ledger single-writers (D-12)
export * from './sync-runs';
export * from './media-sync';
// ADR-018 / DESIGN-008 Phase 4 — metadata harvest single-writer + *arr-tag semantics (D-12/D-07)
export * from './media-metadata';
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
export * from './restore-flow';
// ADR-017 / DESIGN-007 Phase 3 — Plex library self-service single-writers + orchestrators
// (the mutating Plex surface @hnet/plex/write stays confined to this package — guard test).
export * from './plex-clients';
export * from './effective-allowed-libraries';
export * from './role-libraries';
export * from './plex-registry';
export * from './plex-shares';
