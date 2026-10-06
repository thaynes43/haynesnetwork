# 2026-10-06 — collection wants on a book LazyLibrarian holds (issue #759)

Investigation record behind the DESIGN-038 D-13 and DESIGN-037 D-04 amendments of this date. Everything was read-only:
`SELECT`s on the CNPG primary (`postgres16-1`, database `haynesnetwork`, session `default_transaction_read_only=on`), a
`mode=ro` open of LazyLibrarian's `/config/lazylibrarian.db`, Libretto's own `GET /api/collections/:id/missing`, and
Kavita / Audiobookshelf read APIs (from inside the Libretto pod, with its own credentials).

## The set (2026-10-06 ~09:45Z)

Unparked, unmatched, non-comic `origin='collection'` wants with an `ll_book_id`, whose LazyLibrarian book holds the
collection's format (`Open`/`Have`, an import date or a file) while the want's own format is not `landed`: **59** (the
issue counted 57 at 07:30Z). Every one of the 59 files exists on disk.

## Where each chain broke

| Cause | Rows | Fixed where |
| --- | --- | --- |
| **The app read the wrong target's missing list.** All 15 are audiobook wants of a Kavita + Audiobookshelf recipe; Libretto's own `abs` entry already counted them held. The wants pass read the flat `missing`, which is the first target's (Kavita's). | 15 | haynesnetwork: `missingForCollection` |
| **Libretto's matcher missed a book the library holds.** A book Kavita filed as a volume of a series (`Outlander` holds `Written in My Own Heart's Blood` as volume 8; `Bobiverse`, `The Pillars of the Earth`, `The Discworld`, `Redwall`, `The Dark Artifices`), the same book held twice (two Kavita series for an epub and a pdf, two Audiobookshelf copies: refused as ambiguous), or a title with series decoration (`Expanse 03 - Abaddon's Gate`, `Children of Anguish and Anarchy: Legacy of Orisha 3`, `The Lost Metal--A Mistborn Novel`, `Bridgerton: An Offer from a Gentleman`, `Artificial Condition--The Murderbot Diaries`). | 25 | Libretto PR #21 |
| **Kavita cannot show LazyLibrarian's file.** `.mobi` / `.azw3` (Kavita's Books library reads epub and pdf only): Eragon, Shatter Me, We Can Be Mended, Four: The Transfer, Four: The Son. | 5 | the real gap: they read Downloaded (DESIGN-028 amendment of this date) |
| **LazyLibrarian's book is another work or edition.** Gray Dawn (Stewart Edward White's, not Walter Mosley's), Shift (Stephen King's Night Shift), Compulsory (Dumbing Us Down), the three Bridgerton 2nd Epilogues (each on its novel's id), Four: The Traitor (the file is the four-story collection, which Kavita shows under that name). Not held: `requested` is the true status, except that Four: The Traitor reads Downloaded (LazyLibrarian did take a file under its title). | 7 | none needed for #759 (see below) |
| **The library holds it under a title that differs in words.** The World of Divergent (for "...: The Path to Allegiant"), Rapport (for "Rapport: Friendship, Solidarity, Communion, Empathy"), The World of All Souls (for "...: A Complete Guide to..."), Free Four: Tobias Tells the Story (for "...the Divergent Knife-Throwing Scene"), On the Way to the Wedding with 2nd Epilogue, From Percy Jackson: Camp Half-Blood Confidential: Your Real Guide..., The Last Hero: A Discworld Fable Graphic Novel (Kavita indexed only the illustrated pdf; LazyLibrarian's 171 KB epub was never indexed). No safe rule pairs these: dropping a subtitle that carries the book is how "Mistborn: Secret History" would take "Mistborn". | 7 | left as honest matcher misses; they stay Wanted |

Nothing was a library scan or path gap: Kavita's Books root is `/data/cephfs-hdd/data/media/books/EBooks`, LazyLibrarian's
eBook folder, and both libraries had scanned since the files landed. `books_items` (the app mirror) played no part: Libretto
matches against the libraries directly.

## The Libretto replay

Old matcher against new over all 75 recipes and every target, on one dump of the live libraries (Kavita series with their
chapters, Audiobookshelf items, every recipe's resolved works): 464 members missing before, 412 after. All 52 flips are
missing to held and each was checked by hand as the right book and volume; none flips the other way; no collection loses
a member. Two first drafts were rejected by the replay and changed:

- Indexing book titles beside series names moved works off their own item ("Men at Arms" from its own series to
  `The Discworld`, which also holds it) and made a title ambiguous where it was not ("Mostly Harmless"). Book titles are
  now a second tier, read only for a title no item carries as its own.
- Kavita chapter writers as the author guard vetoed true matches (Good Omens credits only Neil Gaiman). Writers now only
  verify that two copies are one book.

## The Downloaded state (the real gap)

A collection want's own format now reads `landed` while LazyLibrarian holds it, its book passes both Volume Checks, and the
library shows nothing named like LazyLibrarian's book; the drill labels it Downloaded ("Downloaded, not in the library
yet"). A dry run of that rule over the 19 left: Downloaded for the five `.mobi` / `.azw3` rows and Four: The Traitor; the
other 13 stay Wanted (the library shows a title like LazyLibrarian's, or the book fails a Volume Check). Before Libretto's
fix is live, three rows Libretto now pairs (Written in My Own Heart's Blood, Heaven's River, Guards! Guards!) would read
Downloaded too, because the app's Kavita mirror lists the series, not the books inside it; once Libretto pairs them their
wants are deleted.

## Still open after the fixes

- **LazyLibrarian accepts formats Kavita cannot open.** `ebook_type = epub, mobi, pdf, azw3`; 57 LazyLibrarian books
  hold only a `.mobi` / `.azw3` with no epub or pdf beside it, and 48 pairing wants and 1 unmatched goodreads want on
  them read their ebook `landed` (#752's LazyLibrarian landing) though Kavita cannot show the file.
  Whether LazyLibrarian should stop taking those formats, and whether the 57 should be searched again for an epub, is
  an owner decision: issue #770.
- **The 7 wants on another work's book** keep a wrong `ll_book_id`. The push guard sees LazyLibrarian holding that book
  and never searches, so they stay `requested` until parked. The Volume Check only names 4 of them (Compulsory and the
  three epilogues), which the capped cron force-search parks when it reaches them; Gray Dawn, Shift and Four: The
  Traitor share their words with the wrong book: issue #771.
