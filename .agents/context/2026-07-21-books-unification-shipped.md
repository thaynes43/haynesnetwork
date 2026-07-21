# 2026-07-21 — Books format unification: SHIPPED (both streams)

Continuation of `2026-07-20-books-unification-rulings.md` (same remote-control session). Both
PLAN-060 streams landed within hours of the rulings. The Stream A Opus agent died mid-build on
the account session limit ("resets 1:20am ET"); the owner said continue now, so the coordinator
finished Stream A inline (test-contract updates, full battery, dev:local drive, PR).

## What landed (all merged)

| Repo | PR | Content |
|---|---|---|
| haynesnetwork | #460 | Docs: ADR-075/076 Accepted, PRD R-231..R-233 + ~14 amendments, glossary T-225..T-227, 7 designs amended, PLAN-060, rulings note |
| haynesnetwork | #464 | Stream A: unified Books wall (work-grain `books.search` + pair collapse + Format seg + data-gated facet union + File relabel + `durations` axis), pairing wants folded into the anchor card, collection cards merged by `libretto_recipe_id`, comic-partition wall mapping, merged manager Books tab (legacy `audiobooks` alias), `?tab=audiobooks` redirect, migration 0071 (audiobooks pref rows dropped) |
| haynesnetwork | #465 | release 0.89.0 (auto-merge queued at wrap — verify it landed) |
| libretto | #13 | Stream B: `targets[]` multi-target recipes (back-compat `targetLibrary` normalize), recipe `category` → marker `\|cat=` emission (D-12 L1 live), per-target `missing[]` + target-tagged read-back, `{title, author}` static entries (flagged conservative fallback), 21 author example recipes in `examples/authors/`, 268 tests (+44) |
| haynes-ops | #2197 | Libretto helmrelease bump → `sha-eaa868a` (flux deploys) |

## Verification evidence

- Stream A: full battery green locally AND in CI (lint / lint:css / typecheck / test — 525/525
  api, 378/378 web — / build). 21 pre-unification test expectations updated to the new contracts.
- dev:local driven end to end: tab row **… YouTube · Books · Comics · Activity · My Fixes** (no
  Audiobooks); Books defaults grouped-by-Author; flat wall interleaves both formats as work cards
  with coverage badges + per-format metrics; Format seg filters (Audiobook → 4 audio works only);
  `?tab=audiobooks` canonicalizes to `?tab=books&format=audiobook` with the seg preselected;
  Comics wall has no Format seg; 390px + desktop clean (no overflow, reserved widths).
- Stream B: CI green (checks + docker); temp-config smoke reconciles a two-target recipe into
  stubbed Kavita+ABS with the shared `[libretto:<id>|cat=<Category>]` marker on both.

## Staged next steps (in order)

1. **Verify the deploys**: flux rolled libretto to `sha-eaa868a`; hnet 0.89.0 (#465) → image →
   staging per `docs/ops/004`. Then the owner's 390px + desktop review of the live wall.
2. **Twin conversion** against the DEPLOYED Libretto: collapse the 5 audiobook twin recipes into
   two-target recipes — the KAVITA recipe id survives (mirror `libretto_recipe_id` joins stay
   stable), the orphaned ABS twin deleted via `?deleteCollection=true` (ADR-076 C-08).
3. **Author recipes**: apply the 21 `examples/authors/` recipes with the estate's real library
   ids (`category: Authors`, both targets, `acquisitionEnabled: true` — wants pace through the
   25/run cap + MAM governor + GB budget). Needs the Libretto API path (LIBRETTO_API_KEY or the
   hnet manager UI) — same route the 2026-07-20 batch of 25 recipes used.
4. **Follow-ups**: stub-harness fixtures for a PAIRED duo + a twin-recipe pair (unblocks the
   DESIGN-038 Q-01 e2e journey spec — the collapse/merge are api-test-covered today);
   DESIGN-036 Q-02 identifier-backed matching now also improves the card collapse, not just
   badges (the known upgrade path).

## DEPLOYED (added later the same day — the owner flagged the wall was not live)

The wrap above stopped one step short: OPS-004's **one manual step** (the haynes-ops
haynesnetwork tag bump — no Flux image automation) had not been done, so staging still ran
v0.88.6. Completed on the owner's flag: artifact-pair gate passed for v0.89.0 (manifest +
cosign sig both 200 — the sig 404 was the documented Accept-header gotcha), **haynes-ops
#2200** merged (v0.88.6 → v0.89.0), flux reconciled, rollout clean, `Migrations applied.`
(0071 included), `/api/health` ok. Running images verified in-cluster:
`haynesnetwork:v0.89.0` (frontend) and `libretto:sha-eaa868a` (media). Staged steps 2–3
(twin conversion + author recipes) remain next; step 1 (deploy verify) is DONE.

## Gotchas recorded

- The pod's `GH_TOKEN` env var goes stale (sidecar refreshes `/creds/gh_token` every 40 min) —
  prefix gh calls with `GH_TOKEN=$(cat /creds/gh_token)`; for git pushes from fresh worktrees use
  the `http.extraheader` basic-auth form with the same file.
- The Opus session limit killed the Stream A agent mid-build with work uncommitted in its
  worktree (`~/work/unified-books-wall`) — recoverable because worktree state survives; the
  continuation picked up from "typecheck green, tests unrun".
