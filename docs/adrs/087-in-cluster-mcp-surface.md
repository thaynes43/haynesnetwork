# ADR-087: The MCP surface — a stateless, in-cluster-only endpoint in the web app, reached through a header-injecting hop with a cluster-generated consumer token

- **Status:** Accepted (2026-09-23 — live as haynesnetwork v0.97.0 behind the hop, haynes-ops #3131/#3139; the Movie Room agent attached, AC-24 passed)
- **Superseded in part by:** [ADR-092](092-plex-watchlist-tools.md) (2026-09-25, effective when ADR-092 is Accepted) — C-07's 3 KB `tools/list`
  cap becomes 4 KB for the two watchlist tools (ADR-092 C-09). Everything else stands.
- **Date:** 2026-09-23
- **Deciders:** Tom Haynes (owner request 2026-09-23: *"Possibly an MCP Server for the haynesnetwork
  site? … I want specialized agents for specialized things and I want dev-env to have access to the
  broad spectrum of these tools"*) · drafted by Opus 5.5
- **Relates:** ADR-029 (the Server Owner is whoever the server tokens belong to — reused as the
  principal), ADR-068 (the three-Tautulli env contract), ADR-088 (the watch read-model this surface
  serves), ADR-089 (recommendations). Realized by DESIGN-049; built by PLAN-068. PRD-001 R-244..R-246.

## Context and problem statement

The owner wants a specialized voice agent for the Movie Room Home Assistant Voice PE box that knows
his watch history ("what series haven't I finished?", "what should I watch next?", "I already
watched X, recommend something new"), and wants the dev-env agents to reach the same tools. The
natural home is this app: it already holds the three Tautulli keys, the three Plex owner tokens, the
*arr ledger with ratings and genres, and the owner's identity (ADR-029). It has no machine-client
surface except per-source webhook secrets, and no MCP code.

The consumers set hard constraints, measured on 2026-09-22 in hass-sandbox
(`.agents/plans/local-assist-stack.md`, "Tool track 1") and re-read from the Home Assistant 2026.9.3
source on 2026-09-23:

1. **Home Assistant's `mcp` client takes a URL plus optional OAuth, and nothing else.** It sends no
   static header, performs no PKCE (so a strict OAuth 2.1 server rejects it) and has no dynamic
   client registration. The live workaround for the cigar-journal server is an nginx *hop* in
   haynes-ops (`home-automation/cigar-mcp-hop`, #3112) that injects the bearer header.
2. **Every tool schema rides every model request.** Attaching cigar-journal's 35 tools added about
   27k tokens per turn and about **2 s per voice turn** on OpenAI. Owner ruling 2026-09-22: *"We
   can't afford 2 seconds for a text agent"*, and the tools were removed from the Kitchen agent.
3. **Results are forwarded whole and re-sent.** A satellite reuses its conversation for 5 minutes and
   OpenAI/Anthropic agents re-send the whole chat log, tool results included.
4. **The server's `instructions` are dropped** by HA; only the server name reaches the prompt.
5. **HA opens a fresh session per tool call** (initialize → initialized → call; the tool list is
   cached for 30 minutes). The handshake measured 35 ms in-cluster, so transport is not the cost.

On this app's side: the web Deployment runs **3 replicas without session affinity**, is
**internet-facing** (Cloudflare Tunnel → traefik-external, `PathPrefix(/)`, no forward-auth), and
authenticates people only through Authentik OIDC (hard rule 5).

## Decision drivers

- **Voice latency is the product.** Tool schemas and results must be small enough that attaching the
  server costs a voice turn well under half a second.
- **No human handles a secret.** The dev-env agents cannot write 1Password and the owner should not
  paste tokens through chat.
- **Least exposure.** v1 has only in-cluster consumers; nothing needs to reach this from the internet.
- **Hard rule 5 stays whole.** Machine consumers are not a login method.
- **Stateless, because there are three replicas.** In-memory MCP sessions would break across pods
  (and cigar-journal's stateful server leaks sessions that are never closed).
- **Reuse the proven hop pattern** rather than invent a second workaround for HA's client.

## Considered options

1. **A stateless Streamable-HTTP endpoint inside the web app, excluded from both IngressRoutes,
   reached through a header-injecting hop whose bearer is minted in-cluster by an External Secrets
   `Password` generator** (chosen).
2. **A separate MCP process and controller, cigar-journal style** (Express on its own port, stateful
   sessions, its own OAuth 2.1 authorization server). Rejected: a second runtime and Deployment for
   seven tools; stateful sessions force a single replica and have already leaked in cigar-journal;
   HA cannot complete its OAuth flow anyway, so the hop would still be needed.
3. **OAuth 2.1 now, through Better Auth's `mcp`/`oidc-provider` plugins.** Rejected for v1: HA cannot
   do PKCE, no current consumer needs public access, and it adds a user-facing auth surface that
   touches hard rule 5. Kept as the path for a future public connector (Q-14).
4. **An unauthenticated endpoint protected only by a NetworkPolicy.** Rejected: the same pods are
   internet-facing through Traefik; one mis-scoped rule would publish the owner's history.
5. **A static token in the URL for Home Assistant** (`http://ha:<token>@host/api/mcp`, which HA's
   httpx client sends as `Authorization: Basic`; proven with HA's client library on 2026-09-23).
   Rejected: the token would sit in HA's config entry and in any URL HA displays, and someone would
   have to copy the plaintext out of the cluster to configure it. The hop keeps it inside the
   Secret. Kept as the fallback if the hop is ever unwanted.
6. **A standalone media MCP server in haynes-ops** (the 2026-09-22 hass-sandbox proposal,
   `ai/media-mcp`). Rejected by the owner's 2026-09-23 steer toward this app: it would duplicate the
   Tautulli/Plex clients, the identity model, the ledger and the tokens that already live here.

## Decision outcome

Chosen option: **1**.

- **Endpoint.** `POST /api/mcp` in `apps/web`, MCP Streamable HTTP in stateless mode with JSON
  responses: no `Mcp-Session-Id`, a fresh server per request, `GET`/`DELETE` answer 405. Any
  replica can serve any request.
- **Consumer auth.** `Authorization: Bearer <token>`, compared in constant time against the
  **hop consumer token** in the web pods' environment. The token is 48 random characters minted once
  by an External Secrets `Password` generator into a Secret in namespace `frontend`, read by both the
  web Deployment and the hop. No person ever sees it. Unset token ⇒ 503 (the webhook posture).
- **Principal.** The hop consumer acts as the **Server Owner** (DDD-001 T-94): the Plex account behind the server
  tokens (ADR-029 `getOwnerAccount()`), mapped to the app user with that email for attribution. The
  consumer carries the `watch:read` and `watch:write` scopes and nothing else. Tools never accept a
  user id.
- **Exposure.** `/api/mcp` is removed from both haynesnetwork IngressRoutes, so Traefik returns 404
  for it from the internet and the LAN. The hop (`frontend/haynesnetwork-mcp-hop`, nginx, ClusterIP
  only) carries a CiliumNetworkPolicy admitting the Home Assistant pod, the dev-env pod and kubelet
  probes, nothing else.
- **Voice budget.** The whole `tools/list` stays at or under **3 KB**; each tool has a one-sentence
  description and flat parameters; results are **plain text written to be spoken**, at most **1,200
  characters** by default, with no `structuredContent` (HA would forward it too). The server
  `instructions` stay under 600 characters because only Claude Code and Codex read them.
- **Consumers.** Home Assistant attaches the hop URL through its `mcp` integration and grants it to
  exactly one agent, the Movie Room agent. The dev-env pod registers the same hop URL in its
  `mcp.json`, which needs no token of its own.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: one surface serves the voice agent and the dev-env agents; stateless, so there are no sessions to leak and any of the three replicas answers. |
| C-02 | Good: **no human secret handling.** The generator mints the token in-cluster; the web pods and the hop read the same Secret. Rotation = delete the generated Secret; External Secrets mints a new value and Reloader rolls both consumers. |
| C-03 | Good: **in-cluster only.** Both IngressRoutes exclude `/api/mcp`; the hop has no ingress and a CiliumNetworkPolicy. A leaked hop URL is useless outside the cluster. |
| C-04 | Good: **hard rule 5 untouched.** The consumer token authenticates a machine client with a fixed principal, the same class of credential as the webhook secrets. No person can sign in with it, and no invite or password flow exists. |
| C-05 | Bad/accepted: **anything admitted to the hop acts as the owner on the watch tools.** The CiliumNetworkPolicy is load-bearing, and the consumer's scopes are limited to watch reads and marks. No ledger, Trash, role or share tool may ever be registered for this consumer without a new ADR. |
| C-06 | Cost: a small nginx Deployment, one generated Secret and one web env var. The hop bakes the token at start; Reloader restarts it on rotation. |
| C-07 | Good: **the voice budget is enforced by tests**, not by review: a test fails if the serialized `tools/list` exceeds 3 KB or a default result exceeds 1,200 characters. |
| C-08 | Deferred: a public connector (claude.ai, Claude mobile, ChatGPT) needs OAuth 2.1 with PKCE and dynamic client registration, and per-person tokens need a token table. Both wait for a consumer and a new ADR (PRD Q-14). |

## More information

- DESIGN-049 D-01..D-06 (route, auth, hop, network policy, budgets, logging); OPS-015 (hop and
  token operations).
- HA facts: `homeassistant/components/mcp/coordinator.py` (per-call session, 30-minute tool cache),
  `config_flow.py` (URL + OAuth only), `helpers/llm.py` (tools renamed `<api>__<tool>` when an agent
  has more than one API). Measured and cited in PLAN-068's evidence section.
- Hop precedent: haynes-ops `kubernetes/main/apps/home-automation/cigar-mcp-hop/` (#3112).
