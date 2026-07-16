# PLAN-054: Libretto — design phase for the books collection-manager app

- **Status:** Design authored (2026-07-16) — DESIGN-037 is the owner-review artifact; NO code
  and NO new repo until the owner rules on its Q-01..Q-04. This plan is the phase map from
  ruling → repo scaffold → MVP → contract → hnet binding.
- **Saga:** PLAN-043 phase "Books collection-manager app ('Kometa for books')". Subsumes the
  engine half of PLAN-032 (the Books Automation Saga escalation — list-driven acquisition now
  lives in Libretto; PLAN-032 closes into this plan's completion record when the MVP ships,
  keeping only its comics-source hunt open).
- **Docs:** DESIGN-037 (architecture, D-01..D-15 + Appendix A binding sequence). Foundation:
  `.agents/context/2026-07-16-kometa-integration-research.md`. Doctrine: ADR-064. Contract:
  research §6 = PLAN-052 R2. Lessons carried: ADR-065 (identifier-first matching, mint-cap
  pacing), ADR-055 (confined LL chain), ADR-054 + OPS-013 (governor + Prowlarr owns LL
  provider config).
- **Owner rulings (2026-07-16, normative — recorded here and in PLAN-043):**
  - **Name: Libretto.** Own public repo; standalone-valuable to Kavita/ABS/LazyLibrarian
    users without haynesnetwork.
  - **Shape:** headless API-first Node/TS service + minimal built-in config/monitoring web UI
    (hnet package idioms: zod, drizzle, Postgres).
  - **Owns BOTH acquisition lists AND collections, "just like Kometa does":** list builders
    drive LL wants for missing items; collection builders write results INTO Kavita/ABS (the
    sources of truth) — haynesnetwork only mirrors (PLAN-051).
  - **hnet integrates ONLY via the provider-parity contract** (PLAN-052 R2:
    recipes/validate/apply/runs/produced-collections), implemented natively from day one.
  - **KISS discipline;** the Kometa idiom kept as the contract SHAPE, but Libretto is an APP:
    recipes are DB rows with a reconciler, not YAML files (research §5.4).
- **Depends on:** owner review of DESIGN-037 (M0 gate). Relates: PLAN-050 (shipped — format
  coverage the series logic leans on), PLAN-051 (mirror; independent, no ordering
  dependency), PLAN-052 (binds after the contract is live), PLAN-037 (shipped pattern).

## Milestones

Repo column: **libretto** = the new public repo · **haynes-ops** = deployment ·
**hnet** = this repo (already queued as PLAN-051/052 — listed for sequence, not re-scoped).

| # | Milestone | Repo | Scope | Exit criterion |
|---|-----------|------|-------|----------------|
| M0 | Owner review | hnet | DESIGN-037 read; Q-01 license, Q-02 source keys, Q-03 DB placement, Q-04 repo home ruled | Rulings recorded here; repo green-lit |
| M1 | Scaffold + walking skeleton | libretto | Public repo (license per Q-01), pnpm/TS/ESLint/Vitest + embedded-PG16 harness, drizzle schema for the D-02/D-03 tables, `/health`, API-key auth (D-12), recipes CRUD + runs endpoints live (contract-first — the nouns exist before the features behind them), CI + release-please + Dockerfile | CI green; `POST /recipes` persists a recipe; container boots against PG |
| M2 | Tracer vertical | libretto | `static_ids` builder → Kavita target end-to-end: identifier match (D-04 steps 2–3), target mapping (D-07: reading list when ordered, collection otherwise), sync_mode append+sync (D-08), Run records, `GET /collections` read-back, in-process cron (D-11). Stub Kavita in tests; probe real Kavita identifier exposure (the D-04 UNVERIFIED) | A static recipe materializes an ordered Kavita reading list; re-run reconciles; run history reads back |
| M3 | **MVP: series completion** | libretto | `hardcover_series` builder (positions → ordered membership), full identifier-resolution chain (Open Library + Wikidata glue, `identifier_cache`), MissingReport computed + `GET /recipes/:id/missing`, `POST /validate` real | **One source, one target, one recipe type end-to-end:** "complete the series I started" produces an ordered Kavita reading list + an honest missing[] — acquisition still OFF |
| M4 | Acquisition leg | libretto | Confined LL write module (addBook → queueBook → searchBook ONLY, import-confined + three-writes-only test pin), `acquisitionEnabled` per recipe (default false), pacing cap (default 25/run, env-tunable), unmintable retry with backoff-by-recency, landed reconcile (D-09) | Missing items become LL wants under the cap; the governor/provider-config invariants are test-pinned |
| M5 | Built-in UI | libretto | Recipes CRUD (form from `GET /builders` schemas + validate-before-save), Runs monitor, Status page — D-13's bound, nothing more | An operator can run Libretto standalone with no hnet |
| M6 | Deploy | haynes-ops | HelmRelease (bjw-s app-template, single Deployment), ESO secrets (Kavita/ABS/LL + Q-02 source keys), DB per Q-03, internal ingress `libretto.haynesops.com`, egress allowlist (D-14) | First real run against estate Kavita; a real series reading list exists and survives re-runs |
| M7 | hnet binding | hnet | PLAN-052 provider registry consumes the contract (Appendix A step 1); PLAN-051 mirror displays Libretto-written collections with ZERO changes (Appendix A step 2 — a validation checkpoint, not work) | Libretto collections visible on the hnet books walls; recipe CRUD from the hnet UI |
| M8 | Breadth | libretto | ABS collection target, `nyt_list` + `wikidata_award` builders, Goodreads RSS seed-import command, sync hardening from M6 field experience | Second target + second source class live |

**Sequencing notes:** M1–M5 are pure libretto-repo work and serialize; M6 needs M3 (something
real to run) and can precede M4/M5 if the owner wants the flagship live early; PLAN-051 has
no dependency on ANY milestone here (its quick win is hand-curated collections) — do not
serialize it behind Libretto. PLAN-052 binds after M6.

## Proposed MVP cut (M3, for the owner's eyes)

Hardcover series positions → ordered Kavita reading list, with the missing[] report computed
but acquisition dark. That single vertical exercises everything load-bearing: the flagship
builder, first-class ordering, the identifier chain, ownership + sync_mode, run records, and
the day-one contract surface — while touching nothing that can flood LL or MAM. The
acquisition leg (M4) flips on only after the reconcile loop is proven against the real
estate.

## Out of scope (this plan)

Everything in DESIGN-037 D-15 (no Goodreads scraping, no recommendations, no multi-user
personalization, no LL provider-config writes, no overlays/metadata ops, no comics v1), plus:
OIDC (API keys first), Prometheus metrics (logs + run history first), Kometa-side work
(PLAN-052 owns it), and any hnet mirror changes (PLAN-051 owns the mirror; Appendix A step 2
is the proof it needs none for Libretto).

## Open questions

Owner-facing questions live in DESIGN-037 (Q-01 license, Q-02 Hardcover/NYT key
provisioning, Q-03 shared-vs-own Postgres, Q-04 repo home/name availability). This plan adds
none — M0 is the gate where they get ruled.
