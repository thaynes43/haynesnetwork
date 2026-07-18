# PLAN-052: Collection-manager integration — Kometa knobs + provider-agnostic UI

## ▶ DIRECT-ADD REWORK — EXECUTABLE BUILD PLAN (PR4a/b/c, 2026-07-18)

**Owner rulings 2026-07-18 KILLED suggest→approve** (`.agents/context/2026-07-18-collections-direct-add-rulings.md`).
Governing docs revised: **ADR-072** (supersedes ADR-069 + ADR-070), **DESIGN-043** (collection
manager → direct-add + first-class `/collections` page), **DESIGN-042** (Kometa → auto-merge).
Backbone is **PR3** (`collection_size_cap` app_setting, migration 0067; `assertWithinCollectionSizeCap`;
`collections.requestOverride` → ADR-050 `collection_override` ticket — on branch
`feat/collection-size-cap`, about to merge; ships as-is). **Migration ledger: 0067 = PR3 (claimed) ·
0068 = reserved (books wanted-tiles) · 0069+ = PR4.** Dispatch build agents straight off the
file-level scope below.

### PR4a — teardown + first-class page shell + Libretto direct add/edit + Tickets (migration 0069)

*Realizes ADR-072 + DESIGN-043 D-01/D-03/D-06/D-09/D-10/D-11/D-15. The keystone PR — everything else
depends on the shell + teardown.*

- **Teardown (DESIGN-043 D-15):**
  - `packages/db/migrations/0069_collections_direct_add.sql` — `DROP TABLE collection_suggestions`;
    drop `COLLECTION_SUGGESTION_STATUSES`; rebuild `COLLECTION_ACTIONS` CHECK from
    `suggest`/`manage`/`acquire` to a single `find_missing` (clearing old grant rows); add
    `tickets.collection_override_payload jsonb` (nullable); extend `TICKET_CATEGORIES` for
    `collection_override` if PR3 hasn't. Journal + snapshot.
  - `packages/domain/src/collection-suggestions.*` + tests — REMOVE (`createCollectionSuggestion` /
    `approveCollectionSuggestion` / `declineCollectionSuggestion` / `listCollectionSuggestions`).
  - `packages/api` collections router — remove `createSuggestion`/`approve`/`decline`/`listSuggestions`.
  - `apps/web/app/(app)/library/suggest-collection.tsx` + its mount in `books-browser.tsx` — REMOVE
    (UI removal lands tonight via another agent; PR4a folds the domain/API/DB teardown behind it).
  - `packages/db/src/enums.ts` — drop suggestion enums; `COLLECTION_ACTIONS = ['find_missing']`.
  - Guard tests: `no-direct-state-writes` (drop the `collection_suggestions` entry, add the tickets
    payload write-confinement); `arr-write-import-guard` unchanged (still confines the write clients).
- **First-class page shell (DESIGN-043 D-01/D-09):**
  - `apps/web/app/(app)/collections/` — new route + layout with sub-nav (Movies / TV / Books /
    Audiobooks / Tickets / Settings); `COLLECTIONS_NAME` constant + top-nav entry.
  - MOVE `apps/web/app/(app)/integrations/collections/*` → `apps/web/app/(app)/collections/*`; remove
    the Integrations hub Collections card; add `/integrations/collections` → `/collections` redirect.
- **Libretto direct add/edit + delete + over-cap (DESIGN-043 D-03/D-06/D-10/D-11):**
  - `packages/domain` — `assertWithinCollectionSizeCap` (reads `collection_size_cap`; admin bypass);
    direct `upsertCollection` writer (audit same-tx, then confined `@hnet/libretto/write` upsert);
    admin `deleteCollection`; `requestCollectionOverride` (opens the `collection_override` ticket with
    the payload, one tx); `approveCollectionOverride` (materialize unbounded + transition ticket +
    audit, one tx — the ADR-050 ticket writer + the confined upsert).
  - `packages/api` collections router — `upsert` (no grant, cap-gated), `delete` (admin),
    `requestOverride`, `approveOverride` (admin), `overview` (per-provider list).
  - `apps/web` — the per-media-type collection list (D-02) + composer Modal (D-03, ref-preview) for
    Books/Audiobooks; the Tickets sub-section (requester own-state + admin approve→materialize, D-11).
- **Tests:** cap boundary + admin bypass; upsert atomicity; over-cap→ticket; approve→materialize in one
  tx; teardown guard (table gone, routers gone); API forbidden matrix (non-admin can upsert≤cap, cannot
  delete/approve).

### PR4b — Kometa auto-merge write path for Movies/TV (no migration)

*Realizes ADR-072 + DESIGN-042 D-02/D-07/D-09/D-10. Depends on PR4a's shell + domain writer seam.*

- **The Kometa write adapter (confined, `@hnet/domain`-only):**
  - the recipe → managed-include compiler (DESIGN-042 D-05, pure function: allowlisted builder +
    validated ref → the `collections:` YAML entry; `acquisitionEnabled:false` ⇒ `radarr_add_missing:false`).
  - a confined haynes-ops git-write client (`@hnet/haynesops/write` or equivalent, import-confined to
    `packages/domain`, arr-write-import-guard extended) — regenerate `hnet-managed-movies.yml` /
    `-tv.yml`, open a bot-authored PR (dev-bot app token), wait for `--validate-file`, **auto-merge**
    when D-10's four conditions hold (within-cap, grouping-only, managed-file-only diff, CI green);
    otherwise leave for human merge (over-cap materialize + find-missing enable).
  - the collection row state machine (drafting → PR opened → merged (auto|human) → run → mirrored),
    reconciled by `collections-sync` (`provenance: kometa`, T-194) — the surviving DESIGN-042 D-07.
- **Provider wiring:** the collections router `provider` discriminator routes Movies/TV to the Kometa
  adapter, Books/Audiobooks to Libretto; the composer/overview UI is provider-agnostic (D-01).
- **Monitor (DESIGN-042 D-08):** Job status (`MediaAutomationJobFailed`) + `meta.log` link; the bounded
  run-now Job scoped to the managed file (dev-env SA job-create).
- **Egress:** ref-preview resolve (TMDb in-hand; IMDb/TVDb list resolution — DESIGN-042 Q-06, may need a
  CiliumNetworkPolicy allowlist entry via a haynes-ops PR).
- **Tests:** the compiler (pure); the auto-merge gate (each of the four conditions blocks auto-merge in
  isolation → human path); a red `--validate-file` never auto-merges; the mirror reconcile to `live`.

### PR4c — find-missing grant + cron force-search wiring (uses 0069's `find_missing`)

*Realizes ADR-072 + DESIGN-043 D-14 + DESIGN-042 D-06/D-14. The acquisition lever — lands last.*

- **The grant (the DESIGN-033 FLIP idiom):** `setRoleCollectionActions` single-writer (survives from
  ADR-070, audit same-tx); `collectionActionsForRole` / `collectionActionProcedure('find_missing')`;
  `roles.setCollectionsActions` + a "Collections actions" grid at `/admin` roles (the `roles.setBooksActions`
  precedent). Ships Admin-only (empty grants).
- **The per-collection knob (DESIGN-043 D-14):** `collections.setFindMissing` (find_missing-gated) →
  Kometa sets `radarr_add_missing`/`sonarr_add_missing` (a HUMAN-merged managed-include PR, D-10);
  Libretto sets `variables.acquisitionEnabled` (direct API). Explanatory Modal confirm; server re-check.
- **Cron force-search:** Kometa's `collections` CronJob + Libretto's apply/cron force-search the missing
  members of find-missing collections (the provider does the acquisition — the app only sets the flag).
- **Tests:** grant matrix (no grant ⇒ FORBIDDEN, admin implies, audit same-tx); the knob opens a
  human-merge PR for Kometa; a non-granted forged flag ⇒ FORBIDDEN.

### Open Q-NNs carried to build

ADR-072 / DESIGN-043 Q-01 (cap unit: resolved vs static count) · Q-02 (ticket payload jsonb column vs
side table) · Q-03 (Kometa auto-merge canary flag) · Q-04 (find_missing role rollout) · Q-05
(collection_override ticket in the Helpdesk too?); DESIGN-042 Q-05 (namespacing/live-reconcile marker) ·
Q-06 (ref-preview egress + `--validate-file` connectivity, canary first).

---

*Historical context below (the executed Libretto leg + the Kometa research — superseded by the
direct-add rework above where they describe suggest→approve).*

- **Libretto leg: EXECUTED (2026-07-17).** ADR-070 + DESIGN-043 land the collection manager +
  member contribution surface bound to the PROVEN live Libretto API (the confined `@hnet/libretto`
  client, read/write split; `role_collection_action_grants` with suggest/manage/acquire, Admin-only;
  `collection_suggestions` propose→approve flow; the manager sub-section under /integrations +
  the walls' suggest affordance; migration 0059). Provider-shaped (`provider` column, 'libretto'
  now) so the Kometa leg (being designed in parallel — DESIGN-037 Appendix A step 1) slots in with
  no schema change. PRD R-225..R-227, DDD T-200..T-202.
- **Status:** Intake — RESEARCH LANDED same day
  (`.agents/context/2026-07-16-kometa-integration-research.md`); scope-ready. Research
  verdicts now normative for this plan:
  - **Write path = Git PRs.** Our Kometa collection files are a git-managed ConfigMap
    (haynes-ops `apps/media/kometa/app/config/*.yml`), hot on every run — the managed file
    is pure PR flow, no PVC writes. Only Defaults `template_variables` live in config.yml
    (ExternalSecret seed → PVC, re-seed required) — those knobs are "PR + re-seed"
    owner-approved operations, deferred past v1.
  - **CI gate = `--validate-file`** against the pinned image (v2.4.4; validation framework
    landed v2.4.2). No --dry-run exists; --validate-level full connects but mutates nothing.
  - **Run-now = `kubectl create job --from=cronjob` with `--run --run-files
    "hnet-managed.yml"`** (bounded; the dev-env SA already holds job-create).
  - **Safety contract for the managed file:** namespace collection names (title collision is
    the only cross-file interference), `sync_mode: sync` per collection, expect
    `minimum_items: 2` auto-delete, and canary-test orphan cleanup before shipping delete.
  - **Run-state readback:** K8s Job status (MediaAutomationJobFailed alert exists) +
    meta.log + optionally Kometa's OUTBOUND run_end/error webhook pointed at hnet.
  - **Provider-parity contract (R2) sketched in research §6** — recipe/validate/apply/run/
    read-back nouns the books app implements natively from day one.
- **Owner rulings (2026-07-16, normative):**
  - **R1 — KISS, absolutely.** Kometa configs are complex and take YAML breaking changes; the
    app exposes "limited, basic" control only.
  - **R2 — INTEGRATION PARITY.** "The integration from haynesnetwork should look the same for
    both our new book app and Kometa." One collection-manager integration surface, two (then N)
    providers behind it.
- **Depends on:** 037 (the mirror shows what the managers produce); the research doc (knob
  feasibility + where our Kometa config lives). Relates: 043 (the books app implements the same
  provider contract from day one), 051.

## Shape (to firm up from research)

1. **Never touch hand-written YAML.** The app owns ONE generated *managed include file* that
   Kometa merges (`collection_files` entry); every knob compiles into that file. Breaking-change
   exposure shrinks to a surface we generate against a pinned Kometa version.
2. **Read-only first:** per provider — collections produced (we already mirror those), config
   summary, last-run state/schedule.
3. **Knob candidates (allowlist, research-gated):** enable/disable a managed default collection
   (Kometa `template_variables` are the intended low-touch lever), add/remove a title in a
   static managed collection, schedule tweak, run-now trigger if the deployment shape allows.
4. **Provider contract:** the books app (PLAN-043) implements the same surface — managed config
   fragment + defaults/template-variables + schedule + run-state — so the hnet UI is genuinely
   provider-agnostic (R2).
5. Write path depends on where our Kometa config lives (haynes-ops git vs PVC — research):
   git ⇒ app edits become PRs (audited, reversible); PVC ⇒ a confined write surface in the
   arr-write-guard idiom.

## Out of scope

Full Kometa config editing, raw YAML passthrough, anything the allowlist can't validate.

## Live-contract notes (2026-07-17) — Libretto as the first bound provider

The Libretto surface is now proven live (16 collections: 12 Kavita + 4 ABS, built through the
API this session). What the manager UI binds against, as observed:

- **Save is idempotent `PUT /api/recipes/:id`** (strictObject schema; unknown key → 400 with
  per-path issues). `GET /api/recipes` returns `{recipes, issues}` — invalid recipe FILES
  surface in `issues[]`, never in `recipes[]`.
- **Apply is async and serialized:** `POST /api/apply {scope}` → 202 `{runId}`; poll
  `GET /api/runs/:id`. Run history keeps only the last 50 (losable) — the targets are the
  only source of truth (stateless doctrine holds).
- **Run verdicts:** `warn` is the NORMAL state for a partial library (fires on any missing
  item); treat it as informational in the UI. `counts.matchedByTitle` (D-04 flag) is routinely
  high for Kavita (epubs expose no scheme'd ISBNs) — not a defect indicator.
- **The biggest composer win is ref preview:** a wrong Hardcover slug → run error, but a slug
  resolving to a 0-work CONTAINER series (e.g. `mistborn` vs `the-mistborn-saga`) → silent
  `matched:0`. There is no resolve/preview endpoint today — the UI should search Hardcover and
  show the resolved series name + ordered work count BEFORE save.
- **Delete does not cascade** — a deleted recipe orphans its marker-owned target collection;
  the UI must offer explicit target cleanup.
- **Recipe `id` is global** (filename + marker key), so per-target variants need distinct ids
  (`dune` / `dune-audiobooks`). Enforce global uniqueness in the composer.
- **Judgment gate:** matched ≤1 ⇒ likely wrong ref or an omnibus-only franchise — surface it
  and offer delete (applied as doctrine this session: the 1/5 hunger-games Kavita recipe was
  deleted and its orphaned reading list cleaned).

## Kometa provider scoped (2026-07-17) — DESIGN-042 / ADR-069 (Proposed)

The second provider is now designed (DESIGN-042, Draft; ADR-069, Proposed). It instantiates
the same recipe/validate/apply/run contract Libretto proves live (R2), movies/TV-flavored:

- **Write path RULED: git-PR managed include.** The Kometa collection files are a git ConfigMap
  (haynes-ops `apps/media/kometa/app/config/*.yml`, hot every run) — the app owns ONE
  `hnet-managed-movies.yml` / `-tv.yml`, regenerates its `collections:` block from validated
  recipes, opens a haynes-ops PR. PVC rejected (only the self-rewritten `config.yml` lives there).
  Latency is a batch cadence: Flux reconcile + next Kometa run (`30 6 * * *` NY, or a bounded
  run-now Job `--run-files hnet-managed-*.yml`) + next `collections-sync`. Stated plainly in UI.
- **Allowlist = the live config's builder types, distilled.** Member-suggestible v1 = the six
  single-ref types (`imdb_list`, `tmdb_collection_details`, `tvdb_list_details`, `tmdb_movie`,
  `tmdb_show`, `tvdb_show`) — a validated + previewed ref, NEVER raw YAML. Owner-only:
  `tmdb_discover` / `imdb_chart` / `imdb_search` / `plex_all` (query/search/regex objects, the
  tuned engines). Defaults `template_variables` deferred (PVC re-seed).
- **Roles = the shared `role_collection_action_grants` (books-leg track owns the table):**
  suggest / manage / acquire; `acquire` (`radarr/sonarr_add_missing`) gated hardest — movies pull
  GBs/title. Grouping-only builders can never acquire. Ships Admin-only.
- **Flow = the DESIGN-033 pipeline:** audited `collection_suggestions` row → manage-gated approval
  → git PR (`--validate-file` CI gate, pinned v2.4.4) → Kometa run → `collections-sync` reconciles
  to `live` with `provenance: kometa` (T-194). Ref preview (resolve id/URL → name+count) is the
  top composer win, exactly as on Libretto (a wrong ref silently matches 0; `minimum_items`
  auto-deletes ≤1).
- **Monitor (honest):** Kometa has no inbound API — Job status (`MediaAutomationJobFailed` exists)
  + `meta.log` link; optional outbound `run_end`/`error` webhook → hnet later. No live progress.
- **Phasing:** P0 read-only monitor → P1 inert suggestions → P2 gated apply (grouping-only) →
  P3 gated acquire (owner-held, last). Blast-radius rules: app writes ONLY the managed file, never
  a sibling; namespaced titles; acquisition off by default; run-now scoped to the managed file;
  orphan-cleanup manage-gated + canary-verified.
- **Owner rulings open:** DESIGN-042 Q-01..Q-08 (write-path merge human/auto, suggestible-type cut,
  notification channel, grant rollout, namespacing marker, ref-preview egress, v1-acquires-or-not,
  Defaults/regex advanced surface).
