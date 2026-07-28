# 2026-07-28 — PLAN-041 Part 2 recon: Fix-everywhere parity, actual remaining gaps

Owner picked PLAN-041 Part 2 as the next work item (ahead of new features, alongside the same-day
gate/MAM rulings). Full-tree recon at v0.91.0. Verdict: **the UX-vocabulary parity is DONE and
guard-enforced; what remains is TWO real gaps, and one listed residual turned out to be already
shipped.**

## What is already solid (do not rebuild)

- **One registry, one anatomy, guard-enforced:** `packages/ui/src/actions/action-registry.ts`
  (`MEDIA_ACTIONS`: fix/forceSearch/consume/retryImport/notOnDisk; Fix = green primary pill,
  Force Search = outline, scope is a `·` qualifier never a label fork) rendered via
  `MediaAction`/`MediaActionBar`/`MediaHero`/`ReservedActionSlot`; drift guard
  `apps/web/lint/action-anatomy-guard.mjs` + `apps/web/lib/__tests__/action-system-guard.test.ts`
  (repo-walk asserts zero live violations). PLAN-015 live feedback present on every
  action-bearing surface.
- **Coverage today:** movie item ✓✓ (Fix/Force) · TV episode+season ✓✓, show Force-only ·
  music album ✓✓, artist Force-only · ebook/audiobook/comic ✓✓ (grant-gated `fix_book`/
  `force_search_book`) · wanted-detail Force ✓ · activity-failure retryImport+Force ✓.
- **Show/artist whole-scope Fix is DELIBERATELY absent** (blocklist-too-broad;
  `FIX_TARGET_SCOPES` comment, `packages/db/src/schema/enums.ts:236`). Not a gap.

## Gap A — ytdl kinds (Peloton/YouTube/Music) have NO Fix and NO Force Search

`ytdlsub-item-detail.tsx` renders only a ConsumeLink; `packages/api/src/routers/ytdlsub.ts` is
read-only (no mutations). PLAN-041 marked this out-of-scope as "blocked on the *arr-style ytdl
service (PLAN-025 Q-01)". **That blocker is GONE: ytdrivarr is live** (X-Api-Key REST API,
OpenAPI, own release train, full-autonomy repo). Closing the gap = a ytdrivarr write surface for
re-driving a bad item (its Fix semantics need the ADR: re-download via the owning subscription),
a confined `@hnet/ytdrivarr` write client (import-confined to `packages/domain`, the
ADR-017/ADR-062 pattern), api mutations, and the registry-standard UI on the ytdlsub detail.
Spans two repos; ytdrivarr side is ours to build/merge (suite-repo autonomy).

## Gap B — RE-RULED same session: rate-limit parity, NOT permission gating

The recon's first framing (grant-gate arr Fix/Force-Search like books) was REJECTED by the owner:
*"Why would we gate Fix? … Last time we said everyone could fix but default role had a stricter
rate limit."* That is a RECOVERED LOST RULING — it appears NOWHERE in the repo (grepped
`.agents/` + `docs/` for stricter/per-role rate limits: empty) and was never implemented. The
standing model is: **everyone can Fix, rate limits do the governing.**

Current reality: flat `FIX_RATE_LIMIT_PER_HOUR = 25`/user/hr on the arr side (admins bypass —
D-09/R-47, also reused by `search-requests.ts`) and a flat books budget
(`BOOK_FIX_RATE_LIMIT_PER_HOUR` 25). NO per-role differentiation anywhere.

**Gap B as re-scoped:** per-role media-action RATE LIMITS — one budget mechanism unifying the
arr + books hourly Fix/Force-Search budgets, with the per-role limit admin-editable in
/admin → roles (the self-serve precedent: books grid, PLAN-040's DB-backed knobs). Seeded at
today's 25/hr for every existing role ⇒ zero behavior change on deploy; the owner then tightens
the Default role's number at will, no redeploy. No permission gating is added for the arrs; the
books grant grid stays exactly as shipped.

## The "Integrations-section grant" residual is ALREADY SHIPPED — closed

`SECTION_IDS` includes `integrations` (default `disabled`, ships Admin-only); `/integrations/*`
pages + every `integrationsProcedure` gate on `effectiveSectionLevel(role,'integrations')`; the
/admin roles grid has the Integrations toggle column writing `role_section_permissions` via the
audited `setSectionPermission`. Nothing to build — if members should see Goodreads, the owner
flips Integrations → Enabled per role in /admin. (No fine-grained per-action integrations grid
exists; none was ruled wanted.) Memory `books-fix-flip-pending` updated accordingly.

## Owner rulings (2026-07-28, this session — all landed)

- **Scope + sequencing: "Both, B then A."** Gap B (rate-limit parity) ships first as its own
  release, then Gap A (the ytdl leg); PLAN-041 closes when both are live.
- **Gap B posture:** the grant-gating framing was rejected; the recovered ruling above
  (everyone can Fix; per-role rate limits, Default stricter, admin-editable) is binding.
  Docs-first next: the ADR for per-role media-action budgets, then the vertical.
