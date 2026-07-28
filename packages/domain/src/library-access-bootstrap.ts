// ADR-081 — library-access bootstrap seeding + the registration auto-grant. THE GUARANTEE: "the Default
// role can see everything" is a CODE guarantee, not just live configuration. Two writers realize it, both
// reusing the ADR-024 role_plex_server_all_grants model + the hard-rule-6 same-tx audit trail:
//
//   • registerPlexServer (C-01/C-06) — the Plex-server REGISTRATION writer. Inserts a plex_servers row and,
//     when it is a genuinely NEW server, auto-grants the Default role an all-libraries grant on it IN THE
//     SAME TRANSACTION as the insert (C-06 — a crash can never register a server invisibly to Default), with
//     the same 'update_role_libraries' audit row a manual grant produces. Fires only on FIRST registration
//     (server newly inserted); a re-registration of an existing slug never re-asserts, so an admin revocation
//     is respected forever.
//   • seedDefaultServerAllGrantsIfBootstrap (C-01/C-02/C-03) — the BOOTSTRAP SEED. On a from-scratch deploy
//     it writes the Default role an all-grant for every Plex server present at seed time. Guarded to a FRESH
//     bootstrap (zero users): the live estate already carries the owner's configured grants, so the seed
//     adds nothing there (C-02 — no widening, no backfill) and never re-asserts a revoked grant (a revocation
//     implies an admin, which implies a user row, which closes the guard). Non-default roles are untouched
//     (C-03 — deny-by-default, ADR-024, stands).
//
// role_plex_server_all_grants is a guarded table; these writers live in packages/domain (the single-writer
// discipline) and co-write permission_audit in the same transaction, exactly like setRoleLibraries.
import {
  permissionAudit,
  plexServers,
  rolePlexServerAllGrants,
  roles,
  users,
  type DbClient,
  type PlexServerInsert,
  type Transaction,
} from '@hnet/db';
import { asc, eq, sql } from 'drizzle-orm';
import { inTransaction } from './db-client';

/** The Default role's identity for an audit detail line (id/slug/name of a granted server). */
interface GrantedServerRef {
  id: string;
  slug: string;
  name: string;
}

/**
 * Auto-grant the Default role an all-libraries grant on one server, in the given transaction, IDEMPOTENTLY
 * (ON CONFLICT DO NOTHING on the composite PK): only a genuinely NEW grant is written, and only then is the
 * 'update_role_libraries' audit row co-written (the same event + detail shape setRoleLibraries produces for
 * a server-all grant). Returns true iff a new grant was written. Never re-asserts an already-present or
 * previously-revoked-and-reinserted grant beyond the single row it owns.
 */
async function grantDefaultServerAll(
  tx: Transaction,
  serverId: string,
  actorId: string | null,
): Promise<boolean> {
  const [def] = await tx
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.isDefault, true));
  // No Default role (pre-migration-0007 DB — impossible in practice): nothing to grant.
  if (!def) return false;

  const inserted = await tx
    .insert(rolePlexServerAllGrants)
    .values({ roleId: def.id, plexServerId: serverId })
    .onConflictDoNothing({
      target: [rolePlexServerAllGrants.roleId, rolePlexServerAllGrants.plexServerId],
    })
    .returning({ serverId: rolePlexServerAllGrants.plexServerId });
  // Already granted (or concurrently granted): do NOT re-audit or re-assert.
  if (inserted.length === 0) return false;

  const [srv] = await tx
    .select({ id: plexServers.id, slug: plexServers.slug, name: plexServers.name })
    .from(plexServers)
    .where(eq(plexServers.id, serverId));
  const after: GrantedServerRef[] = srv ? [{ id: srv.id, slug: srv.slug, name: srv.name }] : [];

  // Mirror setRoleLibraries' 'update_role_libraries' detail shape (before/after library sets +
  // all_servers_before/after); the per-library set is unchanged here, so before === after === [].
  await tx.insert(permissionAudit).values({
    actorId,
    action: 'update_role_libraries',
    roleId: def.id,
    detail: {
      role_name: def.name,
      reason: 'bootstrap_default_all_grant',
      before: [],
      after: [],
      all_servers_before: [],
      all_servers_after: after,
    },
  });
  return true;
}

export interface RegisterPlexServerInput {
  db?: DbClient;
  /** The server row to register (slug is the identity — ON CONFLICT (slug) DO NOTHING). */
  server: PlexServerInsert;
  /** The admin who triggered the registration, or null for a system/seed path. */
  actorId?: string | null;
}

export interface RegisterPlexServerResult {
  serverId: string;
  /** true iff this call inserted the server (a FIRST registration). */
  created: boolean;
  /** true iff the Default all-libraries grant was auto-written this call (only on a first registration). */
  defaultGranted: boolean;
}

/**
 * ADR-081 C-01/C-06 — the Plex-server REGISTRATION writer. Inserts the server (idempotent on slug) and, on a
 * genuinely NEW registration, auto-grants the Default role an all-libraries grant on it IN THE SAME
 * TRANSACTION (C-06), audited like a manual grant. A re-registration of an existing slug is a no-op for the
 * grant (created:false, defaultGranted:false) — the auto-grant fires ONLY at first registration, so a later
 * admin revocation is never re-asserted.
 *
 * NOTE: the three servers of record are seeded by migration 0010 (immutable infra facts, slug-CHECK-capped),
 * so this writer is the forward-looking guarantee for any future server registration path — it is not on the
 * live seed path today. The from-scratch Default grant is handled by seedDefaultServerAllGrantsIfBootstrap.
 */
export async function registerPlexServer(
  input: RegisterPlexServerInput,
): Promise<RegisterPlexServerResult> {
  return inTransaction(input.db, async (tx) => {
    const inserted = await tx
      .insert(plexServers)
      .values(input.server)
      .onConflictDoNothing({ target: plexServers.slug })
      .returning({ id: plexServers.id });

    if (inserted.length === 0) {
      // Slug already registered — never re-assert the grant (revocation respected).
      const [existing] = await tx
        .select({ id: plexServers.id })
        .from(plexServers)
        .where(eq(plexServers.slug, input.server.slug));
      return { serverId: existing!.id, created: false, defaultGranted: false };
    }

    const serverId = inserted[0]!.id;
    const defaultGranted = await grantDefaultServerAll(tx, serverId, input.actorId ?? null);
    return { serverId, created: true, defaultGranted };
  });
}

export interface SeedDefaultServerAllGrantsInput {
  db?: DbClient;
  /** The actor recorded on the audit rows (null = the system bootstrap). */
  actorId?: string | null;
}

export interface SeedDefaultServerAllGrantsResult {
  /** true iff this call performed the seed (a fresh bootstrap — zero users); false iff it was skipped. */
  seeded: boolean;
  /** Plex servers present at seed time. */
  servers: number;
  /** New Default all-grants written this call (already-present grants are not recounted). */
  granted: number;
}

/**
 * ADR-081 C-01/C-02/C-03 — the BOOTSTRAP SEED, guarded to a from-scratch deploy. When (and only when) the DB
 * holds ZERO users — the distinguishing fact of a fresh bootstrap, before the first OIDC login mints a user
 * row — it grants the Default role an all-libraries grant on EVERY registered Plex server (audited per grant,
 * idempotent). On a populated (live) DB it is a clean no-op: it adds no rows (C-02 — the owner's configured
 * grants are neither widened nor rewritten) and cannot re-assert a revoked grant (a revocation requires an
 * admin, hence a user row, so the guard is already closed). Non-default roles are never touched (C-03).
 */
export async function seedDefaultServerAllGrantsIfBootstrap(
  input: SeedDefaultServerAllGrantsInput = {},
): Promise<SeedDefaultServerAllGrantsResult> {
  return inTransaction(input.db, async (tx) => {
    const userRows = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
    // Not a fresh bootstrap — the live estate is already in the desired state by configuration (C-02).
    if ((userRows[0]?.n ?? 0) > 0) return { seeded: false, servers: 0, granted: 0 };

    const serverRows = await tx
      .select({ id: plexServers.id })
      .from(plexServers)
      .orderBy(asc(plexServers.slug));
    let granted = 0;
    for (const s of serverRows) {
      if (await grantDefaultServerAll(tx, s.id, input.actorId ?? null)) granted += 1;
    }
    return { seeded: true, servers: serverRows.length, granted };
  });
}
