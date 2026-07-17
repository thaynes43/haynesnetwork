# DESIGN-042: The collection manager + member contribution surface (PLAN-052 Libretto leg)

- **Status:** Accepted
- **Last updated:** 2026-07-17
- **Realizes:** ADR-069 (the confined `@hnet/libretto` client + `role_collection_action_grants` +
  the propose→approve contribution flow). Satisfies PRD R-225..R-227.
- **Companions:** DESIGN-037 (Libretto's API contract — the nouns this binds to), DESIGN-038/ADR-066
  (the books-collections mirror walls the contribution affordance rides), DESIGN-029 (the
  Integrations hub-card → pushed sub-section idiom), DESIGN-033 (the books-Fix role-grant + Modal
  precedent this copies), ADR-058 (the shared card system), ADR-014/ADR-015 (ConfirmButton +
  reflow-free).

## Overview

A management + monitoring surface for the estate's Libretto-produced collections, plus a
non-invasive way for members to contribute new collection ideas — all gated by role because recipe
edits (and the acquisition knob especially) can pull a lot of content. The manager reads Libretto
LIVE (Libretto is stateless — its API is the read model, ADR-064/DESIGN-037 D-03); the app persists
only the role grants and the pending member suggestions.

## Detailed design

### D-01 — Placement: a Collections sub-section of the Integrations hub

A new hub card **Collections** on `/integrations` (the DESIGN-029 provider-card idiom) pushes to
`/integrations/collections` (its own screen; Back returns to the hub). The card shows a health
pulse (reachable / unreachable) + recipe/collection counts when reachable. The sub-section is gated
by the `integrations` section (visibility floor) AND the collection action grants (capability):

- A caller with none of `manage`/`acquire` who reaches the URL sees a read-only monitor (recipe list
  + run counts) — honest, no controls. (V1: the card is shown only to `manage`/`acquire`/admin; a
  pure-`suggest` member never sees the hub card, they contribute from the walls — D-05.)
- `manage` (or admin) sees the full manager: create/edit/apply/delete + the suggestion review queue.
- `acquire` additionally unlocks the acquisition toggle in the composer + apply confirms.

### D-02 — The recipe list (monitor)

`GET /api/recipes` + `GET /api/collections` + the latest `GET /api/runs/:id` per recipe, composed
server-side into one `collections.overview` payload. Each recipe renders a row card:

- builder badge (`static_ids` / `hardcover_series` / `nyt_list` / `wikidata_award`),
- target (server + library label),
- matched / missing from the last run (D-04 counts; `matchedByTitle` shown as an honest sub-note,
  never a defect flag — the plan's live-contract note),
- an **Acquisition ON/OFF** puck (recolor-not-reflow; the reserved-slot idiom),
- a run verdict chip (`ok` / `warn` / `error`; `warn` is NORMAL for a partial library — informational).

Libretto's `issues[]` (invalid recipe FILES) render as a distinct "needs attention" band above the
list — honest, never silently dropped.

### D-03 — The recipe detail + composer (create/edit)

A `Modal` (DESIGN-004 D-13 — an explanatory/multi-field confirm, never `window.confirm`):

- builder type picker (from the v1 set), ref field, target library select, `ordered` toggle,
  `syncMode` (`append` | `sync`),
- **ref PREVIEW** (the biggest UX win, ADR-069 C-07): a "Preview" action POSTs the draft to
  `POST /api/validate` and shows the resolved series/list name + the resolved work count + any
  issues BEFORE save. A slug that resolves to a 0-work container series shows `resolved: 0 works —
  check the ref` honestly (the silent-failure guard from the plan notes). No fabrication.
- **VALIDATE-before-save:** save is refused if validate returns blocking issues; the per-path issue
  strings render inline.
- Save = `PUT /api/recipes/:id` (id global-unique — the composer enforces uniqueness, the
  `dune` / `dune-audiobooks` per-target-variant rule).
- The **acquisitionEnabled** toggle is present only for `acquire`-granted roles; a `manage`-only
  editor sees it disabled with "needs the acquire grant". Turning it ON opens a second explanatory
  Modal confirm ("this makes the estate acquire the list's missing books via LazyLibrarian, paced").

Apply-now is a `ConfirmButton` (ADR-014 two-step; reserves width for the armed label — no row shift)
firing `POST /api/apply {scope: recipeId}` → 202 `{runId}`; the row then polls `GET /api/runs/:id`
for the async result.

Delete is a `ConfirmButton` with an explicit orphaned-collection warning (ADR-069 C-08): the default
removes the recipe only (the collection survives orphaned in the library); an "also delete the
collection" checkbox sets `?deleteCollection=true`.

### D-04 — Run history + counts

The detail shows the recipe's recent runs (Libretto keeps the last 50 — surfaced honestly with a
"recent runs only" note) with per-run counts: matched, missing, and — when acquisition is on —
acquired. Acquisition counts make the content-pull visible so the owner can watch what a recipe
drives in.

### D-05 — The contribution affordance (creative + non-invasive)

On the Books and Audiobooks **collections walls** (the ADR-066 grouped-cards view, dimension =
Collections), a `suggest`-granted member sees a small **"Suggest a collection"** card rendered
AFTER the collections grid — a trailing affordance, no reflow of existing cards (ADR-015; it sits
below the grid like the load-more sentinel). It opens a `Modal`:

- name + builder type + ref (e.g. a Hardcover series they want) + optional note,
- submit → a `pending` `collection_suggestions` row (applies NOTHING),
- the affordance then shows the suggester their suggestion's state ("Suggested — pending review",
  "Approved", "Declined: <reason>") — a light acknowledgement, not a wall of controls.

A `manage` admin sees the suggestion queue in the manager (D-01): approve (materialize the recipe
via the confined `upsertRecipe`, acquisition off unless the approver holds `acquire` and opts in) or
decline with a reason. Every step is audited (ADR-069 C-05).

### D-06 — Server-side + confinement

All Libretto calls go through tRPC procedures (`collectionActionProcedure('manage'|'acquire')`);
the confined `@hnet/libretto` client is reached only via the `@hnet/domain` collections orchestrator
(the ADR-055 discipline). NEVER a browser call. A Libretto outage degrades to an `unreachable`
health state (D-01) — no crash; the mirror walls are unaffected.

### D-07 — Cards + tokens

The manager reuses existing card/badge tokens and the `hub-card` / `badge` families (ADR-058 — no
hand-rolled wall cards). New color goes through `--color-*` tokens in `tokens.css` only (hard rule
2). The suggest affordance is a `hub-card`-family button; the composer is the standard `Modal`. New
gallery entries capture the recipe row (with the acquisition puck) + the suggest card + the
suggestion-state states, dark/light × desktop/390 (the standing screenshot-review rule).

## Test strategy

- **Domain:** the grants matrix (`collectionActionsForRole`, admin implies all, no-row deny), the
  `setRoleCollectionActions` audit-in-same-tx, the suggestion lifecycle (create → approve materializes
  a recipe via the confined writer / decline with reason; audited), the confined orchestrator's
  validate/apply/delete pass-through against a stub client.
- **API:** the permission matrix INCLUDING forbidden paths — a `manage`-only caller cannot enable
  acquisition (FORBIDDEN), a `suggest`-only caller cannot reach the manager mutations (FORBIDDEN), an
  ungranted caller gets FORBIDDEN everywhere.
- **DB:** the migration block (both tables, the CHECKs, the FKs, the seed remains 10 apps).
- **Guards:** arr-write-import-guard extended (`@hnet/libretto/write` domain-only) +
  no-direct-state-writes extended (the two new tables).
- **UI:** gallery entries + a hermetic screenshot capture (`capture-collections.ts`) driving a
  `stub-libretto` server (the LL/arr stub idiom) at 390/desktop, dark/light.

## Open questions

| ID | Question | For |
|----|----------|-----|
| Q-01 | Which roles get `suggest` first, and does `manage` imply `suggest`? V1 ships all three Admin-only; the owner opens `suggest` to members after review. | owner |
| Q-02 | Target-library selection UX: V1 lists Libretto's configured targets from the recipe/collection reads; a richer `GET /targets` picker is a follow-on if Libretto exposes it. | owner |
| Q-03 | Should an approved suggestion auto-apply once, or only create the recipe (owner applies)? V1 creates the recipe only (acquisition off) — apply stays an explicit manager action. | owner |
