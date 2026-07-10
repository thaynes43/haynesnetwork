// DESIGN-003 D-02 / ADR-012 — the admin rung of the procedure ladder. Admin is the
// superuser role (roles.is_admin); the session carries role.isAdmin so this needs no
// extra query. Further attribute rungs (Phase-3 library gating, Phase-4 section gating)
// compose the same way.
import { TRPCError } from '@trpc/server';
import {
  SECTION_DEFAULT_LEVELS,
  SECTION_LEVEL_RANK,
  type MessageAction,
  type MetricsLevel,
  type SectionId,
  type SectionPermissionLevel,
  type TrashAction,
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

/**
 * ADR-037 C-01/C-03 — the caller's effective metrics access level, read off the session (no query).
 * Admin ⇒ 'full' (like admin implies section 'edit'); otherwise the role's stored `metrics_level`.
 * The `metrics.overview` resolver reads this to SHAPE the payload (full-only fields omitted for
 * 'limited') — server-authoritative, never client-hidden only.
 */
export function effectiveMetricsLevel(role: SessionRole): MetricsLevel {
  return role.isAdmin ? 'full' : role.metricsLevel;
}

/**
 * ADR-037 C-02 — the Metrics rung: authed AND the caller can SEE the `metrics` section (≥ read_only).
 * The section defaults to `disabled` (ships Admin-only; a role row opts others in), so this gate is the
 * visibility check; the payload GRANULARITY is decided per `effectiveMetricsLevel` inside the resolver.
 */
export const metricsProcedure = sectionProcedure('metrics', 'read_only');

/**
 * ADR-025 errata (2026-07-08, owner-directed) — GLOBAL SAVE IS A SUPERSET OF THE WINDOWED RESCUE.
 * Holding `save_exclude` (the anytime whitelist power — "Save items, anytime") IMPLIES
 * `save_leaving_soon` (the narrow "Save during a Leaving-Soon window" grant): if you can whitelist
 * any flagged item at any time, you can obviously rescue one that is Leaving Soon. The implication is
 * one-directional (a `save_leaving_soon`-only holder does NOT gain the anytime pending-wall save) and
 * is COMPUTED here — never written to `role_trash_action_grants` (the stored grants stay as-is).
 * Admin still implies ALL actions and never reaches this helper.
 */
export function effectiveTrashActions(actions: readonly TrashAction[]): TrashAction[] {
  const set = new Set<TrashAction>(actions);
  if (set.has('save_exclude')) set.add('save_leaving_soon');
  return [...set];
}

/**
 * ADR-023 C-03 — is the caller granted a fine-grained Trash `action`? Read off the session
 * (no query). Admin ⇒ every action; otherwise the resolved session grant list expanded with the
 * computed implications (ADR-025 errata — `save_exclude` ⇒ `save_leaving_soon`). Absence ⇒ deny.
 */
export function hasTrashAction(role: SessionRole, action: TrashAction): boolean {
  if (role.isAdmin) return true;
  return effectiveTrashActions(role.trashActions ?? []).includes(action);
}

/**
 * ADR-023 C-03 — the Trash action rung: authed AND the caller's Trash section is at least
 * `minLevel` (default Read-Only, so viewing/browse is allowed) AND the specific `action` is
 * granted. FORBIDDEN otherwise. Composed on top of the section gate so a Disabled-Trash role can
 * never reach a write action even if it somehow carried a stale grant. Rule EDITING passes
 * `minLevel: 'edit'` (D5 — edit_rules additionally requires section Edit). Server-authoritative
 * (AC-13) — the grants are session-carried, never client-hidden only.
 */
export function trashActionProcedure(
  action: TrashAction,
  minLevel: SectionPermissionLevel = 'read_only',
) {
  return sectionProcedure('trash', minLevel).use(({ ctx, next }) => {
    if (!hasTrashAction(ctx.user.role, action)) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return next();
  });
}

/**
 * ADR-026 C-04 — is the caller granted a fine-grained Bulletin message `action`? Read off the
 * session (no query). Admin ⇒ every action; otherwise the resolved session grant list. Deny on
 * absence.
 */
export function hasMessageAction(role: SessionRole, action: MessageAction): boolean {
  if (role.isAdmin) return true;
  return (role.messageActions ?? []).includes(action);
}

/**
 * ADR-026 C-04 — the Bulletin message-action rung: authed AND the caller's `bulletin` section is at
 * least Read-Only (browse allowed) AND the specific `action` is granted. FORBIDDEN otherwise.
 * Composed on top of the section gate so a Disabled-Bulletin role can never reach post/moderate
 * even with a stale grant. Server-authoritative (AC-13) — grants are session-carried.
 */
export function messageActionProcedure(action: MessageAction) {
  return sectionProcedure('bulletin', 'read_only').use(({ ctx, next }) => {
    if (!hasMessageAction(ctx.user.role, action)) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return next();
  });
}
