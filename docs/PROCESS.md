# PROCESS — how work happens in this repo

haynesnetwork is **documentation-first**. Every feature travels this pipeline, and each
stage's artifact lives in a numbered doc under `docs/`:

```
PRD  →  ADR  →  DDD  →  design  →  plan  →  code  →  unit tests  →  e2e / validation
prds/    adrs/   domain-  designs/  .agents/plans/
                 driven-
                 design/
```

Executable plans live in `.agents/plans/` (agent working state), not `docs/plans/`.

## Stages

1. **PRD** (`docs/prds/`) — what and why. Requirements `R-NN`, user stories `US-NN`,
   acceptance criteria `AC-NN`, open questions `Q-NN`. IDs are stable forever.
2. **ADR** (`docs/adrs/`) — significant decisions, MADR 3.0. One decision per ADR.
   Consequences get `C-NN` IDs. Immutable once Accepted; supersede instead of editing.
3. **DDD** (`docs/domain-driven-design/`) — the ubiquitous language glossary and bounded
   contexts. The glossary is normative: code and docs use its terms exactly.
4. **Design** (`docs/designs/`) — how: schemas, API surfaces, component contracts, sequence
   flows. References PRD/ADR IDs it satisfies.
5. **Plan** (`.agents/plans/`) — executable implementation steps as a single free-form doc
   per effort (`NNN-<slug>.md`); GATE A is `001-gate-a-pr-cutover.md`. No fixed
   implementation/validation split is required. (A `COVERAGE.md` mapping PRD requirement IDs
   → plans is a possible future artifact, not a current requirement.)
6. **Code + tests** — implementation follows the plan; the plan states what proves it done
   (unit, integration, Playwright e2e).

## Conventions

- Copy the folder's `000-template.md` to start any new doc; 3-digit numbering, next free.
- Status: `Draft → Proposed → Accepted → (Superseded by NNN | Deprecated)`.
- Never renumber or reuse an ID. Reference IDs across docs (`R-03`, `ADR-002 C-01`).
- Unknowns become `Q-NN` open questions — ask the owner rather than inventing an answer.
- Docs change in the same commit/PR as the behavior they describe.
- Operational runbooks live in `docs/ops/`.
- `docs/flows/` and `docs/releases/` are intentional template scaffolding, not required
  per-feature stages: flows fold into the design docs, and releases are handled by
  release-please (conventional-commit titles → version bumps and changelog), not hand-authored
  release-scope docs.

## Agent workspace

`.agents/HANDOFF.md` is the single resume point: current state, next steps, gotchas.
Executable plans go to `.agents/plans/`, dated coordination notes to `.agents/context/`.
Subagents get their briefs from plans + designs — keep those self-contained.
