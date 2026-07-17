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
