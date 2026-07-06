// @hnet/plex — typed Plex adapters for library self-service (ADR-017 / DESIGN-007; BC-04 ACL:
// external PMS/plex.tv models never leak past this package's zod schemas).
//
// Entrypoints (D-03 read/write split, per ADR-011's enforceability requirement — same as
// @hnet/arr):
//   @hnet/plex        — config, typed errors, schema types, the XML reader (safe everywhere)
//   @hnet/plex/read   — read clients (registry refresh, share-orchestration base reads)
//   @hnet/plex/write  — the sharing write client (ONLY packages/domain share orchestrator)
export * from './errors';
export * from './config';
export * from './schemas';
export { parseXml, childrenNamed, type XmlElement } from './xml';
