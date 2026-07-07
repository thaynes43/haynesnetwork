// @hnet/api — the tRPC v11 surface (ADR-004, DESIGN-003). Context reads the Better
// Auth session; the procedure ladder is publicProcedure → authedProcedure →
// adminProcedure; every permission-touching mutation delegates to @hnet/domain
// helpers that co-write permission_audit rows in the same transaction.
export { appRouter, type AppRouter, createCallerFactory } from './routers/index';
export { createTRPCContext, mapDomainErrors, type SessionUser, type TRPCContext } from './trpc';
export {
  catalogUrlSchema,
  CatalogEntryInput,
  CatalogEntryPatchInput,
  RoleInput,
  RolePatchInput,
  PlexLibraryInput,
  RoleLibrariesInput,
  RefreshRegistryInput,
} from './schemas';
export { resolvePlexBundle } from './trpc';
export { SectionPermissionInput, TrashActionsInput } from './schemas';
// ADR-023 — the Trash section gates the UX/nav reads on (server-authoritative).
export { hasTrashAction, trashActionProcedure } from './middleware/role';
// ADR-019 / DESIGN-008 — the poster-proxy upstream resolver (used by the app poster route).
export { resolvePosterUpstream, type PosterUpstream } from './poster';
// ADR-021 — the section-level resolver the nav + the Ledger export route gate on (server-authoritative).
export { effectiveSectionLevel } from './middleware/role';
// ADR-022 / DESIGN-009 D-06 — the emergency Ledger JSONL export (used by the app export route).
export {
  buildExportFilterFromParams,
  streamLedgerExportRows,
  type LedgerExportRow,
} from './ledger-export';
export type { MyApp } from './routers/catalog';
export type { MyServer, MyLibrary } from './routers/plex';
