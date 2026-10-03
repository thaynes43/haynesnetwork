# ADR-097: A title deleted through Trash is excluded from automation, by the app, before the delete

- **Status:** Accepted (2026-10-03; ships with the delete-path writer, and the one-off backfill runs after deploy:
  `--dry-run`, then `--apply`, DESIGN-052 D-28, OPS-017 §7)
- **Date:** 2026-10-03
- **Deciders:** Tom Haynes (two owner rulings, 2026-10-03, asked on his phone: **"Block automation only"**, with the
  backfill of every title deleted before Maintainerr wrote exclusions approved; and the titles automation already
  brought back, the 29 Kometa re-adds and 3 Seerr re-requests, are **kept as fresh downloads**, with no special Trash
  handling). The mechanism (the app's own writer, its place before Phase A, failing closed) is a **driver decision**.
  Drafted by Opus 5.5.
- **Extends:** ADR-093 (C-07: the Release Block stops the deleted release; this stops automation from bringing the
  title back at all) and its ruling 2 (a person may still request a deleted title).
- **Amends:** hard rule 4's write-back list (CLAUDE.md), as ADR-093 C-08, ADR-094 C-03 and ADR-095 did, with the
  Title Exclusion (C-04).

## Context and problem statement

Trash deletes a title through Maintainerr, which deletes it from Radarr or Sonarr. Nothing stopped automation from
adding it again. Between 2026-07-09 and 2026-10-03, Trash deleted 443 movies and 13 shows; 32 movies came back: **25
in one Kometa seasonal (Halloween) run on 2026-10-01 at 10:32 UTC**, 4 in other Kometa runs, and 3 through a
person's Seerr request. Each one is downloaded again (the ADR-093 Release Block makes it a different release, not no
release).

Radarr and Sonarr keep an **import-list exclusion** list: a title on it is skipped by the *arr's own import lists, and
Kometa skips it too (Kometa's ArrAPI client calls `respect_list_exclusions_when_adding()` for both Radarr and Sonarr,
and logs "N Movies ignored by Radarr's Exclusion List"). A person's request is not checked against it: Seerr adds a
title with `POST /movie` or `POST /series`, which never reads the list. Maintainerr writes an exclusion when it deletes
an item, but only while its rule pool carries `listExclusions`, which has been on since 2026-09-14 (ADR-093 C-10 now
holds the safety audit to it). The evidence is direct: **Kometa re-added 0 of the 73 movies deleted since that
setting, and 29 of the 370 deleted before it.** Of those 370, only 14 have an exclusion; with the 33 titles that are in
Radarr's library now left out, **324 deleted movies and all 13 deleted shows have none.**

The owner ruled on 2026-10-03, asked on his phone with three choices: **"Block automation only."** A title deleted
through Trash must never be re-added by automation (Kometa, import lists). A person can still request it in Seerr on
purpose (ADR-093 ruling 2, 2026-09-26, stands), and the Release Block still stops the exact deleted release. He
approved backfilling the exclusions for everything deleted before the Maintainerr setting existed. Asked separately
about the 32 titles already back, he ruled they are **kept as fresh downloads**, with no special Trash handling: the
backfill leaves out any title the *arr has now.

## Decision drivers

- The owner's rulings: no automated re-add, ever; a person's request still works; the 32 titles back stay.
- The guarantee must not rest on a Maintainerr setting the app does not own. The app's own Arm/Disarm once dropped
  `listExclusions` silently (DESIGN-052 D-16), and a rule pool recreated outside the app, or a Maintainerr upgrade,
  could lose it again. Maintainerr also writes the exclusion after its delete, so a Kometa run between the two
  re-adds the title.
- Fail closed, like the Release Block: a delete the app cannot protect does not happen this hour.
- Hard rule 4: write-backs only through `@hnet/arr/write` from `packages/domain`, by a single writer, audited.
- The 324 movies and 13 shows deleted without an exclusion must be covered too.

## Considered options

1. **Rely on Maintainerr's `listExclusions`, plus a one-off backfill.** Rejected: it keeps the dependency (driver 2),
   writes the exclusion only after the delete, and the app has no record of which exclusions exist.
2. **The app writes the import-list exclusion itself, before the delete, and backfills the past** (chosen).
3. **Add the deleted titles to Kometa's own configuration** (the app compiles Kometa collections). Rejected: it covers
   Kometa only, not the *arrs' import lists, needs a new Kometa write path, and Kometa already honours the *arrs' list.
4. **Also block a person's request** (a Seerr blocklist entry). Rejected by the ruling: a person may request a deleted
   title on purpose.
5. **Keep the Release Block alone.** Rejected: it stops one release, so a re-added title downloads another one; the
   25 Halloween re-adds of 2026-10-01 are that case.

## Decision outcome

Chosen option: **2, the Title Exclusion**, because it is the one option that stops every automated re-add on both
*arrs, owns the guarantee in the app, and leaves a person's request alone. Shape of the decision (normative; mechanics
in DESIGN-052 D-27 and D-28):

- **The write.** One app-owned single writer, `ensureTitleExclusions` in `packages/domain`, through `@hnet/arr/write`:
  under an advisory lock per *arr, in one transaction, it reads the *arr's exclusion list, `POST`s each missing title
  (Radarr `/api/v3/exclusions` with `{tmdbId, movieTitle, movieYear}`, Sonarr `/api/v3/importlistexclusion` with
  `{tvdbId, title}`), inserting one append-only `trash_title_exclusions` audit row for each POST the *arr
  acknowledges, then reads the list back as the gate for the delete. A failure part-way keeps the rows of the writes
  that landed, so every exclusion the app wrote is audited. A title already excluded (by Maintainerr, by hand, by an
  earlier run) gets no write and no row. It never deletes or edits an exclusion.
- **Where it runs.** In the delete paths' shared seam (`recordAndBlockReleases`), for every survivor about to be
  deleted, **after identity and before Phase A** (the Release Block) and so before the Maintainerr handle: the sweep,
  Expedite (item and all) and the manual Expire now. A failure stops there with nothing recorded, blocked or deleted:
  the sweep pauses (`paused_release_block`, step `exclusion`), Expedite and Expire now refuse with
  `PRECONDITION_FAILED`, the same paths a Release Block failure takes. A survivor with no tmdb id (Radarr) or tvdb id
  (Sonarr) is kept, like any item whose release cannot be recorded.
- **The backfill.** A one-off script (`title-exclusion-backfill.ts`, `--dry-run` then `--apply`), run the way the
  Release Block seed is run, for every title the ledger records as deleted through Trash, except a title the *arr has
  in its library now (the 32 the owner keeps, plus any other) and one already excluded. The dry run of 2026-10-03,
  from a read of the database replica and Radarr's and Sonarr's own lists: **324 movies and 13 shows to exclude**; 33
  movies left out because Radarr has them (the 32 re-added titles and The Devil's Mouth, whose 2026-08 delete never
  happened); 86 movies already excluded.
- **Maintainerr's `listExclusions` stays on**, and the safety audit still requires it (ADR-093 C-10): a second writer
  of the same fact, by design. The two cannot conflict: Radarr's and Sonarr's own delete handlers skip a title that
  is already excluded (verified in `ImportListExclusionService.HandleAsync` at Radarr 6.4.4 and Sonarr 4.0.20).
- **Removing an exclusion** stays a person's act in Radarr or Sonarr (DESIGN-052 D-23: no prune surface).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: neither Kometa nor an *arr import list can add a title Trash deleted, from the moment before the delete, whatever Maintainerr's settings say. |
| C-02 | Good: a person can still request a deleted title in Seerr (ADR-093 ruling 2), and the Release Block still makes that request fetch a different release. |
| C-03 | Good: the app records every exclusion it wrote (title, key, the *arr's exclusion id, the path, the batch item), so the Trash history can answer "why will Kometa not add this". |
| C-04 | **Hard rule 4 is amended** (as ADR-093 C-08, ADR-094 C-03 and ADR-095 did): the write-back list gains the Title Exclusion, one Radarr or Sonarr import-list exclusion per title, added by its single writer through `@hnet/arr/write` from `packages/domain`, before each Trash delete (the sweep, Expedite, Expire now) and from the one-off backfill; it never deletes or edits an exclusion, and never touches library files. CLAUDE.md changes in the same PR. |
| C-05 | Fail closed: if Radarr or Sonarr cannot take the exclusion, nothing is deleted this hour. A persistent failure pages like any other pause (the `sweep_paused` alert after 6 hours, the Trash banner). |
| C-06 | Risk: an exclusion written before a delete that then does not happen (the Release Block fails after it, a watchlist add during the sweep keeps the item, the handle fails) stays. It is inert while the title is in the library (an import list and Kometa only add a missing title), and Trash would write the same one on a later delete. If someone deletes that title outside Trash, automation will not add it back; an admin removes the exclusion in Radarr or Sonarr. Accepted. |
| C-07 | Risk: Trash's TV pool is a whole-show pool today (live, 2026-10-03: Maintainerr's one TV rule pool is type `show`), so the series exclusion matches what is deleted. A season or episode pool would delete files and leave the series; its exclusion would then be on a series that is still there (inert, C-06). The Release Block makes the same whole-series assumption. Revisit before arming such a pool. |
| C-08 | Bad: a new standing write surface on Radarr and Sonarr, and two exclusion-list reads per *arr per delete batch (a few hundred rows today). |
| C-09 | Neutral: the exclusions never expire, unlike the Release Block's 365-day terms. The ruling is "never re-added by automation"; the list grows by one row per deleted title, which Radarr and Sonarr handle as a plain table. |
| C-10 | Neutral: the 33 titles in Radarr's library now (the 32 re-added and The Devil's Mouth) get no exclusion from the backfill; the owner keeps them as fresh downloads. When Trash deletes one again, it gets its exclusion then. |

## More information

- DESIGN-052 D-27 (the writer and its place in the delete paths) and D-28 (the backfill). Operator procedure: OPS-017
  §7. PRD R-260, AC-38.
- ADR-093 (the Release Block, ruling 2 on re-requests, C-10's `listExclusions` invariant), ADR-084 D-3 (a Seerr
  request ignores the exclusion list).
- Upstream, verified at the deployed tags: Radarr v6.4.4.10685 `ImportListExclusionController` (`exclusions`,
  `exclusions/paged`; the POST validator refuses a tmdb id already excluded; `movieYear` 0 or more) and
  `ImportListExclusionService` (its `MoviesDeletedEvent` handler skips excluded ids); Sonarr v4.0.20.3014
  `ImportListExclusionController` (`importlistexclusion`, `importlistexclusion/paged`; `{tvdbId, title}`) and
  `ImportListExclusionService` (its `SeriesDeletedEvent` handler skips excluded ids); Kometa `modules/radarr.py` and
  `modules/sonarr.py` (`respect_list_exclusions_when_adding()`).
- Evidence (read-only, 2026-10-03): `trash_batch_items` (443 movies and 13 shows deleted), Radarr's history and
  tags for the 32 re-adds (`kometa-added` with `seasonalcollection` for the 25 of 2026-10-01), Radarr's exclusion
  list (88 rows) and Sonarr's (55, none of the 13 shows).
