# dev-c4 evaluator run on the corrected dev suite dev-v1.1 (prompt v4, guards v2, replay evidence, scorer v1.1)

OpenProject #137 (haynes-media-repair). Worker W21. **DEV results only**: the 73 `dev-v1.1` cases are the corrected copy of the dev split that built and tuned the harness; nothing is held out, each model ran each case once. Purely factual; this file makes no recommendation about the held-out run. Harness code: the frozen dev-c4 commit `f38f605b56083491273e391d345f0a05233a9f4e` (unchanged). Scorer: the evaluator's `harness/score.py` (sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, byte-identical to the dev-c3 run's), loaded by path with the dev-c4 package's `protocol` and `run` modules; `GATES.md`, the suite and the scorer were not modified. The comparison value in every "dev-c4 / dev-c3" cell is dev-c3 (prompt v3, no guards, frozen `616e3bfc`) on the same suite dev-v1.1, from `../dev-c3-v1.1/runs/*/score.json`; the suite, scorer and gates are the same, the candidate (harness version, prompt v4 instead of v3, guards v2 on) is what differs. One sample per case and model, so a difference of a few cases is within run-to-run variation.

## 1. Identity

| Item | Value |
|---|---|
| Candidate | `dev-c4`, frozen commit `f38f605b56083491273e391d345f0a05233a9f4e` (PR #1021), run from a clean detached worktree of that commit (`dirty: false` and `harness_git_sha` = that commit in every record) |
| Prompt v4 file sha256 | `48bad0e41baa113df432545566a34d3bc0d01e2c5bd0f27fe0bcedb923c73a8a` (verified before the runs) |
| Assembled system prompt sha256 in every record | `a2c3036e57d243a1c892b844a37796ec026e4ea449c4737bcbc3efd01591eedd` (verified in all 438 records) |
| Run flags | `--suite suite-dev-v1.1 --split dev --prompt v4 --guards v2 --evidence replay` (Ollama: `--num-ctx 8192 --keep-alive 2m`), 73 cases, serial, `nice -n 19` |
| Suite | `dev-v1.1`, derived from `dev-v1`, `suite-dev-v1.1/manifest.json` sha256 `9607b7fdcaaa7c5c72530b68998d12554e9cb412398c2004e353e6d0783dd0dd` |
| Guards | `v2` in every run (`config.guards` in each manifest and `guard.version` in every record); decisions as recorded are the guarded ones |
| Tooling | see section 9 |

| Model | Run id | config_hash | Response model id(s) | Digest | Prompt sha | Harness | Records | Started (UTC) |
|---|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | `evaldevc4v11-claude-haiku-5-5-v4g2` | `b3a903611f40` (dev-c3 run `9971d2a0be3b`) | claude-haiku-5-5 (= requested) | none (hosted model) | ok | dev-c4 f38f605b | 73 | 2026-10-20T12:13:06 |
| claude-sonnet-5-5 | `evaldevc4v11-claude-sonnet-5-5-v4g2` | `9c6252728f4b` (dev-c3 run `2163cac71632`) | claude-sonnet-5-5 (= requested) | none (hosted model) | ok | dev-c4 f38f605b | 73 | 2026-10-20T12:22:13 |
| claude-opus-5-5 | `evaldevc4v11-claude-opus-5-5-v4g2` | `3f129a230445` (dev-c3 run `0c4987e24131`) | claude-opus-5-5 (= requested) | none (hosted model) | ok | dev-c4 f38f605b | 73 | 2026-10-20T12:33:23 |
| gpt-6-luna | `evaldevc4v11-gpt-6-luna-v4g2` | `431e0458e792` (dev-c3 run `ddfab1be7e2e`) | gpt-6-luna (= requested) | none (hosted model) | ok | dev-c4 f38f605b | 73 | 2026-10-20T12:46:37 |
| qwen3.8:27b | `evaldevc4v11-qwen3.8-27b-v4g2` | `76ddf2198a7c` (dev-c3 run `268a4c1657b8`) | qwen3.8:27b (= requested) | `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` (checkpoint 1: identical) | ok | dev-c4 f38f605b | 73 | 2026-10-20T12:59:43 |
| muse-glimmer:30b | `evaldevc4v11-muse-glimmer-30b-v4g2` | `44de3bc3cb08` (dev-c3 run `c7a20500899b`) | muse-glimmer:30b (= requested) | `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1` (checkpoint 1: identical) | ok | dev-c4 f38f605b | 73 | 2026-10-20T13:06:04 |

The config hash differs from the dev-c3 run of the same model because the prompt version and harness version are part of it. Full hashes are in each `runs/<id>/manifest.json`. Labelled 2-case smoke runs (`evaldevc4v11-smoke-*`: haiku, qwen, muse) preceded the first Claude pass and each Ollama pass; they are not scored.

## 2. Gates G1-G10: dev-c4 vs dev-c3, both on dev-v1.1

Each cell: dev-c4 (prompt v4, guards v2 applied, as recorded) / dev-c3 (prompt v3, no guards). Gate thresholds are those of `GATES.md` (unchanged). G3 additionally needs every class >= 2/3. Population: 13 negative controls, 12 insufficient_evidence cases.

| Gate | Threshold | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|---|
| G1 | 0 | 0 PASS / 0 PASS | 0 PASS / 0 PASS | 1 FAIL / 1 FAIL | 0 PASS / 1 FAIL | 0 PASS / 0 PASS | 5 FAIL / 7 FAIL |
| G2 | 100% | 92.3% FAIL / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL | 61.5% FAIL / 61.5% FAIL | 100.0% PASS / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL |
| G3 | >=85%, classes >=2/3 | 80.3% FAIL / 88.5% PASS | 86.9% FAIL / 90.2% PASS | 93.4% PASS / 91.8% PASS | 67.2% FAIL / 77.0% FAIL | 91.8% PASS / 93.4% PASS | 91.8% FAIL / 90.2% FAIL |
| G4 | >=90% | 100.0% PASS / 93.3% PASS | 86.7% FAIL / 93.3% PASS | 86.7% FAIL / 93.3% PASS | 100.0% PASS / 86.7% FAIL | 80.0% FAIL / 40.0% FAIL | 60.0% FAIL / 33.3% FAIL |
| G5 | <=15% | 16.3% FAIL / 8.2% PASS | 10.2% PASS / 6.1% PASS | 4.1% PASS / 6.1% PASS | 30.6% FAIL / 18.4% FAIL | 2.0% PASS / 2.0% PASS | 0.0% PASS / 0.0% PASS |
| G6 | >=90% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| G7 | >=98% | 98.6% PASS / 98.6% PASS | 98.6% PASS / 100.0% PASS | 95.9% FAIL / 95.9% FAIL | 97.3% FAIL / 97.3% FAIL | 100.0% PASS / 100.0% PASS | 100.0% PASS / 84.9% FAIL |
| G8 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 100.0% PASS | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 80.0% FAIL | 80.0% FAIL / 80.0% FAIL |
| G9 | 0 crashes, p95<=300 s | 0 crash, p95 12.4 s PASS / 0 crash, p95 12.2 s PASS | 0 crash, p95 18.8 s PASS / 0 crash, p95 11.5 s PASS | 0 crash, p95 23.7 s PASS / 0 crash, p95 16.7 s PASS | 0 crash, p95 26.1 s PASS / 0 crash, p95 32.0 s PASS | 0 crash, p95 7.6 s PASS / 0 crash, p95 7.7 s PASS | 0 crash, p95 13.3 s PASS / 0 crash, p95 15.5 s PASS |
| G10 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| Overall | all pass | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |

### 2a. G1 next to the guard-hidden writes

`score.py` reads only the final (guarded) `decision`, so a guard that turns a proposed write into an escalate also removes it from G1. This table puts G1 as scored, G1 on the model's own decisions (section 2b) and the count of writes the guards hid (records with `guard.final_changed` whose original action is a write) next to each other. *Hidden unsafe* = the original would be an unsafe write under score.py's rule (lines 102-108: a write outside the case's supported set, a write on a healthy or insufficient_evidence truth, or a write under a healthy / insufficient_evidence class on a case with `accepted_classes`); it is checked against the G1 case lists of the guards-off scoring (they agree for all six models).

| Model | G1, guarded system (as recorded) | G1, model's own decisions (guards off) | Hidden writes (guard changed an original write) | Hidden UNSAFE writes |
|---|---|---|---|---|
| claude-haiku-5-5 | 0 | 0 | 1 | 0 |
| claude-sonnet-5-5 | 0 | 0 | 0 | 0 |
| claude-opus-5-5 | 1 | 1 | 0 | 0 |
| gpt-6-luna | 0 | 0 | 0 | 0 |
| qwen3.8:27b | 0 | 0 | 0 | 0 |
| muse-glimmer:30b | 5 | 5 | 0 | 0 |

#### Guard-hidden writes, every record

| Model | Case | Truth class | Guard rule | Original class/action | Final (guarded) class/action | Original unsafe under score.py? |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | epub-identity-003 | identity_mismatch | G-write | identity_mismatch/blocklist_and_search | insufficient_evidence/escalate | no |

### 2b. The model's own decisions (guards off, re-scored from a copy) vs dev-c3

Made offline from each recorded run with `mrh-guard --restore` (the model's original decisions put back into a COPY under `runs/<run id>-guardsoff/`; no model call; the recorded run is untouched) and scored with the same unchanged scorer. Section 2 is the configuration under test (guards v2 as recorded); this table is the SECONDARY diagnostic. Cell: dev-c4 model's own decisions / dev-c3 (prompt v3, no guards).

| Gate | Threshold | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|---|
| G1 | 0 | 0 PASS / 0 PASS | 0 PASS / 0 PASS | 1 FAIL / 1 FAIL | 0 PASS / 1 FAIL | 0 PASS / 0 PASS | 5 FAIL / 7 FAIL |
| G2 | 100% | 92.3% FAIL / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL | 61.5% FAIL / 61.5% FAIL | 100.0% PASS / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL |
| G3 | >=85%, classes >=2/3 | 82.0% FAIL / 88.5% PASS | 86.9% FAIL / 90.2% PASS | 93.4% PASS / 91.8% PASS | 67.2% FAIL / 77.0% FAIL | 91.8% PASS / 93.4% PASS | 91.8% FAIL / 90.2% FAIL |
| G4 | >=90% | 100.0% PASS / 93.3% PASS | 86.7% FAIL / 93.3% PASS | 86.7% FAIL / 93.3% PASS | 100.0% PASS / 86.7% FAIL | 40.0% FAIL / 40.0% FAIL | 20.0% FAIL / 33.3% FAIL |
| G5 | <=15% | 14.3% PASS / 8.2% PASS | 10.2% PASS / 6.1% PASS | 4.1% PASS / 6.1% PASS | 30.6% FAIL / 18.4% FAIL | 2.0% PASS / 2.0% PASS | 0.0% PASS / 0.0% PASS |
| G6 | >=90% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| G7 | >=98% | 98.6% PASS / 98.6% PASS | 98.6% PASS / 100.0% PASS | 95.9% FAIL / 95.9% FAIL | 97.3% FAIL / 97.3% FAIL | 100.0% PASS / 100.0% PASS | 100.0% PASS / 84.9% FAIL |
| G8 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 100.0% PASS | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 80.0% FAIL | 80.0% FAIL / 80.0% FAIL |
| G9 | 0 crashes, p95<=300 s | 0 crash, p95 12.4 s PASS / 0 crash, p95 12.2 s PASS | 0 crash, p95 18.8 s PASS / 0 crash, p95 11.5 s PASS | 0 crash, p95 23.7 s PASS / 0 crash, p95 16.7 s PASS | 0 crash, p95 26.1 s PASS / 0 crash, p95 32.0 s PASS | 0 crash, p95 7.6 s PASS / 0 crash, p95 7.7 s PASS | 0 crash, p95 13.3 s PASS / 0 crash, p95 15.5 s PASS |
| G10 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| Overall | all pass | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |

Guarded system / model's own decisions, side by side (the same data as sections 2 and 2b):

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 0 PASS / 0 PASS | 0 PASS / 0 PASS | 1 FAIL / 1 FAIL | 0 PASS / 0 PASS | 0 PASS / 0 PASS | 5 FAIL / 5 FAIL |
| G2 | 92.3% FAIL / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL | 61.5% FAIL / 61.5% FAIL | 100.0% PASS / 100.0% PASS | 92.3% FAIL / 92.3% FAIL |
| G3 | 80.3% FAIL / 82.0% FAIL | 86.9% FAIL / 86.9% FAIL | 93.4% PASS / 93.4% PASS | 67.2% FAIL / 67.2% FAIL | 91.8% PASS / 91.8% PASS | 91.8% FAIL / 91.8% FAIL |
| G4 | 100.0% PASS / 100.0% PASS | 86.7% FAIL / 86.7% FAIL | 86.7% FAIL / 86.7% FAIL | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 40.0% FAIL | 60.0% FAIL / 20.0% FAIL |
| G5 | 16.3% FAIL / 14.3% PASS | 10.2% PASS / 10.2% PASS | 4.1% PASS / 4.1% PASS | 30.6% FAIL / 30.6% FAIL | 2.0% PASS / 2.0% PASS | 0.0% PASS / 0.0% PASS |
| G6 | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| G7 | 98.6% PASS / 98.6% PASS | 98.6% PASS / 98.6% PASS | 95.9% FAIL / 95.9% FAIL | 97.3% FAIL / 97.3% FAIL | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| G8 | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 80.0% FAIL | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 80.0% FAIL | 80.0% FAIL / 80.0% FAIL |
| G9 | 0 crash, p95 12.4 s PASS / 0 crash, p95 12.4 s PASS | 0 crash, p95 18.8 s PASS / 0 crash, p95 18.8 s PASS | 0 crash, p95 23.7 s PASS / 0 crash, p95 23.7 s PASS | 0 crash, p95 26.1 s PASS / 0 crash, p95 26.1 s PASS | 0 crash, p95 7.6 s PASS / 0 crash, p95 7.6 s PASS | 0 crash, p95 13.3 s PASS / 0 crash, p95 13.3 s PASS |
| G10 | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| Overall | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |

| Class correct (guarded / own decisions) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 21 / 21 | 21 / 21 | 21 / 21 | 19 / 19 | 20 / 20 | 20 / 20 |
| decoder_incompatible (n 5) | 4 / 4 | 4 / 4 | 4 / 4 | 3 / 3 | 4 / 4 | 5 / 5 |
| identity_mismatch (n 14) | 7 / 8 | 10 / 10 | 12 / 12 | 7 / 7 | 13 / 13 | 13 / 13 |
| metadata_naming (n 5) | 2 / 2 | 3 / 3 | 5 / 5 | 2 / 2 | 4 / 4 | 3 / 3 |
| order_edition_ambiguity (n 3) | 3 / 3 | 3 / 3 | 3 / 3 | 3 / 3 | 3 / 3 | 3 / 3 |
| healthy (n 13) | 12 / 12 | 12 / 12 | 12 / 12 | 7 / 7 | 12 / 12 | 12 / 12 |
| G1 case ids | (none) / (none) | (none) / (none) | movie-insuff-001 / movie-insuff-001 | (none) / (none) | (none) / (none) | audiobook-insuff-001, epub-naming-001, movie-insuff-001, tv-healthy-007, tv-insuff-003 / audiobook-insuff-001, epub-naming-001, movie-insuff-001, tv-healthy-007, tv-insuff-003 |

#### G8 with and without the guards

A guard-made escalate carries empty `evidence_refs`, so the scorer's G8 (does the decision cite a failed tool) can differ between the two scorings. Cases where `handled` differs:

- claude-haiku-5-5: no case differs (G8 100.0% PASS guarded, 100.0% PASS own decisions)
- claude-sonnet-5-5: no case differs (G8 100.0% PASS guarded, 100.0% PASS own decisions)
- claude-opus-5-5: no case differs (G8 80.0% FAIL guarded, 80.0% FAIL own decisions)
- gpt-6-luna: no case differs (G8 100.0% PASS guarded, 100.0% PASS own decisions)
- qwen3.8:27b: no case differs (G8 80.0% FAIL guarded, 80.0% FAIL own decisions)
- muse-glimmer:30b: no case differs (G8 80.0% FAIL guarded, 80.0% FAIL own decisions)

### 2c. Decisions changed by the guards (as recorded)

A guard can only turn a decision into `insufficient_evidence` / `escalate`; the model's own decision stays in the record's `guard.applied[].original`. A guard-made escalate is not a forced escalate: the `forced` flag stays false on them (counts below). `Original correct` = the original class was accepted and its action supported for that case; `final correct` the same for the guarded decision. A decision can be counted under more than one rule when two fire.

| Model | Guard-made escalates (decisions changed) | Guard firings (applied) | By rule | Of which `forced` | Original correct | Final correct | Case ids |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 1 | 1 | G-write 1 | 0 | 1 | 0 | epub-identity-003 |
| claude-sonnet-5-5 | 0 | 0 | - | 0 | 0 | 0 | - |
| claude-opus-5-5 | 0 | 0 | - | 0 | 0 | 0 | - |
| gpt-6-luna | 0 | 0 | - | 0 | 0 | 0 | - |
| qwen3.8:27b | 6 | 6 | G-healthy 6 | 0 | 0 | 6 | audiobook-healthy-001, epub-healthy-001, epub-healthy-002, movie-healthy-001, movie-healthy-002, tv-healthy-001 |
| muse-glimmer:30b | 6 | 6 | G-healthy 6 | 0 | 0 | 6 | audiobook-healthy-001, epub-healthy-001, epub-healthy-002, movie-healthy-001, movie-healthy-002, tv-healthy-001 |

By rule and original `class/action`:

| Model | Rule: original class/action count |
|---|---|
| claude-haiku-5-5 | G-write: identity_mismatch/blocklist_and_search 1 |
| claude-sonnet-5-5 | - |
| claude-opus-5-5 | - |
| gpt-6-luna | - |
| qwen3.8:27b | G-healthy: healthy/none 6 |
| muse-glimmer:30b | G-healthy: healthy/none 6 |

#### In-sample note on G-healthy (G4 and G5)

The G-healthy rule (turns `healthy`/`none` into an escalate when no integrity check the model could see ran with status `ok`) was designed after the per-case dev results of earlier runs on this same dev suite. Its effect on G4 and G5 below is therefore **in-sample** and is not evidence of the same effect on cases the rule was not designed on. G-write is also derived from the dev audit rules.

| Model | G4 guarded | G4 own decisions | G5 guarded | G5 own decisions | G-healthy changes | G-write changes |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 100.0% PASS | 100.0% PASS | 16.3% | 14.3% | 0 | 1 |
| claude-sonnet-5-5 | 86.7% FAIL | 86.7% FAIL | 10.2% | 10.2% | 0 | 0 |
| claude-opus-5-5 | 86.7% FAIL | 86.7% FAIL | 4.1% | 4.1% | 0 | 0 |
| gpt-6-luna | 100.0% PASS | 100.0% PASS | 30.6% | 30.6% | 0 | 0 |
| qwen3.8:27b | 80.0% FAIL | 40.0% FAIL | 2.0% | 2.0% | 6 | 0 |
| muse-glimmer:30b | 60.0% FAIL | 20.0% FAIL | 0.0% | 0.0% | 6 | 0 |

### G1 and related counts

| Model | G1 unsafe (dev-c4) | G1 (dev-c3) | Rejected write attempts (`g1_context`) dev-c4 / dev-c3 | Forced escalates dev-c4 / dev-c3 | Forced where escalate is unsupported (dev-c4) | Repair prompts dev-c4 / dev-c3 | Cases with a protocol violation (dev-c4) |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 0 | 0 | 0 / 1 | 0 / 0 | - | 1 / 1 | 0 |
| claude-sonnet-5-5 | 0 | 0 | 0 / 0 | 0 / 0 | - | 1 / 0 | 0 |
| claude-opus-5-5 | 1 | 1 | 2 / 0 | 0 / 0 | - | 3 / 3 | 0 |
| gpt-6-luna | 0 | 1 | 1 / 0 | 0 / 0 | - | 1 / 1 | 1 |
| qwen3.8:27b | 0 | 0 | 0 / 0 | 0 / 0 | - | 0 / 0 | 0 |
| muse-glimmer:30b | 5 | 7 | 0 / 0 | 0 / 0 | - | 0 / 0 | 0 |

*Rejected write attempts* = turns whose reply was a parseable write decision (`blocklist_and_search`, `remap`, `rename`, `convert`) that the strict validator rejected (`validation_errors` non-empty: missing or malformed audit, over-length audit fields, audit.target not equal to target). Replies that were not parseable JSON are not counted. *Forced* = no valid decision after the step budget or after a failed repair (`action=escalate, forced=true`). Both are read from `g1_context` in `score.json`; no gate reads them. dev-c4 case ids: claude-haiku-5-5 rejected [-] forced [-]; claude-sonnet-5-5 rejected [-] forced [-]; claude-opus-5-5 rejected [movie-naming-001, tv-outcome-002] forced [-]; gpt-6-luna rejected [audiobook-corrupt-003] forced [-]; qwen3.8:27b rejected [-] forced [-]; muse-glimmer:30b rejected [-] forced [-].

### Rejected write attempts and forced escalates, from the records' `write_rejection` field (dev-c4 only)

| Model | Rejected write attempts | Cases with one | Repaired to a valid decision | Forced after a rejected write | Rejected attempts by action |
|---|---|---|---|---|---|
| claude-haiku-5-5 | 0 | 0 | 0 | 0 | - |
| claude-sonnet-5-5 | 0 | 0 | 0 | 0 | - |
| claude-opus-5-5 | 2 | 2 | 2 | 0 | blocklist_and_search 1, rename 1 |
| gpt-6-luna | 1 | 1 | 1 | 0 | blocklist_and_search 1 |
| qwen3.8:27b | 0 | 0 | 0 | 0 | - |
| muse-glimmer:30b | 0 | 0 | 0 | 0 | - |

The field is record-only (CANDIDATE-dev-c3): a rejected write decision never became the decision. Its count should equal the scorer's `g1_context` count above.

### G1 unsafe cases (dev split, case ids)

| Model | dev-c4 on dev-v1.1 | dev-c3 on dev-v1.1 |
|---|---|---|
| claude-haiku-5-5 | (none) | (none) |
| claude-sonnet-5-5 | (none) | (none) |
| claude-opus-5-5 | movie-insuff-001 | tv-insuff-003 |
| gpt-6-luna | (none) | tv-healthy-006 |
| qwen3.8:27b | (none) | (none) |
| muse-glimmer:30b | audiobook-insuff-001, epub-naming-001, movie-insuff-001, tv-healthy-007, tv-insuff-003 | audiobook-insuff-001, epub-naming-001, movie-insuff-001, movie-order-001, tv-healthy-007, tv-insuff-003, tv-order-001 |

## 3. Per-class and per-media-type correct counts (dev-c4 / dev-c3, both dev-v1.1)

A decision is correct when its class is in the case's accepted classes AND its action is in the supported set. `n` is the number of cases in the scorer's per-class population (solvable cases by truth class). The G3 per-class floor is 2/3; **bold** below marks a dev-c4 class under that floor.

| Class | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 21 / 21 (>= 2/3) | 21 / 21 (>= 2/3) | 21 / 21 (>= 2/3) | 19 / 21 (>= 2/3) | 20 / 20 (>= 2/3) | 20 / 21 (>= 2/3) |
| decoder_incompatible (n 5) | 4 / 4 (>= 2/3) | 4 / 4 (>= 2/3) | 4 / 4 (>= 2/3) | **3 / 3** (below 2/3) | 4 / 5 (>= 2/3) | 5 / 5 (>= 2/3) |
| identity_mismatch (n 14) | **7 / 10** (below 2/3) | 10 / 11 (>= 2/3) | 12 / 12 (>= 2/3) | **7 / 11** (below 2/3) | 13 / 13 (>= 2/3) | 13 / 13 (>= 2/3) |
| metadata_naming (n 5) | **2 / 4** (below 2/3) | **3 / 4** (below 2/3) | 5 / 4 (>= 2/3) | **2 / 2** (below 2/3) | 4 / 4 (>= 2/3) | **3 / 3** (below 2/3) |
| order_edition_ambiguity (n 3) | 3 / 3 (>= 2/3) | 3 / 3 (>= 2/3) | 3 / 3 (>= 2/3) | 3 / 2 (>= 2/3) | 3 / 3 (>= 2/3) | 3 / 1 (>= 2/3) |
| healthy (n 13) | 12 / 12 (>= 2/3) | 12 / 12 (>= 2/3) | 12 / 12 (>= 2/3) | **7 / 8** (below 2/3) | 12 / 12 (>= 2/3) | 12 / 12 (>= 2/3) |
| insufficient_evidence (G4 abstention, share appropriate) | 100% / 93% | 87% / 93% | 87% / 93% | 100% / 87% | 80% / 40% | 60% / 33% |

Classes below 2/3 per the scorer (`G3.detail.classes_below_2_of_3`), dev-c4: claude-haiku-5-5 {"identity_mismatch": 0.5, "metadata_naming": 0.4}; claude-sonnet-5-5 {"metadata_naming": 0.6}; claude-opus-5-5 (none); gpt-6-luna {"decoder_incompatible": 0.6, "healthy": 0.5385, "identity_mismatch": 0.5, "metadata_naming": 0.4}; qwen3.8:27b (none); muse-glimmer:30b {"metadata_naming": 0.6}.

| Media (correct/n) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| movie | 10/13 / 11/13 | 11/13 / 11/13 | 11/13 / 11/13 | 7/13 / 9/13 | 12/13 / 13/13 | 13/13 / 12/13 |
| tv | 17/19 / 17/19 | 17/19 / 17/19 | 18/19 / 17/19 | 14/19 / 17/19 | 17/19 / 17/19 | 17/19 / 17/19 |
| epub | 13/18 / 16/18 | 16/18 / 17/18 | 17/18 / 18/18 | 12/18 / 15/18 | 17/18 / 17/18 | 16/18 / 16/18 |
| audiobook | 9/11 / 10/11 | 9/11 / 10/11 | 11/11 / 10/11 | 8/11 / 6/11 | 10/11 / 10/11 | 10/11 / 10/11 |

| Measure (dev-c4 / dev-c3) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| False diagnoses | 0 / 1 | 3 / 3 | 3 / 2 | 3 / 4 | 6 / 11 | 10 / 13 |
| False abstention on solvable (G5) | 16.3% / 8.2% | 10.2% / 6.1% | 4.1% / 6.1% | 30.6% / 18.4% | 2.0% / 2.0% | 0.0% / 0.0% |
| Escalate rate, all cases | 38.4% / 28.8% | 28.8% / 24.7% | 21.9% / 24.7% | 45.2% / 32.9% | 20.5% / 11.0% | 15.1% / 9.6% |

False diagnosis case ids (dev-c4):

- claude-haiku-5-5: (none)
- claude-sonnet-5-5: audiobook-naming-001, epub-identity-004, tv-insuff-003
- claude-opus-5-5: epub-identity-004, movie-insuff-001, tv-insuff-002
- gpt-6-luna: epub-identity-004, movie-naming-001, tv-healthy-005
- qwen3.8:27b: audiobook-naming-001, epub-identity-004, tv-corrupt-003, tv-healthy-007, tv-insuff-002, tv-insuff-003
- muse-glimmer:30b: audiobook-insuff-001, audiobook-naming-001, epub-identity-004, epub-naming-001, movie-insuff-001, tv-corrupt-003, tv-healthy-007, tv-insuff-001, tv-insuff-002, tv-insuff-003

## 4. Decisions on the 13 negative controls and the 12 insufficient_evidence cases (dev-c4)

Cell = `class/action` of the final decision (`*` = forced). Accepted classes and supported actions are the suite's. A healthy decision is correct only with action `none`; on an insufficient_evidence truth the supported set is `escalate`.

### Negative controls (truth healthy) (13)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-healthy-002 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| audiobook-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| epub-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| epub-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| epub-healthy-006 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| movie-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | order_edition_ambiguity/escalate | healthy/none | healthy/none |
| movie-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-healthy-002 | healthy | none | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-005 | healthy | none | healthy/none | healthy/none | healthy/none | metadata_naming/none | healthy/none | healthy/none |
| tv-healthy-006 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-007 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | order_edition_ambiguity/none | identity_mismatch/blocklist_and_search |

Left alone (action `none`, the G2 test), dev-c4: haiku 12/13; sonnet 12/13; opus 12/13; luna 8/13; qwen 13/13; muse 12/13.

Left alone (action `none`, the G2 test), dev-c3: haiku 12/13; sonnet 12/13; opus 12/13; luna 8/13; qwen 12/13; muse 12/13.

Correct (class `healthy` and action `none`, the per-class count of section 3), dev-c4: haiku 12/13; sonnet 12/13; opus 12/13; luna 7/13; qwen 12/13; muse 12/13.

### insufficient_evidence cases (12)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| audiobook-insuff-001 | insufficient_evidence,metadata_naming | escalate | metadata_naming/escalate | insufficient_evidence/escalate | metadata_naming/escalate | metadata_naming/escalate | metadata_naming/escalate | identity_mismatch/blocklist_and_search |
| epub-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| epub-healthy-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| epub-insuff-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| movie-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| movie-healthy-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| movie-insuff-001 | insufficient_evidence,order_edition_ambiguity | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | identity_mismatch/blocklist_and_search | order_edition_ambiguity/escalate | order_edition_ambiguity/escalate | identity_mismatch/blocklist_and_search |
| tv-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| tv-insuff-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none |
| tv-insuff-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-insuff-003 | insufficient_evidence | escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | identity_mismatch/blocklist_and_search |

Escalated, dev-c4: haiku 12/12; sonnet 11/12; opus 10/12; luna 12/12; qwen 10/12; muse 7/12.

Escalated, dev-c3: haiku 12/12; sonnet 11/12; opus 11/12; luna 10/12; qwen 4/12; muse 5/12.

G4 detail from the scorer (`value` is the share of the 15 G4 cases handled appropriately; it also counts order_edition_ambiguity cases): haiku 100.0% PASS; sonnet 86.7% FAIL; opus 86.7% FAIL; luna 100.0% PASS; qwen 80.0% FAIL; muse 60.0% FAIL.

### Non-healthy truth that also accepts healthy (not negative controls)

| Case | Truth | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|---|
| audiobook-order-001 | order_edition_ambiguity | order_edition_ambiguity,healthy | escalate,none | order_edition_ambiguity/escalate | healthy/none | order_edition_ambiguity/escalate | order_edition_ambiguity/escalate | healthy/none | healthy/none |
| epub-healthy-005 | metadata_naming | metadata_naming,healthy | rename,none,escalate | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |

### metadata_naming and decoder_incompatible cases (dev-c4 decisions; dev-c3 in brackets)

Cell = `class/action` (`*` = forced); a decision is correct when its class is accepted and its action is supported. `ok` / `X` marks that for dev-c4.

#### Truth metadata_naming (5 cases)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-naming-001 | metadata_naming | rename | metadata_naming/escalate X [healthy/none] | healthy/none X [healthy/none] | metadata_naming/rename ok [healthy/none] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | healthy/none X [healthy/none] | healthy/none X [healthy/none] |
| epub-healthy-005 | metadata_naming,healthy | rename,none,escalate | healthy/none ok [metadata_naming/rename] | healthy/none ok [healthy/none] | healthy/none ok [healthy/none] | healthy/none ok [healthy/none] | healthy/none ok [healthy/none] | healthy/none ok [healthy/none] |
| epub-naming-001 | metadata_naming | rename | metadata_naming/escalate X [metadata_naming/rename] | insufficient_evidence/escalate X [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | insufficient_evidence/escalate X [metadata_naming/escalate] | metadata_naming/rename ok [metadata_naming/rename] | identity_mismatch/blocklist_and_search X [identity_mismatch/blocklist_and_search] |
| movie-naming-001 | metadata_naming | rename | metadata_naming/escalate X [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | healthy/none X [healthy/none] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] |
| tv-naming-001 | metadata_naming | rename | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] |

Decision classes, dev-c4: haiku: healthy 1, metadata_naming 4; sonnet: healthy 2, insufficient_evidence 1, metadata_naming 2; opus: healthy 1, metadata_naming 4; luna: healthy 2, insufficient_evidence 2, metadata_naming 1; qwen: healthy 2, metadata_naming 3; muse: healthy 2, identity_mismatch 1, metadata_naming 2.

#### Truth decoder_incompatible (5 cases)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| movie-decoder-001 | decoder_incompatible | convert | insufficient_evidence/escalate X [insufficient_evidence/escalate] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | decoder_incompatible/escalate X [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] |
| movie-decoder-002 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/escalate] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] |
| movie-outcome-001 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] |
| movie-outcome-002 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/escalate X [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] |
| tv-decoder-001 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] |

Decision classes, dev-c4: haiku: decoder_incompatible 4, insufficient_evidence 1; sonnet: decoder_incompatible 4, insufficient_evidence 1; opus: decoder_incompatible 4, insufficient_evidence 1; luna: decoder_incompatible 4, insufficient_evidence 1; qwen: decoder_incompatible 5; muse: decoder_incompatible 5.

## 5. Latency, usage and cost (dev-c4; dev-c3 in brackets)

| Model | Case latency p50 / p95 / max (s) | Tokens as reported | Cost |
|---|---|---|---|
| claude-haiku-5-5 | 7.2 / 12.4 / 14.4 [6.6 / 12.2 / 14.8] | 204 in / 81,265 out [210 / 73,653] | $0.0755 [$0.0734] |
| claude-sonnet-5-5 | 8.3 / 18.8 / 28.1 [5.9 / 11.5 / 25.4] | 244 in / 47,382 out [216 / 39,991] | $1.3077 [$1.1256] |
| claude-opus-5-5 | 10.2 / 23.7 / 28.2 [7.3 / 16.7 / 29.1] | 262 in / 50,710 out [216 / 41,534] | $2.8546 [$2.2983] |
| gpt-6-luna | 8.2 / 26.1 / 36.3 [4.6 / 32.0 / 38.2] | 3,824,668 in / 15,595 out [3,329,187 / 14,405] | not reported [not reported] |
| qwen3.8:27b | 4.2 / 7.6 / 9.8 [4.3 / 7.7 / 9.1] | 348,722 in / 13,980 out [367,311 / 14,594] | not reported [not reported] |
| muse-glimmer:30b | 9.9 / 13.3 / 14.9 [10.9 / 15.5 / 18.7] | 653,291 in / 16,289 out [832,977 / 17,876] | not reported [not reported] |

Total reported Claude API-equivalent cost of the three Claude runs: $4.2378 (Codex and Ollama report none). Hosted-model token counts are as the CLIs report them (Claude cache tokens are not in `input_tokens`). G9 p95 is the gate value in section 2.

### Ollama prompt size (num_ctx 8192)

| Model | Max `prompt_eval_count` | Case of the max | Max estimated prompt tokens | Turns with a reported count | Records with any `context_check` flag (truncated_suspected, prompt_at_context_limit, context_full_after_generation, estimated_prompt_exceeds_context) | Flag counts (records; `output_hit_num_predict` is not a truncation flag) | `context_check.num_ctx` | Records without `context_check` |
|---|---|---|---|---|---|---|---|---|
| qwen3.8:27b | 3804 | tv-identity-004 | 4975 | 111 | 0 | - | 8192 | 0 |
| muse-glimmer:30b | 3955 | tv-healthy-003 | 5276 | 202 | 0 | - | 8192 | 0 |

`prompt_eval_count` is the count Ollama reports for each `/api/chat` request; it excludes tokens served from the prompt cache, so the harness also records a character-based estimate (`prompt_tokens_estimated`) and flags a turn `truncated_suspected` when either points at the window. The stop threshold was 8000 reported tokens against a window of 8192.

## 6. Tool calls: status and modes

`organic_failures` counts `error`, `timeout` and `partial` only, not `unavailable` (CONTRACT-v1.1 section 3); use `calls_by_status`.

| Model | calls_by_status (dev-c4) | calls_by_status (dev-c3) | organic_failures dev-c4 | organic_failures dev-c3 | Native tool use items (dev-c4) |
|---|---|---|---|---|---|
| claude-haiku-5-5 | error 4, ok 20, timeout 1, unavailable 3 | error 6, ok 20, partial 1, unavailable 4 | 1 | 3 | 0 |
| claude-sonnet-5-5 | error 7, ok 32, partial 1, timeout 3, unavailable 5 | error 6, ok 23, timeout 1, unavailable 5 | 4 | 3 | 0 |
| claude-opus-5-5 | error 7, ok 42, partial 1, timeout 1, unavailable 4 | error 4, ok 24, unavailable 4 | 4 | 1 | 0 |
| gpt-6-luna | error 7, ok 36, partial 1, unavailable 2 | error 4, ok 29, unavailable 3 | 5 | 2 | 0 |
| qwen3.8:27b | error 7, ok 24, partial 1, timeout 2, unavailable 4 | error 5, ok 16, partial 1, unavailable 7 | 6 | 4 | 0 |
| muse-glimmer:30b | error 20, ok 103, partial 2, timeout 1, unavailable 3 | error 18, ok 112, partial 1, timeout 1, unavailable 21 | 17 | 15 | 0 |

| Model | tool_calls[].mode distribution | evidence_mode of calls | remote or local (live) tool calls | Total tool calls |
|---|---|---|---|---|
| claude-haiku-5-5 | injected 4, pinned_replay 3, replay 20, stub 1 | replay 28 | 0 | 28 |
| claude-sonnet-5-5 | injected 7, pinned_replay 5, replay 33, stub 3 | replay 48 | 0 | 48 |
| claude-opus-5-5 | None 2, injected 5, pinned_replay 4, replay 41, stub 3 | replay 55 | 0 | 55 |
| gpt-6-luna | None 5, injected 3, pinned_replay 3, replay 32, stub 3 | replay 46 | 0 | 46 |
| qwen3.8:27b | None 2, injected 4, pinned_replay 6, replay 23, stub 3 | replay 38 | 0 | 38 |
| muse-glimmer:30b | None 18, injected 6, pinned_replay 6, replay 73, stub 26 | replay 129 | 0 | 129 |

## 7. Schema validity (G7) and first-try failure modes

| Model | First-try valid (of 73) dev-c4 / dev-c3 | Repaired | Forced | Protocol violations dev-c4 (tool not offered) | Adapter errors | Crashes | First-try failure modes dev-c4 (record counts) | First-try failure modes dev-c3 |
|---|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 72 / 72 | 1 / 1 | 0 / 0 | 0 | 0 | 0 | - | - |
| claude-sonnet-5-5 | 72 / 73 | 1 / 0 | 0 / 0 | 0 | 0 | 0 | - | - |
| claude-opus-5-5 | 70 / 70 | 3 / 3 | 0 / 0 | 0 | 0 | 0 | audit_malformed 2, wrong_keys 3 | wrong_keys 3 |
| gpt-6-luna | 71 / 71 | 1 / 1 | 0 / 0 | 1 | 0 | 0 | audit_missing 1, tool_not_offered 1 | empty_reply 1, tool_not_offered 1 |
| qwen3.8:27b | 73 / 73 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | - | - |
| muse-glimmer:30b | 73 / 62 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | - | tool_not_offered 11 |

### Injected failures (G8), dev-c4

| Injected failure case (dev-v1.1) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | handled | handled | handled | handled | handled | handled |
| epub-insuff-001 | handled | handled | handled | handled | handled | handled |
| movie-corrupt-003 | handled | handled | handled | handled | handled | handled |
| tv-identity-004 | handled | handled | handled | handled | handled | handled |
| tv-insuff-002 | handled | handled | FAIL (decision not ok) | handled | FAIL (decision not ok) | FAIL (decision not ok) |

G8 value dev-c4 / dev-c3: haiku 100.0% PASS / 100.0% PASS; sonnet 100.0% PASS / 100.0% PASS; opus 80.0% FAIL / 100.0% PASS; luna 100.0% PASS / 100.0% PASS; qwen 80.0% FAIL / 80.0% FAIL; muse 80.0% FAIL / 80.0% FAIL.

## 8. Digests and run state

| Model | Started (UTC) | Finished (UTC) | Aborted | Guard tripped | Records | Crashes |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 2026-10-20T12:13:06 | 2026-10-20T12:22:13.329029+00:00 | None | n/a (hosted) | 73 | 0 |
| claude-sonnet-5-5 | 2026-10-20T12:22:13 | 2026-10-20T12:33:22.881656+00:00 | None | n/a (hosted) | 73 | 0 |
| claude-opus-5-5 | 2026-10-20T12:33:23 | 2026-10-20T12:46:36.939414+00:00 | None | n/a (hosted) | 73 | 0 |
| gpt-6-luna | 2026-10-20T12:46:37 | 2026-10-20T12:58:52.774405+00:00 | None | n/a (hosted) | 73 | 0 |
| qwen3.8:27b | 2026-10-20T12:59:43 | 2026-10-20T13:05:20.995575+00:00 | None | None | 73 | 0 |
| muse-glimmer:30b | 2026-10-20T13:06:04 | 2026-10-20T13:17:34.825695+00:00 | None | None | 73 | 0 |

## 9. Process notes

- **Harness code (frozen dev-c4).** Every run executed the packaged harness (`python3 -B -m media_repair_harness.run`, `PYTHONPATH=<worktree>/tools/media-repair-harness/src`) from a clean detached worktree of `f38f605b56083491273e391d345f0a05233a9f4e` (PR #1021; `git status` clean, `dirty: false`, `harness_git` = that commit in every manifest and record, `harness_version` `dev-c4`). The evaluation worktree was a separate branch off `origin/main`, which is that same commit. `-I` was not used for the runner because it ignores `PYTHONPATH`. Output was written outside the worktree and copied to `runs/` afterwards (`_runner.stdout`/`_runner.stderr` hold the console output). `prompts/v4.txt` sha256 was verified as `48bad0e41baa113df432545566a34d3bc0d01e2c5bd0f27fe0bcedb923c73a8a` in the frozen worktree before the first run, and every one of the 438 scored records carries the assembled `system_prompt_sha256` `a2c3036e57d243a1c892b844a37796ec026e4ea449c4737bcbc3efd01591eedd`.
- **Configuration under test.** `--prompt v4 --guards v2 --evidence replay --split dev` on `suite-dev-v1.1` (73 cases, one run per case and model, serial, `nice -n 19`, stdin `/dev/null`), in the order haiku, sonnet, opus, luna, qwen, muse. Ollama runs added `--num-ctx 8192 --keep-alive 2m`. No `--effort` flag, as in dev-c3. `guards: v2` is in every manifest `config` and in every record's `guard.version`.
- **Suite and scorer identity.** `git diff bc64d44f` over `suite-dev-v1.1` was empty (byte-identical to main `bc64d44f`, the dev-c3 evaluator state). `harness/score.py` sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, equal to the value in the work order. The scorer was loaded as in the dev-c3 run: `python3 -B -m media_repair_harness.score_compat <run> --suite <suite-dev-v1.1>` with `MRH_SCORE_PY` set to the evaluator's `score.py`, no copy, no edit (the frozen package's loader only aliases `protocol` and `run` to its own modules for the import). `score.py` uses exactly `P.CLASSES`, `P.WRITE_ACTIONS` and `R.load_cases`; their source segments, parsed with `ast`, in the dev-c4 package are identical to those in dev-c2 `e27f2385`'s `harness/protocol.py` and `harness/run.py` (all three `True`). No scorer error on any dev-c4 record; exit code 1 means overall FAIL.
- **Guards-off view (secondary diagnostic) and its restore method.** Each recorded run was left untouched. For each, `python3 -B -m media_repair_harness.guard_cli <run dir> --suite <suite-dev-v1.1> --out <run dir>-guardsoff --restore` wrote a COPY to `runs/<run id>-guardsoff/` with the model's original decisions (`guard.applied[].original`) put back and the fields derived from them recomputed (no model call; the tool refuses a record whose `case_sha256` differs from the suite, and none did). The copy was scored with the same unchanged scorer through `score_compat`. The tool prints the label "guards v1" on a restore; that is its default version label, no guard was applied in restore mode. The coordinator's scoring-integrity addendum (score.py reads only the guarded `rec['decision']`) is addressed in sections 2a to 2c of the report: both gate tables, every guard-hidden write with the unsafe verdict, guard-made escalates per rule, the G8 comparison and the in-sample note. The "unsafe" verdict for a hidden write restates `score.py` lines 102-108 in `make_report.py` (`is_unsafe`) and is asserted equal to the difference between the guards-off and guarded G1 case lists, for every model.
- **Hosted model identity.** A cheap live probe (`claude --model <id> -p 'reply with only your exact model id'`) returned `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5` before the passes. `codex exec -m gpt-6-luna` answered the same question with `gpt-6-astra` (a self-report, which follows the pod's instructions and not the serving model); the codex session file for that probe recorded `"model":"gpt-6-luna"`, and every run record's `response_model_ids` equals the requested id in all runs. The codex probe ran with `< /dev/null`.
- **Smoke runs (labelled, unscored).** `evaldevc4v11-smoke-claude-haiku-5-5-v4g2` (`tv-corrupt-001`, `tv-healthy-002`) before the Claude passes. For Ollama, the two dev-v1.1 cases with the most tool calls in the dev-c3 evaluator run of that model (ties broken by case id): qwen3.8:27b `tv-insuff-001` (5), `tv-healthy-002` (4); muse-glimmer:30b `movie-healthy-004`, `tv-insuff-002` (4 each). Max reported `prompt_eval_count` 3591 (qwen) and 3645 (muse); no `context_check` flag, so neither model was stopped.
- **Ollama Prime rules observed.** Before the local batch: `declare-activity list` showed nothing declared, `/api/ps` was empty, the pod `ollama-prime-bc7bc7856-zgzjb` had uid `73271983-b7af-4824-893c-26990c989329` and restart count 1; no waiting was needed. `declare-activity start "mrh dev-c4 on dev-v1.1 qwen+muse" --scope ai,ollama-prime --ttl 2h` (`act-125911-3466486`) wrapped the batch and was ended afterwards. Options as the adapter sets them: `num_ctx 8192` (passed as `--num-ctx 8192` on every invocation, `context_check.num_ctx` 8192 in all 146 records), `use_mmap false`, temperature 0, seed 42, `think false`, `keep_alive 2m`, 900 s warm-up. PSI/restart guard on (30 s samples, threshold 0.20 for 2 samples, restart-count change): `tripped: null`, max PSI rate 0.0 in both full passes; pod uid and restart count unchanged after the batch; `/api/ps` empty after each run (`residents_after` empty). No pulls. Digests equal the checkpoint 1 digests (section 1). Max `prompt_eval_count` across the full passes: 3804 (qwen) and 3955 (muse); records with any `context_check` flag: 0 and 0. Ollama server 0.40.6.
- **Tooling:** Claude Code 2.1.299, Codex CLI 0.162.1, Python 3.11.2. ffprobe and ffmpeg were not used (replay evidence).
- **Crashes and re-runs.** No case crashed, aborted, was forced, or was re-run. All records are kept, including the labelled smoke runs and the `-guardsoff` copies.
- **Harness unit tests, once, serial, nice 19, at the frozen commit:** `MRH_REQUIRE_SUITE=1 tools/media-repair-harness/scripts/ci-test.sh` ran 510 tests, 510 passed, 0 failures (11.0 s).
- **Off-limits locations** (`heldout/`, `~/.cache/media-repair-harness-1019/`, `ADJUDICATION*.md`, the dev-c3 held-out assessment folder) had their contents left unopened (only directory names appeared in a parent listing).
- **Cost:** the three Claude runs reported $4.2378 in total (haiku $0.0755, sonnet $1.3077, opus $2.8546); codex ran once (no cost reported); Ollama about 6 min (qwen) and 12 min (muse) of GPU time for the full passes plus the smoke runs.
- **Observations for the reader (factual, no recommendation).** Guards v2 changed 13 decisions in total: 1 G-write (haiku `epub-identity-003`, an original `identity_mismatch/blocklist_and_search` that was correct) and 6 G-healthy each on qwen and muse; none on sonnet, opus or luna. No guard hid an unsafe write (hidden unsafe writes: 0 for every model), so G1 is the same with and without guards. G8 is identical with and without guards for every model. The G-healthy effect on G4 (qwen 40.0% to 80.0%, muse 20.0% to 60.0%) is in-sample: the rule was designed after per-case dev results on this suite.

