# ADR-081: Library-access bootstrap seeding + the cold-start contract

- **Status:** Accepted (owner rulings in-session 2026-07-28; authored under granted
  self-accept authority)
- **Date:** 2026-07-28
- **Deciders:** Tom Haynes (owner, rulings via the in-session question pass) · authored by the
  coordinator

## Context and problem statement

The owner's requirement is simple: **the Default role can see everything.** Today that is true
on the live site only because the owner configured grants that way — it is configuration, not a
code guarantee. Two sharp edges follow (HANDOFF "TWO OPEN OWNER ITEMS" #1, ruled this session):

1. **A role with zero grant rows resolves to EMPTY** (ADR-024 deny-by-default). Correct for
   admin-created roles, but on a from-scratch deploy the seeded Default role would start blind.
2. **The cold-start window:** before the FIRST `sync-plex-matches` run ever populates
   `media_plex_matches`, `resolveLibraryAccessGate` derives zero visible kinds, so non-admins
   see no Library tabs even WITH grants (the ADR-047 fail-safe — right direction, silent and
   confusing UX), until a recurring sync closes the window.

The owner ruled both: seed at bootstrap, AND close the window with an auto-sync plus honest UX.

## Decision drivers

- **"Default sees everything" becomes a code guarantee**, surviving a from-scratch rebuild with
  zero configuration.
- **Zero-change on the LIVE deploy:** the owner's existing grant configuration must not be
  widened or rewritten by shipping this.
- **The ADR-047 invariant is untouchable:** never leak an item from a library a role cannot
  access; deny-by-default stays the failure direction.
- The app now runs 3 replicas (PLAN-062/063) — any boot-time action must be replica-safe.
- Silent empty walls are the enemy: fail-safe states must SAY what they are.

## Considered options

1. Document only (runbook note) — rejected by the owner.
2. Default role bypasses the gate in code — rejected: inverts deny-by-default, makes
   restricting Default a special case.
3. **Seed grants at bootstrap + auto-grant on server registration + boot-triggered first sync +
   honest cold-start UX** — chosen.

## Decision outcome

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Bootstrap seed:** the seed that creates the Default role also writes it a `role_plex_server_all_grants` row for every Plex server present at seed time, and the Plex-server registration writer **auto-grants the Default role** an all-libraries grant on each NEWLY registered server (audited like any grant write; an admin can revoke it afterwards and revocation is respected — auto-grant fires only at first registration, never re-asserts). |
| C-02 | **No backfill.** Existing deployments keep their grants exactly as configured — the migration adds no rows. The guarantee applies to fresh deploys and future server registrations; the live estate is already in the desired state by configuration. |
| C-03 | **Non-default roles are untouched:** admin-created roles still start with zero grants (deny-by-default, ADR-024 unchanged). |
| C-04 | **Boot-triggered first sync:** on app start, when `media_plex_matches` is EMPTY, the app triggers one plex-match sync itself — asynchronously (never blocks serving or health), under a Postgres advisory lock so the 3 replicas cannot race (the PLAN-062 migrator-lock precedent), and skipped entirely when any match row exists (steady-state boots do nothing). The recurring CronJob remains the steady-state owner of match freshness. |
| C-05 | **Honest cold-start UX:** the gate distinguishes WHY it resolved empty. Empty because the match table is empty (cold start) ⇒ non-admin Library surfaces render an explicit "libraries are still syncing" state and admins see a banner with the sync status. Empty because the role truly holds no grants ⇒ the existing access-denied empty state, unchanged. The distinction is computed server-side (never inferred client-side). |
| C-06 | Bad: the registration writer gains a side effect (the Default auto-grant) — it must stay inside the same transaction as the server insert and write the same audit trail as a manual grant, or a crash could register a server invisibly to Default. |
| C-07 | Amends the ADR-024 bootstrap posture and the ADR-047 cold-start note (both remain Accepted; this ADR adds the bootstrap/cold-start contract on top). DESIGN-025 (the gate) is amended in the implementing change; PRD/glossary take next-free numbers at authoring (R-237+/T-232+; re-grep first). |

## More information

- Ruling record: `.agents/context/2026-07-28-owner-rulings-gate-and-mam.md` (Ruling 1, decisions
  1a + 1b). Sequencing: solidification before new features (owner, twice, 2026-07-28).
- Governs: `packages/domain/src/library-access.ts` (`resolveLibraryAccessGate` — gains the
  empty-reason distinction), the DB seed (Default role creation), the Plex-server registration
  writer, the plex-match sync trigger path, and the Library empty states in `apps/web`.
- Related: ADR-024 (grant model), ADR-047 (the gate invariant), PLAN-062 (advisory-lock
  precedent), DESIGN-025 (gate design of record).
