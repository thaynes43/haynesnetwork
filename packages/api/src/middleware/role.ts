// DESIGN-003 D-02 / ADR-012 — the admin rung of the procedure ladder. Admin is the
// superuser role (roles.is_admin); the session carries role.isAdmin so this needs no
// extra query. Further attribute rungs (Phase-3 library gating, Phase-4 section gating)
// compose the same way.
import { TRPCError } from '@trpc/server';
import {
  SECTION_DEFAULT_LEVELS,
  SECTION_LEVEL_RANK,
  type SectionId,
  type SectionPermissionLevel,
} from '@hnet/db';
import { authedProcedure } from '../trpc';
import type { SessionRole } from '@hnet/auth';

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (!ctx.user.role.isAdmin) throw new TRPCError({ code: 'FORBIDDEN' });
  return next();
});

/**
 * ADR-021 C-01/C-03 — the caller's effective level for a section, read off the session (no
 * query). Admin ⇒ 'edit' everywhere; otherwise the resolved session map, falling back to the
 * section default if a key is somehow absent (defense in depth — getSessionExtension already
 * fills every key).
 */
export function effectiveSectionLevel(
  role: SessionRole,
  sectionId: SectionId,
): SectionPermissionLevel {
  if (role.isAdmin) return 'edit';
  return role.sectionPermissions?.[sectionId] ?? SECTION_DEFAULT_LEVELS[sectionId];
}

/**
 * ADR-021 C-02 — the section rung: authed AND the caller's level for `sectionId` is at least
 * `minLevel` (disabled < read_only < edit; admin passes). FORBIDDEN otherwise. The gate reads
 * the session-carried levels, so it is server-authoritative (AC-13) — never client-hidden only.
 */
export function sectionProcedure(sectionId: SectionId, minLevel: SectionPermissionLevel) {
  return authedProcedure.use(({ ctx, next }) => {
    const level = effectiveSectionLevel(ctx.user.role, sectionId);
    if (SECTION_LEVEL_RANK[level] < SECTION_LEVEL_RANK[minLevel]) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return next();
  });
}
