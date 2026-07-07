// DESIGN-003 D-06 — the root router.
import { router } from '../trpc';
import { profileRouter } from './profile';
import { catalogRouter } from './catalog';
import { usersRouter } from './users';
import { rolesRouter } from './roles';
import { ledgerRouter } from './ledger';
import { ledgerAdminRouter } from './ledger-admin';
import { fixRouter } from './fix';
import { restoreRouter } from './restore';
import { plexRouter } from './plex';
import { trashRouter } from './trash';
import { communicationRouter } from './communication';

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
  restore: restoreRouter,
  // Phase 3 (ADR-017 / DESIGN-007 D-05): Plex library self-service.
  plex: plexRouter,
  // ADR-023 / DESIGN-010 (PLAN-006): the Trash section — Maintainerr-backed deletion UI,
  // section-gated view + per-action grants.
  trash: trashRouter,
  // ADR-026 / DESIGN-012 (PLAN-009): the Bulletin section — aggregated notification Feed +
  // user Messages board, section-gated read + per-action post/moderate grants.
  communication: communicationRouter,
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from '../trpc';
