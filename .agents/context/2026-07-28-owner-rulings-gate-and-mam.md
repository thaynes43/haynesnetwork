# 2026-07-28 — Owner rulings: library-access solidification + MAM "harden first, then retune"

The owner ruled on both items in HANDOFF's "TWO OPEN OWNER ITEMS" block this session. Framing
he gave first, binding for sequencing: **these are tech debt, and everything gets solid BEFORE
new feature work is added on top.** (He also has one feature item in mind, not yet named at the
time of writing — do not start it ahead of this work.)

## Ruling 1 — the library-access gate (two explicit decisions)

Context he was given (verified in code, `packages/domain/src/library-access.ts`): production is
fine today — the Default role sees everything only because it HOLDS the grants he configured, and
the plex-match sync populated long ago. The actual sharp edges: (a) "Default sees everything" is
configuration, not a code guarantee — any role with zero grant rows resolves to EMPTY; (b) on a
fresh database, before the FIRST `sync-plex-matches` run, `resolveLibraryAccessGate` derives zero
visible kinds, so non-admins see no Library tabs even WITH grants (the ADR-047 deny-by-default
cold start — safe direction, bad UX).

**Decision 1a — seed at bootstrap.** The seeded Default role is created HOLDING all-servers
library grants (`role_plex_server_all_grants`), making "a fresh deploy's users see everything"
a code guarantee instead of configuration. Admins can still restrict the Default role later
exactly as today. **New non-default roles still start empty — deny-by-default stands.**

**Decision 1b — auto-sync + honest UX.** On startup with an empty `media_plex_matches` table the
app triggers a plex-match sync itself, and for the minutes that window still exists, non-admin
Library surfaces show an explicit "libraries are still syncing" state (plus an admin banner)
instead of a silently empty wall.

Docs-first scope: this amends the ADR-024 bootstrap posture and the ADR-047 cold-start note —
a new ADR (bootstrap grant seeding + the cold-start contract) + DESIGN coverage for the syncing
empty state, then the vertical. Assign next-free numbers at authoring (065+ for plans; re-grep
ADR/DESIGN ceilings first, per the reconciliation rule).

## Ruling 2 — MAM gate: "Harden first, then retune"

Chosen over both "hold at 100 indefinitely" and "raise the edge now". Binding order:

1. **Build the trend-aware gate** — a rising unsatisfied count overrides the dead band. This is
   the exact hazard the 07-25 incident flagged (hysteresis held the gate open through a climb:
   166 inside 160..179 while rising). Behavior change to ADR-077's contract ⇒ superseding/
   amending ADR at authoring.
2. **Activate PLAN-040** (placeholder since 07-11): `MAM_UNSATISFIED_LIMIT`/buffer/floor move to
   an audited DB-backed admin setting + in-app governor-state visibility. Natural home for the
   trend knob too — decide at plan authoring whether trend-gating rides PLAN-040 or its own plan.
3. **Only after that safety layer exists:** revisit raising the pause edge above 100. Any retune
   stays evidence-gated — measured bursts only (the burst grew 17 → 58 → +84 every time it was
   measured; never retune on a quiet window).

## Board effect

- The two "open owner items" are CLOSED as rulings and reopen as build work, queued ahead of any
  new feature. The two workstreams (gate solidification, MAM hardening) are independent.
- Enumerated backlog otherwise unchanged this session (PLAN-040/041-part-2/043/058/059/011-MFA,
  ytdrivarr residuals, smaller items) — see the session transcript enumeration; no new plans were
  authored yet.
