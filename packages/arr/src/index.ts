// @hnet/arr — typed Sonarr/Radarr/Lidarr/Seerr adapters (DESIGN-005 D-18; BC-03 ACL:
// external *arr/Seerr models never leak past this package's zod schemas).
//
// Entrypoints (D-18 read/write split, per ADR-008's enforceability requirement):
//   @hnet/arr        — config, typed errors, schema types (safe everywhere)
//   @hnet/arr/read   — read clients (sync, ledger.children, restore.diff)
//   @hnet/arr/write  — write clients (ONLY packages/domain fix/restore writers)
export * from './errors';
export * from './config';
export * from './schemas/index';
