// ADR-027 / DESIGN-004 D-15 (PLAN-010) — the Message-of-the-Day tRPC surface. One read for EVERY
// authed user (the dashboard banner) plus admin-only compose/prefill/clear. Every write delegates to
// an @hnet/domain single-writer that co-writes its `update_app_setting` permission_audit row in the
// same transaction (the no-direct-writes guard enforces this) — MOTD reuses the audited app_settings
// store, so no new table and no bespoke audit action (ADR-027 / Open decision #1).
import { z } from 'zod';
import { MOTD_SEVERITIES } from '@hnet/db';
import { clearMotd, getActiveMotd, getMotd, setMotd } from '@hnet/domain';
import { authedProcedure, mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

/** An ISO-8601 instant (the admin page converts its datetime-local field to UTC ISO before sending);
 *  lenient on exact shape so any Date-parseable value passes, strict enough to reject junk. */
const isoInstant = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid date/time.');

/** MotdInput (DESIGN-004 D-15/D-17): message 1..500 (a sanitized-markdown subset since D-17 — the
 *  raise from 280 keeps a [text](https://…) link from eating the budget; rendering is React-element
 *  only, so the string itself needs no extra validation), severity from MOTD_SEVERITIES, optional
 *  window with a startsAt <= endsAt refine. Timestamps are optional + nullable (null clears a bound). */
export const MotdInput = z
  .object({
    message: z.string().trim().min(1).max(500),
    severity: z.enum(MOTD_SEVERITIES),
    enabled: z.boolean(),
    startsAt: isoInstant.nullish(),
    endsAt: isoInstant.nullish(),
  })
  .refine((v) => !v.startsAt || !v.endsAt || Date.parse(v.startsAt) <= Date.parse(v.endsAt), {
    message: 'The start must be on or before the end.',
    path: ['endsAt'],
  });

export const motdRouter = router({
  /** The active MOTD (enabled + within its optional window) or null — read by every user's dashboard. */
  getActive: authedProcedure.query(({ ctx }) => getActiveMotd(ctx.db)),

  /** The raw stored record for the admin compose-form prefill (disabled/empty when never set). */
  get: adminProcedure.query(({ ctx }) => getMotd(ctx.db)),

  /** Compose/enable the MOTD (audited via app_settings single-writer). */
  set: adminProcedure.input(MotdInput).mutation(({ ctx, input }) =>
    mapDomainErrors(() =>
      setMotd({
        db: ctx.db,
        message: input.message,
        severity: input.severity,
        enabled: input.enabled,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        actorId: ctx.user.id,
      }),
    ),
  ),

  /** Clear the MOTD — flips enabled off (audited); the banner disappears immediately. */
  clear: adminProcedure.mutation(({ ctx }) =>
    mapDomainErrors(() => clearMotd({ db: ctx.db, actorId: ctx.user.id })),
  ),
});
