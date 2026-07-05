// @hnet/domain — the ONLY allowed write path to role/permission tables (DESIGN-001
// D-12, CLAUDE.md hard rule 6) and to the Phase 2 media-ledger tables (DESIGN-005
// D-12). Every helper mutates and writes its audit row in one transaction; a CI guard
// test forbids direct writes from anywhere else.
export * from './errors';
export * from './url-assert';
export * from './roles';
export * from './catalog';
export * from './effective-apps';
// DESIGN-005 Phase 2 — media ledger single-writers (D-12)
export * from './sync-runs';
export * from './media-sync';
export * from './ledger-ingest';
export * from './fix-requests';
export * from './restore-runs';
// DESIGN-005 Phase 2 — fix/restore orchestration over @hnet/arr (D-15/D-16; the
// mutating *arr surface stays confined to this package — D-12/D-18 guard test)
export * from './arr-clients';
export * from './action-scope';
export * from './media-children';
export * from './fix-flow';
export * from './search-requests';
export * from './search-flow';
export * from './restore-flow';
