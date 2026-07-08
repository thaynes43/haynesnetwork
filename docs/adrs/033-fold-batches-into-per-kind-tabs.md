# ADR-033: Fold the Batches tab into the per-kind tabs (a batch is a property of Movies/TV)

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner-directed UX restructure, 2026-07-07 evening) · built by Fable 5

## Context and problem statement

Since ADR-025 / DESIGN-011 the Trash section carried a separate **Batches** tab (alongside
Movies · TV · Recently Deleted · Activity) with its own Movies|TV segmented control. That tab was
a second poster wall over the *same* media set the Movies/TV pending tabs already showed as poster
walls (the 2026-07-07 pending-tables → walls change, DESIGN-010 D-09 amendment). The owner's
feedback after living with it:

- **Two near-identical poster walls confused him** — "which wall am I on?" The Batches wall and the
  Movies/TV pending wall used the same `.bwall` grammar over overlapping items.
- **One-open-batch-per-kind is already the enforced invariant** (ADR-025 C-01, `createBatchFromPending`
  refuses when an open batch exists). So a batch is not a *browsable collection* — it is a
  **property of a kind**: at any moment Movies has zero or one open batch, likewise TV.
- **Family members should never meet "Batches" as a concept.** They should just see "Leaving Soon"
  inside Movies/TV when a window is open, and otherwise the live candidates.

Separately, the owner refined the wall interaction itself (same evening): he wanted the *fast
tap-toggle* he loves from the batch wall on **both** walls, the `/library` navigation moved off the
poster (so a tap can't accidentally navigate instead of toggling), and per-item "delete now" taken
off the wall entirely (a trash-can that only ever set state, never deleted, was a mixed signal).

## Decision drivers

1. **One surface per kind** — the Movies (and TV) tab is a single *state-aware* surface driven by
   that kind's open batch. No parallel wall, no "Batches" concept for family members.
2. **Reuse every wire contract** — this is a UI restructure only: zero backend/schema/tRPC changes.
   The kind tab reads `trash.batches.list` scoped to the kind and swaps what it renders by state.
3. **Consistent wall grammar** — one glyph language and one tap-toggle interaction on both the
   live-candidates wall and the batch-curation wall (they now *are* the same wall in different
   lifecycle states).
4. **Fast maintenance** — the owner curates batches quickly by tapping posters to save/slate; the
   `/library` nav and the destructive per-item delete must not compete for that tap.
5. ADR-014 / ADR-015 stay intact: destructive actions keep their Modal; interactions recolor, never
   reflow.

## Considered options

1. **Fold Batches into the per-kind tabs; one state-aware surface** (chosen).
2. Keep the separate Batches tab and just de-duplicate the walls visually — rejected: it leaves the
   "which wall?" confusion and keeps "Batches" in the family member's vocabulary.
3. Make Batches an admin-only tab — rejected: still two walls for the admin, and the Leaving-Soon
   family flow genuinely belongs *in* Movies/TV where the family already looks.

## Decision outcome

Chosen option: **fold Batches into the per-kind tabs** — because the enforced one-open-batch-per-kind
invariant means a batch *is* a property of Movies/TV, so the kind tab should render the batch's
current lifecycle state rather than sending the user to a separate collection.

**Trash tabs become: Movies · TV · Recently Deleted · Activity** (Batches is gone). Each kind tab is
ONE surface driven by that kind's open batch (`trash.batches.list` filtered to the kind):

- **No open batch** → the live-candidates poster wall + an admin-only **"Start a batch"** header
  (`createBatchFromPending`). Terminal batches collapse into a **Past-batches** strip at the bottom.
- **`admin_review`** → the wall renders the BATCH (X/lock curation via `setItemSaved`) + a lifecycle
  header (state chip · running counts · **Green-light** Modal · **Cancel** ConfirmButton) + an
  admin-only **"new candidates since this batch (K)"** strip (client-side diff of the live pending
  set vs the batch's media ids — eligible for the *next* batch).
- **`leaving_soon`** → countdown banner + the family save wall (`save_leaving_soon` rules) + "Who
  rescued what" + admin **Expire-now** (still gated behind window-close) + the same new-candidates
  strip.
- **terminal (`deleted`/`cancelled`)** → the wall returns to live candidates; the Past-batches strip
  lists terminal batches (date · state · counts · reclaimed), each a `<details>` that expands to its
  final report (the terminal PosterWall). A just-expired batch's Deletion report stays on screen
  until the operator dismisses it (the batch-list refetch is *deferred to modal close*, so going
  terminal doesn't yank the report — DESIGN-011 D-07 amendment).

Old `?tab=batches` deep links redirect to the per-kind tab (`?tab=batches&kind=tv` → `?tab=tv`, else
`?tab=movies`). The `?kind=`/`?batch=` params are retired (the kind IS the tab; past batches are a
collapsible, not a URL selection).

**Owner wall refinement (same decision):**

- **Fast tap-toggle everywhere** — on BOTH walls a poster/glyph tap flips the item between `trash`
  (slated) and `shield` (saved): a Maintainerr exclusion on the pending wall, a batch rescue in
  admin_review/leaving_soon. Optimistic, reconciled with the server, reflow-free. Inert states stay
  inert (`check` = protected-by-tag/external-exclusion, `eye` = recently-watched, foreign saves in
  the family window). The glyph language is **unified** across both walls: `trash · shield · check ·
  eye · skip · gone` (`lib/trash-batches.ts wallGlyph`, `lib/trash.ts pendingWallGlyph`, unit-tested).
- **Library nav is a corner icon** — since the poster now toggles, the `/library/[id]` link moved to
  a distinct top-left corner glyph (an open-book, visually unlike the state toggle), carrying the
  `?from=` context (ADR-033 back-link convention, DESIGN-005 D-17 amendment).
- **Per-item expedite left the wall** — the trash-can is now a STATE, not a Modal trigger. Per-item
  "Delete now…" moved to the item page's deletion-schedule card (`/library/[id]`
  `TrashPendingNotice`, admin/`expedite_item`-gated), reusing the existing ADR-014 Expedite Modal +
  guarded flow. The bulk **"Expedite all…"** pill stays on the wall.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: one poster wall per kind — the "which wall?" confusion is gone; family members never meet "Batches", only "Leaving Soon" inside Movies/TV. |
| C-02 | Good: zero backend change — same `trash.batches.*` / `trash.pending` / `trash.expedite*` contracts; the kind tab just swaps its render by the open batch's state. |
| C-03 | Good: one unified wall grammar + tap-toggle across live-candidates and batch curation (they are the same wall in different states); the glyph rules are unit-tested. |
| C-04 | Good: the poster tap only ever toggles; `/library` nav and destructive delete can't be mis-tapped (nav is a distinct corner, delete is on the item page). |
| C-05 | Neutral: a terminal batch's report/wall is no longer inline after dismissal — it lives in the Past-batches strip (expand-to-report). The Expire report persists until close via a deferred list-refetch. |
| C-06 | Bad: `trash-client.tsx` + the new `kind-tab.tsx` carry more state-branching than the old flat tab; mitigated by keeping the pending wall a render prop and the batch lifecycle in one file. |
| C-07 | Neutral: `?tab=batches` / `?kind=` / `?batch=` deep links are retired (redirect handles the common one); no external consumers. |

## More information

Supersedes the DESIGN-011 D-07 "Batches tab" IA (the pipeline/domain decisions of ADR-025 stand;
only the *surface* moves). Amends DESIGN-010 D-09 (pending wall) and DESIGN-011 D-07 (batch wall) —
see the dated amendments in those designs. The context-aware back-link convention (Part 2) is
recorded in DESIGN-005 D-17 (amendment) and `apps/web/lib/back-link.ts` (the fixed `?from=`
dictionary, unit-tested). Governed by ADR-014 (confirm affordances) and ADR-015 (no-reorient).
