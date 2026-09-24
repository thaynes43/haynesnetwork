# ADR-091: Public connectors for the MCP surface — the app is its own OAuth 2.1 authorization server, and a separate public `/mcp` accepts only delegated tokens

- **Status:** Proposed
- **Date:** 2026-09-23
- **Deciders:** Tom Haynes (owner directive 2026-09-23: *"We should do what we did for cigar-journal so I
  can hook haynesnetwork-mcp up to ChatGPT"*) · drafted by Fable 5.1
- **Relates:** ADR-087 (the in-cluster surface; its C-08 deferred public connectors until a consumer
  existed — this ADR ends that deferral), ADR-088 (the owner-only read-model that fixes the principal),
  ADR-014 (inline two-step confirm), hard rule 5 (Authentik is the only login). Realized by DESIGN-050
  and FLOW-001; built by PLAN-069. PRD-001 Q-14 → R-247..R-251, US-14, AC-25..AC-28.

## Context and problem statement

ADR-087 put the Watch history MCP server inside the web app behind an in-cluster hop and a
cluster-generated bearer, and deliberately kept it off the internet: no consumer needed public
access, and Home Assistant cannot complete an OAuth flow anyway. The owner now wants ChatGPT
connected. A ChatGPT connector (and claude.ai, Claude Code, Codex) needs a public HTTPS Streamable
HTTP endpoint protected by OAuth 2.1: protected-resource metadata (RFC 9728), authorization-server
metadata (RFC 8414), dynamic client registration (RFC 7591 — ChatGPT registers one client per
connector with a per-connector redirect URI, so nothing can be pre-registered), PKCE S256 (RFC 7636),
`resource` binding (RFC 8707), refresh rotation and revocation (RFC 7009).

Cigar-journal built exactly this in 2026-08 (its ADR-005, FLOW-003, `packages/oauth`): a small
authorization server inside the app, opaque tokens stored as SHA-256 hashes, DCR, PKCE only, tokens
bound to the resource, rotating refresh families, consent through the app's own session. Thirty days
of its logs show ChatGPT, Claude Code and Codex connecting through it (about 80 refresh rotations and
20 re-authorizations from ChatGPT alone, no reuse detections). Home Assistant still cannot use it and
stays on its hop.

## Decision drivers

- **Hard rule 5 must hold.** People sign in to haynesnetwork only through Authentik. A connector
  token is a *delegation* of an existing signed-in session, never a way to sign in.
- **The hop must stay cluster-only** (ADR-087 C-03): whatever is opened to the internet must not
  make the hop token useful outside the cluster.
- **Owner-only data** (ADR-088): every tool acts as the Server Owner, and marks write to Plex as the
  owner. A connector must therefore only ever be authorized by the owner's own account.
- **Stateless server, three replicas** (ADR-087): nothing in-process; every replica must validate a
  token with a database lookup.
- **Proven client compatibility** over elegance: ChatGPT caches metadata, registers per connector,
  opens a session per call, and stalls on anything unusual.
- **An internet-facing OAuth server needs abuse protection** cigar-journal does not have: rate limits
  on registration and the token endpoint, bounded inputs, pruning, a consent page that shows where
  the browser is sent back to.
- **No second runtime** (ADR-087 option 2 stays rejected).

## Considered options

1. **Port cigar-journal's authorization server into `@hnet/oauth` and add a separate public
   `POST /mcp` that accepts only OAuth access tokens.** `/api/mcp` stays the hop's, excluded from
   every ingress. Chosen.
2. **Better Auth's `mcp` / `oidc-provider` plugins.** Rejected: both are deprecated in the pinned
   1.6 line ("will be removed in the next major version") and absent from 1.7; neither is proven
   against ChatGPT's DCR-per-connector behaviour; token storage is theirs, not ours.
3. **Authentik as the authorization server.** Rejected: Authentik has no dynamic client
   registration, so every ChatGPT connector (each with its own redirect URI) would need a manual
   provider; the app would validate tokens by introspection calls on every request; and the
   owner-only rule would live outside the app.
4. **One endpoint accepting both the hop bearer and OAuth tokens.** Rejected: routing `/api/mcp`
   publicly would make a leaked hop token usable from the internet and mix two consumer classes in
   one path. A second route costs one file.
5. **Cigar-journal's service tokens (its ADR-011) for browserless consumers.** Not ported: the hop
   already covers in-cluster consumers with a token no human ever sees, and a minted long-lived
   token is a credential a human would handle.

## Decision outcome

Chosen option: **1** — the smallest change that is already proven with every client the owner
uses, keeps the server stateless and the hop cluster-only, and keeps sign-in Authentik-only.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: ChatGPT, claude.ai, Claude Code and Codex connect through DCR + PKCE; the owner authorizes with the normal Authentik sign-in and a consent page. No new credential exists; hard rule 5 is intact. |
| C-02 | Good: tokens are opaque and stored only as SHA-256 hashes; any replica validates with one indexed lookup; the MCP server stays stateless on three replicas. |
| C-03 | Good: the hop path is unchanged and `/api/mcp` stays excluded from every IngressRoute; the public `/mcp` accepts OAuth tokens only, so the hop token stays useless outside the cluster. |
| C-04 | **The principal stays the Server Owner.** Only the owner's app user (the `watch_accounts` owner row's `app_user_id`, matched by email as the `watch` sync does) can complete consent; any other signed-in user gets a plain "not available for this account" page. Per-person connectors are PRD Q-12 territory and a later ADR. |
| C-05 | Scopes are exactly `watch:read`, `watch:write` and `offline_access`; a request without `scope` gets the default set, so no client ends up with an empty token. Clients request everything advertised, so nothing else is advertised. |
| C-06 | Attribution: a connector's marks record `watch_marks.consumer = oauth:<client_id>`; consent grant, deny, disconnect and reuse-detected family revocation write audit rows in the same transaction (hard rule 6). |
| C-07 | Abuse controls cigar-journal lacks: a per-IP (`CF-Connecting-IP`) database rate limit on `/oauth/register` and `/oauth/token`; `client_name` and redirect-URI caps; the consent page shows the redirect host (anyone can register a client named "ChatGPT"); expired rows and dormant DCR clients are pruned inline; a Gatus probe and a Loki alert watch the surface. |
| C-08 | Bad: a public OAuth surface on `haynesnetwork.com`. Mitigated by C-04 and C-05 — a stolen token acts only as the owner, only on the watch tools — and by C-07. |
| C-09 | Bad: two consumer paths in `@hnet/mcp` (hop bearer, OAuth token). Both resolve to one `McpConsumer` and share every downstream rule (budget, deadline, logging), so the divergence is confined to authentication. |
| C-10 | A **Connected apps** page (self-service disconnect with the ADR-014 inline confirm) ships in the same plan. Cigar-journal promised one and never built it. |
| C-11 | Home Assistant stays on the hop (no PKCE, no DCR — ADR-087 C-01). Nothing about the Movie Room path changes. |
| C-12 | Endpoint paths are fixed forever once published: clients cache authorization-server metadata (cigar-journal had to add permanent root aliases after ChatGPT cached a spike's paths). They are chosen once in DESIGN-050 D-02. |
| C-13 | ADR-087 C-08 is resolved by this ADR; PRD Q-14 closes. Stateless JSON-mode transport with GET answering 405 was never proven against ChatGPT (cigar-journal is stateful); PLAN-069's live gate checks it, and the fallback is a GET that opens and immediately closes an empty stream. |

## More information

- cigar-journal `docs/adr/005-mcp-integration.md`, `docs/flows/003-mcp-authorization.md`,
  `docs/mcp/client-compatibility.md`, `packages/oauth/src/*` (the port source), haynes-ops #3112
  (its hop) — survey of 2026-09-23.
- RFC 6749, 7636 (PKCE), 7591 (DCR), 8414 (AS metadata), 8707 (resource indicators), 9728
  (protected-resource metadata), 7009 (revocation), 8252 §7.3 (loopback redirects); the MCP
  authorization specification (2025-06-18).
- DESIGN-050 (the contract), FLOW-001 (authorize → consent → token), PLAN-069 (build and live gate),
  OPS-016 (operating the connector surface).
