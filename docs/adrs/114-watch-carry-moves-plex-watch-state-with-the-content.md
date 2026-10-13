# ADR-114: The Watch Carry moves each person's Plex watch state with the content

- **Status:** Accepted (owner ruling on issue #928, 2026-10-13: "Carry marks, then move")
- **Date:** 2026-10-13
- **Deciders:** Tom Haynes. Drafted by Opus 5.5.
- **Amends:** [ADR-017](017-plex-library-sharing.md) C-10 and [ADR-088](088-watch-history-read-model-and-marks.md)
  (the Plex write surface: the app wrote watched state only as the owner, through a Watch Mark), and DESIGN-055 D-04
  decision 10 and P4 decision 23 (a Plex ordering change was out of scope; a season with watch state was not moved).
  Hard rule 4's write-back list gains one sentence (C-10 here).
- **Design:** [DESIGN-055](../designs/055-self-service-media-repair.md) P4 decisions 26 to 34 ("The Watch Carry").
  Plan: PLAN-077, P4 follow-up "The Watch Carry".

## Context and problem statement

Staff's Season Re-map (DESIGN-055 P4 decisions 18 to 24) puts misfiled episode files on the episodes they really are.
Plex keeps a person's watched mark, play count and resume point on the **episode** (its metadata item, keyed by the
item's guid), not on the file. So when a file moves from episode A to episode B, everyone who watched it still shows A
as watched, which now plays something they never saw, and B as unwatched. The same happens when a show's Plex ordering
is switched to TheTVDB (the file's episode number stays, but the episode it is matched to changes), and when the
Second-Copy Fix deletes a file whose slot someone watched: the real episode that later fills the slot comes back
"watched".

The owner held every season where a real person has watch state (31 seasons, 11 accounts on HaynesTower, issue
#928), and the three shows whose ordering needs switching (Alaskan Bush People, Fireman Sam, Pokémon). His ruling
(2026-10-13): carry the marks, then move.

Facts this decision relies on (read live, 2026-10-13):

- plex.tv's `GET /api/servers/{machineId}/shared_servers` (owner token) lists each friend's per-server
  `accessToken`. With it, the server answers `allLeaves` with **that friend's** `viewCount`, `viewOffset` and
  `lastViewedAt`; a sample of 26 items matched the server database exactly. The same token writes that friend's
  state.
- `/:/scrobble` adds one play each call (view count 1, then 2) and sets the watch date to now. `/:/unscrobble` clears
  the play count and the resume point. `/:/progress?time=<ms>&state=stopped` sets a resume point, but Plex keeps none
  of 60 seconds or less on an unwatched item.
- Plex keeps watch state by the item's guid. A guid's state outlives its item: HaynesTower empties the trash after
  every scan (`autoEmptyTrash=1`), so an episode left without a file loses its item, and a file that later lands on that
  episode inherits the old state. Such an orphaned mark can only be cleared while the item still exists.
- A two-episode file is **one** Plex item, at its first episode's number (Mickey Mouse: Mixed-Up Adventures S01 on
  HaynesTower: `S01E13-14-15-16` is item E13, with no E14 to E16 items).
- Sonarr asks both Plex servers to scan the series folder after every rename (Connect, `onRename`), so each moved file
  reaches its new item within the run.

## Decision drivers

- Nobody's history may change meaning: what a person watched stays watched, on the episode that now plays it; what they
  never watched never gains a mark.
- Another person's state is written only for a staff move that changes what their marks point at, and only to put the
  same state on the same content.
- Friends' tokens are secrets that must never be stored or printed.
- A move must never run without a stored snapshot, so a failed run can be finished or reverted.

## Considered options

1. **The Watch Carry:** snapshot every account's state per file, move, then write each account's state onto the
   episode that now plays that file, as that account, with an audit row per mark and a verification per account.
2. **Move, and leave the marks** on the episode numbers (the alternative #928 offered).
3. **Never move** a season with watch state, and never switch those shows' ordering.

## Decision outcome

Chosen option: **1**, the owner's ruling on #928, because it is the only option that fixes what viewers see without
changing anyone's history.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Content is the file.** A file is identified on each Plex server by its byte size (unchanged by a move or a rename; the item's file name is kept for display). A person's state for a file is the state of the item that played it. A two-episode file is one content: Plex plays the whole file from its one item, so a mark on that item means the whole file (both segments) was watched. A second copy's content is the original file's (staff evidence, DESIGN-055 P4 decision 25). |
| C-02 | **Snapshot first, stored.** Before anything moves, the carry reads every account that can see the show's library on every Plex server that carries the series: the owner with the server's own token, each friend with the per-server token plex.tv lists for them (read at run time, held in memory only, never stored, logged or printed). It stores each Plex item of the scope with its files, and each account's play count, resume point and watch date on each item, in `watch_carries` and `watch_carry_states`. A read that fails for any account refuses the move. |
| C-03 | **Clear what would be orphaned, before the move.** Items whose file the operation moves away or deletes are cleared for each account with state on them (`/:/unscrobble`) before the move, because their items may disappear with their files and a guid's mark outlives its item. An ordering switch clears, before the switch, the items with state whose Plex title differs from Sonarr's title for the same number (the items it re-matches). The snapshot keeps what was cleared. |
| C-04 | **Carry after the move.** Once every moved file sits on its Sonarr episode's Plex item on each server (bounded wait), each account's state on each item in scope is set to the state of the file it now holds: a watched file is marked watched with its play count (one scrobble per play, at most 5), a resume point is set again (above 60 seconds), and an item whose file the account never played is cleared. Items whose file did not change are never written. An item the account played after the snapshot is left as it is (a real new view). |
| C-05 | **The hard cases.** A second copy's slot is cleared, and the person's plays of it are carried to the original's item (they saw that content); the real episode that later fills the slot comes back unwatched. A two-episode file carries a mark only when the person watched that whole file; a resume point inside it is carried as a resume point, never as a mark, and recorded as `partial`. |
| C-06 | **Verified per account.** After the carry each account is read again on every server: every file they had watched shows watched on the item that now plays it, no item whose file they never played shows watched, and each resume point sits on the item holding its file. The counts are recorded on the carry and printed by the tool. A mismatch leaves the carry `mismatch`; the tool's `carry-finish` runs the carry again from the stored snapshot. |
| C-07 | **Audit.** One append-only `watch_carry_marks` row per mark written (account id, server, item, the state before and the state written, the Plex calls, the result, the phase: pre-clear, carry or revert), in the same transaction as the carry's counters. `carry-revert` restores every written item to its state before, newest first, from those rows. Plex account ids are stored; names and emails are not. |
| C-08 | **The Plex ordering switch** becomes a staff tool: `PUT /library/metadata/{show}/prefs?showOrdering=<ordering>` and `PUT /library/metadata/{show}/refresh` on each server carrying the show, read back, inside a Watch Carry over the whole show. It replaces the hand op of the #928 round (decision 10's "own ADR, a Plex write and a watch-state check"). |
| C-09 | **Staff only.** Only the in-cluster tool (`repair-guide.ts`) starts a carry: inside `season-run`, `copy-run` and `ordering-run`, and as `carry-finish` and `carry-revert`. No person-facing surface writes another person's state. |
| C-10 | **Hard rule 4** gains one sentence: the Watch Carry writes each account's Plex watched state and resume point (`scrobble`, `unscrobble`, `progress`) with that account's own server token, and a show's Plex ordering, only inside a staff move, through `@hnet/plex/write` from `packages/domain`. |
| C-11 | Good: watched seasons and the three held shows can be fixed without changing anyone's history; a failed run can be finished or reverted from the stored snapshot. |
| C-12 | Bad: a carried mark's watch date becomes the carry time, and a play count above 5 is carried as 5 (the original count and date stay in the snapshot). Plex keeps no resume point of 60 seconds or less. Accepted: Plex offers no call that sets either, and nothing in the app reads more than "watched". |
| C-13 | Bad: the app now acts as other people on a Plex server. Accepted: only staff, only to carry each person's own state onto the content they watched, each write audited and reversible. |

## More information

- Builds on ADR-017 (the Plex write surface), ADR-088 (scrobble and unscrobble as the owner), ADR-109 and ADR-110 (the
  Episode Re-map and the Title Check), DESIGN-055 P4 decisions 18 to 25.
- Glossary T-326 (Watch Carry), T-327 (Carry Snapshot).
- Plex endpoints: `/:/scrobble`, `/:/unscrobble` and `/:/progress` with `identifier=com.plexapp.plugins.library`;
  `GET {plex.tv}/api/servers/{machineId}/shared_servers` (`accessToken` per SharedServer).
