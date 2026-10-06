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

The live findings, their triage and the repairs are recorded under "First live run" below once the release is deployed.
