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

## Gap B — gating parity: arr Fix/Force-Search are UNGATED

`packages/api/src/routers/fix.ts` `create`/`forceSearch` are plain `authedProcedure` — ANY
authenticated user can Fix/Force-search movies/TV/music. Books and Activity actions are per-role
grant-gated. The 07-17 audit's §4.3 (shared `canFix`/`canForceSearch`) was never implemented;
only the vocabulary was unified. Parity = an arr action-grant (registry-style enum +
`role_*_action_grants` + the /admin grid column, mirroring `BOOK_ACTION_NAMES` /
`apps/web/lib/books-actions.ts`), UI deriving `canFix`/`canForceSearch` server-side like
`books.ts:1163`. **Owner ruling captured below on the default posture.**

## The "Integrations-section grant" residual is ALREADY SHIPPED — closed

`SECTION_IDS` includes `integrations` (default `disabled`, ships Admin-only); `/integrations/*`
pages + every `integrationsProcedure` gate on `effectiveSectionLevel(role,'integrations')`; the
/admin roles grid has the Integrations toggle column writing `role_section_permissions` via the
audited `setSectionPermission`. Nothing to build — if members should see Goodreads, the owner
flips Integrations → Enabled per role in /admin. (No fine-grained per-action integrations grid
exists; none was ruled wanted.) Memory `books-fix-flip-pending` updated accordingly.

## Owner rulings (2026-07-28, this session)

- **Sequencing:** Gap B first (small, in-repo), then Gap A (the ytdl leg) — pending the owner's
  confirmation captured in the session; PLAN-041 status carries the outcome.
- **Gap B default posture:** RULING PENDING at the time of writing — grandfather-open (seed
  grants for existing roles, preserving today's behavior) vs ship-locked (books precedent).
  Record the answer in PLAN-041 before authoring the ADR.
