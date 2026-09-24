// ADR-091 / DESIGN-050 D-03 — the inline pruner: the ONE path that deletes expired OAuth state (no CronJob). Each
// `/oauth/token` call runs it after answering; every delete is bounded to 200 rows per table so a backlog drains
// over a few calls instead of stalling one. @hnet/oauth `pruneCutoffs` decides the thresholds.
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthAuthorizations,
  oauthClients,
  oauthRefreshTokens,
  rateLimit,
  type DbClient,
} from '@hnet/db';
import { pruneCutoffs } from '@hnet/oauth';
import { and, inArray, like, lt, or, sql } from 'drizzle-orm';
import { resolveDb } from '../db-client';

export interface PruneReport {
  authorizations: number;
  codes: number;
  accessTokens: number;
  refreshTokens: number;
  clients: number;
  rateLimitBuckets: number;
}

/**
 * D-03 — delete, at most 200 rows per table: expired consent transactions and codes; access and refresh tokens
 * that expired or were revoked more than 30 days ago (a rotated refresh token is kept until then, so a late replay
 * is still recognised as reuse); DCR clients older than 30 days that own no token, code or transaction (after the
 * token deletes, so a client emptied in this run can go too); and expired `oauth:` rate-limit buckets (the D-10
 * limiter's rows — Better Auth prunes its own). Never throws past the caller's catch: the route logs and moves on.
 */
export async function pruneExpired(
  input: { db?: DbClient; now?: Date } = {},
): Promise<PruneReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const c = pruneCutoffs(now);

  const accessTokens = await db
    .delete(oauthAccessTokens)
    .where(
      inArray(
        oauthAccessTokens.id,
        db
          .select({ id: oauthAccessTokens.id })
          .from(oauthAccessTokens)
          .where(
            or(
              lt(oauthAccessTokens.expiresAt, c.retainedBefore),
              lt(oauthAccessTokens.revokedAt, c.retainedBefore),
            ),
          )
          .limit(c.batchSize),
      ),
    )
    .returning({ id: oauthAccessTokens.id });
  const refreshTokens = await db
    .delete(oauthRefreshTokens)
    .where(
      inArray(
        oauthRefreshTokens.id,
        db
          .select({ id: oauthRefreshTokens.id })
          .from(oauthRefreshTokens)
          .where(
            or(
              lt(oauthRefreshTokens.expiresAt, c.retainedBefore),
              lt(oauthRefreshTokens.revokedAt, c.retainedBefore),
            ),
          )
          .limit(c.batchSize),
      ),
    )
    .returning({ id: oauthRefreshTokens.id });
  const authorizations = await db
    .delete(oauthAuthorizations)
    .where(
      inArray(
        oauthAuthorizations.id,
        db
          .select({ id: oauthAuthorizations.id })
          .from(oauthAuthorizations)
          .where(lt(oauthAuthorizations.expiresAt, c.expiredBefore))
          .limit(c.batchSize),
      ),
    )
    .returning({ id: oauthAuthorizations.id });
  const codes = await db
    .delete(oauthAuthorizationCodes)
    .where(
      inArray(
        oauthAuthorizationCodes.id,
        db
          .select({ id: oauthAuthorizationCodes.id })
          .from(oauthAuthorizationCodes)
          .where(lt(oauthAuthorizationCodes.expiresAt, c.expiredBefore))
          .limit(c.batchSize),
      ),
    )
    .returning({ id: oauthAuthorizationCodes.id });
  const clients = await db
    .delete(oauthClients)
    .where(
      inArray(
        oauthClients.id,
        db
          .select({ id: oauthClients.id })
          .from(oauthClients)
          .where(
            and(
              lt(oauthClients.createdAt, c.dormantBefore),
              sql`NOT EXISTS (SELECT 1 FROM oauth_access_tokens t WHERE t.client_id = ${oauthClients.clientId})`,
              sql`NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens t WHERE t.client_id = ${oauthClients.clientId})`,
              sql`NOT EXISTS (SELECT 1 FROM oauth_authorizations t WHERE t.client_id = ${oauthClients.clientId})`,
              sql`NOT EXISTS (SELECT 1 FROM oauth_authorization_codes t WHERE t.client_id = ${oauthClients.clientId})`,
            ),
          )
          .limit(c.batchSize),
      ),
    )
    .returning({ id: oauthClients.id });
  const buckets = await db
    .delete(rateLimit)
    .where(
      inArray(
        rateLimit.id,
        db
          .select({ id: rateLimit.id })
          .from(rateLimit)
          .where(and(like(rateLimit.key, 'oauth:%'), lt(rateLimit.lastRequest, now.getTime())))
          .limit(c.batchSize),
      ),
    )
    .returning({ id: rateLimit.id });

  return {
    authorizations: authorizations.length,
    codes: codes.length,
    accessTokens: accessTokens.length,
    refreshTokens: refreshTokens.length,
    clients: clients.length,
    rateLimitBuckets: buckets.length,
  };
}
