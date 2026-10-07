# 2026-10-06 — two wrong LazyLibrarian files repaired (#781) and the Books Census (#744, #781)

Design record: DESIGN-028 amendment "Books Census" (glossary T-289 Books Census, T-290 Held File Check, T-291 Census Hold).
Everything below was read-only unless it says otherwise: LazyLibrarian's database opened `mode=ro`, OPF titles read with
`zipfile`, md5s, the app replica `postgres16-11` in a `default_transaction_read_only` session, Kavita's API from the
Libretto pod with its own key.

## #781 before (21:20Z)

| Record | BookFile | What the file is |
| --- | --- | --- |
| `RZZRAQAAQBAJ` Four. The Traitor (US ISBN 006228567X) | `Veronica Roth/Four. The Traitor/Four. The Traitor - Veronica Roth.epub` | OPF "Four Divergent Stories: The Transfer, The Initiate, The Son, and The Traitor (Divergent Series)", grab 4964 "Four- A Divergent Story Collection (...)" (Kavita series 1661) |
| `TYETAQAAQBAJ` The Traitor. A Divergent Story (UK ISBN 0007550154) | none, `Wanted` (pairing want `0841d533`, anchor the Audiobookshelf "The Traitor: A Divergent Story") | the same book as above under its UK title |
| `Qw30DwAAQBAJ` Shift | `Hugh Howey/First Shift - Legacy/Hugh Howey - First Shift - Legacy.epub` | *First Shift: Legacy* (Silo 6), grab 5046 |

- `Veronica Roth/The Traitor/` held the real Kindle Single (OPF "Four: The Traitor (Kindle Single) (Divergent Trilogy Book 4)",
  Kavita series 1950, converted to EPUB by #770), with a LazyLibrarian opf naming `RZZRAQAAQBAJ`; no record linked it.
- `Hugh Howey/Shift/` held *Third Shift: Pact* (epub, md5 = grab 9282's torrent copy) and *First Shift: Legacy* (mobi, md5 =
  grab 5046's torrent copy) beside an opf naming `Qw30DwAAQBAJ`; `Hugh Howey/Wool Omnibus/` another *Third Shift* with an
  opf naming Shift. Kavita grouped the two *Third Shift* files as series 291 and put *First Shift* inside series 1221 Wool
  (why pairing want `55f3c29a` "First Shift - Legacy" was parked `multi_book` and `179dc47e` "Third Shift - Pact" wanted
  its audiobook).
- Shift's history (wanted table): eleven grabs of Silo parts and omnibuses since 2026-07-23. Grab 6086 (2026-08-22,
  qBittorrent, still seeding) was the right book, "Shift Omnibus Edition (Shift 1-3) (Silo Saga)", 148 entries; grab 9282
  (2026-09-27) overwrote it as `Shift/Shift - Hugh Howey.epub`. The torrent's copy is still in
  `/data/cephfs-hdd/torrents/books/books-mam/Shift Omnibus Edition (Shift 1-3) (Silo  - Howey, Hugh/`.
- App wants: Silo collection want `caf0d2a7` "Shift" (no id, released by the Author Check from Night Shift), pairing
  `1912c0f3` Shift (both formats `landed`), pairing `0841d533` (`wanted`, LazyLibrarian searching `TYETAQAAQBAJ`).

## The repair (21:39Z)

`.agents/context/ll-library-audit/fix_781.py`, dry run then `--go`, declared activity act-213826-23403; LazyLibrarian backup
`/config/lazylibrarian.db.pre-781-20261006` (integrity ok). The table in the DESIGN-028 amendment has the moves. Why not
the book Fix (DESIGN-033): it re-grabs the identity of a library item (queueBook + searchBook) and never re-points
LazyLibrarian's file or moves one; both right books were already on disk, so a search could only have added a second copy
(Libretto refuses a member held twice as ambiguous), and the stray opfs would have re-linked the wrong files at the next
library scan.

After: the three records read `Open` on the right files; Kavita (folder scans of both authors) dropped series 1661 and 291,
series 1221 is Wool alone, series 2062 "Shift Omnibus Edition (Shift 1-3) (Silo Saga)" is new. Max `wanted` rowid 9597.
Owed: OC-028, OC-029.

## The census: trial passes before release

Run as a one-off Job in `downloads` from the v0.108.0 image (the branch's code bundled into the pod; same mounts and
read-only sources as the CronJob). 1,267 records, 981 eBook and 569 audiobook files, 22 to 25 s.

| Pass | wrong_file | What changed |
| --- | --- | --- |
| 1 | 127 | first rules |
| 2 | 32 | series-designation titles decide nothing; the record's title read either way round; leading series indexes, `--`, bullets, "Vs.", "-our", "Deluxe", "Box Set"; audiobook track titles |
| 3 | 25 | a track title can clear a file, never condemn it ("WHITESAND01P04"); squashed titles ("Confessions ofanUglyStepsister") |
| 4 | 24 | "The Churn. an Expanse Novella" reads its period as a part break |

Pass 4 also: `missing_file` 1 (the Catwings audiobook, the known pre-#631 pointer), `foreign_held` 1, `foreign_wanted` 1,
`foreign_item` 0 (every live library tag reads English or blank), `unsupported` 10 (PDFs), `untitled` 38, `unreadable` 0.
The label-only rule went from 3 `foreign_held` to 1 once a book whose other file reads English stopped counting (Grey and
Living to Tell the Tale: German and Spanish records holding English files).


## First live run (v0.109.0, deployed 23:20Z; manual Job at 23:25Z)

`books_census`: 1,268 records, 981 eBook and 569 audiobook files, 31.7 s, `appDb` ok, `holds` ok (none). `wrongFile` 24,
`missingFile` 1, `foreignHeld` 1, `foreignWanted` 1, `foreignItems` 0. The findings are the trial's pass 4 exactly.

- **Repaired the same evening: Divergent.** `K0UczgEACAAJ` held the four-story collection (`Four - A Divergent Story
  Collection/`). `Divergent/Veronica Roth - Divergent.pdf` is Divergent (PDF Info title and author, 381 pages, and its text
  read with pdftotext in a read-only calibre Job). `.agents/context/ll-library-audit/fix_census_divergent.py` (backup
  `/config/lazylibrarian.db.pre-census-divergent-20261006`) re-pointed the record to the PDF and held the collection folder's
  LazyLibrarian opf (it named `K0UczgEACAAJ`, so the library scan would link the collection back). The collection epub stays
  as the collection's one copy (Kavita series 256). A second census run (23:27Z) read `wrongFile` 23. Owed: OC-031.
- **Listed for repair: 23 wrong files**, issue #795 (the table is there). Most are another volume or another work; about 15
  need the right book searched again, which is the owner's call as a bulk re-acquisition.
- **`foreign_wanted`: Crescent City - La casa di terra e sangue** (`LgDwDwAAQBAJ`, `it`, eBook Wanted for collection want
  `76848581`): the crescent-city recipe lists the Italian edition as a member; issue #794.
- **`foreign_held`: Game of Thrones audiobook** (`pyj5oQEACAAJ`, labelled `fr`, album "A Game of Thrones", no language
  tag): needs a listen; in #795.
- **`missing_file`: the Catwings audiobook** (`QGPZEAAAQBAJ`), the known pre-#631 pointer; in #795.

## #795 repaired (2026-10-06 23:58Z to 10-07 00:05Z)

Owner ruling 2026-10-06 on #795: "Yes, re-download all of them" (every wrong file with no right copy anywhere). Each file was
read first: epub OPF titles and identifiers, mobi/azw3 EXTH titles, audio tags and durations (ffprobe in the Audiobookshelf
pod), md5s. Audiobookshelf's database showed no listening progress on any item touched. The scripts are
`.agents/context/ll-library-audit/fix_census_795.py` and `fix_census_795_catwings.py`. Their headers carry the evidence for
every row. The LazyLibrarian backups are `/config/lazylibrarian.db.pre-795-20261006` and `...pre-795-catwings-20261007`.
Activity was declared as act-235821-166161.

Every wrong file was handled by one rule:
- A book whose folder names it correctly stays where it is. Only the LazyLibrarian opf naming the wrong record is held, as in
  the Divergent repair.
- A misfiled copy of a book that is also held elsewhere is held `duplicate`.
- A misfiled only copy is re-homed under its own title, the #782 precedent.

Nothing was deleted.

- **Re-pointed to the right book already on disk (14):** Nightflyers & Other Stories, Wild Cards I, A Crown of Swords
  (audio), City of Illusions, The Tempest Tales, The Science of Discworld II, A Plague of Zombies, How We Learn (both twin
  records), Tales of the Unexpected, Distinctions (eBook), Anne of Green Gables, Magnus Chase 3, The Expanse Origins #3.
  - The Tempest Tales' right epub was copied from grab 2056's seeding torrent.
  - City of Illusions now points at its azw3; the epub there was the omnibus.
  - A Crown of Swords' Audiobookshelf item held seven copies in one folder (178 files, 241 h). One is Winter's Heart. It now
    holds one copy, the 1996 unabridged m4b.
- **Two records with no file got the right book that was already on disk:**
  - A-ZVAQAACAAJ The Hammer of Thor was Wanted and is now Open.
  - HXHWBQAAQBAJ The Further Tales of Tempest Landry, an eBook re-homed out of The Tempest Tales/.
- **Re-wanted (4), under the ruling:**
  - Freed (eBook). Grab 94 is blocked by row 9598.
  - Warriors 3 (eBook).
  - Partners (audio). Its 102 Sparring Partners tracks were re-homed to Sparring Partners/. Grab 9567 is blocked by row 9599.
  - Redwall (audio). The linked file was Eulalia!. The folder `Redwall - Book One - The Wall/` was The Sable Queen; it was
    re-homed to The Sable Queen/ with its Audiobookshelf title corrected.

  Owed checks OC-033 to OC-036 track the four re-downloads.
- **Census Holds (6):** Sweet and Deadly (omnibus), Roald Dahl's Dirty Beasts (audio, combined recording; a duplicate track
  set held), Wilderness (audio, "Wilderness and Other Stories"), Dean Koontz (record titled with the author's name),
  Distinctions (audio, Towers of Midnight), and the foreign_held Game of Thrones (audio). The Game of Thrones file is
  English: Roy Dotrice, 33 h 46 min, English chapter-name tracks. Its `fr` label comes from a mismatched Google Books record.
- **missing_file Catwings audiobook:** no audio exists anywhere; the two grabs were PDFs. The pointer is cleared and
  AudioStatus set to Skipped. Nothing was searched.
- **Found on the way:** the same record's eBook linked Catwings (book 1). It now points at its own PDF. The census gap that
  let it through is #799.

Kavita folder scans (13 authors) and an Audiobookshelf library scan ran at 00:00Z. Owed: OC-032 (the re-points survive the
library scan) and OC-033 to OC-036.
