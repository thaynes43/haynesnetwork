# @hnet/oauth

The **pure** half of the in-app OAuth 2.1 authorization server behind the public MCP connectors (ADR-091,
DESIGN-050 D-01; PLAN-069). Ported from cigar-journal `packages/oauth`. Raw TS, no build step.

`@hnet/oauth` **decides**; the `@hnet/domain` oauth single-writers (`packages/domain/src/oauth/*`) **write**.
At runtime this package imports zod and `node:crypto` only — `@hnet/db` for row types (`import type`), never a
database, drizzle, `@hnet/domain`, Better Auth or the MCP SDK (`__tests__/import-guard.test.ts`).

| Module | What |
|---|---|
| `config.ts` | TTLs (access 1 h, refresh 60 d, consent 10 min, code 60 s), the three scopes, the D-14 scope copy (the `watch:write` line differs for the server owner), the D-04 / D-10 input bounds, the issuer and resource from `BETTER_AUTH_URL` (never the request) |
| `crypto.ts` | 32-byte base64url tokens, 32-hex client ids, SHA-256 at rest, PKCE S256, constant-time `safeEqual` (both sides digested first) |
| `metadata.ts` | RFC 8414 and RFC 9728 documents (D-02) |
| `validate.ts` | DCR body, redirect URIs and the loopback rule (RFC 8252 §7.3: port ignored, path/query/fragment enforced), authorization parameters (`state` required, default scopes, `resource` binding), token / revoke bodies, client credentials (Basic or body), the bearer header |
| `decide.ts` | what to insert, issue, rotate, revoke, refuse or prune: registration, client auth, consent view and scope lines, approval / denial redirects, code exchange, token pairs, refresh rotation and reuse, revocation, the `/mcp` bearer, the once-a-minute stamp, the pruner's cutoffs |
| `logger.ts` | `[auth] <event> {json}` lines (D-06) with 6-character hash fingerprints — never a token, code, secret or verifier |

The closed vocabularies mirror `@hnet/db` `enums.ts` (the schema CHECKs); `__tests__/parity.test.ts` fails on drift.

`pnpm --filter @hnet/oauth test` — unit tests only (no database): metadata, DCR caps, loopback matching, PKCE and
the constant-time compare, every decision, request parsing, log hygiene, parity, the import guard and the
Dockerfile deps-stage wiring. The writers are proven against embedded Postgres in
`packages/domain/__tests__/oauth-writers.test.ts`.
