# OPS-015 — Watch Companion: the MCP hop, the consumer token, the `watch` sync, and the Home Assistant wiring

- **Status:** Active (2026-09-23) — the operating record since PLAN-068 S12 passed live (haynesnetwork v0.97.0, haynes-ops #3139).
- **Scope:** operating the in-cluster MCP surface (`/api/mcp`), its hop, its generated token, the
  `sync-watch` CronJob, and the Movie Room agent that consumes it.
- **Normative basis:** ADR-087, ADR-088, ADR-089, DESIGN-049, PLAN-068; the watchlist tools ADR-092, DESIGN-051, PLAN-071 (§8).
- **Repos:** this app; haynes-ops (`kubernetes/main/apps/frontend/haynesnetwork/`,
  `kubernetes/main/apps/frontend/haynesnetwork-mcp-hop/`, dev-env `mcp.json`); hass-sandbox (the
  agent prompt backup and voice bench).

---

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| MCP endpoint | `haynesnetwork` web pods, `POST /api/mcp` | stateless; never routed by an IngressRoute |
| Consumer token | Secret `frontend/haynesnetwork-mcp-consumer`, key `HNET_MCP_HOP_TOKEN` (the generator's `secretKeys`) | minted once by an External Secrets `Password` generator (ExternalSecret `refreshPolicy: CreatedOnce`); the web container loads it through an optional `envFrom`; no copy exists in 1Password |
| Hop | `frontend/haynesnetwork-mcp-hop` :8080 `/mcp` | nginx injects `Authorization: Bearer`; CiliumNetworkPolicy admits Home Assistant, dev-env and probes only |
| Sync | CronJob `haynesnetwork-sync-watch`, `3,18,33,48 * * * *` | owner, events, Plex progress, watchlist, TMDB seeds |
| Voice consumer | HA `mcp` entry "Watch history" → Movie Room agent `conversation.chatgpt_5` only | prompt backup in hass-sandbox `agent-docs/voice-agent-prompts.md` |
| Agent consumer | dev-env `mcp.json` server `haynesnetwork` | same hop URL, no token |

## 2. Is it healthy?

From the Home Assistant pod (it is admitted by the hop's policy; the dev-env pod is too once its
`mcp.json` PR is merged):

```bash
kubectl exec -n home-automation deploy/home-assistant -- python3 -c '
import json, urllib.request
req = urllib.request.Request("http://haynesnetwork-mcp-hop.frontend.svc.cluster.local:8080/mcp",
  data=json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/list"}).encode(),
  headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream"})
with urllib.request.urlopen(req, timeout=5) as r:
  body = r.read(); print(r.status, len(body), "bytes", r.headers.get("Mcp-Session-Id"))'
```

Expect `200`, at most 4,096 bytes (3,633 with the nine tools of PLAN-071; the cap was 3,072 and the list 2,712 bytes with PLAN-068 S7's seven), and `None` for the session id. `401` means the hop and the web
pods hold different tokens (section 4); `503` means the web pods have no token (the Secret is
missing — check `kubectl get externalsecret -n frontend haynesnetwork-mcp-consumer`).

The sync: `kubectl get jobs -n frontend -l app.kubernetes.io/controller=sync-watch --sort-by=.status.startTime | tail -3`
and its log's final report line (`events`, `shows.reread`, `titles.upserted`, `errors`).

From outside the cluster `https://haynesnetwork.com/api/mcp` must answer **404** (the IngressRoute
exclusion). Anything else is an exposure bug: fix the IngressRoute first, then look at the rest.

## 3. Run the sync now

```bash
kubectl create job -n frontend --from=cronjob/haynesnetwork-sync-watch sync-watch-manual-$(date +%s)
```

The first run backfills the owner's whole history (about 11 Tautulli pages and 180 `allLeaves`
reads); later runs take seconds.

## 4. Rotate the consumer token

Rotation = **delete the generated Secret**; the ExternalSecret (`refreshPolicy: CreatedOnce`) then
recreates it from the generator with a new value:

```bash
kubectl delete secret -n frontend haynesnetwork-mcp-consumer
```

The dev-env service account has no secrets RBAC, so this is **the owner's action** — or, without
touching the cluster by hand, a git rename of the ExternalSecret in haynes-ops (the new object mints a
new Secret; the old one goes with its ExternalSecret). A `force-sync` annotation does **not** rotate
under `CreatedOnce`: the Secret already exists, so nothing is regenerated.

Reloader restarts the web pods and the hop when the Secret changes. Home Assistant and dev-env need
nothing (they never hold the token). If one side restarted before the other, a few calls answer 401
until both are rolled; `kubectl rollout restart deploy/haynesnetwork-mcp-hop -n frontend` settles it.
*(Corrected after the haynes-ops #3131 deploy: this section first said a force-sync rotates, and §1
named the key `HOP_TOKEN`.)*

## 5. Turn it off

- **Voice only:** remove `mcp-<entry id>` from the Movie Room subentry's `llm_hass_api` and restore
  the prompt from the hass-sandbox backup. The agent is back to Assist-only immediately.
- **Everything:** remove the hop app from `kubernetes/main/apps/frontend/kustomization.yaml` (git).
  The endpoint itself stays unreachable without the hop.

## 6. Troubleshooting

| Symptom | Look at |
|---|---|
| HA shows the "Watch history" entry as failed to set up | HA log `homeassistant.components.mcp`; usually a tool schema HA cannot convert (DESIGN-049 D-05 rules) or the hop unreachable |
| Answers are stale (just-finished episode still "next") | the sync's last success; `revalidate_timeout` lines in the web log (Plex slow) |
| A voice turn got slow | `[mcp] slow_call` lines (phase: resolve, revalidate, plex_write); the HA pipeline debug timings |
| "Watch history isn't ready yet." | no `owner` row: the sync has not succeeded once (plex.tv unreachable, or no Plex token) |
| A mark went to the wrong title | `undo_last_change` within 24 hours; later, re-mark by hand in Plex and add a `not_interested` or corrective mark |

## 7. Data

| Table | Rebuildable? |
|---|---|
| `watch_reco_signals` | yes, next run (TMDB seeds within 20 hours) |
| `watch_titles` | yes, next run (full `allLeaves` re-read when missing) |
| `watch_events` | yes, from Tautulli, as far back as each Tautulli remembers |
| `watch_accounts` | yes, next run |
| `watch_marks` | **no** — the owner's corrections and the undo record; never truncate |

## 8. The watchlist tools (ADR-092 / DESIGN-051, live since v0.100.0, 2026-09-26)

`watchlist` (read) lists the owner's plex.tv watchlist; `set_watchlist` (write, owner only) adds or removes one
title on plex.tv (`PUT discover.provider.plex.tv/actions/{add,remove}ToWatchlist`, the discover id being the
`plex://` guid suffix); `watch_status` ends with whether the title is on Plex and on the watchlist. A change is a
Watch Mark (`watchlist_add` / `watchlist_remove`) and `undo_last_change` reverses it.

- **Seerr downloads what is added.** Seerr auto-requests the owner's 20 newest watchlist titles every 3 minutes,
  auto-approved; undo cannot cancel a request already made (ADR-092 C-03, C-07). **A live test uses only a title
  already on Plex**, sent right after a Seerr tick (minutes divisible by 3, a few seconds past) and away from the
  `sync-watch` minutes, then undone. PLAN-071 S5 used The Matrix, Law & Order: SVU and Slow Horses.
- **Log line:** `[mcp] watchlist_changed {consumer, action, kind, result, onPlex}` (never a title); `result` is
  one of `written`, `failed`, `unchanged`, `not_found`, `ambiguous`, `not_in_catalog`, `unconfirmed`,
  `not_owner` (DESIGN-051 D-10).
- **After a deploy that changes the tool list, reload the HA entry.** Home Assistant loads the Movie Room
  agent's tool list once, when the "Watch history" `mcp` entry is set up, and never again (its coordinator has
  no listeners, so the 30-minute refresh never runs). Call `homeassistant.reload_config_entry` with
  `entry_id: 01M381GTWER1BG9K4MWG3GDEGR` (or restart HA); it reloads only that entry. ChatGPT keeps a connector's old tool list until the owner
  refreshes the connector in its settings and starts a new chat (DESIGN-051 D-12). Claude Code and Codex list
  tools when a session starts.
- **plex.tv's own view:** `GET discover.provider.plex.tv/library/metadata/<id>/userState` (`watchlistedAt`
  present when on the watchlist), with an owner server token from inside a `haynesnetwork-main` pod; never
  print the token.

| Symptom | Look at |
|---|---|
| "I couldn't reach Plex, so your watchlist didn't change." | plex.tv discover reachability from the web pods; `watchlist_changed` `failed` |
| "Plex didn't answer in time, so I can't tell whether X changed." | the write may still land; plex.tv `userState` for the title decides; undo of such an add removes it anyway (DESIGN-051 D-15n) |
| An add named the wrong title | `undo_last_change` at once; if the title was not on Plex, cancel the Seerr request in Seerr (undo cannot) |
