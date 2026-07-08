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
// ADR-026 / DESIGN-012 — Bulletin: message action grants + the Messages board single-writers
export * from './message-permissions';
export * from './messages';
// ADR-023 / DESIGN-010 — Trash orchestrators over Maintainerr (confined write surface — guard test)
export * from './maintainerr-clients';
export * from './trash-flow';
// ADR-025 / DESIGN-011 — Trash curation pipeline: generic app settings + batch state machine
export * from './app-settings';
export * from './trash-batches';
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
