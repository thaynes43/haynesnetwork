import { and, eq } from 'drizzle-orm';
import {
  account,
  db,
  roleMessageActionGrants,
  roleSectionPermissions,
  roleTrashActionGrants,
  roles,
  users,
  MESSAGE_ACTIONS,
  SECTION_IDS,
  SECTION_DEFAULT_LEVELS,
  TRASH_ACTIONS,
  type Database,
  type DbClient,
  type MessageAction,
  type MetricsLevel,
  type SectionId,
  type SectionPermissionLevel,
  type TrashAction,
} from '@hnet/db';
import { OIDC_PROVIDER_ID } from '../env';
import { resolvePlexIdentity, type PlexIdentity } from './plex-identity';

/** The role summary carried on the session (ADR-012 — one role per user). */
export interface SessionRole {
  id: string;
  name: string;
  isAdmin: boolean;
  /**
   * ADR-021 C-02 — the caller's resolved access LEVEL per top-level section, so nav + the
   * `sectionProcedure` gate need no per-request query (mirrors `isAdmin`). ALWAYS a full map
   * over SECTION_IDS: admin ⇒ 'edit' everywhere; otherwise the role's row or the section default.
   */
  sectionPermissions: Record<SectionId, SectionPermissionLevel>;
  /**
   * ADR-023 C-03 — the caller's resolved FINE-GRAINED Trash action grants, so `trashActionProcedure`
   * needs no per-request query. Admin ⇒ ALL actions; otherwise exactly the role's granted rows
   * (absence ⇒ not granted). Layered on top of `sectionPermissions.trash` (which gates VIEW).
   */
  trashActions: TrashAction[];
  /**
   * ADR-026 C-04 — the caller's resolved FINE-GRAINED Bulletin message action grants, so
   * `messageActionProcedure` needs no per-request query. Admin ⇒ ALL actions; otherwise exactly
   * the role's granted rows. Layered on top of `sectionPermissions.bulletin` (which gates READ).
   */
  messageActions: MessageAction[];
  /**
   * ADR-037 C-01 — the caller's resolved METRICS access level, so `metricsProcedure` + the router's
   * payload-shaping need no per-request query (mirrors `isAdmin`). Admin ⇒ 'full'; otherwise the
   * role's stored `roles.metrics_level` column (default 'limited').
   */
  metricsLevel: MetricsLevel;
}

/**
 * The per-user fields getServerSession grafts onto Better Auth's session read
 * (DESIGN-002 D-06). ADR-012: `role` is the user's single role (id + name + isAdmin),
 * joined from the roles table — consumers (DESIGN-003 D-01 tRPC context, route gating)
 * switch on `role.isAdmin`, never a string literal.
 */
export interface SessionExtension {
  role: SessionRole;
  displayName: string;
  /**
   * fix/plex-identity-mapping — the caller's resolved REAL Plex identity, NOT the OIDC email.
   * Sourced from the id_token claims (Authentik provider scope mappings): fix/plex-numeric-id adds
   * `plex_user_id` (the plex.tv numeric id — the strongest, matched first), alongside `plex_email`/
   * `plex_username` with the admin-set users.plex_email/plex_username override as fallback. Empty
   * fields ⇒ the My Plex matcher falls back to the app email. Carried on the session so
   * plex.myLibraries needs no extra query.
   */
  plexIdentity: PlexIdentity;
}

/**
 * One-lookup hydration of role + displayName for a user id (users ⋈ roles). Returns null
 * when the user row is gone (deleted between sign-in and read) so callers fail closed.
 */
export async function getSessionExtension(
  userId: string,
  dbc?: DbClient,
): Promise<SessionExtension | null> {
  const q = (dbc ?? db) as Database;
  const [row] = await q
    .select({
      roleId: users.roleId,
      displayName: users.displayName,
      roleName: roles.name,
      isAdmin: roles.isAdmin,
      // ADR-037 C-01 — the role's metrics access level (admin short-circuits to 'full' below). One
      // more roles column on the existing join — no extra query.
      metricsLevel: roles.metricsLevel,
      // fix/plex-identity-mapping — the admin-set Plex identity override (fallback for the claim).
      plexEmail: users.plexEmail,
      plexUsername: users.plexUsername,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));
  if (!row) return null;
  // fix/plex-identity-mapping — the OIDC id_token carries the Plex source claims; read the latest
  // token from the linked Authentik account (Better Auth refreshes it each sign-in). One small
  // extra query, mirroring the role join. Decoded (not re-verified) for an identity hint only.
  const [acct] = await q
    .select({ idToken: account.idToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, OIDC_PROVIDER_ID)))
    .limit(1);
  const plexIdentity = resolvePlexIdentity({
    idToken: acct?.idToken ?? null,
    overrideEmail: row.plexEmail,
    overrideUsername: row.plexUsername,
  });
  // ADR-021 C-01/C-03 — resolve the full section-level map: admin ⇒ 'edit' everywhere (no
  // rows), otherwise the role's stored rows with each missing section falling back to its
  // documented default. One small extra query, mirroring the role join above.
  const sectionRows = row.isAdmin
    ? []
    : await q
        .select({
          sectionId: roleSectionPermissions.sectionId,
          level: roleSectionPermissions.level,
        })
        .from(roleSectionPermissions)
        .where(eq(roleSectionPermissions.roleId, row.roleId));
  const byId = new Map(sectionRows.map((r) => [r.sectionId, r.level]));
  const sectionPermissions = Object.fromEntries(
    SECTION_IDS.map((sid) => [
      sid,
      row.isAdmin ? 'edit' : (byId.get(sid) ?? SECTION_DEFAULT_LEVELS[sid]),
    ]),
  ) as Record<SectionId, SectionPermissionLevel>;
  // ADR-023 C-03 — the fine-grained Trash action grants: admin ⇒ every action (no rows),
  // otherwise the role's granted rows filtered to the canonical order. One more small query,
  // skipped entirely for admins.
  const grantRows = row.isAdmin
    ? []
    : await q
        .select({ action: roleTrashActionGrants.action })
        .from(roleTrashActionGrants)
        .where(eq(roleTrashActionGrants.roleId, row.roleId));
  const grantedSet = new Set(grantRows.map((r) => r.action));
  const trashActions: TrashAction[] = row.isAdmin
    ? [...TRASH_ACTIONS]
    : TRASH_ACTIONS.filter((a) => grantedSet.has(a));
  // ADR-026 C-04 — the fine-grained Bulletin message action grants: admin ⇒ every action (no
  // rows), otherwise the role's granted rows in canonical order. Skipped entirely for admins.
  const messageGrantRows = row.isAdmin
    ? []
    : await q
        .select({ action: roleMessageActionGrants.action })
        .from(roleMessageActionGrants)
        .where(eq(roleMessageActionGrants.roleId, row.roleId));
  const messageGrantedSet = new Set(messageGrantRows.map((r) => r.action));
  const messageActions: MessageAction[] = row.isAdmin
    ? [...MESSAGE_ACTIONS]
    : MESSAGE_ACTIONS.filter((a) => messageGrantedSet.has(a));
  return {
    role: {
      id: row.roleId,
      name: row.roleName,
      isAdmin: row.isAdmin,
      sectionPermissions,
      trashActions,
      messageActions,
      // ADR-037 C-01 — admin implies 'full' (like admin implies section 'edit'); else the stored column.
      metricsLevel: row.isAdmin ? 'full' : row.metricsLevel,
    },
    displayName: row.displayName,
    plexIdentity,
  };
}
