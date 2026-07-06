# PLAN-002: Bazarr subtitle Fix

- **Status:** Completed (2026-07-06) — shipped in v0.5.0 (PR #47, ADR-016); deployed to staging
  and live-validated: real movie + episode subtitle fixes landed `path_taken='bazarr_subtitle'` /
  `search_triggered` with 204s from the verified Bazarr endpoints (Bazarr logged both search
  attempts), and Music offers no Missing-subtitles reason.
- **Satisfies:** PRD-001 R-44/R-45 (note added), new **ADR-016** (supersedes/extends ADR-007),
  DESIGN-005 **D-19** (new)
- **Depends on:** none
- **TODO source:** #1 of `.agents/plans/TODO.md`
- **Validation:** live Playwright on staging (see Verification) — no separate `002-…-validation.md`

## Goal

When a user submits Fix with reason `missing_subtitles`, route the action to **Bazarr**
(subtitle search/download for the Radarr movie or Sonarr episode) instead of the ADR-007
blocklist-and-search (AC-07) / delete-and-search (AC-08) paths — a subtitle problem is not a
bad grab, so re-grabbing the file is wrong. Additionally **remove `missing_subtitles` from
the reason set offered for Music (Lidarr)**: Bazarr's REST API covers Radarr movies + Sonarr
episodes only, and we do not integrate subtitles for music. The reason picker currently shows
it for every kind (`apps/web/app/(app)/library/[id]/fix-dialog.tsx:12` hardcodes the full
`REASONS` list) — it must not for Lidarr.

Reference vertical (mirror it): the Fix flow — `packages/domain/src/fix-flow.ts:82`
`runFixRequest` → single-writers `createFixRequest`/`recordFixAction`
(`packages/domain/src/fix-requests.ts:103,254`) → import-confined `@hnet/arr/write`
(`packages/arr/src/write.ts`) → `fix.create` (`packages/api/src/routers/fix.ts:40`) →
`FixDialog` Modal (`fix-dialog.tsx`).

## Docs-first artifacts to author (same PR as behavior)

### ADR-016 — Subtitle Fix routes to Bazarr; music excludes missing_subtitles
`docs/adrs/016-subtitle-fix-via-bazarr.md` (copy `docs/adrs/000-template.md`; MADR 3.0;
**Fable 5 authors AND ratifies → Status: Accepted**). ADR-007 is Accepted/immutable
(`docs/adrs/007-fix-semantics.md` — already carries an `Amended by: ADR-011` line); do NOT
edit it — ADR-016 supersedes/extends its Option A for the one reason `missing_subtitles`.
Decision to record:
- `missing_subtitles` Fix does **not** mark-failed/blocklist, does **not** delete the file,
  does **not** trigger an *arr `*Search` command. It triggers **Bazarr**'s subtitle search
  for the movie (Radarr id) / episode (Sonarr id). New `FixPath` value `bazarr_subtitle`.
- The Fix reason taxonomy (R-45, still all six values in `FIX_REASONS`) is **filtered by
  arrKind** at the offer/validate layer: Lidarr excludes `missing_subtitles`. The enum const
  array is unchanged (Movies/TV still use the value) — the exclusion is a per-kind offer
  rule, not an enum edit.
- Resting lifecycle state + completion semantics for a subtitle fix (see Open decision #2).
- Consequences C-01..C-0N: good (right tool — subtitles fetched, file untouched); bad
  (Bazarr is a new upstream dependency in the Fix path — one more failure surface, `D-17`
  `ArrUpstreamError` mapping reused); neutral (completion is not observable via ledger
  `imported` events, so subtitle fixes rest rather than auto-complete — Open decision #2).

### DESIGN-005 — new D-19 (Subtitle Fix via Bazarr) + a Bazarr client subsection
`docs/designs/005-arr-ledger-and-fix.md` (append `### D-19`, do not renumber D-01..D-18).
Cover: the `runFixRequest` reason branch and the Bazarr subtitle-search sequence (mermaid
mirroring D-15 at line 637 but with the blocklist/delete steps replaced by one Bazarr call);
the Bazarr read/write client and where it lives (see Client); the per-kind reason filter; the
`completeFixRequests` exclusion (Domain); the Bazarr env contract (extends the D-18 table at
line 42 of `packages/arr/src/config.ts`). Add a row to the D-03 endpoint inventory
(line 122) for the chosen Bazarr endpoints once verified live (Open decision #1). Note the
`D-15` availability rule is unchanged (Fix shows on on-disk grains) — subtitle Fix is just a
new reason inside the same dialog.

### DDD glossary — `docs/domain-driven-design/001-ubiquitous-language.md`
Add (next id is **T-50**; T-45..T-49 are taken):
- **T-50 Bazarr** — the subtitle manager for the Radarr/Radarr estate; the Fix target for
  reason `missing_subtitles`. Covers movies + episodes, not music. `@hnet/arr` bazarr client;
  `BAZARR_API_KEY`.
- **T-51 Subtitle Fix** — the Fix Path (`fix_requests.path_taken = 'bazarr_subtitle'`) taken
  when reason = `missing_subtitles`: no Blocklist (T-33), no Fix Fallback delete (T-34), no
  *arr re-grab — a Bazarr subtitle search only.
- Amend **T-30 Fix Reason** (line 74): `missing_subtitles` is offered for Sonarr/Radarr only
  (Lidarr excluded — no music subtitle integration; ADR-016).
- Add a Change-log row dated 2026-07-05/06 (ADR-016).

### PRD note — `docs/prds/001-haynesnetwork.md`
Add a dated note under R-44/R-45 (mirroring the existing `> Note (2026-07-05)` at line 110):
`missing_subtitles` Fix routes to Bazarr (not mark-failed/delete + re-grab), and the reason is
not offered for Music (ADR-016 / DESIGN-005 D-19). Do not renumber R-44/R-45.

## Data model — `packages/db`

- **`packages/db/src/schema/enums.ts:66`** — add `'bazarr_subtitle'` to `FIX_PATHS`:
  `export const FIX_PATHS = ['blocklist_search', 'delete_search', 'bazarr_subtitle'] as const;`
  This is the single source of truth for the TS `FixPath` type **and** the
  `fix_requests_path_enum` CHECK (`packages/db/src/schema/fix-requests.ts:80`, built from
  `FIX_PATHS_SQL_LIST`). `FIX_REASONS` (line 47) is **unchanged**.
- **Migration `0009_bazarr_subtitle_fix_path.sql`** (next after `0008_relax_catalog_url.sql`)
  — hand-written drop + re-add of the `fix_requests_path_enum` CHECK to admit
  `'bazarr_subtitle'`, mirroring `0004_search_requested_event.sql`'s CHECK-relax pattern
  (DESIGN-005 D-13 migration table, line 548). Existing rows unaffected (additive). Confirm
  the constraint name from the generated migration/`packages/db/migrations/meta`.
- **Guard lists — no change needed.** No NEW table (subtitle fixes reuse `fix_requests`), so
  `no-direct-state-writes.test.ts` (its watched list already includes `fix_requests`, line 41)
  is untouched. The new Bazarr write client is import-confined by living under `@hnet/arr/write`
  (see Client) — `arr-write-import-guard.test.ts` already covers `@hnet/arr/write` with no edit.

## Client / integration — `@hnet/arr` (Bazarr adapter)

**Decision (Open #4): keep Bazarr inside `@hnet/arr`** alongside the sonarr/radarr/lidarr/seerr
adapters — do NOT spin a new `@hnet/bazarr` package. Rationale: reuses the existing
`ArrHttp`/zod/error stack (`packages/arr/src/http.ts`, `errors.ts`), and the **write** surface
lands under the already-guarded `@hnet/arr/write` entrypoint so the D-12 import confinement
holds with zero guard changes.

- **Config** — `packages/arr/src/config.ts`: add a Bazarr entry. Bazarr is **not** an *arr, so
  do NOT add it to `ARR_SERVICES` (line 7) — that would make `BAZARR_API_KEY` a hard
  requirement of `assertArrEnv`, breaking sync which never touches Bazarr. Instead add a
  separate `BAZARR_CLUSTER_URL_DEFAULT = 'http://bazarr.media.svc.cluster.local:6767'`
  (verified: `haynes-ops/kubernetes/main/apps/media/bazarr/app/helmrelease.yaml` service port
  6767) and a small `assertBazarrEnv(env)` reading `BAZARR_URL` (default the cluster DNS) +
  `BAZARR_API_KEY` (required; never echoed — same `ArrConfigError` shape). Bazarr auth header is
  `X-API-KEY` (not the *arr `X-Api-Key` casing — verify in `ArrHttp`; may need a header override)
  and base path `/api` (not `/api/v3`).
- **Read client** — `packages/arr/src/bazarr.ts` `BazarrClient` (exported from
  `@hnet/arr/read`, mirroring `read.ts`): read the wanted/subtitle state for a movie/episode
  (e.g. `GET /api/movies?radarrid[]=` / `GET /api/episodes?episodeid[]=`) for label resolution
  and post-hoc verification. Zod-schema the subset consumed (BC-03 ACL — external models never
  leak past `@hnet/arr`).
- **Write client** — add to `packages/arr/src/write.ts` a `BazarrWriteClient` exported from
  `@hnet/arr/write` (the confined entrypoint, header at line 1). Methods (exact endpoints =
  Open decision #1):
  - `searchMovieSubtitles(radarrMovieId: number)` — e.g. `PATCH /api/movies`
    `{radarrid, action: 'search-missing'}`.
  - `searchEpisodeSubtitles(sonarrEpisodeId: number, sonarrSeriesId?: number)` — e.g.
    `PATCH /api/episodes` `{seriesid, episodeid, action: 'search-missing'}`.
- **Bundle wiring** — `packages/domain/src/arr-clients.ts`: extend `ArrClientBundle`
  (line 12) with `read.bazarr: BazarrClient` + `write.bazarr: BazarrWriteClient`; build them in
  `buildArrClientBundle` (line 41) and `arrClientBundleFromEnv` (line 63) via `assertBazarrEnv`.
  Fix/Restore share this bundle; Restore ignores bazarr. `resolveArrBundle`
  (`packages/api/src/trpc.ts:43`) needs no change (opaque bundle).
- **Env/secret refs (names only):** `BAZARR_URL` (non-secret, defaulted), `BAZARR_API_KEY`
  (secret; 1Password `media-stack` item — see Ops). Never commit values.

## Domain — `packages/domain`

- **`fix-flow.ts` reason branch.** In `runFixRequest` (line 82), after item load +
  `resolveFixTarget` (line 105) and before the grab-resolution block (line 162), branch:
  `if (input.reason === 'missing_subtitles') return runSubtitleFix(...)`. New orchestrator
  `runSubtitleFix` (same file), mirroring `runFixRequest`'s pending-first shape:
  1. Guard kind: sonarr | radarr only — throw a new `SubtitleFixUnsupportedError`
     (`packages/domain/src/errors.ts`, mapped in `mapDomainErrors`) if lidarr reaches here
     (defense in depth; the reason is not offered for music, and the router rejects it — Open #2
     names the resting state).
  2. Resolve target label read-only (sonarr: the episode via `listMediaChildren`
     `packages/domain/src/media-children.ts`, reusing the D-06 live lookup as `runFixRequest`
     does at line 121; radarr: the movie itself — no child).
  3. `createFixRequest(...)` unchanged (`fix-requests.ts:103`) — pending row +
     `fix_requested` event in one tx BEFORE any Bazarr call (D-09 crash-safety), reason
     `missing_subtitles`, `pathTaken` null-until-actioned. **Reuse the existing single-writer;
     no new table, no guard-list change.**
  4. Bazarr call: `arr.write.bazarr.searchEpisodeSubtitles(targetChildId)` (sonarr) /
     `searchMovieSubtitles(item.arrItemId)` (radarr). On `ArrError`, reuse the `fail(...)`
     helper (line 149) → `recordFixAction` transition `failed` + `fix_failed` event, re-throw
     `ArrUpstreamError` (D-17).
  5. `recordFixAction` transition `actioned` with `pathTaken: 'bazarr_subtitle'` + a
     `FixActionEntry` `{step:'bazarr_subtitle_search', endpoint, ok, response, at}`, then the
     resting transition (Open #2 — default `search_triggered`, carrying the Bazarr accept).
  Invariant preserved: every *arr/Bazarr write is preceded by a committed audit row, and every
  step outcome is appended to `fix_requests.actions_taken` (ADR-007 C-03 / D-09).
- **`completeFixRequests` exclusion (correctness — must fix).**
  `fix-requests.ts:327` matches any `search_triggered` fix to a later `imported` ledger event
  on the same `media_item_id`. A subtitle fix produces NO `imported` event, but an **unrelated**
  later import on the same item (e.g. a normal re-grab of another episode/movie file) would
  **spuriously flip the subtitle fix to `completed`**. Add `pathTaken <> 'bazarr_subtitle'`
  (or equivalent) to the `open` query filter (line 331) so subtitle fixes are never matched by
  the ledger-import completer. Cover with a unit test (see Verification).
- **Reason-by-kind helper (shared).** Add `fixReasonsForKind(kind: ArrKind): FixReason[]` in a
  domain module (e.g. `action-scope.ts` neighbor or a new `fix-reasons.ts`, exported from
  `packages/domain/src/index.ts`) returning all six for sonarr/radarr and the five-minus-
  `missing_subtitles` set for lidarr. Used by the router validation AND surfaced to the web
  layer (re-export or mirror in `apps/web/lib/media.ts`).

## API — `packages/api`

- **`fix.ts:40` `create`** — no signature change (still `reason: z.enum(FIX_REASONS)`). Add
  server-side per-kind validation: reject `missing_subtitles` when the item's `arrKind` is
  `lidarr`. Simplest: let the domain guard (`SubtitleFixUnsupportedError`, above) surface via
  `mapDomainErrors` as a `BAD_REQUEST`/appCode; optionally add a `.refine`-style front guard
  after loading the item. Auth level unchanged — `authedProcedure` (members submit their own
  fixes; R-43). `adminList`/`myFixes` unchanged (they already render `pathTaken`).
- No new procedure. The Bazarr trigger rides entirely inside `runFixRequest`.

## UI — `apps/web`

- **`app/(app)/library/[id]/fix-dialog.tsx`** — replace the hardcoded `REASONS` (line 12) with
  `fixReasonsForKind(item.arrKind)` (from `@/lib/media`). Lidarr thus never renders the Missing
  subtitles radio. When the selected reason is `missing_subtitles`, the explanatory copy makes
  clear Bazarr will fetch subtitles and the media file is untouched (no re-grab) — add a
  `bazarr_subtitle` branch to the `done` block (line 116, which currently switches
  `blocklist_search` vs `delete_search`): e.g. "Bazarr is searching for and downloading
  subtitles — the media file itself is untouched." Optionally a one-line hint under the reason
  list when `missing_subtitles` is checked.
- **No-reorientation (ADR-015 / hard rule 9):** the reason set is fixed at dialog-open by kind
  (not changed by interaction), so no reflow-on-interaction. Selecting `missing_subtitles` adds
  no field (unlike `other`, whose textarea is the existing sanctioned deliberate expansion at
  line 194). The dialog stays a **Modal** (`@/components/modal`) — Fix is a multi-field /
  explanatory confirm (ADR-014), not a `ConfirmButton` destructive two-step. No `window.confirm`.
- **`app/(app)/library/[id]/item-detail.tsx`** — no structural change; it opens `FixDialog`
  with the item's `arrKind` already (line 401). `FIX_REASON_LABELS` (`lib/media.ts:82`) keeps
  `missing_subtitles` (movies/TV use it).
- **`lib/media.ts`** — add/re-export `fixReasonsForKind`; no label changes.

## Ops

- **1Password / ExternalSecret.** Add `BAZARR_API_KEY` to the app secret template in
  `haynes-ops/.../frontend/haynesnetwork/app/externalsecret.yaml` under the media-stack block
  (line 41-44, next to `SONARR_API_KEY` etc.): `BAZARR_API_KEY: "{{ .BAZARR_API_KEY }}"`. The
  ExternalSecret already `dataFrom: extract: key: media-stack` (line 57) — so it resolves once
  `BAZARR_API_KEY` is a field on the `media-stack` item (Open decision #5 — confirm it exists;
  Bazarr's own ExternalSecret at `apps/media/bazarr/app/externalsecret.yaml` does not yet pull a
  `BAZARR_API_KEY`, so it may need adding to the item — Bazarr's key lives in its `config.yaml`).
  `BAZARR_URL` is omitted (defaults to the in-cluster service DNS, like the *arrs at
  `externalsecret.yaml:39`). No helmrelease change (env comes via `secretRef`, line 66-67).
- **Local dev / docs.** Add `BAZARR_URL`/`BAZARR_API_KEY` to `apps/web/.env.example` and the
  ops verify doc `docs/ops/003-local-verification.md`. `pnpm dev:local` needs a stub (below).
- **e2e stub (hermetic).** Add `apps/web/e2e/support/stub-bazarr.ts` mirroring
  `stub-arr.ts:165` `startStubArr` (its own `node:http` server, `/_stub/calls` +
  `/_stub/reset` control surface, records the subtitle-search write). Base path `/api`,
  `X-API-KEY` header. Wire it: extend `harness.ts` (`startStack`, line 119 — start it next to
  `startStubArr` at line 153, teardown at line 190), and `env.ts` `RuntimeEnv` +
  `composeRuntimeEnv` (line 60) to add `BAZARR_URL` (→ stub) + `BAZARR_API_KEY`
  (`STUB_ARR_API_KEY`). No new prewarm route.

## Open decisions Fable 5 must make (authorized to decide + record as ADR-016 / Q-NN)

1. **Exact Bazarr endpoints.** Verify **read-only** against the live Bazarr
   (`https://bazarr.haynesops.com` / in-cluster) which of `PATCH /api/movies`+`/api/episodes`
   `{...id, action:'search-missing'}` vs `POST /api/subtitles` (manual download) actually
   triggers a provider search per id on this Bazarr version. Record the chosen verb/path/body
   in DESIGN-005 D-03/D-19.
2. **Fire-and-forget vs poll; resting FixStatus.** Recommended default: fire-and-forget, rest at
   `search_triggered` (reuses the existing terminal state + `fixStatusTone`/labels;
   `completeFixRequests` excluded per Domain). Alternative: mark `completed` immediately, or poll
   Bazarr for subtitle presence to complete. Record in ADR-016 / a Q-NN.
3. **Bazarr ↔ Sonarr/Radarr id mapping.** Confirm Bazarr shares the same Radarr movie ids and
   Sonarr episode ids we store (`media_items.arr_item_id`, `fix_requests.target_arr_child_id`) —
   i.e. `radarrid == arrItemId` (radarr) and Bazarr `episodeid == targetChildId` (sonarr). Single
   Bazarr instance today; if it ever fronts multiple *arr instances, how to select.
4. **Client shape.** Confirm Bazarr-in-`@hnet/arr` (recommended) vs a new `@hnet/bazarr`
   package + its own write-import guard; and whether `BAZARR_API_KEY` is required vs lazy in the
   bundle (recommended required, since staging provides it).
5. **Secret provisioning.** Confirm `BAZARR_API_KEY` is a field on the 1Password `media-stack`
   item; if not, add it (value from Bazarr's `config.yaml` `auth.apikey`).

## Verification

**Unit (`@hnet/domain`, embedded PG16 via `@hnet/test-utils`; mirror `fix.test.ts` fetch-stub
bundle at `packages/api/__tests__/arr-stubs.ts`):**
- `runSubtitleFix` for a **sonarr episode** and a **radarr movie**: asserts the Bazarr write
  client was called with the right id, and that `markHistoryFailed` / `deleteEpisodeFile` /
  `deleteMovieFile` / `searchEpisodes` / `searchMovies` were **not** called; `fix_requests` row
  lands `path_taken = 'bazarr_subtitle'`; `ledger_events` has `fix_requested` + `fix_actioned`;
  resting status per Open #2.
- Bazarr error → status `failed` + `fix_failed` event + `ArrUpstreamError`.
- **lidarr + missing_subtitles** → `SubtitleFixUnsupportedError`.
- `completeFixRequests` does **not** complete a `bazarr_subtitle` fix even when a later
  unrelated `imported` event exists on the same media item (the correctness fix).
- `fixReasonsForKind`: lidarr excludes `missing_subtitles`; sonarr/radarr include it.

**API (`packages/api/__tests__/fix.test.ts`):** `fix.create` with `reason:'missing_subtitles'`
on a radarr/sonarr item hits the Bazarr stub (assert via the injected bundle); the same on a
lidarr item → mapped `BAD_REQUEST` appCode.

**e2e (`apps/web/e2e`, stub Bazarr):** on `/library/[id]` for the seeded Sonarr series (or a
seeded Radarr movie — extend `seed-ledger.ts` if needed) open Fix → check **Missing subtitles**
→ submit → assert `stub-bazarr` `/_stub/calls` recorded the subtitle-search with the expected
id and that no `history/failed` / `command` / file-delete was recorded on `stub-arr`. Assert a
**Lidarr** item's Fix modal renders **no** Missing subtitles radio.

**LIVE Playwright on real staging (`https://haynesnetwork.haynesops.com`, real Bazarr):**
after deploy (bump image tag in
`haynes-ops/kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml` + `flux
reconcile`, per `docs/ops/004-deploy-runbook.md`):
- On a real **movie** and a real **episode**: Fix → Missing subtitles → submit; confirm success
  copy mentions Bazarr, then confirm Bazarr actually received the subtitle search — via the
  fix row's `actions_taken` showing a 2xx from the Bazarr endpoint (admin Fixes queue,
  `/admin/fixes`) and/or Bazarr's own history/logs.
- On a real **Music** (Lidarr) artist/album: open Fix, confirm **no** Missing subtitles option.

## Definition of Done

Docs authored + ADR-016 Accepted; local merge gate green
(`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`); branch
`feat/bazarr-subtitle-fix` → PR → required checks (`lint-and-typecheck`, `test`, `build`) green
→ squash-merged; deployed to staging; the LIVE Playwright journeys above pass against real
staging + real Bazarr. Then flip Status → Completed and `git mv` this plan to
`.agents/plans/completed/`.

## Out of scope

- Music/Lidarr subtitles (no Bazarr coverage).
- Bazarr provider configuration (managed in `haynes-ops` / Bazarr `config.yaml`).
- Poll-based / subtitle-import completion tracking and any subtitle-state sync into the ledger
  (Force Search, other reasons, Restore all unchanged).
- A Bazarr "wanted subtitles" browsing surface — only the Fix trigger is built here.

## Rollback

Revert the squash-merge PR and redeploy the prior image tag (`docs/ops/004-deploy-runbook.md`).
The `FIX_PATHS` addition + migration `0009` is an **additive CHECK relax** — harmless to leave
in place even on rollback (no `bazarr_subtitle` rows exist unless subtitle fixes ran; those rows
stay valid). If Bazarr is unreachable in prod, subtitle fixes fail closed with
`ArrUpstreamError` + a `failed` row (no file mutated) — the other Fix reasons are unaffected.
