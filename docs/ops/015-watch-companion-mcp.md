# OPS-015 — Watch Companion: the MCP hop, the consumer token, the `watch` sync, and the Home Assistant wiring

- **Status:** Draft (2026-09-23) — becomes the operating record when PLAN-068 S12 passes.
- **Scope:** operating the in-cluster MCP surface (`/api/mcp`), its hop, its generated token, the
  `sync-watch` CronJob, and the Movie Room agent that consumes it.
- **Normative basis:** ADR-087, ADR-088, ADR-089, DESIGN-049, PLAN-068.
- **Repos:** this app; haynes-ops (`kubernetes/main/apps/frontend/haynesnetwork/`,
  `kubernetes/main/apps/frontend/haynesnetwork-mcp-hop/`, dev-env `mcp.json`); hass-sandbox (the
  agent prompt backup and voice bench).

---

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| MCP endpoint | `haynesnetwork` web pods, `POST /api/mcp` | stateless; never routed by an IngressRoute |
| Consumer token | Secret `frontend/haynesnetwork-mcp-consumer`, key `HOP_TOKEN` | minted once by an External Secrets `Password` generator; no copy exists in 1Password |
| Hop | `frontend/haynesnetwork-mcp-hop` :8080 `/mcp` | nginx injects `Authorization: Bearer`; CiliumNetworkPolicy admits Home Assistant, dev-env and probes only |
| Sync | CronJob `haynesnetwork-sync-watch`, `3,18,33,48 * * * *` | owner, events, Plex progress, watchlist, TMDB seeds |
| Voice consumer | HA `mcp` entry "Watch" → Movie Room agent `conversation.chatgpt_5` only | prompt backup in hass-sandbox `agent-docs/voice-agent-prompts.md` |
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

Expect `200`, at most 3,072 bytes, and `None` for the session id. `401` means the hop and the web
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

```bash
kubectl annotate externalsecret -n frontend haynesnetwork-mcp-consumer force-sync=$(date +%s) --overwrite
```

The generator mints a new value, and Reloader restarts the web pods and the hop. Home Assistant and
dev-env need nothing (they never hold the token). If one side restarted before the other, a few
calls answer 401 until both are rolled; `kubectl rollout restart deploy/haynesnetwork-mcp-hop -n frontend`
settles it.

## 5. Turn it off

- **Voice only:** remove `mcp-<entry id>` from the Movie Room subentry's `llm_hass_api` and restore
  the prompt from the hass-sandbox backup. The agent is back to Assist-only immediately.
- **Everything:** remove the hop app from `kubernetes/main/apps/frontend/kustomization.yaml` (git).
  The endpoint itself stays unreachable without the hop.

## 6. Troubleshooting

| Symptom | Look at |
|---|---|
| HA shows the "Watch" entry as failed to set up | HA log `homeassistant.components.mcp`; usually a tool schema HA cannot convert (DESIGN-049 D-05 rules) or the hop unreachable |
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
