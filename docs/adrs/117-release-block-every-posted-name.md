# ADR-117: Trash deletes a title only when its release has a verified posted name, and blocks every posted name

- **Status:** Proposed (2026-11-13; story 838, saga 813. Drafted for the coordinator and the owner to accept.)
- **Date:** 2026-11-13
- **Deciders:** the owner, by two rulings of 2026-11-13. On story 818: "We cannot, however, re-grab an index we already grabbed EVER", with a person still able to request the title again in Seerr. On story 838 (comment 8158), asked what Trash should do with a title whose release name is known only from the renamed file: "Get it done right don't ask if I want you to hack around something critical we absolutely cannot re-grab an index we grabbed before". Drafted in the same change as DESIGN-052 D-29.
- **Supersedes:** these parts of [ADR-093](093-watchlists-protect-trash-and-fresh-rerequests.md), which is otherwise unchanged:
  - C-07, and DESIGN-052 D-11 and D-25bd, where they record only the release on disk (or, for a title already gone, only its latest import);
  - C-22, where it lets a delete go ahead on a term built from the renamed file;
  - C-09 and DESIGN-052 D-13, where a delete may prune the oldest terms to stay under the cap. The hourly upkeep's prune stays.

## Context and problem statement

Before Trash deletes a title it writes "must not contain" terms into the Release Block, so that a later request does not fetch the same release again. Fetching it again breaks the indexers' terms.

Radarr renames a file when it imports it, and its record of the original names was lost when it was rebuilt on 2026-07-03. Two reviews measured what followed (`.agents/context/2026-11-13-trash-readd-audit-review.md`, and the adversarial review of PR 1070 recorded on story 838; all figures 2026-11-13):

- Every sweep delete since 2026-10-04 (183 of 183) took its term from the renamed file.
- For 468 of the 524 movies in the Trash pool the app held no posted name at all.
- A term built from the renamed file missed the real posted name for 61 of 1,129 movies, 5.4 percent. The reviewer built that term for every library movie whose posted name is also known and tested it against the name. In 51 of the 61 the indexer's title differs from Radarr's.
- The block remembered only the last file. A grab that failed, or one an upgrade replaced, was forgotten: 28 such names on 25 deleted movies matched no live term.

The names were not lost everywhere. The Radarr and Sonarr databases from before the move still exist on the old host. The coordinator extracted release names and sizes from them, read-only (never a URL, an indexer, a setting or a path), and measured them against the pool of 524 movies: all 524 are known to the old Radarr; for 472 the file on disk has the same size to the byte as the old file record, which carries the original release name; 523 have at least one grab event with its posted name; the grabbed or failed names total 1,012 (median 2 a title, at most 8).

## Decision drivers

- A release that was grabbed is never grabbed again. This is absolute: it is not traded against how fast Trash frees space.
- The block is on the release, never on the title. A person can always request a deleted title again in Seerr.
- Where the evidence is unsure, delete nothing and block more.
- The writers stay the ones that exist. A term is grammar-checked, written and read back before any delete, and a failed write or read-back deletes nothing.
- No download URL is stored or logged anywhere: they carry keys.

## Considered options

- **A. Keep deleting on the renamed-file term.** Rejected by the owner's ruling: it leaves about 1 release in 18 unblocked.
- **B. Keep every title with no verified name, and use only the names the app has today.** Safe, and it stops Trash: 56 of 524 pool titles could go.
- **C. B, with the names from the old databases loaded into the app, matched by the title's own id and the file's exact size.** Chosen.
- **D. Match the old download histories by title, year and a size ratio, and count a match as the file's name.** Rejected as a way to name a file: the review found a pool title where the only match was another film of the same name. Kept as a way to add terms.
- **E. A broader term for a title with no verified name** (alternate titles, no resolution test). Rejected: it still misses (1.9 percent measured) and it is not a verified name.

## Decision

| ID | Decision |
| --- | --- |
| C-01 | **A delete needs a verified name for every file on disk.** Trash deletes a title only when each file it has on disk has a verified posted release name, and a term for it is written and read back first. A title with only the name the *arr rebuilt when it renamed the file is kept (`release_unverified`) on every path that deletes: batch build, the sweep, Expedite and Expire now. A title with no file on disk has nothing to name. |
| C-02 | **What verifies a file's name.** (a) The *arr's own record of the file: the grab its import history joins it to, its scene name, or its original path. A scene name or an original path whose base name is the file's current path is the renamed file and does not verify. (b) The ledger's newest download import of the title, with its grab, when it agrees with the file (DESIGN-052 D-25bd); a folder import is a library scan and names nothing. (c) A legacy file record of the same title id (TMDB on Radarr, TVDB on Sonarr) with the **identical byte size** and an original release name; for a series the same season as well. Never a size ratio, never a title match. |
| C-03 | **Every posted name of the title gets a term**, not only the file's: every `grabbed` and `downloadFailed` event in the *arr's history and in the ledger, and every legacy row of the title's id (grabbed, imported, failed, or a file's original name). A failed grab counts. |
| C-04 | **A name with no term keeps the title.** A term is built from the name as stored, never trimmed, and must match that stored name as the *arr would test it. A name that names a release and yields no such term keeps the title (`release_unrecorded`). A name that names nothing a term could hold (a Sonarr season-0 special, a bare title with no mark of a release) is skipped and counted. A read of the title's names that does not finish keeps the title. |
| C-05 | **The legacy names live in two app tables**, `legacy_release_names` (keyed by the title's id) and `legacy_download_jobs` (the two old SABnzbd histories), loaded once from the coordinator's private extract by a one-off loader. No URL, indexer, download id, setting or path is stored. The extract never enters git. |
| C-06 | **A size match against a download history only adds.** A job matched to a movie by title, year and a 90 to 100 percent size ratio (DESIGN-052 D-15) adds a term. It never makes a file count as named, and it never removes another term. The live download client is not read on a delete path: its history starts the day of the rebuild and names nothing the ledger does not. |
| C-07 | **A delete never prunes.** If a title's terms would not all fit under the 3,000-term cap beside the live ones, the title is kept (`release_block_full`) and counted. The reconcile a delete path or the backfill runs refuses (`cap`) in place of pruning. |
| C-08 | **The same verdict everywhere.** The database's own view of C-02 (the Release Name Check, DESIGN-052 D-29) is read by the pending wall, the batch builder and the guardian, so the default wall never offers, and no batch ever proposes, a movie the delete would keep. The delete path reads the *arr's file and decides again. |
| C-09 | **The backfill** gives a record to every posted name of a title Trash already deleted that no live term matches, from the same sources. It never terms a title that is back in the library, never prunes, and never restarts a term's 365 days. |

## Consequences

- Until the legacy tables are loaded, 56 of the 524 pool movies can be deleted (54 whose import the ledger names, 2 with no file) and 468 are kept. That is the earlier read on 2026-11-13. A later read the same day, 17:00 ET, counted 525 pool movies, 55 named by the ledger, 57 deletable with the legacy tables empty, and 468 kept (DESIGN-052 D-29). After the load the coordinator's measurement gives 472 files named by exact size. The titles in neither set stay kept until a name for the file on disk is found.
- More terms per title. Radarr holds 619 distinct terms against a cap of 3,000, and the pool's 1,012 legacy names fit. Sonarr does not scale the same way: a series can carry hundreds of names, so a long series may be kept for want of room (C-07). A whole-name term for TV and the cap's successor are a later story.
- Some titles are kept that were deletable before: a name the grammar cannot write now keeps its title where it was skipped (review F4: 7 names on 3 movies, 253 on 8 series, none in today's pool).
- A term's 365-day life, which titles Maintainerr proposes, the pace, the restore routes and request protection are untouched.
- Hard rule 4 in `CLAUDE.md` is unchanged in substance: the Release Block's terms still come only from Deleted-Release Records, through its single writer.
