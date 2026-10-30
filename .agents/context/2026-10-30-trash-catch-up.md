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

All clauses share section 0; clauses after the first use `AND=0`. The number comparisons are
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

Use `upsertTrashRule` with the freshly read group: change only entity 151's encoded RuleDto
`customVal.value` to `"6.5"`. Its shape is `{operator:null,action:1,firstVal:[1,16],customVal:
{ruleTypeId:0,value:"6.5"},section:0}`. Round-trip the full group, leaving identity, manual-collection
fields and every other predicate unchanged. The domain seam decodes the entities and preserves and
reads back `arrAction`, `listExclusions`, `forceSeerr`, the server selection and aging horizon.
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

Next safe step: driver review/PR checks and independent native review, then driver-owned approved
configuration through the existing domain writers and exact native/batch validation. No media
deletion or accelerated expiry is part of this worker's handoff.
