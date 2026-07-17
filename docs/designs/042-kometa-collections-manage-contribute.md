# DESIGN-042: Kometa collections — manage & contribute (the provider contract instantiated for movies/TV)

- **Status:** Draft
- **Last updated:** 2026-07-17 (owner directive, tonight)
- **Satisfies:** PLAN-052 (collection-manager integration — the provider-agnostic surface, R1 KISS /
  R2 integration-parity); owner directive 2026-07-16: "apply the same concept to Kometa though it's
  more complex — keep it distilled to the types of collections / builders I am using now but let
  users hook in their own thing … edits pose some risk of pulling a ton of content so we should gate
  them depending on peoples role."
- **Governed by:** **ADR-069** (this design's decision — the Kometa contribution contract) on top of
  **ADR-064** (mirror-only doctrine: external software owns collections; the app authors a Kometa
  RECIPE, never a Plex collection directly), **ADR-062 / DESIGN-033** (the books-Fix suggest → audited
  row → role-gated action precedent this ports), **ADR-023 / ADR-059** (the `role_*_action_grants`
  machinery + `*ActionProcedure` gate), **hard rules 4** (the *arrs / external software are the source
  of truth; the only write-back is explicit), **6** (mutations write audit rows in the same tx),
  **8/9** (Modal for explanatory confirms; no reflow).
- **Companions:** **DESIGN-035** (the Movies/TV Plex-collections mirror this reads back through — the
  produced-collection surface + `provenance: kometa`), **DESIGN-037 / Libretto** (the sibling bound
  provider — the same recipe/apply/run contract, books-flavored), **DESIGN-038** (the books collections
  contribution surface this mirrors in shape).

## Overview

The estate already **mirrors** the 461 Plex collections (457 Kometa-managed) into the Movies/TV walls
(DESIGN-035, read-only). This design adds the WRITE half for the Kometa provider: a **member can
suggest a new collection, a manage-granted user can approve it, the approval becomes a haynes-ops
git PR, Flux applies it, the next Kometa run produces the collection, and the existing
`collections-sync` mirrors it back** with `provenance: kometa`. It is the DESIGN-035 mirror's
contribution loop, and it is the SAME provider contract Libretto already proves live on the books
side (PLAN-052 R2) — one manager UI, two providers.

Three constraints shape every decision:

1. **Mirror-only stays intact (ADR-064).** The app never writes a Plex collection. It writes a Kometa
   *recipe* (a collection definition in Kometa's YAML) into one app-owned file; Kometa is still the
   thing that builds the collection, and DESIGN-035 is still the only read path. The write surface is a
   config recipe, not a collection.
2. **Distilled to exactly the owner's builder types (R1).** Kometa's builder taxonomy is enormous and
   churns (the research doc's breaking-change history). The app allowlists EXACTLY the builder types
   the live config uses today (D-04) and nothing else. "Hook in your own thing" means a member picks an
   allowlisted builder type and supplies a *validated ref* (an IMDb list URL, a TMDb collection id) —
   **never raw YAML passthrough** (ADR-069).
3. **Role-gate the blast radius (owner directive).** A movie pulls gigabytes per title. An edit that
   flips `radarr_add_missing` on can fill Radarr with an entire IMDb list, a whole studio catalogue, or
   a chart that refreshes forever (the 2026-07-10 theatrical-window flood is the estate's own scar).
   So the write actions are gated `suggest` / `manage` / `acquire`, and `acquire` — the builders that
   RADARR/SONARR-request missing titles — is gated hardest (D-06).

## Detailed design

### D-01 — The provider contract, instantiated for Kometa

PLAN-052 §6 defines the provider-agnostic nouns (`recipe`, `validate`, `apply`, `run`, `produced
collections`). This is what each noun MEANS Kometa-side:

- **Recipe** = one Kometa **collection definition** — a single entry under `collections:` in a
  `collection_files` YAML file: a namespaced title + a builder + its ref + a bounded set of variables
  (`{ id, provider: 'kometa', targetLibrary, name, builder: { type, ref }, variables: { syncMode,
  collectionOrder, acquisitionEnabled, tag, schedule }, enabled }`). This is the SAME shape as a
  Libretto recipe (PLAN-052 §6.2) with a Kometa discriminator; the composer form and the tRPC router
  are shared, the builder allowlist (D-04) is provider-specific.
- **Read — what the app can safely see** (two layers, both already in the estate):
  - **Produced collections** — DESIGN-035's mirror. Already synced, already gated (ADR-047), already
    carrying `provenance: kometa` (T-194). This is the "what Kometa actually built" truth and needs no
    new read.
  - **The config's collection definitions** — the app-owned managed file is git (D-02), so the app
    reads back exactly what it wrote (its own recipes). It does NOT parse the owner's hand-written
    sibling files; those are context it never edits (the DESIGN-035 mirror already shows what they
    produced). Reading the app's own managed file back is the recipe-list source of truth, the Libretto
    `GET /api/recipes` analog.
- **Write** = compile the enabled recipes into the ONE managed include file and open a haynes-ops PR
  (D-02). A write is a config change, applied by Flux, realized by the next Kometa run — never a live
  Plex mutation.

### D-02 — The write path: git-PR managed include (RECOMMENDED), not PVC

**Recommendation: git-PR writes to a single app-owned managed include file.** The research is
decisive on where the config lives (research §4, verbatim): the Kometa **collection/overlay files are a
git-managed ConfigMap** (`haynes-ops` `kubernetes/main/apps/media/kometa/app/config/*.yml` via
`configMapGenerator`), mounted read-only at `/config/git`, **hot on every run**. Only `config.yml`
itself lives on the PVC (an ExternalSecret seed that Kometa self-rewrites — the Defaults'
`template_variables` are there, and are a separate "PR + re-seed" story, deferred).

So the app owns exactly ONE new file in that ConfigMap — `hnet-managed-movies.yml` /
`hnet-managed-tv.yml` — appended to each library's `collection_files` list once, by hand, at
bootstrap. Every app write regenerates that file's `collections:` block and opens a PR against
haynes-ops. Consequences:

- **Audited + reversible + Flux-applied.** A git PR is the estate's native audit trail; a bad recipe is
  `git revert`; nothing touches the PVC or a live process.
- **No YAML the app didn't generate.** The app serializes from the validated recipe model (D-05); the
  file is machine-owned, header-stamped "generated by haynesnetwork — do not hand-edit."
- **Honest latency (the cost).** A member suggestion that a manager approves does NOT appear
  immediately. The pipeline is: PR merges → **Flux reconcile** (the ConfigMap redeploys, minutes) →
  the **next Kometa run** produces the Plex collection (the `collections` CronJob is `30 6 * * *`
  America/New_York daily; or a bounded run-now Job, D-08) → the **next `collections-sync`** mirrors it
  back (DESIGN-035 T-181). End to end, a suggestion is visible after a Flux cycle plus a Kometa run
  plus a mirror sync — a scheduled-batch cadence, not a request/response. The UI must say so plainly
  ("Approved. It will appear after the next collection run" — no time-grounding, owner tone). This is
  the deliberate tradeoff for the GitOps audit trail, and it is acceptable because collections are
  curation, not a live action.

**PVC writes are rejected** for the managed file: the collection files are not on the PVC (they are the
git ConfigMap), and the one thing that IS on the PVC — `config.yml` — is self-rewritten by Kometa every
run, so an app write there races the process and needs a re-seed to land. Git is both where the config
lives AND the estate's doctrine (research §4; PLAN-052 write-path verdict). See ADR-069 for the full
options table.

### D-03 — The managed include safety contract

The research §1 "single managed file is fully supported" contract, applied verbatim so the app file can
never disturb the owner's hand-written siblings:

- **Namespace every collection name.** Collections key by Plex title; a title collision with a sibling
  file silently merges (the estate exploits this deliberately for franchise dedup). The managed file
  MUST namespace its titles so it can never collide — a stable prefix the mirror can also recognize
  (proposal: the recipe carries the display title the owner wants, but the Kometa collection name is
  suffixed/marked so app-authored collections are unambiguous — Q-05 on the exact convention, weighing
  it against the DESIGN-035 provenance label which already distinguishes `kometa` but not
  app-authored-within-kometa).
- **`sync_mode: sync` per managed recipe** (the global is already `sync`) so a list-backed collection
  mirrors its ref exactly rather than append-growing.
- **Expect `minimum_items: 2` + `delete_below_minimum: true`** (global): a recipe whose ref resolves to
  0–1 matched titles auto-deletes. The composer must surface this (the Libretto "matched ≤1 ⇒ likely
  wrong ref" judgment gate, live-contract note) as a pre-save warning via ref preview (D-05).
- **Removal orphans, does not delete.** Removing a recipe from the managed file ORPHANS its Plex
  collection (research §1.4, exact orphan semantics UNVERIFIED — canary first). The delete flow must
  offer explicit target cleanup (the Libretto "delete does not cascade" live-contract lesson), and this
  is a `manage`-gated action, never automatic.
- **CI-gate every generated file with `--validate-file`** against the pinned image (v2.4.4; the
  validation framework landed v2.4.2) BEFORE the PR can merge (D-09). No `--dry-run` exists; nearest is
  `--validate-level full` (connects to Plex/APIs, mutates nothing).

### D-04 — Distillation: the builder allowlist IS the owner's current builder types

Enumerated from the LIVE config (`haynes-ops apps/media/kometa/app/config/*.yml`, read this session).
The allowlist is EXACTLY these types — a builder Kometa supports but the owner does not use is not
offered:

| Builder type | Where it lives now | Ref shape | Acquisition-capable? | Member-suggestible v1? |
|---|---|---|---|---|
| `imdb_list` | Christmas HNet, Roald Dahl, J-Horror, Addams Family, Monsterverse | an IMDb list URL (`imdb.com/list/ls\d+/`) | **Yes** (add_missing can pull the whole list) | **Yes** — validated URL + ref preview |
| `tmdb_collection_details` | movies-franchises (Addams, Goosebumps, Fantastic Four, …) | a TMDb collection id (int) | **Yes** | **Yes** — id resolves to a name + member count preview |
| `tvdb_list_details` | shows-franchises (Arrowverse, Band of Brothers, The Boys, …) | a TVDb list URL | **Yes** | **Yes** — validated URL + preview |
| `tmdb_movie` | Unbreakable, Addams augment | a list of TMDb movie ids | **Yes** | **Yes** — manual id curation |
| `tmdb_show` | Curated for Jackson/Kellie/Penelope, Kid Cartoons | a list of TMDb show ids | **Yes** | **Yes** — manual id curation |
| `tvdb_show` | Curated family lists, Earth & Space Wonders | a list of TVDb show ids | **Yes** | **Yes** — manual id curation |
| `tmdb_discover` | movies-charts (sort_by + `with_original_language` + `vote_count.gte`); movies-people (`with_crew`/`with_cast`) | a query OBJECT (many knobs) | **Yes** (charts pull; the 2023 flood source) | **No v1** — owner-only (it is the chart/people engine, not a ref) |
| `imdb_chart` | IMDB Popular, IMDB Top 250 | a named chart enum | **Yes** (continuous for "Popular") | **No v1** — owner-only |
| `imdb_search` | A24, Disney/DreamWorks Animation (company ids) | a search OBJECT (company/keyword) | **Yes** (whole catalogue) | **No v1** — owner-only |
| `plex_all` + `filters` | Spatial Surround, Dolby Atmos, DTS X | library-filter regexes | **No** — groups EXISTING media only | **No v1** — owner-only (regex, not a ref) but inherently acquisition-safe |
| Kometa Defaults (`- default:`) | config.yml: universe, seasonal, oscars, golden (acquire ON), franchise (OFF) | a default name + `template_variables` | Yes (per-default) | **No** — lives on the PVC config.yml (re-seed), deferred past v1 (PLAN-052) |

**The member-suggestible set (v1 proposal, Q-02):** `imdb_list`, `tmdb_collection_details`,
`tvdb_list_details`, `tmdb_movie`, `tmdb_show`, `tvdb_show` — the six that reduce to a **single
validated ref** (a URL or an id/id-list). Each is a "hook in your own thing" lever: a member proposes
"a collection built from THIS IMDb list / THIS TMDb collection". The four owner-only types
(`tmdb_discover`, `imdb_chart`, `imdb_search`, `plex_all`) are query/search/regex OBJECTS, not refs —
they are the estate's tuned acquisition engines and stay authored by the owner in the hand-written
files (or a later advanced surface). Defaults toggling is its own PVC story.

**Ref validation (no raw YAML — ADR-069).** The app never accepts a YAML fragment. It accepts a typed
ref, validates it structurally (URL matches the builder's host/path grammar; ids are integers), and —
the Libretto ref-preview lesson (live-contract note: a wrong slug silently matches 0) — RESOLVES it
before save to show the human what it will build: TMDb collection id → collection name + film count;
IMDb/TVDb list URL → list title + item count. A ref that resolves to 0–1 items is flagged (the
`minimum_items` auto-delete, D-03). The resolve calls ride existing/allowlisted egress (TMDb is already
a Kometa connector; IMDb/TVDb list resolution TBD — Q-06 on the preview data source and its egress
allowlist entry).

### D-05 — The recipe composer (the write model)

A recipe compiles deterministically to one `collections:` entry. Example — a member suggests an IMDb
list, grouping-only:

```yaml
# in hnet-managed-movies.yml (generated — do not hand-edit)
collections:
  "<namespaced title>":
    imdb_list: https://www.imdb.com/list/ls012345678/
    sync_mode: sync
    collection_order: custom
    radarr_add_missing: false        # acquisitionEnabled = false ⇒ grouping-only
    radarr_tag: "Kometa-Added,HNet-Suggested"
```

The composer enforces: builder in the allowlist (D-04), ref validated + previewed (D-04), `id` globally
unique (the Libretto "recipe id is global" lesson — filename + collection-name key; per-target variants
need distinct ids), title namespaced (D-03), and `acquisitionEnabled` defaulting **false** and gated by
the `acquire` grant (D-06). `variables` is a closed set — `syncMode`, `collectionOrder`, `tag`,
`schedule` (validated against the Kometa grammar; display-note only — the CronJob owns cadence, PLAN-052
§6.3), `acquisitionEnabled` — never free YAML.

### D-06 — Role gating: `role_collection_action_grants` (suggest / manage / acquire)

Aligned with the books leg's action-grant model being built in parallel tonight (the
`role_books_action_grants` / `setRoleBookActions` / `bookActionProcedure` shape, DESIGN-033 D-03; the
shared `role_collection_action_grants` table is that agent's to define — this design CONSUMES it,
Kometa-side, and does not mint its own). Three actions, escalating:

- **`suggest`** — create a PENDING collection suggestion (an audited row; no config write, no PR). The
  low-trust entry point; safe to open to member roles because a suggestion is inert until approved.
- **`manage`** — approve/reject a suggestion and edit/remove managed recipes; approval is what opens
  the haynes-ops PR (D-07). Higher trust — a manager's approval writes config.
- **`acquire`** — the privileged flag: enable `radarr_add_missing`/`sonarr_add_missing` on a recipe
  (or approve a suggestion that requests acquisition). This is the "pull a ton of content" lever the
  owner called out.

**Why acquire is gated hardest — and why the rationale is stronger here than for books.** On the books
side a mistaken pull is an epub (megabytes). Here a single approved `imdb_list` with acquisition on can
enqueue an entire list into Radarr — the estate's own 2023 charts flooded Radarr with foreign titles,
and the 2026-07-10 theatrical-window incident (re-importing "Chum" the morning after a sweep deleted it)
is exactly this failure. **Movies pull gigabytes per title**; the blast radius of one wrong acquire
toggle is measured in the storage budget. So:

- The **grouping-capable** builders (`plex_all`) can NEVER acquire — structurally safe regardless of
  grant.
- The **acquisition-capable** builders (all six suggestible types) default `acquisitionEnabled: false`.
  Turning it on requires `acquire`. Approving a suggestion that ASKS for acquisition requires `acquire`
  (a `manage`-only approver can approve the grouping-only version but cannot grant its acquisition).
- Ships **Admin-only** (empty grant table — the DESIGN-033 default), then opened per the owner's ruling
  (Q-04). The natural rollout mirrors the books Fix: `suggest` to member roles early, `manage` to
  trusted roles, `acquire` held by the owner / admin for a long time (Q-04).

The API gate is `collectionActionProcedure('suggest'|'manage'|'acquire')` composed on the Movies/TV
surface, the `bookActionProcedure` idiom. Every grant mutation writes a `permission_audit` row in the
same transaction (hard rule 6). Every suggestion state transition writes an audit row (D-07).

### D-07 — The contribution flow (mirror of the books suggest → approve pipeline)

The DESIGN-033 lifecycle, collection-shaped:

1. **Suggest** (`suggest` grant) — a member fills the composer (builder + validated + previewed ref +
   grouping-only by default). A `collection_suggestions` row is written with `status: pending` in ONE
   transaction with its audit row (hard rule 6), BEFORE anything external. Carries the requester
   snapshot, the recipe payload (builder/ref/variables), and the target library.
2. **Review** (`manage` grant) — a manager sees the pending suggestion with its ref preview (resolved
   name + item count + the `minimum_items` warning if ≤1). Reject → `status: rejected` + audit (the
   requester is notified — Q-03 on channel). Approve → step 3. If the suggestion requests acquisition,
   approval requires `acquire` (D-06); a `manage`-only approver can approve it as grouping-only.
3. **Write** (approval side effect) — the domain single-writer recompiles the managed include from all
   enabled recipes and opens a **haynes-ops PR** (D-02) via the dev-bot app token; the suggestion moves
   to `status: approved_pending_apply` with the PR URL recorded. The PR runs `--validate-file` (D-09);
   a red validation blocks merge and flips the suggestion to `apply_failed` with the validator output
   (honest failure, the DESIGN-033 `failed` idiom). **This design does not auto-merge the haynes-ops
   PR** — Q-01 asks whether merge is human (a real person merges the config PR — the safest, and the
   estate's GitOps norm) or app-armed.
4. **Kometa run** — on the next `collections` CronJob (or a bounded run-now Job, D-08) Kometa produces
   the Plex collection from the merged managed file.
5. **Mirror picks it up** — the next `collections-sync` (DESIGN-035 T-181) mirrors the new collection
   with `provenance: kometa` (T-194 — it carries the `Kometa` Plex label like every Kometa collection).
   The suggestion reconciles to `status: live` when its produced collection appears in the mirror
   (matched by the namespaced title / a recorded marker — Q-05). The member sees their collection on
   the Movies/TV Collections wall, provenance-badged, exactly like every other mirrored collection.

The suggestion row is the durable audit spine across the async gap (the DESIGN-033 `book_fix_requests`
precedent — a row that outlives the external round-trip and records every step in an `actions_taken`
trail: pending → PR opened (url) → validated → merged → run → mirrored).

### D-08 — The monitor story (what Kometa honestly exposes)

Kometa is a **batch process with NO inbound API/UI/daemon** (research §2). What the app can truthfully
show about a run:

- **Job status** — the three CronJobs are Kubernetes Jobs; `MediaAutomationJobFailed` already alerts on
  kometa job failure (research §4). The app can read last-run/last-success/status from Job state (the
  read-only kubectl SA covers get/list/watch). This is the honest "last collection run" surface.
- **`meta.log`** — `/config/logs/meta.log` on the PVC holds the run detail; a link/tail is the
  deepest honest signal (no per-collection results API exists).
- **Outbound webhook (optional upgrade)** — Kometa's `run_start`/`run_end`/`error`/`changes` webhooks
  are OUTBOUND-only; pointing `run_end`/`error` at an hnet endpoint would give the app a run-state
  readback without polling (research §3.7, §6.4). Deferred — Job status + meta.log is enough for v1.
- **Run-now** — a bounded `kubectl create job --from=cronjob/kometa-collections … -- --run --run-files
  "hnet-managed-movies.yml"` (the dev-env SA holds job-create per the pod capabilities memo) lets a
  `manage` user trigger an immediate scoped run of ONLY the managed file after an approval, shortening
  the latency (D-02) without waiting for 06:30. Scoped to the managed file so it can never re-run the
  owner's heavy overlay/operation passes.

**What Kometa CANNOT give** (say so in the UI): live progress, a per-collection result API, or any state
change without starting a process. The monitor is "last run + logs + did-it-fail", not a progress bar.

### D-09 — Validation strategy (a bad recipe can break the whole run)

A malformed managed file can fail the entire Kometa run (all collections), so validation is layered:

- **Compose-time** — the recipe model is a closed schema (D-05); ref structural validation + resolve
  preview (D-04) catches wrong ids/URLs before a row is even written.
- **CI gate (the hard gate)** — the haynes-ops PR runs `--validate-file hnet-managed-*.yml` against the
  PINNED image (v2.4.4). `--validate-file`/`--validate-dir` validate ONE generated file against its
  JSON schema, exit 0/1 (research §2). A red gate blocks merge — a bad recipe never reaches the pod.
  Alternatively (or additionally) the JSON schemas Kometa ships (`json-schema/`) can validate app-side
  before the PR (Q-06 on which, and on `--validate-file`'s connectivity needs at syntax/structure
  level — an UNVERIFIED from the research; canary first).
- **Blast-radius rules (never touch what the owner depends on):**
  - The app writes ONLY `hnet-managed-*.yml`; it never reads, edits, or regenerates a hand-written
    sibling file. The owner's charts/franchises/people/lists are out of the write surface entirely.
  - Namespaced titles (D-03) guarantee no collision-merge into a sibling collection.
  - `acquisitionEnabled` defaults false and is `acquire`-gated (D-06) — the storage blast radius is
    off by default.
  - Run-now is scoped to the managed file (D-08) — an app-triggered run can never re-run the heavy
    overlay/operation passes.
  - Orphan cleanup on delete is `manage`-gated and canary-verified (D-03), never automatic.

## Sequencing + risk (phases)

1. **Phase 0 — read-only monitor.** Surface Kometa's honest run-state (Job status + meta.log link,
   D-08) on the Movies/TV Collections surface, beside the existing mirror. No write path, no grants.
   Proves the provider "run" noun with zero blast radius.
2. **Phase 1 — suggestions (inert).** The composer + `collection_suggestions` table + `suggest` grant.
   Members propose grouping-only recipes; managers see them; NOTHING writes config yet (approval is a
   no-op stub or opens a PR a human must merge). Proves the flow end to end with the acquisition lever
   still dark.
3. **Phase 2 — gated apply (grouping-only).** Approval opens the haynes-ops PR (D-07) for grouping-only
   recipes; `--validate-file` CI gate; the mirror reconciles the produced collection to `live`. Still
   no acquisition — the storage blast radius stays off.
4. **Phase 3 — gated acquire.** The `acquire` grant + `acquisitionEnabled` toggle, owner-held. This is
   the "ton of content" surface and lands last, behind the hardest gate, after Phases 1–2 have proven
   the pipeline safe.

Risk register: the async latency (D-02) is a UX-honesty risk, not a safety one — say it plainly. The
orphan-on-remove and `--validate-file` connectivity items are UNVERIFIED (research §"Open") — canary
before relying. Auto-merge of config PRs (Q-01) is the sharpest open decision: human-merge is safest.

## Alternatives considered

- **PVC writes to the managed file** — rejected: the collection files are the git ConfigMap, not the
  PVC; the only PVC file (`config.yml`) is self-rewritten by Kometa and races app writes (D-02, ADR-069).
- **Raw-YAML passthrough ("advanced mode")** — rejected (ADR-069): unbounded blast radius, exposes the
  full churning builder taxonomy, defeats validation. The allowlist + validated ref is the whole point
  of R1 (KISS).
- **App-native collection authoring (write Plex directly)** — rejected permanently by ADR-064 (the
  mirror-only doctrine): the app writes a Kometa recipe, Kometa owns the collection.
- **Exposing `tmdb_discover` / `imdb_search` to members** — rejected v1: they are query/search objects
  (the tuned acquisition engines behind the 2023 flood), not refs; owner-authored only (D-04).
- **Auto-applying Defaults `template_variables`** — deferred (PLAN-052): they live on the self-rewritten
  PVC `config.yml` and need a re-seed; a "PR + re-seed" owner operation, not a member lever.
- **A live Kometa progress UI** — impossible: Kometa has no inbound API/daemon (D-08). The monitor is
  last-run + logs, honestly.

## Test strategy

- **Domain (packages/domain)** — the recipe compiler is a pure function: allowlisted builder + validated
  ref → the expected `collections:` YAML entry; `acquisitionEnabled: false` emits `radarr_add_missing:
  false`; a non-allowlisted builder or an unvalidated ref REJECTS; global `id` uniqueness bites; title
  namespacing applied. Suggestion lifecycle: row + audit in ONE tx before any external call (the
  DESIGN-033 atomicity test); approve-with-acquisition without the `acquire` grant REJECTS.
- **Grant gate (packages/api)** — `collectionActionProcedure` matrix: no grant ⇒ FORBIDDEN;
  `suggest` can create but not approve; `manage` can approve grouping-only but not enable acquisition;
  `acquire` can; admin bypasses; every mutation writes `permission_audit`.
- **Validation** — a malformed generated file fails `--validate-file` (fixture against the pinned
  schema); a valid one passes; the CI gate blocks a red PR (the flow, mocked git).
- **Mirror reconcile (packages/sync)** — a produced managed collection appears in `collections-sync`
  with `provenance: kometa` and reconciles its suggestion to `live` (extends the DESIGN-035 battery).
- **e2e (advisory)** — suggest → (manager) approve grouping-only → PR opened (stub git) → mirrored →
  card appears on the Collections wall with the provenance badge; no-grant ⇒ no affordance
  (server-enforced); ADR-015 no-reflow across the suggestion state flips.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | **Write-path merge ruling:** does an approved suggestion's haynes-ops PR merge by a HUMAN (safest, GitOps norm) or app-armed auto-merge after `--validate-file` green? | OPEN — owner ruling. Design leans human-merge for v1 (config PRs are owner territory); auto-merge is a Phase-2+ convenience if the validator is trusted. |
| Q-02 | **Which builder types are member-suggestible v1?** Proposed: the six single-ref types (`imdb_list`, `tmdb_collection_details`, `tvdb_list_details`, `tmdb_movie`, `tmdb_show`, `tvdb_show`); owner-only for `tmdb_discover`/`imdb_chart`/`imdb_search`/`plex_all`. | OPEN — owner ruling. The list is derived from the live config (D-04); owner confirms the cut. |
| Q-03 | **Approval SLA / notification:** how is a member told their suggestion was approved/rejected/went live? A Ticket? The `notification_outbox` email channel (T-173)? In-app only? | OPEN — owner ruling. The outbox email channel + notification-preference machinery already exists (T-173/T-174) and is the cheap reuse. |
| Q-04 | **Grant rollout:** which roles get `suggest` / `manage` / `acquire`, and when? | OPEN — owner ruling. Ships Admin-only (empty grants, DESIGN-033 default). Natural path: `suggest` to members early, `manage` to trusted roles, `acquire` owner-held long-term (the storage blast radius). |
| Q-05 | **Namespacing + live-reconcile marker:** the exact convention that (a) prevents title collision with sibling files and (b) lets `collections-sync` match a produced collection back to its suggestion. A title prefix? A recipe-id marker (the Libretto `[libretto:<id>]` idiom, but Kometa collections carry no app-writable description the sync reads today — the DESIGN-035 provenance is a Plex LABEL). | OPEN. Options: a stable title prefix the mirror strips for display; or add an app label the managed recipe applies (`label:`) that `readCollectionLabels` (T-194) already reads. Favor the label — it does not uglify the display title. |
| Q-06 | **Ref-preview data source + egress:** resolving a TMDb collection id → name/count is a TMDb call (already a Kometa connector); resolving an IMDb/TVDb list URL → title/count needs a data source and an egress-allowlist entry (CiliumNetworkPolicy `dev-env`). Which source, and add the allowlist via a haynes-ops PR? | OPEN. TMDb is in-hand; IMDb/TVDb list resolution TBD (scrape vs an API). `--validate-file` connectivity needs at syntax/structure level are also UNVERIFIED (research §Open) — canary first. |
| Q-07 | **Do Kometa suggestions create Radarr/Sonarr wants at all in v1, or grouping-only first?** The "ton of content" risk. | OPEN — owner ruling. Design sequences acquisition to Phase 3 (grouping-only through Phase 2); the safe default is grouping-only until the pipeline is proven. |
| Q-08 | **TV `plex_all`/regex and Defaults toggling** — out of the member surface, but is an owner-only advanced managed surface wanted later, or do these stay hand-authored in haynes-ops? | DEFERRED. Hand-authored today; a later owner-only advanced surface is possible but out of this design's KISS scope (R1). |
