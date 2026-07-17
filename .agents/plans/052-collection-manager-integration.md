# PLAN-052: Collection-manager integration — Kometa knobs + provider-agnostic UI

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
