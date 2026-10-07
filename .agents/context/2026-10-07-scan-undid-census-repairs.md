# 2026-10-07 — the library scan undid the census repairs; the durable repair rule (OC-031, OC-032, OC-037)

## What failed

The 09:10Z LazyLibrarian library scan (CronJob `lazylibrarian-library-scan`, `forceLibraryScan` then
`forceAudioBookScan`, about 36 minutes) undid 9 of the 16 re-points from `fix_census_795.py`, Warriors 3's re-want, 4 of
the 5 states from `fix_census_799.py`, and the Divergent re-point from `fix_census_divergent.py`. The 10:15Z census
listed them as unheld `wrong_file` again.

## The mechanism (read from the code, the files and the log)

`librarysync.py` `library_scan` (image `version-40a389ea`, the haynes-ops override changes only id carry-over and the
author delete) walks `EBooks/` and `AudioBooks/` and matches every book file to a record by, in order:

1. an id in a folder opf, or in the epub's own OPF;
2. the exact title and author;
3. a fuzzy match over that author's books (`find_book_in_db`, a partial ratio: "Four Divergent Stories - Omnibus"
   contains "Divergent", "Fifty Shades Darker" contains "Darker");
4. the ISBN (Dean Koontz's Innocence epub carries How We Learn's ISBN);
5. an online search.

On a match it writes an opf naming the record when the folder has none (`create_opf`, `overwrite=False`) and points the
record's `BookFile` / `AudioFile` at the file, setting it Open even when it was Skipped or Wanted. The last match wins.

The earlier repair rule held the opf naming the wrong record and left the wrong book in its folder. That removes signal 1
only: at 09:11 to 09:43Z the scan re-matched each wrong book by title or ISBN, wrote a fresh opf naming the wrong record
beside it (every one of the 19 opfs it wrote is dated in that window), and re-pointed the record. The log shows it, e.g.
"Updating audiobook location for Douglas Adams The Ultimate Hitchhiker's Guide to the Galaxy from None to ...". The
holding folder `books/quarantine/` is outside both scanned roots (`ebook_dir`, `audio_dir`) and played no part, so no
GitOps change was needed.

Two of the findings were not the scan but new wrong books landing for a re-wanted format: Partners' audiobook (grab 9616,
"John Grisham - JB 03.5 - Sparring Partners", a release title the #795 block on grab 9567 did not cover) and Darker's
audiobook (grab 9600, "Fifty Shades 2 - Fifty Shades Darker (2012) MP3"). Both copies were md5-identical to the copies
already in Sparring Partners/ and Fifty Shades Darker/.

## The durable rule (for every future wrong-file repair)

A folder that holds a book which is the wrong file for some record, and stays in the library for Kavita or
Audiobookshelf, gets an empty `.ll_ignore` (owner 1000:1000). `library_scan` drops any directory holding that file from
its walk, so nothing in it is matched or re-linked. The CronJob's API scans run with `remove=False`, so a record already
pointing into an ignored folder keeps its link. LazyLibrarian's postprocess of a new download does not read the marker.
Undo: delete it. Kavita and Audiobookshelf ignore the dotfile.

Also mark the folder of a book that a re-wanted record would match by title (Sparring Partners/ for Partners, Fifty
Shades Darker/ for Darker), and still hold the opf naming the wrong record. When a repair re-wants a format, block every
release that delivered the wrong book, and expect another release of the same wrong book: the re-want's owed check must
say so.

## The repair (`fix_census_scan_1007.py`, 2026-10-07 13:25Z; LazyLibrarian backup `lazylibrarian.db.pre-scan-durable-20261007`)

- Re-pointed 12 records to the right file again: K0UczgEACAAJ, QGPZEAAAQBAJ, wzxmQgAACAAJ, IMlH63ZPShAC, zTCLswEACAAJ,
  qKuOEAAAQBAJ, lSybHLQbZ_kC, W4ZDugEACAAJ, VKBoDwAAQBAJ, ENRSDwAAQBAJ, 83Hv_EYvHgEC, 4bLbswEACAAJ (eBook).
- Back to Skipped with no file: K3wuAAAACAAJ (eBook), 4m0Qj9xKksYC (audiobook).
- Re-wanted (pointer blanked, `queueBook`): OwTswUGVzVcC Warriors 3 (eBook), 4bLbswEACAAJ (audiobook), VNalCwAAQBAJ
  Partners (audiobook; grab 9616 blocked with a Failed row), 8CzFswEACAAJ Darker (audiobook; grab 9600 blocked). Max
  wanted rowid after the run: 9633.
- Held: the 19 opfs the scan wrote (suffix `.scan-20261007`, since the earlier repairs hold opfs of the same names), the
  102 Partners tracks and 3 Darker tracks as `duplicate` (each md5-equal to its counterpart), and 4 sidecars.
- `.ll_ignore` in 18 folders (listed in the script's IGNORE and in `manifest.jsonl`), 21 with the follow-up below.

## Verified, and one more pass (`fix_census_scan_1007b.py`, 14:08Z)

A full library scan (Job `lazylibrarian-library-scan-manual-1791379571`, 13:26 to 14:05Z) left every marked folder alone:
17 of the 18 records kept what the script set, the four re-wants stayed Wanted with no file, and no wanted row was added.
The 18th, VKBoDwAAQBAJ (The Expanse Origins #3), was linked to "The Expanse Origins - Amos Burton/" (#4 of 4): the 09:10Z
scan had also written opfs naming it there and in "The Expanse Origins - James Holden/" (#1), folders the first script did
not know. A sweep of the whole library for opfs naming any repaired record outside its own folder found those two and
`Eulalia!/Redwall.opf` (re-written at 09:37Z, after `fix_census_795.py` had held it). The follow-up script re-pointed
VKBo, held the three opfs and marked the three folders; scoped scans of `EBooks/James S.A. Corey` and
`AudioBooks/Brian Jacques` then kept VKBo on #3 and Redwall on its new download.

So the sweep belongs in every repair: after holding, look for opfs naming the record anywhere in the library, not only
beside the file the census flagged. The census at 14:11Z (`books-census-manual-1791382243`, v0.109.4): llBooks 1342,
wrongFile 0 unheld, held wrong_file 7 + foreign_held 1, missingFile 0, unusedHolds [], holds ok, appDb ok.

Nothing was deleted. The owed checks OC-031, OC-032, OC-034 to OC-037, OC-039 (Darker) and OC-040 (the next scheduled
scan) record the follow-ups.
