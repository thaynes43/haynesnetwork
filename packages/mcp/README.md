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
3. The body is read with a **64 KB** cap before the transport (**413** over it) and parsed once. A JSON-RPC
   batch (an array) is refused with **400** — MCP 2025-06-18 dropped batching, and a call batched with its own
   `notifications/cancelled` would never answer.
4. A fresh `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined,
   enableJsonResponse: true })` per request — stateless: no `Mcp-Session-Id`, any replica answers.
5. An overall **9 s deadline** (`MCP_DEADLINE_MS`, option `deadlineMs`) under Home Assistant's 10 s per tool
   call: past it the per-request server is closed and a `tools/call` answers the D-06 error text as an
   `isError` result (anything else a 504 JSON-RPC error). The call is logged once, `"code":"deadline"`; the
   abandoned work may still finish (a mark is then recorded) but never logs or answers.

## Tools (`src/tools.ts`, `src/answers.ts`, `src/server.ts`)

The seven D-05 tools with exactly the D-05 names, descriptions and parameters; `.strict()` zod inputs at
module scope validate every call (a call without `arguments` counts as `{}`). A consumer's connection
registers only the tools its scopes allow, so `tools/list` omits the others and a call to one answers "not
found". `tools/list` is served from **hand-written JSON Schemas** through the
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

`pnpm --filter @hnet/mcp test` — `tools.test.ts` (the contract, schema parity, auth, scopes, the deadline's
runner and answer shape; no database), `mcp.e2e.test.ts` (the SDK `Client` + `StreamableHTTPClientTransport`
over a node:http adapter, embedded Postgres 16 seeded through the domain writers, a recording fake Plex —
never a real server — covering stateless initialize, every tool, the Voice Budget, ambiguous titles writing
nothing, mark → recommend/unfinished → undo, 401/503/405/413, strict inputs, no `arguments`, batches, the
deadline, the revalidation timeout, "not ready" and log hygiene), `recommend-query.test.ts` (the D-17 library query pinned
to its first, OR-ed form on a ledger / history / marks fixture — `recommend-fixture.ts`) and
`import-guard.test.ts` (D-01: `@hnet/watch` imports `@hnet/db`, drizzle-orm and zod only; the MCP SDK only
here).
