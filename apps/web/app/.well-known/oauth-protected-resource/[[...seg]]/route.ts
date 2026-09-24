// ADR-091 / DESIGN-050 D-02 — RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource`
// and `/.well-known/oauth-protected-resource/mcp` (the path clients derive from the resource). Public, cached an
// hour, CORS `*`. Any other suffix is 404: the paths are fixed forever (ADR-091 C-12), no aliases.
import { protectedResourceMetadata } from '@hnet/oauth';
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
  return json(protectedResourceMetadata(), { cache: 'public, max-age=3600' });
}

export function OPTIONS(): Response {
  return preflight();
}
