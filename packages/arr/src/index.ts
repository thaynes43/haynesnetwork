// @hnet/arr — typed Sonarr/Radarr/Lidarr/Seerr adapters (DESIGN-005 D-18; BC-03 ACL:
// external *arr/Seerr models never leak past this package's zod schemas).
//
// Entrypoints (D-18 read/write split, per ADR-008's enforceability requirement):
//   @hnet/arr        — config, typed errors, schema types (safe everywhere)
//   @hnet/arr/read   — read clients (sync, ledger.children, restore.diff)
//   @hnet/arr/write  — write clients (ONLY packages/domain fix/restore writers)
export * from './errors';
// DESIGN-049 D-01 — the credential redactors the errors use (reusable by any caller that logs a URL).
export * from './redact';
export * from './config';
export * from './schemas/index';
