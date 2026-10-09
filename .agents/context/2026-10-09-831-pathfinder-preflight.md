# Pathfinder protected-copy preflight, 2026-10-09

Read-only diagnostic for [#831](https://github.com/thaynes43/haynesnetwork/issues/831) and
[#864](https://github.com/thaynes43/haynesnetwork/issues/864), on main `efca5085`.
This is a plan-direction packet, not permission to move a file. ROOT ratified the two-extra
plan below; execution still needs freshly fenced inputs after the #866 deployment and the
reviewed SOURCE/MAIN, native lifecycle and exact restoration closure.

## Ruling and minimum selection

DESIGN-028 Q-06 / ADR-106 and the [owner's #831 ruling](https://github.com/thaynes43/haynesnetwork/issues/831#issuecomment-6048523309)
retain the unique LazyLibrarian BookFile EPUB keeper, move only unprotected same-work extras
outside `EBooks/`, retain backups indefinitely and never delete them. Unknown dependencies,
nonunique keepers and ambiguous identity keep copies in place for review.

All paths below are relative to `/data/cephfs-hdd/data/media/books/EBooks`.

| Role                            | Path                                                             | SHA-256                                                            |   Bytes |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------: |
| Designated LL keeper            | `Orson Scott Card/Pathfinder/Pathfinder - Orson Scott Card.epub` | `dca5fba80025aa2f91535d014684018e4e2211e85803cd136d4cda1c95a83f54` | 1199174 |
| Extra 1                         | `Orson Scott Card/Pathfinder/Orson Scott Card - Pathfinder.epub` | `c48cece08187598a5a63a9fc2a330b911cef57393dcb4cd2db0697e9391e89b2` |  480029 |
| Extra 2, misfiled Pathfinder    | `Orson Scott Card/Visitors/Visitors - Orson Scott Card.epub`     | `c48cece08187598a5a63a9fc2a330b911cef57393dcb4cd2db0697e9391e89b2` |  480029 |
| Genuine Visitors keeper, retain | `Orson Scott Card/Visitors/Orson Scott Card - Visitors.epub`     | `8ed2e2410dfad7b272c1dfba9ba07017898a013f19fa38aaabca4168c322a9d5` | 1452402 |

The live four-file read, completed before the 15:14:47Z app diagnostic, found identical
before/after device, inode, size, mtime, ctime, link count, mode, UID and GID for each file.
All had one link. The three Pathfinder OPFs each name `Pathfinder` with sole creator
`Orson Scott Card`; the genuine Visitors OPF names `Visitors` with that creator. None has
a series tag or an ancestor `.ll_ignore` in its title, author or EBooks folder. The two
extras are byte-identical, including ISBN `9781416991762`; the keeper has ASIN `B003UYUOZ4`.
This verifies the Visitors-named extra is a Pathfinder copy, not the genuine Visitors book.
It does not replace the complete corpus identity/protection census.

Lead's bounded live LL read identifies `QLnfZW-l_EwC` as Open and pointing at the designated
1.2 MB keeper. `Gc1QAQAAQBAJ` is Open and points at genuine Visitors. The controlled capture
must re-establish complete pointers and unique keeper ownership; these two targeted rows
alone cannot prove no other LL row points at an extra.

## File IDs and saved dependencies

The stable source DB copy at `/tmp/hn825-recon-1009-w0_hdsfg/kavita.db` was captured at
14:47:39.420090Z; its private `target-reading-proof.json` records unchanged source stats.
Queries used an immutable read-only local connection and returned counts, never credential
or user text. The deployed preflight schema admission and saved-lock resolver both passed,
with no target lock protections or unresolved lock dependencies.

The current Pathfinder EPUBs have no MangaFile mapping. Series 1448 is the PDF only:
file 3315, chapter 3120, volume 1584. Genuine Visitors survives as series 2161, file 4898,
chapter 4588, volume 2926. Removed EPUB series 2268 had file IDs 5031/5032/5033, chapter
IDs 4721/4722/4723 and volume 3038, proved by
`/home/dev/work/hn-825b-force-only-cont03-file-coverage.json`. Earlier coverage adds file
IDs 4936/4937/4938, chapters 4626/4627/4628, volume 2958 and historical series 1155.

The independent audit checked all direct Series/Chapter/Volume/File fields against these
current and historical aliases. No saved user or curation dependency referred to them;
the only matching rows were catalog ChapterPeople and ExternalSeriesMetadata for the
surviving PDF/Visitors identities. All nine AppUserReadingHistory JSON rows and all seven
AppUserReadingProfiles SeriesIds/LibraryIds parsed, with no target or Books-library scope
hit. Scrobble tables were empty. Current saved reading counts remain 17 progress, 11
session and 20 session-activity rows (48 total); bookmarks and annotations are empty.
Saved lists, collections, remaps, table-of-content and all lock state still require exact
before/after preservation. Absence of rows today does not authorize progress migration
or clearing a historic reference later.

## App diagnostic and API boundary

At 15:14:47.341Z, an app-container transaction proved primary PostgreSQL 16.4,
`transaction_read_only=on`, with a five-second statement timeout. Production was still
v0.110.4, so this is diagnostic only. Four Pathfinder/Visitors wants were found. Their LL
bindings name the designated Pathfinder keeper or genuine Visitors; one old author-null
Pathfinder want remains anchored to tombstoned series 1155 with no LL id. Series 2268 is
tombstoned; 1448 remains the live PDF mirror. No want was changed. A complete fresh app
items/wants capture under SOURCE/MAIN SHARE fences must supersede this targeted query.

The app's `@hnet/books` Kavita client is read-only and exposes no admin per-user progress
reader (ADR-053 C-05); API coverage alone cannot prove file-ID, XPath, history, profile or
lock safety. The authoritative source is the stable copied vendor DB and the full
`epub_copy_preflight.py` dependency/lock resolver. The converter has an exact manual
`--consolidate-copies <snapshot> --copy-selection <manifest>` path and
`--restore-retained-copy <manifest>` inverse. Its scan is the Books library
`POST /api/Library/scan?libraryId=1&force=false`, not a folder scan. None was invoked here.

## Conditional sequence and inverse

1. Finish #866 deployment and refresh full corpus, full LL pointers, census protections,
   vendor reading/curation/lock state and app wants. Review the exact two-extra path/hash
   selection. New paths, changed bytes, ambiguity or any dependency refuse the move.
2. While production runs, complete the signed live-byte/native-input lifecycle proof.
   It grants no copy permission. Reuse requires exact original clocks and complete device
   fingerprints; expired evidence is not refreshed while production is paused.
3. Prepare a current reviewed GitOps pause and exact inverse, independent 170-second
   restoration watcher, strict five-Job/Pod UID ownership and both primary-PG16 fences.
   Pause only after ROOT ratifies the critical stage. SOURCE captures after real fences;
   MAIN independently verifies full fingerprints and rehashes/parses both extras and keeper.
4. Retain the first extra and verify its backup before the exact remainder. Keep the
   Pathfinder EPUB, Pathfinder PDF and genuine Visitors unchanged. Restore production
   immediately on success, refusal or uncertainty before further scan/app checks.
5. Observe the normal library scan, its exact enqueue/start/commit and both completion
   notifications. Require the retained Pathfinder EPUB and genuine Visitors to map, with
   unchanged other path mappings and exact saved state. A Force result alone cannot pass
   the next unchanged-folder nightly scan; update the file-level owed baseline for the
   two deliberately retained-outside-library extras and new arrivals, preserving seven
   unrelated historical gaps honestly.

Filesystem inverse: use each actual retained-copy manifest, verify its retained hash and
owner/mode, and publish a fresh inode atomically only if its original path is absent.
The backup remains. Review partial-move receipts individually; never overwrite a racing
file or repeat a refused batch. Runtime inverse restores all six schedules, LL/Kavita
replicas, Libretto acquisition and all four Flux scopes, then proves owned Jobs/Pods and
PG sessions absent. Existing #3619 restored the old preparation; a future pause needs
its own current exact inverse. No title rewrite, LL rename, progress write or reading-list
write is justified by this packet. No COPY execution, pause, Job or scan occurred.
