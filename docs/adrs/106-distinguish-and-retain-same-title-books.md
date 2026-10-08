# ADR-106: Distinguish and retain same-title books

- **Status:** Accepted (owner rulings in issues #830 and #831 on 2026-10-07, reaffirmed in the 2026-10-08 resume work order)
- **Date:** 2026-10-08
- **Deciders:** Tom Haynes

## Context and problem statement

ADR-105 removes EPUB grouping metadata to give each book its own Kavita series. Its removal-only rule leaves
same-title works by different authors merged, and copies across folders can still disappear from incremental
series scans. The owner has now chosen how to distinguish those works and which copies to retain in the library.

This decision amends ADR-105's removal-only and no-library-file-movement constraints for these two cases. ADR-105
remains the record of the original migration; its accepted text is unchanged. Every other preservation, staging,
app safety and reading-list rule remains applicable.

## Decision drivers

- Keep different authors' same-title works separate without rewriting titles, authors or identifiers.
- Keep the copy LazyLibrarian uses and preserve every original and extra outside the library.
- Preserve census repairs, reading state and app wants.
- Make uncertain identities and dependencies explicit holds rather than acquisitions or guessed metadata.
- Restore production promptly after every controlled maintenance window.

## Considered options

- Keep all same-title groups as exceptions indefinitely. This leaves known mixed-author pages and incomplete scans.
- Rename titles or folders. This changes identity metadata or paths beyond the owner rulings.
- Add dedicated grouping tags and retain unprotected extras outside EBooks. Chosen by the owner.

## Decision outcome

Chosen option: **dedicated grouping tags and guarded copy retention**.

For the same title by different verified authors, write a Book Grouping Tag: `calibre:series` is
`<title> (<author>)` and `calibre:series_index` is `1`. This applies to tagged and untagged peers. Preserve every
other OPF byte and ZIP member, including the original titles, raw creator credits and identifiers. Require an
unambiguous author-role identity; shared aliases or uncertain credit boundaries remain held. A separately approved,
file-bound primary-source proof may identify an existing creator's author role for one exact file without changing
the credits. An already correct grouping pair is unchanged.

For same-title copies by the same verified author, keep the unique file LazyLibrarian's BookFile points to. A manual
operation may move an extra into the outside-library retained backup area only after complete, fresh reads prove
nothing relies on it: other LazyLibrarian pointers, census repairs and `.ll_ignore`, Kavita reading dependencies,
and app wants. Unknown dependencies, ambiguous authors or multiple possible keepers leave copies in place for
review. Retained Copies are never deleted or pruned automatically. This operation is never part of hourly stripping.

Capture dependencies only after real writer fences are established. Stop the relevant filesystem and reading-state
writers through GitOps and hold supervised primary PostgreSQL read-only SHARE locks while capturing app wants and
mirror references. Bind complete source start/completion timestamps and filesystem identities to a short deadline;
abort on missing proof, writer-fence loss, source changes or expiry. Verify retained bytes before removing an
original directory entry. Restore only to an absent original path using a fresh inode, retaining the backup.

Prepare and review one exact GitOps inverse and arm recovery before each pause. Validate the inverse while workloads
are still live, then bound the actual outage. Restore immediately on success, failure or uncertainty, before further
scan, app or recipe work. Metadata-only windows restore schedules and acquisition before broader app checks. The
hourly metadata gate is enabled separately after full verification.

### Consequences

| ID | Consequence |
| --- | --- |
| C-01 | Good: unrelated same-title works receive distinct Kavita series without changing their canonical metadata. |
| C-02 | Good: the library retains its LazyLibrarian keeper while unprotected extras remain recoverable outside EBooks. |
| C-03 | Bad: protected or unproved copies remain and require a concrete review list. |
| C-04 | Bad: duplicate retention needs a brief service outage and supervised dependency-writer locks. |
| C-05 | Good: immutable retained bytes and guarded restoration keep every file operation reversible. |

## More information

[ADR-105](105-one-kavita-series-per-book.md),
[owner grouping ruling](https://github.com/thaynes43/haynesnetwork/issues/830#issuecomment-6048523078),
[owner copy-retention ruling](https://github.com/thaynes43/haynesnetwork/issues/831#issuecomment-6048523309),
[DESIGN-028](../designs/028-integrations-tab-goodreads-requests.md),
[DESIGN-024](../designs/024-books-library.md),
[DESIGN-037](../designs/037-libretto-architecture.md),
[PLAN-074](../../.agents/plans/074-one-kavita-series-per-book.md).
