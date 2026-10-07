# ADR-105: One Kavita series per book

- **Status:** Accepted (owner ruling 2026-10-07, issue #825 work order)
- **Date:** 2026-10-07
- **Deciders:** Tom Haynes

## Context and problem statement

Kavita 0.9.0.2 groups EPUBs by their embedded series name and index. LazyLibrarian keeps books in separate
author/title folders. An incremental Kavita scan rebuilds a series from the folders scanned in that pass, dropping
volumes in skipped folders even while their files remain on disk. The Hunger Games and Assistant to the Villain
alternate which book they hold; books-sync and format pairing follow those identities. The research census found
213 tagged EPUBs among 1,930, 46 tagged series, and 21 partial series with 40 files absent from their series.

Removing grouping metadata lets Kavita use each book's title while retaining the authors, ISBNs and other metadata
the app and Libretto need. Same-title books and duplicate editions remain a separate limitation of Kavita grouping.

## Decision drivers

- End scan-dependent identities and pairing churn without moving library files.
- Preserve each original and every unrelated metadata field.
- Keep series reading order in Libretto reading lists.
- Stage app safety and census checks before changing any library file.

## Considered options

- Group LazyLibrarian folders by series. Its current Google Books metadata does not populate its series tables;
  folder renames also carry ignore files and are unsafe for folders holding duplicate EPUBs.
- Disable Kavita EPUB metadata. This loses authors and ISBNs and changes duplicate grouping.
- Tolerate the flip in the app. Kavita's own pages still omit books; a union parks multi-book anchors.
- Remove EPUB grouping metadata and use Libretto for series order. Chosen by the owner.

## Decision outcome

Chosen option: **one Kavita series per book**, implemented by the existing hourly EPUB converter.

Remove `calibre:series`, `calibre:series_index`, and every EPUB 3 `belongs-to-collection` meta, with the
`collection-type` and `group-position` metadata refining a removed collection. No dangling refinements are allowed.
Keep titles, authors, identifiers and all unrelated OPF bytes and ZIP members. A `dc:title` refined by
`title-type=collection` remains: Kavita uses it as collection metadata, not the grouping identity.

Back up originals outside `EBooks/`; retain them until the owner explicitly authorizes deletion. Validate the
candidate archive and OPF, compare unrelated content, then replace atomically. Untagged EPUBs are untouched. Strip
newly converted EPUBs too. The initial deployment is disabled; targeted batch Jobs perform the staged and full
backfill only after app safeguards are deployed, the after-strip census passes or is explicitly held, and an
adversarial review is complete. Enable the hourly step only after verification.

Books-sync preserves tombstoned rows as history. Pairing must not revive, retitle, resolve or push a want whose
anchor vanished; replacements are matched using their held book identity. Any Request Event mutation uses the
existing single writers. Stage The Hunger Games and Mockingjay first, verify Kavita file coverage and app requests,
then process the rest. Existing multi-book parks do not authorize guessing identities for the split books.

Libretto owns series order. Add missing reading-list recipes through its existing builders where the ordering and
membership are settled; a new policy decision is recorded in a GitHub issue with the exact question. Verify after
the next 04:00Z Kavita scan using an Owed Check.

### Consequences

| ID   | Consequence                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Good: tagged books no longer share a Kavita grouping identity across their book folders.                                                                         |
| C-02 | Bad: about 46 Kavita series pages disappear; replacement book and chapter ids can change. Reading progress was absent on affected series at the research census. |
| C-03 | Neutral: same-title groups are not fixed by this decision and require separate evidence and treatment.                                                           |
| C-04 | Good: verified originals outside the library make the file edit reversible without introducing duplicate books.                                                  |

## More information

[Issue #825](https://github.com/thaynes43/haynesnetwork/issues/825),
[research](https://github.com/thaynes43/haynesnetwork/issues/825#issuecomment-6048048575),
[DESIGN-028](../designs/028-integrations-tab-goodreads-requests.md) (conversion and census),
[DESIGN-024](../designs/024-books-library.md) (mirror),
[DESIGN-036](../designs/036-book-audiobook-format-pairing.md) (pairing),
[DESIGN-037](../designs/037-libretto-architecture.md) (reading lists),
[DESIGN-053](../designs/053-owed-check-tracker.md) (next scan check).
