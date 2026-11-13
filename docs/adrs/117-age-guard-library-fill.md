# ADR-117: A library-fill Plex date does not extend the Age Guard

- **Status:** Proposed (2026-11-13). The owner ruled on 2026-11-13, recorded on story 822, to change the
  2026-10-03 "newest date wins" rule for library fills. This ADR records the rule that tells a fill from a real
  arrival. It is not Accepted until the coordinator accepts it.
- **Date:** 2026-11-13
- **Deciders:** the owner (ruling of 2026-11-13). Drafted in the story 836 session.
- **Amends:** the Age Guard decision recorded in [DESIGN-052 D-26](../designs/052-watchlist-protection-and-release-block.md).
  That decision was an owner ruling in the design. It was not given its own ADR, so there is no Accepted ADR to
  supersede. D-26 is not edited. [DESIGN-052 D-29](../designs/052-watchlist-protection-and-release-block.md) is the
  amendment. ADR-023 and the rest of D-26 (the 180-day window, download imports, folder imports ignored, fail closed,
  the guardian order) stand.

## Context and problem statement

The Age Guard keeps a title whose newest date is inside 180 days. The newest date is the later of the ledger's
download imports and the Plex date added on every library that holds the title.

On 2026-11-13 the HaynesOps TV library's oldest added date is 2026-07-02. That date is inside 180 days, so the guard
keeps every show, including shows whose other server added them years earlier. The 2026-11-13 TV Trash audit
measured 808 of 953 HaynesOps shows with an other-server added date already past 180 days. The owner agreed that a
library-fill date should stop doing that, and that a real download import or upgrade must still protect the title.

A wrong rule here drops protection from something a person just got. Where the evidence does not separate a fill
from a real arrival, the title stays protected.

## Decision drivers

- A real download or upgrade inside 180 days still protects the title.
- A title present on one server only keeps today's behaviour.
- With the switch off, behaviour is today's rule exactly.
- The switch ships off. Turning it on is a later story.
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
  date. A stamp with its own nearby import still counts. One server keeps every stamp.** Chosen.

## Decision outcome

Chosen option: **C**, behind the audited setting `age_guard_ignore_library_fill`, default **off**.

Off, `loadAgeEvidence` does not read fill days. The newest Plex date is the newest across every library, as D-26.

On, a Plex added date is left out of that newest date only when all of these hold:

1. Its library-day (that Plex library, the America/New_York calendar date) has at least 100 titles and at most 5%
   of them have a `downloadFolderImported` event within 6 hours of that title's own added time.
2. This title does not itself have a download import within 6 hours of this stamp.
3. A different Plex server has a strictly older added date for the title.

The oldest dated stamp always remains, because nothing is strictly older than it. An undated match on another
server is not an older date. Two libraries on the same server are not two servers. A download import inside 180
days still protects the title whether or not its Plex stamp was left out. `judgeAge` is unchanged: it judges the
evidence `loadAgeEvidence` returns.

The integer 100 is the cutoff. On the 2026-11-13 replica, any integer from 9 through 232, with the same 5% test,
labels the same in-window show days and changes the same verdicts. 100 also sits above the 39-title movie day of
2026-05-05, which is outside the window and is not called a fill. The evidence and the census are in D-29.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-01 | Good: with the setting on, the July 2026 HaynesOps TV fill no longer keeps a show that is already older than 180 days on the other server and has no download import inside the window. The paper census is 389 shows and 40 movies (D-29).                                                                                                                                                |
| C-02 | Good: a download import or a non-fill added date inside 180 days still protects. A title on one server keeps today's rule. The setting off is today's rule.                                                                                                                                                                                                                                |
| C-03 | Bad: a real download burst of 100 or more titles in one library on one calendar day, with under 5% of them recorded as download imports, would be treated as a fill. Titles in that burst that are older on another server, and have no import inside 180 days, would lose Plex protection. No in-window day on the 2026-11-13 replica has that shape except the TV fill this rule is for. |
| C-04 | Bad: a fill split across midnight into two days of under 100 titles each would not be recognized. Those titles stay protected, which is today's behaviour.                                                                                                                                                                                                                                 |
| C-05 | The setting is off until a later story turns it on. This ADR does not enable it and does not change Save, `dnd`, watchlist, or recent watch.                                                                                                                                                                                                                                               |

## More information

Evidence note: `.agents/context/2026-11-13-age-guard-library-fill.md`. Design: DESIGN-052 D-29. Code:
`packages/domain/src/trash-age-guard.ts`. Migration 0108 admits the setting key and inserts no row.
