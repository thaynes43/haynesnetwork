// ADR-111 C-02 / ADR-112 C-02, C-03 / DESIGN-055 D-10, D-12 (PLAN-077 P3) — the Seerr Issue mirror's tRPC surface.
// Read-only toward Seerr: every read here is the app's own mirror (seerr_issues); nothing calls Seerr.
//   • `forItem` (any signed-in user): the reports on a title page, gated by the ADR-047 library access check; the
//     reporter's name only for admins (ADR-111 C-02).
//   • `adminList` (admin): every issue with its title, the linked repairs from the app's own records and the staff
//     note (D-12). No outcome is scored (ADR-112 C-01).
//   • `setStaffNote` (admin): "Mark fixed by hand" with a note naming the missing capability, or clear it; audited in
//     the same transaction by the domain single writer.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  ADMIN_SEERR_ISSUE_FILTERS,
  SEERR_ISSUE_NOTE_MAX,
  listSeerrIssuesForAdmin,
  seerrIssuesForItem,
  setSeerrIssueStaffNote,
} from '@hnet/domain';
import { authedProcedure, mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { itemAccessById, resolveLibraryAccessGate } from '../library-access';

const issueId = z.number().int().positive().max(2_147_483_647);

export const seerrIssuesRouter = router({
  /** D-10 — the title page's reports: open ones, plus the one a `/r/seerr/<id>` link arrived with. */
  forItem: authedProcedure
    .input(z.object({ mediaItemId: z.uuid(), arrivedIssueId: issueId.optional() }))
    .query(async ({ ctx, input }) => {
      // ADR-047 THE INVARIANT — nothing about a hidden title, not even that it was reported.
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      if (!(await itemAccessById(ctx.db, gate, input.mediaItemId))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.mediaItemId} not found` });
      }
      return seerrIssuesForItem({
        db: ctx.db,
        mediaItemId: input.mediaItemId,
        viewerUserId: ctx.user.id,
        viewerIsAdmin: ctx.user.role.isAdmin,
        arrivedIssueId: input.arrivedIssueId ?? null,
      });
    }),

  /** D-10 / D-12 — the admin list, newest first, with linked repairs and the staff note. */
  adminList: adminProcedure
    .input(
      z.object({
        filter: z.enum(ADMIN_SEERR_ISSUE_FILTERS).default('open'),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: issueId.nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = await listSeerrIssuesForAdmin({
        db: ctx.db,
        filter: input.filter,
        limit: input.limit,
        before: input.cursor ?? null,
      });
      return { items: page.items, nextCursor: page.nextBefore };
    }),

  /** D-12 — mark fixed by hand (a note is required), change the note, or clear both. */
  setStaffNote: adminProcedure
    .input(
      z
        .object({
          seerrIssueId: issueId,
          note: z.string().max(SEERR_ISSUE_NOTE_MAX).nullable(),
          fixedByHand: z.boolean(),
        })
        .refine((v) => !v.fixedByHand || (v.note ?? '').trim().length > 0, {
          message: 'Say what was missing before marking it fixed by hand.',
          path: ['note'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await mapDomainErrors(() =>
        setSeerrIssueStaffNote({
          db: ctx.db,
          actorId: ctx.user.id,
          seerrIssueId: input.seerrIssueId,
          note: input.note,
          fixedByHand: input.fixedByHand,
        }),
      );
      return {
        fixedByHand: result.fixedByHand,
        note: result.note,
        staffHandledAt: result.staffHandledAt ? result.staffHandledAt.toISOString() : null,
      };
    }),
});
