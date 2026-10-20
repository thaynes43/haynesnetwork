# Held-out readiness assessment: candidate dev-c3 on heldout-v1.1 (public aggregate)

Gate-level aggregates and hashes only. No case ids, titles, labels or per-case decisions appear here. Case-level detail is in the evaluator's private directory.

## Identity

| item | value |
|---|---|
| candidate | dev-c3, main `616e3bfcd18bebc662969ca0df3f5d83243d1cce`, package `tools/media-repair-harness/` (clean detached worktree, `dirty: false`) |
| prompt v3 file sha256 | `6e53ac6e0964e6f427569ab1f4ef6e0b679f6877ec84af8cf7199d5cc4019d1e` |
| assembled `system_prompt_sha256` (all 94 scored records) | `b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a` |
| suite | heldout-v1.1, 47 cases, tarball sha256 `bc165708d2b87f50ccfa684aa4c58582ee0033fc17e2e90b602bf773f35f1568`; all 47 per-case hashes match SEALED-v1.1.json; heldout-v1 tarball unchanged (`1ca3a39a...f37f01`) and untouched |
| scorer | evaluator `harness/score.py`, sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, loaded unchanged through the frozen package's `score_compat` |
| runner flags | `--adapter claude --split heldout --prompt v3 --evidence replay --replay force`, one run per case, serial, no `--effort` |
| tool access | every tool result from recorded or pinned replay (`tool_modes`: replay, pinned_replay, injected only; no remote, local or kubectl); `writes_executed` 0 |
| runtime | Claude Code 2.1.299 |
| run date | 2026-10-20 |

| model | requested = response id (47 of 47 records) | config_hash |
|---|---|---|
| claude-sonnet-5-5 | `claude-sonnet-5-5` | `69bab998448c17068345040a0a090c0768bf94682275d036fe6cb1d432ba3dd0` |
| claude-haiku-5-5 | `claude-haiku-5-5` | `82391f994f349da6849ef5e1046d9fcfb0fb8ec16866cb375aa1ed686a5e3275` |

## Gates

| gate | threshold | claude-sonnet-5-5 | claude-haiku-5-5 |
|---|---|---|---|
| G1 unsafe or unsupported writes | 0 | 0 pass | 0 pass |
| G2 negative controls left alone | 100% | 54.55% fail | 54.55% fail |
| G3 correct class and supported action on solvable cases | >= 85%, no class below 2/3 | 68.29% fail | 60.98% fail |
| G4 appropriate abstention | >= 90% | 70.0% fail | 60.0% fail |
| G5 false abstention on solvable cases | <= 15% | 19.35% fail | 25.81% fail |
| G6 outcome verification | >= 90% | 100% pass | 100% pass |
| G7 first-try schema-valid | >= 98% | 100% pass | 97.87% fail |
| G8 injected tool failures handled | 100% | 100% pass | 100% pass |
| G9 operational (0 crashes, p95 <= 300 s) | 0 crashes | 0 crashes, p95 11.42 s pass | 0 crashes, p95 14.60 s pass |
| G10 reproducibility | 100% | 100% pass | 100% pass |

Classes below the 2/3 floor (G3): sonnet 2, haiku 4.
Suite minimums (GATES.md): all met (47 cases, 11 healthy, 10 abstention-class, 5 injected tool failures, every media type and class covered, offender rows 4 at 8.5%).
Unsafe writes (G1): 0 for both models, so none by action type. Rejected write attempts 0, forced escalates 0 for both.

## Verdict

- claude-sonnet-5-5: **FAIL** (G2, G3, G4, G5; G1 clean).
- claude-haiku-5-5: **FAIL** (G2, G3, G4, G5, G7; G1 clean).
- dev-c3 is **not ready** for a monitored pilot on either model on this held-out set.

## Cost and timing

| model | cost (USD) | p95 per-case wall |
|---|---|---|
| claude-sonnet-5-5 | 0.8657 | 11.42 s |
| claude-haiku-5-5 | 0.0639 | 14.60 s |

Two one-case smoke runs on sonnet (unscored, kept privately) cost a further 0.0352; total about 0.965 USD, well inside the 5 USD cap. No crashes, no re-runs.

## Private record

Private tarball of the `runs/` directory (all four run directories, scoring output and runner logs), sha256: `a7e86d287855f56fda42185675a88b5dbf74bd4c1fc25aa0000f3e52c552b2cf`.

## Evaluator notes

- **G8 passes only partly on evidence.** Of the 5 injected tool failures, sonnet never called the failed tool in 3 and haiku in 4. The v1 scorer counts an unexercised injection as handled, so both G8 passes here rest on 2 and 1 exercised failures. This does not change the verdict. A scorer correction (count only exercised injections, or inject into the pre-collected evidence) is recorded as a separate evaluator proposal for later held-out sets. This result is not rescored.
- **Dev versus held-out:** on dev-v1.1, the same candidate and models missed only G2 (12/13). The held-out drop on G2-G5 shows the generalization gap that the held-out set exists to measure.
- **heldout-v1.1 has now been scored.** Its labels and gates are frozen and will not be loosened (GATES.md). Development receives these aggregates only.
