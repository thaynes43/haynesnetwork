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
export type { MyApp } from './routers/catalog';
export type { MyServer, MyLibrary } from './routers/plex';
