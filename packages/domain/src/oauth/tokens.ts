// ADR-091 / DESIGN-050 D-06 — the token single-writers: the code exchange, refresh rotation, RFC 7009
// revocation, and the audited family revocation on reuse (hard rule 6). @hnet/oauth decides every check; these
// functions read the row, apply the decision and write — the code consume and the rotation are conditional
// UPDATEs (race-safe across the three replicas), and every issue happens in the same transaction as its consume.
//
// Revocation versus a concurrent rotation (READ COMMITTED): a revoking UPDATE that waited on a rotation's row lock
// re-checks only the rows its own statement saw, never the child token the rotation just inserted. So every family
// revocation here sweeps refresh, then access, then refresh AGAIN — each statement a fresh snapshot, and by the
// time the first one finished, any rotation it waited on has committed. A rotation that reaches the parent after
// the revocation locked it finds `revoked_at` set and mints nothing.
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
  replayedCodeFamily,
  type TokenPairPlan,
  type TokenResponse,
} from '@hnet/oauth';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from '../db-client';

/** Insert a planned pair (access + optional refresh) inside an open transaction. */
async function insertPair(tx: DbClient, plan: TokenPairPlan): Promise<void> {
  await tx.insert(oauthAccessTokens).values(plan.access.row);
  if (plan.refresh) await tx.insert(oauthRefreshTokens).values(plan.refresh.row);
}

/**
 * Revoke every refresh and access token of one family inside an open transaction: refresh, access, then refresh
 * again (the module note: the second sweep catches a child a racing rotation committed meanwhile). Counts.
 */
async function revokeFamilyRows(
  tx: DbClient,
  familyId: string,
  now: Date,
): Promise<{ refreshRevoked: number; accessRevoked: number }> {
  const sweepRefresh = () =>
    tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthRefreshTokens.familyId, familyId), isNull(oauthRefreshTokens.revokedAt)))
      .returning({ id: oauthRefreshTokens.id });
  const first = await sweepRefresh();
  const access = await tx
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthAccessTokens.familyId, familyId), isNull(oauthAccessTokens.revokedAt)))
    .returning({ id: oauthAccessTokens.id });
  const second = await sweepRefresh();
  return { refreshRevoked: first.length + second.length, accessRevoked: access.length };
}

/**
 * D-06 `authorization_code` — look the code up by hash, run every check (@hnet/oauth `decideCodeExchange`), then
 * in ONE transaction consume it (a conditional UPDATE — of two racing exchanges exactly one wins; the loser is a
 * replay; a code a Disconnect expired meanwhile is not consumed either) and insert the new family's access token
 * (and a refresh token with `offline_access`, when the client registered the refresh grant).
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
  // RFC 6749 §4.1.2 — a replayed code revokes every token its exchange issued (audited), then is refused below.
  const replayed = replayedCodeFamily(rec);
  if (replayed && rec) {
    await revokeFamilyOnReuse({
      db,
      familyId: replayed,
      clientId: rec.clientId,
      userId: rec.userId,
      reason: 'code_replayed',
      now,
    });
  }
  const grant = decideCodeExchange(rec, client, request, now);
  const plan = planTokenPair({
    clientId: client.clientId,
    userId: grant.userId,
    scopes: grant.scopes,
    resource: grant.resource,
    refreshAllowed: client.grantTypes.includes('refresh_token'),
    now,
  });
  const issued = await inTransaction(db, async (tx) => {
    const consumed = await tx
      .update(oauthAuthorizationCodes)
      .set({ consumedAt: now, familyId: plan.familyId })
      .where(
        and(
          eq(oauthAuthorizationCodes.id, rec!.id),
          isNull(oauthAuthorizationCodes.consumedAt),
          gt(oauthAuthorizationCodes.expiresAt, now),
        ),
      )
      .returning({ id: oauthAuthorizationCodes.id });
    if (consumed.length === 0) return false;
    await insertPair(tx, plan);
    return true;
  });
  if (!issued) {
    // Lost to another exchange of the same code (or the code was expired by a Disconnect meanwhile): re-read it —
    // if it was consumed, this presentation is a replay, and the family the winner started is revoked too.
    const [fresh] = await db
      .select({
        consumedAt: oauthAuthorizationCodes.consumedAt,
        familyId: oauthAuthorizationCodes.familyId,
      })
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.id, rec!.id))
      .limit(1);
    const family = replayedCodeFamily(fresh);
    if (family) {
      await revokeFamilyOnReuse({
        db,
        familyId: family,
        clientId: rec!.clientId,
        userId: rec!.userId,
        reason: 'code_replayed',
        now,
      });
    }
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
 * D-03 / D-06 — the audited family revocation (hard rule 6): a SPENT credential was presented again — a refresh
 * token replayed after its rotation (`rotated`) or losing a rotation race (`race`), or an authorization code
 * replayed after its exchange (`code_replayed`, RFC 6749 §4.1.2) — which is a theft signal. Every refresh and access
 * token of the family is revoked and a `family_revoked_on_reuse` audit row is written, in one transaction. The
 * detection itself is the audited event, so it writes its row even when the family was already dead (zero counts).
 * A REVOKED, never-rotated refresh token presented again is not this — see `rotateRefreshToken`.
 */
export async function revokeFamilyOnReuse(input: {
  db?: DbClient;
  familyId: string;
  clientId: string;
  userId: string;
  reason: 'rotated' | 'race' | 'code_replayed';
  now?: Date;
}): Promise<{ refreshRevoked: number; accessRevoked: number }> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const counts = await revokeFamilyRows(tx, input.familyId, now);
    await tx.insert(oauthAudit).values({
      event: 'family_revoked_on_reuse',
      userId: input.userId,
      clientId: input.clientId,
      familyId: input.familyId,
      details: {
        reason: input.reason,
        refresh_revoked: counts.refreshRevoked,
        access_revoked: counts.accessRevoked,
      },
      at: now,
    });
    return counts;
  });
}

/**
 * D-06 `refresh_token` — rotation with reuse detection.
 *
 * - A SPENT token (ever rotated — even if revoked since) presented again is a theft signal: the family is revoked
 *   with its audit row (`revokeFamilyOnReuse`), `refresh_reuse_detected` is logged (the D-11 alert pages on it),
 *   `invalid_grant`.
 * - A REVOKED token that was never rotated, presented again, is the expected aftermath of a revocation someone chose — Disconnect, the
 *   client's own RFC 7009 revoke (ChatGPT revokes on every reconnect), an earlier reuse response — so it is
 *   refused quietly: `invalid_grant`, a `refresh_rejected` line, no audit row and no page. The family is swept
 *   once more, unaudited, in case a racing rotation left a live member.
 * - Otherwise, in ONE transaction, the token is marked spent with a conditional UPDATE and the new pair joins the
 *   family (parent = the spent token). Losing that UPDATE means another request changed the token first: re-read it
 *   — revoked meanwhile is the quiet refusal above; rotated meanwhile is reuse (a strict reading of D-06: of two
 *   presentations of one token, the second is a replay). The revocation runs AFTER the rotation transaction, in
 *   the audited writer's own (cigar-journal revoked inside the rotation transaction and then threw, rolling the
 *   revocation back).
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
  const reuse = async (reason: 'rotated' | 'race'): Promise<never> => {
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
  const refuseRevoked = async (): Promise<never> => {
    const r = rec!;
    const swept = await inTransaction(db, (tx) => revokeFamilyRows(tx, r.familyId, now));
    authEvent('refresh_rejected', {
      client_id: client.clientId,
      family: r.familyId,
      reason: 'revoked',
      refresh: fingerprint(request.refreshToken),
      ...(swept.refreshRevoked + swept.accessRevoked > 0 ? { swept } : {}),
    });
    throw invalidGrant('Refresh token was revoked');
  };
  if (decision.kind === 'reuse') {
    return decision.reason === 'revoked' ? refuseRevoked() : reuse(decision.reason);
  }
  const r = rec!;
  const plan = planTokenPair({
    clientId: client.clientId,
    userId: r.userId,
    scopes: decision.scopes,
    resource: r.resource,
    familyId: r.familyId,
    parentRefreshId: r.id,
    refreshAllowed: client.grantTypes.includes('refresh_token'),
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
  if (!rotated) {
    const [fresh] = await db
      .select({ rotatedAt: oauthRefreshTokens.rotatedAt, revokedAt: oauthRefreshTokens.revokedAt })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, r.id))
      .limit(1);
    // Revoked while still unspent is the quiet case; anything rotated (by the racing request) is reuse.
    if (fresh?.revokedAt && !fresh.rotatedAt) return refuseRevoked();
    return reuse('race');
  }
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
 * (one transaction, with the re-sweep); a standalone access token is revoked alone; an unknown token or another
 * client's is ignored (the route answers 200 either way). Client-initiated, so not audited (ChatGPT calls this on
 * every reconnect); each outcome logs `token_revoked`.
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
    await inTransaction(db, (tx) => revokeFamilyRows(tx, decision.familyId, now));
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
