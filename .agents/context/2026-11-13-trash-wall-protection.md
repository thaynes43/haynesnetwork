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
