// ADR-091 / DESIGN-050 D-06 — the token single-writers: the code exchange, refresh rotation, RFC 7009
// revocation, and the audited family revocation on reuse (hard rule 6). @hnet/oauth decides every check; these
// functions read the row, apply the decision and write — the code consume and the rotation are conditional
// UPDATEs (race-safe across the three replicas), and every issue happens in the same transaction as its consume.
import {
  oauthAccessTokens,
  oauthAudit,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  type DbClient,
  type OAuthClientRow,
} from '@hnet/db';
import {
  authEvent,
  decideCodeExchange,
  decideRefresh,
  decideRevocation,
  fingerprint,
  hashToken,
  invalidGrant,
  planTokenPair,
  type TokenPairPlan,
  type TokenResponse,
} from '@hnet/oauth';
import { and, eq, isNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from '../db-client';

/** Insert a planned pair (access + optional refresh) inside an open transaction. */
async function insertPair(tx: DbClient, plan: TokenPairPlan): Promise<void> {
  await tx.insert(oauthAccessTokens).values(plan.access.row);
  if (plan.refresh) await tx.insert(oauthRefreshTokens).values(plan.refresh.row);
}

/**
 * D-06 `authorization_code` — look the code up by hash, run every check (@hnet/oauth `decideCodeExchange`), then
 * in ONE transaction consume it (a conditional UPDATE — of two racing exchanges exactly one wins; the loser is a
 * replay) and insert the new family's access token (and refresh token with `offline_access`).
 */
export async function exchangeCode(input: {
  db?: DbClient;
  client: OAuthClientRow;
  request: { code: string; codeVerifier?: string; redirectUri?: string; resource?: string };
  now?: Date;
}): Promise<TokenResponse> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  const { client, request } = input;
  const [rec] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashToken(request.code)))
    .limit(1);
  const grant = decideCodeExchange(rec, client, request, now);
  const plan = planTokenPair({
    clientId: client.clientId,
    userId: grant.userId,
    scopes: grant.scopes,
    resource: grant.resource,
    now,
  });
  const issued = await inTransaction(db, async (tx) => {
    const consumed = await tx
      .update(oauthAuthorizationCodes)
      .set({ consumedAt: now })
      .where(
        and(eq(oauthAuthorizationCodes.id, rec!.id), isNull(oauthAuthorizationCodes.consumedAt)),
      )
      .returning({ id: oauthAuthorizationCodes.id });
    if (consumed.length === 0) return false;
    await insertPair(tx, plan);
    return true;
  });
  if (!issued) {
    authEvent('code_replayed', { client_id: client.clientId, code: fingerprint(request.code) });
    throw invalidGrant('Authorization code already used');
  }
  authEvent('token_issued', {
    client_id: client.clientId,
    family: plan.familyId,
    scopes: grant.scopes,
    offline: plan.refresh !== null,
    access: fingerprint(plan.access.token),
    ...(plan.refresh ? { refresh: fingerprint(plan.refresh.token) } : {}),
  });
  return plan.response;
}

/**
 * D-03 / D-06 — the audited family revocation (hard rule 6): a spent or revoked refresh token was presented (a
 * theft signal), so every refresh and access token of its family is revoked and a `family_revoked_on_reuse`
 * audit row is written, in one transaction. The detection itself is the audited event, so a replay against an
 * already-revoked family still writes its row (with zero counts).
 */
export async function revokeFamilyOnReuse(input: {
  db?: DbClient;
  familyId: string;
  clientId: string;
  userId: string;
  reason: 'rotated' | 'revoked' | 'race';
  now?: Date;
}): Promise<{ refreshRevoked: number; accessRevoked: number }> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const refresh = await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(oauthRefreshTokens.familyId, input.familyId), isNull(oauthRefreshTokens.revokedAt)),
      )
      .returning({ id: oauthRefreshTokens.id });
    const access = await tx
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(oauthAccessTokens.familyId, input.familyId), isNull(oauthAccessTokens.revokedAt)),
      )
      .returning({ id: oauthAccessTokens.id });
    await tx.insert(oauthAudit).values({
      event: 'family_revoked_on_reuse',
      userId: input.userId,
      clientId: input.clientId,
      familyId: input.familyId,
      details: {
        reason: input.reason,
        refresh_revoked: refresh.length,
        access_revoked: access.length,
      },
      at: now,
    });
    return { refreshRevoked: refresh.length, accessRevoked: access.length };
  });
}

/**
 * D-06 `refresh_token` — rotation with reuse detection. The decision (@hnet/oauth `decideRefresh`) says reuse
 * for a spent or revoked token: the family is revoked (audited) and the call answers `invalid_grant`. Otherwise,
 * in ONE transaction, the token is marked spent with a conditional UPDATE and the new pair joins the family
 * (parent = the spent token). Losing that UPDATE to a concurrent rotation means this request presented a token
 * that is now spent, so it is reuse as well — the revocation runs AFTER the rotation transaction, in the audited
 * writer's own (cigar-journal revoked inside the rotation transaction and then threw, rolling the revocation back).
 */
export async function rotateRefreshToken(input: {
  db?: DbClient;
  client: OAuthClientRow;
  request: { refreshToken: string; scope?: string; resource?: string };
  now?: Date;
}): Promise<TokenResponse> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  const { client, request } = input;
  const [rec] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, hashToken(request.refreshToken)))
    .limit(1);
  const decision = decideRefresh(rec, client, request, now);
  const reuse = async (reason: 'rotated' | 'revoked' | 'race'): Promise<never> => {
    const r = rec!;
    await revokeFamilyOnReuse({
      db,
      familyId: r.familyId,
      clientId: r.clientId,
      userId: r.userId,
      reason,
      now,
    });
    authEvent('refresh_reuse_detected', {
      client_id: client.clientId,
      family: r.familyId,
      reason,
      refresh: fingerprint(request.refreshToken),
    });
    throw invalidGrant('Refresh token already used');
  };
  if (decision.kind === 'reuse') return reuse(decision.reason);
  const r = rec!;
  const plan = planTokenPair({
    clientId: client.clientId,
    userId: r.userId,
    scopes: decision.scopes,
    resource: r.resource,
    familyId: r.familyId,
    parentRefreshId: r.id,
    now,
  });
  const rotated = await inTransaction(db, async (tx) => {
    const spent = await tx
      .update(oauthRefreshTokens)
      .set({ rotatedAt: now })
      .where(
        and(
          eq(oauthRefreshTokens.id, r.id),
          isNull(oauthRefreshTokens.rotatedAt),
          isNull(oauthRefreshTokens.revokedAt),
        ),
      )
      .returning({ id: oauthRefreshTokens.id });
    if (spent.length === 0) return false;
    await insertPair(tx, plan);
    return true;
  });
  if (!rotated) return reuse('race');
  authEvent('token_refreshed', {
    client_id: client.clientId,
    family: r.familyId,
    scopes: decision.scopes,
    old_refresh: fingerprint(request.refreshToken),
    access: fingerprint(plan.access.token),
    ...(plan.refresh ? { refresh: fingerprint(plan.refresh.token) } : {}),
  });
  return plan.response;
}

/**
 * D-06 / RFC 7009 — revoke what a client presents: a refresh token or a family access token revokes the family
 * (one transaction); a standalone access token is revoked alone; an unknown token or another client's is ignored
 * (the route answers 200 either way). Client-initiated, so not audited (ChatGPT calls this on every reconnect);
 * each outcome logs `token_revoked`.
 */
export async function revokeToken(input: {
  db?: DbClient;
  client: OAuthClientRow;
  token: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  const hash = hashToken(input.token);
  const [refresh] = await db
    .select({ clientId: oauthRefreshTokens.clientId, familyId: oauthRefreshTokens.familyId })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, hash))
    .limit(1);
  const [access] = refresh
    ? []
    : await db
        .select({
          id: oauthAccessTokens.id,
          clientId: oauthAccessTokens.clientId,
          familyId: oauthAccessTokens.familyId,
        })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.tokenHash, hash))
        .limit(1);
  const decision = decideRevocation({ refresh, access }, input.client.clientId);
  if (decision.kind === 'family') {
    await inTransaction(db, async (tx) => {
      await tx
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthRefreshTokens.familyId, decision.familyId),
            isNull(oauthRefreshTokens.revokedAt),
          ),
        );
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthAccessTokens.familyId, decision.familyId),
            isNull(oauthAccessTokens.revokedAt),
          ),
        );
    });
    authEvent('token_revoked', {
      kind: decision.tokenKind,
      client_id: input.client.clientId,
      family: decision.familyId,
      token: fingerprint(input.token),
    });
    return;
  }
  if (decision.kind === 'access') {
    await db
      .update(oauthAccessTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthAccessTokens.id, decision.accessId), isNull(oauthAccessTokens.revokedAt)));
    authEvent('token_revoked', {
      kind: 'access',
      client_id: input.client.clientId,
      token: fingerprint(input.token),
    });
    return;
  }
  authEvent('token_revoked', {
    kind: decision.reason,
    client_id: input.client.clientId,
    token: fingerprint(input.token),
  });
}
