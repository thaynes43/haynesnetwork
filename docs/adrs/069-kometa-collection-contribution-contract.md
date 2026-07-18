# ADR-069: Kometa collection contribution — git-PR managed include, allowlisted builders with validated refs, acquisition-gated roles

- **Status:** Superseded by ADR-072 <!-- was Proposed; the propose→approve suggestion pipeline is retired by the 2026-07-18 direct-add rulings (ADR-072). The write-path spine (git-PR managed include, allowlisted builders, validated refs, mirror-only) survives there, re-pointed at direct-add + auto-merge. -->
- **Date:** 2026-07-17
- **Deciders:** Tom Haynes (owner directive 2026-07-16: "apply the same concept to Kometa … keep it
  distilled to the types of collections / builders I am using now but let users hook in their own thing
  … gate them depending on peoples role") · scoped by the PLAN-052 research (config lives in git;
  `--validate-file`; managed-file safety contract) · realized by **DESIGN-042**.
- **Relates:** EXTENDS **ADR-064** (mirror-only: external software owns collections) with a WRITE half
  that stays inside the doctrine — the app writes a Kometa RECIPE, never a Plex collection; builds on
  **ADR-062 / DESIGN-033** (the books-Fix suggest → audited row → role-gated action pattern this
  ports), **ADR-023 / ADR-059** (the `role_*_action_grants` + `*ActionProcedure` machinery), and
  **hard rules 4** (external software is the source of truth; the only write-back is explicit) **and 6**
  (audit rows in the same transaction). Implements PLAN-052 (R1 KISS, R2 provider-parity).

## Context and problem statement

DESIGN-035 mirrors the estate's 461 Plex collections (457 Kometa-managed) into the Movies/TV walls,
read-only, under ADR-064's doctrine: external software owns collections, the app only mirrors. The
owner now wants the WRITE half — members should be able to contribute collections — but with three
hard constraints, near-verbatim: keep it **distilled to the builder types I use now**, let users
**hook in their own thing**, and **gate edits by role because they can pull a ton of content**.

Kometa is materially harder to write against than the books-side Libretto (which is an app the estate
owns, with a native `/api/recipes` write API). Kometa is a batch process with no inbound API, an
enormous and churning builder taxonomy (the research doc's breaking-change history), a hybrid config
(git ConfigMap for collection files, a self-rewritten PVC `config.yml`), and an acquisition surface
that requests missing titles into Radarr/Sonarr — where a single wrong edit can enqueue an entire list
of gigabyte-scale movies (the estate's own 2023 chart flood and the 2026-07-10 theatrical-window
incident are the scars).

The decision: HOW does the app write a Kometa collection safely — the write path, the write vocabulary,
and the authorization model?

## Decision drivers

- **Mirror-only must survive (ADR-064).** No app-authored Plex collections. The write target must be a
  Kometa config artifact that Kometa then applies, keeping Kometa the source of truth.
- **KISS + distilled (owner R1).** The full builder taxonomy churns and is dangerous; expose only what
  the owner uses, and only as far as a validated ref — not raw YAML.
- **Blast radius is storage (owner directive).** Movies pull gigabytes per title; the acquisition
  toggle is the sharp edge. Gating must be strongest exactly there.
- **GitOps doctrine (CLAUDE.md; the estate).** Cluster changes go through git + Flux; a PR is the
  native audit trail and revert path.
- **Provider parity (PLAN-052 R2).** The same contract Libretto already proves live — one manager UI,
  two providers.
- **Config location is settled (research §4).** Collection files are a git-managed ConfigMap, hot every
  run; `config.yml` is a self-rewritten PVC seed.

## Considered options

**Write path:**
1. **Git-PR writes to ONE app-owned managed include file** (chosen). The app owns a single
   `hnet-managed-*.yml` in the haynes-ops Kometa ConfigMap, regenerates it from validated recipes, and
   opens a PR; Flux applies it, the next Kometa run produces the collection, `collections-sync` mirrors
   it back.
2. **PVC writes.** Rejected: the collection files are not on the PVC; the only PVC file (`config.yml`)
   is self-rewritten by Kometa every run and races app writes, needing a re-seed to land.

**Write vocabulary:**
3. **Allowlisted builder types + a validated, previewed ref** (chosen). Exactly the builder types the
   live config uses; a member supplies a URL or id, structurally validated and resolved to a preview.
4. **Raw-YAML passthrough / an "advanced mode".** Rejected: unbounded blast radius, exposes the full
   churning taxonomy, defeats validation — the opposite of R1.

**Authorization:**
5. **Three-action role grants `suggest` / `manage` / `acquire`** (chosen), the DESIGN-033
   `role_*_action_grants` machinery, with `acquire` (enabling `radarr/sonarr_add_missing`) gated
   hardest. Aligned with the parallel `role_collection_action_grants` the books leg is building.
6. **Ownership/section gating only** (a single "can edit collections" flag). Rejected: it cannot
   separate the inert act of suggesting from the storage-consuming act of acquiring — the owner's
   explicit ask.

## Decision outcome

Chosen: **1 + 3 + 5** — a git-PR write to one app-owned managed include file, a builder allowlist of
exactly the owner's current types written only via validated refs, authorized by the three-action
`suggest`/`manage`/`acquire` grant model with acquisition gated hardest.

- **The app owns ONE managed include** (`hnet-managed-movies.yml` / `-tv.yml`) in the git ConfigMap; it
  never reads, edits, or regenerates a hand-written sibling file. It regenerates its own file from the
  enabled recipes and opens a haynes-ops PR (DESIGN-042 D-02).
- **The managed-file safety contract holds** (research §1): namespaced titles (no collision-merge),
  `sync_mode: sync`, expect `minimum_items` auto-delete, orphan-cleanup-on-remove is manage-gated and
  canary-verified, and every generated file is CI-gated with `--validate-file` against the pinned image
  before merge (DESIGN-042 D-03/D-09).
- **The allowlist is exactly the live config's builder types** (DESIGN-042 D-04). Member-suggestible v1:
  the six single-ref types (`imdb_list`, `tmdb_collection_details`, `tvdb_list_details`, `tmdb_movie`,
  `tmdb_show`, `tvdb_show`). Owner-only: `tmdb_discover`, `imdb_chart`, `imdb_search`, `plex_all` (query
  /search/regex objects, not refs — the tuned acquisition engines). Defaults toggling is deferred (PVC
  re-seed).
- **Refs are validated and previewed, never raw YAML** — the composer resolves an id/URL to a name +
  member count before save (the Libretto ref-preview lesson: a wrong ref silently matches 0).
- **`acquire` gates the storage blast radius.** Acquisition-capable recipes default
  `acquisitionEnabled: false`; enabling it (or approving a suggestion that asks for it) requires the
  `acquire` grant, held by the owner/admin long-term. Grouping-only builders (`plex_all`) can never
  acquire, structurally.
- **The contribution flow is the DESIGN-033 pipeline** (DESIGN-042 D-07): audited `pending` suggestion →
  manage-gated approval → the git PR → Kometa run → the mirror reconciles it to `live` with
  `provenance: kometa`.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: ADR-064 survives intact — there is still NO app→Plex collection write. The app writes a Kometa recipe; Kometa produces the collection; DESIGN-035 remains the only read path. The mirror can never drift from Kometa by app action. |
| C-02 | Good: every write is a git PR — audited, `git revert`-able, Flux-applied, human-reviewable. No PVC race, no live-process mutation. The estate's GitOps audit trail is the collections audit trail. |
| C-03 | Cost/accepted: **latency.** A suggestion→visible round-trip is a Flux reconcile + the next Kometa run (daily 06:30 NY, or a bounded run-now Job) + the next `collections-sync` — a scheduled-batch cadence, not request/response. The UI must state this plainly (owner tone). Acceptable because collections are curation, not a live action. |
| C-04 | Good: the blast radius is off by default and gated exactly where it bites — `acquisitionEnabled: false` unless `acquire`-granted. The 2023-flood / theatrical-window class of incident cannot originate from a member suggestion. |
| C-05 | Good/accepted: the allowlist is deliberately narrow (six suggestible types). A builder Kometa supports but the owner does not use is not offered; the owner's tuned query/search/regex collections stay hand-authored. This is R1 (KISS) as a structural property, at the cost of expressiveness the owner did not ask for. |
| C-06 | Neutral: a bad recipe can fail the WHOLE Kometa run, so validation is layered (compose schema → ref preview → `--validate-file` CI gate on the pinned image). `--validate-file` connectivity needs and orphan-on-remove semantics are UNVERIFIED (research §Open) — canary before relying. |
| C-07 | Good: provider parity (PLAN-052 R2) — the recipe/validate/apply/run/read-back nouns are the Libretto contract with a `kometa` discriminator; one composer + router serves both, the allowlist is the only Kometa-specific surface. |
| C-08 | Accepted: this ADR is **Proposed**, not Accepted — the write-path/no-raw-YAML/role-gate spine is decided, but the merge ruling (human vs auto), the suggestible-type cut, the grant rollout, notification channel, and namespacing/preview details await owner rulings (DESIGN-042 Q-01..Q-07). It is ratified once those land. |

## More information

- Realized by **DESIGN-042** (contract D-01, write path D-02, safety contract D-03, allowlist D-04,
  composer D-05, role gate D-06, flow D-07, monitor D-08, validation/blast-radius D-09, phasing).
- Live config read this session: `haynes-ops kubernetes/main/apps/media/kometa/app/config/*.yml`
  (charts/collections/franchises/lists/people/shows) — the builder-type source for the allowlist.
- Research: `.agents/context/2026-07-16-kometa-integration-research.md` (config model, the managed-file
  safety contract, `--validate-file`, the git-vs-PVC finding, the provider-parity contract).
- Precedent: **ADR-062 / DESIGN-033** (books Fix suggest → role-gated action), **DESIGN-037 / Libretto**
  (the sibling provider's live contract), **ADR-064 / DESIGN-035** (the mirror this reads back through).
- Numbering: glossary terms in the same change (Kometa Managed Include / Kometa Recipe / Collection
  Suggestion); the shared `role_collection_action_grants` action term is owned by the parallel books
  track (two-track reconciliation at merge).
