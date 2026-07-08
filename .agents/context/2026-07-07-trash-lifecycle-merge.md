# 2026-07-07 — Per-kind Trash lifecycle (Batches folded in) + context-aware item back-links

Owner-directed UX restructure (ADR-033), built by Fable 5 the evening of 2026-07-07. Two parts,
plus an owner wall refinement mid-build.

## PART 1 — Fold the Batches tab into the per-kind tabs

**Rationale (owner):** one-open-batch-per-kind is the enforced invariant (ADR-025 C-01), so a batch
is a *property* of Movies/TV, not a browsable collection. Two near-identical poster walls confused
him; family members should never meet "Batches" — just "Leaving Soon" inside Movies/TV.

Trash tabs are now **Movies · TV · Recently Deleted · Activity**. Each kind tab is ONE state-aware
surface (`apps/web/app/(app)/trash/kind-tab.tsx` → `KindTab`, replacing `batches-tab.tsx`) driven by
`trash.batches.list` scoped to the kind — **zero backend change**, reuses every wire call:

- **no open batch** → the live pending wall (passed in as a render prop from `trash-client.tsx`) +
  admin-only "Start a batch"; terminal batches collapse into a **Past-batches** `<details>` strip.
- **admin_review** → the batch wall (curation) + lifecycle header (Green-light / Cancel) + an
  admin-only **new-candidates strip** (client diff: live pending − batch media ids).
- **leaving_soon** → countdown + family save wall + "Who rescued what" + Expire-now (window-gated) +
  the same new-candidates strip.
- **terminal** → back to the pending wall + Past-batches (each row expands to its final report).

`?tab=batches` → `?tab=movies` (kind rides along: `&kind=tv` → `?tab=tv`); `?kind=`/`?batch=` retired.

**Owner wall refinement (same evening):** unified **fast tap-toggle** on BOTH walls — poster tap
flips `trash` ⇄ `shield` (optimistic, reflow-free). Unified glyph language `trash·shield·check·eye·
skip·gone` (`wallGlyph` renamed X→`trash`, lock→`shield`, protected→`check`; `pendingShieldGlyph` →
`pendingWallGlyph`/`pendingWallTappable`; shared `WallGlyphSvg`). `/library` nav moved OFF the poster
to a distinct **corner icon** (`LibraryCornerLink`, open-book). **Per-item Expedite left the wall** —
"Delete now…" now lives on `/library/[id]`'s deletion-guard card (`TrashPendingNotice`, admin/
`expedite_item`/safe-gated), reusing the ADR-014 `ItemExpediteModal`. Bulk "Expedite all…" stays.

**Gotcha:** a successful Expire flips the batch terminal, which unmounts the LifecycleView (and its
Modal) → the Deletion report vanished. Fix: `ExpireModal` **defers the `trash.batches.invalidate()`
to modal close** so the report persists until dismissed.

## PART 2 — Context-aware item back-link

`/library/[id]` back affordance is now "← <Label>" from a **fixed dictionary** (`lib/back-link.ts`,
unit-tested): `trash-movies`→"Trash Movies", `trash-tv`→"Trash TV", `bulletin`→"Bulletin"
(`?tab=messages`), `bulletin-feed`→"Bulletin", `ledger`→"Ledger", default/garbage→"Library". Prefers
`history.back()` when in-app (Navigation API `canGoBack` → `history.state.idx` → same-origin
referrer) to preserve scroll/filters, else the mapped href. Fixed dictionary = **no open redirect**.
Origin links wired with `?from=`: both trash walls (corner icon), the bulletin chip + feed, ledger
titles. (my-fixes has no dictionary key → falls to Library; history.back() handles its return.)

## Verification

Full gate green: typecheck / lint / lint:css / unit (domain, db, auth, sync, api 202, web 168) /
build. e2e **122 passed** — `trash-batches.spec.ts` folded into `trash.spec.ts` (25 trash tests) with
the merged model; `ledger.spec` + `communication.spec` href assertions updated for `?from=`. Stub
gained `POST /_stub/add-pending` (inject a post-snapshot candidate for the new-candidates strip).
Screenshots (both themes, desktop + 390): `scratchpad/ux-trash-merge/` — every lifecycle state on
the Movies tab + the "← Trash Movies" back link. New capture harness: `capture-trash-merge-ux.ts`
(old `capture-trash-wall-ux.ts` / `capture-batches-ux.ts` deleted).

Docs: ADR-033; DESIGN-010 D-09 + DESIGN-011 D-07 + DESIGN-005 D-17 dated amendments; glossary
change-log row (no term shift — UI only).
