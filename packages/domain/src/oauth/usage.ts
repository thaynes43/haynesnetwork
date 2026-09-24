// ADR-091 / DESIGN-050 D-07 — what the public `/mcp` reads and writes per request: the bearer lookup (one
// indexed hash lookup joined to `users` and the client — a read; @hnet/oauth `decideBearer` judges it) and the
// `last_used_at` single-writer, stamped on the token and the client at most once a minute.
import { oauthAccessTokens, oauthClients, users, type DbClient, type OAuthScope } from '@hnet/db';
import { LAST_USED_RESOLUTION_MS, hashToken, lastUsedIsStale } from '@hnet/oauth';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { resolveDb } from '../db-client';

export interface BearerTokenRow {
  id: string;
  clientId: string;
  userId: string;
  scopes: OAuthScope[];
  resource: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  clientLastUsedAt: Date | null;
}

/** The access token a bearer names (by SHA-256), joined to its user and client; undefined when unknown. */
export async function selectBearerToken(input: {
  db?: DbClient;
  token: string;
}): Promise<BearerTokenRow | undefined> {
  const [row] = await resolveDb(input.db)
    .select({
      id: oauthAccessTokens.id,
      clientId: oauthAccessTokens.clientId,
      userId: oauthAccessTokens.userId,
      scopes: oauthAccessTokens.scopes,
      resource: oauthAccessTokens.resource,
      expiresAt: oauthAccessTokens.expiresAt,
      revokedAt: oauthAccessTokens.revokedAt,
      lastUsedAt: oauthAccessTokens.lastUsedAt,
      clientLastUsedAt: oauthClients.lastUsedAt,
    })
    .from(oauthAccessTokens)
    .innerJoin(users, eq(users.id, oauthAccessTokens.userId))
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthAccessTokens.clientId))
    .where(eq(oauthAccessTokens.tokenHash, hashToken(input.token)))
    .limit(1);
  return row;
}

/**
 * D-07 — stamp `last_used_at` on the token and on its client, each at most once a minute: nothing is written
 * while the stored stamp is under a minute old (checked on the values the lookup already read, and again in the
 * UPDATE's condition, so concurrent requests on three replicas write it once). No audit row (usage bookkeeping,
 * the markIntegrationSynced class). Returns what it stamped.
 */
export async function touchLastUsed(input: {
  db?: DbClient;
  tokenId: string;
  clientId: string;
  tokenLastUsedAt: Date | null;
  clientLastUsedAt: Date | null;
  now?: Date;
}): Promise<{ token: boolean; client: boolean }> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  // The same boundary as `lastUsedIsStale`: a stamp exactly a minute old is stale.
  const cutoff = new Date(now.getTime() - LAST_USED_RESOLUTION_MS);
  let token = false;
  let client = false;
  if (lastUsedIsStale(input.tokenLastUsedAt, now)) {
    const rows = await db
      .update(oauthAccessTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(oauthAccessTokens.id, input.tokenId),
          or(isNull(oauthAccessTokens.lastUsedAt), lte(oauthAccessTokens.lastUsedAt, cutoff)),
        ),
      )
      .returning({ id: oauthAccessTokens.id });
    token = rows.length > 0;
  }
  if (lastUsedIsStale(input.clientLastUsedAt, now)) {
    const rows = await db
      .update(oauthClients)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(oauthClients.clientId, input.clientId),
          or(isNull(oauthClients.lastUsedAt), lte(oauthClients.lastUsedAt, cutoff)),
        ),
      )
      .returning({ id: oauthClients.id });
    client = rows.length > 0;
  }
  return { token, client };
}
