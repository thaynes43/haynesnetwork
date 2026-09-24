// ADR-091 / DESIGN-050 D-06 — `POST /oauth/token`: the `authorization_code` grant (code + PKCE verifier) and the
// `refresh_token` grant (rotation with reuse detection), form-encoded only (a JSON body is 400 invalid_request),
// rate-limited to 60 per minute per client IP (D-10). Client authentication: `client_id` in the body or HTTP
// Basic. Every answer is `no-store`. After answering, the inline pruner runs (D-03 — bounded, never on the
// response path, and a pruning failure is logged and dropped).
import { after } from 'next/server';
import {
  authenticateOAuthClient,
  exchangeCode,
  pruneExpired,
  rotateRefreshToken,
} from '@hnet/domain';
import { parseClientCredentials, parseTokenRequest } from '@hnet/oauth';
import {
  clientIp,
  json,
  limitRequest,
  oauthErrorResponse,
  preflight,
  rateLimitedResponse,
  readFormBody,
} from '@/lib/oauth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** D-10: 60 token requests per minute per client IP. */
export const TOKEN_LIMIT = { windowSeconds: 60, max: 60 } as const;

/** D-03: prune expired OAuth rows after the response is sent. */
export function schedulePrune(): void {
  after(async () => {
    try {
      await pruneExpired();
    } catch (error) {
      console.error('[oauth] prune failed', error instanceof Error ? error.message : String(error));
    }
  });
}

export async function POST(req: Request): Promise<Response> {
  const limit = await limitRequest(
    'token',
    clientIp(req.headers),
    TOKEN_LIMIT.windowSeconds,
    TOKEN_LIMIT.max,
  );
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds);
  schedulePrune();
  let basic = false;
  try {
    const params = await readFormBody(req);
    const credentials = parseClientCredentials(req.headers.get('authorization'), params);
    basic = credentials.via === 'basic';
    const client = await authenticateOAuthClient({ credentials });
    const request = parseTokenRequest(params);
    const tokens =
      request.grantType === 'authorization_code'
        ? await exchangeCode({ client, request })
        : await rotateRefreshToken({ client, request });
    return json(tokens);
  } catch (error) {
    return oauthErrorResponse(error, { basicChallenge: basic });
  }
}

export function OPTIONS(): Response {
  return preflight();
}
