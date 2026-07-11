# PLAN-033: Book/ebook/comic/audiobook requests + the wanted-not-on-disk view

- **Status:** PARKED (owner ruling 2026-07-11 eve): too large a project to take on now; when
  revisited, START by evaluating existing "Seerr-for-books" solutions rather than building
  in-app. The near-term content need is covered by PLAN-032 (lists → LL auto-grab) + PLAN-039
  (MAM cap governor). NOT dispatched.
- **Owner problem statement:** users have NO way to request books/ebooks (movies/TV have Seerr)
  and NO view of what is wanted-but-not-on-disk for the book layer — so members can't
  participate and the owner can't see the acquisition backlog in-app.
- **Relates:** PLAN-023 (books_items mirror — Kavita/ABS remain source of truth for ON-disk;
  wanted state lives in LL/Kapowarr), PLAN-031/032 (the pipeline requests feed), the *arr
  ledger's existing Wanted surface (`ledger.wanted` — movies/TV precedent to mirror), Bulletin
  action-grant pattern (post/moderate) as the RBAC precedent for request/approve.

## Shape (coordinator sketch, to pressure-test at scoping)

1. **Wanted view:** LL (books/audio) + Kapowarr (comics volumes/issues) hold wanted state →
   books-sync grows a wanted dimension (mirror-only, like ledger wanted; hard rule 4 extended
   pattern — no write-back for the VIEW). Library Books/Audiobooks/Comics tabs gain the same
   wanted affordance the *arr tabs have (gated by the existing `books` section permission).
2. **Requests:** in-app request flow ("I want this book") — search an external metadata source
   (OpenLibrary/Google Books/Hardcover; keys for Google Books already in 1P), submit → admin
   approves → the approval WRITES the want into LL/Kapowarr. That write-back is a NEW confined
   write surface (`@hnet/books/write`? — today the package is deliberately read-only, ADR-046)
   → needs its own ADR + the import-confinement guard treatment.
3. **Attribution + audit:** requests are first-class rows (requester, state machine
   requested→approved→grabbed→on-disk→denied), audited like everything else; "grabbed/on-disk"
   transitions detected by sync, closing the loop for the requester (Feed/notification hook).

## Open questions (owner)

- **Q-01:** who can request (Default? Family?) and who approves (admin-only, or a per-role
  action grant like Bulletin moderate)? Auto-approve for some roles?
- **Q-02:** request quota/throttle? (MAM's unsatisfied cap + ratio floor make unbounded member
  demand a real compliance risk — see `2026-07-11-mam-rules-scrape.md`.)
- **Q-03:** Seerr-for-books alternatives — adopt/deploy an existing requester app if a good one
  exists vs build in-app (in-app matches the roles/audit model; a survey step should confirm
  the landscape first)?
- **Q-04:** ebook vs audiobook vs both on one request; comics at issue- or volume-granularity?
- **Q-05:** where do requests surface — a Requests sub-tab under Library, the Bulletin Feed
  (attribution item is already in the Phase-3 bucket), or both?

## Out of scope until scoped

Everything — especially any `@hnet/books` write surface (ADR required first).
