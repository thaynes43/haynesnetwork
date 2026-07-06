// DESIGN-003 D-06 — the root router.
import { router } from '../trpc';
import { profileRouter } from './profile';
import { catalogRouter } from './catalog';
import { usersRouter } from './users';
import { rolesRouter } from './roles';
import { ledgerRouter } from './ledger';
import { fixRouter } from './fix';
import { restoreRouter } from './restore';
import { plexRouter } from './plex';

export const appRouter = router({
  profile: profileRouter,
  catalog: catalogRouter,
  users: usersRouter,
  roles: rolesRouter,
  // Phase 2 (DESIGN-005 D-17): ledger + fix claim their DESIGN-003 reservations;
  // restore is the third Phase 2 name (recorded in DESIGN-003's reservation note).
  ledger: ledgerRouter,
  fix: fixRouter,
  restore: restoreRouter,
  // Phase 3 (ADR-017 / DESIGN-007 D-05): Plex library self-service.
  plex: plexRouter,
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from '../trpc';
