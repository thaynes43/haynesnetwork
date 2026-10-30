# Trash catch-up and automation exclusions — 2026-10-30

Canonical work: OpenProject story **#296**, epic **#293**; read-only precursor **#294**.
Worktree: `/home/dev/work/trash-catchup-1030`, branch `agent/trash-catchup-1030`, base `a5b5e5c4`.
The driver owns policy ratification, runtime operations and delivery. This worker changed source and
documentation only. It executed no live configuration, backfill, deletion, merge or deployment.

## Why generation stopped

The 13:17 UTC space-policy run had no open batches, was enabled and over its 75% ceiling, but found
only eight actionable movies below the configured minimum of ten. TV had no native pool members.
The raw movie snapshot held 21 entries, 535,100,383,999 bytes. Read-only joins during this story
accounted for the difference:

| Current protection | Movies | Nominal bytes |
| --- | ---: | ---: |
| Neither recent nor watchlisted | 8 | 205,673,367,828 |
| Recent only | 7 | 97,116,144,618 |
| Watchlisted only | 4 | 195,402,876,509 |
| Both recent and watchlisted | 2 | 36,907,995,044 |

There were no protective tags, open Saves, recent watches, unresolved ledger items, undated Plex
matches, failed rule evaluations or missing handle keys in that snapshot. The 180-day Age Guard
takes the newest download import or Plex date across servers, so a title old enough on the
Maintainerr rule's HOps Plex server can still be recent on another server. Lowering the minimum
alone would free only about 206 GB after its seven-day save window, below the approximately
1.45 TB net addition observed over the preceding week; it does not provide sustained catch-up.

## Read-only projections and the chosen knobs

Maintainerr 3.31.0's live movie rule group is **1**, libraryId **string `"1"`**, dataType `movie`,
collectionId **1**. The API constants and deployed contracts/comparator confirm these predicates:

| Entity | Predicate |
| --- | --- |
| 151 | Radarr IMDb rating (`firstVal: [1,16]`), action `SMALLER=1`, value `"6.0"` |
| 152 | Radarr IMDb votes (`[1,19]`), `BIGGER=0`, value `"99"` |
| 153 | Plex movie views (`[0,5]`), `SMALLER=1`, value `"1"` |
| 154 | Radarr tags (`[1,2]`), `NOT_CONTAINS=9`, value `"mediarequests"` |
| 155 | Plex added date (`[0,0]`), `BEFORE=5`, value `"15552000"` seconds |

The entity IDs in this table are the pre-change snapshot, not stable identifiers: Maintainerr
deletes and recreates condition rows on update. All clauses share section 0; clauses after the first use `AND=0`. The number comparisons are
strict `<` and `>`; BEFORE compares `addedAt <= now - seconds`.

The projection read all 5,240 HOps Plex movie entries with GUIDs, live Radarr ratings/tags, and
the database's Save, newest-age, recent-watch and watchlist facts. It checked discover-id-only
watchlist membership against the Plex GUIDs and Maintainerr group/global exclusions too. It read
all 26/26 HOps movie history entries and used `max(history.length, nativeViewCount)`, matching the
deployed `plex-adapter.service.js`. No watchlist changes were recorded in the preceding 30 minutes.
The following figures retain the existing vote, request-tag, never-watched and age predicates:

| IMDb cutoff | Projected movies | Total nominal TB | Largest 50 nominal TB |
| --- | ---: | ---: | ---: |
| < 6.5 | 524 | 13.875 | 3.587 |
| < 7.0 | 1,376 | 38.151 | 4.034 |
| < 7.5 | 2,270 | 65.467 | 4.230 |

**These are projections, not a native rule evaluation or physical reclaim guarantee.** The baseline
< 6.0 projection still includes one 59.47 GB title absent from the native pool, even after its
per-item Plex history read returned no plays. Its exact native exclusion remains unverified.
The driver must confirm the native pool and the selected batch after the normal evaluation.
At < 6.5, the default worst-rated first 50 project only 1.490 TB; largest first is material to the
3 TB initial weekly-batch target. TV's exploratory database census is not an exact native show-view
evaluation and does not justify changing its rule.

The driver ratified these **pending runtime changes** within Tom's catch-up authorization:

- Movie rating cutoff `6.0 → 6.5` only, preserving its other four clauses and safety flags.
- Movie `strategy: 'largest'`, `maxItems: { enabled: true, value: 50 }`.
- Space-policy minimum `10 → 1`; retain the seven-day save window and 75% ceiling.
- Keep TV predicates and its five-item cap unchanged; preserve all app protections.

Use `upsertTrashRule` with the freshly read group: identify the rating predicate by
`firstVal: [1,16]`, `action: 1`, section 0 and its null operator, then change only its encoded
RuleDto `customVal.value` to `"6.5"`. Its shape is `{operator:null,action:1,firstVal:[1,16],customVal:
{ruleTypeId:0,value:"6.5"},section:0}`. Round-trip the full group, leaving identity, manual-collection
fields and every other predicate unchanged. The domain seam decodes the entities and preserves and
reads back `arrAction`, `listExclusions`, `forceSeerr`, the server selection and aging horizon.
Compare decoded predicate bodies after the write; do not require the regenerated entity IDs to match.
Use audited `setAppSetting` for policy changes; source defaults are unchanged.

## Durable automation exclusions

Read-only cross-check of unique batch-item identities against the live libraries/exclusion lists:

| Kind | Recorded deleted | Present now | Present without exclusion | Absent now | Absent without exclusion |
| --- | ---: | ---: | ---: | ---: | ---: |
| Movie | 549 | 34 | 32 | 515 | 0 |
| TV | 13 | 1 | 0 | 12 | 0 |

The earlier release-record cross-check counted 29 present movie titles; this batch-item population
is broader and should not be presented as the same denominator. Missing exclusions are confined
to currently present movies. ADR-097 deliberately left present titles out of the October 3
backfill and kept the already-returned titles as fresh downloads. There is no demonstrated current
exclusion-writer defect and no justification here for another backfill or retroactive deletion.

The current writer reads exclusions, posts missing identities, reads them back before Phase A and
Maintainerr's handle, and audits successful writes. Existing tests cover both kinds, no-op existing
exclusions, write/read-back failure and refusal before deletion, partial writes/retry, and present
backfill exemptions. Seerr's explicit requests bypass import-list exclusions by design; neither
the source fix nor these proposed knobs change that path. The Release Block remains in force.

Read-only profile readiness: exactly one enabled managed deleted-release profile on each *arr,
543 ignored terms on Radarr and 64 on Sonarr, no required terms, no tags, indexerId 0. This confirms
profile shape, not future candidate-specific release identity or a successful future reconciliation.

## Source fix and validation

The space-policy minimum/count/byte filter omitted `!saveIntent`, although the batch builder already
excluded open Saves. A pending Save could therefore satisfy a minimum for a batch that could not
include it. The fix adds the same check; DESIGN-014 records the accounting correction. The new
PostgreSQL 16 regression creates a Save whose Maintainerr enforcement fails, proves it contributes
neither count nor bytes and creates no batch/event/notification below the minimum, then proves a
lower minimum proposes just the two unsaved items.

Validation completed locally:

- `pnpm --filter @hnet/domain exec vitest run __tests__/space-policy.test.ts __tests__/title-exclusion.test.ts --maxWorkers=1`
  — 39 passed, two files; one worker, serial suite.
- `pnpm --filter @hnet/domain exec tsc --noEmit` — passed.
- `pnpm --filter @hnet/domain exec eslint src/space-policy.ts __tests__/space-policy.test.ts` — passed.

The fresh dependency installation skipped scripts; initial PostgreSQL boot failed because its
packaged shared-library symlinks were not hydrated. Running the package's own
`scripts/hydrate-symlinks.js` from that package directory repaired the local install; the subsequent
suite passed. No repository dependency, lockfile or system package change was needed.

The worker's handoff was source-only. The following driver checkpoint records the subsequent
runtime work separately.

## Driver runtime confirmation — 15:18 UTC

The movie rule update was applied through `upsertTrashRule` at 14:53 UTC. Its fresh read-back
confirmed IMDb < 6.5, the other four predicates, section 0/AND grouping, activation, library and
collection identity, and all safety flags. Maintainerr regenerated condition IDs 151–155 as
160–164; a stricter operator check initially stopped on that ID change. Comparing the decoded
predicates confirmed the intended result, so the rule PUT was not replayed. The normal refresh
marker was armed through `requestPoolRefreshAfterSave` at 14:54 UTC. The 15:00 incremental sync
accepted it, and Maintainerr completed movie evaluation at 15:05:09 UTC and TV at 15:07:47 UTC.

The actual native movie pool held 619 entries. Applying the proposal's Save, tag, watchlist and
Age Guard filters left 529 entries and 14,067,971,814,952 nominal bytes. The largest 50 held
3,591,025,375,575 nominal bytes. One had a current recent-watch guardian hold, leaving 49 and
3,525,999,994,557 nominal bytes without a known current hold. There were no failed-rule,
unknown-age or missing-ledger-identity cases among those 50. These observations supersede the
earlier projected counts; they do not remove any deletion-time check.

At 15:07:46 UTC, audited `setAppSetting` installed minimum 1 and the largest-first movie strategy
with cap 50. The effective per-array minimum was read back. The seven-day save window, 75% ceiling,
TV predicates and five-item TV cap were retained. No direct SQL update or accelerated expiry was used.
The 15:15 sync refreshed the cached movie snapshot to 619 entries.

The normal 15:17 space-policy job succeeded and created one **Leaving Soon** movie batch:

| Evidence | Observed result |
| --- | --- |
| Selected items | 50 |
| Selected nominal bytes | 3,591,025,375,575 |
| Greenlit | 2026-10-30 15:17:11.487 UTC |
| Save window ends | 2026-11-06 15:17:11.487 UTC |
| Deleted at this checkpoint | 0 |

The log's `candidateBytes` is the full 14.068 TB eligible pool, not this batch's selected size.
Selected bytes above come from the batch-item sum. Saves, changed watchlists, fresh guardian checks,
release/exclusion preflight, deletion outcomes and hardlinks can reduce actual physical reclaim.
Measure the subsequent sweep and physical free-space change before claiming an achieved net rate.

The current exclusion check also has deployed evidence: today's successful Kometa collections run
logged titles ignored by Radarr's exclusion list. All 515 currently absent deleted movies and 12
shows had exclusions. No backfill or Seerr test request was executed.

Source PR [#1049](https://github.com/thaynes43/haynesnetwork/pull/1049) merged as `cfca294f` after all
four required checks passed, independent native review and Claude advisory review. The native
review's condition-ID documentation correction was addressed before merge. The Save-accounting
patch is awaiting normal release [#1051](https://github.com/thaynes43/haynesnetwork/pull/1051) and
deployment [haynes-ops #4448](https://github.com/thaynes43/haynes-ops/pull/4448). At this checkpoint
the runtime still runs v0.126.0; the live filter configuration and source-image installation are
separate states. Deployment must wait for final-head release checks and image publication.

Inventory story #297 is complete with merged PR #1050 and
[its bounded inventory and cleanup evidence](2026-10-30-tower-storage-inventory.md).
No retained file was proved safe to purge; no cleanup was performed. The host SSH timeout, partial
Music inventory and unresolved legacy ownership remain recorded there. OpenProject #296 carries
the latest delivery checkpoint and next safe step.
