// ADR-091 / DESIGN-050 D-06 — `POST /oauth/revoke`, RFC 7009: a refresh token or a family access token revokes the
// family, a standalone access token only itself; unknown tokens and other clients' tokens are ignored silently —
// the answer is 200 with an empty body whatever the token was (ChatGPT calls this on every reconnect). Only a
// request that fails client authentication or is malformed gets the RFC 7009 §2.2.1 error body. Rate-limited like the
// token endpoint: 60 per minute per client IP (429 + Retry-After + {"error":"rate_limited"}).
import { authenticateOAuthClient, revokeToken } from '@hnet/domain';
import { parseClientCredentials, parseRevokeRequest } from '@hnet/oauth';
import {
  CORS_HEADERS,
  clientIp,
  limitRequest,
  oauthErrorResponse,
  preflight,
  rateLimitedResponse,
  readFormBody,
} from '@/lib/oauth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 60 revocations per minute per client IP (the token endpoint's budget). */
export const REVOKE_LIMIT = { windowSeconds: 60, max: 60 } as const;

export async function POST(req: Request): Promise<Response> {
  const limit = await limitRequest(
    'revoke',
    clientIp(req.headers),
    REVOKE_LIMIT.windowSeconds,
    REVOKE_LIMIT.max,
  );
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds);
  let basic = false;
  try {
    const params = await readFormBody(req);
    const credentials = parseClientCredentials(req.headers.get('authorization'), params);
    basic = credentials.via === 'basic';
    const client = await authenticateOAuthClient({ credentials });
    const { token } = parseRevokeRequest(params);
    await revokeToken({ client, token });
    return new Response(null, {
      status: 200,
      headers: { 'cache-control': 'no-store', ...CORS_HEADERS },
    });
  } catch (error) {
    return oauthErrorResponse(error, { basicChallenge: basic });
  }
}

export function OPTIONS(): Response {
  return preflight();
}
