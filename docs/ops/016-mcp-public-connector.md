# OPS-016 — Public MCP connectors: the OAuth surface, the public `/mcp`, connected clients

- **Status:** Draft (skeleton; becomes Active when PLAN-069 S8 passes, with the per-client notes filled in).
- **Scope:** operating the internet-facing half of the watch MCP surface: the app's own OAuth 2.1
  authorization server, the public `POST /mcp`, the five OAuth tables, and the clients connected
  through them (ChatGPT, Claude Code, Codex). The in-cluster hop, `/api/mcp`, the `sync-watch` CronJob
  and the Movie Room agent are OPS-015.
- **Normative basis:** ADR-091, DESIGN-050, FLOW-001, PLAN-069.
- **Repos:** this app; haynes-ops (`kubernetes/main/apps/frontend/haynesnetwork/app/gatus.yaml` and
  `lokirule.yaml`; the dev-env CiliumNetworkPolicy for in-cluster tests).

---

## 1. What runs where

| Piece                   | Where                                                                                                                                                                                                                            | Notes                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Authorization server    | `haynesnetwork` web pods: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` (each also under `…/mcp`), `/oauth/register`, `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, `/oauth/revoke` | issuer `https://haynesnetwork.com`; stateless; the paths never change (ADR-091 C-12)                                 |
| Public MCP endpoint     | the same pods, `POST /mcp`                                                                                                                                                                                                       | accepts Delegated Tokens only; the hop token is refused there; routed by the existing `PathPrefix(/)` IngressRoutes  |
| In-cluster MCP endpoint | `POST /api/mcp`                                                                                                                                                                                                                  | the hop's, never routed (OPS-015)                                                                                    |
| State                   | the `haynesnetwork` database on CNPG `database/postgres16`: `oauth_clients`, `oauth_authorizations`, `oauth_authorization_codes`, `oauth_refresh_tokens`, `oauth_access_tokens`; rate-limit buckets in `rate_limit`              | tokens, codes and secrets are stored only as SHA-256 hashes                                                          |
| Principal               | per call: the token's user → `user_account_map` → a tracked `watch_accounts` row                                                                                                                                                 | only the Server Owner is tracked until PLAN-070; Plex is written only for the owner                                  |
| Probes                  | Gatus (haynes-ops `gatus.yaml`): `POST https://haynesnetwork.com/mcp` → 401; `GET …/.well-known/oauth-protected-resource` → 200 with the canonical `resource`                                                                    | Gatus cannot read response headers; §2's curl checks the challenge header                                            |
| Alert                   | Loki ruler (haynes-ops `lokirule.yaml`): `[auth] refresh_reuse_detected`, or more than 20 `authorize_rejected` / `rate_limited` in 10 minutes                                                                                    | only `severity: critical` reaches a human                                                                            |
| Clients                 | ChatGPT (owner's connector), Claude Code, Codex; claude.ai unverified (DESIGN-050 Q-01)                                                                                                                                          | per-client behaviour in DESIGN-050 D-12; this runbook gains a client-notes section from the live gate at PLAN-069 S9 |

## 2. Is it healthy?

The two Gatus endpoints are green. By hand, from anywhere with internet access (from the dev-env pod
add `-4`: the name has AAAA records and the cluster has no IPv6 egress):

```bash
# The 401 challenge: expect HTTP 401 and the resource_metadata header.
curl -sS -o /dev/null -D - -X POST https://haynesnetwork.com/mcp \
  -H 'Content-Type: application/json' -d '{}' | grep -iE '^HTTP|^www-authenticate'
# -> HTTP/2 401
# -> www-authenticate: Bearer resource_metadata="https://haynesnetwork.com/.well-known/oauth-protected-resource"

# The metadata: resource, issuer, the three scopes, S256 only.
curl -sS https://haynesnetwork.com/.well-known/oauth-protected-resource | jq '{resource, authorization_servers, scopes_supported}'
curl -sS https://haynesnetwork.com/.well-known/oauth-authorization-server | jq '{issuer, registration_endpoint, token_endpoint, code_challenge_methods_supported}'

# The hop's endpoint must stay unreachable from outside.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://haynesnetwork.com/api/mcp   # -> 404
```

Anything but 404 on `/api/mcp` is an exposure bug (OPS-015 §2): fix the IngressRoute first.

The auth log, in Grafana Explore (Loki):

```logql
{app="haynesnetwork", container="main"} |= "[auth]"
{app="haynesnetwork", container="main"} |= "[mcp] tool_called" |= "oauth:"
```

Every step logs one `[auth] <event> {…}` line (DESIGN-050 D-06) with at most a 6-character hash
fingerprint, never a token, code, secret or verifier. A line that holds one is a defect: file it, and
treat the token as leaked (§4).

## 3. See connected clients

Read-only, on a **replica** (never the primary):

```bash
REPLICA=$(kubectl get pods -n database -l cnpg.io/cluster=postgres16,cnpg.io/instanceRole=replica -o name | head -1)
kubectl exec -n database "$REPLICA" -c postgres -- psql -d haynesnetwork -c "
  SELECT c.client_name, c.client_id, u.email,
         min(r.created_at) AS connected, max(c.last_used_at) AS last_used,
         count(*) FILTER (WHERE r.revoked_at IS NULL AND r.rotated_at IS NULL AND r.expires_at > now()) AS live_refresh
  FROM oauth_clients c
  JOIN oauth_refresh_tokens r ON r.client_id = c.id
  JOIN users u ON u.id = r.user_id
  GROUP BY c.client_name, c.client_id, u.email
  ORDER BY last_used DESC NULLS LAST;"
```

Other useful reads (same exec):

- Live access tokens per client: `SELECT client_id, user_id, count(*) FROM oauth_access_tokens WHERE revoked_at IS NULL AND expires_at > now() GROUP BY 1, 2;`
- Pending consents: `SELECT client_id, user_id, expires_at FROM oauth_authorizations ORDER BY expires_at DESC LIMIT 20;`
- Registrations never used (pruning candidates): `SELECT client_name, created_at, registered_ip FROM oauth_clients WHERE last_used_at IS NULL ORDER BY created_at;`
- A connector's marks: `SELECT created_at, action, scope, title, plex_result, reverted_at FROM watch_marks WHERE consumer = 'oauth:<client_id>' ORDER BY created_at DESC;`

Never select `token_hash` or `code_hash` into a ticket, PR or chat. Column names follow DESIGN-050
D-03; correct this section against the migration at PLAN-069 S2 if they differ.

## 4. Revoke by hand

- **One app, one user:** that user opens **Connected apps** (the user menu, `/settings/connections`)
  and presses **Disconnect**, then **Confirm disconnect**. It revokes every token the app holds for
  that user in one transaction with an `oauth_client_disconnected` audit row; the app's next call is
  refused on every replica. The owner does this for his own connectors.
- **There is no admin or command-line revoke.** Do not update or delete OAuth rows with SQL: the
  audited writers are the only way in (hard rule 6), and a hand edit leaves no record. Use §3 to see
  what is connected, and ask the user to disconnect.
- **A suspected leak or abuse:** take the public surface off the internet (§5) and then disconnect.
- **A family the server revoked on its own** (`refresh_reuse_detected`) needs nothing: the client
  signs in and consents again.

## 5. Turn it off

Exclude `/mcp` and `/oauth` in the three IngressRoutes (haynes-ops,
`kubernetes/main/apps/frontend/haynesnetwork/app/ingressroute.yaml`) the way `/api/mcp` is excluded
already, and merge. Clients then fail to connect; the metadata documents that stay reachable are
harmless without the endpoints. The hop, the Movie Room agent and the dev-env agents are unaffected.

## 6. Rotation

None. There is no shared secret: every client gets its own opaque tokens at consent, access tokens
live 1 hour and refresh tokens 60 days, rotated on every use. Nothing needs rotating on a schedule.
The hop's consumer token is separate and rotates per OPS-015 §4.

## 7. Troubleshooting

| Symptom                                                            | Look at                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ChatGPT still shows old tools, or keeps using old endpoint paths   | ChatGPT caches the authorization-server metadata and the tool schemas. Refresh the connector in ChatGPT's settings, then start a **new chat** (an old chat keeps its old schemas). The paths themselves never change (ADR-091 C-12)                                                                                      |
| A client loops on 401                                              | `[auth]` lines for that client: `refresh_reuse_detected` (the family was revoked; it must consent again), `audience_mismatch` (a token bound to another resource), or no `token_refreshed` at all (the client is not refreshing; reconnect it). Check the Delegated Token has not expired past the 60-day refresh window |
| Registration refused                                               | `rate_limited` on `/oauth/register`: more than 10 an hour from one IP (`CF-Connecting-IP`). Wait an hour; a client that registers on every attempt is misbehaving                                                                                                                                                        |
| Token calls refused in bursts                                      | `rate_limited` on `/oauth/token` (60 a minute per IP)                                                                                                                                                                                                                                                                    |
| "Something is off with this connection request"                    | `authorize_rejected`: an unknown `client_id` (the client's registration was pruned or it never registered) or a redirect URI that was not registered. Remove and re-add the connector in the client                                                                                                                      |
| "This request expired"                                             | more than 10 minutes on the consent page, or a consent link opened in another user's session. Start again from the app                                                                                                                                                                                                   |
| Consent approved but the client says it failed                     | the code lives 60 seconds: a slow paste or a callback that never reached the client (a loopback URL opened on another device) answers `invalid_grant`                                                                                                                                                                    |
| Every answer is "Watch history isn't set up for your account yet." | the signed-in user has no Plex Account Map row, or their account is not tracked (everyone but the owner until PLAN-070). For the owner: check `user_account_map` maps his Plex id 12874060 to his app user                                                                                                               |
| A mark "did not change Plex"                                       | expected for anyone but the owner (history only, `plex_result = 'none'`)                                                                                                                                                                                                                                                 |
| A dev-env CLI cannot connect                                       | egress (the dev-env policy's HTTPS rule must list `haynesnetwork.com`) or IPv6: set `NODE_OPTIONS=--dns-result-order=ipv4first`                                                                                                                                                                                          |
| The Loki alert fired                                               | `refresh_reuse_detected`: a refresh token was replayed (a leaked token, or a client bug); see which client and user in the line and §3. A burst of `authorize_rejected` / `rate_limited`: someone probing the endpoints; check the IPs, and turn it off (§5) if it persists                                              |

## 8. Data

| Table                                               | Rebuildable?                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `oauth_clients`                                     | nothing to rebuild: a client registers again on its next connect (ChatGPT re-registers only if its connector is re-created) |
| `oauth_authorizations`, `oauth_authorization_codes` | transient (10 minutes, 60 seconds)                                                                                          |
| `oauth_refresh_tokens`, `oauth_access_tokens`       | nothing to rebuild: losing them disconnects every app, and each user consents again                                         |
| `rate_limit` (the OAuth route buckets)              | transient buckets                                                                                                           |
| the consent, disconnect and reuse audit rows        | the only record of who connected what; never truncate                                                                       |
