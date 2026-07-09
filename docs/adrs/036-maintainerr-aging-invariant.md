# ADR-036: Maintainerr aging-invariant safeguard (rule pools never self-delete)

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Tom Haynes

## Context and problem statement

The Trash section treats **Maintainerr** as the deletion system of record, but routes every actual
deletion through *this app's* pipeline: the batch/save/guardian flow (ADR-025 / DESIGN-011) and the
per-item `expediteDeletion` guardian (ADR-023 / DESIGN-010 D-05). Both re-run the preflight
`auditMaintainerr` SAFE gate before any destructive call.

**Incident (2026-07-09).** A live audit found the two production Maintainerr **rule collections** —
`hnet — unwatched low-value movies` (~741 items / ~16 TB) and `hnet — unwatched low-value TV`
(~13 items) — carrying `deleteAfterDays: 60` with `arrAction: 0` (DELETE). Maintainerr's **own**
aging worker (`collection-worker.service.ts`, v3.17.0) deletes any collection member whose
`addDate <= now − deleteAfterDays·86_400_000`, skipping **only** collections whose
`arrAction === ServarrAction.DO_NOTHING (4)`. There is **no** null/0 guard — a null/0 horizon deletes
*immediately*. That worker path **bypasses this app entirely**: no batch, no Leaving-Soon window, no
cross-server watch guardian, no ledger attribution. Left alone, Maintainerr would have mass-deleted the
movie pool ~Sep 5–7, 2026. The immediate ops fix raised both pools to `deleteAfterDays: 9999` (dangerDate
~27 years in the past ⇒ zero eligible items), preserving `arrAction: 0` so the app's per-item
`/collections/media/handle` still works.

The gap: nothing in the app *noticed* that Maintainerr was armed to delete out-of-band. The SAFE gate
only checked reachability + integration health, not the collections' own aging configuration.

## Decision drivers

- **The *arrs are the source of truth; deletions ride the app's rails** (CLAUDE.md hard rule 4). A
  Maintainerr-internal auto-delete violates that invariant silently.
- Defense-in-depth: the ops fix defused *today's* pools, but drift (a future rule created/edited in
  Maintainerr's own UI) must be caught, not re-discovered by hand.
- The signal is cheap: `auditMaintainerr` already reads `GET /api/collections` on every wall paint and
  before every destructive action.

## Considered options

- **A. Do nothing beyond the ops fix.** Rejected — leaves the same silent-drift hole open.
- **B. A separate cron/alert that emails on short horizons.** Rejected — out-of-band, doesn't *block*
  the destructive paths, adds a new moving part.
- **C. Fold an aging invariant into the existing SAFE gate (chosen).** The audit that already gates
  expedite + sweep additionally asserts the pools are configured so Maintainerr's own worker can never
  fire, and surfaces a specific human reason when they aren't.

## Decision outcome

Chosen option: **C** — `auditMaintainerr` evaluates two invariants over every **active** collection and
folds any breach into `safe` (so the existing unsafe-gating in `expediteDeletion` and
`sweepExpiredBatches` blocks destructive actions unchanged):

1. **Rule pool** (an active collection that is not one of our Leaving-Soon manual collections):
   `deleteAfterDays >= AGING_HORIZON_MIN_DAYS (3650)` **AND** `arrAction === 0`. The horizon keeps
   Maintainerr's dangerDate far enough in the past that no real item qualifies; `arrAction === 0`
   keeps the app's own per-item delete working.
2. **App-managed Leaving-Soon manual collection** (matched by title, ADR-025): `arrAction === 4`
   (DO_NOTHING) so Maintainerr never deletes its curated members out from under the batch pipeline.

A violation yields a human-readable reason rendered in the Trash **safety banner** (e.g.
`Maintainerr would self-delete the '<pool>' pool in N days — raise its delete-after horizon`). A
collections read failure fails **closed** (blocks, since we cannot prove the pools are defused).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: Maintainerr can never mass-delete a pool outside the app's batch/guardian pipeline without the app noticing and blocking every destructive action first. |
| C-02 | Good: the reason is specific and actionable (names the pool + the fix), not a generic "unsafe". |
| C-03 | Good: zero new moving parts — reuses the existing `GET /collections` read and the existing SAFE gate. |
| C-04 | Neutral: raising a rule pool's horizon to defuse auto-delete relies on the app remaining the delete driver (`arrAction: 0` + `/collections/media/handle`); the invariant enforces exactly that pairing. |
| C-05 | Bad: a transient `GET /collections` failure now fails closed (blocks destructive actions) where it previously did not — an acceptable fail-safe, re-tried on the next audit. |

## More information

- Incident + before/after evidence: DESIGN-010 errata (2026-07-09).
- Maintainerr v3.17.0 source verified: `collection-worker.service.ts` (dangerDate math; DO_NOTHING is
  the only skip; no null/0 guard) and `rules.service.ts` `updateRules` (`deleteAfterDays` is nested
  under `collection`; the crucial-change wipe compares only dataType/manualCollection/
  manualCollectionName/libraryId — raising the horizon alone never wipes).
- Governs ADR-023 (Trash safety gate); relates to ADR-025 (Leaving-Soon manual collections,
  `arrAction = DO_NOTHING`). PRD-001 R-79..R-87.
