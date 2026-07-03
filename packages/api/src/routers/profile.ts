// DESIGN-003 D-06 — profile router.
import { authedProcedure, router } from '../trpc';

export const profileRouter = router({
  /**
   * Session identity for chrome (topbar name, admin link, family badge).
   * Deliberately does NOT include the app list — the dashboard uses catalog.myApps so
   * tile data has exactly one source (D-05).
   */
  me: authedProcedure.query(({ ctx }) => ctx.user), // { id, email, displayName, role, isFamily }
});
