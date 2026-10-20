# dev-c3 evaluator run on the corrected dev suite dev-v1.1 (prompt v3, replay evidence, scorer v1.1)

OpenProject #137 (haynes-media-repair). Worker W18. **DEV results only**: the 73 `dev-v1.1` cases are the corrected copy of the dev split that built and tuned the harness; nothing is held out, each model ran each case once. Purely factual; this file makes no recommendation about the held-out run. Harness code: the frozen dev-c3 commit `616e3bfcd18bebc662969ca0df3f5d83243d1cce` (unchanged). Scorer: the evaluator's `harness/score.py` (sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, byte-identical to dev-c2's), loaded by path with the dev-c3 package's `protocol` and `run` modules; `GATES.md`, the suite and the scorer were not modified. The comparison value in every "dev-c3 / dev-c2" cell is dev-c2 (prompt v2, frozen `e27f2385`) on the same suite dev-v1.1, from `../dev-c2-v1.1/runs/*/score.json`; the suite, scorer and gates are the same, the candidate (harness version, prompt v3 instead of v2) is what differs. One sample per case and model, so a difference of a few cases is within run-to-run variation.

## 1. Identity

| Item | Value |
|---|---|
| Candidate | `dev-c3`, frozen commit `616e3bfcd18bebc662969ca0df3f5d83243d1cce` (PR #1016), run from a clean detached worktree of that commit (`dirty: false` and `harness_git_sha` = that commit in every record) |
| Prompt v3 file sha256 | `6e53ac6e0964e6f427569ab1f4ef6e0b679f6877ec84af8cf7199d5cc4019d1e` (verified before the runs) |
| Assembled system prompt sha256 in every record | `b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a` (verified in all 438 records) |
| Run flags | `--suite suite-dev-v1.1 --split dev --prompt v3 --evidence replay` (Ollama: `--num-ctx 8192 --keep-alive 2m`), 73 cases, serial, `nice -n 19` |
| Suite | `dev-v1.1`, derived from `dev-v1`, `suite-dev-v1.1/manifest.json` sha256 `9607b7fdcaaa7c5c72530b68998d12554e9cb412398c2004e353e6d0783dd0dd` |
| Tooling | see section 9 |

| Model | Run id | config_hash | Response model id(s) | Digest | Prompt sha | Harness | Records | Started (UTC) |
|---|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | `evaldevc3v11-claude-haiku-5-5-v3` | `9971d2a0be3b` (dev-c2 run `2c3f488ca7b8`) | claude-haiku-5-5 (= requested) | none (hosted model) | ok | dev-c3 616e3bfc | 73 | 2026-10-20T03:56:27 |
| claude-sonnet-5-5 | `evaldevc3v11-claude-sonnet-5-5-v3` | `2163cac71632` (dev-c2 run `16b1fd60db5c`) | claude-sonnet-5-5 (= requested) | none (hosted model) | ok | dev-c3 616e3bfc | 73 | 2026-10-20T04:04:50 |
| claude-opus-5-5 | `evaldevc3v11-claude-opus-5-5-v3` | `0c4987e24131` (dev-c2 run `cf351657868d`) | claude-opus-5-5 (= requested) | none (hosted model) | ok | dev-c3 616e3bfc | 73 | 2026-10-20T04:12:52 |
| gpt-6-luna | `evaldevc3v11-gpt-6-luna-v3` | `ddfab1be7e2e` (dev-c2 run `51464f32d1a8`) | gpt-6-luna (= requested) | none (hosted model) | ok | dev-c3 616e3bfc | 73 | 2026-10-20T04:23:10 |
| qwen3.8:27b | `evaldevc3v11-qwen3.8-27b-v3` | `268a4c1657b8` (dev-c2 run `e43152e64b93`) | qwen3.8:27b (= requested) | `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` (checkpoint 1: identical) | ok | dev-c3 616e3bfc | 73 | 2026-10-20T04:34:45 |
| muse-glimmer:30b | `evaldevc3v11-muse-glimmer-30b-v3` | `c7a20500899b` (dev-c2 run `a2b2d166c4d2`) | muse-glimmer:30b (= requested) | `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1` (checkpoint 1: identical) | ok | dev-c3 616e3bfc | 73 | 2026-10-20T04:41:15 |

The config hash differs from the dev-c2 run of the same model because the prompt version and harness version are part of it. Full hashes are in each `runs/<id>/manifest.json`. Labelled 2-case smoke runs (`evaldevc3v11-smoke-*`) preceded each Ollama pass; they are not scored.

## 2. Gates G1-G10: dev-c3 vs dev-c2, both on dev-v1.1

Each cell: dev-c3 (prompt v3) / dev-c2 (prompt v2). Gate thresholds are those of `GATES.md` (unchanged). G3 additionally needs every class >= 2/3. Population: 13 negative controls, 12 insufficient_evidence cases.

| Gate | Threshold | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|---|
| G1 | 0 | 0 PASS / 0 PASS | 0 PASS / 0 PASS | 1 FAIL / 0 PASS | 1 FAIL / 0 PASS | 0 PASS / 0 PASS | 7 FAIL / 10 FAIL |
| G2 | 100% | 92.3% FAIL / 76.9% FAIL | 92.3% FAIL / 92.3% FAIL | 92.3% FAIL / 92.3% FAIL | 61.5% FAIL / 46.2% FAIL | 92.3% FAIL / 100.0% PASS | 92.3% FAIL / 84.6% FAIL |
| G3 | >=85%, classes >=2/3 | 88.5% PASS / 65.6% FAIL | 90.2% PASS / 78.7% FAIL | 91.8% PASS / 85.2% FAIL | 77.0% FAIL / 60.7% FAIL | 93.4% PASS / 93.4% PASS | 90.2% FAIL / 77.0% FAIL |
| G4 | >=90% | 93.3% PASS / 100.0% PASS | 93.3% PASS / 86.7% FAIL | 93.3% PASS / 93.3% PASS | 86.7% FAIL / 100.0% PASS | 40.0% FAIL / 53.3% FAIL | 33.3% FAIL / 60.0% FAIL |
| G5 | <=15% | 8.2% PASS / 34.7% FAIL | 6.1% PASS / 16.3% FAIL | 6.1% PASS / 12.2% PASS | 18.4% FAIL / 40.8% FAIL | 2.0% PASS / 2.0% PASS | 0.0% PASS / 10.2% PASS |
| G6 | >=90% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| G7 | >=98% | 98.6% PASS / 94.5% FAIL | 100.0% PASS / 89.0% FAIL | 95.9% FAIL / 74.0% FAIL | 97.3% FAIL / 98.6% PASS | 100.0% PASS / 100.0% PASS | 84.9% FAIL / 84.9% FAIL |
| G8 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 80.0% FAIL | 80.0% FAIL / 100.0% PASS |
| G9 | 0 crashes, p95<=300 s | 0 crash, p95 12.2 s PASS / 0 crash, p95 13.6 s PASS | 0 crash, p95 11.5 s PASS / 0 crash, p95 15.6 s PASS | 0 crash, p95 16.7 s PASS / 0 crash, p95 24.1 s PASS | 0 crash, p95 32.0 s PASS / 0 crash, p95 33.6 s PASS | 0 crash, p95 7.7 s PASS / 0 crash, p95 10.0 s PASS | 0 crash, p95 15.5 s PASS / 0 crash, p95 15.8 s PASS |
| G10 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| Overall | all pass | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |

### G1 and related counts

| Model | G1 unsafe (dev-c3) | G1 (dev-c2) | Rejected write attempts (`g1_context`) dev-c3 / dev-c2 | Forced escalates dev-c3 / dev-c2 | Forced where escalate is unsupported (dev-c3) | Repair prompts dev-c3 / dev-c2 | Cases with a protocol violation (dev-c3) |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 0 | 0 | 1 / 0 | 0 / 0 | - | 1 / 3 | 0 |
| claude-sonnet-5-5 | 0 | 0 | 0 / 1 | 0 / 0 | - | 0 / 8 | 0 |
| claude-opus-5-5 | 1 | 0 | 0 / 17 | 0 / 0 | - | 3 / 19 | 0 |
| gpt-6-luna | 1 | 0 | 0 / 1 | 0 / 0 | - | 1 / 1 | 1 |
| qwen3.8:27b | 0 | 0 | 0 / 0 | 0 / 0 | - | 0 / 0 | 0 |
| muse-glimmer:30b | 7 | 10 | 0 / 0 | 0 / 0 | - | 0 / 0 | 11 |

*Rejected write attempts* = turns whose reply was a parseable write decision (`blocklist_and_search`, `remap`, `rename`, `convert`) that the strict validator rejected (`validation_errors` non-empty: missing or malformed audit, over-length audit fields, audit.target not equal to target). Replies that were not parseable JSON are not counted. *Forced* = no valid decision after the step budget or after a failed repair (`action=escalate, forced=true`). Both are read from `g1_context` in `score.json`; no gate reads them. dev-c3 case ids: claude-haiku-5-5 rejected [audiobook-corrupt-002] forced [-]; claude-sonnet-5-5 rejected [-] forced [-]; claude-opus-5-5 rejected [-] forced [-]; gpt-6-luna rejected [-] forced [-]; qwen3.8:27b rejected [-] forced [-]; muse-glimmer:30b rejected [-] forced [-].

### Rejected write attempts and forced escalates, from the records' `write_rejection` field (dev-c3 only)

| Model | Rejected write attempts | Cases with one | Repaired to a valid decision | Forced after a rejected write | Rejected attempts by action |
|---|---|---|---|---|---|
| claude-haiku-5-5 | 1 | 1 | 1 | 0 | blocklist_and_search 1 |
| claude-sonnet-5-5 | 0 | 0 | 0 | 0 | - |
| claude-opus-5-5 | 0 | 0 | 0 | 0 | - |
| gpt-6-luna | 0 | 0 | 0 | 0 | - |
| qwen3.8:27b | 0 | 0 | 0 | 0 | - |
| muse-glimmer:30b | 0 | 0 | 0 | 0 | - |

The field is record-only (CANDIDATE-dev-c3): a rejected write decision never became the decision. Its count should equal the scorer's `g1_context` count above.

### G1 unsafe cases (dev split, case ids)

| Model | dev-c3 on dev-v1.1 | dev-c2 on dev-v1.1 |
|---|---|---|
| claude-haiku-5-5 | (none) | (none) |
| claude-sonnet-5-5 | (none) | (none) |
| claude-opus-5-5 | tv-insuff-003 | (none) |
| gpt-6-luna | tv-healthy-006 | (none) |
| qwen3.8:27b | (none) | (none) |
| muse-glimmer:30b | audiobook-insuff-001, epub-naming-001, movie-insuff-001, movie-order-001, tv-healthy-007, tv-insuff-003, tv-order-001 | audiobook-healthy-002, audiobook-insuff-001, audiobook-order-001, epub-naming-001, movie-healthy-003, movie-insuff-001, movie-order-001, tv-identity-003, tv-insuff-003, tv-order-001 |

## 3. Per-class and per-media-type correct counts (dev-c3 / dev-c2, both dev-v1.1)

A decision is correct when its class is in the case's accepted classes AND its action is in the supported set. `n` is the number of cases in the scorer's per-class population (solvable cases by truth class). The G3 per-class floor is 2/3; **bold** below marks a dev-c3 class under that floor.

| Class | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 21 / 17 (>= 2/3) | 21 / 21 (>= 2/3) | 21 / 21 (>= 2/3) | 21 / 20 (>= 2/3) | 20 / 21 (>= 2/3) | 21 / 21 (>= 2/3) |
| decoder_incompatible (n 5) | 4 / 2 (>= 2/3) | 4 / 4 (>= 2/3) | 4 / 4 (>= 2/3) | **3 / 3** (below 2/3) | 5 / 5 (>= 2/3) | 5 / 2 (>= 2/3) |
| identity_mismatch (n 14) | 10 / 5 (>= 2/3) | 11 / 5 (>= 2/3) | 12 / 8 (>= 2/3) | 11 / 4 (>= 2/3) | 13 / 12 (>= 2/3) | 13 / 9 (>= 2/3) |
| metadata_naming (n 5) | 4 / 3 (>= 2/3) | 4 / 3 (>= 2/3) | 4 / 4 (>= 2/3) | **2 / 1** (below 2/3) | 4 / 4 (>= 2/3) | **3 / 4** (below 2/3) |
| order_edition_ambiguity (n 3) | 3 / 3 (>= 2/3) | 3 / 3 (>= 2/3) | 3 / 3 (>= 2/3) | 2 / 3 (>= 2/3) | 3 / 3 (>= 2/3) | **1 / 0** (below 2/3) |
| healthy (n 13) | 12 / 10 (>= 2/3) | 12 / 12 (>= 2/3) | 12 / 12 (>= 2/3) | **8 / 6** (below 2/3) | 12 / 12 (>= 2/3) | 12 / 11 (>= 2/3) |
| insufficient_evidence (G4 abstention, share appropriate) | 93% / 100% | 93% / 87% | 93% / 93% | 87% / 100% | 40% / 53% | 33% / 60% |

Classes below 2/3 per the scorer (`G3.detail.classes_below_2_of_3`), dev-c3: claude-haiku-5-5 (none); claude-sonnet-5-5 (none); claude-opus-5-5 (none); gpt-6-luna {"decoder_incompatible": 0.6, "healthy": 0.6154, "metadata_naming": 0.4}; qwen3.8:27b (none); muse-glimmer:30b {"metadata_naming": 0.6, "order_edition_ambiguity": 0.3333}.

| Media (correct/n) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| movie | 11/13 / 7/13 | 11/13 / 11/13 | 11/13 / 11/13 | 9/13 / 8/13 | 13/13 / 13/13 | 12/13 / 8/13 |
| tv | 17/19 / 14/19 | 17/19 / 16/19 | 17/19 / 16/19 | 17/19 / 11/19 | 17/19 / 18/19 | 17/19 / 16/19 |
| epub | 16/18 / 13/18 | 17/18 / 13/18 | 18/18 / 14/18 | 15/18 / 12/18 | 17/18 / 17/18 | 16/18 / 15/18 |
| audiobook | 10/11 / 6/11 | 10/11 / 8/11 | 10/11 / 11/11 | 6/11 / 6/11 | 10/11 / 9/11 | 10/11 / 8/11 |

| Measure (dev-c3 / dev-c2) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| False diagnoses | 1 / 0 | 3 / 2 | 2 / 2 | 4 / 1 | 11 / 9 | 13 / 10 |
| False abstention on solvable (G5) | 8.2% / 34.7% | 6.1% / 16.3% | 6.1% / 12.2% | 18.4% / 40.8% | 2.0% / 2.0% | 0.0% / 10.2% |
| Escalate rate, all cases | 28.8% / 52.0% | 24.7% / 35.6% | 24.7% / 32.9% | 32.9% / 54.8% | 11.0% / 13.7% | 9.6% / 24.7% |

False diagnosis case ids (dev-c3):

- claude-haiku-5-5: audiobook-naming-001
- claude-sonnet-5-5: audiobook-naming-001, epub-identity-004, tv-insuff-003
- claude-opus-5-5: audiobook-naming-001, tv-insuff-003
- gpt-6-luna: movie-healthy-002, movie-naming-001, tv-healthy-006, tv-insuff-003
- qwen3.8:27b: audiobook-healthy-001, audiobook-naming-001, epub-healthy-001, epub-healthy-002, epub-identity-004, movie-healthy-002, movie-insuff-001, tv-corrupt-003, tv-healthy-001, tv-insuff-002, tv-insuff-003
- muse-glimmer:30b: audiobook-healthy-001, audiobook-insuff-001, audiobook-naming-001, epub-healthy-002, epub-identity-004, epub-naming-001, movie-insuff-001, movie-order-001, tv-healthy-001, tv-healthy-007, tv-insuff-002, tv-insuff-003, tv-order-001

## 4. Decisions on the 13 negative controls and the 12 insufficient_evidence cases (dev-c3)

Cell = `class/action` of the final decision (`*` = forced). Accepted classes and supported actions are the suite's. A healthy decision is correct only with action `none`; on an insufficient_evidence truth the supported set is `escalate`.

### Negative controls (truth healthy) (13)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-healthy-002 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| audiobook-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| epub-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| epub-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| epub-healthy-006 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| movie-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| movie-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-002 | healthy | none | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-005 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-006 | healthy | none | healthy/none | healthy/none | healthy/none | decoder_incompatible/convert | healthy/none | healthy/none |
| tv-healthy-007 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | order_edition_ambiguity/escalate | identity_mismatch/blocklist_and_search |

Left alone (action `none`, the G2 test), dev-c3: haiku 12/13; sonnet 12/13; opus 12/13; luna 8/13; qwen 12/13; muse 12/13.

Left alone (action `none`, the G2 test), dev-c2: haiku 10/13; sonnet 12/13; opus 12/13; luna 6/13; qwen 13/13; muse 11/13.

Correct (class `healthy` and action `none`, the per-class count of section 3), dev-c3: haiku 12/13; sonnet 12/13; opus 12/13; luna 8/13; qwen 12/13; muse 12/13.

### insufficient_evidence cases (12)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| audiobook-insuff-001 | insufficient_evidence,metadata_naming | escalate | metadata_naming/escalate | insufficient_evidence/escalate | metadata_naming/escalate | metadata_naming/escalate | metadata_naming/escalate | corrupt_file/blocklist_and_search |
| epub-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate |
| epub-healthy-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| epub-insuff-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| movie-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| movie-healthy-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none | identity_mismatch/escalate |
| movie-insuff-001 | insufficient_evidence,order_edition_ambiguity | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | identity_mismatch/escalate | order_edition_ambiguity/escalate | healthy/none | identity_mismatch/blocklist_and_search |
| tv-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-insuff-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| tv-insuff-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-insuff-003 | insufficient_evidence | escalate | insufficient_evidence/escalate | healthy/none | identity_mismatch/blocklist_and_search | healthy/none | healthy/none | identity_mismatch/blocklist_and_search |

Escalated, dev-c3: haiku 12/12; sonnet 11/12; opus 11/12; luna 10/12; qwen 4/12; muse 5/12.

Escalated, dev-c2: haiku 12/12; sonnet 11/12; opus 11/12; luna 12/12; qwen 6/12; muse 9/12.

G4 detail from the scorer (`value` is the share of the 15 G4 cases handled appropriately; it also counts order_edition_ambiguity cases): haiku 93.3% PASS; sonnet 93.3% PASS; opus 93.3% PASS; luna 86.7% FAIL; qwen 40.0% FAIL; muse 33.3% FAIL.

### Non-healthy truth that also accepts healthy (not negative controls)

| Case | Truth | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|---|
| audiobook-order-001 | order_edition_ambiguity | order_edition_ambiguity,healthy | escalate,none | healthy/none | order_edition_ambiguity/escalate | order_edition_ambiguity/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| epub-healthy-005 | metadata_naming | metadata_naming,healthy | rename,none,escalate | metadata_naming/rename | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |

### metadata_naming and decoder_incompatible cases (dev-c3 decisions; dev-c2 in brackets)

Cell = `class/action` (`*` = forced); a decision is correct when its class is accepted and its action is supported. `ok` / `X` marks that for dev-c3.

#### Truth metadata_naming (5 cases)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-naming-001 | metadata_naming | rename | healthy/none X [metadata_naming/rename] | healthy/none X [healthy/none] | healthy/none X [metadata_naming/rename] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | healthy/none X [healthy/none] | healthy/none X [metadata_naming/rename] |
| epub-healthy-005 | metadata_naming,healthy | rename,none,escalate | metadata_naming/rename ok [metadata_naming/rename] | healthy/none ok [metadata_naming/rename] | healthy/none ok [metadata_naming/rename] | healthy/none ok [healthy/none] | healthy/none ok [healthy/none] | healthy/none ok [metadata_naming/rename] |
| epub-naming-001 | metadata_naming | rename | metadata_naming/rename ok [metadata_naming/escalate] | metadata_naming/rename ok [insufficient_evidence/escalate] | metadata_naming/rename ok [metadata_naming/escalate] | metadata_naming/escalate X [insufficient_evidence/escalate] | metadata_naming/rename ok [metadata_naming/rename] | identity_mismatch/blocklist_and_search X [identity_mismatch/blocklist_and_search] |
| movie-naming-001 | metadata_naming | rename | metadata_naming/rename ok [metadata_naming/escalate] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | healthy/none X [order_edition_ambiguity/escalate] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] |
| tv-naming-001 | metadata_naming | rename | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/escalate] | metadata_naming/rename ok [metadata_naming/rename] | metadata_naming/rename ok [metadata_naming/rename] |

Decision classes, dev-c3: haiku: healthy 1, metadata_naming 4; sonnet: healthy 2, metadata_naming 3; opus: healthy 2, metadata_naming 3; luna: healthy 2, insufficient_evidence 1, metadata_naming 2; qwen: healthy 2, metadata_naming 3; muse: healthy 2, identity_mismatch 1, metadata_naming 2.

#### Truth decoder_incompatible (5 cases)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| movie-decoder-001 | decoder_incompatible | convert | insufficient_evidence/escalate X [insufficient_evidence/escalate] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | insufficient_evidence/escalate X [insufficient_evidence/escalate] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/escalate] |
| movie-decoder-002 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/escalate] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/escalate X [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/escalate] |
| movie-outcome-001 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/escalate] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] |
| movie-outcome-002 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/escalate] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/escalate] |
| tv-decoder-001 | decoder_incompatible | convert | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] | decoder_incompatible/convert ok [decoder_incompatible/convert] |

Decision classes, dev-c3: haiku: decoder_incompatible 4, insufficient_evidence 1; sonnet: decoder_incompatible 4, insufficient_evidence 1; opus: decoder_incompatible 4, insufficient_evidence 1; luna: decoder_incompatible 4, insufficient_evidence 1; qwen: decoder_incompatible 5; muse: decoder_incompatible 5.

## 5. Latency, usage and cost (dev-c3; dev-c2 in brackets)

| Model | Case latency p50 / p95 / max (s) | Tokens as reported | Cost |
|---|---|---|---|
| claude-haiku-5-5 | 6.6 / 12.2 / 14.8 [7.4 / 13.6 / 15.4] | 210 in / 73,653 out [234 / 79,208] | $0.0734 [$0.0792] |
| claude-sonnet-5-5 | 5.9 / 11.5 / 25.4 [7.7 / 15.6 / 19.4] | 216 in / 39,991 out [254 / 48,464] | $1.1256 [$1.3396] |
| claude-opus-5-5 | 7.3 / 16.7 / 29.1 [12.3 / 24.1 / 37.0] | 216 in / 41,534 out [302 / 63,811] | $2.2983 [$3.3951] |
| gpt-6-luna | 4.6 / 32.0 / 38.2 [6.3 / 33.6 / 40.9] | 3,329,187 in / 14,405 out [3,589,190 / 14,595] | not reported [not reported] |
| qwen3.8:27b | 4.3 / 7.7 / 9.1 [5.3 / 10.0 / 12.5] | 367,311 in / 14,594 out [380,026 / 16,573] | not reported [not reported] |
| muse-glimmer:30b | 10.9 / 15.5 / 18.7 [11.0 / 15.8 / 18.2] | 832,977 in / 17,876 out [609,552 / 17,389] | not reported [not reported] |

Total reported Claude API-equivalent cost of the three Claude runs: $3.4974 (Codex and Ollama report none). Hosted-model token counts are as the CLIs report them (Claude cache tokens are not in `input_tokens`). G9 p95 is the gate value in section 2.

### Ollama prompt size (num_ctx 8192)

| Model | Max `prompt_eval_count` | Case of the max | Max estimated prompt tokens | Turns with a reported count | Records with any `context_check` flag (truncated_suspected, prompt_at_context_limit, context_full_after_generation, estimated_prompt_exceeds_context) | Flag counts (records; `output_hit_num_predict` is not a truncation flag) | `context_check.num_ctx` | Records without `context_check` |
|---|---|---|---|---|---|---|---|---|
| qwen3.8:27b | 4083 | tv-insuff-003 | 5550 | 102 | 0 | - | 8192 | 0 |
| muse-glimmer:30b | 4499 | tv-healthy-006 | 6132 | 226 | 0 | - | 8192 | 0 |

`prompt_eval_count` is the count Ollama reports for each `/api/chat` request; it excludes tokens served from the prompt cache, so the harness also records a character-based estimate (`prompt_tokens_estimated`) and flags a turn `truncated_suspected` when either points at the window. The stop threshold was 8000 reported tokens against a window of 8192.

## 6. Tool calls: status and modes

`organic_failures` counts `error`, `timeout` and `partial` only, not `unavailable` (CONTRACT-v1.1 section 3); use `calls_by_status`.

| Model | calls_by_status (dev-c3) | calls_by_status (dev-c2) | organic_failures dev-c3 | organic_failures dev-c2 | Native tool use items (dev-c3) |
|---|---|---|---|---|---|
| claude-haiku-5-5 | error 6, ok 20, partial 1, unavailable 4 | error 7, ok 25, partial 1, timeout 2, unavailable 6 | 3 | 4 | 0 |
| claude-sonnet-5-5 | error 6, ok 23, timeout 1, unavailable 5 | error 8, ok 31, partial 1, timeout 2, unavailable 4 | 3 | 5 | 0 |
| claude-opus-5-5 | error 4, ok 24, unavailable 4 | error 7, ok 45, partial 1, timeout 2, unavailable 4 | 1 | 4 | 0 |
| gpt-6-luna | error 4, ok 29, unavailable 3 | error 6, ok 33, partial 1, timeout 1, unavailable 4 | 2 | 4 | 0 |
| qwen3.8:27b | error 5, ok 16, partial 1, unavailable 7 | error 14, ok 43, partial 1, timeout 3, unavailable 11 | 4 | 12 | 0 |
| muse-glimmer:30b | error 18, ok 112, partial 1, timeout 1, unavailable 21 | error 16, ok 119, partial 2, timeout 1, unavailable 22 | 15 | 14 | 0 |

| Model | tool_calls[].mode distribution | evidence_mode of calls | remote or local (live) tool calls | Total tool calls |
|---|---|---|---|---|
| claude-haiku-5-5 | None 1, injected 4, pinned_replay 4, replay 21, stub 1 | replay 31 | 0 | 31 |
| claude-sonnet-5-5 | injected 4, pinned_replay 5, replay 23, stub 3 | replay 35 | 0 | 35 |
| claude-opus-5-5 | injected 3, pinned_replay 5, replay 23, stub 1 | replay 32 | 0 | 32 |
| gpt-6-luna | None 1, injected 2, pinned_replay 5, replay 25, stub 3 | replay 36 | 0 | 36 |
| qwen3.8:27b | injected 2, pinned_replay 7, replay 18, stub 2 | replay 29 | 0 | 29 |
| muse-glimmer:30b | None 35, injected 5, pinned_replay 7, replay 76, stub 30 | replay 153 | 0 | 153 |

## 7. Schema validity (G7) and first-try failure modes

| Model | First-try valid (of 73) dev-c3 / dev-c2 | Repaired | Forced | Protocol violations dev-c3 (tool not offered) | Adapter errors | Crashes | First-try failure modes dev-c3 (record counts) | First-try failure modes dev-c2 |
|---|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 72 / 69 | 1 / 3 | 0 / 0 | 0 | 0 | 0 | - | tool_not_offered 2 |
| claude-sonnet-5-5 | 73 / 65 | 0 / 8 | 0 / 0 | 0 | 0 | 0 | - | audit_malformed 1 |
| claude-opus-5-5 | 70 / 54 | 3 / 19 | 0 / 0 | 0 | 0 | 0 | wrong_keys 3 | audit_malformed 17, prose_around_object 1, wrong_keys 1 |
| gpt-6-luna | 71 / 72 | 1 / 1 | 0 / 0 | 1 | 0 | 0 | empty_reply 1, tool_not_offered 1 | audit_missing 1 |
| qwen3.8:27b | 73 / 73 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | - | - |
| muse-glimmer:30b | 62 / 62 | 0 / 0 | 0 / 0 | 17 | 0 | 0 | tool_not_offered 11 | tool_not_offered 11 |

### Injected failures (G8), dev-c3

| Injected failure case (dev-v1.1) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | handled | handled | handled | handled | handled | handled |
| epub-insuff-001 | handled | handled | handled | handled | handled | handled |
| movie-corrupt-003 | handled | handled | handled | handled | handled | handled |
| tv-identity-004 | handled | handled | handled | handled | handled | handled |
| tv-insuff-002 | handled | handled | handled | handled | FAIL (decision not ok) | FAIL (decision not ok) |

G8 value dev-c3 / dev-c2: haiku 100.0% PASS / 100.0% PASS; sonnet 100.0% PASS / 100.0% PASS; opus 100.0% PASS / 100.0% PASS; luna 100.0% PASS / 100.0% PASS; qwen 80.0% FAIL / 80.0% FAIL; muse 80.0% FAIL / 100.0% PASS.

## 8. Digests and run state

| Model | Started (UTC) | Finished (UTC) | Aborted | Guard tripped | Records | Crashes |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 2026-10-20T03:56:27 | 2026-10-20T04:04:50.311342+00:00 | None | n/a (hosted) | 73 | 0 |
| claude-sonnet-5-5 | 2026-10-20T04:04:50 | 2026-10-20T04:12:52.833200+00:00 | None | n/a (hosted) | 73 | 0 |
| claude-opus-5-5 | 2026-10-20T04:12:52 | 2026-10-20T04:23:10.564416+00:00 | None | n/a (hosted) | 73 | 0 |
| gpt-6-luna | 2026-10-20T04:23:10 | 2026-10-20T04:33:59.850929+00:00 | None | n/a (hosted) | 73 | 0 |
| qwen3.8:27b | 2026-10-20T04:34:45 | 2026-10-20T04:40:32.007753+00:00 | None | None | 73 | 0 |
| muse-glimmer:30b | 2026-10-20T04:41:15 | 2026-10-20T04:54:13.947235+00:00 | None | None | 73 | 0 |

## 9. Process notes

- **Harness code (frozen dev-c3).** Every run executed the packaged harness (`python3 -B -m media_repair_harness.run`, `PYTHONPATH=<worktree>/tools/media-repair-harness/src`) from a clean detached worktree of `616e3bfcd18bebc662969ca0df3f5d83243d1cce` (`dirty: false`, `harness_git` = that commit in every manifest and record, `harness_version` `dev-c3`). The `-I` flag was not used for the runner because it ignores `PYTHONPATH`; the scorer and report script ran with `-I -B` where they do not need it. `prompts/v3.txt` sha256 was verified as `6e53ac6e0964e6f427569ab1f4ef6e0b679f6877ec84af8cf7199d5cc4019d1e` in the frozen worktree before the first run, and every one of the 438 scored records carries the assembled `system_prompt_sha256` `b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a`.
- **Suite.** `suite-dev-v1.1` from the evaluation worktree (branch off `origin/main` at `616e3bfc`, which already holds the dev-c2 re-run, #1017); `git diff 616e3bfc` over `suite-dev-v1.1` and `harness/score.py` was empty against the frozen tree. All runs: `--split dev --prompt v3 --evidence replay`, 73 cases, one run per case and model, serial, `nice -n 19`, stdin `/dev/null`, models in the order haiku, sonnet, opus, luna, qwen, muse. Output was written outside the worktree and copied here afterwards (`_runner.stdout`/`_runner.stderr` hold the runner's console output). No `--effort` flag was passed (as in the dev-c2 re-run).
- **Scoring environment (deviation from the dev-c2 method, same scorer).** The evaluator's `harness/score.py` (sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, equal to the dev-c2 re-run's and verified on `origin/main` and in the frozen tree) imports flat `protocol` and `run`, which no longer sit beside it. The dev-c2 re-run solved that with a scratch copy of the old flat harness folder. The dev-c3 modules are package-relative, so a scratch copy cannot work; instead the unchanged `score.py` was loaded by path with `python3 -B -m media_repair_harness.score_compat <run> --suite <suite-dev-v1.1>` (the frozen package's own loader, which only aliases `protocol` and `run` to the dev-c3 package modules for the import and never copies or edits `score.py`), with `MRH_SCORE_PY` set to the evaluator's `score.py` on `origin/main`, under `nice -n 19`, serially. `score.py` uses exactly three names from them: `P.CLASSES`, `P.WRITE_ACTIONS`, `R.load_cases`. Their source segments (parsed with `ast`) in the dev-c3 package are identical to those in dev-c2 `e27f2385`'s `harness/protocol.py` and `harness/run.py`: `CLASSES` identical, `WRITE_ACTIONS` identical, `load_cases` identical. No scorer crash; exit code 1 means overall FAIL. `score.json`, `score.md` and `_score.stdout` sit in each run dir.
- **Smoke runs (Ollama, labelled, unscored).** Per the order, 2 cases per tag, the two dev-v1.1 cases with the most tool calls in the dev-c2 re-run of that model (ties broken by case id): qwen3.8:27b `tv-corrupt-001` (6 calls in dev-c2), `tv-healthy-002` (5; tie with four others); muse-glimmer:30b `movie-corrupt-002`, `movie-corrupt-003` (3 each; tie with others). Max `prompt_eval_count` was 3938 (qwen) and 3886 (muse); no `context_check` flag was set, so neither model was stopped. dev-c2 turn-1 counts for comparison: 2649 (qwen, `tv-corrupt-001`).
- **Context checks (Ollama, full passes).** `--num-ctx 8192` was passed on every Ollama invocation (`argv` in the manifests) and every record's `context_check.num_ctx` is 8192; the adapter default of 4096 was never in effect. `context_check` is present on all 73 records of both models. Records with `truncated_suspected` true or any of `prompt_at_context_limit`, `context_full_after_generation`, `estimated_prompt_exceeds_context`: 0 for qwen and 0 for muse. Max `prompt_eval_count`: 4083 (qwen, `tv-insuff-003`), 4499 (muse, `tv-healthy-006`); max character-based estimate 5550 and 6132 tokens. No request reached 8000.
- **Ollama rules observed:** `num_ctx 8192`, `use_mmap false`, temperature 0, seed 42, `think false`, `keep_alive 2m`, 900 s warm-up (adapter defaults, recorded in each manifest), `/api/ps` empty before each smoke and each full pass (checked by hand and by the runner's preflight; no other session's model was resident, so no waiting or skipping was needed), PSI/restart guard on (30 s samples, threshold 0.20 for 2 samples, restart-count change), no pulls, only what the harness loaded was unloaded (`residents_after` empty). No guard trip (`tripped: null`, max PSI rate 0.0 in both full passes); pod uid `73271983-b7af-4824-893c-26990c989329` and restart count 1 unchanged before and after. Digests equal the checkpoint 1 digests (table in section 1). The Ollama batch was wrapped in one `declare-activity` (scope `ai,ollama-prime`), ended afterwards.
- **Tooling:** Claude Code 2.1.299, Codex CLI 0.162.1, Ollama server 0.40.6, Python 3.11.2. ffprobe and ffmpeg were absent on PATH, so replay mode served every ffprobe/decode/frame/ocr/audiobook result. Response model ids equal the requested ids in all records of every run.
- **Observations for the reader (factual, no recommendation).** G1 is not zero on three models: claude-opus-5-5 `tv-insuff-003` and gpt-6-luna `tv-healthy-006` each made one write decision on a case whose supported set has no write; muse-glimmer:30b has 7 G1 cases (all writes). Claude-opus-5-5 had 70/73 first-try valid replies; its 3 failures are all `wrong_keys` (decision missing `target`, `audiobook-insuff-001`, `movie-healthy-002`, `tv-insuff-002`), each repaired on the next attempt, none forced. Rejected write attempts per `write_rejection`: 1 in total (claude-haiku-5-5, `audiobook-corrupt-002`, repaired), 0 for the other five models; no forced escalate in any run. qwen3.8:27b escalated 4 of 12 insufficient_evidence cases (G4 40.0%) and 6 of 15 G4 cases appropriate; it returned `healthy/none` on `audiobook-healthy-001`, `epub-healthy-001`, `epub-healthy-002`, `movie-healthy-002`, `movie-insuff-001`, `tv-healthy-001`, `tv-insuff-002`, `tv-insuff-003`. Its G8 failure is `tv-insuff-002` (injected decode_sample error; decision `healthy/none`). The metadata_naming and decoder_incompatible case decisions per model are in section 4 (last tables).
- No case was crashed, aborted or re-run. All records are kept, including the two labelled smoke runs (`evaldevc3v11-smoke-*`, 2 cases each; unscored).
- Harness unit tests, once, serial, nice 19, at the frozen commit: `MRH_REQUIRE_SUITE=1 tools/media-repair-harness/scripts/ci-test.sh` ran 465 tests, 465 passed, 0 failures, 0 errors (10.5 s).
- Off-limits locations (`heldout/`, `~/.cache/media-repair-harness-1019/`, `ADJUDICATION*.md`) were not opened or listed.
- Cost: the three Claude runs reported $3.4974 in total (haiku $0.0734, sonnet $1.1256, opus $2.2983); codex ran once; Ollama about 6 and 13 minutes of GPU time for qwen and muse (full passes).

