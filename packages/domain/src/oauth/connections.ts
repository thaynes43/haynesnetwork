// ADR-091 C-10 / DESIGN-050 D-08 — the Connected apps page: its read (one row per client with a live refresh
// family or an unexpired access token) and the audited Disconnect single-writer (hard rule 6).
import {
  oauthAccessTokens,
  oauthAudit,
  oauthAuthorizationCodes,
  oauthAuthorizations,
  oauthClients,
  oauthRefreshTokens,
  users,
  type DbClient,
} from '@hnet/db';
import { canonicalScopes, redirectHost, type OAuthScope } from '@hnet/oauth';
import { and, eq, gt, inArray, isNull, max, min, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { inTransaction, resolveDb } from '../db-client';

export interface ConnectedApp {
  clientId: string;
  clientName: string;
  /** Host of the client's first registered redirect URI (where its consent sent the browser). */
  redirectHost: string;
  userId: string;
  userEmail: string;
  userName: string;
  /** When the live connection began: its oldest live family's first token (or oldest live access token). */
  connectedAt: Date;
  /** The newest `last_used_at` of any of this user's tokens for the client; null = never used. */
  lastUsedAt: Date | null;
  /** The union of the live tokens' scopes, in the advertised order. */
  scopes: OAuthScope[];
}

/**
 * D-08 — the connections to list: for ONE user (`userId`), or — the admin view — for every user (`userId: null`).
 * A connection is a (client, user) pair with a live refresh family (an unrevoked, unrotated, unexpired refresh
 * token) or an unexpired, unrevoked access token. Newest connection first.
 */
export async function listConnectedApps(input: {
  db?: DbClient;
  userId: string | null;
  now?: Date;
}): Promise<ConnectedApp[]> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const forUser = (column: AnyPgColumn): SQL | undefined =>
    input.userId === null ? undefined : eq(column, input.userId);

  const liveRefresh = await db
    .select({
      familyId: oauthRefreshTokens.familyId,
      clientId: oauthRefreshTokens.clientId,
      userId: oauthRefreshTokens.userId,
      scopes: oauthRefreshTokens.scopes,
    })
    .from(oauthRefreshTokens)
    .where(
      and(
        forUser(oauthRefreshTokens.userId),
        isNull(oauthRefreshTokens.revokedAt),
        isNull(oauthRefreshTokens.rotatedAt),
        gt(oauthRefreshTokens.expiresAt, now),
      ),
    );
  const liveAccess = await db
    .select({
      clientId: oauthAccessTokens.clientId,
      userId: oauthAccessTokens.userId,
      scopes: oauthAccessTokens.scopes,
      createdAt: oauthAccessTokens.createdAt,
    })
    .from(oauthAccessTokens)
    .where(
      and(
        forUser(oauthAccessTokens.userId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, now),
      ),
    );
  if (liveRefresh.length === 0 && liveAccess.length === 0) return [];

  const families = [...new Set(liveRefresh.map((r) => r.familyId))];
  const familyStarts = families.length
    ? await db
        .select({
          familyId: oauthRefreshTokens.familyId,
          startedAt: min(oauthRefreshTokens.createdAt),
        })
        .from(oauthRefreshTokens)
        .where(inArray(oauthRefreshTokens.familyId, families))
        .groupBy(oauthRefreshTokens.familyId)
    : [];
  const startOf = new Map(familyStarts.map((f) => [f.familyId, f.startedAt]));

  const clientIds = [...new Set([...liveRefresh, ...liveAccess].map((r) => r.clientId))];
  const userIds = [...new Set([...liveRefresh, ...liveAccess].map((r) => r.userId))];
  const [clients, people, lastUsed] = await Promise.all([
    db
      .select({
        clientId: oauthClients.clientId,
        clientName: oauthClients.clientName,
        redirectUris: oauthClients.redirectUris,
      })
      .from(oauthClients)
      .where(inArray(oauthClients.clientId, clientIds)),
    db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds)),
    db
      .select({
        clientId: oauthAccessTokens.clientId,
        userId: oauthAccessTokens.userId,
        lastUsedAt: max(oauthAccessTokens.lastUsedAt),
      })
      .from(oauthAccessTokens)
      .where(
        and(
          inArray(oauthAccessTokens.clientId, clientIds),
          inArray(oauthAccessTokens.userId, userIds),
        ),
      )
      .groupBy(oauthAccessTokens.clientId, oauthAccessTokens.userId),
  ]);
  const clientOf = new Map(clients.map((c) => [c.clientId, c]));
  const personOf = new Map(people.map((p) => [p.id, p]));
  const usedOf = new Map(lastUsed.map((u) => [`${u.clientId}|${u.userId}`, u.lastUsedAt]));

  const byPair = new Map<
    string,
    { clientId: string; userId: string; scopes: Set<string>; since: Date | null }
  >();
  const pair = (clientId: string, userId: string) => {
    const key = `${clientId}|${userId}`;
    let p = byPair.get(key);
    if (!p) {
      p = { clientId, userId, scopes: new Set(), since: null };
      byPair.set(key, p);
    }
    return p;
  };
  const earlier = (a: Date | null, b: Date | null | undefined): Date | null =>
    !b ? a : !a || b.getTime() < a.getTime() ? b : a;
  for (const r of liveRefresh) {
    const p = pair(r.clientId, r.userId);
    for (const s of r.scopes) p.scopes.add(s);
    p.since = earlier(p.since, startOf.get(r.familyId) ?? null);
  }
  for (const a of liveAccess) {
    const p = pair(a.clientId, a.userId);
    for (const s of a.scopes) p.scopes.add(s);
    p.since = earlier(p.since, a.createdAt);
  }

  const out: ConnectedApp[] = [];
  for (const [key, p] of byPair) {
    const client = clientOf.get(p.clientId);
    const person = personOf.get(p.userId);
    if (!client || !person) continue;
    out.push({
      clientId: p.clientId,
      clientName: client.clientName,
      redirectHost: redirectHost(client.redirectUris[0] ?? ''),
      userId: p.userId,
      userEmail: person.email,
      userName: person.displayName,
      connectedAt: p.since ?? now,
      lastUsedAt: usedOf.get(key) ?? null,
      scopes: canonicalScopes(p.scopes),
    });
  }
  return out.sort(
    (a, b) =>
      b.connectedAt.getTime() - a.connectedAt.getTime() || a.clientName.localeCompare(b.clientName),
  );
}

/**
 * D-08 — Disconnect (the Connected apps page): in ONE transaction, revoke every refresh and access token of the
 * client for the user, expire the user's pending consent requests and unexchanged codes for it (so nothing can
 * mint a new token afterwards), and write the `client_disconnected` audit row. The client's next `/mcp` call answers
 * 401. `actorUserId` is who pressed Disconnect — the user themself, or an admin acting on another user's row
 * (recorded in the audit details). Nothing to revoke ⇒ `{ changed: false }` and no audit row (the domain's
 * idempotent-no-op rule).
 */
export async function disconnectClient(input: {
  db?: DbClient;
  clientId: string;
  userId: string;
  actorUserId?: string;
  now?: Date;
}): Promise<{ changed: boolean; refreshRevoked: number; accessRevoked: number }> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const refresh = await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(oauthRefreshTokens.clientId, input.clientId),
          eq(oauthRefreshTokens.userId, input.userId),
          isNull(oauthRefreshTokens.revokedAt),
        ),
      )
      .returning({ id: oauthRefreshTokens.id });
    const access = await tx
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(oauthAccessTokens.clientId, input.clientId),
          eq(oauthAccessTokens.userId, input.userId),
          isNull(oauthAccessTokens.revokedAt),
        ),
      )
      .returning({ id: oauthAccessTokens.id });
    // Pending consent requests and unexchanged codes for the client are EXPIRED, not deleted (deleting is the
    // pruner's job): the consent page then shows the expired state and a code can no longer be exchanged.
    const pending = await tx
      .update(oauthAuthorizations)
      .set({ expiresAt: now })
      .where(
        and(
          eq(oauthAuthorizations.clientId, input.clientId),
          eq(oauthAuthorizations.userId, input.userId),
          gt(oauthAuthorizations.expiresAt, now),
        ),
      )
      .returning({ id: oauthAuthorizations.id });
    const codes = await tx
      .update(oauthAuthorizationCodes)
      .set({ expiresAt: now })
      .where(
        and(
          eq(oauthAuthorizationCodes.clientId, input.clientId),
          eq(oauthAuthorizationCodes.userId, input.userId),
          isNull(oauthAuthorizationCodes.consumedAt),
          gt(oauthAuthorizationCodes.expiresAt, now),
        ),
      )
      .returning({ id: oauthAuthorizationCodes.id });
    const changed = refresh.length + access.length + pending.length + codes.length > 0;
    if (changed) {
      const [client] = await tx
        .select({ clientName: oauthClients.clientName, redirectUris: oauthClients.redirectUris })
        .from(oauthClients)
        .where(eq(oauthClients.clientId, input.clientId))
        .limit(1);
      await tx.insert(oauthAudit).values({
        event: 'client_disconnected',
        userId: input.userId,
        clientId: input.clientId,
        details: {
          client_name: client?.clientName ?? null,
          redirect_host: client ? redirectHost(client.redirectUris[0] ?? '') : null,
          refresh_revoked: refresh.length,
          access_revoked: access.length,
          requests_expired: pending.length,
          codes_expired: codes.length,
          ...(input.actorUserId && input.actorUserId !== input.userId
            ? { actor_user_id: input.actorUserId }
            : {}),
        },
        at: now,
      });
    }
    return { changed, refreshRevoked: refresh.length, accessRevoked: access.length };
  });
}
