# DESIGN-049: Watch Companion — watch history read-model, recommendations, voice reconcile marks, and the in-cluster MCP surface

- **Status:** Draft
- **Last updated:** 2026-09-23 (PLAN-068 S4: D-25 records the pure-math rulings; D-21 example order fixed; Q-05)
- **Satisfies:** PRD-001 R-240..R-246, US-13, AC-20..AC-24; governed by ADR-087 (MCP surface),
  ADR-088 (read-model, Watch Marks, Plex write-back), ADR-089 (recommendations); reuses ADR-017
  (confined Plex writes), ADR-029 (Server Owner), ADR-068 (Tautulli trio env contract).
- **Context:** DDD-002 BC-06 Watch Companion; glossary DDD-001 T-243..T-253.

## Overview

```
Movie Room Voice PE ─▶ HA pipeline "Movie Room Assist" ─▶ conversation.chatgpt_5 (OpenAI, APIs: assist + mcp)
                                                              │ HA mcp client: URL only, fresh session per call
dev-env Claude Code / Codex ──────────────────────────────────┤
                                                              ▼
                         frontend/haynesnetwork-mcp-hop :8080/mcp   (nginx; injects Bearer; CiliumNetworkPolicy)
                                                              ▼
                         haynesnetwork :3000  POST /api/mcp   (stateless Streamable HTTP, JSON responses)
                               │  @hnet/mcp: auth → 7 tools
                               ├─ @hnet/watch: reads, progress math, resolver, scoring, spoken formatting
                               └─ @hnet/domain: Watch Marks, live revalidation ─▶ @hnet/plex/write scrobble/unscrobble
                                                              ▲
 CronJob sync-watch (*/15) ─ @hnet/sync `watch` mode ─▶ Tautulli ×3 (history) · Plex HaynesOps + HaynesTower
                             (owner progress) · plex.tv (owner, watchlist) · TMDB (seed recommendations)
                             ─▶ @hnet/domain writers ─▶ watch_accounts · watch_events · watch_titles ·
                                                        watch_marks · watch_reco_signals
```

Everything a voice turn reads comes from Postgres. Plex is touched at request time only to
revalidate the handful of titles in an answer (D-11) and to apply a Watch Mark (D-14).

## Detailed design

### D-01 — Packages and ownership

| Package | Adds | Rule |
|---|---|---|
| `@hnet/db` | migration `0077_watch_companion.sql` (+ `_journal.json` entry), schema file for the five tables, enum constants | CHECK constraints written by hand from `schema/enums.ts` |
| `@hnet/watch` (**new**) | pure progress math (D-10), states, resolver scoring (D-13), taste profile and scoring (D-16..D-19), spoken formatter (D-21), read queries (SELECT only) | imports `@hnet/db` and zod only; never writes; never imports `@hnet/domain`, `@hnet/plex/write` or the MCP SDK (the `/sync` bundle flattens its dependencies) |
| `@hnet/domain` | `watch/*` single-writers: accounts, events, titles, marks, signals; `markWatched`, `dismissTitle`, `undoLastChange`, `revalidateTitles` | the only importer of `@hnet/plex/write`; tables join `no-direct-state-writes` |
| `@hnet/plex` | read: the optional watch fields added to `sectionItemSchema` (`viewCount`, `viewedLeafCount`, `lastViewedAt`, `viewOffset`, `Genre[]`, `contentRating`, `parentIndex`, `parentRatingKey`, `grandparentRatingKey`, `grandparentTitle`, `grandparentGuid`), `listAllLeaves(ratingKey)` (paged, with a `truncated` flag), filtered section pages (`type`, `unwatched`, `inProgress`), `findByGuid(guid)` (`/library/all?guid=`), `getWatchlist()` (discover provider; base URL `plexDiscoverBaseUrl`, default `https://discover.provider.plex.tv`, env override `PLEX_DISCOVER_URL`); write: `scrobble(ratingKey)`, `unscrobble(ratingKey)` on `PlexWriteClient` | fields are optional, so `plex-match` and every existing reader are unchanged; `@hnet/plex/write` stays import-confined (ADR-017 C-10, `arr-write-import-guard.test.ts`). The two writes are GETs, issued through `PlexHttp.requestIdempotentGet` and **retried like a read** (3 attempts on timeout / network / 502-504): both are idempotent on watched state, so a retry after an ambiguous timeout cannot flip anything else, while giving up would record a failed mark for a write that probably landed |
| `@hnet/arr` | Tautulli `getHistory` gains `userId`, `after`, `grouping`, `orderColumn`/`orderDir`, and the history row schema gains the row id (`row_id`), `guid`, `media_index`, `parent_media_index`, `parent_rating_key`, `percent_complete`, `year`, `full_title`, `started`; `getMetadata` maps both HTTP 400 and `{}` to "gone" (`null`); TMDB `getMovieRecommendations`/`getTvRecommendations`/`searchMulti`; **error messages redact credential query values** — `apikey`, `api_key`, `token` and `X-Plex-Token`, case-insensitively, in every ArrError's `message`, `url` and `bodySnippet` (every `ArrHttpError`/`ArrTimeoutError`/`ArrParseError` used to embed the full URL, and Tautulli and TMDB v3 carry their keys in the query) | read-only clients |
| `@hnet/sync` | `watch` mode (D-09): `SYNC_RUN_KINDS` gains `watch` (migration 0077 re-adds the `sync_runs_run_kind_enum` CHECK), an early-return orchestrator block like `plex-match`, `sync.ts` USAGE and both `parseArgs` lists | calls domain writers only; depends on `@hnet/watch` as a `dependency` (not dev) so `deploy --prod` keeps it |
| `@hnet/mcp` (**new**) | request handler, consumer auth, tool registry, budgets, logging | depends on `@modelcontextprotocol/sdk` 1.30.x (zod `^3.25 \|\| ^4` peer, so zod 4.4.3 is fine), `@hnet/watch`, `@hnet/domain`; its tests use embedded Postgres and the SDK `Client` |
| `apps/web` | `app/api/mcp/route.ts` (a thin adapter) and a `lib/__tests__` route test that mocks `@hnet/mcp` (web tests never touch a database) | `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`; declares `@hnet/mcp` as a workspace dependency |

The Dockerfile's dependency stage must COPY every workspace `package.json` (today it copies 9 of 20
and works only because the missing ones depend on nothing but `zod`); PLAN-068 S1 fixes that before
the first new dependency lands. `build-image` is not a required check, so a missing COPY line would
merge green and fail only at release.

### D-02 — The MCP endpoint

- `POST /api/mcp` only. The route exports only `POST`, so Next answers every other method with
  **405**. GET and DELETE must never reach the transport: in stateless mode it would open an SSE
  stream that never ends for a GET.
- MCP Streamable HTTP, **stateless**: a new `McpServer` and a new
  `WebStandardStreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`,
  `handleRequest(req: Request): Promise<Response>`) per request, `sessionIdGenerator: undefined`,
  `enableJsonResponse: true`. No `Mcp-Session-Id` is ever issued, so
  clients never open the GET stream or send DELETE. The pair must be new per request (a stateless
  transport refuses a second request and a server binds one transport); the zod schemas live at
  module scope, which keeps the per-request build under a millisecond (prototype, 2026-09-23).
- SDK: `@modelcontextprotocol/sdk` **1.30.x** (v1). v2 (`@modelcontextprotocol/server` 2.x, GA
  2026-07-27) answers older-protocol clients, which Home Assistant and Codex are, with SSE even in
  JSON mode; it is the upgrade path, not day one.
- Clients must send `Accept: application/json, text/event-stream` (406 otherwise) and
  `Content-Type: application/json` (415 otherwise); all three consumer clients do.
- Body limit 64 KB, enforced before the transport (v1 has none): read the body capped, parse it, and
  pass `parsedBody` to `handleRequest`. A thrown tool error is replaced by the D-06 text before it can
  reach the client (the SDK would otherwise return the raw `error.message`).
- `serverInfo`: name **`Watch history`**, version = app version. Home Assistant uses the name as
  the config entry title and in the prompt ("tools … from a remote server named Watch history"),
  and, because the Movie Room agent also has Assist, namespaces every tool with its slug:
  `watch_history__recommend`, and Assist's own tools become `assist__…` (HA `helpers/llm.py`
  `MergedAPI`). Claude Code and Codex name tools after their `mcp.json` key instead. `instructions` (≤600 characters; only
  Claude Code and Codex read them): *"Watch history for the owner's Plex account across HaynesOps,
  HaynesKube and HaynesTower. Every result is short plain text meant to be read aloud. unfinished:
  shows started and not finished. recommend: never-watched picks with reasons (pass offset for
  more). watch_status: one title. recent_history: recent plays. mark_watched writes to Plex;
  dismiss never does; undo_last_change reverses the last change."*
- Tool annotations: reads `readOnlyHint: true`; `mark_watched` `destructiveHint: false,
  idempotentHint: true`; `dismiss` and `undo_last_change` `destructiveHint: false`.

### D-03 — Consumer auth and the principal

- One consumer in v1, `hop`: `Authorization: Bearer <HNET_MCP_HOP_TOKEN>`. Compare SHA-256 digests
  with `timingSafeEqual` (the webhook-secret pattern). Missing or wrong ⇒ **401**
  (`WWW-Authenticate: Bearer`); env unset ⇒ **503**, like an unconfigured webhook source.
- Scopes `watch:read`, `watch:write`; every tool declares one and the handler checks it (a second
  consumer with read-only scope must be a config change, not a code change).
- **Principal = the `owner` row of `watch_accounts`** (D-07), written by the `watch` sync from ADR-029
  `PlexReadClient.getOwnerAccount()` (`id` arrives as a string, stored as bigint). No plex.tv call happens on the request path. No owner row yet ⇒ every tool
  answers "Watch history isn't ready yet." (not an MCP error).
- Tool inputs are `.strict()` objects; no tool accepts an account or user id.

### D-04 — Exposure: ingress exclusion, the hop, the network policy (haynes-ops)

- All three haynesnetwork IngressRoute rules (`haynesnetwork.com` and the `www` redirect on
  traefik-external, `haynesnetwork.haynesops.com` on traefik-internal) gain
  `&& !PathPrefix(`/api/mcp`)`, so no route matches and Traefik answers 404. Neither Traefik has
  entrypoint-level middlewares, and the external access log keeps the request path, which is why the
  token must never ride a query string.
- `frontend/haynesnetwork-mcp-hop`: a copy of `home-automation/cigar-mcp-hop` (nginx-unprivileged,
  read-only root, envsubst pinned by `NGINX_ENVSUBST_FILTER=^HNET_MCP_HOP_TOKEN$`, Flux substitution
  disabled on the template and the HelmRelease). `location /mcp` → `proxy_pass
  http://haynesnetwork.frontend.svc.cluster.local:3000/api/mcp`, `proxy_set_header Authorization
  "Bearer ${HNET_MCP_HOP_TOKEN}"`, `proxy_buffering off`, `proxy_read_timeout 30s`. `/healthz` for
  probes. No ingress, no Gatus (as with the cigar hop).
- CiliumNetworkPolicy on the hop pods: ingress **only** from the Home Assistant pod
  (`home-automation`, its app label), the dev-env pod (`dev`, its app label) and the `host` entity
  (kubelet probes), TCP 8080.
- The token: an External Secrets `Password` generator (48 characters, letters and digits) feeding an
  ExternalSecret with `refreshInterval: "0"` in the haynesnetwork app, target Secret
  `haynesnetwork-mcp-consumer`, key `HOP_TOKEN`. The web controller reads it as
  `HNET_MCP_HOP_TOKEN` (`optional: true`, so a missing Secret degrades to 503, never a crash loop);
  the hop reads the same key. Reloader on both.

### D-05 — The tool contract and the Voice Budget

| Tool | Scope | Description (as served) | Parameters (all optional unless noted) |
|---|---|---|---|
| `unfinished` | read | Shows (or movies) the user started but hasn't finished, most recent first, with the next episode. | `kind`: `show`\|`movie`\|`any` (default `show`); `limit` 1–10 (5); `kids` boolean (false) |
| `recommend` | read | Titles the user has never watched, best first, each with a short reason; titles on Plex first. | `kind` (default `any`); `genre` string (e.g. "sci-fi"); `limit` 1–10 (5); `offset` ≥0 (0) for more; `kids` boolean |
| `watch_status` | read | Whether the user has seen a title, how far along he is, and whether it is on Plex. | `title` string (**required**); `kind` `show`\|`movie` |
| `recent_history` | read | What the user watched recently. | `days` 1–365 (14); `limit` 1–20 (8) |
| `mark_watched` | write | Record that the user already watched a title and mark it watched in Plex: the whole show unless a season or episode is given; through=true marks everything up to that episode. | `title` (**required**); `kind`; `season` ≥1; `episode` ≥1; `through` boolean |
| `dismiss` | write | Stop suggesting a title: reason not_interested (default) or not_mine (someone else watched it on this account). Never changes Plex. | `title` (**required**); `reason` `not_interested`\|`not_mine` |
| `undo_last_change` | write | Undo the user's last mark_watched or dismiss from the past day. | none |

Schema rules (Home Assistant converts schemas and fails the whole entry on one it cannot convert;
OpenAI strips top-level `oneOf/anyOf/allOf/enum/not`): flat objects, primitive properties,
property-level `enum` only, no `default`, no `nullable`, no unions, no `$ref`. Defaults are applied in
the handler.

Every Home Assistant tool call is four POSTs: `initialize`, `notifications/initialized`,
`tools/call`, then `tools/list` (the client refreshes its tool list on each new session). So the list is
paid on every call and must be static and cheap. If that trailing `tools/list` fails after a
successful `mark_watched`, HA reports a failure for a change that happened: one more reason marks
must be idempotent (D-14).

**Voice Budget (T-253), enforced by `@hnet/mcp` tests:** the serialized `tools/list` result is at
most **3,072 bytes**; a default call to each read tool over the seeded fixture returns at most
**1,200 characters**; no result carries `structuredContent`. The v1 SDK adds about 89 bytes per tool (a `$schema`
URL on each input schema and `execution: {taskSupport}`); if the generated list is over budget, serve
`tools/list` from hand-written JSON Schemas through the low-level request handler instead of
trimming descriptions. Integer parameters use `.int().min().max()` (a bare `.int()` emits ±2^53
bounds, 73 bytes), and schemas avoid `z.email()`, `z.tuple()`, `z.date()` and `z.bigint()`: Home
Assistant's converter rejects the first two and the SDK cannot serialize the last two.

### D-06 — Logging and errors

- One line per call: `[mcp] tool_called {"tool","consumer","ms","ok","chars"}`; failures add
  `"code"`. Arguments and results are never logged (they are the owner's viewing history).
- Tool-level problems (not found, ambiguous, nothing unfinished, not ready) are normal text results,
  not `isError`, so the voice model can say them. `isError` is reserved for unexpected failures,
  with the text "Watch history hit an error. Try again in a minute."
- A request that takes over 2 s logs `slow_call` with the phase (resolve, revalidate, plex_write).

### D-07 — Tables (migration 0077)

`watch_accounts` — the tracked Plex accounts.

| Column | Type | Notes |
|---|---|---|
| `plex_account_id` | bigint PK | plex.tv numeric id = Tautulli `user_id` (owner 12874060) |
| `username` | text not null | |
| `role` | text not null | CHECK `owner`\|`household`; partial unique index: one `owner` |
| `app_user_id` | FK `users.id` null | the app user with the owner's email, for attribution |
| `tracked` | boolean not null default true | |
| `resolved_at`, `created_at`, `updated_at` | timestamptz | |

`watch_events` — the append-only Watch Event log (T-243).

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `plex_account_id` | bigint FK | |
| `instance` | text | CHECK `haynesops`\|`hayneskube`\|`haynestower` |
| `tautulli_row_id` | bigint | UNIQUE (`instance`, `tautulli_row_id`) |
| `kind` | text | CHECK `movie`\|`episode` (tracks and clips are skipped) |
| `item_guid`, `show_guid` | text null | `plex://…`; `show_guid` from `get_metadata` on the grandparent key, null when gone |
| `title`, `show_title` | text | episode or movie title; show title for episodes |
| `season`, `episode`, `year` | int null | |
| `rating_key`, `grandparent_rating_key` | text null | server-local and perishable; never used as identity |
| `started_at` | timestamptz not null | |
| `stopped_at` | timestamptz null | |
| `percent_complete` | smallint null | |
| `watched` | boolean not null | Tautulli `watched_status = 1` |
| `ingested_at` | timestamptz not null default now() | |

Indexes: (`plex_account_id`, `started_at` desc), (`plex_account_id`, `show_guid`).

`watch_titles` — the Title State snapshot (T-244). UNIQUE (`plex_account_id`, `title_key`).

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `plex_account_id`, `kind` | | `kind` CHECK `show`\|`movie` |
| `title_key` | text not null | identity (D-08) |
| `plex_guid`, `tmdb_id`, `tvdb_id`, `imdb_id` | | whatever is known |
| `media_item_id` | FK `media_items` null | ledger link when the *arrs manage it |
| `title`, `year`, `genres` (jsonb `string[]`, like `media_metadata.genres`), `content_rating`, `is_kids` | | |
| `on_plex` | jsonb not null default `[]` | `[{server, ratingKey, local}]` where it exists now |
| `plex_counts` | jsonb not null default `{}` | `{server: {leafCount, viewedLeafCount, lastViewedAt}}` for change detection |
| `episode_map` | jsonb null | shows: `{"<season>": [[episode, watched 0/1, lastViewedAt s or 0, {server: ratingKey}]]}`, seasons ≥1 |
| `episodes_total`, `episodes_watched` | int null | shows, specials excluded |
| `furthest_season`, `furthest_episode`, `next_season`, `next_episode` | int null | |
| `next_title`, `next_server`, `next_rating_key` | text null | |
| `next_resume` | boolean not null default false | the next episode has a resume point |
| `resume_percent` | smallint null | movies |
| `plex_watched` | boolean not null default false | movie watched / show fully watched in Plex now |
| `plex_last_viewed_at` | timestamptz null | |
| `event_plays`, `event_watched_episodes` | int not null default 0 | |
| `first_watched_at`, `last_watched_at` | timestamptz null | Plex ∪ events |
| `rewatch` | boolean not null default false | |
| `show_status` | text null | `continuing`\|`ended` from the ledger, else null |
| `refreshed_at` | timestamptz not null | |

`watch_marks` — Watch Marks (T-248).

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `plex_account_id` | bigint FK | |
| `action` | text | CHECK `watched`\|`not_interested`\|`not_mine` |
| `scope` | text | CHECK `movie`\|`show`\|`season`\|`episode`\|`through` |
| `title_key`, `kind`, `title`, `year`, `plex_guid`, `tmdb_id`, `tvdb_id`, `imdb_id` | | the resolved identity |
| `season`, `episode` | int null | |
| `query` | text not null | what was asked, trimmed to 200 characters |
| `consumer` | text not null | `hop`, later `web` |
| `actor_user_id` | FK `users.id` null | |
| `flipped` | jsonb not null default `[]` | `[{server, ratingKey}]` actually changed in Plex |
| `plex_result` | text | CHECK `pending`\|`written`\|`partial`\|`not_on_plex`\|`failed`\|`none` |
| `plex_error` | text null | first error, trimmed |
| `created_at` | timestamptz not null | index (`plex_account_id`, `created_at` desc) |
| `reverted_at` | timestamptz null | |
| `revert_result` | text null | `written`\|`partial`\|`failed`\|`none` |

`watch_reco_signals` — the recommendation input cache (ADR-089).

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `plex_account_id` | bigint FK | |
| `source` | text | CHECK `watchlist`\|`tmdb_seed` |
| `kind`, `title`, `year`, `tmdb_id`, `tvdb_id`, `imdb_id`, `plex_guid` | | |
| `seed_title_key`, `seed_title` | text null | `tmdb_seed` only |
| `rank` | smallint | position in the source list |
| `added_at` | timestamptz null | watchlist add time |
| `fetched_at` | timestamptz not null | |

Each run replaces a source's rows for the account in one transaction.

All five tables join `packages/domain/__tests__/no-direct-state-writes.test.ts` (snake_case names in
the SQL families, camelCase schema identifiers in the Drizzle families; `watch_reco_signals` and
`watch_titles` also in DELETE). `users.id` and `media_items.id` are **uuid** (this design first said
`users.id` was text; the schema has always been uuid — corrected in PLAN-068 S2), so `app_user_id`,
`actor_user_id` and `media_item_id` are uuid. The same migration drops and re-adds
`sync_runs_run_kind_enum` with `watch` added, and the journal entry is idx 76 with a `when` above
1783903301000 (the journal test requires strictly increasing values); it landed as `when`
1783903302000.

As built (migration 0077, PLAN-068 S2): every enumerated column is text + CHECK from an `enums.ts` const
array, including the nullable ones this table leaves implicit — `watch_titles.show_status`,
`watch_titles.next_server` and `watch_marks.revert_result` admit NULL or a listed value, and
`watch_marks.kind` / `watch_reco_signals.kind` are `show`|`movie`. `watch_events.instance` and
`next_server` reuse `PLEX_SERVER_SLUGS`. `watch_marks.consumer` is deliberately unconstrained (a new
consumer is a config change, D-03). Rows owned by an account `ON DELETE CASCADE` from `watch_accounts`;
the user FKs and `media_item_id` are `ON DELETE SET NULL`. `resolved_at`, `refreshed_at` and
`fetched_at` default to `now()`. Until the `watch` mode exists (S6), `runSync` refuses `--mode=watch`
rather than fall through to the per-source *arr loop.

### D-08 — Title identity (`title_key`)

In order of preference: `plex:<plex guid>` (a `plex://show/…` or `plex://movie/…` guid, identical on
every server); `tvdb:<id>` (shows) or `tmdb:movie:<id>`; `imdb:<id>`; last `name:<normalized
title>|<year>`. When a later run learns a stronger key for an existing row (for example an event-only
title that reappears on Plex), the writer re-keys the row in place so marks keep pointing at it
(marks also carry the ids, D-13). Unmatched `local://` items never produce a `plex:` key; they match
by external ids, then by normalized title and year.

### D-09 — The `watch` sync mode

CronJob `sync-watch`, schedule `3,18,33,48 * * * *` (minutes free of the other sync jobs), same image,
env and resources pattern as `sync-plex-match`. Steps, each isolated so one source's failure keeps
the others' results (per-source degradation, the DESIGN-008 posture):

1. **Owner.** `getOwnerAccount()` against HaynesOps, falling back to HaynesTower → upsert the `owner`
   row (app user by email). Failure with a stored owner ⇒ continue; with none ⇒ `totalFailure`.
2. **Events.** For each configured Tautulli instance: window start = the newest stored `started_at`
   for (instance, owner) minus 3 days, or no window on the first run. Page `get_history`
   (`user_id`, `grouping=0`, `length=500`, the `after` date filter, newest first) and
   insert-or-ignore on (instance, row id). The row id is Tautulli's **`row_id`** (verified live
   2026-09-23 on all three instances: under `grouping=0` it is unique per row and `id` mirrors it, while
   `reference_id` names the first row of a group and repeats — HaynesTower row 42195 has reference
   41839). `after` filters by day (`after=2099-01-01` returns nothing); movies send `""` for the
   episode indices. Movies and episodes only. For a new episode whose show guid is unknown, look it
   up once per (instance, grandparent key): first in stored events, then `get_metadata`; a 400 means
   the show is gone (null guid, fall back to the show title). Page cap 200 per instance per run.
3. **Plex progress** on each server with movie or show sections (HaynesOps and HaynesTower today;
   decided from `/library/sections`, never hard-coded):
   - shows: one section listing (`type=2`, `includeGuids=1`) gives `leafCount`, `viewedLeafCount`,
     `lastViewedAt`, guids, genres and content rating;
   - re-read `allLeaves` only for shows whose counts differ from `plex_counts[server]`, or that have
     `viewedLeafCount > 0` and no stored episode map for that server;
   - movies: the watched listing and the in-progress listing of each movie section (Plex filters
     `unwatched=0` and `inProgress=1`, both verified live in PLAN-068 S3: on HaynesOps' 5,273 movies
     `unwatched=0` returns the 310 with `viewCount ≥ 1` and `unwatched=1` the other 4,963; `inProgress=1`
     returns the items with a `viewOffset` — 97 on HaynesTower, none on HaynesOps). The filters are for
     movies only: on a show section `unwatched=0` means *fully* watched shows, so show progress always
     comes from the plain listing above.
4. **Assemble** Title States with the pure D-10 function: merge across servers by `title_key`, attach
   event facts, ledger links (`media_items` by guid or external id), genres, `show_status`.
5. **Write** through the domain writer: upsert changed rows only; never delete. A title gone from
   Plex keeps its event facts with `on_plex = []`.
6. **Watchlist**: the owner's plex.tv watchlist (discover provider, owner token), replacing
   `source = watchlist`. Verified live 2026-09-23: 151 titles; the provider rejects a page over 100
   (HTTP 400), so it is read in pages of 100; the default order is `watchlistedAt:desc` (the client asks
   for it explicitly), and list items carry no watchlist timestamp (`addedAt` is the catalog date), so
   `rank` is the order and `added_at` stays null (the per-item `userState` endpoint has
   `watchlistedAt`; one call per title is not worth it in v1).
7. **TMDB seeds** when the stored seeds are older than 20 hours (D-17).

Report: `{ owner, events: {instance: inserted}, shows: {listed, reread}, movies, titles: {upserted},
watchlist, seeds, errors[] }`. First run backfills the owner's full history (about 5,300 rows on
HaynesTower, 11 pages) and reads `allLeaves` for about 180 shows; steady state is a handful of
requests.

### D-10 — Progress math (pure, in `@hnet/watch`)

Input per show: each holding server's episodes `{season, episode, ratingKey, watched (viewCount>0),
lastViewedAt, viewOffset}`, plus the title's events and marks.

- **Universe** U = the union over servers of `(season, episode)` with season ≥ 1. A pair is watched if
  watched on any server (view-state sync makes them agree; the union covers unmatched items).
- `episodes_total = |U|`, `episodes_watched` = watched pairs in U.
- **Furthest** = the greatest watched pair (season, then episode). **Next** = the smallest unwatched
  pair greater than furthest; if nothing is watched but an episode has a resume point, next is that
  episode (`next_resume = true`). The next episode's server is HaynesOps when it holds it.
- **Rewatch** when the event log has more than `episodes_watched + 2` distinct watched episodes.
- `last_watched_at` = the newest of Plex `lastViewedAt` and event `stopped_at`.
- **Children's title** (`is_kids`): content rating `TV-Y`, `TV-Y7`, `TV-Y7-FV`, or a `Kids`/`Children`
  genre; movies also when both `Animation` and `Family` are present.
- **Movies**: `plex_watched` = any server `viewCount > 0`; `resume_percent` from the server with the
  newest `lastViewedAt` (resume points are not synced).

State is computed at read time (it depends on now):

| State | Rule |
|---|---|
| `in_progress` | next exists and `last_watched_at` within 90 days |
| `stalled` | next exists and older than 90 days |
| `caught_up` | watched > 0, no next, `show_status` ≠ `ended` |
| `finished` | watched > 0, no next, `show_status` = `ended` |
| `taster` | watched ≤ 2, under 10% of total, older than 30 days (overrides in_progress/stalled) |
| `unstarted` | nothing watched, no resume point |

Movies: `in_progress` when 5 ≤ `resume_percent` ≤ 90 within 90 days, `stalled` when older.

**Unfinished** (T-245) = shows in `in_progress` or `stalled`, not dismissed, not children's unless
`kids`; ordered in_progress first, then by `last_watched_at` desc.

**Ever Watched** (T-247) for a title = `episodes_watched > 0` or `plex_watched` or `event_plays > 0`
with a watched event or a live `watched` mark; a live `not_mine` mark removes it.

### D-11 — Live revalidation of an answer

`unfinished` and `watch_status` revalidate the shows they are about to report: one
`/library/metadata/<ratingKey>` read per title on its preferred server, in parallel, 300 ms per
request and 400 ms overall. A title whose counts moved gets its `allLeaves` re-read inside the same
budget and written through (`revalidateTitles` in the domain), and the answer is recomputed. On
timeout the snapshot answers and `revalidate_timeout` is logged. `recommend` does not revalidate
(ever-watched moves slowly and marks write through).

### D-12 — Watch Marks

`markWatched`, `dismissTitle` and `undoLastChange` live in `@hnet/domain`, each one transaction
around its database rows, with Plex calls outside the transaction (D-14).

### D-13 — Resolving a spoken title

- **Normalize**: NFKD, strip diacritics, lower-case, `&` → `and`, drop punctuation, drop a leading
  "the", "a" or "an", collapse spaces. A four-digit year (1900–2099) at the end or in parentheses
  becomes a year hint.
- **Pool**: the owner's `watch_titles`, the live ledger (`media_items` for Sonarr and Radarr, not
  tombstoned), and `watch_reco_signals`, filtered by `kind` when given.
- **Score**: 1.0 exact; 0.95 exact once a trailing country or year tag is dropped ("the office us");
  0.85 when one is a prefix of the other and the shorter is at least 60% of the longer; otherwise
  Jaro-Winkler × 0.9 when at least 0.9. Plus 0.05 when the title is in the owner's history and 0.05
  when the year hint matches.
- **Decide**: resolved when the best is at least 0.9 and no *different* title scores within 0.05 of
  it; ambiguous when the best is at least 0.6 (return up to three candidates as "Title (year, kind)");
  otherwise one TMDB `search/multi` call, accepted only on an exact normalized title match (the title
  is then "not on Plex"); else not found.
- Ambiguous and not-found never write.

### D-14 — `mark_watched` flow

1. Resolve (D-13). A show without season/episode ⇒ scope `show`; with `season` only ⇒ `season`;
   with both ⇒ `episode`, or `through` when `through` is true.
2. Holding servers: from `on_plex`, else the ledger's `media_plex_matches`, else a live
   `/library/all?guid=` lookup. Preferred = HaynesOps if it holds the title, else HaynesTower.
3. Before-state: live `allLeaves` (show) or metadata (movie) on the preferred server, and on every
   other holding server whose item is `local://` (no view-state sync for those).
4. Insert the mark with `plex_result = 'pending'` and the planned keys.
5. Writes (`/:/scrobble?identifier=com.plexapp.plugins.library&key=<ratingKey>`): whole show ⇒ the
   show key once; season ⇒ the season key; episode ⇒ the episode key; through (S, E) ⇒ the season
   key for each earlier season that has unwatched episodes plus each unwatched episode ≤ E in season
   S (at most 6 concurrent); movie ⇒ the movie key. `flipped` = the episodes (or the movie) that were
   unwatched before.
6. Finalize the mark (`written`, `partial`, `failed`, or `not_on_plex` with no writes) and write the
   Title State through by applying the flips to the snapshot (no second read).
7. **Replay:** the same mark (title, scope, season, episode) repeated within 10 minutes that would
   flip nothing answers like the first and inserts no row, so a retried call never becomes the
   "last change" that `undo_last_change` would pick.
8. Say it back: *"Marked Severance (2022) as watched in Plex, all 19 episodes."* or *"Noted Dark
   Matter (2024) as watched. It isn't on Plex, so only your history changed."* Budget: 3 s end to end
   (Home Assistant allows 10 s per call including connect).

### D-15 — `dismiss` and `undo_last_change`

- `dismiss` records `not_interested` (never suggested again, dropped from Unfinished) or `not_mine`
  (removed from Ever Watched, the Taste Profile and Unfinished). No Plex call, ever: the children
  watch on the owner account.
- `undo_last_change` reverts the owner's newest unreverted mark from the last 24 hours. For a
  `watched` mark it unscrobbles exactly `flipped`, collapsing to the show or season key when
  `flipped` covers all of it, and writes the Title State through. It answers what it undid; with
  nothing to undo it says so. Plex's unscrobble clears resume points, so an episode that was half
  watched comes back unwatched from the start (ADR-088 C-04).

### D-16 — Taste Profile

For each Ever Watched, non-children's title with genres (ledger first, then Plex): weight =
`0.5 ^ (months since last watched / 12)` × completion (shows: `episodes_watched / episodes_total`,
at least 0.25 once three episodes are watched; movies: 1). Each genre of the title gets
`weight / number of genres`; the vector is normalized to sum 1. `not_mine` titles are left out; a
`not_interested` title subtracts half its weight from its genres (floored at 0). A second profile is
built from children's titles for `kids=true`.

### D-17 — Candidates

- **Library**: Sonarr and Radarr ledger items that are on Plex (`media_plex_matches`), not
  tombstoned, with `media_metadata` genres and ratings. SQL pre-filter: kind, genre overlap, not
  children's unless `kids`, anti-join on the owner's Ever Watched and started titles and on
  `not_interested`/`not_mine` marks, ordered by rating, limit 600; scoring happens in TypeScript.
- **Watchlist**: `watch_reco_signals` `watchlist`, matched to the ledger or Plex when possible.
- **TMDB seeds**: once a day the sync picks up to 15 seeds, the owner's most recent non-children's
  titles that are finished, caught up, or have at least 30% of their episodes watched, and stores
  page one of `/3/{tv|movie}/{id}/recommendations` for each.

### D-18 — Exclusions (applied last, in code)

Drop any candidate that is Ever Watched, currently started (a show with `episodes_watched > 0` or a
movie with a resume point: those belong to Unfinished), dismissed (`not_interested` or `not_mine`),
or a children's title when `kids` is false (and a grown-up title when `kids` is true). The property
test in AC-21 exercises exactly this function.

### D-19 — Score and reason

`score = 0.45 × affinity + 0.30 × quality + boosts`, where affinity is the sum of the profile weights of
the candidate's genres divided by the sum of the profile's top three weights (capped at 1), quality
is the mean of the available ratings scaled to 0–1 (IMDb and TMDB ÷ 10, Rotten Tomatoes ÷ 100;
0.6 when none), and boosts are +0.35 for the watchlist, +0.3 × min(1, seeds ÷ 3) for TMDB seed
agreement, and +0.1 when added to Plex in the last 21 days. Ties break on quality, then title.

Reason, first that applies: "on your watchlist"; "because you watched <the most recent seed>";
"<genre> like <the owner's most-watched title sharing it>"; "rated <x> on IMDb"; "new on Plex".

### D-20 — `recommend` output

Up to `limit` on-Plex picks after skipping `offset`, then at most two not-on-Plex picks under "Not on
Plex yet". Each pick: title, year, show or movie, the reason. When nothing survives: "Nothing new
matches that. Try another genre or kind."

### D-21 — Spoken output style

Plain sentences only: no markdown, bullets, emoji or URLs. Lead with the count ("Four unfinished
shows."). Name episodes as "season 3 episode 1". Dates as "today", "yesterday", "on September 12"
this year, "in March 2025" otherwise. At most `limit` items, then "and N more". Hard cap 1,200
characters, cut at a sentence boundary. Examples:

- `unfinished`: *"Three unfinished shows. Silo: 30 of 40 watched, next is season 3 episode 1, last
  watched on September 20. For All Mankind: next is season 5 episode 3, on September 12. Stalled:
  The Righteous Gemstones, 36 of 45, untouched since March 2025."* (Dates swapped in S4: the first
  draft listed the older show first, against the D-10 order.)
- `recommend`: *"Five picks on Plex. Foundation, a 2021 show, because you watched The Expanse.
  Severance, a 2022 show, on your watchlist. … Not on Plex yet: Dark Matter, a 2024 show, on your
  watchlist."*
- `watch_status`: *"The Expanse (2015 show): all 62 episodes watched, finished in March 2025. On
  Plex."*
- `recent_history`: *"In the last two weeks: Silo, 5 episodes, latest season 2 episode 10 on September
  20. WarGames, a movie, on September 5."*
- ambiguous: *"More than one match for Dune: Dune (2021, movie), Dune (1984, movie), Dune: Prophecy
  (2024, show). Which one?"*

### D-22 — Home Assistant (hass-sandbox owns the record)

1. An `mcp` config entry with URL `http://haynesnetwork-mcp-hop.frontend.svc.cluster.local:8080/mcp`
   (no auth). Its title comes from `serverInfo.name`, "Watch history" (D-02).
2. The Movie Room agent (`conversation.chatgpt_5`, OpenAI entry `01JK456T3JV6CPBG2ZQ2FS10GE`,
   subentry `01JZ8DWMCRND9599AR8EFJVN0A`) gets `llm_hass_api: ["assist", "mcp-<entry id>"]` and a
   WATCH HISTORY block appended to its prompt (text kept in hass-sandbox
   `agent-docs/voice-agent-prompts.md`). No other agent gets the API.
3. Bench before and after with hass-sandbox `scripts/voice-bench` in text mode as the Movie Room
   satellite, read-only questions only (a mark would write to Plex). Pass: at most 0.5 s median
   added latency on questions that use no watch tool (R-245).
4. Rollback: remove the API from the subentry (prompt restored from the backup); the entry can stay.

### D-23 — dev-env

`kubernetes/main/apps/dev/dev-env/app/resources/config/claude/mcp.json` gains
`"haynesnetwork": {"type": "http", "url": "http://haynesnetwork-mcp-hop.frontend.svc.cluster.local:8080/mcp"}`
(no header: the hop injects it), and the dev-env CiliumNetworkPolicy
(`kubernetes/main/apps/dev/dev-env/app/networkpolicy.yaml`) allows that name on TCP 8080. The policy
is not under `resources/**`, so it merges like any change and lets agents in the pod reach the hop
with curl right away. The `mcp.json` edit is under `resources/**`, bounces the pod, and is therefore a
held draft for the owner to merge at a natural break.

### D-24 — Deployment (haynes-ops)

1. haynesnetwork app: the `Password` generator, the `haynesnetwork-mcp-consumer` ExternalSecret, the
   web env `HNET_MCP_HOP_TOKEN`, the `sync-watch` CronJob, the image tag, and the IngressRoute
   exclusions.
2. New app `frontend/haynesnetwork-mcp-hop` (ks `dependsOn` the haynesnetwork ks for the Secret).
3. dev-env: the CiliumNetworkPolicy egress rule (normal PR) and the `mcp.json` entry (held draft), D-23.
4. The hop's CiliumNetworkPolicy admits the dev-env pod from the start, so the order of 3 does not
   matter for the hop.

### D-25 — Pure-math rulings made while building `@hnet/watch` (PLAN-068 S4)

Where D-08..D-21 left a case open or two sections disagreed, S4 decided as below. The package README
lists the final signatures; the tests pin each row.

| Section | Ruling |
|---|---|
| D-08 | A show known only by its TMDB id keys as `tmdb:show:<id>`, after `imdb:` (D-08 named TMDB for movies only). A TVDB id counts for shows only. `identityKeys` always adds the `name:` key; `name:` keys carry no kind, so a watched movie also excludes a same-name, same-year show (errs toward leaving a pick out). Grouping by keys is kind-scoped. |
| D-10 | Season-0 events are ignored like specials (plays, rewatch, dates). An event without `stopped_at` counts at `started_at`. With nothing watched and several started episodes, next is the one viewed most recently. Next is served from HaynesOps, then HaynesTower, then HaynesKube. "Within 90 days" includes exactly 90; a Taster is untouched for more than 30. An unknown last-watched time counts as old. A movie outside the 5–90% band is `finished` when watched in Plex, else `unstarted`; a `lastViewedAt` tie between servers goes to the one with a resume point. |
| D-13 | A bare trailing year becomes the hint but stays in the normalized title ("Blade Runner 2049"); the 0.95 rule matches the year-less form. The 0.95 rule drops ONE side's tag; two different tags ("office us", "office uk") never match there. Country tags leave out the English words "it", "in", "no", "be". Pool entries that share an identity key are one title (a Title State, its ledger item and its watchlist row are not rivals); the history bonus is per title; bonuses never lift a zero match. A margin of exactly 0.05 resolves, so the year and history bonuses each break an exact tie. Options list newer years first on a tie. |
| D-16 | "Once three episodes are watched" counts the event log too, and a show gone from Plex (`episodes_total` 0) weighs 0.25 once three episodes are in the log — otherwise shows Maintainerr deleted after he finished them, the strongest signals, would weigh nothing. A title without a last-watched time weighs 0. Genres are folded onto canonical names first; compound source genres split ("Sci-Fi & Fantasy"). |
| D-18 | A show whose next episode is started (a resume-only start, which D-10 counts as Unfinished) is "started" too. Exclusion is per title: Title States and marks that share a key form one title whose every key joins the set, and a candidate goes when any candidate sharing a key with it is excluded. A title is children's when any source says so or its sources' genres together do. |
| D-19 | Every pick has a reason (AC-21): after "new on Plex" comes "new to you". `<genre> like <title>` names the requested genre, else the owner's strongest shared genre with drama last (nearly every show carries it); kids read "for kids, like Bluey". A rating of 0 is missing (TMDB reports 0 when unrated). Final tie-break after title is the title key. Candidates from the library, the watchlist and the seeds merge into one before scoring. |
| D-20 | The not-on-Plex picks page two at a time with `offset` (page = ⌊offset ÷ limit⌋), so "more" never repeats them. Past the end: "No more picks. Try another genre or kind." |
| D-21 | Dates use the owner's time zone (America/New_York by default). "And N more." is its own sentence. Only the first in-progress show carries its counts, as in the example; relative dates keep "last watched" ("last watched yesterday"). A started next episode reads "resume season 3 episode 7"; a rewatch reads "(rewatch)". Titles lose markdown characters, emoji and URLs (`M*A*S*H` → `MASH`). The cut never splits a title like "Mr. Robot". |

## Alternatives considered

- **A standalone media MCP server** (hass-sandbox 2026-09-22 proposal) and **a separate MCP process**:
  ADR-087 options 5 and 2.
- **Answering from Plex live** or **from Tautulli alone**: ADR-088 options 2 and 3.
- **The model recommends and checks titles one by one**: ADR-089 option 1.
- **Reusing `user_media_watch`**: ADR-088 option 1.
- **Precomputing recommendations per run**: rejected; scoring over cached inputs is cheap, and
  precomputed lists would lag a mark by up to 15 minutes.

## Test strategy

- `@hnet/watch` (unit): the D-10 math over fixtures (specials ignored; union across servers; next after
  furthest; resume-only start; rewatch; taster; children's flag; each state); resolver cases (exact,
  country tag, prefix, ambiguity between two Dunes, year hint, kind filter); Taste Profile weighting;
  D-18 exclusions as a property test over generated histories (AC-21); scoring determinism;
  formatter caps and sentence-boundary cuts.
- `@hnet/domain` (embedded Postgres): event insert-or-ignore; Title State upsert and re-keying; the
  mark flows with a recording fake Plex writer (show, season, episode, through, movie, not on Plex,
  partial failure); undo reverses exactly `flipped`; the guard list.
- `@hnet/sync`: the `watch` mode against stub Tautulli and stub Plex (window paging, 400 → gone,
  per-source degradation, change-detected `allLeaves` re-reads, watchlist replace, seed refresh
  cadence).
- `@hnet/mcp`: the SDK client end to end against the handler with a seeded database: initialize
  (no session id), `tools/list` ≤ 3,072 bytes, each tool's happy path and budget, 401/503/405,
  scope checks, strict inputs.
- `apps/web`: the route adapter test (mocks `@hnet/mcp`, like the webhook route test).
- `@hnet/arr`: an error-message test proving `apikey`/`api_key`/`token`/`X-Plex-Token` values never appear in `ArrHttpError`,
  `ArrTimeoutError` or `ArrParseError` messages.
- Stubs: `apps/web/e2e/support/stub-plex.ts` gains the watch fields, `allLeaves`, `/:/scrobble` and
  `/:/unscrobble` (recorded in `calls`); `stub-tautulli.ts` gains `user_id`, row ids, episode indices and
  `percent_complete`, and is wired into the stack env. As built (PLAN-068 S3): the stub Plex keeps the
  owner's watch state in an in-memory map every read overlays (a scrobble round-trips), also serves
  `/library/all?guid=`, the section filters and the discover watchlist (`PLEX_DISCOVER_URL`), and adds
  its dataset only to the seeded sections; the stub Tautulli serves all three instances (told apart by
  key) and deliberately does not serve `get_libraries_table`, so the Home play scoreboard stays hidden
  in the stack as before.
- Live (PLAN-068): the HA bench and the three US-13 questions (AC-24).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Household persons by spoken name. | PRD Q-12 — open; v1 owner only. |
| Q-02 | Seerr requests by voice. | PRD Q-13 — open. |
| Q-03 | Public connectors (OAuth). | PRD Q-14 — deferred. |
| Q-04 | Should the HaynesOps Tautulli webhook trigger an immediate Title State refresh? | Open; D-11 covers answers, so only worth it if the bench shows stale answers. |
| Q-05 | D-21's ambiguous example offers Dune: Prophecy for "Dune", but D-13 scores it 0: a 4-of-13-character prefix is under the 60% rule and its Jaro-Winkler (0.86) is under 0.9. D-13's 0.6 floor never binds either, since the lowest nonzero score is 0.81. Should a whole-word prefix score about 0.7, so it is offered as an option but can never resolve alone (0.7 plus both bonuses is 0.8)? | Open; S4 follows D-13, so "Dune" offers only the two Dune films. |
