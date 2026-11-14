# Story 856 — Plex section completeness

Source baseline, measured by `git fetch origin main; git rev-parse HEAD origin/main` on 2026-11-14:
`780fdeb178850c7b9f11941e9442ed09d1afe101` for both. PR 1075's ADR-123 is already present.
DESIGN-025 D-11 implements the existing full-read contract; no new architectural decision, glossary term or
migration is needed. Reserved ADR-126, Q-06 and Q-07 remain unused. Q-05 records the unresolved size-drop policy.

## Replica measurement (measured, 2026-11-14)

Read route (no writes):

```sh
REPLICA=$(kubectl get pods -n database -l cnpg.io/cluster=postgres16,cnpg.io/instanceRole=replica -o name | head -1)
kubectl exec -n database "$REPLICA" -c postgres -- psql -d haynesnetwork -c '<SELECT below>'
```

Replica selected: `pod/postgres16-11`; `SELECT pg_is_in_recovery()` returned true. SQL below ran at
07:00:45 UTC (library census) and 07:01:03 UTC (matcher run count and stats keys). Counts include every stored
match row, including a tombstoned ledger title; zero-row libraries are included by the left join.

```sql
SELECT now() AT TIME ZONE 'UTC' AS measured_utc, pg_is_in_recovery();
SELECT s.slug, l.section_key, l.name, l.media_type, count(m.id) AS rows
FROM plex_libraries l JOIN plex_servers s ON s.id=l.server_id
LEFT JOIN media_plex_matches m ON m.plex_library_id=l.id
GROUP BY s.slug,l.section_key,l.name,l.media_type ORDER BY s.slug,l.section_key;
SELECT source,run_kind,status,count(*) AS runs,min(started_at),max(started_at)
FROM sync_runs WHERE started_at >= now()-interval '30 days'
GROUP BY source,run_kind,status ORDER BY source,run_kind,status;
SELECT count(*) AS plex_match_runs FROM sync_runs
WHERE run_kind='plex-match' AND started_at>=now()-interval '30 days';
SELECT run_kind, jsonb_object_keys(stats) AS stat_key, count(*) AS rows
FROM sync_runs WHERE started_at>=now()-interval '30 days'
GROUP BY run_kind,stat_key ORDER BY run_kind,stat_key;
```

| Server | Section | Library | Stored rows (measured) |
| --- | --- | --- | ---: |
| hayneskube | 2 | HOps Music | 4,981 |
| hayneskube | 3 | HOps YT | 0 |
| hayneskube | 4 | HOps Peloton | 0 |
| haynesops | 1 | HOps Movies | 5,181 |
| haynesops | 2 | HOps TV Shows | 953 |
| haynestower | 1 | HNet Movies | 5,180 |
| haynestower | 2 | HNet TV Shows | 957 |
| haynestower | 4 | HNet Photos | 0 |
| haynestower | 5 | HNet Home Videos | 0 |
| Total (sum of the rows above) | | | 17,252 |

Measured matcher history: **0** `sync_runs` rows in that window. Existing rows cover full, incremental and
metadata-refresh modes; their stats keys contain no matcher section total, items-read or removed-row history.
Source confirms the standalone matcher intentionally writes no run row. Current match timestamps do not
retain removed rows or prior library counts, so the database cannot show a historical drop and recovery.

## Retained logs (measured, 2026-11-14)

Grafana MCP `list_datasources(type="loki", limit=5)` supplied datasource uid `loki`. Query:

```logql
{namespace="frontend", pod=~"haynesnetwork-sync-plex-match.*"} |= "plex-match complete"
```

Window: 2026-10-15T07:00:00Z through 2026-11-14T07:00:00Z (the requested 30 days).
`query_loki_logs`, direction forward, compact, bounded to 100 returned lines per request. The initial
whole-window result was truncated after 100 lines (through 2026-10-19T10:52:13.601Z). Continued strictly after
that timestamp through October 23 at 07:00Z, then adjacent windows ending October 27, October 31, November 4,
November 8, November 12 and November 14, all at 07:00Z. Each continuation reported no truncation. The retained
**715** completion lines are projected into [the aggregate CSV](2026-11-14-plex-match-runs.csv), with no
per-account viewing. A blank cross-type count means the old log did not emit that field; it is not an
observed zero. The separate 30-day `sum(count_over_time(...[30d]))` instant query timed out; no alternate
route was attempted. The bounded log reads provide the counts reported here.

Measured by grouping/summing those CSV rows: **61** runs report `removed > 0`, summing **5,471** stale-row
removals (row-removal events, not distinct titles). The maximum is **834** at 2026-10-28T02:52:13.662Z; the
next largest is **138**. The prior run reports **16,857** upserts and **4,472** Lidarr matches; the maximum
removal run reports **16,023** and **3,638**, respectively, with **8** libraries scoped in both. At
2026-10-29T03:52:15.090Z they recover to **16,897** and **4,508**. These are aggregate match/upsert counts,
not saved per-library row counts. They show a deletion spike followed by recovery, but do not prove a
short read or distinguish actual library changes from bad answers. There are **5** completion lines with
**5** scoped libraries instead of **8**; comparing aggregate upserts across them is not a library-drop measure.
There is a completion-log gap from November 5 at 08:52Z to 14:52Z; no run or success is inferred for it.

The 2026-11-14T02:52:18.268Z run reports **131** `crossTypeRemoved` and **0** `removed`, confirming the earlier
coordinator measurement of ADR-123's first installed run. It is the only retained line with a positive
cross-type count. The surviving pod census (`kubectl get pods -n frontend`, filtered by `plex-match`) found
`haynesnetwork-sync-plex-match-29910652-hfxqr`. Its own completion line was read with:

```sh
kubectl -n frontend logs haynesnetwork-sync-plex-match-29910652-hfxqr --tail=30
```

Only the JSON object whose `msg` is `plex-match complete` was retained. It reports at 06:52:14.866Z:
upserted **17,252**, removed **0**, crossTypeRemoved **0**, scopedLibraries **8**, plexTitlesIndexed **17,579**.
No matcher job or production repair was started.

**Unmeasurable:** no old section log records `itemsRead` or `totalSize`. The number or rate of mismatches is
unknown, not zero. No per-library historical row counts or row identities survive in these sources. The
spike does not establish a safe numerical drop threshold. DESIGN-025 Q-05 recommends shipping the required
completeness guard, then collecting section telemetry before choosing a per-library limit; repeat confirmation
or a manual release are alternatives for the coordinator. No extra numerical threshold is added here.

Reproduce the CSV summary without an API call:

```python
import csv
from pathlib import Path
rows = list(csv.DictReader(Path('.agents/context/2026-11-14-plex-match-runs.csv').open()))
assert len(rows) == len({r['time'] for r in rows}) == 715
assert sum(int(r['removed']) > 0 for r in rows) == 61
assert sum(int(r['removed']) for r in rows) == 5471
assert max(int(r['removed']) for r in rows) == 834
assert sum(int(r['scoped_libraries']) == 5 for r in rows) == 5
```

## Missing-row consequences on the pinned main (source inspection, 2026-11-14)

These readers are unchanged. No per-account data was queried.

| Reader | Consequence of a missing match row |
| --- | --- |
| Age Guard (`trash-age-guard.ts`, ADR-119 / DESIGN-052 D-31) | A recent import or remaining recent Plex date returns `recent` first. With no match rows, or an undated remaining match, it is `unknown` and kept. Losing only the recent/undated copy while an older dated copy remains can change `recent`/`unknown` to `clear`; losing every copy does not clear the guard. This holds with the library-fill setting off or on. |
| Access gate and wall queries (`domain/library-access.ts`, `api/library-access.ts`, `ledger-query.ts`, `routers/ledger.ts`) | The library leaves the kind/instance candidate set if it has no other matches. An item losing all matches falls back to its accessible kind/instance; it may disappear or change visibility. Admins remain unrestricted. The wall and export use that same gate. |
| Play targets and art (`api/library-access.ts`, `library-plex-art.ts`) | The missing library supplies no play link, season poster or episode thumbnail; another accessible matched copy may supply them. |
| Collection views (`domain/plex-collections.ts`, `api/ledger-query.ts`) | The item no longer joins the collection's library/rating key; it loses that collection membership in the read model. |
| Watch tools (`watch/queries/titles.ts`, `ledger.ts`, `answers.ts`, `watchlist.ts`, `views.ts`) | No ledger holder for that server, no ledger-based on-Plex flag or added-time evidence; independent Title State may still establish availability. Plex-backed recommendation candidates can disappear. |
| `mark_watched` (`domain/watch/marks.ts`) | A stored Title State wins; otherwise ledger holders are tried, then a Plex GUID lookup if all are missing. With neither a holder nor GUID result there is no server target from this fallback. No marks are changed by the matcher itself. |
| Watch harvest (`sync/db-reads.ts`, `metadata-refresh.ts`) | Missing cached rating-key GUIDs require metadata lookup instead. Stored household plays are not rewritten by matcher reconciliation; the independent cross-kind join fix belongs to story 855. |
| Playback evidence (`domain/playback-evidence.ts`) | The server's Tautulli history is not queried without a matched key; independent webhook evidence remains. |
| Audio Preference (`domain/audio-preference.ts`) | The missing copy is absent from preference reads/writes; with no matches no server can be set through this lookup. |
| Season Re-map / Watch Carry (`domain/season-remap-flow.ts`, `watch-carry.ts`) | The server is absent from the season title/carry source set. Downstream guards still apply; the matcher performs no move or mark. |
| Bootstrap (`sync/first-plex-match.ts`) | An entirely empty match table can trigger the existing first-match sync; a partially empty table does not. |

## Execution plan and evidence states

Amend DESIGN-025 D-11 before code. Preserve the cross-type writer and `metadata-refresh.ts`. Make the matcher
request real totals, check stored rows before trusting zero, and withhold scope on incomplete reads. Add
error counts and per-section evidence to both run summaries. Prove preservation and normal stale deletion
with stubbed Plex and embedded PostgreSQL 16, including the existing page cap and cross-type behavior.
Run touched-package tests serially with at most two workers, then workspace typecheck, then lint. Review the
diff, push this session branch and open a non-draft PR. Wait for required checks including e2e-gate. Hand off
with PR/head/evidence to story 856; no claim, completion, merge, deployment or production execution.

Disk preflight measured 2026-11-14 by `df -h`, `df -i`, `du -sx /tmp`: home volume had **18 GiB** available,
**1,256,555** free inodes; `/tmp` used **0 KiB**. Operational budgets (chosen limits, not measurements):
dependency/test artifacts at most **4 GiB** on home with **8 GiB** reserved, and **512 MiB** temporary output.
The pinned starting source was already on origin before dependency installation.

Source: implemented D-11 and error/stats telemetry; no change to domain writers, Age Guard or
`metadata-refresh.ts`. Local tests measured 2026-11-14: `pnpm --filter @hnet/sync exec vitest run
--maxWorkers=2` passed **326** tests in **45** files; `pnpm --filter @hnet/plex exec vitest run
--maxWorkers=2` passed **145** tests in **11** files; `pnpm --filter @hnet/domain exec vitest run
plex-match-type no-direct-state-writes --maxWorkers=2` passed **9** tests in **2** files. Suites ran serially. The installed embedded
package identifies itself as PostgreSQL **16.14** (`node_modules/.pnpm/embedded-postgres*/node_modules/embedded-postgres/package.json`).
`git diff --check` and the CSV assertions above passed. The initial root typecheck passed, but its outer
`--workspace-concurrency=2` did not propagate to the nested recursive command (the log showed the default
concurrency); final typecheck and lint therefore use the explicit recursive `--workspace-concurrency=2`.
Final typecheck/lint measured 2026-11-14: `pnpm -r --workspace-concurrency=2 typecheck` and
`pnpm -r --workspace-concurrency=2 lint` both passed. Lint reported existing unused-import warnings in
unmodified domain tests. No local application build was requested; required CI build/e2e checks follow the PR.
Built: CI pending. Installed: not performed. Accepted:
coordinator-owned, pending adversarial review. Story's stale dependency text calls PR 1075 not ready; its
later completion/install history and the pinned source show it ready. No held action was resumed.

Initial CI on `b37b3704` caught a direct historical-fixture insert in the new sync test, forbidden by the
single-writer guard outside domain. The fixture test was removed, without weakening the guard. The existing
domain case `the sync deletes a cross-type row in a library it did not read, and leaves fitting rows there`
already proves the required independent deletion. Final test counts above are after that correction (the
initial sync count was **327**, measured by the earlier same-command run). The guard was added to the final
local domain check. The automatic advisory review reported no findings and a diagnostic note; its note was
also addressed by changing the zero-scope summary to say that no library had a verified complete read.
