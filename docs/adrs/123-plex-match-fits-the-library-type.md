# ADR-123: A Plex match stays inside the fitting library type

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** the owner (direction of 2026-11-13, saga 813, through the review of story 836). The coordinator accepted releasing the titles that lose a borrowed Plex date (story 847, comment 8232, 2026-11-13). The re-derived list is in that story's pull request.
- **Amends:** [ADR-047](047-library-play-here-access-aware-deep-links.md) the shared-GUID match. ADR-047 stays Accepted. Its gate, its deep link and its single-writer rule stand. This record adds the library type to the match. The decision text of ADR-047 is not edited; its status link points here.
- **Design:** [DESIGN-025](../designs/025-library-play-here-links.md) D-10. Glossary T-139 amended. No migration.

## Context and problem statement

ADR-047 resolves each ledger item to a Plex title by a shared id (`tmdb`, `imdb`, `tvdb`, `musicbrainz`) and stores `{plex library, rating key}` in `media_plex_matches`. The index did not include the library type. TMDB and TVDB number movies and shows separately, so the same number is a different title in the other library. A movie was stored against a show's Plex item, and the reverse.

The Age Guard, the Trash walls, the access gate, the collection drill-in and `mark_watched` use these rows. A wrong row lends a title another title's added date, and can hand `mark_watched` the other title's rating key. Household play counts are not read from these rows (C-05).

## Decision drivers

- A shared id number must not pair a movie with a show, or an artist with either.
- Every id kind the matcher uses follows the same type rule.
- A fitting row that is already right stays. A wrong row is removed by the app's own writer, not by a hand edit.
- Plex is read, never written. The Age Guard's own rule and the Trash rules stay as they are.

## Considered options

- **A.** Keep indexing by id alone.
- **B.** Match only inside the fitting library type, and delete a stored row that crosses types, through the existing writer.
- **C.** Edit ADR-047's match paragraph in place.

## Decision outcome

Chosen option: **B** — because the id spaces are separate, and an Accepted ADR is amended by a new record rather than edited.

The fitting pairs are radarr with a movie library, sonarr with a show library, and lidarr with an artist library. A photo library fits nothing. The matcher indexes each id under the section's library type and looks up only the kind's fitting type. TMDB and TVDB number movies and shows separately, so the same number in the other library is a different title. An IMDb id is one namespace, so a cross-type IMDb match can be the same work. Removing that row is still right, because that copy is not the other application's file and its added date is not the other title's date.

A section whose live type disagrees with the registry is not indexed and not scoped. The snapshot returns that library's id, the skip is logged at error, and the count is `typeDisagreements` on the `plex-match complete` line. `syncPlexMatches` leaves those libraries out of the cross-type delete, so a stale registry type cannot remove a row the skipped section will not put back.

`syncPlexMatches` deletes cross-type rows in the same transaction, after the upsert and before the reconcile. A stale wrong row in a library the run read in full is therefore counted as `crossTypeRemoved`, not as `removed`. So is a row in a library that run did not read, and a row the upsert just wrote. When `crossTypeRemoved` is not zero the run logs the report's groups. `repairCrossTypePlexMatches` is that delete. A dry run selects and writes nothing, and prints title, year, kind and library for each selected row. An apply deletes the selected rows and nothing else. A second apply selects nothing. The one-off script judges type from the registry, because it does not read Plex.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Good: a movie and a show that share an id number each match their own Plex item.                                                                                                                                                                                 |
| C-02 | Good: the next match run removes a cross-type row after the upsert and before the reconcile, and counts it as `crossTypeRemoved`. The one-off repair removes the same rows. A fitting row stays. When the count is not zero the run logs the groups. |
| C-03 | Bad: a title whose only stored match was the wrong type loses that Plex link and the added date it carried. Under the Age Guard on main (ADR-119), a title with no remaining match and no download import inside 180 days is `unknown`, which keeps it. A title that still has a dated fitting match older than 180 days, and no newer import, goes from `recent` to `clear` when the date that kept it was the wrong type. Removing a row cannot make a remaining date newer. It can move `clear` to `unknown` when the last match goes, and that keeps the title. |
| C-04 | The Age Guard's rule, the Trash rules and the pace are unchanged. Plex is not written. A short or empty section read can still mark a library fully read and let the reconcile delete fitting rows. That is on main today and is not changed here. |
| C-05 | This delete does not move a household play count. The watch harvest joins plays to titles by id number with no regard to kind, so a movie and a show that share a TMDB number share their plays whether or not a wrong match row exists (DESIGN-025 Q-04). The harvest is a separate story. |

## More information

Story 847. The census and the per-title effect are in that story's pull request. ADR-047 remains the gate and the deep link.
