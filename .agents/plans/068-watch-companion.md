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
| S1 | Build hygiene | Dockerfile deps stage COPYs every `packages/*/package.json`; scaffold `packages/watch` (`@hnet/watch`) and `packages/mcp` (`@hnet/mcp`) with the repo's package conventions | `pnpm install`, `pnpm typecheck`, `pnpm build` green; the image build job green if it runs on PRs. **Dockerfile done** (foundation PR #559): the 11 missing COPY lines added, every manifest listed (21 now that #558 added `@hnet/watch`; each new package adds its own line). `@hnet/mcp` arrives with S7 |
| S2 | Schema | migration `0077_watch_companion.sql` + `_journal.json` entry + schema + enums for the five DESIGN-049 D-07 tables; guard list | migrate clean on embedded PG; a test asserts the journal lists 0077. **Done** (#559): idx 76, `when` 1783903302000; `users.id`/`media_items.id` are uuid, so the FKs are (DESIGN-049 D-07 corrected); every CHECK tested against its const array; `runSync` refuses `--mode=watch` until S6 |
| S3 | Clients | `@hnet/arr` error messages redact `apikey`/`api_key` (first: the new sync adds Tautulli call paths, and every client error today embeds the key-bearing URL); `@hnet/plex` read (optional watch fields on `sectionItemSchema`, `allLeaves`, filtered pages, plex.tv watchlist) and write (`scrobble`, `unscrobble`, confined); `@hnet/arr` Tautulli history window + `get_metadata` 400/`{}` → gone, TMDB `recommendations` + `search/multi` | a redaction test; unit tests on recorded fixtures; the Tautulli row-id field and the Plex `unwatched=0` / `inProgress=1` filters verified with read-only GETs and noted here. **Done** (#559; redaction also covers `token` / `X-Plex-Token`; stubs extended and the stub Tautulli wired into the stack). **Verified 2026-09-23** (read-only GETs from a haynesnetwork pod; no key or token printed): **Tautulli** — under `grouping=0` the stable per-row id is `row_id` (`id` mirrors it; `reference_id` repeats across a group: HaynesTower row 42195 → reference 41839); `user_id=12874060` gives HaynesOps 118 rows, HaynesTower 5,158, HaynesKube 0 video (music only); `after=YYYY-MM-DD` works (a 30-day window returned only newer rows, `after=2099-01-01` → 0; Tautulli documents it as inclusive, by its local day); movies send `""` for `media_index`/`parent_media_index`; `include_activity=0` is accepted (no live session at probe time; a playing session has no `row_id`, so the ingest sends 0); `get_metadata` for a missing key → HTTP 400 "Unable to retrieve metadata for rating_key …", `data: {}`, on all three. Every Tautulli error is a 400 (an unknown command too), so the client maps only that message to "gone"; the same message can also come from a Plex outage (DESIGN-049 Q-06). **Plex** — HaynesOps movies (5,273): `unwatched=0` → 310, every one `viewCount ≥ 1` (a full client-side scan agrees), `unwatched=1` → 4,963 (sum = total); `inProgress=1` → 0 on HaynesOps (the scan finds no `viewOffset` either) and 97 on HaynesTower, each with a `viewOffset`; on a SHOW section `unwatched=0` means fully watched (9 of 952) and `inProgress=1` → 0, so show progress comes from the plain `type=2` listing (`leafCount`/`viewedLeafCount`/`lastViewedAt`). `allLeaves` (a 106-episode show) returns every episode incl. 15 specials with `index`/`parentIndex`; `viewCount`/`lastViewedAt` appear only on watched ones (28 = `viewedLeafCount` 28); Start/Size paging with `totalSize` works. `/library/all?guid=` (with `includeGuids=1`) → the same ratingKey. **Watchlist** — the discover provider answers the owner token: 151 titles (104 movies, 47 shows, all with Guids); max 100 per page (101 → HTTP 400), so two pages; default order = `watchlistedAt:desc`; items carry no watchlist timestamp (`addedAt` is the catalog date; the per-item `userState` endpoint has `watchlistedAt`), so `added_at` stays null. **TMDB** — `/recommendations` 20 per page; `search/multi` returns people too (`media_type: person`); an unknown id → 404 `status_code` 34 |
| S4 | Pure math | `@hnet/watch`: D-10 progress + states, D-13 resolver, D-16..D-19 profile/candidates/exclusions/score, D-21 formatter | the D-10/D-13/D-18 test matrix in DESIGN-049; AC-21 property test |
| S5 | Domain | writers for the five tables; `markWatched`, `dismissTitle`, `undoLastChange`, `revalidateTitles` (D-11..D-15) | embedded-PG tests with a recording fake Plex writer; undo reverses exactly `flipped`. **Done** (the S5–S6 PR, branch `agent/watch-core`): `packages/domain/src/watch/*` — `upsertWatchOwner`, `appendWatchEvents`, `fillShowGuids` (the one event update, Q-06), `upsertWatchTitles` (changed rows only, re-key in place, never delete), `replaceRecoSignals`, `resolveWatchTitle`, `markWatched` / `dismissTitle` / `undoLastChange`, `revalidateTitles`. **Verified** by `watch-writers.test.ts` (9) and `watch-marks.test.ts` (20) on embedded PG16 with a recording fake Plex — never a real server: show / season / episode / through / movie scopes write exactly the planned keys; a whole-show mark flipping 4 of 6 leaves undoes as two season keys + one episode key and restores the exact before-state; a mark flipping every leaf undoes as the show key; a partial failure records only the succeeded flips and its undo touches only those; replay inserts no row; not-on-Plex, TMDB exact-match fallback, ambiguous (no row, no Plex call), `local://` copies, `need_season`; dismiss and its undo make zero Plex calls; revalidation re-reads only moved titles and answers from the snapshot past its budget. `watch_events` / `watch_marks` joined the DELETE guard families; `@hnet/plex/write` is still domain-only (the import guard passes). The @hnet/watch rulings (`name:<kind>:…` keys, Q-05's 0.7 whole-word prefix, `PLEX_SERVERS` from `PLEX_SERVER_SLUGS`) landed with it (DESIGN-049 D-26) |
| S6 | Sync | `watch` mode (D-09) in the orchestrator and `sync.ts` | stub Tautulli/Plex tests: window paging, 400 handling, per-source degradation, change-detected re-reads. **Done** (the S5–S6 PR): `packages/sync/src/watch.ts` + the pure `watch-assemble.ts`; the orchestrator early-return block replaced S2's refusal; `sync.ts` USAGE, both `parseArgs` lists and the Plex/Tautulli/TMDB clients built only for `--mode=watch`. **Verified** by `watch-sync.test.ts` (13) on embedded PG16 with fake Plex servers and the REAL `TautulliClient` over a fetch stub: first-run backfill (no `after`, `include_activity=0`, `grouping=0`, `user_id`; a friend's row, a track and a live session with no `row_id` stay out), 500-row paging (3 pages for 1,203 rows), the 3-day window on the next run, allLeaves re-read only for the moved show — on every server that holds it — and nothing re-read or written when nothing moved, 404 / 400 / `{}` → guid-less then filled by the Q-06 retry (Plex first), per-source degradation (a Tautulli down, a Plex server down, plex.tv down with and without a stored owner), the watchlist replace, the 20-hour seed cadence with a failed seed keeping its rows, reset and deleted movies. Q-06 ruled (DESIGN-049). The `sync-watch` CronJob itself is S10 |
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
