# 2026-10-06 — LazyLibrarian's `.mobi` / `.azw3` books converted to EPUB (issue #770)

Owner ruling on #770: **"Convert to EPUB."** LazyLibrarian keeps accepting `.mobi` and `.azw3`; they are converted to
EPUB after import, beside the original, which is kept; nothing is searched or downloaded again. Design record: DESIGN-028
amendment "EPUB conversion". Cluster side: haynes-ops #3445 and #3446 (`kubernetes/main/apps/downloads/lazylibrarian/app/`,
CronJob `lazylibrarian-epub-convert`, script and tests in `epub-convert/`).

## Before (read-only, 2026-10-06 ~16:00Z)

- On disk under `EBooks`: 125 folders held a `.mobi` / `.azw3` and no epub or pdf (272 `.mobi` and 174 `.azw3` files in
  all; most sit beside an epub already). 57 of them are a LazyLibrarian `BookFile` (LazyLibrarian DB opened `mode=ro`);
  the other 68 are library files LazyLibrarian does not point at.
- App wants on those 57 books (replica `postgres16-11`, read-only session): 48 pairing (ebook `landed`), 2 goodreads
  (ebook `landed`), 6 collection: five of the six OC-021 Downloaded wants (Eragon, Shatter Me, We Can Be Mended, Four: The
  Transfer, Four: The Son) and The World of All Souls (`requested`). The sixth OC-021 want, Four: The Traitor, sits on
  another LazyLibrarian id; its book's folder (`Veronica Roth/The Traitor`, the Kindle Single) was one of the 125.
- Libretto, all 75 recipes: 228 members missing from Kavita, 180 from Audiobookshelf.
- A probe and a dry run (calibre image, the share mounted read-only, conversions into the pod's `/tmp`) over all 125:
  121 would convert, 4 would be held, 0 DRM; slowest book 19 s; whole pass 4 minutes at CPU limit 1.

## The run (declared activity act-164954-555003, downloads + media)

- **16:50Z, bulk Job** `lazylibrarian-epub-convert-bulk-20261006` (from the CronJob): 121 converted, 4 held, census
  `unconverted 0`, Kavita scan queued. Every EPUB passed `ebook-meta` (title and author read) and the title check against
  its folder; for the 57 LazyLibrarian books the EPUB title was also checked against LazyLibrarian's `BookName` (all match
  except the held Sand, below).
- **Regression found and fixed.** Libretto went from held to missing on "Dirk Gently's Holistic Detective Agency": the run
  had converted 8 folders whose book Kavita already showed from a sibling folder of the same author (names differing only in
  punctuation) or which were two copies of one book, and Libretto refuses a member held twice as ambiguous. haynes-ops
  #3446 added the duplicate guard (a sibling with the same title words holding an epub or pdf: skip, census `duplicate`).
  A one-off Job removed the 8 EPUBs the run had written there (size-checked against the run's log; originals untouched):
  The Taggerung, The All Souls Real-Time Reading Companion, Dirk Gently's Holistic Detective Agency, So Long and Thanks for
  All the Fish, The Long Dark Tea-Time of the Soul (Douglas Adams), The Titans Curse (Rick Riordan), The Girl Who Played with
  Fire (Stieg Larsson), and one of the two Life, the Universe and Everything folders. For that pair the copy kept is the one
  whose EPUB title is clean ("Life, the Universe and Everything"; the other reads "03 Life, the Universe and Everything",
  which Libretto does not pair).
- **Kept: 113 EPUBs.** Census after: `unconverted 0, held 4, duplicate 8`.

## Held (left exactly as they are; `books/.epub-convert/held.tsv`)

| Folder | Why | What it needs |
| --- | --- | --- |
| Hugh Howey/Sand | `title_mismatch`: the file (`Hugh Howey - Sand.azw3`, 2025) is *The Best American Science Fiction and Fantasy 2024*, which is also LazyLibrarian's book for it (`Zi7wEAAAQBAJ`); only the folder and file name say Sand. No app want on it. | Rename the folder to the anthology's title (then delete the held line), or confirm it is Sand. |
| Dennis E. Taylor/Potomu chto nas mnogo | `title_mismatch`: the English *Bobiverse 2: For We Are Many* in a folder titled with the Russian edition's name. Not one of the 57. | Rename the folder or leave it; Kavita may already hold the English book elsewhere. |
| J.R.R. Tolkien/Tree and Leaf - Including Mythopoeia ... | `title_mismatch`: the file is *Beowulf: A Translation and Commentary*. Not one of the 57. | Another release of Tree and Leaf, if wanted. |
| Tom Clancy/Debt of Honor | `convert_error`: "KF8 does not have a valid FDST record" (a broken file). LazyLibrarian book `igdN-TOJVEsC`; pairing want `28ec5fba` reads its ebook `landed` though Kavita cannot show it. | A new release (a search), which the ruling did not cover. |

The four are issue #782 (the decisions they need).

## After

- **Kavita** (Books library 1, searched by file path through its API): all 113 kept EPUBs are indexed; the 8 removed are
  gone. The 57 LazyLibrarian books: 50 show from their own EPUB, 5 from the sibling copy that was already there, 2 are held
  (Sand, Debt of Honor).
- **App wants:** all 7 collection wants above (the six OC-021 and The World of All Souls) and both goodreads wants have
  their ebook in Kavita from its own EPUB; of the 48 pairing wants, 39 from their own EPUB, 8 from the sibling copy that was
  already there, 1 not (Debt of Honor).
- **Libretto** (all 75 recipes, 17:07Z): Kavita missing 228 to 211, Audiobookshelf 180 to 179; 18 members missing to held,
  none held to missing. 13 of the 18 are the conversion: the six OC-021 members (Eragon, Shatter Me, We Can Be Mended, Four:
  The Transfer, Four: The Son, Four: The Traitor), A Bone to Pick, Life, the Universe and Everything, Once Upon a Broken Heart,
  The Sins of Our Fathers, Brisingr, Kingdom of Ash, The World of All Souls. The other 5 (On the Way to the Wedding, Free Four,
  The World of Divergent, Rapport, Camp Half-Blood Confidential on Audiobookshelf) came from Libretto `sha-2e77f28`, which
  went live at ~17:02Z in the same window.
- **LazyLibrarian.** Its library scan (the `lazylibrarian-library-scan` CronJob run by hand, 16:55Z) re-pointed 48 of the
  57 `BookFile`s to the EPUB (same basename, `EBOOK_TYPE` lists epub first). Five of those pointed at EPUBs the dedupe then
  removed; an eBook-only scan at 17:21Z re-pointed them to their `.mobi`. Final: 43 of the 57 records point at the EPUB, the
  rest keep the original (allowed: the app reads LazyLibrarian's status, never its `BookFile`), and none of LazyLibrarian's
  939 epub `BookFile`s is missing on disk. No database write by hand. (The daily 09:10Z scan had failed today: LazyLibrarian
  restarted under it, curl exits 52 and 7; these two runs cover the day.)
- **App (17:27Z collections sync):** the six OC-021 collection wants and The World of All Souls are gone, removed by the
  wants pass now that Libretto lists their members held; no `collection_want_download_reverted` line. The books-sync at
  17:22Z mirrored 116 new Kavita items. The 48 pairing and 2 goodreads wants still read their ebook `landed`, now true in the
  library for all but Debt of Honor.

## How a new book flows

LazyLibrarian imports a `.mobi` / `.azw3`-only book; at the next :20 (after a 15-minute settle) the CronJob converts it,
logs `epub_convert` `converted`, touches the folders and queues a Kavita scan; the books-sync at :22 mirrors it; Libretto
pairs it; the collections sync at :27 deletes a collection want on it. LazyLibrarian links its `BookFile` to the EPUB at the
09:10Z library scan. Owed: OC-023.
