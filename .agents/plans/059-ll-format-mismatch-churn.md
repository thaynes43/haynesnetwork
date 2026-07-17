# PLAN-059 — LazyLibrarian format-mismatch re-grab churn (intake)

- **Status:** Intake (filed 2026-07-17, found during the owner-directed SAB acquisition sweep)
- **Owner ruling needed:** none to investigate; fixes may need rulings once designed

## The defect (observed live, 2026-07-17 ~02:45 UTC)

LL grabs **audiobook** usenet releases against **eBook** wants, fails the ebook import, reverts
the want to `Wanted`, and re-grabs the same release — a churn loop that wastes SAB bandwidth and
never satisfies the want:

- *Rework* and *Feeling Good* (ebook wants): each completed in SAB **4+ times in one day**
  (narrator names "Mike Chamberlain" / "George Newbern" visible in the grabbed filenames — they
  are audiobook rips); both ended the observation window back at `Wanted`, `snatched=[]`.
- The same pattern in SAB history without the loop closing: *Hornet Flight* (NMR 64kbps
  audiobook completed; ebook want untouched), *Heir of Fire* and *Lord of Shadows* (retail
  audiobooks completed; AudioStatus still Wanted — import gap rather than mismatch),
  *Brimstone* (completed; ebook want untouched).

Two distinct failure classes to separate during investigation:

1. **Format mismatch at grab time** — an eBook search accepting an audiobook release (provider
   category mapping / search-type filtering in LL's usenet providers).
2. **Completed-but-not-imported** — SAB finishes, LL post-processing never imports (the
   PLAN-044-era `sab_cat=lazylibrarian` import contract of OPS-013 §11 may have a sibling gap
   for some release layouts; compare The Other Emily multi-part "Chapterized" incident).

## First moves

- Reproduce with LL debug logs on one churned title (Rework): what did the eBook `searchBook`
  match, and why did the import fail?
- Audit the LL usenet provider config: are book vs audiobook categories separated per provider
  (the Prowlarr-fullSync ownership rule from OPS-013 §5 applies — fix at the Prowlarr app level
  or it gets overwritten).
- Consider a `forceProcess` pass for the completed-but-unimported class.
- Blocklist/history: whether LL records the failed grab so it stops re-snatching the same NZB.

## Success criteria

A format want only snatches releases of its own format; a completed SAB download either imports
or is rejected WITH a recorded reason that prevents an identical re-grab; the four named titles
resolve (land or honestly park).

## Addendum — 2026-07-17 ~07:30 UTC: the GB/LL RESOLUTION gap (distinct from the format churn)

Surfaced while completing the owner's two queued fixes and seeding acquisition. Two separate
resolution failures, both rooted in how books resolve to a LazyLibrarian `BookID` (a Google
Books volume id) on the deployed LL build (`40a389ea`, `BOOK_API=GoogleBooks`):

1. **[SHIPPED same-day — the fix-resolve hardening PR: item author passed to both resolve sites, pre-colon fallback, author guard, series-index prefix strip. The Whispers wrong-book incident below made it urgent.] book-fix resolve miss on subtitle-laden titles.** The owner's "Dead Ever After: A Sookie
   Stackhouse Novel" fix landed `failed` with "Could not resolve this book against Google
   Books" — a genuine GB no-match, NOT quota (Whispers, fired the same second, resolved fine
   and completed). The v0.68.1 `gbQueryTitle` de-noiser strips trailing Goodreads
   PARENTHETICALS, not colon subtitles — and broadly stripping colon subtitles is UNSAFE (many
   are meaningful, esp. non-fiction). Safe fix: a FALLBACK — on a full-title no-match, retry the
   GB resolve with the pre-colon title (additive, only fires on miss). Owner impact: he has a
   green fix (Whispers) to test THE FLIP with; Dead Ever After needs this fallback or a manual
   re-fire under a cleaner title.

2. **Libretto M3 acquisition resolves ~nothing against this LL.** The acquisition leg is
   mechanically correct (paced, idempotent, honest skips) but produced 0 LL wants across the
   seeded NYT + franchise recipes because Libretto has NO Google Books key (statelessness — by
   design) and depends on LL's own `addBookByISBN`, which returned "No results for <isbn>" for
   every NEW NYT bestseller (valid 2024-25 ISBN13s GB hasn't cleanly indexed) AND `findBook`
   returns [] on this build (title path dead). Net: new books fail by ISBN (GB index gap),
   older/franchise books fail by no-ISBN + dead findBook. This is a LIBRETTO/LL follow-up, not
   a flag flip. Candidate directions (owner ruling): (a) an hnet-side resolve broker — the app
   HAS the estate GB key and resolves ISBN→volume-id reliably (Whispers proved it); Libretto
   could hand LL a resolved volume id via an hnet endpoint (weakens Libretto's independence but
   closes the gap); (b) enrich the Hardcover builder to emit edition ISBNs GB DOES index; (c)
   accept that acquisition only flows for GB-indexed titles and let the daily retry catch new
   books as GB indexes them. Acquisition is left ENABLED on the seeded recipes (manual-apply,
   harmless, capped) so it flows the moment the resolution path is fixed.


### The Whispers wrong-book incident (2026-07-17 ~13:15 UTC — found during the owner's pre-FLIP test)

The owner's "Whispers" audiobook fix (item author **Dean Koontz**) resolved and queued **"Whispers
of the Dead" by Simon Beckett** into LL. Root cause: BOTH book-fix resolve sites called
`guardedGbResolve` with `author: null` (title-only `intitle:Whispers`), and the v0.68.1 title
guard passes subtitle-extended titles by design. Hardening shipped same-day: (1) both resolve
sites now read the item's author at execute time (no schema change) and pass `inauthor`; (2) a
surname-token author guard rejects a resolved volume whose authors are disjoint from the item's;
(3) `gbQueryTitle` strips leading series-index prefixes ("02 - Grave Surprise"); (4) the
pre-colon fallback (item 1 above). Cleanup: the wrong LL want was left `Skipped` (inert; LL has
no removeBook), the fix row annotated + failed so the owner can re-fire post-deploy.
