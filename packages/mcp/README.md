# @hnet/mcp

The in-cluster MCP endpoint behind `POST /api/mcp` (ADR-087; DESIGN-049 D-02..D-06; PLAN-068 S7): consumer
auth, the seven watch tools, the D-06 logging, and the Voice Budget tests. `apps/web/app/api/mcp/route.ts`
is a thin adapter over `handleMcpRequest`; this package never writes a table itself — reads come from the
`@hnet/watch` queries, writes and Plex calls from the `@hnet/domain` watch flows.

Raw TS, no build step. `@modelcontextprotocol/sdk` is pinned to **1.30.0** (v1: v2 answers older-protocol
clients such as Home Assistant and Codex with SSE even in JSON mode — D-02).

## Request path (`src/http.ts`)

1. Only `POST` (the route exports only `POST`, so Next answers every other method 405).
2. Consumer auth (`src/auth.ts`, D-03): `Authorization: Bearer <token>`, SHA-256 + `timingSafeEqual` against
   every configured consumer's token; none configured ⇒ **503**, missing/wrong ⇒ **401** with
   `WWW-Authenticate: Bearer`. v1 has one consumer, `hop` (`HNET_MCP_HOP_TOKEN`, scopes `watch:read` +
   `watch:write`); another consumer is one more `MCP_CONSUMERS` entry — configuration, not code.
3. The body is read with a **64 KB** cap before the transport (**413** over it) and parsed once.
4. A fresh `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined,
   enableJsonResponse: true })` per request — stateless: no `Mcp-Session-Id`, any replica answers.

## Tools (`src/tools.ts`, `src/answers.ts`, `src/server.ts`)

The seven D-05 tools with exactly the D-05 names, descriptions and parameters; `.strict()` zod inputs at
module scope validate every call. `tools/list` is served from **hand-written JSON Schemas** through the
low-level handler: the SDK-generated list (a `$schema` URL and `execution` on every tool) measured 3,475
bytes, over the 3,072-byte budget; the served list is 2,712 bytes, and a test pins each hand-written schema to
its zod schema. Every answer is `@hnet/watch`-formatted plain text — no `structuredContent`, no
`outputSchema`. Principal = THE `owner` row (none yet ⇒ "Watch history isn't ready yet."). `unfinished` and
`watch_status` revalidate the titles they report live (D-11: a 300 ms-per-read Plex bundle, 400 ms overall);
marks use an ≈ 800 ms-per-attempt bundle (D-14's 3 s).

## Logging and errors (`src/log.ts`, D-06)

`[mcp] tool_called {"tool","consumer","ms","ok","chars"}` per call (+ `"code"` on failure), `[mcp] slow_call`
with the slowest phase (resolve / revalidate / plex_write) over 2 s, `[mcp] revalidate_timeout`. Arguments
and results are never logged. A thrown failure becomes `isError` with "Watch history hit an error. Try again
in a minute." — never the raw message.

## Tests

`pnpm --filter @hnet/mcp test` — `tools.test.ts` (the contract, schema parity, auth, scopes; no database) and
`mcp.e2e.test.ts` (the SDK `Client` + `StreamableHTTPClientTransport` over a node:http adapter, embedded
Postgres 16 seeded through the domain writers, a recording fake Plex — never a real server): stateless
initialize, every tool, the Voice Budget, ambiguous titles writing nothing, mark → recommend/unfinished →
undo, 401/503/405/413, strict inputs, log hygiene.
