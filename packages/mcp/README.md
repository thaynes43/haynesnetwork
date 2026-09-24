# @hnet/mcp

The MCP endpoint behind the in-cluster `POST /api/mcp` (ADR-087; DESIGN-049 D-02..D-06; PLAN-068 S7) and the
public `POST /mcp` (ADR-091; DESIGN-050 D-07; PLAN-069 S4): consumer auth, the seven watch tools, the D-06
logging, and the Voice Budget tests. `apps/web/app/api/mcp/route.ts` and `apps/web/app/mcp/route.ts` are thin
adapters over `handleMcpRequest` (the public one passes `authenticateOAuth`); this package never writes a table
itself — reads come from the `@hnet/watch` queries and the `@hnet/domain` bearer lookup, writes and Plex calls
from the `@hnet/domain` watch flows and `touchLastUsed`.

Raw TS, no build step. `@modelcontextprotocol/sdk` is pinned to **1.30.0** (v1: v2 answers older-protocol
clients such as Home Assistant and Codex with SSE even in JSON mode — D-02).

## Request path (`src/http.ts`)

1. Only `POST` (the route exports only `POST`, so Next answers every other method 405).
2. Consumer auth — one of two sources (option `authenticate`), everything after it shared (ADR-091 C-09):
   - **the hop** (`src/auth.ts`, D-03, the default — `/api/mcp`): `Authorization: Bearer <token>`, SHA-256 +
     `timingSafeEqual` against every configured consumer's token; none configured ⇒ **503**, missing/wrong ⇒
     **401** with `WWW-Authenticate: Bearer`. v1 has one consumer, `hop` (`HNET_MCP_HOP_TOKEN`, scopes
     `watch:read` + `watch:write`), acting as the Server Owner; another is one more `MCP_CONSUMERS` entry.
   - **a delegated OAuth token** (`src/oauth.ts`, DESIGN-050 D-07 — `/mcp`): `authenticateOAuth` looks the
     bearer up by hash (`@hnet/domain` `selectBearerToken`) and `@hnet/oauth` `decideBearer` refuses it when
     unknown, revoked, expired or bound to another resource ⇒ **401** with
     `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"`. The consumer is
     `{ name: 'oauth:<client_id>', scopes: <token scopes ∩ watch scopes>, userId }`; a `tools/call` of a known
     tool outside those scopes answers **403** `insufficient_scope`. `last_used_at` is stamped (token and client)
     at most once a minute. No owner check: the principal is the token's user (below).
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
`outputSchema`. Principal (`resolvePrincipal`): the hop acts as THE `owner` row (none yet ⇒ "Watch history isn't
ready yet."); an OAuth consumer acts as its user's own tracked account — `users.id` → the ADR-053 Plex Account
Map → `watch_accounts` with `tracked = true` (none ⇒ "Watch history isn't set up for your account yet.", an
ordinary answer). Only the owner's account is revalidated live and written to Plex (both use the owner's server
tokens): a household account's `mark_watched` is recorded in its history only (ADR-091 C-04). `unfinished` and
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
`oauth.e2e.test.ts` (the public path: `authenticateOAuth` against real tokens issued through the domain writers,
the 401 / 403 challenges, the stamp, the user-aware principal incl. a household account that never touches Plex,
the unchanged Voice Budget and D-06 lines, and the two paths kept apart) and `import-guard.test.ts` (D-01: `@hnet/watch` imports `@hnet/db`, drizzle-orm and zod only; the MCP SDK only
here).
