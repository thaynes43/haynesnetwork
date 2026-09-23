// ADR-087 / DESIGN-049 D-02 — `POST /api/mcp`, the in-cluster MCP endpoint (a thin adapter over @hnet/mcp).
// ONLY POST is exported, so Next answers every other method 405: a GET or DELETE must never reach the
// stateless transport (a GET would open an SSE stream that never ends). The path is excluded from both
// IngressRoutes (D-04) — the in-cluster hop injects the consumer bearer; nothing here is public.
import { handleMcpRequest } from '@hnet/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}
