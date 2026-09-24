// ADR-091 / DESIGN-050 D-06 — `POST /oauth/revoke`, RFC 7009: a refresh token or a family access token revokes the
// family, a standalone access token only itself; unknown tokens and other clients' tokens are ignored silently —
// the answer is 200 with an empty body whatever the token was (ChatGPT calls this on every reconnect). Only a
// request that fails client authentication or is malformed gets the RFC 7009 §2.2.1 error body.
import { authenticateOAuthClient, revokeToken } from '@hnet/domain';
import { parseClientCredentials, parseRevokeRequest } from '@hnet/oauth';
import { CORS_HEADERS, oauthErrorResponse, preflight, readFormBody } from '@/lib/oauth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
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
