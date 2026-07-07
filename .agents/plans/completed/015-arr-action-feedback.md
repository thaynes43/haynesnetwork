# PLAN-015: Downstream *arr action feedback (live status)

- **Status:** Completed (2026-07-07) — shipped v0.15.0; live-validated 6/6 on staging against
  real Radarr/Sonarr: Force Search shows live searching→nothing_found (15-min window) with
  wire-ack; the anti-mashing lock replaces Fix/Force-Search with a live chip producing 0 duplicate
  *arr commands on mash (ADR-015 no reflow); subtitle Fix rests reassuringly (Bazarr, no poll);
  season roll-up cascades per-episode phases; My Fixes live rows; polling bounded + stops on
  terminal; UI phase matched the real *arr queue on every cross-check.
- **Reconciled identifiers (2026-07-07):** the plan's NEXT-FREE-AT-AUTHORING placeholders
  (ADR-025, DESIGN-005 D-20/D-21, T-75..T-78, R-88/R-89) were consumed by plans that landed
  first. Actual numbers taken: **ADR-028**, **DESIGN-005 D-20/D-21** (D-19 was the ceiling),
  **glossary T-90..T-93** (T-89 ceiling), **PRD R-106/R-107** (R-105 ceiling). No migration.
- **Satisfies:** PRD-001 new **R-88/R-89** (+ dated notes under R-43/R-46/R-47), new **ADR-025**
  (the feedback / on-demand-polling model), DESIGN-005 new **D-20**/**D-21** (+ a `/queue` row on
  the D-03 endpoint inventory, line 122), DDD new **T-75..T-78**.
  > **All identifiers above are NEXT-FREE-AT-AUTHORING placeholders, not reservations**
  > (`.agents/plans/README.md` reconciliation, lines 71–104). Ceilings on `main` @ v0.11.0 are
  > **ADR-024, DESIGN-010, migration 0016, PRD R-87, glossary T-74** — but plans **012 / 011 /
  > 009 / 010** run ahead of 015 in the owner-ordered sequence and will consume ADR/DESIGN/R/T/
  > migration numbers above those ceilings first. **Re-grep `docs/adrs/`, `docs/designs/`, the PRD,
  > the glossary, and `packages/db/migrations/` at authoring time** and take the next free number in
  > queue order. The D-NNs are appended to DESIGN-005 (it owns the Fix/Force-Search vertical), so
  > they follow D-19 regardless of what other designs land.
- **Depends on:** none hard. The vertical it extends (Fix `fix-flow.ts`, Force Search
  `search-flow.ts`, `fix_requests` + `FIX_STATUSES`, the *arr read clients) is all on `main`
  (shipped by PLAN-002/005). Soft cross-ref: **009 Bulletin** may later surface these phases as
  feed events — noted only, not built here.
- **TODO source:** owner backlog 2026-07-07 (verbatim essence quoted in Goal).
- **Validation:** live Playwright on staging (see Verification) — including a **real fix watched
  through to import**. No separate `015-…-validation.md`.

## Goal

**Owner requirement (2026-07-07, verbatim essence):** *"Users must never click a button that
triggers downstream *arr behavior and then not know if anything happened or how long to wait.
For **Fix**: show queued → (new grab) downloading with progress like Seerr → complete; only then
may they Fix again (no mashing). For **Force Search**: searching → found-something / found-nothing
→ if found, download progress → complete → button re-enabled. Need an ack that proves the request
crossed the wire ("searching") plus a timeout/staleness failure mode when status stops flowing
(never stuck states). The history table records each step fed back to the user (so people can see
what others did). Season/artist/any roll-up cascades status down to every child the interaction
touched. We deliberately expose limited *arr functions with a small blast radius — so we owe users
status back up."*

**Where we are today (the coarse lifecycle already exists):** a Fix moves
`pending → actioned → search_triggered → completed | failed` (`FIX_STATUSES`,
`packages/db/src/schema/enums.ts:76`), transitions written by the domain single-writers
`createFixRequest` / `recordFixAction` (`packages/domain/src/fix-requests.ts:103,254`), completion
matched asynchronously by `completeFixRequests` when the replacement `imported` ledger event is
ingested (`fix-requests.ts:332`, invoked once per sync run at `packages/sync/src/orchestrator.ts:213`
— **cron-driven, no push path**). The one-open-fix-per-target rule (`FixAlreadyOpenError`,
`fix-requests.ts:158-176`, statuses `OPEN_FIX_STATUSES` at `fix-requests.ts:28`) **already blocks a
second open Fix server-side** — the "no mashing" invariant is enforced; the UI just doesn't
**surface** the in-flight state, so a user can click Fix again and land in an error toast instead of
seeing "still working" (`fix-dialog.tsx` has no open-fix guard on the button;
`item-detail.tsx:139-152` renders an always-enabled Fix). Force Search records a `search_requested`
ledger event (`search-flow.ts:94`, `search-requests.ts`) but leaves **no persistent row and has no
open-search dedupe** (verified — `FixAlreadyOpenError` never appears in `search-requests.ts`).

**The missing layer** is everything between `search_triggered` and `completed`: the live grab +
download progress, the "searching…" wire-ack, the found-nothing terminal, and the staleness
timeout. The current UI declares a static end-state and stops: `fix-dialog.tsx:116-127` shows
"a search for a replacement is running… it completes when the new copy imports"; the Force Search
dialog's `done` block says "a fresh search is running" and offers only a **Done** button
(`force-search-dialog.tsx` `done` state) — no polling, no progress, no failure surface. Nothing
tells the user the download is 40% done, or that nothing was found, or that the request stalled.

This plan adds that live layer as a **read-only, poll-on-demand projection** over the *arrs'
download queue + recent history, translated into user-facing **phases**, surfaced beside the
Fix/Force-Search buttons, in the item **History**, and in **My Fixes** — with a bounded blast
radius (no new mutations, no background poller v1).

## Docs-first artifacts to author (same PR as behavior)

### ADR-025 (NEXT-FREE) — Live *arr action feedback via on-demand queue polling; derived phases; no server-side poller v1
`docs/adrs/NNN-arr-action-feedback.md` (copy `docs/adrs/000-template.md`; MADR 3.0; **Fable 5
authors AND ratifies → Status: Accepted**). Decisions of record:

- **Source of truth for live progress = the *arrs' download queue, read-only.** `GET /api/v3/queue`
  (Sonarr, Radarr) / `GET /api/v1/queue` (Lidarr) — records carry `size`/`sizeleft`/`status`/
  `trackedDownloadStatus`/`trackedDownloadState`/`estimatedCompletionTime`/`downloadId`, joined to
  the target by `movieId` (radarr) / `seriesId`+`episodeId` (sonarr) / `artistId`+`albumId`
  (lidarr). No mutation, no new *arr write surface — the D-12/D-18 `@hnet/arr/write` import
  confinement is untouched (queue reads live on the `read.*` side of `ArrClientBundle`,
  `packages/domain/src/arr-clients.ts:23`).
- **Phases are DERIVED, not a new stored enum.** `FIX_STATUSES` is **unchanged** — the richer phase
  `{ queued | searching | grabbed | downloading(pct) | importing | completed | nothing_found |
  stalled | failed }` is computed on demand from `(fix_requests.status | search_requested event) +
  live queue + recent history`. Rationale: the queue is inherently ephemeral and per-poll; baking
  nine phases into the DB CHECK enum + a migration + `completeFixRequests` would fossilize
  transient state and multiply the write surface for no durable gain. (Open decision #5 records the
  alternative; recommendation = derive.)
- **Poll-on-demand, client-driven; NO server-side poller in v1.** A tRPC **query** procedure
  live-reads the queue when the client asks; the browser polls (`refetchInterval`) only while a
  progress surface is mounted and the phase is non-terminal. No cron, no `setInterval`, no
  webhook/SSE. Rationale: smallest blast radius, zero new always-on infra, and the authoritative
  milestones (`grabbed`/`imported`/`download_failed`) already flow into `ledger_events` via the
  sync cron, so History stays correct even when nobody is watching. A background poller (for push
  notifications / Bulletin) is explicitly **future** (see Out of scope + C-0N consequence).
- **Wire-ack = the mutation's own resolution.** `runFixRequest` returns `search_triggered`
  (`fix-flow.ts:318`) and `runForceSearch` returns the accepted `commandName`
  (`search-flow.ts:120`) only **after** the *arr accepts the command — that resolution IS the proof
  the request crossed the wire, so the UI enters the live "searching" phase the instant the
  mutation succeeds.
- **Never-stuck guarantee via two windows.** (a) **Found-nothing:** no `grabbed` event and no queue
  record within the *found-nothing window* after the search → "still watching", then the terminal
  **nothing_found** once the window elapses. (b) **Staleness:** a request older than the *stalled
  threshold* with no queue/history activity, or a queue record with `trackedDownloadStatus:'error'`
  → **stalled**, with a retry affordance. Both windows are Open decisions #2/#3.
- **Roll-up cascade.** A season/artist/show action reports **per-child** phases: the queue records
  keyed by the episode/album ids the run targeted are mapped back to each child; the roll-up's
  headline phase is the least-advanced non-terminal child (Open decision #6 refines the roll-up
  aggregation rule).
- **"No mashing" is already enforced server-side; v1 only surfaces it.** `FixAlreadyOpenError`
  (`fix-requests.ts:173`) blocks a second open Fix; the UI change is to render the in-flight chip +
  disable the Fix button while an open fix targets that child, instead of letting the click error.
  Force Search has no such lock today (Open decision #4 — whether to add one).
- **Consequences C-01..C-0N:** good (the owner's status-back-up contract is met with no new write
  surface, no fossilized enum, no always-on infra); bad (the queue is a new upstream read
  dependency + one more failure surface — mapped via the existing `ArrUpstreamError`/BAD_GATEWAY,
  `packages/domain/src/media-children.ts` `guardArrCall`; found-nothing/stalled are only *observed*
  when someone polls in v1, so an unwatched Force Search's terminal nothing_found isn't persisted
  until a background poller exists); neutral (derived phases mean the DB `FIX_STATUSES` and the live
  phase can momentarily disagree — `completed` derives from a matching import before the cron flips
  the row; documented as a projection).

### DESIGN-005 — new D-20 + D-21 (append after D-19 at line 1013; do NOT renumber D-01..D-19)
`docs/designs/005-arr-ledger-and-fix.md`.

- **D-20 — The action-feedback progress model.** The phase state machine (the nine phases above) and
  its derivation table `(fix status | search event) × queue record × recent history → phase`; the
  `@hnet/arr` queue read client + `queueRecordSchema` (see Client); the two domain projectors
  `computeFixProgress` / `computeSearchProgress` (see Domain); the `fix.progress` / `search.progress`
  tRPC queries (see API) and the client poll contract (`refetchInterval` while mounted +
  non-terminal). A mermaid sequence mirroring D-15 (line 637) but read-only:
  `client → api.progress → arr.read.<kind>.getQueue + getHistorySince → phase`. Note the
  **projection vs. authority** nuance: `completed` may derive live before `completeFixRequests`
  (`fix-requests.ts:332`) flips the row on the next sync — the derived phase is a view, the cron
  matcher remains the durable writer.
- **D-21 — Roll-up cascade + the UI feedback states (ADR-014/015 discipline).** Per-child phase
  mapping for season/show/artist actions (queue records keyed on the run's target child ids via
  `listMediaChildren`, `packages/domain/src/media-children.ts:54`, `MediaChildTarget.arrChildId`).
  The UI states: the inline in-flight chip/progress meter beside the Fix/Force-Search buttons
  (`item-detail.tsx`), the live phase in item History and My Fixes, and the Fix-button open-fix
  disable. **Hard-rule 9 (ADR-015):** progress renders in **reserved space** and deepens
  color/updates a meter but never reflows neighbors or reorients the row — the button slot reserves
  width for the widest state (the "Downloading 100%" / "Nothing found" label) exactly as the
  ConfirmButton reserves the armed-label width (ADR-014). No `window.confirm`; the Fix/Force-Search
  entry points stay `Modal`s (multi-field/explanatory — ADR-014).
- **D-03 endpoint inventory (line 122):** add a **Queue** row — `GET /api/v3/queue` (Sonarr, Radarr)
  / `GET /api/v1/queue` (Lidarr), paged, filtered/joined by the target ids; read-only; the fields
  consumed (`size`,`sizeleft`,`status`,`trackedDownloadStatus`,`trackedDownloadState`,
  `estimatedCompletionTime`,`downloadId`,`episodeId`/`movieId`/`albumId`). Verify the per-version
  server-side filter param vs. client-side filter live (Open decision #8).

### DDD glossary — `docs/domain-driven-design/001-ubiquitous-language.md`
Add (next ids **T-75..T-78**; T-74 is the ceiling — re-check after 012/011/009/010):
- **T-75 Action Progress Phase** — the derived, user-facing status of a downstream *arr action
  between trigger and terminal: `queued | searching | grabbed | downloading | importing | completed
  | nothing_found | stalled | failed`. A projection over `fix_requests.status` (T-43) / the
  `search_requested` event (T-44) + the live *arr Queue (T-76) + recent history — **never stored**;
  recomputed per poll (ADR-025).
- **T-76 Download Queue** — the owning *arr's live download queue (`GET /api/v3|v1/queue`), read
  read-only for progress (`size`/`sizeleft` → percent, `status`/`trackedDownloadState`,
  `estimatedCompletionTime`, `downloadId`). Not synced, not stored; the source of the `downloading`/
  `importing` phases.
- **T-77 Found-Nothing / Stalled** — the two never-stuck terminals: **nothing_found** (no grab
  within the found-nothing window after a search) and **stalled** (a non-terminal action past the
  staleness threshold with no queue/history activity, or a queue `trackedDownloadStatus:'error'`),
  the latter carrying a retry affordance.
- **T-78 Action Feedback** — the contract that every user-triggered downstream *arr action reports
  status back (wire-ack → live phase → terminal), surfaced beside the button, in item History, and
  in My Fixes; the household-visibility promise for the deliberately small *arr blast radius.
- Amend **T-43 Fix Lifecycle** (line 96): the stored `fix_requests.status` is unchanged; the live
  Action Progress Phase (T-75) is a richer *derived* projection on top of it (ADR-025).
- Amend **T-44 Force Search** (line 97): its progress derives from the `search_requested` event +
  live Queue (no `fix_requests` row); Open decision #4 governs whether it gains an open-search lock.
- Add a Changelog row dated 2026-07-07 (ADR-025 / PLAN-015).

### PRD note — `docs/prds/001-haynesnetwork.md`
Add two requirements (next ids **R-88/R-89**; ceiling R-87 — re-check) in the Fix/Ledger table and
a dated note under R-43/R-46/R-47 (line 108, mirroring the `> Note (2026-07-05/06)` blocks at
126–135):
- **R-88 (Must)** — Every user-triggered downstream *arr action (Fix, Force Search, incl. roll-ups)
  gives live status feedback: a wire-ack the request landed ("searching"), download progress
  (queued → downloading% → importing → complete), and a terminal for the empty/failed/stalled cases
  — no silent buttons, no stuck states.
- **R-89 (Should)** — Feedback cascades to every child a roll-up touched, and each step shown to the
  user is reflected in the shared item History so others can see what was done.
- Dated note (2026-07-07): the Fix/Force-Search UI surfaces the live phase and disables Fix while an
  open fix targets the same grain (the R-47 one-open guard, now surfaced) — ADR-025 / DESIGN-005
  D-20/D-21.

## Data model — `packages/db`

- **No new table (recommended; verify at authoring).** Live phases are derived (ADR-025); the queue
  is read-only and never persisted. `FIX_STATUSES` (`enums.ts:76`), `FIX_PATHS` (`enums.ts:88`),
  `FIX_TARGET_SCOPES` (`enums.ts:96`) and `LEDGER_EVENT_TYPES` (`enums.ts:32`) are **unchanged** —
  **no migration** in the recommended path.
- **Guard lists — no change in the recommended path.** Queue reads use `@hnet/arr/read`, which is
  unguarded (only `@hnet/arr/write` is import-confined by
  `packages/domain/__tests__/arr-write-import-guard.test.ts`). No new table ⇒
  `no-direct-state-writes.test.ts` watched list untouched (`packages/domain/__tests__/`).
- **If Open decision #5 chooses to PERSIST milestones** (nothing_found / stalled / first-downloading
  as History steps): the leanest option is appending `FixActionEntry` rows to the existing
  `fix_requests.actions_taken` jsonb via a **new domain single-writer** (no schema change — the
  column already holds the step log, `fix-requests.ts:285` `actionsTaken || …::jsonb`). That writer
  lives in `packages/domain` so the `no-direct-state-writes` guard (which already watches
  `fix_requests`) stays green. A **new `LEDGER_EVENT_TYPES` value** for a persisted terminal would
  instead require migration `0017` (CHECK-relax, mirroring `0009`'s pattern, DESIGN-005 D-13) —
  **not recommended** (enum growth for transient state); recorded as the fallback only.

## Client / integration — `@hnet/arr` (queue read)

**A queue read client does not exist yet** (verified: zero `/queue` references in `packages/`). Add
it on the READ side only:

- **Schema** — `packages/arr/src/schemas/common.ts` gains a `queueRecordBaseSchema`
  (`{ id, status, trackedDownloadStatus, trackedDownloadState, size, sizeleft,
  estimatedCompletionTime?, timeleft?, downloadId?, title?, errorMessage?, statusMessages? }`) +
  `pagedSchema` reuse (`common.ts:38`), and per-*arr extensions in `schemas/{sonarr,radarr,lidarr}.ts`
  adding the id join keys (`episodeId`+`seriesId` / `movieId` / `albumId`+`artistId`). Zod-schema
  only the subset consumed (BC-03 ACL — external models never leak past `@hnet/arr`).
- **Read methods** — `packages/arr/src/read.ts`: add `getQueue(params?)` to `SonarrClient`
  (`read.ts:131`), `RadarrClient` (`read.ts:209`), `LidarrClient` (`read.ts:260`) issuing
  `GET queue?…` via the shared `ArrHttp.requestJson` (`http.ts:119`). Filter by target id where the
  server version supports it (`seriesIds`/`movieIds`/…); otherwise page the queue and filter
  client-side (Open decision #8). Percent = `(size - sizeleft) / size`.
- **Bundle** — `packages/domain/src/arr-clients.ts`: **no interface change** — `getQueue` rides the
  existing `read.{sonarr,radarr,lidarr}` clients already in `ArrClientBundle` (`arr-clients.ts:23`),
  built by `buildArrClientBundle` (`:58`) / `arrClientBundleFromEnv` (`:82`) from the *arrs' existing
  `*_URL`/`*_API_KEY` — **no new secret, no env, no helmrelease change.**

## Domain — `packages/domain`

New module `packages/domain/src/action-progress.ts` (exported from `packages/domain/src/index.ts`),
pure read (no writes in the recommended path):

- **`computeFixProgress({ db?, arr, fixRequestId, requesterId })`** — loads the `fix_requests` row
  (status, `target_scope`, `target_arr_child_id`, `target_season`, `path_taken`, `created_at`,
  `media_item_id`→`arr_kind`+`arr_item_id`), reads the owning *arr's queue via
  `arr.read.<kind>.getQueue()` and recent history for the target ids
  (`getHistorySince`/`getEpisodeGrabHistory` etc., `read.ts:160/190/245/304`), and returns
  `{ phase, pct, estimatedCompletionAt, lastActivityAt, perChild: [{ childId, label, phase, pct }],
  message? }`. Derivation (per target/child):
  1. a later `imported` ledger/history event for the target → **completed** (before the cron flip —
     the projection vs. authority note);
  2. else a queue record: `trackedDownloadState ∈ {importPending, importing}` → **importing**;
     `status:'downloading'` (or `sizeleft < size`) → **downloading(pct)**;
     `status ∈ {queued, delay, paused}` → **queued**; `trackedDownloadStatus:'error'` /
     `status:'warning'` → **stalled**(message);
  3. else no queue record: a `grabbed` event since `created_at` but not yet queued → **grabbed**;
     a `download_failed` event → **failed**; no grab within the *found-nothing window* → **searching**
     then **nothing_found**; `created_at` older than the *stalled threshold* with no activity →
     **stalled**.
  A `bazarr_subtitle` fix (`path_taken`) has no *arr queue/import → it rests at **searching** and is
  reported as "subtitles requested" (it is excluded from `completeFixRequests`, `fix-requests.ts:347`
  — mirror that exclusion here so it never derives `nothing_found`/`stalled`).
- **`computeSearchProgress({ db?, arr, mediaItemId, scope, targetChildId?, seasonNumber?, requesterId })`**
  — Force Search leaves no row, so this keys off the **most recent `search_requested` ledger event**
  for the target (its `recorded_at` is the window/staleness reference and `payload.scope`/
  `targetArrChildId`/`seasonNumber` identify the grain) + the same queue/history derivation. Same
  return shape.
- **Roll-up** — for `scope ∈ {season, show, artist}`, resolve the touched children via
  `listMediaChildren` (`media-children.ts:54`) — for a season, filter to
  `MediaChildTarget.seasonNumber` — map each child's queue/history to a `perChild` phase, and set the
  headline phase to the least-advanced non-terminal child (empty ⇒ terminal per rule).
- **Read-only + fail-closed.** All *arr reads wrap `ArrError → ArrUpstreamError` (BAD_GATEWAY) via
  the existing `guardArrCall` pattern (`media-children.ts:38`); a queue read failure surfaces as a
  transient "couldn't reach the manager" phase, never a false terminal.
- **(Open #5 only) `recordActionMilestone`** — if persistence is chosen, a `packages/domain` writer
  appends a `FixActionEntry` (e.g. `{ step:'phase', phase, at }`) to `fix_requests.actions_taken`
  **idempotently** (dedupe by phase — never per-tick), reusing the `actionsTaken || …::jsonb` append
  (`fix-requests.ts:285`). No status change (the lifecycle writer `recordFixAction` is untouched).

## API — `packages/api`

Extend the fix router (`packages/api/src/routers/fix.ts`) — **queries, not mutations**:

- **`fix.progress`** — `authedProcedure`, input `{ fixRequestId: z.uuid() }`; returns
  `computeFixProgress(...)`. The caller sees their own fix; admins see any (mirror the `myFixes` /
  `adminList` auth split, `fix.ts:123/157`). Errors via `mapDomainErrors` (`fix.ts:64`).
- **`search.progress`** (or `fix.searchProgress`) — `authedProcedure`, input
  `{ mediaItemId, scope?, targetChildId?, seasonNumber? }` (reuse `refineScopeShape`, `fix.ts:23`);
  returns `computeSearchProgress(...)`. Keys off the latest `search_requested` event for the grain.
- **No new mutation.** Progress is read-only; the client polls these queries via `refetchInterval`
  while a progress surface is mounted and the phase is non-terminal (see UI). `resolveArrBundle(ctx)`
  (`fix.ts:67`) supplies the read clients — no signature/auth changes elsewhere.

## UI — `apps/web`

- **`apps/web/lib/media.ts`** — add an `actionPhaseTone(phase)` + `ACTION_PHASE_LABELS` map (the nine
  phases → label/tone) beside the existing `fixStatusTone`/`FIX_STATUS_LABELS` (`media.ts:116-138`),
  and an optional `<PhaseChip>`/progress-meter component in `@hnet/ui` (token-themed; `tokens.css`
  the only hex — CLAUDE.md rule 2). No new raw hex.
- **`fix-dialog.tsx`** — replace the static `done` block (`fix-dialog.tsx:116-127`) with a **live
  phase view**: on `fix.create` success (which returns `{ id, status, pathTaken }`) start at
  **searching**, poll `fix.progress({ fixRequestId: result.id })` (`refetchInterval` while
  non-terminal), and render the phase chip + a Seerr-style download meter (pct from
  `size`/`sizeleft`), the target label, and a terminal line for completed / nothing_found / stalled
  (with a retry affordance for stalled). Stays a `Modal`.
- **`force-search-dialog.tsx`** — replace the static "a fresh search is running" `done` block with the
  same live view driven by `search.progress({ mediaItemId, ...targetToInput(target) })`, starting at
  **searching** on mutation success and advancing found-something → downloading% → complete /
  terminal **nothing_found** — the button "re-enables" (offers a fresh action) only on a terminal
  phase.
- **`item-detail.tsx`** — (a) **surface the open-fix lock:** when `detail.fixes` (already loaded,
  `item-detail.tsx:86`; each `{ status, targetLabel, … }`) contains an open fix (status ∈
  `OPEN_FIX_STATUSES`) matching a child/scope, render an in-flight **phase chip** in place of that
  child's enabled **Fix** button (`item-detail.tsx:139-152`, and the radarr/season Fix buttons at
  `:222-233` / `:405-423`) and disable the Fix action — the click can no longer error into
  `FixAlreadyOpenError`. Force Search stays enabled (no lock — Open #4). (b) The item **History**
  section (`item-detail.tsx:543-579`) already renders ledger milestones; extend `EVENT_TYPE_LABELS`
  usage so the journey (`fix_requested → grabbed → imported → fix_completed` / `download_failed →
  fix_failed`) reads clearly. **ADR-015 (hard rule 9):** the chip/meter render in the row's reserved
  action slot — width reserved for the widest label — so an interaction updates color/percentage
  but never reflows or reorients neighbors.
- **`my-fixes-panel.tsx`** — the Status cell (`my-fixes-panel.tsx:67-71`) gains the **live phase**:
  for rows whose stored status is non-terminal (`pending`/`actioned`/`search_triggered`), poll
  `fix.progress` and show the phase chip + a compact meter; terminal rows keep the static
  `FIX_STATUS_LABELS`/`fixStatusTone` badge. Same table, no layout reflow.

## Ops

- **No new secret / env / helmrelease change** — queue reads use the *arrs' existing
  `SONARR_/RADARR_/LIDARR_URL`+`_API_KEY` already in the bundle.
- **e2e stub — add a `/queue` route.** `apps/web/e2e/support/stub-arr.ts` (its `node:http` switch,
  read routes ~`:361-490`; control surface `/_stub/calls` + `/_stub/reset`) gains a **`GET /queue`**
  case returning **scriptable** records — a control endpoint (e.g. `POST /_stub/queue`) to stage a
  target's progression (queued → downloading with a shrinking `sizeleft` → empty-after-import) so a
  Playwright test can drive the phases deterministically. Mirror the stub's existing id constants
  (`STUB_SERIES_ID`/`STUB_MOVIE_ID`/`grabHistoryIdFor`). Bazarr's stub is unaffected (no queue).
- **Local dev / docs.** Note the queue-stub progression in `docs/ops/003-local-verification.md` so
  `pnpm dev:local` can demo a Fix advancing.

## Open decisions Fable 5 must make (authorized to decide + record as ADR-025 / Q-NN)

1. **Poll interval + backoff.** Recommended: ~2–3 s while `downloading`, ~5–8 s while
   `searching`/`queued`, stop on terminal or when the surface unmounts. Cap total poll duration.
2. **Found-nothing window.** How long after a search with no grab before the terminal
   **nothing_found** (vs. "still watching")? Recommended default ~10–15 min; may differ by kind
   (music indexers are slower). Record as a constant + Q-NN.
3. **Stalled threshold.** How old may a non-terminal action be with no queue/history activity before
   **stalled**? Recommended default ~30–45 min, plus immediate stalled on
   `trackedDownloadStatus:'error'`. Constant + Q-NN.
4. **Force-Search dedupe semantics.** Force Search has no open-search lock today (verified). Options:
   (a) leave it lock-free, surface progress purely from the latest `search_requested` event
   (recommended v1 — smallest change, "re-enable on terminal" is a UI affordance); (b) add a
   short-lived open-search guard (needs a persistent object — a `search_requests` row or an
   in-flight ledger marker). Decide + record.
5. **Persist phase transitions vs. derive.** Recommended: **derive** live; rely on the existing
   sync-ingested ledger milestones (`grabbed`/`imported`/`download_failed`) for the shared History,
   and **optionally** persist only the two *derived terminals* (nothing_found/stalled) via an
   idempotent `fix_requests.actions_taken` append (no migration). Avoid growing `FIX_STATUSES` /
   `LEDGER_EVENT_TYPES`. Confirm this satisfies R-89 "history records each step" or whether the owner
   wants intermediate phases persisted too.
6. **Roll-up headline aggregation.** Least-advanced non-terminal child (recommended) vs. a
   count/summary ("3/8 downloading, 1 nothing found"). Define the exact rule + how an all-terminal
   roll-up reads.
7. **Progress procedure surface.** `fix.progress(fixRequestId)` + `search.progress(mediaItem+target)`
   (recommended) vs. a single unified `action.progress`. Confirm auth (own-fix + admin).
8. **Queue endpoint/filter verification.** Read-only against live Sonarr/Radarr/Lidarr: does this
   version accept a server-side `seriesIds`/`movieIds` filter on `/queue`, or must we page + filter
   client-side? Confirm the join keys (`episodeId`/`movieId`/`albumId`) and the
   `status`/`trackedDownloadState` value vocabulary. Record verified fields in DESIGN-005 D-03/D-20.

## Verification

**Unit (`@hnet/domain`, embedded PG16 via `@hnet/test-utils`; fetch-stub bundle mirroring
`packages/api/__tests__/arr-stubs.ts`):**
- `computeFixProgress` phase mapping across staged queue/history states: **searching** (no queue, no
  grab, within window), **queued**, **downloading** (asserts pct from `size`/`sizeleft`),
  **importing** (`trackedDownloadState`), **completed** (matching `imported`), **nothing_found**
  (window elapsed, no grab), **stalled** (past threshold / `trackedDownloadStatus:'error'`),
  **failed** (`download_failed`).
- A `bazarr_subtitle` fix rests at **searching** and never derives nothing_found/stalled (mirrors the
  `completeFixRequests` exclusion).
- **Roll-up:** a season fix with mixed children → correct `perChild` phases + the headline rule.
- `computeSearchProgress` keys off the latest `search_requested` event (no fix row) and derives the
  same phases; two searches on one target → the newer event drives progress.
- Read-only guarantee: a queue-read `ArrError` maps to `ArrUpstreamError`, not a false terminal, and
  **no** `fix_requests`/`ledger_events` write occurs (assert row/event counts unchanged) — and no
  `@hnet/arr/write` call is made (the guard test already blocks the import; assert here too).

**API (`packages/api/__tests__/fix.test.ts`):** `fix.progress` returns the derived phase for a seeded
fix against the stub queue; own-fix vs. admin auth; `search.progress` for a Force-Search target.

**e2e (`apps/web/e2e`, stub `/queue`):** on `/library/[id]` for the seeded Sonarr series / Radarr
movie: (a) Fix → drive the stub queue queued → downloading (meter advances) → import → **completed**,
and assert the Fix button is **disabled with an in-flight chip** while open, then re-armed on
completion; (b) Force Search with a staged grab → downloading → complete; (c) Force Search with **no**
grab past the (test-shortened) found-nothing window → **nothing_found** terminal; (d) a season roll-up
shows per-child phases; (e) assert **no** write call was recorded on `stub-arr` `/_stub/calls` by the
progress polling (read-only).

**LIVE Playwright on real staging (`https://haynesnetwork.haynesops.com`, real *arrs):** after deploy
(bump the image tag in `haynes-ops/.../frontend/haynesnetwork/app/helmrelease.yaml` + `flux reconcile`,
per `docs/ops/004-deploy-runbook.md`):
- **A real fix watched through to import:** Fix a real broken movie/episode, watch the panel go
  searching → downloading (real percent) → complete, and confirm the Fix button was disabled in-flight
  then re-armed; cross-check the `fix_requests` row (`/admin/fixes`) reached `completed`.
- A real **Force Search** on a missing item → searching → (found) downloading → complete; and a
  deliberately unavailable item → **nothing_found** after the window.
- A real **season** Force Search → per-child phases cascade.

## Definition of Done

Docs authored + ADR-025 Accepted; local merge gate green
(`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`); branch
`feat/arr-action-feedback` → PR → required checks (`lint-and-typecheck`, `test`, `build`) green →
squash-merged; deployed to staging; the LIVE Playwright journeys above pass against real staging +
real *arrs (**including a real fix watched through to import**). Then flip Status → Completed and
`git mv` this plan to `.agents/plans/completed/`.

## Out of scope

- **Push notifications** of any kind (no toast/email/web-push when a download finishes while the user
  is away) — v1 is poll-on-demand only.
- **Any server-side/background poller** (no cron/`setInterval`/webhook/SSE reconciling progress). The
  authoritative milestones still arrive via the existing sync cron; a background poller for push +
  reliable unwatched terminals is a **future** plan.
- **Bulletin (009) integration** — surfacing these phases as feed events is noted for 009, not built
  here.
- **New *arr write actions** (retry/cancel/remove-from-queue) — progress is read-only; the retry
  affordance on **stalled** just re-issues the existing Fix/Force-Search action.
- Growing `FIX_STATUSES` / `LEDGER_EVENT_TYPES` for transient phases (derived, per ADR-025).

## Rollback

Revert the squash-merge PR and redeploy the prior image tag (`docs/ops/004-deploy-runbook.md`). The
change is **read-only and additive** — no migration in the recommended path, no new write surface, no
enum change — so a rollback simply removes the progress UI/queries and returns to the static done
states; existing fixes/searches and their lifecycle are unaffected. If a queue read misbehaves in
prod it fails closed (`ArrUpstreamError`, a transient "couldn't reach the manager" phase) and never
mutates state or blocks the underlying Fix/Force-Search.
