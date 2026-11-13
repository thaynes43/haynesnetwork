# ADR-123: A Plex match stays inside the fitting library type

- **Status:** Proposed
- **Date:** 2026-11-13
- **Deciders:** the owner (direction of 2026-11-13, saga 813, through the review of story 836)
- **Narrows:** [ADR-047](047-library-play-here-access-aware-deep-links.md) the shared-GUID match. ADR-047 stays Accepted and unedited. Its gate, its deep link and its single-writer rule stand. This record adds the library type to the match.
- **Design:** [DESIGN-025](../designs/025-library-play-here-links.md) D-10. Glossary T-139 amended. No migration.

## Context and problem statement

ADR-047 resolves each ledger item to a Plex title by a shared id (`tmdb`, `imdb`, `tvdb`, `musicbrainz`) and stores `{plex library, rating key}` in `media_plex_matches`. The index did not include the library type. TMDB and TVDB number movies and shows separately, so the same number is a different title in the other library. A movie was stored against a show's Plex item, and the reverse.

The Age Guard, the Trash walls and the watch reads use these rows. A wrong row lends a title another title's added date or plays. That can keep it from Trash, or show it as watched.

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

Chosen option: **B** — because the id spaces are separate, and an Accepted ADR is superseded or narrowed by a new record rather than edited.

The fitting pairs are radarr with a movie library, sonarr with a show library, and lidarr with an artist library. A photo library fits nothing. The matcher indexes each id under the section's library type and looks up only the kind's fitting type. A section whose live type disagrees with the registry is not indexed and not scoped.

`syncPlexMatches` deletes cross-type rows in the same transaction as its upsert and reconcile, including a row in a library that run did not read. `repairCrossTypePlexMatches` is that delete. A dry run selects and writes nothing. An apply deletes the selected rows and nothing else. A second apply selects nothing.

### Consequences

| ID   | Consequence                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Good: a movie and a show that share an id number each match their own Plex item.                                                                                                                                                                                 |
| C-02 | Good: the next match run, and the one-off repair, remove a cross-type row and leave a fitting row.                                                                                                                                                               |
| C-03 | Bad: a title whose only stored match was the wrong type loses that Plex link and the added date it carried. The Age Guard can then judge it clear. Removing a row cannot make a remaining date newer, so it cannot newly protect a title that was already clear. |
| C-04 | The Age Guard's rule, the Trash rules and the pace are unchanged. Plex is not written.                                                                                                                                                                           |
| C-05 | A household play count already stored on `media_metadata` is not moved by this delete. The next metadata refresh may attribute it to the other title of a collided pair (DESIGN-025 Q-04).                                                                       |

## More information

Story 847. The census and the per-title effect are in that story's pull request. ADR-047 remains the gate and the deep link.
