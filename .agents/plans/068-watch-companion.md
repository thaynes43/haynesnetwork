# PLAN-068: Watch Companion — build, deploy, attach to the Movie Room voice agent, verify

- **ADRs:** ADR-087 (MCP surface), ADR-088 (read-model + Watch Marks + Plex write-back), ADR-089
  (recommendations) — all Proposed until S14 · **Design:** DESIGN-049 · **PRD:** R-240..R-246,
  US-13, AC-20..AC-24
- **Owner:** whoever holds the session; this plan is the tracked owner.
- **Owner rulings:** 2026-09-23 request (the Movie Room agent, watch history on all servers, "what
  haven't I finished", "what should I watch next", "I already watched X"); 2026-09-23 **"Mark it in
  Plex too"** for "I already watched X" (asked on his phone).
- **Cross-repo:** haynes-ops (hop, token, CronJob, ingress, dev-env), hass-sandbox (the HA agent
  record, prompt backup, voice bench).

## Evidence (surveys 2026-09-23)

| Fact | Source |
|---|---|
| Movie Room box = device `28c4d487734253cfec7955cbdee0f539`, pipeline "Movie Room Assist" `01jk451rswcggg0xt1d5yfxr7b` (HA Cloud STT/TTS, prefer local), agent `conversation.chatgpt_5` = OpenAI `gpt-5.6-terra`, reasoning none, Assist API only, prompt 2,730 characters | HA config entries, read-only |
| Attaching cigar-journal's 35 tools cost about 27k tokens and about 2 s per turn on OpenAI; owner ruled 2026-09-22 "We can't afford 2 seconds for a text agent" | hass-sandbox `.agents/plans/local-assist-stack.md`, PR #192 |
| HA 2026.9.3 `mcp` client: URL + OAuth only (no static header, no PKCE, no DCR); fresh session per tool call (~35 ms in-cluster); tool list cached 30 min; server instructions dropped; every tool on every request | HA core source at 2026.9.3 |
| All three Plex servers are owned by manofoz (plex.tv id 12874060); view-state sync is on (940/944 shared shows agree); resume points and `local://` items are not synced | live Plex/plex.tv reads |
| Owner history: HaynesTower 2023-09-18 → 2026-09-05 (1,329 episodes, 561 movies); HaynesOps since 2026-07-04; HaynesKube music only | Tautulli `get_history` |
| Plex flags reset on rewatch (Rick and Morty 28/106 in Plex vs S1–S8 in Tautulli); specials inflate `leafCount`; the owner account carries the children's viewing | live reads |
| haynesnetwork: `user_media_watch` per title and empty (map writer unwired); household harvest capped at the newest 10k rows per instance; no MCP code; cookie sessions only; 3 replicas; public ingress without forward-auth | code + live DB (read-only) |
| HA can reach `haynesnetwork.frontend:3000` (no NetworkPolicy); dev-env is fenced to allowlisted names | reachability probes |
| Plex watchlist: 151 titles; Seerr has no Tautulli; Trakt unused | plex.tv, Seerr reads |

## Build stages

| # | Stage | Deliverable | Gate |
|---|---|---|---|
| S1 | Build hygiene | Dockerfile deps stage COPYs every `packages/*/package.json`; scaffold `packages/watch` (`@hnet/watch`) and `packages/mcp` (`@hnet/mcp`) with the repo's package conventions | `pnpm install`, `pnpm typecheck`, `pnpm build` green; the image build job green if it runs on PRs |
| S2 | Schema | migration `0077_watch_companion.sql` + `_journal.json` entry + schema + enums for the five DESIGN-049 D-07 tables; guard list | migrate clean on embedded PG; a test asserts the journal lists 0077 |
| S3 | Clients | `@hnet/arr` error messages redact `apikey`/`api_key` (first: the new sync adds Tautulli call paths, and every client error today embeds the key-bearing URL); `@hnet/plex` read (optional watch fields on `sectionItemSchema`, `allLeaves`, filtered pages, plex.tv watchlist) and write (`scrobble`, `unscrobble`, confined); `@hnet/arr` Tautulli history window + `get_metadata` 400/`{}` → gone, TMDB `recommendations` + `search/multi` | a redaction test; unit tests on recorded fixtures; the Tautulli row-id field and the Plex `unwatched=0` / `inProgress=1` filters verified with read-only GETs and noted here |
| S4 | Pure math | `@hnet/watch`: D-10 progress + states, D-13 resolver, D-16..D-19 profile/candidates/exclusions/score, D-21 formatter | the D-10/D-13/D-18 test matrix in DESIGN-049; AC-21 property test |
| S5 | Domain | writers for the five tables; `markWatched`, `dismissTitle`, `undoLastChange`, `revalidateTitles` (D-11..D-15) | embedded-PG tests with a recording fake Plex writer; undo reverses exactly `flipped` |
| S6 | Sync | `watch` mode (D-09) in the orchestrator and `sync.ts` | stub Tautulli/Plex tests: window paging, 400 handling, per-source degradation, change-detected re-reads |
| S7 | MCP | `@hnet/mcp` handler, auth, seven tools, logging; `apps/web/app/api/mcp/route.ts` | SDK-client end-to-end tests: no session id, `tools/list` ≤ 3,072 bytes, results ≤ 1,200 characters, 401/503/405 |
| S8 | Local stack | `dev:local` wires the existing `stub-tautulli.ts` (with `user_id` rows) and stub Plex watch endpoints; a local hop token | `pnpm dev:local` answers `unfinished` over curl |
| S9 | Release | feature PR(s) merged, release-please PR merged, image `ghcr.io/thaynes43/haynesnetwork:vX.Y.Z` signed | image manifest present |
| S10 | haynes-ops | generator + ExternalSecret, web env, `sync-watch` CronJob, IngressRoute exclusions, tag bump; new app `frontend/haynesnetwork-mcp-hop` with its CiliumNetworkPolicy | flux-local green; reconcile; rollout 3/3; `/api/health` 200 |
| S11 | Live data | first `sync-watch` run (manual Job from the CronJob) backfills; row counts checked against the evidence table | owner row present; events ≈ Tautulli counts; unfinished list sane |
| S12 | Live MCP | from the HA pod: initialize via the hop (no session id), `tools/list` bytes, `unfinished`, `recommend`, `watch_status`; from outside: `https://haynesnetwork.com/api/mcp` → 404 | all pass |
| S13 | Home Assistant | bench the Movie Room agent (text, read-only) → add the `mcp` entry + API + WATCH HISTORY prompt block → bench again → the three US-13 questions; hass-sandbox PR with the prompt backup and the Tool track 2 record | ≤ 0.5 s median added on non-watch questions (R-245); AC-24 |
| S14 | dev-env + close | haynes-ops PR for the dev-env CiliumNetworkPolicy egress rule (merged normally: not under `resources/**`); held-draft PR for `mcp.json` (bounces the pod, the owner merges it); ADR-087/088/089 → Accepted; HANDOFF; this plan → `completed/` | policy merged and the hop reachable from dev-env; `mcp.json` PR held with the reason stated |

**Hard rule: no Plex write before S5's undo test passes.** `mark_watched` may be built earlier; it
may not reach a real server until `undo_last_change` provably reverses exactly what it flipped.

**Live-test rule for S13:** marks are only exercised live on a title the owner has already fully
watched (zero flips, so Plex does not change), followed by `undo_last_change`.

## Invariants a reviewer must not let regress

1. No tool accepts an account or user id; the principal is the `owner` row (DESIGN-049 D-03).
2. `recommend` can never return an Ever Watched, started, dismissed or not-mine title (D-18, AC-21).
3. `dismiss` and `undo` of a dismiss never call Plex; only `watched` marks and their undo do.
4. `@hnet/plex/write` is imported only by `packages/domain` and `packages/plex`.
5. `/api/mcp` is never routed by an IngressRoute; the hop never gets one.
6. The Voice Budget tests stay: `tools/list` ≤ 3,072 bytes, default results ≤ 1,200 characters.
7. Arguments and results are never logged.

## Out of scope (tracked elsewhere)

- Household persons, Seerr requests by voice, public connectors: PRD Q-12..Q-14.
- ADR-053's unwired `user_account_map` writer: fixed on its own branch (`agent/fix-plex-account-map`).
- The household harvest's 10k-row window: a GitHub issue (it moves Trash numbers, an owner call).
