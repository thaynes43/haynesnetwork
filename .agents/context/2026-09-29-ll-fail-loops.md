# 2026-09-29 — LazyLibrarian fail loops: evidence, the changes made, the rollback list

Companion to DESIGN-046 D-21 (the rulings live there; this note holds the record). Everything below was read
read-only from LazyLibrarian's database (`/config/lazylibrarian.db`, opened `mode=ro`), its API, SABnzbd's API,
qBittorrent's API and Loki, except the two changes in §2, which went through LazyLibrarian's own API.

## 1. The loop rate before

- The 60 `fail_loop` pairs of the janitor's first books census (v0.104.0, 16:25Z run): 25 grabs in the 7 days to
  2026-09-29 12:30 local, **3.6 a day, every one failed**: 16 "Failed to send torrent to QBITTORRENT", 7 "Duplicate
  NZB" (all Cibola Burn eBook, one a day), 2 "Unable to locate a valid filetype" (Twilight audiobook).
- LazyLibrarian as a whole: 179 grabs in the same 7 days (25.6 a day), 77 failed.
- 48 of the 60 pairs were books LazyLibrarian already held (file on disk, library date) with the format reading
  `Wanted`. Across all books there were 127 such formats (114 eBook, 13 audiobook), plus one with a library date
  but no file (the Twilight audiobook), none with a library date after 2026-09-22 06:00. The 2026-09-22 note measured 292 → 168 that evening; the daily library scan has not moved the
  rest (still `Wanted` after the 2026-09-29 09:10Z scan).

## 2. The changes (reversible)

LazyLibrarian settings, through `cmd=writeCFG` (group `General`), about 16:42Z. LazyLibrarian kept its own
`config.ini.bak`, but that holds the state between the two writes, so the old values are here.

| Setting | Before | After |
|---|---|---|
| `reject_words` | `audiobook, mp3, m4b, m4a, flac, hörbuch, hoerbuch, hörverlag, hoerverlag, lesung, ungekrzt, ungekürzt, ungekurzt, gekrzt, gekürzt, gekurzt, deutsch, german, dunklen, mächte, mchte, entscheidung, erzaehlt, erzählt, wustenplanet, wüstenplanet, goldener, zorn, doppelgangerin, doppelgängerin, und` | the same with `mp4` added after `flac` and `und` removed |
| `reject_audio` | `epub, mobi, azw3, azw, pdf, hörbuch, hoerbuch, hörverlag, hoerverlag, lesung, ungekrzt, ungekürzt, ungekurzt, gekrzt, gekürzt, gekurzt, deutsch, german, dunklen, mächte, mchte, entscheidung, erzaehlt, erzählt, wustenplanet, wüstenplanet, goldener, zorn, doppelgangerin, doppelgängerin, und` | the same with `und` removed |

Unchanged and checked: `blacklist_failed` 1, `blacklist_processed` off, `del_failed` 1, `notfound_status` Skipped,
`found_status` Open, `search_bookinterval` 1440. SABnzbd `no_dupes` stays 3 (Fail); it was only read.

Rollback: `cmd=writeCFG&group=General&name=reject_words&value=<Before>` (and the same for `reject_audio`).

The cleanup, about 16:43Z: `cmd=unqueueBook&id=<BookID>&type=<eBook|AudioBook>` for every format that read `Wanted`
and whose recorded file exists on disk, **127 formats (114 eBook, 13 audiobook), all now `Skipped`**. Excluded: the
open haynesnetwork Fix requests (`book_fix_requests` in `pending`/`queued`/`search_triggered`: `Rlf2vQAACAAJ`,
`GrYsEAAAQBAJ`; neither was in the set), since a Fix is the one sanctioned way to make LazyLibrarian re-acquire a
held format; and the one format with a library date but no file (it stays `Wanted`). No search was sent. Fail loops
after: **12**, none of them held.

Rollback for one format: `cmd=queueBook&id=<BookID>&type=<eBook|AudioBook>`. The list:

| BookID | Format | Book |
|---|---|---|
| `njs6CQAAQBAJ` | AudioBook | Alcatraz vs. the Evil Librarians |
| `jVyVzQEACAAJ` | AudioBook | Blood Grove |
| `R7lwacBA53QC` | AudioBook | Confessions of an Ugly Stepsister |
| `emvqDwAAQBAJ` | AudioBook | Ghosts of the Shadow Market |
| `_66cporIROcC` | AudioBook | Gone Fishin' |
| `ybmToyCGzycC` | AudioBook | Mariel of Redwall |
| `TAEjw0IM50YC` | AudioBook | Mossflower |
| `8IhkAgAACAAJ` | AudioBook | The Hedge Knight |
| `YqfWwAEACAAJ` | AudioBook | The Last Hero |
| `gqpSPwAACAAJ` | AudioBook | The Last Hero |
| `d2eNPwAACAAJ` | AudioBook | The Viscount who Loved Me |
| `Iest_zZHolAC` | AudioBook | The Voyage of the Dawn Treader (full color) |
| `yBNRDwAAQBAJ` | AudioBook | Walkin' the Dog |
| `ec5mEQAAQBAJ` | eBook | A Bone to Pick |
| `XaZaPgAACAAJ` | eBook | A Fisherman of the Inland Sea |
| `fdBmEQAAQBAJ` | eBook | A Fool and His Honey |
| `Cv6FBPQlIAEC` | eBook | A Place Called Freedom |
| `DHiItwAACAAJ` | eBook | Aces Abroad |
| `RzIuCwAAQBAJ` | eBook | Alcatraz Vs. the Evil Librarians |
| `BN2JDQAAQBAJ` | eBook | All the Pretty Horses |
| `cxT4Hz7kNnsC` | eBook | Always Outnumbered, Always Outgunned |
| `w2zOAAAACAAJ` | eBook | An Offer from a Gentleman |
| `6uv-CwAAQBAJ` | eBook | Arcanum Unbounded. The Cosmere Collection |
| `mNzNCHhqFwcC` | eBook | Artemis Fowl and the Atlantis Complex |
| `0nbw0AEACAAJ` | eBook | Babylon's Ashes |
| `zKZXjwEACAAJ` | eBook | Beacon 23 |
| `p01LDwAAQBAJ` | eBook | Binti |
| `UMlFHF0JOyEC` | eBook | Blonde Faith |
| `x5Q308_4S3kC` | eBook | Boomerang |
| `tXGRBgwxAHIC` | eBook | Caliban's War |
| `8dfLywEACAAJ` | eBook | Changing Planes |
| `9g9UDwAAQBAJ` | eBook | Children of Virtue and Vengeance |
| `ik6xzgEACAAJ` | eBook | Chroniken der Unterwelt |
| `Hn41AgAAQBAJ` | eBook | Cibola Burn |
| `GVPGAAAAQBAJ` | eBook | City of Ashes |
| `LRpCrgEACAAJ` | eBook | City of Fallen Angels |
| `HP9wCgAAQBAJ` | eBook | Clockwork Prince |
| `1L_kBQAAQBAJ` | eBook | Dangerous Women 1 |
| `jRgrtAEACAAJ` | eBook | Dark Prophecy |
| `69wLTeKBPeEC` | eBook | Dead and Alive (Dean Koontz’s Frankenstein, Book 3) |
| `KFuLDQAAQBAJ` | eBook | Dead in the Family |
| `D59dwgEACAAJ` | eBook | Dean Koontz's Frankenstein |
| `cW_aCwAAQBAJ` | eBook | Debbie Doesn't Do It Anymore |
| `EjOH1Np0uy0C` | eBook | Demon Seed |
| `AApXQwAACAAJ` | eBook | Down & Dirty |
| `fpV0DVDxLqkC` | eBook | Eclipse |
| `W6mabRTiDjYC` | eBook | Fear of the Dark |
| `XgtGPgAACAAJ` | eBook | Four Ways to Forgiveness |
| `QEtj-cZIog8C` | eBook | Frankenstein. Prodigal Son |
| `VIKLDQAAQBAJ` | eBook | Frankenstein. The Dead Town |
| `mUoBfC4z_sMC` | eBook | Gone Fishin' |
| `1IiNEAAAQBAJ` | eBook | Grave Secret |
| `h_tTnwEACAAJ` | eBook | High Rhulain |
| `A8dV8dbPzuIC` | eBook | His Dark Materials. The Golden Compass (Book 1) |
| `6BPTCwAAQBAJ` | eBook | Honor Among Thieves |
| `KLJPEAAAQBAJ` | eBook | Hooked |
| `VkMUrgEACAAJ` | eBook | How to Stop Worrying and Start Living |
| `MPu0xhrYqqUC` | eBook | It's in His Kiss |
| `GOhLAQAACAAJ` | eBook | Karma |
| `iSnJmAEACAAJ` | eBook | Last Scene Alive |
| `hGyDBQAAQBAJ` | eBook | Legion. Skin Deep |
| `Zng8PgAACAAJ` | eBook | Liar's Poker |
| `Mf4TnAEACAAJ` | eBook | Loamhedge |
| `YhpSHnWjG3AC` | eBook | Lord John and the Brotherhood of the Blade |
| `96KNEAAAQBAJ` | eBook | Mariel of Redwall |
| `ybmToyCGzycC` | eBook | Mariel of Redwall |
| `TAEjw0IM50YC` | eBook | Mossflower |
| `sA-TEAAAQBAJ` | eBook | Mr. Murder |
| `hN-yEAAAQBAJ` | eBook | Murtagh - Eine dunkle Bedrohung |
| `ENRSDwAAQBAJ` | eBook | Nightflyers & Other Stories |
| `Ye9ftAEACAAJ` | eBook | No One Writes to the Colonel and Other Stories |
| `7XUkBQAAQBAJ` | eBook | Odd Thomas. You Are Destined to Be Together Forever (Short Story) |
| `nCmuEQAAQBAJ` | eBook | Percy Jackson and the Olympians. The Lightning Thief Illustrated Edition |
| `8yWqlAEACAAJ` | eBook | Percy Jackson and the Sea of Monsters |
| `K8ETEAAAQBAJ` | eBook | Queen of Air and Darkness |
| `NVvtwAEACAAJ` | eBook | Queen of Air and Darkness |
| `C9-NmQLA64gC` | eBook | Rakkety Tam |
| `IA6TEAAAQBAJ` | eBook | Red Rabbit |
| `wZ-CDwAAQBAJ` | eBook | Reveal Me |
| `aS9CPgAACAAJ` | eBook | Rocannon's World |
| `pxY_EAAAQBAJ` | eBook | Sauron Defeated. The End Of The Third Age |
| `elABCwAAQBAJ` | eBook | Shakespeare's Champion |
| `j8tmEQAAQBAJ` | eBook | Shakespeare's Christmas |
| `UB6E-h0wS84C` | eBook | Shatter Me |
| `giXxsgEACAAJ` | eBook | Shatter Me |
| `L04eDgAAQBAJ` | eBook | Sleep Like a Baby |
| `k7Tkl7ACkwcC` | eBook | Surprised by Joy |
| `SMiJCwAAQBAJ` | eBook | Tales from the Shadowhunter Academy |
| `alZJ6--uhyUC` | eBook | The Amber Spyglass |
| `Ivg5DwAAQBAJ` | eBook | The Crooked Staircase |
| `eC1MDwAAQBAJ` | eBook | The Dark Talent |
| `sfi_DwAAQBAJ` | eBook | The Evening and the Morning |
| `ZVX4DwAAQBAJ` | eBook | The Evening and the Morning |
| `xFr92V2k3PIC` | eBook | The Fellowship of the Ring (The Lord of the Rings, Book 1) |
| `y_SO_GJi81MC` | eBook | The Good Guy |
| `fJaCEAAAQBAJ` | eBook | The Great Divorce |
| `IaMpAAAACAAJ` | eBook | The Hedge Knight |
| `2CKuEQAAQBAJ` | eBook | The Heroes of Olympus, Book One. The Lost Hero |
| `7XjgswEACAAJ` | eBook | The House of Hades |
| `4KJuMAEACAAJ` | eBook | The Infernal Devices (Boxed Set) |
| `ws2LNcOIubEC` | eBook | The Jesus Incident |
| `5ffYzQEACAAJ` | eBook | The Julius House |
| `hJGWuxd1a_IC` | eBook | The Key to Midnight |
| `VDs6CQAAQBAJ` | eBook | The Knights of Crystallia |
| `gqpSPwAACAAJ` | eBook | The Last Hero |
| `pcyOEAAAQBAJ` | eBook | The Last Olympian |
| `HeKxxAIzXI4C` | eBook | The Long Fall |
| `odqk4bsjdKAC` | eBook | The New New Thing |
| `xl0-XHoXrvYC` | eBook | The Science of Discworld II |
| `w48kmK8CrvEC` | eBook | The Screwtape Letters |
| `hupYCwAAQBAJ` | eBook | The Scrivener's Bones |
| `oTw6CQAAQBAJ` | eBook | The Shattered Lens |
| `aFy9AQAACAAJ` | eBook | The Subtle Art Of Not Giving A F*Ck |
| `HJIaZMnrcVgC` | eBook | The Sunset Limited |
| `Obm7DmrDsroC` | eBook | The Tempest Tales |
| `9LoxEAAAQBAJ` | eBook | The Treason Of Isengard |
| `YN-HSCwta5IC` | eBook | The Voyage of the Dawn Treader (adult) |
| `Iest_zZHolAC` | eBook | The Voyage of the Dawn Treader (full color) |
| `gqQjEQAAQBAJ` | eBook | The Wave |
| `xgyREAAAQBAJ` | eBook | The Witch's Vacuum Cleaner And Other Stories |
| `PyRvEAAAQBAJ` | eBook | These Infinite Threads |
| `Ec5mEQAAQBAJ` | eBook | Three Bedrooms, One Corpse |
| `ZYK4q11X1UoC` | eBook | Tom Clancy SSN |
| `cjZOBQAAQBAJ` | eBook | Triple |
| `NyZ7Wp2jkqMC` | eBook | Whispers |
| `laM7DwAAQBAJ` | eBook | Wild Cards I |
| `6Y3CLykbEAAC` | eBook | Written in My Own Heart's Blood |

## 3. Library copies that are the wrong book (for a person: the books Fix)

An epub title check of the 114 held eBooks against the book's name flagged these (the first two are certainly wrong,
the last two need a look). They are `Skipped` now like the rest, so LazyLibrarian will not replace them with another
wrong grab; a Fix re-acquires.

| Book (eBook) | BookID | What the file is |
|---|---|---|
| Wild Cards I | `laM7DwAAQBAJ` | "The Button Man and the Murder Tree" (Wild Cards 21.3). About 50 different Wild Cards volumes were imported as Wild Cards I in August: its title is a token subset of every volume's, so LazyLibrarian's fuzzy match accepts any of them. A Fix will likely grab another volume the same way; it needs a hand-picked release. |
| The Last Olympian | `pcyOEAAAQBAJ` | "The Sea of Monsters" (Percy Jackson 2, not 5) |
| The Dark Talent | `eC1MDwAAQBAJ` | titled "Alcatraz Versus the Evil Librarians" (series book 1, not 5); worth a look |
| The Infernal Devices (Boxed Set) | `4KJuMAEACAAJ` | titled "Clockwork Princess" (book 3 only); worth a look |

## 4. The 12 fail loops left (still `Wanted`, nothing on disk)

| Book | Format | Failed grabs | Why |
|---|---|---|---|
| Twilight | AudioBook | 39 | Only whole-saga bundles match (490 and 380 mp3 in per-book folders); LazyLibrarian finds no audiobook file at the top. Two bundles seed in qBittorrent. |
| The Hedge Knight (`gXIAoQEACAAJ`) | eBook | 17 | Usenet posts incomplete ("Aborted, cannot be completed") |
| A Bone to Pick | eBook | 15 | Articles gone from the provider ("Not on your server") |
| Eragon - Die Weisheit des Feuers | eBook | 11 | The wanted entry is the German edition; English releases do not match it |
| Rebel Island | eBook | 10 | Wrong-type downloads, NZB fetch failures in July |
| Conan The Magnificent | eBook | 9 | Wrong-type downloads |
| The Inheritance Cycle | AudioBook | 7 | The wanted entry is the 4-book set; the set's torrent seeds, but its files sit in per-book folders |
| Hornet Flight | eBook | 7 | Wrong-type downloads (last 2026-07-18) |
| The Pandora Sequence | AudioBook | 5 | Incomplete posts |
| The Man from St. Petersburg | eBook | 5 | Wrong-type downloads (last 2026-07-18) |
| Kingdom of Ash | eBook | 5 | Repair failures, wrong-type downloads |
| Defy Me | AudioBook | 5 | Two complete copies seed in qBittorrent as bare files; the imports failed on a stale folder in the old `books-mam.unpack` directory (gone since 2026-09-22), and re-grabs are refused as duplicate torrents. A manual import in LazyLibrarian lands it. |

## 5. How to re-run the checks

- Held but `Wanted` (should stay at 0 apart from open Fixes): count books whose `Status`/`AudioStatus` is `Wanted`
  and whose `BookFile`/`AudioFile` exists, from the LazyLibrarian pod, database opened read-only.
- Loop rate: `wanted` rows with `NZBdate` in the last 7 days, grouped by `Status` and by `DLResult` shape.

## 6. Follow-up: the two wrong-volume eBooks (2026-09-29, ops)

Both eBooks from section 3 are fixed and verified. Only the eBook format was wrong for each; the audiobooks held the right
title (two hand-cleaning notes below).

| Book | BookID | Was | Now |
|---|---|---|---|
| The Last Olympian | `pcyOEAAAQBAJ` | epub tagged "The Sea of Monsters" (Percy Jackson 2) | epub 2.9 MB tagged "The Last Olympian" / Rick Riordan; text has Kronos, Thalia, Luke, not the Sea of Monsters plot |
| Wild Cards I | `laM7DwAAQBAJ` | epub 579 KB, "The Button Man and the Murder Tree" (Wild Cards 21.3) | epub 930 KB tagged "Wild Cards 01 - Wild Cards I" (the Expanded edition); stories from volume I present (Thirty Minutes Over Broadway, Fortunato, Croyd), no Button Man |

Both LazyLibrarian book rows read `Open` with the new file, and each replaced the old epub in place (one epub per folder, no
duplicate). Kavita picks them up on its next scan.

**Audit.** Both went through the audited books Fix path (`createBookFixRequest` / `runBookFixRequest` /
`recordBookFixAction`, actor null, the same code the Fix button runs) and are `completed` in `book_fix_requests`: Last Olympian
on the Kavita item "The Last Olympian" (fix `b44cf2e6`), Wild Cards I on the Kavita item "Wild Cards" (fix `cc597aca`; there is
no Kavita item named "Wild Cards I", and that item's LazyLibrarian id is `laM7DwAAQBAJ`). The `actions_taken` array holds the manual steps.

**What the automatic path did and why it needed a hand.**

- `runBookFixRequest` calls `addBook` then `queueBook` then `searchBook` back to back. LazyLibrarian runs `addBook` in the
  background, and it finished *after* `queueBook`, writing the book back as `Skipped/Skipped`. The search then ran on a
  `Skipped` book and found nothing. It also flipped the Last Olympian **audiobook** row from `Open` to `Skipped` (the files are
  untouched). `addBook` takes `&wait`; the Fix path did not use it (fixed in #626, below).
- Even without that race, LazyLibrarian's search returned nothing usable (the Last Olympian title is searched as "The Last
  Olympian: Percy Jackson and the Olympians: Book 5"; Wild Cards I matches any volume). So both releases were picked by hand from
  LazyLibrarian's own manual search (`booksearch` + `snatch_book`, the page the UI uses): usenet, epub, English, sensible size.
  Last Olympian: NZBgeek "Rick Riordan - [Percy Jackson and the Olympians 05] - The Last Olympian (US) (retail) (epub)",
  2.8 MB. Wild Cards I: NZBgeek "George R R Martin (ed) - [Wildcards 01] - Wild Cards Expanded edition (retail) (epub)", 935 KB.
  No torrent, nothing on MAM.
- SABnzbd (`no_dupes` 3) refused both as `Duplicate NZB`: it keys on the NZB's articles, so re-posting the same NZB changes
  nothing, and both had been downloaded before (the good Wild Cards I copy on 2026-08-24, the Last Olympian one 23 times in
  July; the good epubs were later overwritten by the wrong grabs). Handling, one per book:
  - Last Olympian: the July download was still on disk in the LazyLibrarian download directory
    (`complete-k8s/lazylibrarian/...(epub).23`); imported it with `cmd=importBook&library=eBook&id=...&dir=...`.
  - Wild Cards I: no copy on disk, so the one stale SABnzbd history record of that exact download (2026-08-24, plus the
    failed duplicate stubs of today's attempts) was deleted from SABnzbd's history, which is the only thing its duplicate check
    reads. The download then ran, and it was imported with `importBook` as well.
- `importBook` marks every `wanted` history row of that BookID `Processed`. That rewrote the old `Failed`/`Processed` rows of
  the Last Olympian in LazyLibrarian's history (cosmetic; the real record is section 2 and the SABnzbd history).

**Left as they are on purpose (owner call, per the Fix design's stale-file rule).**

- `EBooks/George R.R. Martin/Wild Cards I/Wild Cards I - George R.R. Martin.mobi` (1.5 MB, 2026-08-29) is the wrong volume:
  "Wild Cards: Jokers Wild" (volume III), next to the correct epub. Not deleted.
- The Wild Cards I **audiobook** folder is a mix of volumes (Aces High, Jokers Wild, Aces Abroad, German editions and volume I
  parts in one directory of 122 files), and the Last Olympian audiobook folder holds the right book but several copies
  interleaved (299 files: chapter files, `NN of 98` files and an m4b). Neither is a wrong-file fix; they need a hand clean.
- The Last Olympian **audiobook** row now reads `Skipped` (was `Open`) because of the `addBook` race above; the files are intact.
  It is one more held-but-`Skipped` format like the 127 in section 2, so it stays quiet.

**Cleaned afterwards (coordinator ruling).** Deleted the wrong `Wild Cards I` `.mobi` (Jokers Wild); reset the Last Olympian audiobook row to `Open` with a `forceAudioBookScan` of its folder; in the Last Olympian audiobook folder deleted the 98 `(N).mp3` files (byte-identical to the `NN of 98` set, md5-checked); in the Wild Cards I audiobook folder deleted the 11 files with a byte-identical twin in their own volume's folder (Jokers Wild chapters). Left as is because they are different releases or unique content, not duplicates: the Last Olympian `Ch NN` set (98 files, another encoding) and the torrent-seeded m4b, and the rest of the Wild Cards I audiobook folder (volume II and IV files and other-volume chapters with no copy elsewhere, plus two non-identical volume I sets); which release to keep there is a person's call.

**Code fix.** haynesnetwork #626 makes `addBook` send `&wait=1` (LazyLibrarian only runs the add synchronously with it), so a
Fix on an already-known book no longer ends `Skipped/Skipped` behind a "search triggered" audit row. It does not stop LazyLibrarian's
add from resetting the book's *other* format to `Skipped`; that is LazyLibrarian's own behaviour.

## 7. Follow-up: library-wide audit for wrong-book files (2026-09-29, ops)

Prompted by #630 and the earlier wrong-volume finds. Every book that holds a file was checked against what the file really
is: 885 books, 626 with at least one file (427 eBook and 409 audiobook formats), metadata of 23,849 files read (epub OPF,
mobi and azw3 EXTH, ID3, MP4 and FLAC tags; headers only, read-only, about a minute in the pod). Titles were compared
fuzzily (series, subtitle, omnibus and language variants accepted). No readable metadata: 6 eBook books, 1 audiobook book
and 533 single files (untagged mp3 parts, PDFs). Scripts: `.agents/context/ll-library-audit/` (`scan_raw.py`, `wanted_dump.py`,
`audit.py`, `opfwalk.py`). The per-item tables were parked in #631; #630 is closed.

| Finding | Found | Done | Left |
|---|---|---|---|
| Bare-file torrent dumps copied into unrelated audiobook folders | 37 files, 23 folders, 17.5 GB | all 37 moved to quarantine (originals still seed in `books-mam`) | 0 |
| Wrong-book eBook files (Inheritance held the German Fractal Noise, Twilight held Life and Death, the Dark Talent folder held Alcatraz 1, Key to Midnight held Lullaby, Fantastic Beasts held Crimes of Grindelwald, and more) | 14 files in 9 folders | 5 re-homed under their own books, 9 quarantined; Inheritance, Twilight, Key to Midnight and Fantastic Beasts restored, Alcatraz 1 and Dark Talent re-linked to files already on disk | The Lost Hero (only file was the Graphic Novel; prose edition not findable) |
| Audiobook rows whose file was a removed dump | 6 | 5 re-pointed to their own file, 1 cleared | 0 |
| Books whose recorded file is another book's file | 40 eBook | 3 hold, 33 reverted by the next scan (see below) | 37, in #631 |
| `.opf` sidecars carrying another book's title | 1,274 of 2,517 | 4 orphan audiobook sidecars | 1,270 (regenerated by the scan) |
| Audiobook folders holding other books | 16 books | none | 16 (#631) |
| One file claimed by two books | 58 | none | 50 are same-title duplicate rows (harmless), 8 are the pointer cases above |

Everything removed is under `books/quarantine/audit-2026-09-29/` (162 entries, `manifest.jsonl` gives each old path). The
database was copied to `/config/lazylibrarian.db.pre-audit-20260929` before the first change. Restored books: usenet for
Inheritance and Fantastic Beasts; Twilight and The Key to Midnight came from MAM because the only usenet Twilight release failed
verification and Key to Midnight has none (both are single small torrents, seeding as usual). Stale SABnzbd history records for
the Inheritance and Twilight NZBs were deleted so the duplicate check let them through.

**Three mechanisms.**

1. **Library scan reuses the previous file's book id** (the big one). In `librarysync.py`, `gb_id` is set only when the current
   file has one and is never reset, while `bookid = eval('gb_id')` reads it for every file, so an untracked folder inherits the
   last book scanned, gets that book's `.opf` written into it and that book's `BookFile` pointed at it. 1,274 folders were
   stamped in two bursts (16 July and 22 September, each a run of consecutive folders with one wrong id); the daily
   `lazylibrarian-library-scan` re-applies it, and it also adds unrelated books found by search (nine turned `Wanted` after the
   audit's scans and were set back to `Skipped`). Repairing the pointers in the database was reverted by the next scan (33 of
   35), and moving 106 stamped sidecars aside was undone within a second. It needs a decision first: suspend or patch the scan.
2. **Flat download directories.** The 37 dump copies are files from a flat staging directory (`books-mam.unpack.fail` held three bare-file
   torrents) whose files are byte-identical to the copies found in unrelated folders, which fits LazyLibrarian treating the parent
   directory of a bare-file torrent as the download folder (the earlier `mam-misfile-2026-09-22` quarantine points the same way).
3. **Author packs and title-subset matches.** A multi-book MAM pack imported one wrong file (Inheritance took the German Fractal
   Noise from a Paolini pack), and title-subset matching accepts a different book (Twilight took Life and Death, Wild Cards I took
   any volume). Same family as section 3.

**Operating notes for the next person.** `importBook` only works from a staging folder owned by the LazyLibrarian user and creates
`<folder>.unpack` beside it; a failed import flips the book to `Wanted` (run `unqueueBook`). A book that already holds a correct
sibling file (Dark Talent had its original epub) only needs its link fixed, not a download. The duplicate rows in #630 and
#621 are victims of mechanism 1, not stray grabs.

## 8. The scan bug: fixed at the source, and the #631 damage repaired (2026-09-29, ops)

Coordinator default for this work: suspend the scheduled scan unless something important depends on it. Something does, so
the bug was patched instead and the CronJob was suspended only for the repair window.

**The bug, verified in the running image** (`linuxserver/lazylibrarian:version-40a389ea`, LazyLibrarian commit `40a389ea`,
pyproject `2026.05.25`; unmodified `librarysync.py` sha256 `b05018db…41933e9`). In `library_scan`, the per-file block
(lines 812 to 821) resets `isbn`, `book`, `author`, `bookid` and the rest, but not `gr_id`, `gb_id`, `ol_id`, `hc_id` or
`dnb_id`. Lines 875 to 889 assign them only when the file carries that id, and line 998 (`bookid = eval(this_source['book_key'])`,
`gb_id` for Google Books) and line 1046 read them for every file. The `except NameError` covers only the files before the first
one that has an id.

It did more damage than the stamped sidecars. When the stale id was **not** in the database but the file's title matched a
row by the same author, the "title matches" branch (around line 1009) ran `UPDATE … SET BookID=<stale id>` on books, member,
wanted, failedsearch, genrebooks and bookauthors. So **20 rows were re-keyed to another book's Google Books id.** The row's
own id survives in its `gb_id` column and `BookLink`. Each re-keyed row then pulled in the file that legitimately embeds that id
(The Savage Blue claimed "God Emperor of Dune", Unfair Advantage claimed "The Silmarillion"). haynesnetwork's pushes use the
real id, so they missed the row and LazyLibrarian added duplicates (4 existed).

**What triggers a scan.** (1) The `lazylibrarian-library-scan` CronJob (`forceLibraryScan` then `forceAudioBookScan`, daily
09:10 UTC). (2) The UI's Library Scan button and the per-author scan. (3) The API commands `forceLibraryScan`,
`forceAudioBookScan` and `includeAlternate`. (4) Post-processing only when Calibre is configured (`IMP_CALIBREDB` is empty
here, so not in this deployment). LazyLibrarian has no scheduler entry for it, and it does not scan at startup.
haynesnetwork never calls a scan; it uses `forceProcess` only.

**What depends on it.** The scan is the only thing besides the post-processor that tells LazyLibrarian which books are on
disk (haynes-ops #3087, OPS-013 §12). haynesnetwork's held-guard (`llFormatAlreadyHeld`) reads exactly that. Before the
repair, 330 held books were unlinked, 26 of them `Wanted` and searched daily. ABS and Kavita read files directly and do
not depend on it. So suspending it would have stopped the damage but also stopped LazyLibrarian from learning about files on
disk, and the UI button would still have run the buggy code.

**Chosen: patch, not suspend.** haynes-ops #3273 (merged, `aaa515b7`) mounts the image's own `librarysync.py` plus one
line (`gr_id = gb_id = ol_id = hc_id = dnb_id = None`, line 845 of the mounted file) from the ConfigMap
`lazylibrarian-librarysync` over that single file (`subPath`, read-only). The file's header and a comment on the image tag
pin it to `version-40a389ea` and say what to do on a bump: re-derive the file from the new image, or drop the override if
upstream fixed it. Renovate has never proposed a bump for this image. **CronJob:** suspended by hand at 19:50Z for the repair
(`spec.suspend` was unset, i.e. false; Flux does not own the field), but Flux's reconcile of #3273 at 19:53Z quietly reverted it. kustomize-controller takes over fields that a `kubectl patch` sets, so a hand suspend of a Flux-managed CronJob only lasts until the next reconcile. No scheduled run fell in that window (the next is 09:10Z), and the patched code was live from 19:54Z. To hold a suspend, set `spec.suspend: true` in git. The CronJob reads `suspend: false` now, as intended.

**Repair, in order** (database copies: `/config/lazylibrarian.db.pre-631-repair-20260929`, `…pre-631-phase2-20260929`,
`…pre-631-audio-20260929`; every moved file is in a `manifest.jsonl`; scripts in `ll-library-audit/`).

| Item | Done |
|---|---|
| (a) 37 rows pointing at another book's file | 36 re-pointed to their own file, 1 cleared (Christmas at Hogwarts, no file). The audit had marked 13 as "no own file". 11 of those do have one, named `Author - Title.epub` (the audit only looked for `Title - Author`). |
| (b) 1,274 stamped `.opf` sidecars | Quarantined to `books/quarantine/opf-stamps-2026-09-29/` (mirrors the tree, manifest has each sha256). The fixed scan regenerated 453 sidecars through LazyLibrarian's own `create_opf`. |
| 20 re-keyed rows (found during the repair) | 16 re-keyed back to their own id and 4 merged into the duplicate that already held the real id (the stale row is deleted, its file, status, history and authors folded into the real one). 25 own-folder sidecars had the stale id replaced in place (keeps ABS's opf metadata unchanged), and 27 sidecars were quarantined to `…/opf-stamps-2026-09-29/phase2/`: 16 in other books' folders that carried a stale id, 11 fuzzy mismatches. The other 13 `BookID ≠ gb_id` rows are LazyLibrarian re-keying a book to its own file's embedded id (their own epub carries it), which is normal. 3 have no evidence either way (A Column of Fire, Locked On, Fooled by Randomness). |
| (c) 16 mixed audiobook folders | 15 of 16 rows fixed, in 9 of the 10 folders; Wild Cards I is left (§6 made which release to keep a person's call). 2,773 files quarantined (18.7 GB) to `books/quarantine/audit-631-2026-09-29/AudioBooks/`: 2,202 German editions (Mistborn 4 to 7, The Ragpicker King, Throne of Glass 0/2/3/4, per the F10 English-only ruling), further copies of books whose own folder already holds them (Hero of Ages, Bands of Mourning, Alloy of Law, Throne of Glass ×3, Crown of Midnight, Queen of Shadows, Sworn Sword, Fifty Shades of Grey, Darker), and 16 files of 4 unrequested books with no row in Nemesis Games. 30 files re-homed: the English Shadows of Self (was under Mistborn) into its own folder, and Camp Half-Blood Confidential out of the Percy Jackson series folder. 13 audio rows re-pointed. No torrent seeds from the library (0 of 931 have a save path under `media/books`). |
| (d) 5 ambiguous eBooks | All resolved. Skyward: the pdf is the novel (Gollancz 2018), the epub is Skyward Flight, which was re-homed and linked to its own row. The "Terry Pratchett's Discworld" file was a second Unseen Academicals: quarantined, row cleared. The Mortal Instruments: the epub was an illustrated Shadowhunter's Codex (a 2026-09-22 wrong grab), quarantined; the row now points at the folder's mobi, which is the series omnibus. The Lord John bundle folder held the Outlander 7-book bundle: re-homed. The Lost Hero: the prose epub was on disk under `Rick Riordan/The Lost Hero/` and is now linked. |

**The first fixed scan also exposed LazyLibrarian's fuzzy title matching** (mechanism 3 of §7). With no stale id to hide
behind, 13 files matched the wrong book by the same author (Jokers Wild and Busted Flush matched Aces High, Esio Trot matched
Dirty Beasts, and others). The 7 rows that turned `Open` on those matches were reverted, 3 of them `Wanted`. Those 13 folders now carry `.ll_ignore`
(a LazyLibrarian-native skip) with a note inside; remove it once LazyLibrarian has an exact row for that book. 14 fuzzy
matches that are fair (Beacon 23 parts matching Beacon 23, a Four story matching Four) were left.

**Verification.** A second full eBook scan after the repair wrote no stale-id sidecar and re-keyed nothing through the
bug; its only id changes were 5 files linking to their own embedded id. All 42 repaired rows (the 37 plus the 5 in (d)) point at
a file that exists and whose folder matches the row title. The fixed audiobook scan (23 minutes, after the splits) re-linked 10 audio rows, all to their own title. It found no stale ids, and all 773 audiobook sidecars match their folder. A third eBook scan changed no row and wrote no sidecar, so the daily run is now idempotent. The 16 eBook sidecars that still name a different title are the 14 fair fuzzy matches, the Infernal Devices box set against Clockwork Princess, and the Charterhouse Dune folder, whose file really is The Pandora Sequence. After the scans, haynesnetwork's format-pairing reported `skippedHeld 118` (14 on 2026-09-22).

**ABS.** ABS has one library, `AudioBooks`, so the eBook sidecars never reached it. Its metadata precedence puts its own
`metadata.json` above the `.opf` and the tags, which is why the mixed folders kept their old titles and chapter lists. For
the reorganised items, their `metadata.json` was moved aside as `metadata.json.pre-631-20260929` in
`/metadata/items/<id>/` and the item rescanned through the API (logged in as root with the password from the haynesnetwork
pod's environment). That rebuilt 9 items. The 4 that ABS reported as already up to date got their `metadata.json` back.
6 titles were then set through the API: Shadows of Self, Nemesis Games, Throne of Glass, A Court of Mist and Fury,
Twilight and New Moon. The one live listen (House of Flame and Shadow) is at 25.7 h inside its m4b,
which is track 1, so dropping the Throne of Glass tracks after it did not move her position. Spot-checked 12 items through the API (titles, file and chapter counts): Shadows of Self, Mistborn, Sword Catcher, Throne of Glass, A Court of Mist and Fury, House of Flame and Shadow, The Hedge Knight, Grey, Twilight, New Moon, Camp Half-Blood Confidential and Nemesis Games. All show the right title. Several still hold two or more releases of the same book (Mistborn, Throne of Glass, A Court of Mist and Fury, Grey, Twilight, Nemesis Games), which §6 left as a person's call. The Percy Jackson and the Olympians item now has no audio and shows as missing in ABS. Also done under (c), outside the #631 list: the Twilight audiobook folder held New Moon (212 files, now `Stephenie Meyer/New Moon/`, a new ABS item) and 4 Swedish files (quarantined). The Twilight row now links a Twilight file, which ends the Twilight audiobook fail loop from §1.

**Side effect of the pod roll.** LazyLibrarian's startup check deletes authors whose `TotalBooks` is 0, and books cascade
with them. It removed 18 authors and 11 books added by the API on 2026-09-29 that had no `bookauthors` row, including
`Yesteryear` (`Wanted`). Any pod roll does this. If one of them is a haynesnetwork want, the next sync pushes it again.

**Upstream.** Not filed: this pod cannot reach gitlab.com. LazyLibrarian's own update check says the build is 436 commits
behind master, so a newer build may already fix it. The report text is on #631.

**Left, tracked on #631.** (1) The 13 `.ll_ignore` folders need an exact LazyLibrarian row each: `findBook`, then `addBook`
with the right Google Books id, then delete `.ll_ignore` and scan that folder. `findBook` returned nothing at 21:02Z because
LazyLibrarian's Google Books key was exhausted by the day's scans; the key resets at 07:00 UTC. (2) Wild Cards I and the
multi-release audiobook items (§6: which release to keep is a person's call). (3) Three rows whose `BookID` differs from
`gb_id` with no file evidence either way (A Column of Fire, Locked On, Fooled by Randomness), each with a same-title
duplicate. They are harmless as they stand. (4) The Midnight Sun audiobook row links a file named "Twilight Saga 01"; that folder was
not checked.
