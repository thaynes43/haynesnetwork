# Media-action UX consistency audit (READ-ONLY → propose)

Date: 2026-07-17
Author: audit agent (read-only; no code changed)
For: owner ratification before any build
Repo: `/home/dev/work/haynesnetwork-0717-133132` @ branch `agent/haynesnetwork-0717-133132`

> Owner's acceptance bar: the site must present **exactly the same action/UX language for a
> given media action** regardless of (a) media type (movie / TV / season / episode / book /
> audiobook / comic) and (b) the view it is seen in (wall card, detail page, collection,
> series/show, wanted, Goodreads items, activity). It must be **impossible to mess up** —
> enforced by shared libraries/components, not by convention.
>
> Concrete trigger: movie detail shows a green primary **"Fix"** pill + an outline **"Force
> Search"** button; book/audiobook detail shows an outline **"Fix this"** (different label,
> different variant/color) and NO Force Search. Same intent, divergent implementation.

**Bottom line:** the *card faces* are already unified-by-construction (BaseCard + a lint guard —
the exact pattern to copy). The *detail pages and their action controls are not*. Every detail
surface hand-rolls its own hero, its own action row, and its own copy of the "button ↔ live
chip" reserved slot, with per-call string literals for label/variant/gating. That is the whole
root cause. **24 discrepancies** found across 5 detail surfaces; **6 are High severity** (the
ones a user directly sees as "this looks like a different app").

> ⚠️ **Sequencing flag:** a sibling agent is actively editing `packages/api/src/routers/books.ts`
> and the books/wanted detail surfaces (admin force-search override + wanted-tiles). This audit
> is read-only so there is no merge conflict now, but the unification build in Part 4 **rewrites
> exactly those surfaces**. Land the sibling's functional change first, then rebase the
> unification onto it (or explicitly co-design). Do not start the Part-4 build in parallel with it.

---

## Part 1 — every media-action surface (file:line)

### Detail pages (each hand-rolls its own hero + action row)
| # | Surface | File | Hero | Actions rendered |
|---|---|---|---|---|
| A | Movie / TV / Music detail | `apps/web/app/(app)/library/[id]/item-detail.tsx` | `.card.detail-head` (L462) | Fix + Force Search at item/season/episode/album/show/artist grains (L542-855); consume "Watch on Plex — …" (L509-525); NotOnDiskButton (L535) |
| B | Books / Audiobook / Comic detail | `apps/web/app/(app)/library/books/[id]/books-detail.tsx` | `.card.detail-head` (L217) | consume "Read in Kavita ↗"/"Listen on Audiobookshelf ↗" (L237-241); paired second consume (L242-253); **BookFixControl** (L255); pairing "Search for …" (L268); pairing-want link (L264) |
| C | Books Fix control | `apps/web/app/(app)/library/books/[id]/book-fix-dialog.tsx` | — | "Fix this" button (L73-81) + reason Modal (L82) |
| D | Wanted detail | `apps/web/app/(app)/library/books/wanted/[requestId]/wanted-detail.tsx` | `.card.detail-head` (L281) | per-format "Force Search" (L150-161); per-format status badge + live stage chip (L207-223) |
| E | Activity failure detail | `apps/web/app/(app)/library/activity/[failureId]/activity-failure-detail.tsx` | `.card.detail-head` (L…) | "Retry import" / "Force re-search" (L… ActionSlot); downstream deep link |
| F | ytdl-sub (Peloton/YouTube) detail | `apps/web/app/(app)/library/ytdlsub/[library]/[ratingKey]/ytdlsub-item-detail.tsx` | `.card.detail-head` (L…) | consume "Watch on Plex ↗" (L210-218); NotOnDiskButton (L…); no Fix/Force-Search |

### Dialogs / modals
- Movie Fix: `apps/web/app/(app)/library/[id]/fix-dialog.tsx` (reason taxonomy from `lib/media.fixReasonsForKind`, live progress).
- Movie Force Search: `apps/web/app/(app)/library/[id]/force-search-dialog.tsx` (single confirm + live progress).
- Books Fix: reason Modal inside `book-fix-dialog.tsx` (its own hard-coded `REASONS`).

### Card faces / walls — **already unified** (the model to copy)
- `apps/web/components/cards/media-card.tsx`, `book-card.tsx`, `request-card.tsx`,
  `wanted-card.tsx`, `trash-card.tsx`, `ticket-card.tsx` — all thin `BaseCard` extensions.
- Locked by the lint guard `apps/web/lint/card-anatomy-guard.mjs` + executable proof
  `apps/web/lib/__tests__/card-system-guard.test.ts` (ESLint `no-restricted-syntax` /
  `no-restricted-imports` over every file outside `components/cards`, plus an import-confinement
  repo walk). Card faces carry no per-item actions, so they are consistent by construction and
  are **out of scope** except as the precedent for Part 4.

### The precedent the app ALREADY has for "config not components"
- `apps/web/lib/library-view-registry.ts` — `LIBRARY_VIEW_REGISTRY` keyed by `ViewLevelKey`
  declares, per (wall, level), the exact sorts/facets/defaults; the UI renders exactly what the
  active entry lists (ADR-051 C-01: "adding a dimension is a registry-row edit, never a new
  component"). **There is no equivalent registry for media actions.** That gap is the whole bug.

---

## Part 2 — the discrepancy matrix

Legend for variant: `primary` = `.btn.primary` (green accent pill, `--color-accent`,
app.css L94); `outline-sm` = `.btn.sm` (neutral surface, L1255); `outline` = plain `.btn`
(neutral surface, L83); `missing` = `.btn.btn--missing` (inert, L1870).

### 2a — FIX (the headline conflict)
| Surface / grain | Label | Variant | Gating | Component |
|---|---|---|---|---|
| Movie head (radarr) | **`Fix`** | **`primary`** (green) | `onDiskFileCount>0`; **no role gate** (authedProcedure) | inline `<button>` in ActionSlot, item-detail L549 |
| Episode / album child | `Fix` | **`outline-sm`** | `hasFile` | inline `<button>`, item-detail L427 |
| Season roll-up | **`Fix season`** | `outline-sm` | `onDiskCount>0` | inline `<button>`, item-detail L766 |
| Show / artist roll-up | *(no Fix — deliberate; blocklist too broad)* | — | — | — |
| Book / audiobook / comic | **`Fix this`** | **`outline`** (`.btn`, neutral) | server `canFix` = **Admin-only** (role-gated) | `BookFixControl`, book-fix-dialog L73 |

**Divergences:** label `Fix` vs `Fix season` vs `Fix this` (3 strings for one verb); variant
`primary`/`outline-sm`/`outline` (3 looks); gating rule differs in KIND — movies gate on
on-disk state with no role check, books gate on role (`canFix`) with no on-disk check; the movie
head Fix is the ONLY green-primary Fix (children/season/books are all non-primary), so even
*within movies* Fix is not one look.

### 2b — FIX + FORCE-SEARCH pairing
| Surface | On-disk item shows | Missing item shows |
|---|---|---|
| Movie head | Fix (primary) **+** Force Search (outline) | Force Search only (primary) + NotOnDiskButton |
| Movie child/season | Fix + Force Search | Force Search only |
| **Books detail** | **Fix this only — NO Force Search** | *(n/a — books never expose on-disk Force Search)* |

This is the exact asymmetry the owner cited: movies pair Fix with Force Search; books show Fix
alone. Books' only search surfaces are the *pairing* "Search for ebook/audio" and the *wanted*
per-format "Force Search" — neither sits beside the book's own Fix.

### 2c — FORCE SEARCH label + variant
| Surface | Label | Variant | Gating |
|---|---|---|---|
| Movie head | `Force Search` | `primary` if missing else `outline` | authed; disabled if tombstoned |
| Movie child/season | `Force Search` | `outline-sm` | always |
| Movie show/artist | **`Force Search show`** / **`Force Search artist`** | `outline-sm` | not tombstoned |
| Wanted per-format | `Force Search` | `outline-sm` | server `searchable` (own + integrations) |
| Books pairing | **`Search for {ebook/audio}`** | `outline-sm` | want `searchable` |
| Activity failure | **`Force re-search`** | `outline-sm` | `canForceSearch` |

**Divergences:** `Force Search` vs `Force Search show/artist` vs `Search for ebook` vs `Force
re-search` — 4 phrasings; the movie head is the only one that ever goes `primary`.

### 2d — PRIMARY consume link (mostly consistent — keep as the template)
| Surface | Label | Variant | Trailing mark |
|---|---|---|---|
| Movie/ytdl | `Watch on Plex — <library>` / `Watch on Plex` | `primary` + `.btn__ext` ↗ | ↗ |
| Books | `Read in Kavita` / `Listen on Audiobookshelf` | `primary` + `.btn__ext` ↗ | ↗ |
| Books paired 2nd | counterpart label | `outline` (`.btn`) | ↗ |

The consume link is the ONE action already visually consistent (primary pill + ↗). Label varies
by serving app, which is correct. **This is the look the Fix/Force-Search actions should adopt.**
Minor drift: each page re-hand-rolls the `<a class="btn primary">…<span class="btn__ext">↗</span>`
markup; it should be one `<ConsumeLink>` so the ↗ / target / rel are guaranteed identical.

### 2e — Missing-state pill (already shared — the good example)
`NotOnDiskButton` (`apps/web/components/not-on-disk-button.tsx`) is one component used by both
item-detail (L535) and ytdl-sub. Books-detail does NOT use it (it renders the pairing affordance
instead). Consistent where used; the seam is that books opted out.

### 2f — Badges / ratings / section anatomy
| Element | Movie (A) | Books (B) | Wanted (D) | Activity (E) | ytdl (F) |
|---|---|---|---|---|---|
| Kind badge | `ARR_KIND_LABELS` muted | `KIND_LABEL` muted | shelf label | failure-class danger | library muted |
| On-disk badge | `disk.tone` (ok/warn) | none | hero + per-format status | Stuck/Resolved | none |
| Ratings row | IMDb/TMDb/RT pills (L591) | **none** (honest gap) | none | none | none |
| About section | ✅ (ratings, facts, genres, requesters, collections) | ✅ mirrored (R-221) | ✗ (requesters only, in hero) | ✗ | ✗ (summary in hero) |
| Details section | ✅ `meta-grid` | ✅ `meta-grid` | ✅ `meta-grid` | ✅ `meta-grid` | ✗ |
| "Fixes on this item" | ✅ `fix-list` | ✅ mirrored | ✗ | ✗ | ✗ |
| History | ✅ `timeline` | ✅ mirrored | ✗ | ✗ | ✗ |

Section anatomy is *largely* at parity for A vs B (that was the R-221 / commit `bcb830d`
"detail-page parity" work — good). The remaining gaps are honest data gaps (books have no
ratings), not drift. The real drift lives in the *actions* and in the *duplicated label/tone
maps* feeding the badges (below).

### 2g — Duplicated status→label and status→tone logic (silent drift risk)
| Concern | Copies |
|---|---|
| Fix status → label | `FIX_STATUS_LABELS` (`lib/media.ts` L129, movie) **vs** local `FIX_STATUS_LABEL` (books-detail L34) **vs** `FIX_REASON_LABEL` books-local vs movie `FIX_REASON_LABELS` |
| status → badge tone | `fixStatusTone` (`lib/media.ts` L142) **vs** `statusTone` (books-detail L61) **vs** `statusTone` (wanted-detail L41) — 3 independent tone maps |
| Fix reason taxonomy | movie `fixReasonsForKind` (`lib/media.ts`) **vs** books hard-coded `REASONS` (book-fix-dialog L15) — different vocabularies AND different labels ("Won't open / corrupt" vs "Won't play / corrupt") |
| "button ↔ live PhaseChip" reserved slot | **5 reimplementations**: `ActionSlot` (item-detail L107), `FormatSearchSlot` (wanted L93), `ActionSlot` (activity-failure), `PairingSearchSlot` (books-detail L86), inline in `BookFixControl` (book-fix-dialog L44) |

The 5 copies of the reserved-slot idiom are the clearest "impossible to keep in sync by hand"
signal: each independently maps phases → tone → copy, and they already disagree on wording
("Search fired" vs "Fix requested. Searching…" vs "Requested").

### Discrepancy count / severity
- **High (6):** Fix label (2b/2a — 3 strings), Fix variant (3 looks), Fix gating KIND mismatch
  (on-disk vs role), Fix+ForceSearch pairing asymmetry (movies pair / books don't), Force-Search
  label variants (4 strings), 5× duplicated reserved-slot idiom.
- **Medium (10):** primary-vs-non-primary inconsistency within movies; consume-link markup
  re-hand-rolled ×3; 3× duplicated status→tone maps; 2× duplicated status→label maps; reason
  taxonomy fork; NotOnDiskButton opted-out by books; per-format Force-Search variant vs head
  Force-Search variant; "Force Search show/artist" verbose variants.
- **Low (8):** ↗ mark placement, `data-testid` naming forks (`book-fix-btn` vs `format-search-btn`
  vs `activity-retry`), disabled/pending copy forks ("Searching…" vs "Working…" vs "Requesting…"),
  chip `tone` naming (`neutral` vs `info` for the same "fired" state), etc.

---

## Part 3 — root cause: why the drift happens

1. **No shared hero / action-row component.** Every detail page writes its own
   `<section className="card detail-head">` + `<div className="detail-head__play|__actions">`
   and its own `<button className="btn …">`. The class `media-card__badges` is deliberately left
   OUT of the card-anatomy lock (card-anatomy-guard.mjs comment), so the detail-head badge row is
   a free-for-all copy across A/B/D/E/F.

2. **Action definitions are per-call string literals, not data.** Compare with sorts/facets,
   which are declared once in `LIBRARY_VIEW_REGISTRY` and rendered by one engine. Actions have no
   registry — "Fix" / "Fix this" / "Fix season" / green-vs-outline are typed inline at each call
   site, so nothing forces them to agree.

3. **`@hnet/ui` sharing stops below the action layer.** It ships primitives only — `PhaseChip`,
   `ProgressMeter` (`packages/ui/src/controls/PhaseChip.tsx`), `ConfirmButton`, the filter/sort
   helpers, layout budgeters. There is **no `MediaAction`, no `MediaActionBar`, no `MediaHero`,
   no `ReservedActionSlot`.** So the reserved-slot idiom (the one place ADR-015 reflow-safety is
   subtle) is re-derived 5 times, and the Fix/Force-Search buttons are raw `<button>`s.

4. **Fix/Force-Search logic is genuinely duplicated across item-detail and books.** item-detail
   owns the on-disk→Fix / missing→Force-Search rule (L400-456) and the grain plumbing; books
   re-implement a parallel, narrower version (canFix + pairing search) with different copy and
   gating. Neither imports a shared decision function; the "which action does this grain get"
   rule lives twice.

5. **Historical accretion.** The books/wanted/activity surfaces were each added by a later ADR
   (ADR-047 books drill-in, ADR-057 wanted, ADR-059 activity, ADR-062 book-Fix) that "mirrors the
   /library/[id] visual language" **by copying markup**, not by extending a shared component. Each
   copy drifted slightly. The R-221 parity pass fixed the *sections* but not the *actions*.

**Exact seams where the missing abstraction belongs:**
- item-detail L360-384 `actionSlot()` / L107 `ActionSlot` → should be `@hnet/ui`'s
  `ReservedActionSlot`.
- item-detail L425-452 (Fix/Force-Search `<button>`s) → should be `<MediaAction action="fix|forceSearch" …>`.
- book-fix-dialog L73-81, wanted L149-162, activity ActionSlot, books PairingSearchSlot →
  all the same `ReservedActionSlot` + `<MediaAction>`.
- The `.detail-head` + `.detail-head__play|__actions` blocks in A/B/D/E/F → one `<MediaHero>` +
  `<MediaActionBar>`.

---

## Part 4 — proposed single design + enforcement (the deliverable)

### 4.1 The canonical action registry (single source of truth)
New `packages/ui/src/actions/action-registry.ts` — the media-action analog of
`LIBRARY_VIEW_REGISTRY`. One entry per action TYPE, keyed by an enum, carrying label + variant +
icon + destructiveness. **No call site ever types a label or a `btn` class again.**

```ts
export type MediaActionType = 'fix' | 'forceSearch' | 'consume' | 'retryImport' | 'notOnDisk';

export interface MediaActionSpec {
  type: MediaActionType;
  label: string;              // the ONE canonical string
  variant: 'primary' | 'outline';   // the ONE canonical look
  destructive: boolean;       // → ConfirmButton vs plain (hard rule 8)
  icon?: IconName;
  external?: boolean;         // consume → renders the ↗ btn__ext
}

export const MEDIA_ACTIONS: Record<MediaActionType, MediaActionSpec> = {
  fix:          { type: 'fix',          label: 'Fix',          variant: 'primary', destructive: false },
  forceSearch:  { type: 'forceSearch',  label: 'Force Search', variant: 'outline', destructive: false },
  consume:      { type: 'consume',      label: '<per-app>',    variant: 'primary', external: true, destructive: false },
  retryImport:  { type: 'retryImport',  label: 'Retry import', variant: 'outline', destructive: false },
  notOnDisk:    { type: 'notOnDisk',    label: 'Not on Disk',  variant: 'outline', destructive: false },
};
```

Scope suffix ("season"/"show"/"artist") becomes a *prop on the component* that appends a
grammatically-consistent qualifier ("Force Search · Season 2"), not a fork of the label string.
The consume label stays per-app (correct) but flows through one `<ConsumeLink>` so the pill +
↗ + `rel="noopener noreferrer"` + `target="_blank"` are identical everywhere.

### 4.2 The canonical shared components (`@hnet/ui`)
1. `ReservedActionSlot` — the ONE reflow-safe "button ↔ live PhaseChip" slot (ADR-015 hard
   rule 9), lifted verbatim from item-detail `ActionSlot`. Replaces all 5 copies. It reserves
   width for its widest state and swaps button→chip in place.
2. `<MediaAction spec={MEDIA_ACTIONS.fix} scopeLabel? onFire disabled? live? />` — renders the
   registry spec: picks `.btn.primary`/`.btn` from `variant`, wraps in `ReservedActionSlot`,
   drives its own PhaseChip from a `live` phase. Every Fix/Force-Search/Retry button in the app
   is one of these. Structure-only, tone from tokens (the PhaseChip/ConfirmButton precedent — no
   hex, CLAUDE.md rule 2).
3. `<MediaActionBar>` — lays out the ordered action set for a grain (consume first, then
   Fix, then Force-Search) with the canonical spacing; guarantees ordering can't drift.
4. `<MediaHero>` — the `.detail-head` poster + title + badge-row + action-bar, so A/B/D/E/F stop
   hand-rolling it. Takes typed `badges`, a `consume` slot, and an `actions` slot.
5. `<ConsumeLink app label url>` — the one primary ↗ pill.

Result: a movie, a book, a comic, an episode, a wanted format, a stuck import all get the
identical Fix/Force-Search/consume treatment **by construction** — they render the same
`<MediaAction>` off the same registry entry.

### 4.3 Canonical answers to the specific conflicts (owner to ratify)
- **"Fix" or "Fix this"?** → **`Fix`** everywhere. Rationale: shortest, matches the movie head
  and every roll-up; "this" adds nothing. Scope qualifier ("Fix · Season 2") handles grains.
- **Which variant/color for Fix?** → **`primary` (green accent)** everywhere Fix is the primary
  repair action; `outline` only when it is a secondary among several row actions is NOT allowed —
  keep Fix visually the same. Simpler owner-facing rule: *Fix is always the green pill; Force
  Search is always the outline pill.* (This upgrades books' "Fix this" outline → green primary,
  and normalizes the movie child/season Fix to primary too.)
- **Force Search wording** → **`Force Search`** everywhere; scope via qualifier ("Force Search ·
  Whole show"), not "Force Search show". Books' pairing button becomes `Force Search` (the format
  is already labeled by the row). Activity's `Force re-search` → `Force Search`.
- **Does every on-disk item get Fix + Force Search, every missing item get Force Search?** →
  **Yes — adopt the movie rule as universal.** On disk ⇒ Fix (repair) **+** Force Search
  (re-grab); missing ⇒ Force Search only. **Extend this to books:** an on-disk book gets Fix +
  Force Search (books gain a real Force-Search on the detail page, closing the 2b asymmetry) —
  *pending the sibling agent's admin-force-search work, which is building exactly this surface;
  co-design so books' Force-Search is the same `<MediaAction forceSearch>`.* Whole-show/artist
  keep Force-Search-only (blocklisting a whole series is too broad — existing owner ruling, keep).
- **Fix gating** → unify on the **role/`canActon(action, item)` server helper** returning
  `{ canFix, canForceSearch }` per item for ALL media types (movies included), so gating is one
  rule, not "movies = on-disk only, books = role only". Movies currently use `authedProcedure`
  with no role gate; fold that into the same `canFix`/`canForceSearch` the books detail already
  computes. On-disk state becomes an *input* to that helper, not a separate parallel rule.
- **Status→label / status→tone / reason taxonomy** → one shared map each in
  `packages/ui` (or `lib/media` promoted to shared), consumed by all surfaces. Delete the 3 local
  `statusTone`s and the books-local label maps.

### 4.4 Enforcement (make drift impossible — the part that matters)
Copy the **card-anatomy guard** pattern (`lint/card-anatomy-guard.mjs` +
`card-system-guard.test.ts`) one-for-one for actions:

1. **`lint/action-anatomy-guard.mjs`** — ESLint `no-restricted-syntax`:
   - Forbid raw action `<button>` labels outside `@hnet/ui`: a `Literal`/`JSXText` matching
     `/\b(Fix|Force Search|Force re-search|Retry import|Fix this)\b/` in a `className~="btn"`
     button context is an error → "Render media actions through `<MediaAction>` /
     `MEDIA_ACTIONS` (ADR-0NN)."
   - Forbid `className` string/template literals containing `detail-head__play` or
     `detail-head__actions` outside the hero component → "Build the hero from `<MediaHero>`."
   - `no-restricted-imports`: seal the action package internals to a barrel (the card guard's
     exact mechanism).
2. **`lib/__tests__/action-system-guard.test.ts`** — the executable proof: a violating fixture
   (a hand-rolled `<button className="btn primary">Fix</button>`) FAILS; the sanctioned
   `<MediaAction spec={MEDIA_ACTIONS.fix} …>` passes; a repo walk asserts zero live violations.
3. **A registry-parity test** — assert every `MediaActionType` has exactly one label/variant and
   that no surface passes a literal label to `<MediaAction>` (props are `spec` + optional
   `scopeLabel` only). This is the "one label per verb" lock.
4. Reuse the **hex-lint precedent** unchanged — all new component color stays token-only.

Net: after this, adding or changing a media action is a **registry-row edit**, and the linter +
guard test fail CI the moment anyone hand-rolls a `Fix`/`Force Search` button or a bespoke
detail-head action row — the same "impossible to mess up" guarantee the card system already has.

### 4.5 Migration path (least-risk PR sequence)
Each PR is independently green (`lint-and-typecheck`, `test`, `build`); guard lands LAST so the
tree is already clean when the lock closes.

0. **(sibling-first)** Let the in-flight books force-search / wanted-tiles PR merge. Rebase.
1. **PR-1 (pure add, no behavior change):** add `@hnet/ui` `action-registry.ts`,
   `ReservedActionSlot`, `MediaAction`, `MediaActionBar`, `ConsumeLink`, `MediaHero` + unit
   tests. Nothing consumes them yet. Zero risk.
2. **PR-2:** refactor **item-detail** (the reference implementation) onto the new components;
   snapshot/e2e proves pixel-parity. This is the source of truth all others copy.
3. **PR-3:** migrate **books-detail + book-fix-dialog** — Fix→`primary` green, gains Force
   Search per 4.3, consume via `<ConsumeLink>`. (Owner-visible change: books Fix turns green +
   gains Force Search — the headline fix. Ratify first.)
4. **PR-4:** migrate **wanted-detail** + **activity-failure-detail** (drop their local ActionSlot
   / FormatSearchSlot / statusTone; adopt shared).
5. **PR-5:** migrate **ytdl-sub** consume link + hero to `<MediaHero>`/`<ConsumeLink>`.
6. **PR-6 (the lock):** land `action-anatomy-guard.mjs` + `action-system-guard.test.ts`; delete
   the now-dead local maps/slots; CI now blocks any regression.

Advisory `e2e` stays advisory until PR-6; run the resize/gallery matrix on PR-2 and PR-3 since
those touch the most-seen surfaces.

---

## Appendix — the strongest evidence lines
- Movie Fix = green primary: `item-detail.tsx:549-556` (`className="btn primary"`, label `Fix`).
- Movie child Fix = outline-sm: `item-detail.tsx:427-437`.
- Books Fix = outline neutral, label "Fix this", role-gated: `book-fix-dialog.tsx:73-81`;
  gate `canFix` (Admin-only) `books.ts:825-827`, `books-detail.tsx:255`.
- Books have no on-disk Force Search: `books.ts:810` ("no Fix/Force-Search"), only pairing/wanted.
- 5× reserved-slot idiom: `item-detail.tsx:107`, `wanted-detail.tsx:93`,
  `activity-failure-detail.tsx` ActionSlot, `books-detail.tsx:86`, `book-fix-dialog.tsx:44`.
- 3× status→tone: `lib/media.ts:142`, `books-detail.tsx:61`, `wanted-detail.tsx:41`.
- The pattern to copy: `lint/card-anatomy-guard.mjs` + `lib/__tests__/card-system-guard.test.ts`.
- The config-not-components precedent: `lib/library-view-registry.ts` (ADR-051 C-01).
- `.btn` vs `.btn.primary` tokens: `app.css:83` / `app.css:94`.
</content>
</invoke>
