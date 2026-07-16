# PLAN-054: Libretto — design phase for the books collection-manager app

- **Status:** Design authored + M0 rulings landed (2026-07-16, incl. the evening STATELESS
  amendment) — DESIGN-037 is the owner-review artifact and Q-01..Q-04 are ruled; build is
  green-lit. This plan is the phase map from ruling → repo scaffold → MVP → contract → hnet
  binding.
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
    (zod idioms; storage ruling evolved same-day — see the stateless ruling below).
  - **Owns BOTH acquisition lists AND collections, "just like Kometa does":** list builders
    drive LL wants for missing items; collection builders write results INTO Kavita/ABS (the
    sources of truth) — haynesnetwork only mirrors (PLAN-051).
  - **hnet integrates ONLY via the provider-parity contract** (PLAN-052 R2:
    recipes/validate/apply/runs/produced-collections), implemented natively from day one.
  - **KISS discipline;** the Kometa idiom kept as the contract SHAPE, and Libretto is an APP
    (resident service, real API, reconciler, triggering schedules).
  - **STATELESS (2026-07-16 eve, FINAL — supersedes both the original "recipes are DB rows"
    ruling and the same-day SQLite amendment; all three kept for the record):** "Kometa has
    no database... It just reads its YAML and searches its sources... Stateless." Recipes =
    YAML files on the config volume (never self-rewritten); produced-collection ownership
    recovered from the targets via a description-embedded recipe-id marker; acquisition
    state lives in LazyLibrarian (hard rule 4 applied to books); run history = logs + a
    rotating last-runs JSON; identifier cache = TTL'd disk dir. DESIGN-037 D-01/D-03
    amended.
- **Depends on:** owner review of DESIGN-037 (M0 gate). Relates: PLAN-050 (shipped — format
  coverage the series logic leans on), PLAN-051 (mirror; independent, no ordering
  dependency), PLAN-052 (binds after the contract is live), PLAN-037 (shipped pattern).

## Milestones

Repo column: **libretto** = the new public repo · **haynes-ops** = deployment ·
**hnet** = this repo (already queued as PLAN-051/052 — listed for sequence, not re-scoped).

| # | Milestone | Repo | Scope | Exit criterion |
|---|-----------|------|-------|----------------|
| M0 | Owner review | hnet | DESIGN-037 read; Q-01 license, Q-02 source keys, Q-03 storage, Q-04 repo home ruled | **DONE 2026-07-16:** AGPL-3.0; key instructions delivered; Q-03 = STATELESS (final, after a same-day SQLite step); repo created by the owner |
| M1 | Scaffold + walking skeleton | libretto | Public repo (AGPL-3.0), pnpm/TS/ESLint/Vitest (temp-config-dir test harness — no DB), the D-01 recipes dir + YAML schema (zod), `/health`, API-key auth (D-12), recipes CRUD + runs endpoints live (contract-first — the nouns exist before the features behind them), CI + release-please + Dockerfile. **SPIKE: Kavita collection/reading-list description writability (the D-03 provenance marker; UNVERIFIED)** — if unwritable, wire the sidecar ownership JSON fallback | CI green; `POST /recipes` validates then writes a YAML file; container boots with only a config volume; spike verdict recorded |
| M2 | Tracer vertical | libretto | `static_ids` builder → Kavita target end-to-end: identifier match (D-04 steps 2–3), target mapping (D-07: reading list when ordered, collection otherwise), sync_mode append+sync (D-08), ownership recovery via the marker (or the M1-spike fallback), run-state file + `GET /runs`, `GET /collections` read-back FROM the target, in-process cron (D-11). Stub Kavita in tests; probe real Kavita identifier exposure (the D-04 UNVERIFIED) | A static recipe materializes an ordered Kavita reading list; re-run reconciles; wipe the volume's cache/run file ⇒ next run converges (statelessness proven); run history reads back |
| M3 | **MVP: series completion** | libretto | `hardcover_series` builder (positions → ordered membership), full identifier-resolution chain (Open Library + Wikidata glue, TTL'd disk cache), MissingReport recomputed per run + `GET /recipes/:id/missing`, `POST /validate` real | **One source, one target, one recipe type end-to-end:** "complete the series I started" produces an ordered Kavita reading list + an honest missing[] — acquisition still OFF |
| M4 | Acquisition leg | libretto | Confined LL write module (addBook → queueBook → searchBook ONLY, import-confined + three-writes-only test pin), `acquisitionEnabled` per recipe (default false), pacing cap (default 25/run, env-tunable; recency rotation in the run-state file), LL queried as the want ledger (D-09 — probe whether `Requester` provenance is settable via the API path, UNVERIFIED), landed by recomputation | Missing items become LL wants under the cap; the governor/provider-config invariants are test-pinned |
| M5 | Built-in UI | libretto | Recipes CRUD (form from `GET /builders` schemas + validate-before-save), Runs monitor, Status page — D-13's bound, nothing more | An operator can run Libretto standalone with no hnet |
| M6 | Deploy | haynes-ops | HelmRelease (bjw-s app-template, single Deployment + one small config/cache PVC — the Kometa shape, no DB service), ESO secrets (Kavita/ABS/LL + Q-02 source keys), internal ingress `libretto.haynesops.com`, egress allowlist (D-14) | First real run against estate Kavita; a real series reading list exists and survives re-runs |
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

Owner-facing questions live in DESIGN-037 — all four now carry resolutions (Q-01 AGPL-3.0;
Q-02 key provisioning in flight; Q-03 STATELESS, final, with the same-day ruling progression
kept for the record; Q-04 repo created by the owner). The remaining UNVERIFIEDs are build-time
spikes, not owner questions: Kavita description writability (M1) and LL `Requester` via the
API path (M4).
