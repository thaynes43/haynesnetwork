# 2026-10-07: the Books Census cut-title rule (#799), its repair, and 17 stale Audiobookshelf items

Design record: the DESIGN-028 "Books Census" follow-up dated 2026-10-07 (issue #799), and glossary T-290. Everything below
was read-only unless it says otherwise. LazyLibrarian's database was opened `mode=ro`. The app's Postgres was read through
the census's read-only session, from a sleeping Job built from the CronJob template. The Audiobookshelf database was read
with its own sqlite3 module, `OPEN_READONLY`.

## The rule and its trial

- **Rule.** A held file whose title is the record's with words cut now passes only when each cut says nothing about which
  book it is (`cutTitleNamesBook`, PR #805, v0.109.2). The design record has the table.
- **Trial.** A sleeping Job from the v0.109.1 image, with the CronJob's mounts, dumped the LazyLibrarian rows and every
  held file's metadata (1,315 records, 1,547 files). The census ran locally over that dump four times: 35, then 7, then 5,
  then 6 unheld findings (the last one is held). Pass 4 added the code review's fix: a series in front no longer vouches for
  words cut from the kept part.
- **Gap left.** LazyLibrarian's `series` and `member` tables are empty, so the rule reads series names from the file's
  declared series, the record's decoration, and the author's other titles.

## The live run and the repair (03:00Z to 03:02Z)

The first v0.109.2 run found the trial's five, plus "Star Wars. Galaxy's Edge A Crash of Fate", which is held. The repair
script is `ll-library-audit/fix_census_799.py`. It ran as a dry run first, then `--go`. Activity act-030227-269854; backup
`/config/lazylibrarian.db.pre-799-20261007`; max wanted rowid 9599.
- **Re-pointed to a right copy on disk (2):**
  - Merge / Disciple (eBook): now points at the two-novel epub in `Merge + Disciple - .../`, which no record linked.
  - A Secret Rage and Sweet and Deadly (eBook): now points at the omnibus epub that Sweet and Deadly's record also links.
- **Re-wanted (1):** the A Secret Rage and Sweet and Deadly audiobook, for pairing want 6593ef4e. The recording held was A
  Secret Rage alone. OC-038 tracks the re-download.
- **Cleared to Skipped (2), because no want asks for these formats:**
  - Code to Zero [and] The Man from St Petersburg (eBook). The file was Code to Zero alone.
  - The Ultimate Hitchhiker's Guide (audiobook). The file was book 1 alone; those tracks are now linked to book 1's record,
    `zaynQgAACAAJ`.
- **Opfs held (5):** each LazyLibrarian opf that named the wrong record. They are in `quarantine/crossvolume-2026-10-05/`,
  with manifest and sort rows. No book file moved.

The second run read one unheld wrong file: book 1's audiobook on `zaynQgAACAAJ`. Its track title is "Hitchhikers Guide To
The Galaxy"; the record is "The Hitch Hiker's Guide to the Galaxy". PR #806 makes the comparator treat two titles as one
string when they match once spaces and punctuation are removed, a leading article is dropped, and the possessive "'s" is
read either way. OC-037 checks that the five records keep their state after the 09:10Z library scan.

## Audiobookshelf: 17 missing items removed (02:10Z)

None of the 17 had listening progress, a playback session, a bookmark or a playlist entry. Each was removed with
`DELETE /api/items/<id>` (no `hard`; ABS 2.37.1's handler deletes files only with `hard=1`). The calls ran from the Libretto
pod with its root token, and each returned 200, then 404. The missing count went from 17 to 0, and a library scan at 03:03Z
brought none back: a folder with only sidecar files makes no item.

| Item(s) | Why it was missing | Where its content is |
|---|---|---|
| 9 items titled "Dawn (Xenogenesis, Book 1)" (Alice Oseman/This Winter, Cassandra Clare/Nothing But Shadows, Gabriel García Márquez/Until August, Gerald Durrell/Golden Bats and Pink Pigeons, Julia Quinn/Splendid, Mackenzi Lee/The Ladys Guide to Petticoats and Piracy, Nnedi Okorafor/Binti. Home, Roald Dahl/War, Robert T. Kiyosaki/Rich Dads Cashflow Quadrant, Terry Pratchett/Shaking Hands with Death) | each folder held a misfiled copy of Dawn (257,164,714 bytes); quarantined in `mam-misfile-2026-09-22/`; only `Dawn.opf` and `playlist.ll` are left | Dawn itself: `Octavia E. Butler/Dawn` (same size) |
| Ursula K. Le Guin/Wonderful Alexander and the Catwings | misfiled audio quarantined in `mam-misfile-2026-09-22/`; no Catwings audiobook exists (#795) | nowhere |
| Brian Jacques/Redwall - Book One - The Wall (in the Libretto-managed Redwall collection) | folder emptied by #795 | The Sable Queen item (11 tracks, 13.5 h, the same recording) |
| John Grisham/Partners | tracks re-homed by #795 | Sparring Partners item (102 tracks, 10.0 h) |
| Rick Riordan/Percy Jackson and the Olympians | m4b moved by the 2026-09-29 #631 audio split | Camp Half-Blood Confidential item |
| Gary Russell/The Lord of the Rings | audio quarantined by the 2026-09-29 audit (`audit-2026-09-29/`) | quarantine only |
| Sarah J. Maas/[(Throne of Glass )] [Author - Sarah J Maas] [May-2013] | German audio, quarantined in `german-audio/` (F10) | the English Throne of Glass is its own item |
| Charles Dickens/A Christmas Carol (Tim Curry) | a stale twin of a live item on the same folder | item e0a372d0 (6 files, untouched) |

> 2026-10-07: holding the opf was not enough. The 09:10Z library scan re-matched the wrong books by title and undid these
> repairs; the durable rule (an `.ll_ignore` in the wrong book's folder) and the redo are in
> `2026-10-07-scan-undid-census-repairs.md`.
