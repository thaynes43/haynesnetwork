// ADR-062 / DESIGN-033 D-06 (PLAN-041) — the books Fix router. `create` fires the audited
// single-writer THEN the acquisition orchestrator (outside the tx); `progress` joins the fix row
// with the live ADR-059 Activity item status (the wanted-detail idiom — books have no per-grab
// meter; the honest signal is searching → fired → next-reconcile). Gate: bookActionProcedure
// ('fix_book') — Admin-only until the owner's Q-01 all-roles flip.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  BOOK_FIX_REASONS,
  type BookFixRequestRow,
} from '@hnet/db';
import {
  createBookFixRequest,
  getBookFix,
  listBookFixes,
  runBookFixRequest,
} from '@hnet/domain';
import {
  mapDomainErrors,
  resolveGoogleBooksClient,
  resolveKapowarrBundle,
  resolveLazyLibrarianBundle,
  router,
} from '../trpc';
import { adminProcedure, bookActionProcedure } from '../middleware/role';

function fixWire(row: BookFixRequestRow) {
  return {
    id: row.id,
    booksItemId: row.booksItemId,
    title: row.titleSnapshot,
    mediaKind: row.mediaKind,
    route: row.route,
    reason: row.reason,
    reasonText: row.reasonText,
    status: row.status,
    staleFileAction: row.staleFileAction,
    llBookId: row.llBookId,
    kapowarrVolumeId: row.kapowarrVolumeId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export const bookFixRouter = router({
  /**
   * File a books Fix: the audited row commits first (crash-safety), then the re-grab fires. The
   * response carries the post-orchestration status so the client renders the fired/failed chip
   * immediately (books have no *arr live meter — DESIGN-033 D-08).
   */
  create: bookActionProcedure('fix_book')
    .input(
      z
        .object({
          booksItemId: z.uuid(),
          reason: z.enum(BOOK_FIX_REASONS),
          reasonText: z.string().trim().min(1).max(1000).optional(),
          languagePref: z.string().trim().min(2).max(40).optional(),
        })
        .refine((v) => (v.reason === 'other') === (v.reasonText !== undefined), {
          message: 'reasonText is required exactly when reason is "other"',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const row = await createBookFixRequest({
          db: ctx.db,
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role.isAdmin,
          booksItemId: input.booksItemId,
          reason: input.reason,
          reasonText: input.reasonText ?? null,
          languagePref: input.languagePref ?? null,
        });
        const result = await runBookFixRequest({
          db: ctx.db,
          fix: row,
          ll: resolveLazyLibrarianBundle(ctx),
          kapowarr: resolveKapowarrBundle(ctx),
          gb: resolveGoogleBooksClient(ctx),
        });
        const fresh = await getBookFix({ db: ctx.db, fixId: row.id });
        return fixWire(fresh ?? { ...row, status: result.status as BookFixRequestRow['status'] });
      });
    }),

  /** One fix (own or admin) — the detail page's poll target alongside activity.itemStatus. */
  progress: bookActionProcedure('fix_book')
    .input(z.object({ fixId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await getBookFix({ db: ctx.db, fixId: input.fixId });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' });
      if (row.requesterId !== ctx.user.id && !ctx.user.role.isAdmin) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return fixWire(row);
    }),

  /** The caller's fixes, newest-first (fix.myFixes parity). */
  myFixes: bookActionProcedure('fix_book').query(async ({ ctx }) => {
    const rows = await listBookFixes({ db: ctx.db, requesterId: ctx.user.id, limit: 50 });
    return { fixes: rows.map(fixWire) };
  }),

  /** Every fix (admin triage). */
  adminList: adminProcedure.query(async ({ ctx }) => {
    const rows = await listBookFixes({ db: ctx.db, limit: 100 });
    return { fixes: rows.map(fixWire) };
  }),
});
