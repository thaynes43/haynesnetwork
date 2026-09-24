// ADR-091 / DESIGN-050 D-02 — RFC 8414 authorization-server metadata at `/.well-known/oauth-authorization-server`
// and `/.well-known/oauth-authorization-server/mcp`. Public, cached an hour, CORS `*`; every endpoint derives from
// the issuer (BETTER_AUTH_URL). Any other suffix is 404 — clients cache this document, so the paths never move.
import { authorizationServerMetadata } from '@hnet/oauth';
import { json, preflight } from '@/lib/oauth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ seg?: string[] }> },
): Promise<Response> {
  const { seg } = await ctx.params;
  if (seg && !(seg.length === 1 && seg[0] === 'mcp'))
    return new Response('Not found', { status: 404 });
  return json(authorizationServerMetadata(), { cache: 'public, max-age=3600' });
}

export function OPTIONS(): Response {
  return preflight();
}
