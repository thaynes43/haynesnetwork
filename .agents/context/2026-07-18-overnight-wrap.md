# 2026-07-18 overnight wrap — Collections saga COMPLETE (v0.77.0 → v0.80.0)

Coordinator: Fable (cold start ~04:27 UTC, per COLDSTART.md). All build work Opus-dispatched;
Fable owned orchestration + UI/UX + the polish pass. Every backlog/saga note is on main
(owner rule, codified in CLAUDE.md § Workflow this session, PR #387).

## Live: v0.80.0 (four releases tonight, each live-verified at the data layer)

| Release | Carried | Note |
|---|---|---|
| v0.78.0 | PR3 #385 (size cap + override tickets + movies force-search seam) | DEFECTIVE — migration 0067 silently skipped in prod (journal timestamp collision, drizzle strict `<`) |
| v0.78.1 | #391 fix + journal-monotonicity regression guard | caught by the data-layer verify; 0067 confirmed applied |
| v0.79.0 | ★ #394 books/audiobooks Wanted tiles (migration 0068) · #393 PR4a `/collections` (0069) · #396 UX polish · #388 suggest removal | Stormlight view PROVEN: 154 collection-origin wants minted on first sync (173 by 0.80.0) |
| v0.80.0 | #397 PR4b Kometa write path (feat!) · #400 unification refactor · #401 PR4c find-missing · #402 GB 429 hardening · #403 drift guard · #399 runbook | no new migrations; Kometa provider degrades honestly pending token |

## The owner rulings that reshaped PR4 (captured in `2026-07-18-collections-direct-add-rulings.md`)
Suggest→approve is DEAD (the shipped in-wall suggest button was REJECTED and removed same-night).
Direct-add: everyone adds/edits ≤ configurable 25-cap; over-cap = ticket carrying the full
definition, admin one-click approve = materialize; admins only unbounded + delete; find-missing is
a granted per-collection knob feeding Kometa/Libretto cron acquisition; Kometa within-cap adds
auto-commit+auto-merge to haynes-ops (gated: cap-asserted · grouping-only · managed-file-only ·
CI-validate green — until the CI gate exists every PR routes to a human). Collection management is
a FIRST-CLASS `/collections` page (Movies · TV · Books · Audiobooks · Tickets · Settings), not an
Integrations hub card. Docs: ADR-072 supersedes ADR-069+070; DESIGN-042/043 rewritten; PLAN-052
executed as PR4a/b/c (#393/#397/#401).

## Unification lane: COMPLETE
wanted-detail + activity refactored onto shared components (#400); the `action-anatomy` drift
guard is LIVE in required CI (#403) — the ADR-071 doctrine is structural now. Ruling recorded:
collection-scoped config controls (find-missing puck, pairing-backfill) are NOT media actions.

## Overnight verifier evidence (~07:33 UTC, read-only)
- **GB quota anomaly:** the 07:32 pairing cron's FIRST post-reset call 429'd — a GENUINE empty
  day-quota (live-captured body: "Queries per day", reason `rateLimitExceeded` — Google reports
  daily exhaustion with the same reason as burst; classification-by-reason would REGRESS). The
  consumer draining the shared key sits OUTSIDE our namespaces (Libretto broker made only ~16
  calls). The 210 unresolved pairing wants (27 ISBN-bearing, frozen) stay starved until quota
  capacity changes. #402 shipped the real latent fix found en route (URL-in-message could
  false-arm the 24h breaker on a book titled "Daily…") + Retry-After-honoring jittered backoff.
- **Mia (`mia.xh`):** 33/74 landed previously; the 41 force-searched are ALL resolved but 0 grabs
  in ~7.5h (availability/LL latency, not resolution). Watch tonight.
- **THE FLIP: owner opened the full grid** (~04:07–04:17 UTC): Default/Family/Friends all hold
  fix_book + force_search_book. CLOSED.
- ai-usage cron Errors ~06:15 UTC = transient 30s upstream timeout; subsequent run clean.

## OWNER MORNING CHECKLIST
1. **haynes-ops PR #2114 (draft, DO NOT MERGE yet):** create a GitHub App install token / fine-grained
   PAT (haynes-ops, contents+PRs write) → add field `HAYNESOPS_WRITE_TOKEN` to the existing
   `haynesnetwork` 1Password item (HaynesKube) → mark PR ready + merge → one-time delete
   `/config/config.yml` on the Kometa PVC. This arms Movies/TV collection writes end to end.
2. **GB day-quota (the 210-want prize):** raise the Books API per-day quota on GCP project
   `841331826441`, or identify the external consumer draining it within ~30 min of the 07:00 UTC
   reset. Code is ready and waiting; it has never had one successful post-fix resolve window.
3. **Grants to open at will:** /admin → roles → "Collections actions" (find_missing) — ships
   admin-only, same self-serve grid as Books actions.
4. **Pixel check (your binding seat):** `/collections` all six tabs (phone + desktop, both themes),
   a thin books/audiobooks collection drill (held + Wanted tiles), the phone nav edge-fade.

## Residuals / open questions (unchanged priorities)
Backlog: SSO estate apps + HA OIDC research · unified Tautulli · Kid/Teen curation · SMTP ·
integrations-section grant. Design Q-NNs left open: DESIGN-043 Q-03 (Kometa auto-merge canary
flag), DESIGN-042 Q-05 marker refinement (v1 = `HNet Managed` label), Q-06 ref-preview egress
(canary-first; URL/collection-id builders route to the ticket path since cap is unprovable
offline). Kometa hard-delete semantics unverified → delete orphans the produced collection in v1.
Migration ledger: next free = **0070**.
