// ADR-091 / DESIGN-050 D-07 — the public `/mcp` consumer source: a delegated OAuth access token. A read-only hash
// lookup (@hnet/domain `selectBearerToken`, joined to the user and the client) judged by @hnet/oauth
// `decideBearer` — refused when unknown, revoked, expired or bound to another resource — then the consumer
// `{ name: 'oauth:<client_id>', scopes: <token scopes ∩ watch scopes>, userId }`. No owner check here: the
// principal is the token's user (ADR-091 C-04), resolved to their own tracked account at tool time.
// Failures answer 401 with the RFC 9728 challenge `WWW-Authenticate: Bearer resource_metadata="…"` (what makes
// ChatGPT, Claude Code and Codex start the OAuth flow); a tool outside the token's scopes answers 403
// `insufficient_scope`. `last_used_at` is stamped on the token and the client at most once a minute.
import { selectBearerToken, touchLastUsed } from '@hnet/domain';
import {
  decideBearer,
  parseBearer,
  protectedResourceMetadataUrl,
  type OAuthEnv,
} from '@hnet/oauth';
import type { DbClient } from '@hnet/db';
import { jsonRpcError, type AuthResult } from './auth';

export interface OAuthAuthOptions {
  db?: DbClient;
  now?: () => Date;
  env?: OAuthEnv;
}

/**
 * `WWW-Authenticate` for a missing or refused bearer (RFC 9728 §5.1). With no credential presented there is no error
 * code (RFC 6750 §3.1); a bearer that was presented but refused (unknown, revoked, expired, another audience) adds
 * `error="invalid_token"`.
 */
export function oauthChallenge(env: OAuthEnv = process.env, presented = false): string {
  const error = presented ? 'error="invalid_token", ' : '';
  return `Bearer ${error}resource_metadata="${protectedResourceMetadataUrl(env)}"`;
}

/** `WWW-Authenticate` for a tool the token's scopes do not cover (RFC 6750 §3.1), naming the scope it needs. */
export function insufficientScopeChallenge(required: string, env: OAuthEnv = process.env): string {
  return `Bearer error="insufficient_scope", scope="${required}", resource_metadata="${protectedResourceMetadataUrl(env)}"`;
}

export async function authenticateOAuth(
  req: Request,
  opts: OAuthAuthOptions = {},
): Promise<AuthResult> {
  const env = opts.env ?? process.env;
  const now = opts.now?.() ?? new Date();
  const header = req.headers.get('authorization');
  // A Bearer credential was presented (well formed or not): a refusal says `invalid_token`.
  const presented = /^\s*bearer\b/i.test(header ?? '');
  const unauthorized = (): AuthResult => ({
    ok: false,
    response: jsonRpcError(401, -32001, 'Unauthorized', {
      'www-authenticate': oauthChallenge(env, presented),
    }),
  });
  const token = parseBearer(header);
  if (!token) return unauthorized();
  const row = await selectBearerToken({ db: opts.db, token });
  const decision = decideBearer(row, { now, env });
  if (!decision.ok || !row) return unauthorized();
  try {
    await touchLastUsed({
      db: opts.db,
      tokenId: row.id,
      clientId: row.clientId,
      tokenLastUsedAt: row.lastUsedAt,
      clientLastUsedAt: row.clientLastUsedAt,
      now,
    });
  } catch (error) {
    // Bookkeeping only: a failed stamp never fails the call.
    console.error(
      '[mcp] last_used stamp failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    ok: true,
    consumer: { name: `oauth:${row.clientId}`, scopes: decision.scopes, userId: row.userId },
    insufficientScope: (required) =>
      jsonRpcError(403, -32001, 'Insufficient scope', {
        'www-authenticate': insufficientScopeChallenge(required, env),
      }),
  };
}
