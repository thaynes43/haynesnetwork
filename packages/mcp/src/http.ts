// ADR-087 / DESIGN-049 D-02 / D-03 — `POST /api/mcp`: MCP Streamable HTTP, STATELESS, JSON responses. A fresh
// McpServer + WebStandardStreamableHTTPServerTransport per request (`sessionIdGenerator: undefined`, so no
// `Mcp-Session-Id` is ever issued and clients never open the GET stream or send DELETE), after consumer auth
// and a 64 KB body cap enforced BEFORE the transport (SDK v1 has none; the parsed body is passed through).
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpDeps } from './answers';
import { authenticate, jsonRpcError, type McpConsumer } from './auth';
import { defaultDeps } from './deps';
import { buildServer } from './server';

/** D-02: requests over this are refused before any parsing. */
export const MAX_MCP_BODY_BYTES = 64 * 1024;

/** Read the body with a hard byte cap (a declared oversize length is refused up front). Null = too large. */
export async function readBodyCapped(req: Request, cap: number = MAX_MCP_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export interface McpRequestOptions {
  deps?: McpDeps;
  env?: Record<string, string | undefined>;
}

/**
 * Handle one MCP request. Only POST reaches the transport (the Next route exports only POST, so Next
 * answers every other method 405; this guard keeps the handler safe on its own).
 */
export async function handleMcpRequest(req: Request, opts: McpRequestOptions = {}): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  const auth = authenticate(req, opts.env ?? process.env);
  if (!auth.ok) return auth.response;

  const raw = await readBodyCapped(req);
  if (raw === null) return jsonRpcError(413, -32600, 'Request too large');
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return jsonRpcError(400, -32700, 'Parse error');
  }

  const deps = opts.deps ?? defaultDeps();
  const server = buildServer(deps, auth.consumer);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, { parsedBody, authInfo: authInfo(auth.consumer) });
  } finally {
    await server.close().catch(() => {});
  }
}

function authInfo(consumer: McpConsumer) {
  return { token: '', clientId: consumer.name, scopes: [...consumer.scopes] };
}
