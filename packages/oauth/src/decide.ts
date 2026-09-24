// ADR-091 / DESIGN-050 D-03..D-07 — the authorization server's DECISIONS, pure: given the rows the @hnet/domain
// writers read, decide what to insert, issue, rotate, revoke, refuse or prune. Ported from the decision half of
// cigar-journal `packages/oauth/src/provider.ts` / `validate.ts`. D-01: `@hnet/oauth` decides and
// `@hnet/domain` writes — nothing here touches a database (row shapes are `import type` from @hnet/db only), so
// every rule is unit-testable and every write stays inside a guarded single-writer.
import { randomUUID } from 'node:crypto';
import type {
  OAuthAccessTokenInsert,
  OAuthAuthorizationCodeInsert,
  OAuthAuthorizationInsert,
  OAuthClientInsert,
  OAuthRefreshTokenInsert,
} from '@hnet/db';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_TTL_SECONDS,
  CODE_TTL_SECONDS,
  CODE_VERIFIER_PATTERN,
  DORMANT_CLIENT_DAYS,
  LAST_USED_RESOLUTION_MS,
  PRUNE_BATCH_SIZE,
  PRUNE_RETENTION_DAYS,
  REFRESH_TOKEN_TTL_SECONDS,
  SCOPE_DESCRIPTIONS,
  SCOPE_PARAM_MAX_LENGTH,
  WATCH_SCOPES,
  canonicalScopes,
  mcpResource,
  resourceMatches,
  type OAuthEnv,
  type OAuthGrantType,
  type OAuthScope,
  type WatchScope,
} from './config';
import { hashToken, randomClientId, randomToken, safeEqual, verifyPkceS256 } from './crypto';
import {
  OAuthError,
  invalidClient,
  invalidGrant,
  invalidRedirectUri,
  invalidScope,
  invalidTarget,
} from './errors';
import { authEvent, fingerprint, loggableResource, redirectHost } from './logger';
import {
  redirectUriMatches,
  splitScopes,
  type ClientCredentials,
  type ClientRegistration,
  type ValidatedAuthorization,
} from './validate';

const plusSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);
const DAY_MS = 86_400_000;

/** The client fields every decision reads (a structural subset of the `oauth_clients` row). */
export interface ClientRecord {
  clientId: string;
  clientName: string;
  clientSecretHash: string | null;
  redirectUris: string[];
  grantTypes: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

// ---- registration (D-04) ------------------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  /** RFC 7591 §3.2.1: REQUIRED with a secret; 0 = the secret does not expire. */
  client_secret_expires_at?: number;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

/**
 * D-04 — mint a client for a validated registration: a 32-hex public id, and for a confidential method a secret
 * returned ONCE (in the RFC 7591 response) and stored only as its SHA-256.
 */
export function planClientRegistration(
  reg: ClientRegistration,
  ctx: { now: Date; registeredIp?: string | null },
): { row: OAuthClientInsert; response: RegisteredClient } {
  const clientId = randomClientId();
  const secret = reg.authMethod === 'none' ? undefined : randomToken();
  return {
    row: {
      clientId,
      clientSecretHash: secret ? hashToken(secret) : null,
      clientName: reg.clientName,
      redirectUris: reg.redirectUris,
      grantTypes: reg.grantTypes,
      responseTypes: reg.responseTypes,
      scope: reg.scope,
      tokenEndpointAuthMethod: reg.authMethod,
      registeredIp: ctx.registeredIp ? ctx.registeredIp.slice(0, 64) : null,
      createdAt: ctx.now,
    },
    response: {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(ctx.now.getTime() / 1000),
      client_name: reg.clientName,
      redirect_uris: reg.redirectUris,
      grant_types: reg.grantTypes,
      response_types: reg.responseTypes,
      token_endpoint_auth_method: reg.authMethod,
      ...(reg.scope ? { scope: reg.scope } : {}),
    },
  };
}

/**
 * D-06 — token / revoke client authentication: the client must exist; a confidential client's secret is compared
 * as digests in constant time; a public client proves itself later with PKCE.
 */
export function checkClientCredentials<C extends Pick<ClientRecord, 'clientSecretHash'>>(
  client: C | undefined,
  creds: Pick<ClientCredentials, 'clientId' | 'clientSecret'>,
): C {
  if (!creds.clientId) throw invalidClient('client_id is required');
  if (!client) throw invalidClient('Unknown client');
  if (client.clientSecretHash) {
    const secret = creds.clientSecret ?? '';
    if (!secret) throw invalidClient('client_secret is required for this client');
    if (!safeEqual(hashToken(secret), client.clientSecretHash))
      throw invalidClient('Invalid client_secret');
  }
  return client;
}

/** D-05 step 1 — the redirect must match a registered one (the loopback rule); refused ⇒ never redirected to. */
export function checkRegisteredRedirect(
  client: Pick<ClientRecord, 'redirectUris'>,
  redirectUri: string | undefined,
): string {
  if (!redirectUri) throw invalidRedirectUri('redirect_uri is required');
  if (!client.redirectUris.some((uri) => redirectUriMatches(uri, redirectUri))) {
    throw invalidRedirectUri('redirect_uri does not match a registered value');
  }
  return redirectUri;
}

/** RFC 6749 §4 / §6: a client may use only a grant it registered for. */
export function assertGrantAllowed(
  client: Pick<ClientRecord, 'grantTypes'>,
  grant: OAuthGrantType,
): void {
  if (!client.grantTypes.includes(grant)) {
    throw new OAuthError('unauthorized_client', `Client is not registered for the ${grant} grant`);
  }
}

// ---- authorization + consent (D-05) -------------------------------------------------------------------

/** D-05 step 5 — the pending transaction for the SIGNED-IN user (10 minutes). */
export function planAuthorization(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  validated: ValidatedAuthorization;
  now: Date;
}): OAuthAuthorizationInsert {
  return {
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.validated.scopes,
    resource: input.validated.resource,
    state: input.validated.state,
    codeChallenge: input.validated.codeChallenge,
    codeChallengeMethod: input.validated.codeChallengeMethod,
    expiresAt: plusSeconds(input.now, AUTHORIZATION_TTL_SECONDS),
    createdAt: input.now,
  };
}

/** The transaction fields the consent decisions read. */
export interface TransactionRecord {
  id: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  resource: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
}

export interface ConsentScopeLine {
  scope: OAuthScope;
  description: string;
}

/**
 * D-14 — one consent line per requested scope, in the advertised order. Plex write-back is owner-only
 * (ADR-091 C-04), so `watch:write` promises a Plex change only when the signed-in user IS the server owner.
 */
export function consentScopeLines(
  scopes: readonly OAuthScope[],
  opts: { writesPlex: boolean },
): ConsentScopeLine[] {
  return canonicalScopes(scopes).map((scope) => ({
    scope,
    description:
      scope === 'watch:write'
        ? SCOPE_DESCRIPTIONS['watch:write'][opts.writesPlex ? 'owner' : 'other']
        : SCOPE_DESCRIPTIONS[scope],
  }));
}

export interface ConsentView {
  txnId: string;
  clientId: string;
  clientName: string;
  /** Where Approve sends the browser (anyone can register a client named "ChatGPT"). */
  redirectHost: string;
  scopes: OAuthScope[];
}

export type ConsentLookup =
  | { status: 'ok'; view: ConsentView }
  /** The user's own transaction, past its 10 minutes: the expired page names the client. */
  | { status: 'expired'; clientName: string }
  /** Malformed, unknown, already decided, or another user's: the expired page says "your app". */
  | { status: 'missing' };

/**
 * D-05 step 6 — what the consent page shows for a transaction. Another user's transaction is `missing`, so its
 * client name never leaks; the user's own expired one is `expired` (the page names the client).
 */
export function consentLookup(
  row:
    | (Pick<
        TransactionRecord,
        'id' | 'clientId' | 'userId' | 'redirectUri' | 'scopes' | 'expiresAt'
      > & {
        clientName: string;
      })
    | undefined,
  userId: string,
  now: Date,
): ConsentLookup {
  if (!row || row.userId !== userId) return { status: 'missing' };
  if (row.expiresAt.getTime() <= now.getTime())
    return { status: 'expired', clientName: row.clientName };
  return {
    status: 'ok',
    view: {
      txnId: row.id,
      clientId: row.clientId,
      clientName: row.clientName,
      redirectHost: redirectHost(row.redirectUri),
      scopes: canonicalScopes(row.scopes),
    },
  };
}

/** The client redirect for a decided request: `code` + `state`, or `error` + `state` (RFC 6749 §4.1.2). */
export function clientRedirect(redirectUri: string, params: Record<string, string>): string {
  const target = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return target.href;
}

/**
 * D-05 step 7 — Approve: a single-use code (60 s) bound to the transaction, and the redirect carrying it. An
 * expired transaction issues nothing (re-checked inside the writer's transaction).
 */
export function planApproval(
  txn: TransactionRecord,
  now: Date,
):
  | { kind: 'expired' }
  | { kind: 'grant'; code: string; row: OAuthAuthorizationCodeInsert; redirectUrl: string } {
  if (txn.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
  const code = randomToken();
  return {
    kind: 'grant',
    code,
    row: {
      codeHash: hashToken(code),
      clientId: txn.clientId,
      userId: txn.userId,
      redirectUri: txn.redirectUri,
      scopes: canonicalScopes(txn.scopes),
      resource: txn.resource,
      codeChallenge: txn.codeChallenge,
      codeChallengeMethod: 'S256',
      expiresAt: plusSeconds(now, CODE_TTL_SECONDS),
      createdAt: now,
    },
    redirectUrl: clientRedirect(txn.redirectUri, { code, state: txn.state }),
  };
}

/** D-05 step 7 — Deny: the client learns `access_denied` (with its `state`). */
export function denialRedirect(txn: Pick<TransactionRecord, 'redirectUri' | 'state'>): string {
  return clientRedirect(txn.redirectUri, { error: 'access_denied', state: txn.state });
}

// ---- tokens (D-06) ------------------------------------------------------------------------------------

/** The code fields the exchange decision reads. */
export interface CodeRecord {
  id: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  resource: string;
  codeChallenge: string;
  expiresAt: Date;
  consumedAt: Date | null;
  /** The refresh family the code's exchange started (null until consumed, or when nothing was issued). */
  familyId?: string | null;
}

/**
 * RFC 6749 §4.1.2 — a code presented after it was consumed is a replay: the family its exchange started must be
 * revoked (the authorization server SHOULD revoke every token issued from it). Null when there is nothing to revoke.
 */
export function replayedCodeFamily(
  rec: Pick<CodeRecord, 'consumedAt' | 'familyId'> | undefined,
): string | null {
  return rec?.consumedAt && rec.familyId ? rec.familyId : null;
}

/**
 * D-06 `authorization_code` — every check before the atomic consume: the client registered the grant; the code
 * exists (by hash); a consumed one is a replay (`code_replayed`); it was issued to this client and is unexpired;
 * `redirect_uri`, if sent, matches (loopback-tolerant); the verifier is well formed and passes S256 in constant
 * time; `resource`, if sent, is the code's. Returns what to issue.
 */
export function decideCodeExchange(
  rec: CodeRecord | undefined,
  client: Pick<ClientRecord, 'clientId' | 'grantTypes'>,
  req: { code: string; codeVerifier?: string; redirectUri?: string; resource?: string },
  now: Date,
): { userId: string; scopes: OAuthScope[]; resource: string } {
  assertGrantAllowed(client, 'authorization_code');
  if (!rec) throw invalidGrant('Invalid authorization code');
  if (rec.consumedAt) {
    authEvent('code_replayed', { client_id: client.clientId, code: fingerprint(req.code) });
    throw invalidGrant('Authorization code already used');
  }
  if (rec.clientId !== client.clientId)
    throw invalidGrant('Authorization code was issued to another client');
  if (rec.expiresAt.getTime() <= now.getTime()) throw invalidGrant('Authorization code expired');
  // RFC 6749 §4.1.3: if sent, it must be the authorization request's — with the loopback exemption, since a
  // native client may hand a different loopback literal or port here than the browser leg carried.
  if (req.redirectUri !== undefined && !redirectUriMatches(rec.redirectUri, req.redirectUri)) {
    throw invalidGrant('redirect_uri does not match the authorization request');
  }
  if (!req.codeVerifier) throw invalidGrant('PKCE code_verifier is required');
  if (
    !CODE_VERIFIER_PATTERN.test(req.codeVerifier) ||
    !verifyPkceS256(req.codeVerifier, rec.codeChallenge)
  ) {
    throw invalidGrant('PKCE verification failed');
  }
  if (req.resource !== undefined && !resourceMatches(req.resource, rec.resource)) {
    authEvent('audience_mismatch', {
      phase: 'token',
      client_id: client.clientId,
      requested: loggableResource(req.resource),
      expected: rec.resource,
    });
    throw invalidTarget('Unknown resource indicator');
  }
  return { userId: rec.userId, scopes: canonicalScopes(rec.scopes), resource: rec.resource };
}

export interface TokenPairPlan {
  familyId: string;
  access: { token: string; row: OAuthAccessTokenInsert };
  refresh: { token: string; row: OAuthRefreshTokenInsert } | null;
  response: TokenResponse;
}

/**
 * D-03 / D-06 — mint an access token (1 h) and, only with `offline_access` (and the refresh grant registered), a
 * refresh token (60 days), into a family (a new one for a code exchange; the same one for a rotation, with the spent token as parent).
 */
export function planTokenPair(input: {
  clientId: string;
  userId: string;
  scopes: OAuthScope[];
  resource: string;
  familyId?: string;
  parentRefreshId?: string;
  /**
   * The client registered the `refresh_token` grant. A refresh token it could never use (the grant check refuses
   * it) would only linger as a "live connection" for 60 days, so none is issued. Default true.
   */
  refreshAllowed?: boolean;
  now: Date;
}): TokenPairPlan {
  const familyId = input.familyId ?? randomUUID();
  const scopes = canonicalScopes(input.scopes);
  const accessToken = randomToken();
  const refreshToken =
    scopes.includes('offline_access') && input.refreshAllowed !== false ? randomToken() : null;
  return {
    familyId,
    access: {
      token: accessToken,
      row: {
        tokenHash: hashToken(accessToken),
        familyId,
        clientId: input.clientId,
        userId: input.userId,
        scopes,
        resource: input.resource,
        expiresAt: plusSeconds(input.now, ACCESS_TOKEN_TTL_SECONDS),
        createdAt: input.now,
      },
    },
    refresh: refreshToken
      ? {
          token: refreshToken,
          row: {
            tokenHash: hashToken(refreshToken),
            familyId,
            parentId: input.parentRefreshId ?? null,
            clientId: input.clientId,
            userId: input.userId,
            scopes,
            resource: input.resource,
            expiresAt: plusSeconds(input.now, REFRESH_TOKEN_TTL_SECONDS),
            createdAt: input.now,
          },
        }
      : null,
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(' '),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    },
  };
}

/** The refresh-token fields the rotation decision reads. */
export interface RefreshRecord {
  id: string;
  familyId: string;
  clientId: string;
  userId: string;
  scopes: OAuthScope[];
  resource: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export type RefreshDecision =
  /**
   * A spent token (`rotated` — ever rotated, even if revoked since) is theft: revoke the family with its audit row.
   * A `revoked` token that was never rotated is the aftermath of a chosen revocation: refused quietly.
   */
  | { kind: 'reuse'; reason: 'rotated' | 'revoked' }
  /** Rotate: mark this token spent (conditionally — a lost race is reuse too) and issue the pair with `scopes`. */
  | { kind: 'rotate'; scopes: OAuthScope[] };

/**
 * D-06 `refresh_token` — the client registered the grant; the token exists and is this client's (another
 * client's ⇒ `invalid_grant`, D-06); spent or revoked ⇒ reuse; expired ⇒ `invalid_grant`; `resource`, if sent,
 * is the token's; a `scope`, if sent, may narrow the grant but never widen it.
 */
export function decideRefresh(
  rec: RefreshRecord | undefined,
  client: Pick<ClientRecord, 'clientId' | 'grantTypes'>,
  req: { scope?: string; resource?: string },
  now: Date,
): RefreshDecision {
  assertGrantAllowed(client, 'refresh_token');
  if (!rec) throw invalidGrant('Invalid refresh token');
  if (rec.clientId !== client.clientId)
    throw invalidGrant('Refresh token was issued to another client');
  // A token that was ever ROTATED is spent: presenting it again is reuse whatever happened to it since (a revocation
  // afterwards must not silence the theft alert). Only a token revoked while still unspent is the quiet case.
  if (rec.rotatedAt) return { kind: 'reuse', reason: 'rotated' };
  if (rec.revokedAt) return { kind: 'reuse', reason: 'revoked' };
  if (rec.expiresAt.getTime() <= now.getTime()) throw invalidGrant('Refresh token expired');
  if (req.resource !== undefined && !resourceMatches(req.resource, rec.resource)) {
    authEvent('audience_mismatch', {
      phase: 'refresh',
      client_id: client.clientId,
      requested: loggableResource(req.resource),
      expected: rec.resource,
    });
    throw invalidTarget('Unknown resource indicator');
  }
  let scopes = canonicalScopes(rec.scopes);
  if (req.scope !== undefined && req.scope.trim() !== '') {
    if (req.scope.length > SCOPE_PARAM_MAX_LENGTH) throw invalidScope('scope is too long');
    const requested = splitScopes(req.scope);
    if (requested.some((s) => !(rec.scopes as string[]).includes(s))) {
      throw invalidScope('scope exceeds the original grant');
    }
    scopes = canonicalScopes(requested);
  }
  return { kind: 'rotate', scopes };
}

export type RevocationDecision =
  | { kind: 'family'; familyId: string; tokenKind: 'refresh' | 'access' }
  | { kind: 'access'; accessId: string }
  | { kind: 'ignore'; reason: 'unknown' | 'foreign' };

/**
 * D-06 / RFC 7009 — a refresh token, or an access token that belongs to a family, revokes the family; a
 * standalone access token is revoked alone; an unknown token or another client's is ignored silently (RFC 7009
 * §2.1 — the endpoint answers 200 either way).
 */
export function decideRevocation(
  found: {
    refresh?: { clientId: string; familyId: string };
    access?: { id: string; clientId: string; familyId: string | null };
  },
  clientId: string,
): RevocationDecision {
  if (found.refresh) {
    return found.refresh.clientId === clientId
      ? { kind: 'family', familyId: found.refresh.familyId, tokenKind: 'refresh' }
      : { kind: 'ignore', reason: 'foreign' };
  }
  if (found.access) {
    if (found.access.clientId !== clientId) return { kind: 'ignore', reason: 'foreign' };
    return found.access.familyId
      ? { kind: 'family', familyId: found.access.familyId, tokenKind: 'access' }
      : { kind: 'access', accessId: found.access.id };
  }
  return { kind: 'ignore', reason: 'unknown' };
}

// ---- the bearer at /mcp (D-07) ------------------------------------------------------------------------

export type BearerRefusal = 'invalid_token' | 'revoked' | 'expired' | 'audience_mismatch';

/**
 * D-07 — is a looked-up access token usable at `/mcp`? Refused when unknown, revoked, expired, or bound to a
 * resource other than the canonical one (RFC 8707: a token minted for another audience — or before the issuer
 * changed — is not valid here). Returns the token's watch scopes (its scopes ∩ the two MCP scopes).
 */
export function decideBearer(
  row:
    | {
        scopes: OAuthScope[];
        resource: string;
        expiresAt: Date;
        revokedAt: Date | null;
        clientId: string;
      }
    | undefined,
  ctx: { now: Date; env?: OAuthEnv },
): { ok: true; scopes: WatchScope[] } | { ok: false; error: BearerRefusal } {
  if (!row) return { ok: false, error: 'invalid_token' };
  if (row.revokedAt) return { ok: false, error: 'revoked' };
  if (row.expiresAt.getTime() <= ctx.now.getTime()) return { ok: false, error: 'expired' };
  const canonical = mcpResource(ctx.env);
  if (!resourceMatches(row.resource, canonical)) {
    authEvent('audience_mismatch', {
      phase: 'mcp',
      client_id: row.clientId,
      requested: loggableResource(row.resource),
      expected: canonical,
    });
    return { ok: false, error: 'audience_mismatch' };
  }
  return { ok: true, scopes: WATCH_SCOPES.filter((s) => (row.scopes as string[]).includes(s)) };
}

/** D-07 — stamp `last_used_at` at most once a minute: true when it is unset or at least a minute old. */
export function lastUsedIsStale(lastUsedAt: Date | null, now: Date): boolean {
  return lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS;
}

// ---- pruning (D-03) -----------------------------------------------------------------------------------

export interface PruneCutoffs {
  /** Transactions and codes with `expires_at` before this are deleted. */
  expiredBefore: Date;
  /** Tokens expired or revoked before this (30 days ago) are deleted. */
  retainedBefore: Date;
  /** DCR clients created before this (30 days ago) that own no token and no transaction are deleted. */
  dormantBefore: Date;
  /** At most this many rows per table per call. */
  batchSize: number;
}

/** D-03 — the inline pruner's thresholds for one `/oauth/token` call. */
export function pruneCutoffs(now: Date): PruneCutoffs {
  return {
    expiredBefore: now,
    retainedBefore: new Date(now.getTime() - PRUNE_RETENTION_DAYS * DAY_MS),
    dormantBefore: new Date(now.getTime() - DORMANT_CLIENT_DAYS * DAY_MS),
    batchSize: PRUNE_BATCH_SIZE,
  };
}
