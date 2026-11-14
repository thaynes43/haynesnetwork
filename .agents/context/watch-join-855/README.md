# Story #855 — watch join census and release hold

**The next eligible metadata harvest after deployment applies this correction automatically.** Do not release before the coordinator reviews this list and the required adversarial review is recorded. No production recompute, metadata refresh, deployment, Plex write or Tautulli write was run by this worker.

**Six movies would newly clear the database guardian if they entered the pool:** 2001: A Space Odyssey, Beautiful Thing, Citizen Kane, Das Boot, Sister Act, The Bridges of Madison County. **None is in the current pool or an open batch.** There is therefore no newly deletable current pool/batch member in this snapshot. This distinction does not waive the release hold.

## Measurement and reproducibility

All counts below are measured or calculated by the supplied queries/scripts on 2026-11-14; there are no estimated counts. The database is replica `postgres16-11`, and both captures assert `pg_is_in_recovery() = true`. Live means `deleted_from_arr_at IS NULL`. No account watch table was read for the census. Music title names are omitted.

- Before: `2026-11-14T02:03:58.432741-05:00` (07:03:58Z), `before.sql`, captured with `kubectl exec -i -n database pod/postgres16-11 -c postgres -- psql -XAt -v ON_ERROR_STOP=1 -d haynesnetwork`.
- Lifetime source: `history.json` records the start timestamp and per-instance page/row counts from `read-household.mjs`, executed through stdin in the existing web pod with `node --input-type=module`. It only uses grouped `get_history` and `get_metadata` GETs, serially, page size 500, cap 158, stopping on a short page. Credential values stay in the web pod and no response with an account field is retained. The source output is a household aggregate per kind/rating key, with normalized ids. The cached map is a replica SELECT of `media_plex_matches` → libraries → servers → items (slug, rating key, library type, arr kind and external ids only). The caller substitutes that JSON for `__CACHE__`.
- Projection: `2026-11-14T02:08:38.342403-05:00` (07:08:38Z), `projection.sql`. Substitute the quoted `history.json` for `__HISTORY__` and run it through the same replica psql command. **This is a SELECT mirror of what the corrected join would store, not a production backfill dry run or a claim that production has been corrected.** A first SELECT at 07:06:57Z lacked release-name evidence; the retained projection adds it.
- `before.json.gz` and `projection.json.gz` retain those household-only SELECT inputs. `python3 .agents/context/watch-join-855/summarize.py` regenerates `summary.json` and both CSVs. The compressed inputs are for reproducibility; the CSVs are the review surface.
- `household-inventory.csv`: every live movie/show, including titles missing an optional id. `affected-titles.csv`: the union of cross-kind shared usable ids and explicit sentinel ids; title, current/projected count and last instant/server, watch-keep loss/gain, other keeps, pool membership and open batches. No account identifiers, account plays, progress, requester tags or names are retained.

## Before and projected after

Pair rule: one unordered pair of live titles of different arr kinds with an equal usable external id. "With play" means either stored count is positive. The before identical record compares count, last-viewed, last-watched and server; after compares count/last-viewed/server (last-watched is the same instant). This is not an assertion that equal zero/unknown records imply contamination. 10 movies in these pairs have no file but currently store positive plays (counted from `affected-titles.csv`, `arr_kind=radarr`, `on_disk_file_count=0`, `before_plays>0`). All cross-kind pairs found are Radarr/Sonarr; pairs involving Lidarr are zero for every namespace.

| Id namespace | Cross-kind pairs | Pairs with stored plays | Identical positive before | Identical positive projected after |
| --- | ---: | ---: | ---: | ---: |
| TMDB | 76 | 46 | 46 | 0 |
| TVDB | 0 | 0 | 0 | 0 |
| IMDb | 0 | 0 | 0 | 0 |

Invalid-id rule: zero means numeric 0 or text `0`/`tt0`; empty is non-null empty/whitespace; missing is SQL null. These categories are disjoint. A repeated-record group has at least two titles with exactly the watch record described above. "Titles grouped" sums group sizes, not the number of groups. Natural missing optional ids and music unknowns are included for completeness, not classified as a faulty join.

| Id | Arr | Live | Zero | Empty | Missing | Repeated groups before / after | Titles grouped before / after | Positive repeated groups before / after |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| TMDB | radarr | 9630 | 0 | 0 | 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| TMDB | sonarr | 1085 | 22 | 0 | 0 | 1 / 1 | 22 / 20 | 1 / 0 |
| TMDB | lidarr | 7735 | 0 | 0 | 7735 | 1 / 1 | 7735 / 7735 | 0 / 0 |
| TVDB | radarr | 9630 | 0 | 0 | 9630 | 1 / 1 | 8331 / 8356 | 0 / 0 |
| TVDB | sonarr | 1085 | 0 | 0 | 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| TVDB | lidarr | 7735 | 0 | 0 | 7735 | 1 / 1 | 7735 / 7735 | 0 / 0 |
| IMDb | radarr | 9630 | 0 | 0 | 85 | 1 / 1 | 84 / 84 | 0 / 0 |
| IMDb | sonarr | 1085 | 0 | 0 | 12 | 2 / 1 | 11 / 10 | 1 / 0 |
| IMDb | lidarr | 7735 | 0 | 0 | 7735 | 1 / 1 | 7735 / 7735 | 0 / 0 |

The explicit-zero TMDB group projects to **20 shows with zero plays and 2 with their own plays (1 and 10)**, rather than 22 copies of 11 plays. Those are measured lifetime totals resolved by usable TVDB/IMDb ids. The earlier coordinator note described only one played title under the old window; that is not used to derive this result. Shared zero records after correction are legitimate known no-play results. No live video title lacks every usable id in this measurement; the null case is covered by embedded-PG tests.

| Arr | Before played / zero / unknown | Projected played / zero / unknown |
| --- | --- | --- |
| radarr | 1299 / 8331 / 0 | 1274 / 8356 / 0 |
| sonarr | 500 / 585 / 0 | 464 / 621 / 0 |

Count checks: the affected union is 174 = 2 × 76 + 22 (disjoint in this snapshot). Of those, 73 change a watch column; the others retain their own result. Overall 76 titles differ, including the 3 newer-source cases below. Every video totals row sums to its live count; every invalid-id row counts a subset of that same live population. `summarize.py` derives all tables from the retained inputs. The lifetime history read overlaps active viewing, so it is not a transactionally frozen before/after comparison.

Newer source results outside the collision/sentinel set (measured SELECT mirror):

| Title | Before count | Projected count | Before last (local offset) | Projected last |
| --- | ---: | ---: | --- | --- |
| Numberblocks | 637 | 637 | 2026-11-14T00:14:56-05:00 | 2026-11-14T02:04:39-05:00 |
| Lockup | 371 | 373 | 2026-11-12T23:17:00-05:00 | 2026-11-14T02:04:20-05:00 |
| The Office (US) | 3281 | 3285 | 2026-11-14T00:14:16-05:00 | 2026-11-14T02:04:06-05:00 |

These source timestamps are newer than the stored harvest. They are reported separately, not attributed to the two join fixes.

## Trash consequences

The watch keep is `last_viewed_at >= measured time − 720 elapsed hours`, matching `buildPendingItems` / `classifyGuardian`. The retained capture used SQL calendar days; an exhaustive comparison of all retained before/after flags against the exact 30 × 86,400-second expression found zero differences on 2026-11-14. The reusable SQL now uses elapsed hours and the summarizer asserts that equivalence. Another keep is reported independently of guardian ordering: Save, `dnd`, household watchlist membership, Age Guard, Request Keep and release-name verification. The measured library-fill setting is off, so the Age Guard uses the newest download import / Plex added date and the unchanged 180-day/undated-match rules. The projection reads only booleans/dates for these checks, never release names or account lists. Release-name status mirrors `loadReleaseNameStates` (latest non-folder import/grab or equal-size legacy evidence); Sonarr stays `unchecked`, leaving per-file checks to the actual delete path.

Watchlist membership is a household EXISTS, not a fresh Registry Gate verification or live exclusion read. The newest ok registry run is `2026-11-14T01:59:17.908-05:00`. The live gate, late-watchlist overlay, exclusions, rule evaluation, release read-back and batch state are still checked at deletion time. These SELECTs do not authorize any delete or predict future pool membership.

Measured watch-keep changes: 11 losses, 0 gains. Every loss is listed below; every affected title, including unchanged ones, is in `affected-titles.csv`.

| Title | Stored plays → projected | Stored last → projected | Other keep | Pool / open batch |
| --- | --- | --- | --- | --- |
| 2001: A Space Odyssey | 610 → 0 | 2026-11-10T21:03:13-05:00 → null | none in database projection | no / none |
| Beautiful Thing | 16 → 0 | 2026-10-25T17:29:58-04:00 → null | none in database projection | no / none |
| Citizen Kane | 34 → 0 | 2026-10-27T10:54:01-04:00 → null | none in database projection | no / none |
| Das Boot | 18 → 2 | 2026-11-11T20:03:27-05:00 → 2026-07-05T05:51:48-04:00 | none in database projection | no / none |
| Galaxy Quest | 18 → 0 | 2026-11-08T09:29:02-05:00 → null | watchlisted | no / none |
| Pan's Labyrinth | 83 → 0 | 2026-11-13T15:46:48-05:00 → null | watchlisted | no / none |
| Sister Act | 308 → 0 | 2026-11-08T09:43:37-05:00 → null | none in database projection | no / none |
| The Bridges of Madison County | 589 → 0 | 2026-11-10T20:14:19-05:00 → null | none in database projection | no / none |
| Troy | 7 → 0 | 2026-11-08T18:35:50-05:00 → null | recently_added | no / none |
| Hacks | 16 → 12 | 2026-10-31T09:20:59-04:00 → 2026-10-13T22:06:46-04:00 | recently_added | no / none |
| Muppet Babies | 1 → 0 | 2026-10-20T16:59:35-04:00 → null | recently_added | no / none |

No rule, guard, threshold, release-name policy, match table or production row changed. In particular, the six guardian-clear movies above are outside the pool and open batches, so the measured immediate deletion exposure is zero. Their absence is not a permanent keep.

## Readers and resulting behavior

Inventory command (2026-11-14): `rg -n "userMediaWatch|mediaMetadata\.(playCount|lastViewedAt|lastWatchedAt|lastWatchedServer)" packages apps/web --glob "*.ts" --glob "*.tsx"`, followed by searches for the returned fields. Direct readers and their downstream views:

| Reader | Effect |
| --- | --- |
| `packages/domain/src/trash-flow.ts` (`buildPendingItems`, `classifyGuardian`, sweep / Expedite / preview) | Correct MAX instant can remove a recent-watch keep. Other guards and their order stay unchanged. |
| `packages/domain/src/trash-batches.ts` (batch listing/wall) | Correct recent-watch badge and last-watch date/server on existing batch tiles. No batch state is rewritten. |
| `packages/api/src/ledger-query.ts` and ledger / ledger-admin routers (search/browse/detail, sort keys, metadata block) | Correct household plays and last-viewed ordering/display; identifiable no-play remains zero, unidentifiable remains null. |
| `apps/web/components/pending-wall.tsx`, `trash-shield.tsx`, Trash kind tab and Library item detail | Correct watch labels / server attribution and any shield fed by the guardian; no layout or rule changes. |
| `user_media_watch` → `packages/domain/src/user-media-watch.ts`, ledger-query watched/in-progress facets | The same corrected join feeds these rows. Complete refresh/backfill replaces stale rows for mapped viewers, including absent contributions; partial reads do not clear absent contributions. Equal rows are not rewritten and no absent-viewer zero rows are created. Existing rows without a current Plex mapping cannot be reattributed until that mapping is restored. No production per-account census was performed. |
| MCP watch tools / `packages/watch/src/queries/*` | No read of household watch-stat columns or `user_media_watch`; metadata joins here use ratings/genres. Watch tools read `watch_titles` / `watch_events` and live Plex evidence, populated by the separate watch sync. Their counts and marks are unchanged by this harvest. `mark_watched` and other writers are untouched. |
| `packages/api/src/ledger-export.ts` and Library router | Export payload remains media-item data; watched/in-progress filtering through the shared predicate and Library per-viewer detail use the corrected per-user projection. |
| Existing `watch-history-backfill.ts` | Uses the same corrected join; dry-run writes nothing; apply updates household and changed mapped-viewer projections, preserving unrelated metadata. The report now separates unknown from zero. |

## Source, validation and handoff

- Source: DESIGN-008 D-15 and code/tests in this PR. New ids: D-15 and Q-13/Q-14/Q-15 only. ADR-125 and migration 0114 are unused; no new glossary term.
- Tested locally on 2026-11-14: `pnpm --filter @hnet/sync test --maxWorkers=2` passed 45 files / 313 tests (final run started 07:29:23Z); `pnpm --workspace-concurrency=2 typecheck`, `pnpm --workspace-concurrency=2 lint`, and `pnpm lint:css` passed. Lint reports only existing unused-import warnings in unrelated domain tests. The single-writer guard also passed (`pnpm --filter @hnet/domain exec vitest run __tests__/no-direct-state-writes.test.ts --maxWorkers=2`, 2 tests, 07:28:41Z). Test fixtures use the normal domain writers. CI evidence is recorded on the PR. Embedded PostgreSQL 16 and synthetic stub histories; no Plex/Tautulli writes or production backfill.
- Installed: not deployed by this worker. Accepted: not accepted; coordinator-owned.
- Required independent Fable review remains for the coordinator to arrange. This worker did not start another session, request an advisory reviewer or merge.
- Questions/recommendations: DESIGN-008 Q-13 records why aggregate-only reconstruction is impossible and the measured read-only replacement; Q-14 states the proposed IMDb/kind rule; Q-15 is the explicit coordinator release hold. No unanswered implementation choice was guessed.
- Next safe step: coordinator reviews this list, obtains the mandatory adversarial review, and decides the release. After authorized deployment, verify the first harvest and record installed/accepted separately on #855. A production backfill is optional and belongs to that later authorized step.
