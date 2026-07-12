# PLAN-033: Book/ebook/comic/audiobook requests + the wanted-not-on-disk view

- **Status:** **SURVEY DISPATCHED (owner authorized 2026-07-11 late-eve).** The owner restated
  the need: "I'm really looking for a Seerr type app where you request these things" — so the
  parked plan's first step (evaluate existing solutions) runs NOW as a research pass: existing
  request apps for books/audiobooks/comics, including **LazyLibrarian's own built-in
  user-accounts/request feature**, judged on LL/Kapowarr integration, OIDC/Authentik fit, and
  the estate's roles/audit posture. Adopt-vs-build follows the survey, likely decided inside
  the **Books Automation Saga** (see PLAN-032 — the owner leans to a separate books-automation
  application; a requests surface may belong to it). Confirmed: Kavita "Want To Read" is
  library-only (cannot request net-new titles) — not a requests substitute. The build itself
  stays NOT dispatched.
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

## Survey outcome (2026-07-12)

Full survey with per-candidate evaluations, comparison matrix, and citations:
`.agents/context/2026-07-12-seerr-for-books-survey.md` (web research + read-only LL pod recon;
no config changed, no grab, no MAM contact).

**Verdict: adopt NOTHING as the production requester — BUILD the request flow into the Books
Automation Saga (in-app), reusing the LL API seam. Keep Libreseerr as a UX reference only.**

- **The "Seerr for books" landscape is real but thin, and NONE covers comics.** Purpose-built
  candidates are **Libreseerr**, **Shelfarr**, **AudioBookRequest**, **SeerrNG** — all
  ebook/audiobook only. Mainline **Ombi / Seerr (Jellyseerr+Overseerr, merged Feb'26; Overseerr
  archived) have no book support** in 2026 (books aren't even in Seerr's music-style preview).
- **Only Libreseerr fronts OUR exact LazyLibrarian** as a pure request-broker (no deletes/imports,
  marks wanted → inherits usenet-first + the PLAN-039 governor for free). But it stores identity/
  roles/requests in **flat JSON outside** haynesnetwork's Postgres audit model (against hard rule 6),
  has **no approval gate**, and is young/solo (~58★). Marginal — best as a UX reference, not adopted.
- **Shelfarr (most polished, OIDC-Authentik, /api/v1) and AudioBookRequest (healthiest community)
  are OUT for coexistence:** they *are* book *arrs (own Prowlarr + download clients + imports + MAM
  wiring), so adopting one runs a **second acquisition pipeline the MAM governor cannot see or
  throttle** — the biggest compliance risk in the books program (breaks hard rule 4 + OPS-013 §6).
  SeerrNG needs a Bookshelf/Readarr backend we don't run (same collision) and is a 6★ fork.
- **LazyLibrarian ALREADY has native multi-user** (`users` table + per-media permission bitmask;
  friend role = search + mark-Wanted) and **Authentik-frontable trusted-header proxy auth**
  (`PROXY_AUTH`/`X-WEBAUTH-USER`/`PROXY_REGISTER`) — but its "request" is thin: the low-priv
  *Request to Download* button just **emails the admin** (no queue/state/audit), and the only real
  want-write is giving a user `perm_status` to mark **Wanted with no approval**. Usable as a
  **zero-build stopgap** behind Authentik forward-auth, not the product the owner pictured.

**What the saga should do with this (answers to Q-03, informs Q-01/Q-02/Q-04):**

1. **Ship the wanted-not-on-disk VIEW first** — it is a **LL+Kapowarr read, decoupled from any
   requester** (mirror-only, hard rule 4 extended; reuses PLAN-023 read-only LL access). Cheap,
   high-value, no adopt decision. (Q2 answer: the backlog is readable via LL's API/DB, not via
   any requester — Libreseerr has no external API and just writes wanted into LL anyway.)
2. **Build the request FLOW in-app**, layered on **PLAN-032 Track-2's LL-write machinery**
   (`addbookbyisbn`/mark-wanted) + the metadata search PLAN-032 already scoped (Google Books key
   in 1P) — so it's a **small addition, not a new pipeline**. Only an in-app build satisfies all
   four estate constraints at once: Authentik **OIDC** (hard rule 5), Postgres **roles + in-tx
   audit** (hard rule 6, Bulletin action-grant precedent for request/approve), a real
   requested→approved→grabbed→on-disk→denied **state machine + attribution**, and a
   **governor-aware request quota** (Q-02 is a live compliance need). New confined write surface
   `@hnet/books/write` (own ADR).
3. **Comics (Q-04): nothing to adopt, build-only later.** No comic requester exists; Kapowarr has
   no request front-end (the archived Overseerr Kapowarr request never shipped). An in-app request
   that writes to Kapowarr's API is a later saga increment; near-term comics stay on Kapowarr
   volume-completion + manual (per PLAN-032).
