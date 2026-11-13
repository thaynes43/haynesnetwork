# 2026-11-13 — Trash wall protection read (story 832)

Display and read model only. No delete-path guard was changed.

## What the two checks were

The amber no-entry badge is the pending wall's skip glyph. It is the Age Guard, and only when that is the first keep (`ageGuard === 'recent'`, and not a tag, a recent watch, or a watchlist). The Show protected checkbox sent `includeWatchlisted: false` and the page hid a title only when `onWatchlist` was true. A title the guardian would keep for any other reason stayed on the default wall.

`includeWatchlisted` omitted still means the full set. The library page omits the flag. That contract stays.

## Replica read (2026-11-13)

Replica pod `postgres16-11` (`cnpg.io/instanceRole=replica`). Not the primary.

`SELECT media_kind, item_count, refreshed_at FROM trash_candidates_state` on 2026-11-13: movies `item_count` 524, TV 0, `refreshed_at` 2026-11-13 12:30:04.983-05. An earlier read the same day, against `refreshed_at` 2026-11-13 12:15:05.576-05, had the same item counts.

Guardian-order counts over that movie snapshot (SQL mirror of `classifyGuardian`, not a call to the function): deletable 431, `recently_added` 55, `watchlisted` 34, `recently_watched` 4. No saved, tag, unactionable, not-in-ledger, watchlist-unknown, rules-unknown, or age-unknown row in that snapshot. The filter hid the 34 watchlisted titles and missed the 55 Age Guard titles and the 4 recently watched titles.

Newest ok watchlist registry run: 2026-11-13 12:14:17.558-05. `movie_unmapped` 1, `show_unmapped` 0, so a movie with no discover id was unevaluable. None of the six titles below were in that state.

## The six titles

Re-read 2026-11-13 from the same replica (titles, year, pool membership, rule flag, `dnd`, last view, newest `downloadFolderImported`, newest Plex date added, open save). All six were still in the movie pool. Each had `rule_evaluation_failed` false, no `dnd` tag, no last view, and no open save. The newest age signal is the import, and each import is inside 180 days of 2026-11-13 (the window reaches back to about 2026-05-17). The 12:15 read also recorded a discover id, `on_watchlist` false, and two dated Plex matches for each. Reason: `recently_added`. The badge showed because that is the skip glyph. The filter let them through because they were not watchlisted.

| Title                | Year | Newest import (measured) |
| -------------------- | ---- | ------------------------ |
| The Smashing Machine | 2025 | 2026-09-22 06:08:00-04   |
| Mars Attacks!        | 1996 | 2026-08-03 13:21:03-04   |
| MaXXXine             | 2024 | 2026-09-19 07:01:01-04   |
| Shelter              | 2026 | 2026-09-20 14:27:20-04   |
| The Cable Guy        | 1996 | 2026-10-21 17:24:01-04   |
| Drop                 | 2025 | 2026-09-10 03:50:00-04   |

Shelter and Drop are the pool rows with those exact titles.

## What the read now does

`trashWallProtection` is the one definition. The default view (`includeWatchlisted: false`) excludes every non-null reason known before the page, then drops a page-scoped live exclusion. The protected view and an omitted flag return every title with `protectionReason` set. Expedite preview, totals, and `allActionableIds` stay on the unfiltered set. Glyphs for a tag, a recent watch, a live exclusion, and a Save stay as previously ruled. Skip follows `protectionReason === 'recently_added'`.

## Open questions

Q-15. A live exclusion on a later page can still be inside the reported count. Recommendation: do not crawl exclusions for the whole pool.

Q-16. `release_unrecorded` is decided at delete time from the *arr's files. Recommendation: leave it off the wall. The delete path was not changed.

## Finishing pass (2026-11-13, second worker)

The first worker ended before its checks finished and the required check `e2e-gate` was red. This
pass found why, fixed it, and checked the claims above. Display and read model only; no delete-path
guard was touched.

### Why `e2e-gate` was red

The read model and the page were right. The tests were wrong, in three places, all in
`apps/web/e2e/trash.spec.ts`. Each was reproduced locally before it was changed (measured
2026-11-13, `pnpm --filter web e2e trash.spec.ts`, one worker):

| # | Test (line on the branch as delivered) | What happened | Fix |
| - | -------------------------------------- | ------------- | --- |
| 1 | D-12 cross-server watch visibility (489) | The new `showHeldTitles` helper ran straight after the click on the TV tab. A tab switch keeps only `?tab`, but the Movies wall, with its box ticked from `protected=show`, was still mounted when the helper read it. It saw a ticked box, did nothing, and the TV wall then mounted on its default view, which omits the Age Guard title. | `switchTrashTab` clicks the tab and waits until it is the selected one. |
| 2 | Expire now, then the sweep (1638) | After the cancel the test expected the wall's tiles at once. Saves left open by the earlier tests held every title, so the default view was empty. | Show the held titles first, as the same test already did further down. |
| 3 | The same test, after fix 2 | `showHeldTitles` looked the box up by its name on the whole page. An open batch's future strip has a box with the same name and was still on the page for a moment after the cancel, so the helper ticked that one. | The helper is scoped to the pending wall's own filter bar. |

Defects 2 and 3 sat behind defect 1: the block is serial, so CI skipped the 33 tests after the first
failure. Result after the fixes, before any other change: 38 passed of 38.

### A tile saved from the default view vanished (hard rule 9)

Found while checking the claims, and not covered by any test: every save-tap test opens the wall with
`protected=show`. On the default view a Save makes its title undeletable, so the read that follows
the Save no longer returned it. The tile vanished a moment after it turned green, every tile after it
moved up, and the un-save tap went with it. Proved with a new e2e case run against the branch as
delivered: `expect(vanished).toHaveCount(1)` failed with `Received: 0`.

Fix, client only: `usePinnedSaves` (`apps/web/components/pending-wall.tsx`) over the pure
`withPinnedTiles` (`apps/web/lib/trash.ts`). The wall keeps a tile the viewer saved from this view at
the place it had, wearing the saved shield, until the view is opened again. The counts bar follows
the server at once. A freshly opened default view never contains a saved title. Both the pending wall
and the future-candidate strip use it. The server read is unchanged. Recorded as DESIGN-052 Q-17,
because it is a choice between two of the owner's rules.

### Claims checked

- **One definition.** `trashWallProtection` returns null exactly when `classifyForExpedite` returns
  `deletable`. The first worker's test sampled 13 cases. A new test walks every combination of the
  nine inputs: 2^8 x 3 = 768 combinations, all agreeing (`trash-protection-filter.test.ts`).
- **Each reason, both views.** The database test seeds one title per reason. The default view returns
  the one deletable title; the protected view returns all twelve rows, eleven with a distinct reason
  and one with none. Read and re-run; it passes.
- **Nothing the sweep or Expedite reads has changed.** `git diff origin/main...HEAD --
  packages/domain/src/trash-flow.ts` has no removed line: the change there is one function, one
  constant, one type and one optional field. `listTrashPendingPage` is called only by the
  `trash.pending` read. `protectionReason` is read only by that function and by the tile's glyph. The
  Expedite preview and `allActionableIds` are still built from the unfiltered set, and the guard test
  asserts they are equal with the flag on and off.
- **Corner glyphs stay as ruled: one case did not, and is fixed.** The first worker made the kept
  badge follow the reason `recently_added`. A title that has no Maintainerr id and is also inside the
  Age Guard has `unactionable` as its first reason, so on the protected view it lost the kept badge
  and wore the plain trash can. The advisory reviewer on the PR raised the same thing. Such a title
  now reads the Age Guard from the item itself, as before story 832, and keeps the badge
  (`pendingWallGlyph`, with a unit test). It could not be deleted before and cannot be now.

### Checks (measured 2026-11-13, local, one suite at a time)

| Check | Command | Result |
| ----- | ------- | ------ |
| Trash e2e | `pnpm --filter web e2e trash.spec.ts` | 39 passed of 39 (38 existing, 1 new) |
| Domain | `vitest run __tests__/trash-protection-filter.test.ts __tests__/trash-watchlist-guard.test.ts --maxWorkers=2` | 36 passed of 36 |
| Web unit | `vitest run lib/__tests__/trash.test.ts --maxWorkers=2` | 76 passed of 76 (re-run after the glyph fix) |
| Types | `pnpm typecheck` | clean |
| Lint | `pnpm lint`, `pnpm lint:css` | no errors; 3 warnings, all in two test files this change does not touch |
