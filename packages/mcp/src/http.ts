// ADR-087 / DESIGN-049 D-02 / D-03 — `POST /api/mcp`: MCP Streamable HTTP, STATELESS, JSON responses. A fresh
// McpServer + WebStandardStreamableHTTPServerTransport per request (`sessionIdGenerator: undefined`, so no
// `Mcp-Session-Id` is ever issued and clients never open the GET stream or send DELETE), after consumer auth
// and a 64 KB body cap enforced BEFORE the transport (SDK v1 has none; the parsed body is passed through).
// JSON-RPC batches are refused (MCP 2025-06-18 dropped batching), and every request answers within an overall
// deadline, under Home Assistant's 10 s per tool call.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { formatWatchError } from '@hnet/watch';
import type { McpDeps } from './answers';
import { authenticate, jsonRpcError, type McpConsumer } from './auth';
import { defaultDeps } from './deps';
import { buildServer } from './server';

/** D-02: requests over this are refused before any parsing. */
export const MAX_MCP_BODY_BYTES = 64 * 1024;

/**
 * The overall deadline of one request: Home Assistant abandons a tool call after 10 s, so the answer must be
 * on the wire before that even when Plex hangs through `mark_watched`'s sequential phases.
 */
export const MCP_DEADLINE_MS = 9_000;

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
  /** The overall deadline of the transport's handling (default {@link MCP_DEADLINE_MS}). */
  deadlineMs?: number;
}

/**
 * The answer when the deadline passes first. A `tools/call` gets an ordinary JSON-RPC result carrying the
 * D-06 error text with `isError: true` — the SDK client returns it like any tool error and Home Assistant
 * hands the text to the model, where an HTTP error status would surface as an exception in both. Anything
 * else (never slow in practice) gets a 504 JSON-RPC error.
 */
export function deadlineResponse(body: unknown): Response {
  const msg = (body ?? {}) as { id?: unknown; method?: unknown };
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  if (id !== null && msg.method === 'tools/call') {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: formatWatchError() }], isError: true },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return jsonRpcError(504, -32001, 'Request timed out');
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
  // MCP 2025-06-18 dropped JSON-RPC batching and none of our clients batch. The SDK still accepts arrays,
  // and a batch of a call plus its own `notifications/cancelled` never answers: the cancelled response is
  // dropped, so the JSON response waits forever for it.
  if (Array.isArray(parsedBody)) return jsonRpcError(400, -32600, 'Batch requests are not supported');

  const deps = opts.deps ?? defaultDeps();
  const server = buildServer(deps, auth.consumer);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), opts.deadlineMs ?? MCP_DEADLINE_MS);
  });
  try {
    const handled = transport.handleRequest(req, { parsedBody, authInfo: authInfo(auth.consumer) });
    const outcome = await Promise.race([handled, deadline]);
    if (outcome !== 'deadline') return outcome;
    // The transport's promise never settles once the server closes (below); nothing may surface from it.
    handled.catch(() => {});
    return deadlineResponse(parsedBody);
  } finally {
    clearTimeout(timer);
    // Closing aborts a call still running (its SDK signal): `runTool` logs it once as `deadline`, and the
    // SDK drops whatever the abandoned work returns later.
    await server.close().catch(() => {});
  }
}

function authInfo(consumer: McpConsumer) {
  return { token: '', clientId: consumer.name, scopes: [...consumer.scopes] };
}
