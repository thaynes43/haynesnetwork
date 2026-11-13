# ADR-119: A library-fill Plex date does not extend the Age Guard

- **Status:** Proposed (2026-11-13). The owner ruled on 2026-11-13, recorded on story 822, to change the
  2026-10-03 "newest date wins" rule for library fills. This ADR records the rule that tells a fill from a real
  arrival, including the ledger-coverage guard added after the review of PR 1067. It is not Accepted until the
  coordinator accepts it.
- **Date:** 2026-11-13
- **Deciders:** the owner (ruling of 2026-11-13). Drafted in the story 836 session. The review of PR 1067
  (2026-11-13) added the ledger-coverage guard, the wrong-type exclusion, and the `unknown` verdict for a title
  with no Plex match. The coordinator's correction order took those and kept the setting off.
- **Amends:** the Age Guard decision recorded in [DESIGN-052 D-26](../designs/052-watchlist-protection-and-release-block.md).
  That decision was an owner ruling in the design. It was not given its own ADR, so there is no Accepted ADR to
  supersede. [DESIGN-052 D-31](../designs/052-watchlist-protection-and-release-block.md) is the amendment. A
  paragraph inside D-26 already pointed at this rule; this correction also changes D-26's no-match line, so
  `judgeAge` returns `unknown` for a title no Plex library is matched to. The rest of D-26 (the 180-day window,
  download imports, folder imports ignored, fail closed for an undated match, the guardian order) stands.
  ADR-023 stands.

## Context and problem statement

The Age Guard keeps a title whose newest date is inside 180 days. The newest date is the later of the ledger's
download imports and the Plex date added on every library that holds the title.

On 2026-11-13 the HaynesOps TV library's oldest added date is 2026-07-02. That date is inside 180 days, so the
guard keeps every show, including shows whose other server added them years earlier. The 2026-11-13 TV Trash
audit measured 808 of 953 HaynesOps shows with an other-server added date already past 180 days. The owner
agreed that a library-fill date should stop doing that, and that a real download import or upgrade must still
protect the title.

A show's Plex date does not move when an episode arrives. The ledger's first Sonarr download import is
2026-07-03 11:20:40 (review of PR 1067, `min(occurred_at)` on replica `postgres16-11`). The window on that day
reaches back to 2026-05-17, so the ledger cannot see an import in those 47 days. Removing a fill stamp in that
gap would drop protection from a show that received episodes the ledger cannot see. The review named Criminal
Record and The Late Show with Stephen Colbert as proven cases among the 389.

The 869 fill stamps run from 2026-07-02 22:00:21 to 2026-07-03 00:36:12, so they stop protecting on their own
between 2026-12-29 21:00:21 and 23:36:12. The Sonarr ledger covers a full window only from 2026-12-30 10:20:40
(review, 2026-11-13).

A wrong rule here drops protection from something a person just got. Where the evidence does not separate a
fill from a real arrival, the title stays protected.

## Decision drivers

- A real download or upgrade inside 180 days still protects the title. The ledger-coverage guard is what makes
  that true while the ledger cannot see the whole window.
- A title present on one server only keeps today's behaviour.
- With the switch off, the date selection is today's rule. A title with no Plex match is `unknown` either way,
  and that only ever keeps more.
- The switch ships off. Turning it on is story 823, and only after the conditions in D-31.
- No other keep (Save, `dnd`, watchlist, recent watch) changes.
- Prefer keeping a title when a day cannot be told from a real arrival.

## Considered options

- **A. Ignore every Plex date that has no download import within 6 hours, whenever another server is older.**
  Rejected. The ledger's download history starts 2026-07-02 (Radarr) and 2026-07-03 (Sonarr). Movie added dates
  from 2026-05-17 through 2026-06-30 are inside the window and have no import to show. On the replica those days
  are a trickle (the largest is 12 titles). Treating "no import" as a fill would drop protection from real
  arrivals the ledger cannot see. Measured 2026-11-13: 157 movies are recent only by a Plex date against an older
  date and have no download import inside 180 days (5,155,985,257,336 bytes). This option would clear all 157.
- **B. Hard-code 2026-07-02 and 2026-07-03.** Rejected. The next fill would not match, and a real arrival on those
  dates would be classified by the calendar instead of by the evidence.
- **C. A library-day is a fill when it holds at least 100 titles and at most 5% of them have a download import
  within 6 hours of their own added date. A fill stamp does not count when another server has a strictly older
  date. A stamp with its own nearby import still counts. One server keeps every stamp.** Chosen, then narrowed
  by the review of PR 1067: the rule does not run until that *arr's first download import is at least 180 days
  old, and a stamp from a library whose type does not fit the title never counts as the older date.

## Decision outcome

Chosen option: **C**, with the two review limits, behind the audited setting `age_guard_ignore_library_fill`,
default **off**.

Off, `loadAgeEvidence` does not read fill days. The newest Plex date is the newest across every library, as the
rest of D-26 states. A title with no Plex match, and no download import inside the window, is `unknown`. That
holds with the setting on or off. It is the one change in this ADR that alters today's behaviour, and it only
ever keeps more. Measured 2026-11-13 on replica `postgres16-11` (`SELECT` on `trash_candidates`,
`trash_candidates_state.refreshed_at` 2026-11-13 15:15:05.495-05): 0 of 524 movie candidates have no Plex match,
and the TV pool has 0 members.

On, a Plex added date is left out of that newest date only when all of these hold:

1. That *arr's first `downloadFolderImported` event in the ledger is at least 180 days old. A missing first
   import does not qualify. The other *arr's history does not count. Compared as `judgeAge` compares a date:
   the first import is inside the window when `now - first < 180 days`, and then every stamp stays.
2. Its library-day (that Plex library, the America/New_York calendar date) has at least 100 titles and at most
   5% of them have a `downloadFolderImported` event within 6 hours of that title's own added time.
3. This title does not itself have a download import within 6 hours of this stamp.
4. A different Plex server has a strictly older added date for the title, in a library whose type fits the
   title (a movie library for Radarr, a show library for Sonarr).

With the guard in (1), the rule does nothing for the July 2026 fill. Those stamps stop protecting on their own
on 2026-12-29. The rule works for any later fill.

The oldest dated stamp that can retire another always remains, because nothing fitting is strictly older than
it. An undated match on another server is not an older date. Two libraries on the same server are not two
servers. A download import inside 180 days still protects the title whether or not its Plex stamp was left out.

The integer 100 is the cutoff. The review of PR 1067 (2026-11-13, the review's SQL with the minimum varied)
measured the same 389-show and 40-movie verdicts for every integer from 13 through 232. At 12, 46 movies
change; at 9, 65; at 8, 70. Not 9 through 232. 100 also sits above the 39-title movie day of 2026-05-05, which
is outside the window and is not called a fill. The 5% test had no power on the July fill: the last scan stamp
plus 6 hours is 2026-07-03 06:36, and the first Sonarr import is 11:20:40, so "0 of 638" and "1 of 232" would
read the same had every show been downloaded that night. The label is still right on evidence the rule does
not use (869 stamps in 2 hours 36 minutes, 866 with an other-server date more than a day older). The evidence
and the census are in D-31. That census is the Age Guard alone. Under the live pools the switch changes no
deletion today.

`setAgeGuardIgnoreLibraryFill` is the audited way to set the value and to set it back. It refuses a non-boolean
and calls `setAppSetting`, which writes the row and an `update_app_setting` audit row in the same transaction.
The admin mutation `trash.settings.set` accepts the boolean. This ADR does not turn the setting on and does not
add a control on the settings page.

### Consequences

| ID   | Consequence |
| ---- | ----------- |
| C-01 | Good, and bounded: with the guard, the July 2026 fill is left alone. Its stamps stop protecting on their own on 2026-12-29. The paper census of 389 shows (85,031,322,181,927 bytes) and 40 movies (1,368,757,512,491 bytes) is the Age Guard alone, as if the ledger already covered the window (worker census 2026-11-13 12:51:41-05, reproduced by the review the same day). Under the live pools the switch changes no deletion today (review: TV pool 0 members; movies 524, 464 clear and 60 recent before and after). |
| C-02 | Good: a download import or a non-fill added date inside 180 days still protects. The guard is the guarantee while the ledger cannot see the whole window: `applyLibraryFill` leaves every stamp unless that *arr's first download import is at least 180 days old. A title on one server keeps today's rule. With the setting off, the date selection is today's rule. A title with no Plex match is `unknown` either way, which only ever keeps more. |
| C-03 | Bad: a real download burst of 100 or more titles in one library on one calendar day, with under 5% of them recorded as download imports, would be treated as a fill once the ledger covers the window. Titles in that burst that are older on another server, and have no import inside 180 days, would lose Plex protection. No in-window day on the 2026-11-13 replica has that shape except the TV fill, and the guard leaves that fill alone. |
| C-04 | Bad: a fill split across midnight into two days of under 100 titles each would not be recognized. Those titles stay protected, which is today's behaviour. |
| C-05 | The setting is off until story 823 turns it on, and only after the five conditions in D-31. This ADR does not enable it and does not change Save, `dnd`, watchlist, or recent watch. |
| C-06 | A stamp from a library whose type does not fit the title never counts as the older date. The matcher that pairs a movie with a show sharing an id number is not fixed here (story 847). |

## More information

Evidence note: `.agents/context/2026-11-13-age-guard-library-fill.md`. Design: DESIGN-052 D-31. Code:
`packages/domain/src/trash-age-guard.ts`. Migration 0109 admits the setting key and inserts no row. Its journal
index is 107, the next index after migration 0107 on current `main`; the filename is 0109 because 0108 is
reserved by another open change. Plan: PLAN-091. Questions: DESIGN-052 Q-24 and Q-25.
