# PROCESS — how work happens in this repo

haynesnetwork is **documentation-first**. Every feature travels this pipeline, and each
stage's artifact lives in a numbered doc under `docs/`:

```
PRD  →  ADR  →  DDD  →  design  →  plan  →  code  →  unit tests  →  e2e / validation
prds/    adrs/   domain-  designs/  plans/                          plans/ (validation)
                 driven-
                 design/
```

## Stages

1. **PRD** (`docs/prds/`) — what and why. Requirements `R-NN`, user stories `US-NN`,
   acceptance criteria `AC-NN`, open questions `Q-NN`. IDs are stable forever.
2. **ADR** (`docs/adrs/`) — significant decisions, MADR 3.0. One decision per ADR.
   Consequences get `C-NN` IDs. Immutable once Accepted; supersede instead of editing.
3. **DDD** (`docs/domain-driven-design/`) — the ubiquitous language glossary and bounded
   contexts. The glossary is normative: code and docs use its terms exactly.
4. **Design** (`docs/designs/`) — how: schemas, API surfaces, component contracts, sequence
   flows. References PRD/ADR IDs it satisfies.
5. **Plan** (`docs/plans/`) — executable implementation steps, paired
   `NNN-<slug>-implementation.md` + `NNN-<slug>-validation.md`. `COVERAGE.md` maps PRD
   requirement IDs → plans, so nothing silently drops.
6. **Code + tests** — implementation follows the plan; the validation doc defines what
   proves it done (unit, integration, Playwright e2e).

## Conventions

- Copy the folder's `000-template.md` to start any new doc; 3-digit numbering, next free.
- Status: `Draft → Proposed → Accepted → (Superseded by NNN | Deprecated)`.
- Never renumber or reuse an ID. Reference IDs across docs (`R-03`, `ADR-002 C-01`).
- Unknowns become `Q-NN` open questions — ask the owner rather than inventing an answer.
- Docs change in the same commit/PR as the behavior they describe.
- Releases are scoped in `docs/releases/`; operational runbooks in `docs/ops/`.

## Agent workspace

`.agents/HANDOFF.md` is the single resume point: current state, next steps, gotchas.
Dated coordination notes go to `.agents/context/`, executable prompts to `.agents/prompts/`.
Subagents get their briefs from plans + designs — keep those self-contained.
