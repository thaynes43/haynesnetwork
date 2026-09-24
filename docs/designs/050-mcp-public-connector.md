# DESIGN-050: Public connectors for the MCP surface — the in-app OAuth 2.1 authorization server, the public `/mcp`, and the Connected apps page

- **Status:** Draft
- **Last updated:** 2026-09-23 (owner ruling: user-aware principal, no owner gate; D-05, D-07, D-14, Q-02)
- **Satisfies:** PRD-001 R-247..R-251, US-14, AC-25..AC-28; governed by ADR-091 (this surface),
  ADR-087 (the in-cluster surface it sits beside), ADR-088 (the owner-only principal), ADR-014
  (inline two-step confirm), ADR-015 (no re-orientation on interaction).
- **Context:** DDD-002 BC-06 Watch Companion; glossary DDD-001 T-254..T-259 (Connector, OAuth client,
  Authorization transaction, Refresh family, Connected app, Delegated token).

## Overview

```
ChatGPT / claude.ai / Claude Code / Codex ──▶ https://haynesnetwork.com/.well-known/oauth-protected-resource
        │                                      https://haynesnetwork.com/.well-known/oauth-authorization-server
        │  DCR ──▶ POST /oauth/register
        │  browser ──▶ GET /oauth/authorize ──▶ (no session) /login?next=… ──▶ Authentik ──▶ back
        │                                   ──▶ /oauth/consent?txn=… (any signed-in user) ──▶ code ──▶ client
        │  POST /oauth/token (code + PKCE verifier | refresh rotation) ──▶ opaque access + refresh tokens
        └─ POST /mcp  Authorization: Bearer <access token> ──▶ @hnet/mcp (OAuth consumer) ──▶ the seven tools
Home Assistant / dev-env ──▶ hop ──▶ POST /api/mcp  (unchanged, ADR-087; never routed publicly)
```

One origin, `https://haynesnetwork.com`, is both the authorization server (issuer) and the
protected resource (`https://haynesnetwork.com/mcp`). Everything is stateless per request; the five
OAuth tables in Postgres hold the shared state, so all three replicas serve every step.

## Detailed design

### D-01 — Packages and ownership

| Package | Adds | Rule |
|---|---|---|
| `@hnet/oauth` (**new**) | a port of cigar-journal `packages/oauth/src/{config,crypto,errors,metadata,provider,validate,logger}.ts`: metadata documents, DCR, the authorize/consent/code/token/refresh/revoke state machine, token hashing and validation | depends on `@hnet/db` and zod only; never imports Better Auth, `@hnet/domain` or the MCP SDK; a `COPY packages/oauth/package.json` line in the Dockerfile deps stage. `service-tokens.ts` and the CLI are **not** ported (ADR-091 option 5) |
| `@hnet/db` | migration `0078_oauth_connectors.sql` + `_journal.json` entry; schema files for the five tables (D-03); `rate_limit` reuse | CHECK constraints from `enums.ts` const arrays, as 0077 did |
| `@hnet/domain` | `oauth/*` single-writers: `grantConsent`, `denyConsent`, `disconnectClient`, `revokeFamilyOnReuse` — each one transaction with its audit row (hard rule 6) | the only writers of the OAuth tables; they join `no-direct-state-writes.test.ts` (and `oauth_access_tokens` / `oauth_refresh_tokens` join DELETE for the pruner only) |
| `@hnet/mcp` | a second consumer source: `authenticateOAuth(req)` → `McpConsumer { name: 'oauth:<client_id>', scopes }`; the 401 challenge with `resource_metadata`; the 403 `insufficient_scope` | the hop consumer is untouched; everything after authentication is shared |
| `apps/web` | routes outside the `(app)` gate: `.well-known/*`, `/oauth/*`, `/mcp`; the consent page; `/login?next=`; `(app)/settings/connections` | every redirect is built from `BETTER_AUTH_URL` (behind the tunnel `req.url` is `0.0.0.0:3000`), never from the request |

### D-02 — Endpoints (fixed forever, ADR-091 C-12)

| URL | Method | Purpose |
|---|---|---|
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | GET | RFC 9728: `resource: "https://haynesnetwork.com/mcp"`, `authorization_servers: ["https://haynesnetwork.com"]`, `scopes_supported: ["watch:read","watch:write","offline_access"]`, `bearer_methods_supported: ["header"]`, `resource_name: "haynesnetwork Watch history"`. Public, `Cache-Control: public, max-age=3600`, CORS `*` |
| `/.well-known/oauth-authorization-server` and `…/mcp` | GET | RFC 8414: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, the three scopes, `response_types_supported: ["code"]`, `response_modes_supported: ["query"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `token_endpoint_auth_methods_supported: ["client_secret_post","client_secret_basic","none"]` (the same list for revocation), `code_challenge_methods_supported: ["S256"]`. Same caching and CORS |
| `/oauth/register` | POST JSON | RFC 7591 DCR (D-04) |
| `/oauth/authorize` | GET | the authorization request (D-05) |
| `/oauth/consent` | page + server action | Approve / Deny (D-05) |
| `/oauth/token` | POST form | `authorization_code` and `refresh_token` grants (D-06); JSON bodies get 400 `invalid_request` |
| `/oauth/revoke` | POST form | RFC 7009; always 200 with an empty body |
| `/mcp` | POST | the public MCP endpoint (D-07); GET, DELETE and every other method 405 |

`/.well-known/openid-configuration` is not served. No root-path aliases: the paths are chosen once.
CORS (`*`; `GET, POST, OPTIONS`; `Content-Type, Authorization, mcp-protocol-version`) is on the
metadata, register, token and revoke routes only, never on `/mcp`.

### D-03 — Storage (migration 0078)

Five tables, all `ON DELETE CASCADE` from `users.id` and from `oauth_clients.id`; every `expires_at`
NOT NULL (no never-expiring tokens: ADR-091 option 5).

| Table | Columns (beyond `id`, `created_at`) |
|---|---|
| `oauth_clients` | `client_id` text unique (32 hex), `client_secret_hash` text null, `client_name` text (≤ 80), `redirect_uris` jsonb (≤ 5, https or loopback), `grant_types` jsonb, `response_types` jsonb, `scope` text null, `token_endpoint_auth_method` text CHECK `none`\|`client_secret_post`\|`client_secret_basic`, `registered_ip` text null, `last_used_at` timestamptz null |
| `oauth_authorizations` | the pending consent transaction: `client_id` FK, `user_id` FK, `redirect_uri`, `scopes` jsonb, `resource`, `state`, `code_challenge`, `code_challenge_method` (`S256`), `expires_at` (10 min) |
| `oauth_authorization_codes` | `code_hash` unique, the same binding columns, `expires_at` (60 s), `consumed_at` null |
| `oauth_refresh_tokens` | `token_hash` unique, `family_id` uuid, `parent_id` self-FK null, `client_id`, `user_id`, `scopes`, `resource`, `expires_at` (60 days, re-issued on rotation), `rotated_at` null, `revoked_at` null |
| `oauth_access_tokens` | `token_hash` unique, `family_id` uuid null, `client_id`, `user_id`, `scopes`, `resource`, `expires_at` (1 h), `revoked_at` null, `last_used_at` null |

Tokens, codes and client secrets are 32 random bytes in base64url, opaque, hashed with SHA-256 before
they touch the database; validation is a hash lookup joined to `users`. A refresh token presented
after rotation or revocation revokes its whole family (refresh and access rows) and writes an audit
row. Old access tokens are not revoked on rotation; they expire.

**Pruning is inline** (no CronJob): each `/oauth/token` call deletes, bounded to 200 rows per table,
expired transactions and codes, tokens expired or revoked more than 30 days ago, and DCR clients
older than 30 days that own no token and no transaction.

### D-04 — Registration

Open and unauthenticated (ChatGPT registers one client per connector), rate-limited to **10 per hour
per client IP** (`CF-Connecting-IP` first, then the socket address) through the `rate_limit` table.
Validation: `client_name` 1–80 characters; 1–5 `redirect_uris`, each `https://` or a loopback
`http://` (`127.0.0.1`, `[::1]`, `localhost`); `token_endpoint_auth_method` in D-02's list (default
`none`); `grant_types` ⊆ {`authorization_code`, `refresh_token`}; `response_types` = [`code`];
`scope`, if given, ⊆ the three. Returns 201 with `client_id` (and `client_secret` only for a
confidential method), the echoed metadata, `client_id_issued_at`. Errors are RFC 7591 bodies.

### D-05 — Authorize and consent (FLOW-001)

1. **Client and redirect.** The `client_id` must exist and `redirect_uri` must match a registered one
   exactly, except that loopback redirects compare with the port ignored (RFC 8252 §7.3; path, query
   and fragment must still match). A failure here renders the error page (D-14) and never redirects.
2. **Parameters.** `response_type=code`; `code_challenge` required with `code_challenge_method=S256`
   (`plain` refused); **`state` required** (stricter than cigar-journal); every scope must be one of
   the three, and a missing `scope` means all three; `resource`, if sent, must equal the canonical
   resource (`invalid_target` otherwise). Parameter errors redirect back with `error`,
   `error_description` and `state`.
3. **Session gate.** No app session ⇒ redirect to `${issuer}/login?next=<the authorize path and query>`.
   `next` is accepted only as a relative path that starts with `/` and not `//` (D-09).
4. **No owner gate.** Any signed-in user may continue (ADR-091 C-04, owner ruling 2026-09-23). Whether
   the user's account has watch history is decided at tool time (D-07), never at consent.
5. **Transaction.** Insert an `oauth_authorizations` row; redirect to `/oauth/consent?txn=<uuid>`.
6. **Consent page** (copy in D-14): re-derives the user; the transaction must be a well-formed UUID,
   unexpired and the user's own, else the expired state. Shows the client name **and the redirect
   host** (anyone can register a client named "ChatGPT"), one line per requested scope, Approve and
   Deny with the decision bound into the server action (cigar-journal #29: a submit button's value is
   dropped by `formAction`, so both buttons read as Deny). Consent is never remembered.
7. **Approve:** one transaction — delete the transaction row (re-checking expiry), insert the code,
   write the `oauth_consent_granted` audit row — then redirect to `redirect_uri?code=&state=`.
   **Deny:** the `oauth_consent_denied` audit row and `?error=access_denied&state=`.

### D-06 — Token, refresh and revoke

- `authorization_code`: the client must have registered the grant; the code is looked up by hash
  (a replay logs `code_replayed` and answers `invalid_grant`); client, expiry, `redirect_uri` (if
  sent, loopback-tolerant), the S256 verifier (constant-time) and `resource` (if sent) are checked;
  the code is consumed atomically; a refresh token is issued only when `offline_access` was granted.
  Response `{access_token, token_type: "Bearer", expires_in: 3600, scope, refresh_token?}` with
  `Cache-Control: no-store`.
- `refresh_token`: rotation with a conditional UPDATE (race-safe across replicas); the new pair joins
  the family; a refresh may narrow scopes; a spent or revoked token revokes the family.
- Client authentication: `client_id` in the body or HTTP Basic; a confidential client's secret is
  compared as digests. A refresh token presented by another client ⇒ `invalid_grant`.
- Rate limit on `/oauth/token`: **60 per minute per client IP**.
- `/oauth/revoke`: a refresh token or a family access token revokes the family; a standalone access
  token is revoked alone; unknown tokens and other clients' tokens are ignored silently; always 200.
- Every step logs one `[auth] <event> {…}` line with masked token fingerprints (first 6 characters
  of the hash) and never a token, code, secret or verifier. Events: `client_registered`,
  `authorize_started`, `authorize_rejected`, `consent_shown`, `consent_granted`, `consent_denied`,
  `owner_gate_refused`, `token_issued`, `token_refreshed`, `refresh_reuse_detected`, `token_revoked`,
  `code_replayed`, `audience_mismatch`, `rate_limited`.

### D-07 — The public `/mcp`

`apps/web/app/mcp/route.ts` exports only `POST`. Order: `authenticateOAuth` (D-03 lookup by hash
joined to `users`; refused when revoked, expired or `resource` ≠ canonical), then the same
`handleMcpRequest` as `/api/mcp` (64 KB cap, batch refusal,
the 9 s deadline, D-06 logging of DESIGN-049). The consumer is
`{ name: 'oauth:<client_id>', scopes: <the token's scopes ∩ watch scopes>, userId }`; `tools/list` is
filtered by scope as today.

**Principal (user-aware).** The hop consumer keeps acting as the Server Owner (ADR-087). An OAuth
consumer's principal is the token user's Plex account: `users.id` → the ADR-053 Plex Account Map →
`watch_accounts` row with `tracked = true`. No mapped or tracked account ⇒ every tool answers
"Watch history isn't set up for your account yet." as an ordinary result. The tool runner passes that
account where it passes the owner today (the `AnswerContext.owner` field becomes `account`), and the
domain flows accept any tracked account (their owner assertion becomes a tracked-account assertion).
**Plex write-back stays owner-only:** `mark_watched` for a non-owner account records the mark with
`plex_result = 'none'` and answers "Noted <title> as watched in your history. Only the server owner's
marks change Plex."; `dismiss` and `undo` behave as today (never Plex for a dismiss; an undo of a
history-only mark makes no Plex call). Until PLAN-070 tracks household accounts, only the owner's
account is tracked, so this path answers "isn't set up" for everyone else. Failures: no or bad bearer ⇒ **401** with
`WWW-Authenticate: Bearer resource_metadata="https://haynesnetwork.com/.well-known/oauth-protected-resource"`;
a tool outside the token's scopes ⇒ **403** with `WWW-Authenticate: Bearer error="insufficient_scope", resource_metadata="…"`.
`last_used_at` is stamped on the token and the client at most once a minute. `/api/mcp` is
unchanged and stays excluded from every IngressRoute.

### D-08 — Connected apps page

`(app)/settings/connections` — the owner's self-service view (an admin sees the same list, which is
the owner's anyway). One row per client with a live refresh family or an unexpired access token:
client name, redirect host, "Connected <date>", "Last used <date or never>", scope chips, and a
**Disconnect** `ConfirmButton` (armed label "Confirm disconnect"; the row reserves the width of the
armed label, ADR-015). Disconnect = `disconnectClient`: revoke every family and token of that client
for this user in one transaction with the `oauth_client_disconnected` audit row; the row stays in
place with a "Disconnected" state until the page is next loaded (no reflow). A link to this page
sits in the settings navigation next to the existing entries.

### D-09 — `/login?next=`

The login button passes a safe `next` as Better Auth's `callbackURL` (today it hard-codes `/`), and
the route's already-signed-in redirect honours it. Accepted values: a relative path starting with `/`
and not `//`, at most 2,048 characters; anything else falls back to `/`.

### D-10 — Rate limits and abuse controls

| Where | Limit | Key |
|---|---|---|
| `/oauth/register` | 10 / hour | client IP |
| `/oauth/token` | 60 / minute | client IP |
| `/oauth/authorize` | 30 / minute | client IP |
| `/mcp` | none beyond the existing 64 KB cap and 9 s deadline (a valid token is required first) | — |

Bounded inputs (D-04), inline pruning (D-03), the redirect host on the consent page (D-05), owner-only
consent (ADR-091 C-04), no never-expiring tokens.

### D-11 — Observability (haynes-ops, OPS-016)

Gatus: `https://haynesnetwork.com/mcp` (POST, empty body) must answer **401** with the
`resource_metadata` challenge; `https://haynesnetwork.com/.well-known/oauth-protected-resource` must
answer 200 with `resource` equal to the canonical value. A Loki alert on `[auth]` `refresh_reuse_detected`
or more than 20 `authorize_rejected` / `rate_limited` in 10 minutes. No IngressRoute change is needed:
the routes already forward `PathPrefix(/)` and keep `!PathPrefix(/api/mcp)`.

### D-12 — Client notes (from cigar-journal's logs)

- **ChatGPT**: registers once per connector (`client_name "ChatGPT"`, redirect
  `https://chatgpt.com/connector/oauth/<id>`, auth `none`, both grants), reuses that client for every
  re-authorization, requests every advertised scope, refreshes often, calls revoke on reconnect,
  caches the authorization-server metadata, opens a fresh MCP session per call and never sends
  DELETE (stateless is fine), and refreshes tool schemas only after "refresh" in the connector
  settings plus a new chat. About 5–7 s per call on its side.
- **Claude Code**: `"Claude Code (<server>)"`, loopback redirect with an ephemeral port, every scope,
  silent refresh; reconnects on 404. **Codex**: `"Codex"`, `http://127.0.0.1:<port>/callback/<random>`
  (the reason for the port-insensitive loopback rule). **claude.ai / Claude Desktop**: unverified
  (Q-01). **Home Assistant**: stays on the hop.
- In-cluster Node clients need `NODE_OPTIONS=--dns-result-order=ipv4first` for the public name (AAAA
  records, no IPv6 egress) — dev-env uses the hop, so this does not apply to it.

### D-13 — What does not change

The hop, `/api/mcp`, the seven tools and their budgets, the Movie Room agent, dev-env's `mcp.json`
(the hop entry in haynes-ops #3140), ADR-087's IngressRoute exclusions.

### D-14 — User-facing copy (normative; the owner copy rules apply)

**Consent page** — title: `Connect <client name>`. Lead: `<client name> wants to use your watch
history on haynesnetwork. It will act as your account and can only do what you approve below.`
Redirect line: `Sends you back to <redirect host>.` Scope lines: `watch:read` → `See what you have
watched and what is unfinished`; `watch:write` → `Mark titles watched or dismissed, and change them
in Plex`; `offline_access` → `Stay connected without signing in again`. Buttons: `Approve`, `Deny`.

**Expired request** — title: `This request expired`. Body: `Start the connection again from
<client name>.` (or `from your app` when the client is unknown).

**Bad request** (unknown client, bad redirect) — title: `Something is off with this connection
request`. Body: `haynesnetwork did not recognise the app or where it wants to send you back. Start
the connection again from the app.`

**Connected apps** — title: `Connected apps`. Lead: `Apps you have allowed to use your watch history.
Disconnecting stops an app at its next request.` Empty state: `No connected apps yet.` Row: `<client
name>` · `<redirect host>` · `Connected <date>` · `Last used <date>` / `Never used`. Scope chips:
`Read history`, `Mark titles`, `Stays connected`. Button `Disconnect`, armed `Confirm disconnect`,
done state `Disconnected`.

## Alternatives considered

ADR-091 options 2–5. Also considered: a `/mcp` GET that opens an empty SSE stream for clients that
insist on one — kept as the fallback (ADR-091 C-13) if the live gate shows a client stalling on 405.

## Test strategy

- `@hnet/oauth` (unit): metadata documents; DCR validation and caps; loopback matching (port
  ignored, path enforced); PKCE S256 constant-time check; code single use and replay; refresh
  rotation, family revocation on reuse, scope narrowing; revoke semantics; the pruner's bounds; every
  log line free of tokens (a regex over captured logs).
- `@hnet/domain` (embedded Postgres): the four writers, each with its audit row in the same
  transaction; the guard lists.
- `apps/web`: route tests for the metadata, register, token and revoke handlers; the authorize gate
  (no session → `/login?next=`; a session → transaction + consent); the
  consent action with a bound decision; `/login?next=` safety; the `/mcp` route test (mocks
  `@hnet/mcp`) for 401/403 headers and 405s.
- `@hnet/mcp`: `authenticateOAuth` against a seeded database (valid, expired, revoked, wrong
  resource, scope filtering of `tools/list`); the principal lookup (mapped + tracked → that account;
  unmapped or untracked → "isn't set up"); a non-owner `mark_watched` records history only and never
  calls Plex.
- Live gate (PLAN-069): ChatGPT, Claude Code and Codex each complete DCR → consent → a read tool → a
  refresh; ChatGPT completes a zero-flip `mark_watched` and `undo_last_change` on a title with no
  unwatched regular episode on the preferred server; revoke from the Connected apps page stops the
  next call with 401; the Movie Room bench is unchanged.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | claude.ai / Claude Desktop connectors were never exercised against cigar-journal; do they accept a stateless server whose GET answers 405? | Open; the live gate decides, with the empty-stream GET as the fallback. |
| Q-02 | Per-person connectors: the read-model tracks only the owner today (PRD Q-12). | **Ruled 2026-09-23:** the auth path and the principal are user-aware from day one (ADR-091 C-04); tracking household accounts in the `watch` sync is PLAN-070; Plex write-back stays owner-only until per-person Plex tokens exist. |
