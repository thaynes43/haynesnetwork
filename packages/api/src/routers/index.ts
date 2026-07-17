// DESIGN-003 D-06 — the root router.
import { router } from '../trpc';
import { profileRouter } from './profile';
import { catalogRouter } from './catalog';
import { usersRouter } from './users';
import { rolesRouter } from './roles';
import { ledgerRouter } from './ledger';
import { ledgerAdminRouter } from './ledger-admin';
import { fixRouter } from './fix';
import { bookFixRouter } from './book-fix';
import { restoreRouter } from './restore';
import { plexRouter } from './plex';
import { trashRouter } from './trash';
import { communicationRouter } from './communication';
import { motdRouter } from './motd';
import { storageRouter } from './storage';
import { metricsRouter } from './metrics';
import { ytdlsubRouter } from './ytdlsub';
import { booksRouter } from './books';
import { libraryRouter } from './library';
import { authentikPortalRouter } from './authentik-portal';
import { integrationsRouter } from './integrations';
import { activityRouter } from './activity';
import { collectionsRouter } from './collections';

export const appRouter = router({
  profile: profileRouter,
  catalog: catalogRouter,
  users: usersRouter,
  roles: rolesRouter,
  // Phase 2 (DESIGN-005 D-17): ledger + fix claim their DESIGN-003 reservations;
  // restore is the third Phase 2 name (recorded in DESIGN-003's reservation note).
  ledger: ledgerRouter,
  // ADR-021/022 / DESIGN-009 (PLAN-005): the Ledger section — section-gated browse/export/bulk.
  ledgerAdmin: ledgerAdminRouter,
  fix: fixRouter,
  // ADR-062 / DESIGN-033 (PLAN-041) — the books/audiobooks/comics Fix.
  bookFix: bookFixRouter,
  restore: restoreRouter,
  // Phase 3 (ADR-017 / DESIGN-007 D-05): Plex library self-service.
  plex: plexRouter,
  // ADR-023 / DESIGN-010 (PLAN-006): the Trash section — Maintainerr-backed deletion UI,
  // section-gated view + per-action grants.
  trash: trashRouter,
  // ADR-026 / DESIGN-012 (PLAN-009): the Bulletin section — aggregated notification Feed +
  // user Messages board, section-gated read + per-action post/moderate grants.
  communication: communicationRouter,
  // ADR-027 / DESIGN-004 D-15 (PLAN-010): the dashboard Message-of-the-Day banner — admin compose/
  // clear over the audited app_settings store, one authed read for every user's dashboard.
  motd: motdRouter,
  // ADR-030 / DESIGN-013 (PLAN-013): the Storage metrics surface — admin-gated disk utilization
  // (*arr /diskspace) + reclaim attribution (PG deletion snapshots) + per-server space targets.
  storage: storageRouter,
  // ADR-037 / DESIGN-016 (PLAN-017): the Metrics section — member-facing Overview (WAN usage-vs-
  // capacity + cluster load/memory + storage snapshot), per-role Full/Limited level, audited capacities.
  metrics: metricsRouter,
  // ADR-038 / DESIGN-017 (PLAN-022): the ytdl-sub Library sub-tabs — Peloton + YouTube read DIRECTLY from
  // the k8plex Plex server (no ledger sync), gated by the `ytdlsub` section (ships Admin-only).
  ytdlsub: ytdlsubRouter,
  // ADR-046 / DESIGN-024 (PLAN-023): the Books Library sub-tabs — Books/Audiobooks/Comics read from the
  // app-owned books_items ledger (synced from Kavita + Audiobookshelf), gated by the `books` section
  // (ships Admin-only). Read-only — no Fix/Restore for books (the book servers are the source of truth).
  books: booksRouter,
  // ADR-052 / DESIGN-026 (PLAN-029): the per-user Library preferences pair (library.preferences.get/set)
  // — server-side last view + sort per wall (URL overrides for shared links). Session-gated, own-row only.
  library: libraryRouter,
  // ADR-045 / DESIGN-023 (PLAN-026): the Authentik user/role portal — /admin/users directory (all
  // Authentik identities) + role assignment that writes owned Authentik group membership (+ OWUI tier
  // pre-create), admin-only, audited + import-confined.
  authentikPortal: authentikPortalRouter,
  // ADR-055 / DESIGN-028 (PLAN-044): the Integrations tab — link a PUBLIC Goodreads profile → shelf sync →
  // requests/Missing wall + coverage % + manual re-search. Gated by the `integrations` section (ships
  // Admin-only). Book requests push to LazyLibrarian (both formats, paced); comics parked out of LL.
  integrations: integrationsRouter,
  // ADR-059 / DESIGN-030 (PLAN-048): the Activity / In-Flight surface — the cross-library live pipeline
  // read (searching/downloading/importing/failed/completed) + the durable import-failure detail with
  // role-controlled retry-import / force-research. Always-on tab; the LIST resolver does per-section gating.
  activity: activityRouter,
  // ADR-069 / DESIGN-042 (PLAN-052): the collection manager — read/manage Libretto recipes + runs through
  // the confined @hnet/libretto client (manage/acquire grants, integrations-floored) + the member
  // propose→approve contribution flow (suggest grant, from the books walls). NEVER a browser Libretto call.
  collections: collectionsRouter,
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from '../trpc';
