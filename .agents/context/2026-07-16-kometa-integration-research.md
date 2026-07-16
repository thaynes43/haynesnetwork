# Kometa deep research — config model, safe knobs, our deployment, "Kometa for books" (2026-07-16)

> Opus deep-research report (dispatched at the owner's roadmap ruling; verified against the
> Kometa GitHub docs source + v2.4.4 tagged source + Kavita/ABS source repos + local
> haynes-ops exploration). Feeds PLAN-052 (collection-manager integration) and the PLAN-043
> books-app phase. UNVERIFIED flags preserved.

## 1. Kometa config model (essentials)

- config.yml: `libraries` (per-library `collection_files`/`overlay_files`/`operations`/
  `schedule`), global `playlist_files`, `settings`, `webhooks`, connector blocks (plex+tmdb
  required; tautulli/radarr/sonarr/trakt/mdblist/...). Default location /config/config.yml.
- `collection_files` is an ORDERED LIST of independent File Blocks, each one of:
  `- file:` (local) | `- folder:` | `- url:` | `- git:` (Community-Configs) | `- repo:` |
  `- default:` (built-in Defaults; legacy `- pmm:` alias still works). Each block may carry
  its own `template_variables:`, `schedule:`, `asset_directory:`.
- Defaults system: `- default: <name>` loads upstream-maintained YAML from the image's
  defaults/ (chart/award/movie/show/both families: oscars, golden, franchise, universe,
  seasonal, genre, streaming, ...). Customization = documented `template_variables` per
  default (incl. `use_<key>: false` per sub-collection, `collection_order`, `schedule`, and
  the *arr acquisition knobs radarr_add_missing/search/availability/tag). EXPLICIT caveat:
  template_variables are SPECIFIC to Defaults — custom files don't get them unless authored
  to implement them.
- Builders taxonomy: plex_search/smart_filter/plex_watchlist...; tmdb_* (discover, list,
  collection, trending, actor/director...); imdb_list/chart/search/award; trakt_*;
  mdblist_list; letterboxd_list; tautulli_popular/watched; tvdb_*; radarr_all/taglist +
  sonarr equivalents; anime (anidb/anilist/mal). NO literal-title list builder — manual
  curation = ID builders (tmdb_movie:/tmdb_show:/imdb_id: lists; the "Curated for Jackson"
  idiom in our config); a text_file builder exists since v2.3.1 (semantics UNVERIFIED).
- Filters post-builder (original_language, tmdb_vote_count.gte, filepath.regex, ...);
  templates (`templates:` + `<<var>>`); dynamic_collections (33 types incl. tmdb_collection,
  genre, decade, network, imdb_awards, custom).
- Schedules: hourly/daily/weekly(day)/monthly(D|last)/yearly/date/range/never/non_existing/
  all[...] — at file-block AND per-collection level. KEY SEMANTIC (verbatim): "These
  schedules do not trigger Kometa to run; they control what Kometa will do if it happens to
  be running at the scheduled time."
- Operations: mass_*_rating_update, mass_genre_update, mass_poster/background_update,
  assets_for_all, delete_collections, radarr_add_all, genre_mapper, metadata_backup, ...

### THE LOAD-BEARING ANSWER — single managed file is fully supported

An app can own exactly ONE `- file:` entry appended to `collection_files` and never touch
siblings. Safety contract:
1. Only interference vector = COLLECTION-NAME COLLISION (collections key by Plex title; our
   own config deliberately exploits this for franchise dedup — "curated file loaded last
   wins"). The managed file must NAMESPACE its collection names.
2. `sync_mode` default is `append` — a managed collection that mirrors a list exactly needs
   `sync_mode: sync` (our global is already sync).
3. Global `minimum_items: 2` + `delete_below_minimum: true` apply to managed collections too
   (a 0-1-match collection auto-deletes; expect it).
4. Removing the managed entry ORPHANS its Plex collections rather than deleting them —
   explicit cleanup needed (delete_collections op or empty+sync); exact orphan semantics
   UNVERIFIED — test on a canary before relying.

## 2. Stability / validation / runtime

- Branches master(stable, v2.4.4 = latest, 2026-06-25) / develop / nightly (VERSION file +
  v2.x.x tags + docker semver). Breaking-change reality: PMM→Kometa rebrand (back-compat
  kept for `- pmm:`), metadata_path→collection_files rename, monthly(N) fallback REMOVED,
  v2.3.0 dropped AniDB auth config, v2.3.1 REMOVED the Reciperr builder. Churn concentrates
  in BUILDERS (scraper-backed) and connectors; the File-Block shape has been stable across
  2.x. Defaults + template_variables = the materially more stable public surface (upstream
  fixes the internals; e.g. IMDb charts moved to GraphQL under the hood).
- VALIDATION (framework landed v2.4.2, verified in our pinned v2.4.4): `--validate`
  (`--validate-level syntax|structure|full` — full connects to Plex/APIs but MUTATES
  NOTHING), `--validate-schema` (JSON schemas shipped in json-schema/), and crucially
  `--validate-file <file>` / `--validate-dir` — validate ONE generated file against its
  schema, exit 0/1. NO --dry-run exists; nearest = --validate-level full, or --tests
  (runs only `test: true` collections — a canary that DOES write those).
- RUNTIME: batch process, NO inbound API/UI/daemon; default = wake at --times (5AM) daily;
  --run = immediate one-shot. Scoped runs: --run-files / --run-collections /
  --run-libraries / --ignore-schedules. Kometa REWRITES config.yml each run unless
  --read-only-config. Webhooks are OUTBOUND only (error/version/run_start/run_end/changes/
  delete → URL/notifiarr/gotify/ntfy/apprise). Run state = logs (/config/logs/meta.log) +
  exit status; save_report exists (format UNVERIFIED; ours off).

## 3. Safe knob set for a limited web UI (ordered safest → most powerful)

1. Enable/disable the managed file entry (one line in collection_files).
2. Toggle default sub-collections via documented template_variables (use_<key>, schedule,
   collection_order, radarr_* acquisition knobs — treat *_add_missing as PRIVILEGED; the
   2026-07-10 theatrical-window/flood history is the cautionary tale).
3. Static membership: app-namespaced collections in the managed file using ID builders
   (tmdb_movie:/tmdb_show: lists) with sync_mode: sync. Add a title = append an ID.
4. Schedule strings (validated against the grammar; they gate, not trigger).
5. Run-now = `kubectl create job --from=cronjob/...` with `--run --run-files
   "hnet-managed.yml"` (bounded, fast; our SA can create jobs).
6. CI gate every generated file with --validate-file (or JSON-schema app-side) against the
   pinned image BEFORE the PR merges.
7. Run-state readback: K8s Job status (already alerted via MediaAutomationJobFailed) +
   meta.log + optionally point Kometa's run_end/error OUTBOUND webhook at an hnet endpoint.
What Kometa CANNOT give a UI: live progress, per-collection results API, state mutation
without a process start.

## 4. OUR deployment (authoritative — haynes-ops/kubernetes/main/apps/media/kometa/)

- bjw-s app-template, THREE CronJobs sharing one config: collections `30 6 * * *` NY
  (--run --collections-only), overlays Sat 01:00 (--overlays-only), operations Sun 01:00
  (--operations-only); concurrencyPolicy Forbid; 16Gi memory (overlay OOM history).
- Image PINNED docker.io/kometateam/kometa:v2.4.4 (current latest).
- CONFIG HYBRID (the integration-critical fact):
  - config.yml = ExternalSecret-rendered SEED (1P-injected tokens) → copied to PVC ONLY IF
    ABSENT (Kometa self-rewrites it, e.g. trakt tokens). Git edits to config.yml DO NOT
    reach the pod until a re-seed (delete the PVC copy) — template_variable changes on
    Defaults = "PR + re-seed" owner-approved operations.
  - Collection/overlay FILES = git-managed ConfigMap (app/config/*.yml via
    configMapGenerator), mounted RO at /config/git, HOT every run. **An hnet-managed file
    lives here → pure Git PR flow, no PVC writes.**
  - PVC 20Gi ceph-block: cache DB, self-written config.yml, original-poster backups; not
    VolSync'd.
- Libraries: HOps Movies + HOps TV Shows on plexops; HOps Music block prepared but
  commented. Movies = 5 Defaults (universe/seasonal/oscars/golden acquisition-ON via
  template_variables; franchise acquisition-OFF) + 5 git files; TV = 2 git files. The
  franchise-Default-vs-curated-file name-collision dedup is deliberate and documented in
  externalsecret comments.
- Overlays in use (movies: resolution/audio_codec/video_format/ribbon/ratings; shows: +
  status, SHOW-LEVEL only — episode/season overlays banned, historic day-long runs).
- Operations: mass ratings (mdb_tomatoes/tomatoesaudience/imdb).
- Acquisition posture: global add_missing+search ON, tag Kometa-Added, radarr availability
  `released` (owner theatrical-window ruling 2026-07-10); per-file opt-outs; charts gated
  by with_original_language en + vote floors. Trakt unconfigured.
- Alerting: MediaAutomationJobFailed (critical → Pushover) on kometa|recyclarr job failures.

## 5. "Kometa for books" modeling (the PLAN-043 app)

- Idiom map: libraries→Kavita/ABS targets; collection_files→app recipes; builders→books
  list sources; Plex collections→Kavita collections/reading lists + ABS collections/
  playlists; radarr add_missing→LL Wanted push (behind the PLAN-039 governor);
  sync_mode/schedule→same semantics; Defaults+template_variables→app-shipped recipe
  presets ("NYT Fiction", "Hugo winners", "Complete series I've started").
- WRITE TARGETS (verified from source):
  - Kavita: Plugin auth (apiKey→JWT; our KavitaClient already does this). Collections:
    POST /api/Collection/update, /update-for-series, /update-series, DELETE — UNORDERED.
    Reading lists: /api/ReadingList/create, update-by-*, **update-position (explicit
    arbitrary ordering)** + CBL import/export. → reading ORDER = Kavita READING LIST;
    grouping = collection.
  - ABS: Bearer auth. /api/collections CRUD + /book + /batch/add|remove — **ORDERED**
    (collectionBook.order; PATCH takes a books[] array). Playlists: ordered, user-personal,
    cross-library. → household series order = ABS collection; personal queue = playlist.
- LIST SOURCES (viability 2026-07): NYT Books API (official, ISBN+rank; rate ~500/day
  UNVERIFIED vs 1000); **Hardcover GraphQL (Bearer, 60/min, series POSITION field — the
  Goodreads replacement; LL even has native hc_sync)**; Open Library (no-key reads, Lists
  API read+write, OLID/ISBN/LCCN backbone; series ordinals unusable); Wikidata SPARQL
  (series order via P179+P1545, awards via P166 — Hugo/Nebula/Booker home); Goodreads =
  API DEAD, shelf RSS alive (last-100 cap) = seed/curation input only; award lists =
  Wikidata-backed recipes.
- Deltas from Kometa to adopt deliberately: ORDERING IS FIRST-CLASS (collection_items.
  position from day one; per-target mapping reading-list/collection/playlist); matching via
  ISBN/ASIN/OLID chains (Open Library + Wikidata as glue) against books_items, never
  title/author fuzz alone; BE AN APP not a YAML batch job (DB recipes + reconciler, own
  API) while keeping Kometa's contract SHAPE so the hnet UI is common.

## 6. Provider-parity contract (PLAN-052 R2 — the UI binds to these nouns)

1. Managed collection set (Kometa: ONE namespaced managed file, git-PR-delivered; books:
   DB-native recipes). Everything else read-only "unmanaged" context.
2. Recipe = builder + variables ({id, targetLibrary, name(namespaced), builder{type,ref},
   variables{syncMode, ordered, acquisitionEnabled, tag, schedule}, enabled}) — one tRPC
   router + form serves both with a provider discriminator; Kometa Defaults toggling is the
   same shape (provider=kometa, recipe=default:<name>).
3. Schedule (cadence string; Kometa's is display-only v1 — the CronJob owns cadence).
4. Run state (last_run_at, status, per-recipe counts, log link). Kometa: Job status +
   meta.log + optional run_end webhook → hnet; books: native sync_runs.
5. Run-now (Kometa: Job from CronJob w/ --run-files, CI-validated first; books: sync mode).
6. Collections-produced read-back from the media server keyed to recipe ids, flagged
   unmanaged otherwise → feeds the PLAN-037/051 mirrored walls.
Day-one books-app contract (implement from the start): listRecipes/upsertRecipe/
deleteRecipe · validate(recipe|set)→issues[] · apply(scope)→runId + getRun(runId) ·
listProducedCollections() · ordered membership + per-recipe missing[] consumed by the
acquisition layer (role-gated toggle, the radarr_add_missing analog).

## Open/UNVERIFIED (carry into ADRs)

Orphan-cleanup semantics on managed-definition removal (canary-test); --validate-file
connectivity needs at syntax/structure; NYT current rate limit; Hardcover token expiry;
Open Library series ordinals (assume unusable); ABS batch/add body fields; smart_label/
simkl/textfile exact spellings; save_report format.
