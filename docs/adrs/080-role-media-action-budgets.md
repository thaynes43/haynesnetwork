# ADR-080: Per-role media-action rate budgets — everyone can Fix, limits govern

- **Status:** Accepted (owner rulings in-session 2026-07-28; authored under granted
  self-accept authority)
- **Date:** 2026-07-28
- **Deciders:** Tom Haynes (owner, verbal rulings 2026-07-28) · authored by the coordinator

## Context and problem statement

PLAN-041 Part 2 (Fix-everywhere parity) recon found the last non-ytdl inconsistency in the
media-action system: **how Fix / Force Search are governed differs by media family.**

- ***arr kinds** (movies/TV/music): open to every signed-in user, governed by a FLAT hourly
  budget — `FIX_RATE_LIMIT_PER_HOUR = 25` per user, Fix + Force Search drawing ONE shared
  counter (DESIGN-005 D-17), admins bypass (D-09, R-47).
- **Books kinds** (ebook/audiobook/comic): governed by per-role GRANTS
  (`fix_book`/`force_search_book`, ADR-071's grid) — plus a flat books Fix budget
  (`BOOK_FIX_RATE_LIMIT_PER_HOUR`, env-tunable, default 25). Books **Force Search draws no
  hourly budget at all** — grant-gated only.

The first Part-2 framing proposed unifying by grant-gating the arrs. The owner REJECTED it and
in doing so recovered a ruling that had never been captured in the repo (confirmed absent by
grep — one of the worktree-lost decisions): **"everyone can Fix; the Default role just gets a
stricter rate limit."** Permissions are the wrong instrument for Fix — it is a repair verb, not
a privilege; abuse is a volume problem, and volume is what budgets govern.

So the problem: unify governance across every media family on the owner's model — open access,
role-differentiated budgets — without changing behavior on deploy and without a redeploy every
time the owner tunes a number.

## Decision drivers

- **The recovered owner ruling is binding:** no permission gating on arr Fix/Force-Search;
  per-role rate limits with a stricter Default are the governing instrument.
- **Zero-change deploy:** live behavior today (25/hr everywhere, admins bypass) must be exactly
  the day-one behavior; tightening is an owner act, not a release act.
- **Self-serve tuning** (the books-grid / PLAN-040 precedent): the owner tunes numbers in
  /admin, audited, no redeploy.
- Hard rule 6: role/permission mutations write audit rows in the same transaction.
- Gap A (the ytdl Fix leg, next release) needs a governance mechanism to plug into; whatever
  ships here becomes its contract.

## Considered options

1. **Grant-gate the arrs like books** — rejected by the owner (see above).
2. **Keep flat limits, tune via env** — no per-role differentiation (the actual requirement),
   and every tune is a redeploy.
3. **Per-role DB-backed budgets, admin-edited, code-default fallback** — chosen.

## Decision outcome

Chosen option: **per-role media-action budgets** — a single mechanism every media family (and
the coming ytdl leg) draws.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **No permission gating is added to arr Fix/Force-Search — ever, per the recovered ruling.** Everyone-can-fix is contractual. The books grant grid (ADR-071) stays exactly as shipped — it is the books-specific restriction lever the owner already uses; this ADR does not touch it. |
| C-02 | New table `role_media_action_budgets` (`role_id` PK/FK → roles, `fix_per_hour` int NOT NULL, CHECK `0 <= fix_per_hour <= 1000`), migration 0073. Guard-listed in `no-direct-state-writes`; written ONLY by a single-writer domain helper that records a `permission_audit` row (`update_media_action_budget`, before/after) in the same transaction. |
| C-03 | **Effective-limit resolution, in order:** admin ⇒ bypass (D-09 unchanged) → the role's row → fallback **25** (today's constant). No seed rows: absence IS today's behavior, so deploy is zero-change. The `BOOK_FIX_RATE_LIMIT_PER_HOUR` env override is RETIRED from the read path (the DB value supersedes; a stale env var must not shadow an owner edit). |
| C-04 | The role's ONE number applies **independently to each existing pool**: the arr pool (Fix + Force Search shared — D-17 unchanged) and the books pool (book Fix — and books **Force Search now also draws it**, closing its unbudgeted hole). Pools stay separate; a books binge cannot starve a movie Fix. |
| C-05 | Admin surface: a numeric budget control per role on /admin → roles (beside Books actions), Admin's own row shown as implicit bypass. Setting **0 blocks that role's non-admin media actions entirely** — the documented emergency lever (the UI must say so, not hide it). Reflow-safe per hard rule 9. |
| C-06 | The ytdl Fix/Force-Search leg (PLAN-041 Gap A, next release) MUST draw this same mechanism — either the arr pool or a third pool, decided in its design, never a new bespoke limiter. |
| C-07 | Bad: rate-limit errors become role-dependent — the "limit reached" copy must state the ROLE's number, not a constant (owner copy rules apply). Tests pinning `FIX_RATE_LIMIT_PER_HOUR` as a constant get rewritten against the resolver. |

## More information

- Owner rulings + recon: `.agents/context/2026-07-28-fix-parity-recon.md` (the re-ruling section
  is the record of the recovered ruling); plan of record `.agents/plans/041-library-fix-books-and-parity.md`.
- Governs: `packages/domain/src/fix-requests.ts` (D-09/D-17 budget), `search-requests.ts`
  (shared counter), `book-fix.ts` (books budget), `packages/api/src/routers/books.ts`
  `forceSearch` (gains the books pool draw).
- Related: ADR-062 (books-Fix boundary), ADR-071 (unified media-action system + books grid),
  DESIGN-005 D-16/D-17 (the shared budget), DESIGN-033 (books Fix). Amend DESIGN-005 + DESIGN-033
  and the PRD/glossary (next-free R-/T- at authoring) in the implementing change.
