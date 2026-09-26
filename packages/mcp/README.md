# @hnet/mcp

The MCP endpoint behind the in-cluster `POST /api/mcp` (ADR-087; DESIGN-049 D-02..D-06; PLAN-068 S7) and the
public `POST /mcp` (ADR-091; DESIGN-050 D-07; PLAN-069 S4): consumer auth, the nine watch tools (ADR-092 /
DESIGN-051 added `watchlist` and `set_watchlist`, PLAN-071), the D-06
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

The nine tools of DESIGN-049 D-05 + DESIGN-051 D-01 with exactly their names, descriptions and parameters (reads
first, then writes, `undo_last_change` last); `.strict()` zod inputs at
module scope validate every call (a call without `arguments` counts as `{}`). A consumer's connection
registers only the tools its scopes allow, so `tools/list` omits the others and a call to one answers "not
found". `tools/list` is served from **hand-written JSON Schemas** through the
low-level handler: the SDK-generated list (a `$schema` URL and `execution` on every tool) measured 3,475
bytes, over the 3,072-byte budget; the served list was 2,712 bytes with seven tools and is **3,633 bytes** with
nine (the cap is 4,096 since ADR-092 C-09; `oauth.e2e.test.ts` pins the exact size), and a test pins each
hand-written schema to its zod schema. Every answer is `@hnet/watch`-formatted plain text — no `structuredContent`, no
`outputSchema`. Principal (`resolvePrincipal`): the hop acts as THE `owner` row (none yet ⇒ "Watch history isn't
ready yet."); an OAuth consumer acts as its user's own tracked account — `users.id` → the ADR-053 Plex Account
Map → `watch_accounts` with `tracked = true` (none ⇒ "Watch history isn't set up for your account yet.", an
ordinary answer). Only the owner's account is revalidated live and written to Plex (both use the owner's server
tokens): a household account's `mark_watched` is recorded in its history only (ADR-091 C-04). `unfinished` and
`watch_status` revalidate the titles they report live (D-11: a 300 ms-per-read Plex bundle, 400 ms overall);
marks use an ≈ 800 ms-per-attempt bundle (D-14's 3 s).

**The watchlist (ADR-092 / DESIGN-051).** `watchlist` (read) lists the owner's plex.tv watchlist through
`@hnet/watch`'s `selectWatchlist` — the 15-minute cache with the Watchlist Changes since that sync overlaid at
read time (D-05) — with the D-02 "on Plex" rule and started / watched per title; `watch_status` ends with the
four-way availability sentence (on the watchlist ⇔ the resolver's matched entries include an overlaid watchlist
entry). `set_watchlist` (write) runs `@hnet/domain` `changeWatchlist`: its live userState read before the write goes out
on the short 300 ms bundle (`revalidatePlex`), its catalog lookup (the external-id match) and the userState re-read
after a failed PUT on the discover bundle (`discoverPlex`: one 1.5 s attempt, since plex.tv takes up to 1.3 s to
match a long-running show, DESIGN-051 D-15ab), its two PUTs on the mark bundle (`markPlex`), and its TMDB fallback
makes a single attempt (`tmdbOnce`, DESIGN-051 D-15g). Every tool's TMDB check made while the pool already has an
answer (a named year the pool's title does not have) goes through `tmdbOnce` too, since `mark_watched`'s Plex work
follows it; "not found" keeps the retrying `tmdb` (D-15aa). Both answer a principal that is not the Server Owner with "Your Plex watchlist isn't set up
for your account yet." (ADR-092 C-04); `watch_status` keeps DESIGN-049's sentence for them.

## Logging and errors (`src/log.ts`, D-06)

`[mcp] tool_called {"tool","consumer","ms","ok","chars"}` per call (+ `"code"` on failure), `[mcp] slow_call`
with the slowest phase (resolve / revalidate / plex_write) over 2 s, `[mcp] revalidate_timeout`, and (DESIGN-051
D-10) `[mcp] watchlist_changed {"consumer","action","kind","result","onPlex"}` per `set_watchlist` call — result
`written` · `failed` · `unchanged` · `not_found` · `ambiguous` · `not_in_catalog` · `unconfirmed` · `unknown` ·
`not_owner`.
Both extra lines are logged by the runner's `finish`, with the call's one `tool_called` line, so abandoned work
past the deadline never logs. Arguments and results (titles, queries) are never logged. A thrown failure becomes `isError` with "Watch history hit an error. Try again
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
the Voice Budget and D-06 lines, the watchlist tools' non-owner answers, and the two paths kept apart),
`watchlist.e2e.test.ts` (DESIGN-051: `watchlist` newest first / kind / offset / past the end / started and watched /
the cap and paging past it, `set_watchlist` add on Plex, add not on Plex with the Seerr line, remove, already on,
not found on the watchlist, ambiguous, a year in parentheses settling an add's TMDB ambiguity and TMDB titles
that read the same answered without a question (D-15v, D-15w), an add reaching TMDB past a near title and a
recommendation of another year (D-15x, D-15y), a Plex failure and its undo, the very next answers
reflecting a change the cache predates, undo, a watchlist change leaving Unfinished / recent history / progress
untouched, the exact `watchlist_changed` lines, and the bundle each watchlist call used: `revalidatePlex`,
`markPlex` and `discoverPlex` are different fakes, so a budget swap fails; and from the seventh review pass an add
whose catalog lookup takes a second through real clients on the discover bundle's production tuning, each tool's
TMDB check with the pool's answer through `tmdbOnce`, and a `mark_watched` of a named year answering inside a
scaled deadline while TMDB stalls, D-15aa, D-15ab; and from the eighth an undo after a new change inside the replay
window, the cleared undo of a refused add not on Plex with its Seerr sentence, D-04, and an add of a year no TMDB
match has asked about, D-15ac), `deps.test.ts` (the production wiring: `tmdbSearchFromEnv`
and `defaultDeps` build `tmdb` with the client's GET retries and `tmdbOnce` with one attempt, and each attempt's
timer covers a body that stalls after its headers; `discoverPlex` makes one 1.5 s attempt, so a one-second
`matches` answer arrives where the 300 ms bundle times out; DESIGN-051 D-15g, D-15p, D-15ab) and `import-guard.test.ts` (D-01:
`@hnet/watch` imports `@hnet/db`, drizzle-orm and zod only; the MCP SDK only here).
