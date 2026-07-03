// DESIGN-003 D-06 — the root router.
import { router } from '../trpc';
import { profileRouter } from './profile';
import { catalogRouter } from './catalog';
import { usersRouter } from './users';
import { tagsRouter } from './tags';

export const appRouter = router({
  profile: profileRouter,
  catalog: catalogRouter,
  users: usersRouter,
  tags: tagsRouter,
  // RESERVED router names — do not repurpose:
  //   ledger, fix   → Phase 2 (R-40..R-52)
  //   plex          → Phase 3 (R-25..R-28)
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from '../trpc';
