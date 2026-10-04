# 2026-10-04 — wants whose LazyLibrarian book is gone (issue #665)

Investigation record behind DESIGN-028's 2026-10-04 amendment. Everything below was read-only: `SELECT`s on the
CNPG primary (`postgres16-1`, database `haynesnetwork`, `default_transaction_read_only=on`) and a `mode=ro`
SQLite open of LazyLibrarian's `/config/lazylibrarian.db`, plus copies of its backups pulled out of the pod.

## Counts (2026-10-04 ~02:40Z)

Open wants = `ll_book_id IS NOT NULL AND unroutable_reason IS NULL AND comic_status IS NULL` and a format not
`landed`: 1,237. LazyLibrarian's `books` table: 1,020 rows (`getAllBooks` is that table joined to `authors`, so
it is complete apart from orphan rows). 901 open wants point at an id the table lacks:

| origin | absent | of which pushed and unsettled (what the fix acts on) |
|---|---|---|
| pairing | 747 | 745 (`wanted`/`grabbed` on a format) |
| goodreads | 51 | 49 |
| collection | 103 | 23 (`last_searched_at` set); the other 80 were never force-searched, so never handed to LL |

Of the 901: 11 ids are another row's `gb_id` (LazyLibrarian re-keyed the row to its file's embedded id); 57
pairing wants have exactly one LazyLibrarian row with the same normalized title and author (29 of them `Skipped`
for the wanted format, 28 `Open`); the rest have no row at all.

## Why: LazyLibrarian deletes the books

- Not a filter: `api.py::_getallbooks` is `SELECT … FROM books, authors WHERE books.AuthorID = authors.AuthorID`
  with no status or limit unless asked.
- Not never-added: 159 of the 216 pairing wants last found by the 2026-07-30 05:32Z pairing run have
  LazyLibrarian `wanted` (snatch history) rows under the very same id, most `Processed` in July. Only 46 of the
  901 ids were in the 2026-08-09 backup (`scheduled_Sun_Aug__9_12_18_58_2026.tgz`), 31 in 2026-09-08's.
- Deleted with their author: whole authors are missing. Orson Scott Card (39 absent wants), V.C. Andrews (27),
  John Grisham (23), Madeleine L'Engle (14), Martha Wells (11). Their author rows today were re-created on
  2026-09-22 or later and hold none of the old books.
- The mechanism, in the running image (`linuxserver/lazylibrarian:version-40a389ea`):
  - `dbupgrade.check_db` runs at every start. "Removing authors with no listed books" recounts each author with
    `TotalBooks = 0` through `importer.update_totals` and deletes those still at zero.
  - `update_totals` counts `books JOIN bookauthors`. `books.AuthorID REFERENCES authors ON DELETE CASCADE`.
  - `gb.py::add_bookid_to_db` (what `cmd=addBook` runs) creates the author (`Paused`) and upserts the book, but
    never inserts a `bookauthors` row (only `get_author_books` does). So an author LazyLibrarian knows only
    through app-added books counts zero and is deleted, with those books, at the next start.
  - Live: the 2026-10-03 19:47Z start logged `Removing 25 authors with no listed books`. Today 215 books have no
    `bookauthors` row; one author (John Grisham, `OL39329A`, added 2026-10-03 with The Firm `LorQP-vVUT0C`)
    counts zero and goes at the next restart unless LazyLibrarian is fixed first.
- July had node blips (haynes-ops #2302/#2303 on 2026-07-29/30), each LazyLibrarian restart a sweep. Pod logs
  and Loki do not reach back to July (Loki keeps about 60 days, the pod's log files 3).

## Cost: who kept calling LazyLibrarian for these

- format-pairing and goodreads-sync: nothing. Their mints push only `requested`; their reconciles `continue`d.
- The collection force-search cron: `permission_audit` `request_book_search` rows with `via: find_missing_cron`
  in the 7 days to 2026-10-04: 869, of which 276 on 16 absent ids (44 a day). Each was `addBook` (LazyLibrarian
  re-created the book and a new author, `Skipped/Skipped`), `queueBook`, `searchBook` (a real search: the LL log
  shows e.g. "NZB title search for AudioBook Mary-Jane Knight The Kane Chronicles: Survival Guide returned no
  results" twice a day, plus LazyLibrarian's own daily search of it while it existed). The next restart deleted
  the book again. LazyLibrarian's API calls are not logged with ids, so Loki cannot count these; the audit rows
  can.
- Side finding: `addBook` on a book LazyLibrarian holds re-runs `add_bookid_to_db`'s upsert, which resets BOTH
  formats to the new-book status (`Skipped`). The collection force-search, books Force Search and books Fix called
  it unconditionally. Fixed in the same change (DESIGN-028 amendment rule 6).

## The fix

haynesnetwork (this change): re-key or settle a gone want at each reconcile, no LazyLibrarian call; Search again
re-adds a gone book; `addBook` only for a book LazyLibrarian lacks. haynes-ops: a patched `gb.py` (write the
`bookauthors` row on `addBook`) and `dbupgrade.py` (never delete an author that still owns a book), mounted over
the image like `librarysync.py`.

Expected first runs after the deploy: format-pairing `llGoneRekeyed` about 28 (the match holds the format
`Open`) and `llGoneSettled` about 717 (including 29 whose match is `Skipped`: re-keying those would hand them to
the Skipped sweep's search, so they settle and wait for a person's Search again); goodreads-sync about 49 settled;
the collection cron about 23 settled (its grace is an hour since the last force-search). No
`searchBook`, `queueBook` or `addBook` from any of it.

## Result (deploy record)

- LazyLibrarian overlays live 2026-10-04 03:28Z (haynes-ops #3351). Start-up check: no author removed (it logged
  "Found 1 author with no existing or wanted books", a report-only line); `books` stayed at 1,020; John Grisham
  and The Firm kept.
- v0.105.4 live 03:52Z. First runs: `collection-force-search` 04:27Z `llGoneSettled 23, searched 0`;
  `format-pairing` 04:32Z `llGoneRekeyed 27, llGoneSettled 717, pushed 0, requeued 0`; goodreads-sync 04:41Z 48
  settled. Loki `ll_book_gone` lines: 27 + 717 + 23 + 48.
- v0.105.5 live 05:10Z. 05:32Z pairing run: `heldLanded 3, pushed 0, requeued 0, llGone 0`.
- Gone-and-unsettled: 745 + 49 + 23 = 817 before, 1 after. Pairing 745 = 27 re-keyed + 717 settled + Rework (its
  own format was already `missing`; only its stale held `grabbed` counted, landed by v0.105.5). Goodreads 49 = 48
  settled + the one left, a request whose shelf item was removed when the book moved to the read shelf (its live
  twin on the read shelf settled).
- Prowlarr `prowlarr_indexer_queries_total`, 10-minute increases from 04:30Z: 0, 0, 0, 995, 407, 0, 0. The
  04:50-05:10Z burst is LazyLibrarian's scheduled backlog search (`SEARCHALLBOOKS` 04:54-05:03Z, 226 items); LL's
  log has no `API-SEARCHBOOK` line and no "added to the books database" since the deploy.
- Two LazyLibrarian rows (`EJ_cCwAAQBAJ`, `UZyjuQAACAAJ`) keep their eBook `Wanted`. That is right: audiobook-anchored
  pairing wants for the same books want the eBook (their match to the Kavita copy failed on a messy file title).
