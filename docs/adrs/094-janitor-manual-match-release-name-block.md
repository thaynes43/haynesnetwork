# ADR-094: The queue janitor acts on Lidarr's manual_match, and blocks the failing release name first

- **Status:** Accepted (2026-09-29; ships with the Lidarr `manual_match` cell in census, flipped by the coordinator
  after deploy)
- **Date:** 2026-09-29
- **Deciders:** Tom Haynes (two owner rulings, 2026-09-29: `manual_match` acts, with no waiting period, and is enabled
  as soon as it is deployed; "You can monitor for loops"). The release-name block is a **coordinator ruling by
  default**, made the same day under the owner's direction (act now, keep it generic, monitor loops) from the evidence
  of that day's hand sweep. Drafted by Opus 5.5.
- **Supersedes (in part):** ADR-083's class D clause as DESIGN-046 D-12 applied it to `manual_match` ("never acted
  on, reported only"; C-02 here), and ADR-093 C-08's "a single app-owned release profile per Radarr and Sonarr"
  (the app now also owns one janitor profile on Lidarr; C-03 here). ADR-093's Release Block itself is unchanged.
- **Amends:** hard rule 4's write-back list (CLAUDE.md), as ADR-083 C-04 and ADR-093 C-08 did, with the janitor
  release block (C-03).

## Context and problem statement

The ADR-083 queue janitor classifies every errored grab in the Sonarr, Radarr and Lidarr queues. DESIGN-046 D-12
(2026-09-28) answered Q-01: Lidarr's own match rejections ("Album match is not close enough", "Has missing/unmatched
tracks", "Couldn't find similar album", "Worst track match", "found multiple artists") became the class
`manual_match`, report only, because a removal could delete the only copy of a wanted album.

On 2026-09-29 the owner approved, by hand and twice, the action a person would take: remove the download with
blocklist and `skipRedownload`, then search the album again. About half the albums imported. The owner then ruled
that `manual_match` should act, with no waiting period.

The coordinator's hand sweep the same day ran exactly that action on 74 records (59 `manual_match` and 15 others):
55 of 66 albums got a new grab, 22 imported and 27 were stuck again. **18 albums grabbed a same-titled re-post of the
release that had just failed.** Lidarr's blocklist blocks one posting (its indexer and guid), not the release title,
so a search finds the same release posted again. 8 of the 27 stuck items were that same release. Grab, reject and
blocklist cycles, 29 SABnzbd duplicate-NZB rejections among them, ran to 10 grabs for one album before they stopped.
Remove, blocklist and search therefore loops at the level of the release title.

## Decision drivers

- The owner's rulings: act now, keep the mechanism generic (the janitor is being extended to the whole suite, books
  and comics included), and monitor for loops.
- A failed release must not come back under the same name on the next search, or the action wastes the album.
- The block must not reach other releases. A Lidarr release profile with no tags applies to every artist, and music
  titles are short: a term that matched "Greatest Hits" would block every artist's greatest hits.
- Lidarr never validates a term on write and compiles it only at decision time, so one malformed term would stop
  every release decision on Lidarr (the ADR-093 C-19 risk).
- Hard rule 4: write-backs only through `@hnet/arr/write` from `packages/domain`, never library files.
- Bounded growth, and a writer that repairs drift (a hand edit, a deleted profile).

## Considered options

1. **Remove, blocklist and search only (the owner's hand action), with a loop guard.** Rejected: the evidence shows a
   same-titled re-post on 18 of 55 grabbed albums. The loop guard would stop the loop only after it had spent the
   album's tries.
2. **Block the release name in a janitor-owned Lidarr release profile, written and read back before the removal**
   (chosen). A "must not contain" term built from the failing release's title stops every posting of that title on
   every indexer.
3. **Reuse ADR-093's Release Block profile.** Rejected: it exists on Radarr and Sonarr only, is found by a name that
   Lidarr's profiles do not have, and its terms come only from Deleted-Release Records with their own lifecycle. A
   second writer on the same profile would break its single-writer rule.
4. **A per-artist profile, scoped by an artist tag.** Rejected: it needs the app to write artist tags, a wider write
   surface than one profile, for a scope the whole-name term already gives.
5. **Keep `manual_match` report only.** Rejected by the owner's ruling.

## Decision outcome

Chosen option: **2, the janitor release block**, because it is the one option that stops a failed release from
coming back under its own name without touching anything but one app-owned profile, and because every part of it is
already proven by ADR-093's Release Block (a whitelist grammar, a write followed by a read-back, a 365-day term life,
a cap, drift repair).

Shape of the decision (normative; mechanics in DESIGN-046 D-13 and D-14):

- **An enforce cell for `manual_match`, on Lidarr only**, set through the existing audited config
  (`modes.lidarr.manual_match`), census by default. It counts in the promotion ladder like any other cell.
- **The action, once per download (DESIGN-046 D-11):** read the grab's own release title (Lidarr's grab history for
  the download, else the queue title) and the artist's name; derive the whole-name term; write it into the janitor's
  profile and read it back; only then remove the download from the client with blocklist and `skipRedownload`; then
  run one album search for the download's albums that are monitored and still missing tracks. A record with no album
  is removed and blocklisted, never searched (never an artist-wide search).
- **The term** is the release title's words anchored at both ends (`/^SEP*word SEP* word … SEP*$/i`), written with
  the raw apostrophes, accented letters and `&` as ADR-093's terms are. It blocks that exact title posted again, with
  any separators, and nothing with a word more or a word less. **The title must name the album's artist** (the
  artist's words as a run of whole words, a leading "The" optional) and carry at least one more word, and every word
  must be one the term can write (a word in another script, or a symbol such as `÷`, would be matched by any word);
  otherwise no term is
  written and the download is left alone (`skipped_unblockable`): the janitor never removes a `manual_match` download
  without blocking its name first.
- **The profile:** one per *arr the janitor blocks on (Lidarr today), enabled, no required terms, every indexer, no
  tags. Lidarr's release profiles have no name, so the profile is marked by a plain sentinel term,
  `haynesnetwork-janitor-managed-do-not-edit`, which also keeps it valid with no live term. A term lives 365 days from
  its latest block (the owner's Release Block ruling); at most 3,000 live terms per *arr, the oldest left out first.
  One writer, `reconcileJanitorReleaseBlock`, under an advisory lock; every term passes the whole-name grammar before
  any write; the janitor's hourly run repairs drift and drops expired terms.
- **Loops stay watched.** A re-post under a different title escapes the term. The loop guard holds an album the
  janitor has already removed as `manual_match` on two earlier downloads, while it is still monitored and missing
  tracks, so the janitor would search it again (`skipped_loop`); every held download and
  every target the janitor searched on two or more runs in seven days is listed in the nightly digest and logged as
  `[queue-cleanup] loop_detected`.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a release that failed Lidarr's match is not grabbed again under the same name, on any indexer, for a year, so the album search that follows reaches a different release. |
| C-02 | **Supersedes ADR-083's class D clause in part.** "Never acted on, reported only" now means `unknown` alone. `manual_match` takes class C's action shape (blocklist, then re-search only where the target is monitored), with the name block before it and the completeness check and loop guard after it. ADR-083's rails apply unchanged: census first, per-class per-instance audited config, the per-run cap, the minimum age, one action per download. |
| C-03 | **Hard rule 4 is amended** (as ADR-083 C-04 and ADR-093 C-08 did), and **ADR-093 C-08 is superseded in part** ("a single app-owned release profile per Radarr and Sonarr"): the write-back list gains the janitor release block, one app-owned release profile per *arr the janitor blocks on (Lidarr only), marked by its sentinel term, holding "must not contain" whole-name terms only, written through `@hnet/arr/write` from `packages/domain` by its one writer, before each enforced `manual_match` removal and in the janitor's hourly upkeep. It never touches library files, quality profiles or custom formats. CLAUDE.md changes in the same PR. ADR-093's Release Block profiles are separate and unchanged. |
| C-04 | Bounded growth: one term per blocked release name, 365 days from its latest block, at most 3,000 live per *arr. The term records are append-only and nothing deletes them; an expired record stops counting. |
| C-05 | Risk: over-blocking. The profile applies to every artist. A term is anchored at both ends and must contain the artist's name, so it blocks only a title identical, word for word, to the failing one. A good release posted under exactly that title is blocked too; the name is what failed, so that is the intent. A title that does not name the artist is never blocked, and that download is left for a person. |
| C-06 | Risk: a term that does not compile in .NET would stop every Lidarr release decision. Terms come only from the whole-name template, are checked against its grammar before every write, and must match the release title they were built from. |
| C-07 | Risk: a re-post under a changed title escapes the term. The loop guard (two earlier removals of the album) and the loop signals in the digest and the logs catch it, and the owner can alert on the log line. |
| C-08 | Neutral: generic by instance. The profile surface, the term records and the writer are keyed by instance, so the janitor can block names on another source (books, comics) with a term shape of its own. Each new source is a new write-back and needs its own ruling under hard rule 4. |
| C-09 | Bad: a new standing write surface on Lidarr, and one release-profile read per hourly run once the janitor has blocked anything there. |

## More information

- DESIGN-046 D-12 (Q-01, `manual_match`), D-13 (the enforce cell, the loop guard and the loop signals) and D-14 (the
  janitor release block). Build plan and ladder log: PLAN-065.
- ADR-083 (the census-first janitor), ADR-093 and DESIGN-052 D-12 / D-13 (the Release Block, whose term writing and
  writer this reuses).
- Lidarr v3.1.6.5078 upstream: `ReleaseProfileResource` (`{id, enabled, required, ignored, indexerId, tags}`, no
  name), `ReleaseRestrictionsSpecification` (the raw release title against every enabled profile's terms),
  `TermMatcherService` and `PerlRegexFactory` (a `/pattern/i` term is a .NET regex, anything else a case-insensitive
  contains), `HistoryController` (`downloadId` and `eventType` filters).
