// DESIGN-003 D-06 — profile router.
import { z } from 'zod';
import { getNotificationPreference, setNotificationPreference } from '@hnet/domain';
import { authedProcedure, router } from '../trpc';

export const profileRouter = router({
  /**
   * Session identity for chrome (topbar name, admin link via role.isAdmin).
   * Deliberately does NOT include the app list — the dashboard uses catalog.myApps so
   * tile data has exactly one source (D-05).
   */
  me: authedProcedure.query(({ ctx }) => ctx.user), // { id, email, displayName, role: { id, name, isAdmin } }

  /**
   * ADR-060 / DESIGN-031 D-06 (PLAN-035) — the caller's OWN notification opt-ins (R-196). No
   * section gate: it is the user's own descriptive preference (the library-preferences exposure
   * precedent). Defaults (no row) read as everything OFF.
   */
  notificationPreference: authedProcedure.query(({ ctx }) =>
    getNotificationPreference({ db: ctx.db, userId: ctx.user.id }),
  ),

  /** Upsert the caller's notification opt-ins (the `setNotificationPreference` single-writer). */
  setNotificationPreference: authedProcedure
    .input(z.object({ emailTicketUpdates: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setNotificationPreference({
        db: ctx.db,
        userId: ctx.user.id,
        emailTicketUpdates: input.emailTicketUpdates,
      }),
    ),
});
