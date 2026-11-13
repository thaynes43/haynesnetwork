# PLAN-081: Comparable model-family baseline feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-079 first usable loop accepted; include PLAN-080 cases only when available
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Which accessible family of models/variants can perform the same bounded repair task?
- Q-02: Can we compare verified outcomes fairly under identical case, tool and budget constraints?
- Hypothesis: a small reproducible baseline exposes capability/cost tradeoffs without a large benchmark campaign.

## Scope and usable deliverable

Deliver a versioned case manifest, runner contract and small comparison report for
multiple named models/variants, with the working Sonnet 5.5 loop as the reference.
Select the family during grooming; do not silently replace it with one favorite model.
Use the same initial case state, visible evidence, tool versions/permissions, per-case
time/action/token policy, retry limits and verification rules. Record incompatibilities
rather than quietly giving a model extra tools or easier cases. No real-world repair
side effects merely to benchmark. New releases become candidates for an explicitly
groomed rerun, never an automatically scheduled model promotion.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 081-S1 | Verified loop receipts; select and freeze representative cases and model roster | Case manifest, expected outcomes and identical tool/budget contract | 30 min |
| 081-S2 | Frozen S1 inputs; run only the approved small matrix in isolated fixtures | Complete raw receipts, including failures/timeouts, and independently adjudicated outcomes | 45 min |
| 081-S3 | S2 receipts; compare without retuning on evaluation cases | Reproducible report and keep/change/defer recommendation; no runtime switch | 30 min |

**Dependency graph:** 081-S1 -> 081-S2 -> 081-S3; isolated runs could be parallel only after explicit resource/budget grooming No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Version case split, source evidence, model identifiers/settings, prompts/skills, tool schemas, harness and budget policy before running.
2. Proposed first matrix: three models/variants on the same four frozen cases (12 runs maximum), including success, ambiguity, unsupported action and safe escalation. Groom a smaller matrix if it cannot fit the cap.
3. Report diagnosis correctness against verified root cause; verified repair rate over all attempted cases; unnecessary/unauthorized changes; appropriate escalation and missed escalation; end-to-end latency; observed cost/usage. Keep timeouts and failures in the denominator.
4. Audit before/after state and action traces independently of model self-report. Preserve raw case-level results; small samples get ranges/limitations, not unsupported reliability claims.
5. Separate subscription consumption, measured cash cost, and explicitly sourced estimates. Unknown costs stay unknown. Reproduce one selected result without changing case or settings.
6. Publish a bounded decision and a versioned rerun recipe for future releases. No model is promoted automatically from a score.

**Expected end state:** a credible small family baseline with evidence, limitations and a repeatable comparison protocol, not a production model decision

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 105 min across three sessions; 12 runs maximum, one attempt per case/model unless an explicit harness fault invalidates it. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

## Ungroomed spike: media-inspection toolkit (paused)

Owner lesson, 2026-10-14, from the suspended PLAN-077 R1 Mickey case (checkpoint issue #992, file 80066, Fix `37685a87-1e02-4cd4-bce7-1600c9a55c33`). Cheaper and text-only agents need a shared inspection toolkit before a model-family comparison is fair. **Implementation is paused.** This section is not a story, not acceptance that work has started, and not permission to benchmark or install tools.

Provider-neutral capabilities to groom later, each capability-tested per provider, model, and harness. Do not assume Qwen or any other model has or lacks a modality.

- Bounded decode of a named file: a few frames and a short audio slice, with sample limits recorded up front.
- Supported interpretation of audio and language, separate from filename, codec tags, and subtitle cues.
- Story boundaries and completeness for every story a file claims, including a later story in a pair. Two frames or a short clip do not prove the whole file.
- Multi-episode mapping evidence: Sonarr assignment and what Plex actually exposes, kept distinct from file content.
- Structured provenance (tool, version, input, output, hash) and an explicit uncertainty when a check was not done.

Case distinctions already learned: a missing inspection codec is not corrupt or unplayable media. A correct file with a wrong Sonarr or Plex assignment is a mapping question, not an automatic blocklist, delete, and search. Supported replacement stays a later, recovery-aware repair decision, separate from inspection.

Future acceptance considerations only. They do not authorize a benchmark or an implementation now.

- Privacy: no unapproved media upload and no third-party transcription of library files.
- Explicit resource, time, and sample limits. CPU first. A bounded GPU only when a groomed story justifies it and the owner approves it.
- Tool, input, and output provenance, plus stated uncertainty.
- Temporary artifacts removed after proof copies and hashes are retained.
- Recovery-aware supported replacement kept separate from inspection.
- Cross-model and cross-harness checks for accuracy, unsupported claims, cost or latency, and tool coverage. Unknown cost stays unknown.

The current R1 gates stay in force: both Fixes remain completed without `owned_import_intent`, Pokémon finish serial 64 stays undelivered, and no repair mutation is part of this spike.

Stop if verified truth is missing, evaluation leaks into tuning, budgets differ, a provider needs unapproved spend/access, or a model cannot use the common tool contract. Record failure instead of expanding the experiment. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** owner reviews the evidence before PLAN-082 or any later adoption; every new model-release rebenchmark requires a scoped decision Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
