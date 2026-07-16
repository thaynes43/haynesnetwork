# PLAN-050: Book ⇄ audiobook format pairing (Integration Saga pt 5)

- **Status:** BUILT (2026-07-16 — docs + code + tests on `feat/plan-050-format-pairing`, awaiting
  coordinator review/PR; owner green-lit 2026-07-16 morning; runs PARALLEL to PLAN-037 — separate
  branches, releases serialize).
- **Docs:** ADR-065 (Accepted) · DESIGN-036 · PRD R-211..R-213 · glossary T-183..T-185.
- **Shipped shape:** migration 0054 (`books_format_pairs` + the `book_requests` system-want widening
  + `format-pairing` run kind); domain `matchFormatPairs`/`syncFormatPairs`/`mintPairingWants`/
  `runFormatPairing` (cap `PAIRING_MINT_CAP_PER_RUN`=25, env-tunable); the `format-pairing` sync
  mode (runs AFTER books-sync); wanted reads widened for `origin='pairing'` ("Format pairing"
  attribution); books-gated audited `books.searchPairingWant`; detail dual consume buttons +
  missing-format affordance + wall coverage badge.
- **Follow-ups:** haynes-ops CronJob block for `--mode=format-pairing` (after the books-sync tick) —
  a deploy-repo change, out of this branch; DESIGN-036 Q-01 (unmintable digest?) and Q-02
  (identifier-backed matching) stay open.
- **Saga:** PLAN-043 phase "Book ⇄ audiobook pairing (pt 5)". Owner's original spec (near-verbatim,
  saga file): "attempt a copy of EACH format per title; the one we lack is a Missing entry.
  Library items with both show 'Listen on Audiobookshelf' AND 'Read in Kavita'; otherwise one
  active button plus 'Search for …' on the missing format."
- **Owner rulings (2026-07-16):**
  - **R1 — AUTO-MINT ESTATE-WIDE.** Every library title holding one format auto-mints a Missing
    want for the absent format (not on-demand-only, not Goodreads-shelved-only).
  - **R1a (engineering commitment made alongside the ruling):** the backfill is PACED — a
    per-run cap on new mints so LazyLibrarian/SAB digest the ~1000-title backlog over days;
    MAM stays entirely behind the PLAN-039 governor; comics are out of scope (no
    Kavita-comic ⇄ audio pairing).
- **Depends on:** nothing new (PLAN-044/045 request machinery, ADR-046 books_items). Docs:
  ADR-065 + DESIGN-036 + PRD R-2NN + glossary terms, authored docs-first in this branch.

## Shape (firming up from the exploration fact sheet)

1. Pairing model over `books_items`: match Kavita (book) rows ⇄ ABS (audiobook) rows by the
   goodreads-sync normalization idiom (title/author), persisted so the UI and the mint pass
   share one truth.
2. Auto-mint pass (paced, capped per run) minting missing-format wants through the EXISTING
   confined LL chain (addBook → queueBook → searchBook), system-originated (no user shelf item).
3. `/library/books/[id]`: paired titles render BOTH consume buttons; unpaired render the active
   button + the missing format's Missing/search affordance. Wall badge for format coverage.
4. Missing entries surface in the composed Library-Wanted view like any other want; per-format
   Force Search works on them unchanged.

## Open questions

- Q-01: pairing precision — normalized title/author collisions (editions, subtitle variants);
  fact sheet to establish available external ids per source. Mitigation lean: conservative
  matcher + an UNPAIRED-honest state (never a wrong pairing).
- Q-02: system-originated want attribution — schema seam to confirm from exploration.
