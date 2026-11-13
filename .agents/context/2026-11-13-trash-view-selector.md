# 2026-11-13 — Trash page view selector (story 821)

Display only. Which titles a sweep or Expedite may delete does not change, and the server read is
the one story 832 left (`.agents/context/2026-11-13-trash-wall-protection.md`). The design of
record is DESIGN-052, "D-10 amendment — the view is the Library's segmented control, and a kept
tile says why".

## What changed on the page

- The **Show protected** checkbox is gone from the pending wall and from the future-candidate strip.
  In its place is the Library's view selector: the same `.seg` pill, first in the controls row.
  Two segments, **Deletable** (the default) and **All**. The selected one is green.
- In **All**, every kept tile says why in a few plain words under its facts. A deletable tile says
  nothing. **Deletable** tiles carry no such line.
- The counts bar says "Reclaiming ..." only in Deletable. All counts titles ("12 titles in all ·
  71 GB"). With nothing deletable while the rules still flag titles, Deletable says "Nothing to
  delete" and the empty wall points at All.
- The URL is unchanged: `?protected=show` is All, no parameter is Deletable.

## The words

| Reason the read returns | On the tile | In full (tooltip, screen reader) |
| ----------------------- | ----------- | -------------------------------- |
| `saved`, `live_excluded` | Saved | Kept: saved |
| `tag` | Marked to keep | Kept: marked do not delete |
| `recently_watched` | Watched recently | Kept: watched recently |
| `watchlisted` | On a watchlist | Kept: on a watchlist |
| `recently_added` | Added recently | Kept: added or upgraded recently |
| `not_in_ledger` | Not in the library | Kept: not in the library, so it can't be checked |
| `watchlist_unknown` | Can't be checked | Kept: its watchlists can't be checked right now |
| `rules_unknown` | Can't be checked | Kept: its rules couldn't be checked |
| `age_unknown` | Can't be checked | Kept: its dates can't be checked right now |
| `unactionable` | Can't be removed | Kept: not linked to Plex, so it can't be removed |
| a reason this build does not know | Kept | Kept: it can't be deleted right now |

Eleven reasons, as the server lists them (`TRASH_WALL_PROTECTION_REASONS`); a unit test compares the
two lists. Other words on the page:

| Where | Words |
| ----- | ----- |
| The segments | Deletable, All |
| Segment tooltips | "Only the titles that can be deleted"; "Every title the rules flagged, with the reason any of them is kept" |
| Counts bar, Deletable | "Reclaiming 42 GB across 7 items" (unchanged); "Nothing to delete" when none can be |
| Counts bar, All | "12 titles in all · 71 GB" |
| Empty wall, Deletable | "Nothing here can be deleted right now. Choose All to see what is kept, and why." |
| Empty strip, Deletable | "Nothing else here can be deleted right now. Choose All to see what is kept, and why." |
| A kept tile's accessible name | "<title>. Kept: watched recently. Tap to save it" (it no longer says "slated to delete") |

## Nothing moves on a switch (hard rule 9)

Measured 2026-11-13 on the local stack (`pnpm dev:local`, the playwright MCP server), reading
`getBoundingClientRect` for the control, the search box, the counts bar, the total, the "as of"
line, Refresh, Delete all now and the wall, before and after choosing All.

| Width | Before this change's fixes | After |
| ----- | -------------------------- | ----- |
| 1280 px | the pill 124.6 to 124.0 px wide, so the search box moved 0.6 px; the "as of" line and Refresh moved 37 px (the total's text got shorter) | no box changed except the wall's own height |
| 390 px | the pill 124.6 to 124.0 px wide; nothing else | no box changed except the wall's own height |
| 760, 999, 1000 px | not measured before | no box changed except the wall's own height |

Two causes, two fixes: `.seg--steady` holds each segment at the width of its bold label, and the
total has a slot that does not depend on its text (fixed from 1000 px up, a line of its own below).
The Library's own pill moves its search box by 0.08 px on a switch (measured the same way); it is
left as it is.

The reason line is 15 px tall and every tile of the All wall carries it, so an All tile is 15 px
taller than a Deletable one (271 against 256 px at 1280 px) and all tiles of one wall are one height.

## Checks (measured 2026-11-13, local, one suite at a time)

| Check | Command | Result |
| ----- | ------- | ------ |
| Trash e2e | `pnpm --filter web e2e trash.spec.ts` | 40 passed of 40 (39 from story 832, 1 new) |
| Web unit | `vitest run lib/__tests__/trash.test.ts --maxWorkers=2` | 85 passed of 85 (76 before, 9 new) |
| Types | `pnpm typecheck` | clean |
| Lint | `pnpm lint`, `pnpm lint:css` | no errors; 4 warnings, in three files this change does not touch |

The new e2e case asserts, at 1280 and 390 px and in both themes: the checkbox is gone; the selector
has the Library pill's computed style, group and place; the selected segment's color is the theme's
accent token; and thirteen boxes plus the page's scroll width are equal before and after a switch,
in both directions. Existing cases now also assert the words on each seeded kept tile.

## Screenshots

Eight PNG files in `~/.shared/op821/`, 74 to 95 KB each (674 KB in all), from the local stack with
a demo pool of 12 movies: 7 deletable and 5 kept, one each for Saved, Marked to keep, Added recently,
Watched recently and Not in the library. The stack's posters are plain red fixtures. Phone shots are
390 px wide and 1680 px tall so the whole wall is in one picture.

- `trash-deletable-light-desktop.png`, `trash-all-light-desktop.png`
- `trash-deletable-dark-desktop.png`, `trash-all-dark-desktop.png`
- `trash-deletable-light-390.png`, `trash-all-light-390.png`
- `trash-deletable-dark-390.png`, `trash-all-dark-390.png`

Not in the pictures, because the local stack had no title in that state: On a watchlist (asserted
by the e2e watchlist case instead), Can't be checked, Can't be removed.

## Not done, and why

- Corner glyphs and taps are as ruled. A kept title other than a Save or an Age Guard title still
  wears the red trash can. See Q-18.
- The Library's own pill was not given `.seg--steady`: 0.08 px, and not this story's page.
- The read still takes `includeWatchlisted`. Renaming a wire field is not display.
- Prettier was not run over the touched files; they are not Prettier-clean on `main`.

## Questions

- **Q-18** (DESIGN-052). In All a kept title says in words that it is kept, but four kinds still wear
  the red trash can, because the corner is the Save tap (owner ruling 2026-07-09). Should a kept
  title's corner change? Recommendation, shipped: leave the corners as ruled in this change and ask
  the owner with the screenshots in hand.
- Q-17 (from story 832) also shows on this page: a title saved from Deletable stays in place, shown
  as saved, until the view is opened again.
