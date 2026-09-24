// ADR-091 / DESIGN-050 D-02 / D-07 — `POST /mcp`, the PUBLIC MCP endpoint (ChatGPT, claude.ai, Claude Code,
// Codex). It accepts ONLY delegated OAuth access tokens (`authenticateOAuth`: 401 with the RFC 9728
// `resource_metadata` challenge otherwise, 403 `insufficient_scope` for a tool outside the token's scopes), then
// runs the very same handler as the in-cluster `/api/mcp` (64 KB cap, batch refusal, the 9 s deadline, the D-06
// log). ONLY POST is exported, so Next answers GET, DELETE and every other method 405 — a GET must never open a
// stream on the stateless transport. No CORS here (D-02). `/api/mcp` and its hop bearer are untouched and stay
// excluded from every IngressRoute; this route never accepts the hop token.
import { authenticateOAuth, handleMcpRequest } from '@hnet/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req, { authenticate: (r) => authenticateOAuth(r) });
}
