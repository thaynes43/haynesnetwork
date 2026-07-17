// DESIGN-003 D-02 / ADR-012 — the admin rung of the procedure ladder. Admin is the
// superuser role (roles.is_admin); the session carries role.isAdmin so this needs no
// extra query. Further attribute rungs (Phase-3 library gating, Phase-4 section gating)
// compose the same way.
import { TRPCError } from '@trpc/server';
import {
  BULLETIN_VIEW_DEFAULTS,
  SECTION_DEFAULT_LEVELS,
  SECTION_LEVEL_RANK,
  type ActivityAction,
  type BookAction,
  type BulletinView,
  type CollectionAction,
  type MessageAction,
  type MetricsLevel,
  type SectionId,
  type SectionPermissionLevel,
  type TrashAction,
} from '@hnet/db';
import { activityActionsForRole, bookActionsForRole, collectionActionsForRole } from '@hnet/domain';
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
 * ADR-038 C-05 (PLAN-022 ytdl-sub Library) — the ytdl-sub rung: authed AND the caller can SEE the
 * `ytdlsub` section (≥ read_only). The section defaults to `disabled` (ships Admin-only; a role row opts
 * others in), so this gate is the visibility check for the Peloton/YouTube Library sub-tabs AND the
 * Plex-thumb poster proxy. Server-authoritative (AC-13) — never client-hidden only.
 */
export const ytdlsubProcedure = sectionProcedure('ytdlsub', 'read_only');

/**
 * ADR-046 C-04 (PLAN-023 Books & Audiobooks) — the books rung: authed AND the caller can SEE the `books`
 * section (≥ read_only). The section defaults to `disabled` (ships Admin-only; a role row opts others in),
 * so this gate is the visibility check for the Books/Audiobooks/Comics Library sub-tabs AND the book-cover
 * proxy. Server-authoritative (AC-13) — never client-hidden only.
 */
export const booksProcedure = sectionProcedure('books', 'read_only');

/**
 * ADR-055 C-04 (PLAN-044 Goodreads requests MVP) — the integrations rung: authed AND the caller can SEE the
 * `integrations` section (≥ read_only). The section defaults to `disabled` (ships Admin-only; a role row
 * opts others in after screenshot review), so this gate is the visibility check for the Integrations tab
 * (link accounts, shelf sync, requests/Missing wall, manual re-search). Server-authoritative (AC-13) —
 * never client-hidden only.
 */
export const integrationsProcedure = sectionProcedure('integrations', 'read_only');

/**
 * ADR-057 amendment (PLAN-047 — the Wanted DETAIL page) — the rung for a read reachable from EITHER wall
 * that links to it: the household Library-Wanted cards (books-gated) OR the per-user Goodreads items wall
 * (integrations-gated). Authed AND the caller can SEE `books` OR `integrations` (≥ read_only); FORBIDDEN
 * only when BOTH are disabled. This is the VIEW gate for `books.wantedDetail` — "reachable by whoever can
 * see the card that links to it"; the force-search ACTION keeps its own `integrations` + ownership gate.
 */
export const booksOrIntegrationsProcedure = authedProcedure.use(({ ctx, next }) => {
  const books = effectiveSectionLevel(ctx.user.role, 'books');
  const integrations = effectiveSectionLevel(ctx.user.role, 'integrations');
  if (books === 'disabled' && integrations === 'disabled') throw new TRPCError({ code: 'FORBIDDEN' });
  return next();
});

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
 * ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the caller's effective Activity actions.
 * Admin ⇒ every action (no query). Otherwise a per-call DB read of `role_activity_action_grants` (a
 * mutation/detail path, so the read is cheap + rare; the grant seam deliberately does NOT yet ride the
 * session — R2's "openable to roles later"). Used by `activityActionProcedure` (the server gate) + the
 * failure-detail resolver (the per-viewer canAct flags).
 */
export async function resolveActivityActions(
  db: import('@hnet/db').Database,
  role: SessionRole,
): Promise<ActivityAction[]> {
  return activityActionsForRole({ db, roleId: role.id, isAdmin: role.isAdmin });
}

/**
 * ADR-059 / DESIGN-030 (PLAN-048) — the Activity action rung (R2): authed AND (admin OR the caller's role
 * holds the `role_activity_action_grants` row for `action`). FORBIDDEN otherwise — server-authoritative,
 * never a client hide. The Activity tab itself is ungated (the LIST resolver does per-section VIEW gating);
 * these gate only the failure ACTIONS. Rides the ADR-023 grant machinery so opening an action to a role is
 * a data change, not code.
 */
export function activityActionProcedure(action: ActivityAction) {
  return authedProcedure.use(async ({ ctx, next }) => {
    if (ctx.user.role.isAdmin) return next();
    const actions = await activityActionsForRole({ db: ctx.db, roleId: ctx.user.role.id });
    if (!actions.includes(action)) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
}

/**
 * ADR-062 / DESIGN-033 D-03 (PLAN-041) — the books Fix action rung: the `books` section at
 * read_only or better (visibility floor) AND (admin OR the caller's role holds the
 * `role_books_action_grants` row for `action`). Ships UNGRANTED ⇒ Admin-only for the owner's test
 * window; the Q-01 ruling then flips `fix_book` to all roles via `setRoleBookActions` — a data
 * change, not code. Server-authoritative, never a client hide.
 */
export function bookActionProcedure(action: BookAction) {
  return sectionProcedure('books', 'read_only').use(async ({ ctx, next }) => {
    if (ctx.user.role.isAdmin) return next();
    const actions = await bookActionsForRole({ db: ctx.db, roleId: ctx.user.role.id });
    if (!actions.includes(action)) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
}

/**
 * ADR-070 / DESIGN-043 D-01/D-06 (PLAN-052 — collection manager) — the caller's effective collection
 * actions. Admin ⇒ every action (no query); otherwise a per-call read of `role_collection_action_grants`
 * (a management path — cheap + rare). Used by `collectionActionProcedure` (the server gate) + the router's
 * per-viewer `canAcquire` flag (which gates the acquisition toggle in the composer).
 */
export async function resolveCollectionActions(
  db: import('@hnet/db').Database,
  role: SessionRole,
): Promise<CollectionAction[]> {
  return collectionActionsForRole({ db, roleId: role.id, isAdmin: role.isAdmin });
}

/**
 * ADR-070 / DESIGN-043 D-06 (PLAN-052) — the collection action rung: the `integrations` section at
 * read_only or better (visibility floor — the manager lives under the Integrations hub) AND (admin OR the
 * caller's role holds the `role_collection_action_grants` row for `action`). Ships UNGRANTED ⇒ Admin-only;
 * the owner opens `suggest` / `manage` / `acquire` per role via `setRoleCollectionActions` — a data change,
 * not code. `acquire` is a DISTINCT grant a `manage` role does not automatically hold. Server-authoritative,
 * never a client hide.
 */
export function collectionActionProcedure(action: CollectionAction) {
  return sectionProcedure('integrations', 'read_only').use(async ({ ctx, next }) => {
    if (ctx.user.role.isAdmin) return next();
    const actions = await collectionActionsForRole({ db: ctx.db, roleId: ctx.user.role.id });
    if (!actions.includes(action)) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
}

/**
 * ADR-070 / DESIGN-043 D-05 (PLAN-052) — the member-contribution rung: authed AND (admin OR the caller's
 * role holds the `suggest` grant). Deliberately NO section floor — the "Suggest a collection" affordance
 * lives on the BOOKS walls (books-section gated for visibility), so a member who can see the walls may
 * propose without the `integrations` section being open to them. It only PROPOSES (a pending row) — the
 * content-touching manager mutations keep the integrations-floored `collectionActionProcedure('manage')`.
 */
export const collectionSuggestProcedure = authedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role.isAdmin) return next();
  const actions = await collectionActionsForRole({ db: ctx.db, roleId: ctx.user.role.id });
  if (!actions.includes('suggest')) throw new TRPCError({ code: 'FORBIDDEN' });
  return next();
});

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
 * ADR-049 C-02 (PLAN-027) — can the caller SEE a Bulletin sub-`view` (feed / messages)? Read off the
 * session (no query). Admin ⇒ both views; otherwise the resolved session view list — which already
 * carries the "no rows ⇒ both" default (BULLETIN_VIEW_DEFAULTS), so a role that has never been
 * narrowed sees everything, and the owner's Default role (narrowed to `messages`) does NOT see feed.
 * Defense in depth: if the session somehow lacks the field, fall back to the both-views default.
 */
export function hasBulletinView(role: SessionRole, view: BulletinView): boolean {
  if (role.isAdmin) return true;
  return (role.bulletinViews ?? BULLETIN_VIEW_DEFAULTS).includes(view);
}

/**
 * ADR-049 C-02 (PLAN-027) — the Bulletin sub-view rung: authed AND the caller's `bulletin` section is
 * at least Read-Only (section visible) AND the specific `view` is granted. FORBIDDEN otherwise.
 * Composed on top of the section gate so a Disabled-Bulletin role can never reach either view. This
 * is the SERVER-AUTHORITATIVE gate (AC-13): a role without the `feed` grant gets FORBIDDEN from the
 * feed endpoint, not merely a hidden tab — never client-hidden only.
 */
export function bulletinViewProcedure(view: BulletinView) {
  return sectionProcedure('bulletin', 'read_only').use(({ ctx, next }) => {
    if (!hasBulletinView(ctx.user.role, view)) {
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
 * ADR-026 C-04 + ADR-049 C-02 — the Bulletin message-action rung: authed AND the caller can SEE the
 * `messages` view (which itself requires `bulletin` ≥ Read-Only) AND the specific `action` is
 * granted. FORBIDDEN otherwise. Composed on top of the MESSAGES-VIEW gate (not just the section) so a
 * role whose Bulletin is narrowed to feed-only — or disabled — can never reach post/moderate even
 * with a stale grant. Server-authoritative (AC-13) — grants are session-carried.
 */
export function messageActionProcedure(action: MessageAction) {
  return bulletinViewProcedure('messages').use(({ ctx, next }) => {
    if (!hasMessageAction(ctx.user.role, action)) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return next();
  });
}
