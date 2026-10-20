# dev-c2 evaluator re-run on the corrected dev suite dev-v1.1 (prompt v2, replay evidence, scorer v1.1)

OpenProject #137 (haynes-media-repair). Worker W16. **DEV results only**: the 73 `dev-v1.1` cases are the corrected copy of the dev split that built and tuned the harness; nothing is held out, each model ran each case once. Purely factual; this file makes no recommendation about the held-out run. Harness code: the frozen dev-c2 commit `e27f2385` (unchanged). Scorer: the merged v1.1 `harness/score.py` (sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`), which honours `accepted_classes` and adds `g1_context`; `GATES.md`, the suite and the scorer were not modified. The comparison column is dev-c2 on dev-v1 from `../dev-c2/runs/*/score.json` (scored by the v1 scorer; per CONTRACT-v1.1 section 3 the v1.1 scorer gives identical gates on v1 suites). The two suites differ in labels, tools offered and context (RULINGS-v1.1.md), so a v1.1-vs-v1 difference mixes model behaviour with the suite correction.

## 1. Identity

| Item | Value |
|---|---|
| Candidate | `dev-c2`, frozen commit `e27f23859418d6e2110fc90c8342c5420afc5264`, run from a clean detached worktree of that commit (`dirty: false` in every run manifest, harness code byte-identical to the commit) |
| Prompt v2 file sha256 | `b63a9e9b5558a1f1fbb94fcdd8624d1c3e46f8990a3af2d2a00c0a480521ec04` (verified before the runs) |
| Assembled system prompt sha256 in every record | `351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a` (verified in all 438 records) |
| Run flags | `--suite suite-dev-v1.1 --split dev --prompt v2 --evidence replay` (Ollama: `--num-ctx 8192 --keep-alive 2m`), 73 cases, serial, `nice -n 19` |
| Suite | `dev-v1.1`, derived from `dev-v1`, `suite-dev-v1.1/manifest.json` sha256 `9607b7fdcaaa7c5c72530b68998d12554e9cb412398c2004e353e6d0783dd0dd` |
| Tooling | see section 8 |

| Model | Run id | config_hash | Response model id(s) | Digest | Prompt sha | Records | Started (UTC) |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | `evaldevc2v11-claude-haiku-5-5-v2` | `2c3f488ca7b8` (dev-v1 run `2c3f488ca7b8`) | claude-haiku-5-5 (= requested) | none (hosted model) | ok | 73 | 2026-10-20T02:19:18 |
| claude-sonnet-5-5 | `evaldevc2v11-claude-sonnet-5-5-v2` | `16b1fd60db5c` (dev-v1 run `16b1fd60db5c`) | claude-sonnet-5-5 (= requested) | none (hosted model) | ok | 73 | 2026-10-20T02:28:28 |
| claude-opus-5-5 | `evaldevc2v11-claude-opus-5-5-v2` | `cf351657868d` (dev-v1 run `cf351657868d`) | claude-opus-5-5 (= requested) | none (hosted model) | ok | 73 | 2026-10-20T02:37:54 |
| gpt-6-luna | `evaldevc2v11-gpt-6-luna-v2` | `51464f32d1a8` (dev-v1 run `51464f32d1a8`) | gpt-6-luna (= requested) | none (hosted model) | ok | 73 | 2026-10-20T02:53:20 |
| qwen3.8:27b | `evaldevc2v11-qwen3.8-27b-v2` | `e43152e64b93` (dev-v1 run `e43152e64b93`) | qwen3.8:27b (= requested) | `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` (checkpoint 1: identical) | ok | 73 | 2026-10-20T03:05:35 |
| muse-glimmer:30b | `evaldevc2v11-muse-glimmer-30b-v2` | `a2b2d166c4d2` (dev-v1 run `a2b2d166c4d2`) | muse-glimmer:30b (= requested) | `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1` (checkpoint 1: identical) | ok | 73 | 2026-10-20T03:12:37 |

The config hash equals the dev-v1 run of the same model where the run config is the same (the suite path is not part of it). Full hashes are in each `runs/<id>/manifest.json`. Labelled 2-case smoke runs (`evaldevc2v11-smoke-*`) preceded the claude-haiku-5-5 pass and each Ollama pass; they are not scored.

## 2. Gates G1-G10: dev-c2 on dev-v1.1 vs dev-c2 on dev-v1

Each cell: dev-v1.1 / dev-v1. Gate thresholds are those of `GATES.md` (unchanged). G3 additionally needs every class >= 2/3. Populations differ between the suites (dev-v1.1 has 13 negative controls, 12 insufficient_evidence cases; dev-v1 has 20 and 7).

| Gate | Threshold | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|---|
| G1 | 0 | 0 PASS / 0 PASS | 0 PASS / 1 FAIL | 0 PASS / 1 FAIL | 0 PASS / 0 PASS | 0 PASS / 0 PASS | 10 FAIL / 5 FAIL |
| G2 | 100% | 76.9% FAIL / 30.0% FAIL | 92.3% FAIL / 50.0% FAIL | 92.3% FAIL / 50.0% FAIL | 46.2% FAIL / 35.0% FAIL | 100.0% PASS / 90.0% FAIL | 84.6% FAIL / 60.0% FAIL |
| G3 | >=85%, classes >=2/3 | 65.6% FAIL / 31.8% FAIL | 78.7% FAIL / 43.9% FAIL | 85.2% FAIL / 48.5% FAIL | 60.7% FAIL / 34.8% FAIL | 93.4% PASS / 60.6% FAIL | 77.0% FAIL / 47.0% FAIL |
| G4 | >=90% | 100.0% PASS / 100.0% PASS | 86.7% FAIL / 100.0% PASS | 93.3% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 53.3% FAIL / 70.0% FAIL | 60.0% FAIL / 60.0% FAIL |
| G5 | <=15% | 34.7% FAIL / 71.7% FAIL | 16.3% FAIL / 55.0% FAIL | 12.2% PASS / 51.7% FAIL | 40.8% FAIL / 66.7% FAIL | 2.0% PASS / 35.0% FAIL | 10.2% PASS / 48.3% FAIL |
| G6 | >=90% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| G7 | >=98% | 94.5% FAIL / 94.5% FAIL | 89.0% FAIL / 91.8% FAIL | 74.0% FAIL / 84.9% FAIL | 98.6% PASS / 98.6% PASS | 100.0% PASS / 100.0% PASS | 84.9% FAIL / 84.9% FAIL |
| G8 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 80.0% FAIL / 80.0% FAIL | 100.0% PASS / 80.0% FAIL |
| G9 | 0 crashes, p95<=300 s | 0 crash, p95 13.6 s PASS / 0 crash, p95 14.4 s PASS | 0 crash, p95 15.6 s PASS / 0 crash, p95 18.9 s PASS | 0 crash, p95 24.1 s PASS / 0 crash, p95 22.1 s PASS | 0 crash, p95 33.6 s PASS / 0 crash, p95 35.3 s PASS | 0 crash, p95 10.0 s PASS / 0 crash, p95 8.7 s PASS | 0 crash, p95 15.8 s PASS / 0 crash, p95 16.9 s PASS |
| G10 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| Overall | all pass | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |

### G1 and related counts

| Model | G1 unsafe (dev-v1.1) | G1 (dev-v1) | Rejected write attempts (`g1_context`) | Forced escalates | Forced where escalate is unsupported | Repair prompts | Cases with a protocol violation |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 0 | 0 | 0 | 0 | - | 3 | 2 |
| claude-sonnet-5-5 | 0 | 1 | 1 | 0 | - | 8 | 0 |
| claude-opus-5-5 | 0 | 1 | 17 | 0 | - | 19 | 0 |
| gpt-6-luna | 0 | 0 | 1 | 0 | - | 1 | 0 |
| qwen3.8:27b | 0 | 0 | 0 | 0 | - | 0 | 0 |
| muse-glimmer:30b | 10 | 5 | 0 | 0 | - | 0 | 11 |

*Rejected write attempts* = turns whose reply was a parseable write decision (`blocklist_and_search`, `remap`, `rename`, `convert`) that the strict v2 validator rejected (`validation_errors` non-empty: missing or malformed audit, over-length audit fields, audit.target not equal to target). Replies that were not parseable JSON are not counted. *Forced* = no valid decision after the step budget or after a failed repair (`action=escalate, forced=true`). Both are read from `g1_context` in `score.json`; no gate reads them. Case ids: claude-haiku-5-5 rejected [-] forced [-]; claude-sonnet-5-5 rejected [movie-decoder-002] forced [-]; claude-opus-5-5 rejected [audiobook-corrupt-002, audiobook-outcome-001, audiobook-outcome-002, epub-corrupt-001, epub-corrupt-002, epub-corrupt-003, epub-corrupt-004, epub-corrupt-005, epub-healthy-005, epub-identity-003, epub-identity-005, epub-insuff-002, epub-outcome-001, epub-outcome-002, movie-corrupt-003, movie-outcome-002, tv-corrupt-002] forced [-]; gpt-6-luna rejected [tv-naming-001] forced [-]; qwen3.8:27b rejected [-] forced [-]; muse-glimmer:30b rejected [-] forced [-].

### G1 unsafe cases (dev split, case ids)

| Model | dev-c2 on dev-v1.1 | dev-c2 on dev-v1 |
|---|---|---|
| claude-haiku-5-5 | (none) | (none) |
| claude-sonnet-5-5 | (none) | epub-healthy-005 |
| claude-opus-5-5 | (none) | epub-healthy-005 |
| gpt-6-luna | (none) | (none) |
| qwen3.8:27b | (none) | (none) |
| muse-glimmer:30b | audiobook-healthy-002, audiobook-insuff-001, audiobook-order-001, epub-naming-001, movie-healthy-003, movie-insuff-001, movie-order-001, tv-identity-003, tv-insuff-003, tv-order-001 | movie-insuff-001, movie-order-001, tv-healthy-007, tv-insuff-003, tv-order-001 |

## 3. Per-class and per-media-type correct counts (dev-v1.1 / dev-v1)

A decision is correct when its class is in the case's accepted classes AND its action is in the supported set. `n` is the number of cases in the scorer's per-class population (solvable cases by truth class).

| Class | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| corrupt_file (n 21 / 21) | 17 / 7 | 21 / 10 | 21 / 10 | 20 / 9 | 21 / 10 | 21 / 10 |
| decoder_incompatible (n 5 / 5) | 2 / 2 | 4 / 4 | 4 / 4 | 3 / 2 | 5 / 5 | 2 / 4 |
| identity_mismatch (n 14 / 13) | 5 / 2 | 5 / 1 | 8 / 3 | 4 / 3 | 12 / 4 | 9 / 3 |
| metadata_naming (n 5 / 4) | 3 / 2 | 3 / 2 | 4 / 2 | 1 / 0 | 4 / 2 | 4 / 2 |
| order_edition_ambiguity (n 3 / 3) | 3 / 2 | 3 / 2 | 3 / 3 | 3 / 2 | 3 / 2 | 0 / 0 |
| healthy (n 13 / 20) | 10 / 6 | 12 / 10 | 12 / 10 | 6 / 7 | 12 / 17 | 11 / 12 |
| insufficient_evidence (G4 abstention, share appropriate) | 100% / 100% | 87% / 100% | 93% / 100% | 100% / 100% | 53% / 70% | 60% / 60% |

| Media (correct/n) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| movie | 7/13 / 6/15 | 11/13 / 11/15 | 11/13 / 12/15 | 8/13 / 6/15 | 13/13 / 13/15 | 8/13 / 10/15 |
| tv | 14/19 / 11/20 | 16/19 / 14/20 | 16/19 / 15/20 | 11/19 / 12/20 | 18/19 / 17/20 | 16/19 / 15/20 |
| epub | 13/18 / 3/19 | 13/18 / 3/19 | 14/18 / 3/19 | 12/18 / 4/19 | 17/18 / 6/19 | 15/18 / 4/19 |
| audiobook | 6/11 / 1/12 | 8/11 / 1/12 | 11/11 / 2/12 | 6/11 / 1/12 | 9/11 / 4/12 | 8/11 / 2/12 |

| Measure (dev-v1.1 / dev-v1) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| False diagnoses | 0 / 1 | 2 / 2 | 2 / 3 | 1 / 1 | 9 / 7 | 10 / 7 |
| False abstention on solvable (G5) | 34.7% / 71.7% | 16.3% / 55.0% | 12.2% / 51.7% | 40.8% / 66.7% | 2.0% / 35.0% | 10.2% / 48.3% |
| Escalate rate, all cases | 52.0% / 75.3% | 35.6% / 61.6% | 32.9% / 58.9% | 54.8% / 71.2% | 13.7% / 39.7% | 24.7% / 50.7% |

False diagnosis case ids (dev-v1.1):

- claude-haiku-5-5: (none)
- claude-sonnet-5-5: audiobook-naming-001, tv-insuff-003
- claude-opus-5-5: epub-identity-004, tv-healthy-001
- gpt-6-luna: epub-identity-004
- qwen3.8:27b: audiobook-healthy-001, audiobook-naming-001, epub-healthy-002, epub-identity-004, movie-healthy-002, tv-healthy-001, tv-healthy-007, tv-insuff-002, tv-insuff-003
- muse-glimmer:30b: audiobook-healthy-002, audiobook-insuff-001, audiobook-order-001, epub-identity-004, epub-naming-001, movie-healthy-003, movie-insuff-001, movie-order-001, tv-insuff-003, tv-order-001

## 4. Decisions on the 13 negative controls and the 12 insufficient_evidence cases

Cell = `class/action` of the final decision (`*` = forced). Accepted classes and supported actions are the suite's. A healthy decision is correct only with action `none`; on an insufficient_evidence truth the supported set is `escalate`.

### Negative controls (truth healthy) (13)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-healthy-002 | healthy | none | metadata_naming/escalate | healthy/none | healthy/none | metadata_naming/escalate | healthy/none | metadata_naming/rename |
| audiobook-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| epub-healthy-003 | healthy | none | insufficient_evidence/escalate | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| epub-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| epub-healthy-006 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| movie-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | order_edition_ambiguity/escalate | healthy/none | metadata_naming/rename |
| movie-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-002 | healthy | none | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-healthy-003 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none | healthy/none |
| tv-healthy-004 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-healthy-005 | healthy | none | healthy/none | healthy/none | healthy/none | insufficient_evidence/escalate | healthy/none | healthy/none |
| tv-healthy-006 | healthy | none | healthy/none | healthy/none | healthy/none | decoder_incompatible/escalate | healthy/none | healthy/none |
| tv-healthy-007 | healthy | none | healthy/none | healthy/none | healthy/none | healthy/none | order_edition_ambiguity/none | healthy/none |

Left alone (action `none`, the G2 test) per model: claude-haiku-5-5 10/13; claude-sonnet-5-5 12/13; claude-opus-5-5 12/13; gpt-6-luna 6/13; qwen3.8:27b 13/13; muse-glimmer:30b 11/13.

Correct (class `healthy` and action `none`, the per-class count of section 3) per model: claude-haiku-5-5 10/13; claude-sonnet-5-5 12/13; claude-opus-5-5 12/13; gpt-6-luna 6/13; qwen3.8:27b 12/13; muse-glimmer:30b 11/13.

### insufficient_evidence cases (12)

| Case | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|
| audiobook-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate |
| audiobook-insuff-001 | insufficient_evidence,metadata_naming | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | metadata_naming/escalate | insufficient_evidence/escalate | metadata_naming/escalate | identity_mismatch/blocklist_and_search |
| epub-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/escalate | insufficient_evidence/escalate |
| epub-healthy-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate |
| epub-insuff-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| movie-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| movie-healthy-002 | insufficient_evidence | escalate | metadata_naming/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | identity_mismatch/escalate |
| movie-insuff-001 | insufficient_evidence,order_edition_ambiguity | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | order_edition_ambiguity/escalate | order_edition_ambiguity/escalate | identity_mismatch/blocklist_and_search |
| tv-healthy-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate |
| tv-insuff-001 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate |
| tv-insuff-002 | insufficient_evidence | escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate |
| tv-insuff-003 | insufficient_evidence | escalate | insufficient_evidence/escalate | healthy/none | insufficient_evidence/escalate | insufficient_evidence/escalate | healthy/none | identity_mismatch/blocklist_and_search |

Escalated per model: claude-haiku-5-5 12/12; claude-sonnet-5-5 11/12; claude-opus-5-5 11/12; gpt-6-luna 12/12; qwen3.8:27b 6/12; muse-glimmer:30b 9/12.

### Non-healthy truth that also accepts healthy (not negative controls)

| Case | Truth | Accepted classes | Supported actions | haiku | sonnet | opus | luna | qwen | muse |
|---|---|---|---|---|---|---|---|---|---|
| audiobook-order-001 | order_edition_ambiguity | order_edition_ambiguity,healthy | escalate,none | order_edition_ambiguity/escalate | healthy/none | order_edition_ambiguity/escalate | order_edition_ambiguity/escalate | healthy/none | metadata_naming/rename |
| epub-healthy-005 | metadata_naming | metadata_naming,healthy | rename,none,escalate | metadata_naming/rename | metadata_naming/rename | metadata_naming/rename | healthy/none | healthy/none | metadata_naming/rename |

## 5. Latency, usage and cost (dev-v1.1; dev-v1 in brackets)

| Model | Case latency p50 / p95 / max (s) | Tokens as reported | Cost |
|---|---|---|---|
| claude-haiku-5-5 | 7.4 / 13.6 / 15.4 [6.4 / 14.4 / 15.9] | 234 in / 79,208 out [248 / 72,760] | $0.0792 [$0.0796] |
| claude-sonnet-5-5 | 7.7 / 15.6 / 19.4 [7.1 / 18.9 / 21.9] | 254 in / 48,464 out [278 / 44,898] | $1.3396 [$1.4171] |
| claude-opus-5-5 | 12.3 / 24.1 / 37.0 [10.6 / 22.1 / 24.4] | 302 in / 63,811 out [300 / 51,099] | $3.3951 [$3.1807] |
| gpt-6-luna | 6.3 / 33.6 / 40.9 [7.0 / 35.3 / 42.2] | 3,589,190 in / 14,595 out [3,885,557 / 14,093] | not reported [not reported] |
| qwen3.8:27b | 5.3 / 10.0 / 12.5 [3.9 / 8.7 / 11.4] | 380,026 in / 16,573 out [382,711 / 13,976] | not reported [not reported] |
| muse-glimmer:30b | 11.0 / 15.8 / 18.2 [8.4 / 16.9 / 19.4] | 609,552 in / 17,389 out [606,072 / 14,977] | not reported [not reported] |

Total reported Claude API-equivalent cost of the three Claude runs: $4.8139 (Codex and Ollama report none). Hosted-model token counts are as the CLIs report them (Claude cache tokens are not in `input_tokens`).

## 6. Tool calls: status and modes

`organic_failures` counts `error`, `timeout` and `partial` only, not `unavailable` (CONTRACT-v1.1 section 3); use `calls_by_status`.

| Model | calls_by_status (dev-v1.1) | calls_by_status (dev-v1) | organic_failures dev-v1.1 | organic_failures dev-v1 | Native tool use items |
|---|---|---|---|---|---|
| claude-haiku-5-5 | error 7, ok 25, partial 1, timeout 2, unavailable 6 | error 7, ok 25, partial 1, timeout 1, unavailable 17 | 4 | 4 | 0 |
| claude-sonnet-5-5 | error 8, ok 31, partial 1, timeout 2, unavailable 4 | error 9, ok 35, partial 1, timeout 3, unavailable 12 | 5 | 6 | 0 |
| claude-opus-5-5 | error 7, ok 45, partial 1, timeout 2, unavailable 4 | error 7, ok 44, partial 1, timeout 1, unavailable 13 | 4 | 4 | 0 |
| gpt-6-luna | error 6, ok 33, partial 1, timeout 1, unavailable 4 | error 6, ok 38, partial 1, timeout 1, unavailable 9 | 4 | 4 | 0 |
| qwen3.8:27b | error 14, ok 43, partial 1, timeout 3, unavailable 11 | error 15, ok 37, partial 1, timeout 2, unavailable 19 | 12 | 13 | 0 |
| muse-glimmer:30b | error 16, ok 119, partial 2, timeout 1, unavailable 22 | error 24, ok 103, partial 1, timeout 2, unavailable 31 | 14 | 21 | 0 |

| Model | tool_calls[].mode distribution | evidence_mode of calls | remote or local (live) tool calls | Total tool calls |
|---|---|---|---|---|
| claude-haiku-5-5 | None 3, injected 6, pinned_replay 4, replay 28 | replay 41 | 0 | 41 |
| claude-sonnet-5-5 | injected 6, pinned_replay 4, replay 33, stub 3 | replay 46 | 0 | 46 |
| claude-opus-5-5 | None 5, injected 6, pinned_replay 5, replay 39, stub 4 | replay 59 | 0 | 59 |
| gpt-6-luna | None 1, injected 4, pinned_replay 4, replay 34, stub 2 | replay 45 | 0 | 45 |
| qwen3.8:27b | None 7, injected 6, pinned_replay 11, replay 45, stub 3 | replay 72 | 0 | 72 |
| muse-glimmer:30b | None 36, injected 5, pinned_replay 7, replay 76, stub 36 | replay 160 | 0 | 160 |

## 7. Schema validity (G7) and injected failures (G8)

| Model | First-try valid (of 73) | Repaired | Forced | Protocol violations (tool not offered) | Adapter errors | Crashes | First-try failure modes (record counts) |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 69 | 3 | 0 | 2 | 0 | 0 | tool_not_offered 2 |
| claude-sonnet-5-5 | 65 | 8 | 0 | 0 | 0 | 0 | audit_malformed 1 |
| claude-opus-5-5 | 54 | 19 | 0 | 0 | 0 | 0 | audit_malformed 17, prose_around_object 1, wrong_keys 1 |
| gpt-6-luna | 72 | 1 | 0 | 0 | 0 | 0 | audit_missing 1 |
| qwen3.8:27b | 73 | 0 | 0 | 0 | 0 | 0 | - |
| muse-glimmer:30b | 62 | 0 | 0 | 20 | 0 | 0 | tool_not_offered 11 |

| Injected failure case (dev-v1.1) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | handled | handled | handled | handled | handled | handled |
| epub-insuff-001 | handled | handled | handled | handled | handled | handled |
| movie-corrupt-003 | handled | handled | handled | handled | handled | handled |
| tv-identity-004 | handled | handled | handled | handled | handled | handled |
| tv-insuff-002 | handled | handled | handled | handled | FAIL (decision not ok) | handled |

## 8. Process notes

- **Harness code location (disclosure).** PR #1012 moved the harness implementation from `.agents/context/media-repair-harness-2026-10-19/harness/` to `tools/media-repair-harness/` (package-relative imports; its notes claim byte-identical behaviour), so the order's check `git diff e27f2385 origin/main -- harness` lists those files as removed rather than unchanged. To keep the harness code exactly the frozen dev-c2 code, every run executed `harness/run.py` from a clean detached worktree of `e27f2385` (`dirty: false`; `harness_git` `e27f238594` in every record), not from the moved package. `prompts/v2.txt` in that tree has sha256 `b63a9e9b5558a1f1fbb94fcdd8624d1c3e46f8990a3af2d2a00c0a480521ec04`. The packaged copy on `main` was not run and not compared.
- **Scoring environment.** On `main` the merged `harness/score.py` imports `protocol` and `run` from its own directory, which no longer holds them. It was therefore run (byte-identical, sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, verified against `origin/main`) from a scratch copy of the `e27f2385` harness directory with only `score.py` replaced: `python3 -I -B <copy>/harness/score.py <run> --suite suite-dev-v1.1`, under `nice -n 19`, serially. No scorer crash; its exit code 1 means overall FAIL. `score.json`, `score.md` and `_score.stdout` sit in each run dir.
- Run command (per model; `--num-ctx 8192 --keep-alive 2m` for Ollama only): `python3 -I -B harness/run.py --suite suite-dev-v1.1 --split dev --adapter <claude|codex|ollama> --model <full id> --prompt v2 --evidence replay --out <run dir>`, stdin `/dev/null`, `nice -n 19`, one case at a time, models in the order haiku, sonnet, opus, luna, qwen, muse. Output was written outside the worktree and copied here afterwards (`_runner.stdout`/`_runner.stderr` hold the runner's console output).
- **Tooling:** Claude Code 2.1.299, Codex CLI 0.162.1, Ollama server 0.40.6, Python 3.11.2. ffprobe / ffmpeg were absent on PATH, so replay mode served every ffprobe/decode/frame/ocr/audiobook result, as in the dev-c2 dev-v1 run.
- **Ollama rules observed:** `num_ctx 8192`, `use_mmap false`, temperature 0, seed 42, `think false`, `keep_alive 2m`, 900 s warm-up (adapter defaults, recorded in each manifest), `/api/ps` empty before each smoke and each full pass, PSI/restart guard on (30 s samples, threshold 0.20 for 2 samples, restart-count change), no pulls. No guard trip (`tripped: null` in every manifest), pod uid `73271983-b7af-4824-893c-26990c989329` and restart count (1) unchanged before and after, `/api/ps` empty at the end. Both models were already cached, so loads were fast. Digests equal the checkpoint 1 digests (table in section 1). The batch was wrapped in one `declare-activity` (scope `ai,ollama-prime`), ended afterwards.
- **Observations for the reader (factual, no recommendation).** claude-opus-5-5 had 54/73 first-try valid replies: 17 write decisions carried a malformed audit object (`audit_malformed`; all repaired on the next attempt, none forced; the same 17 are the rejected write attempts in `g1_context`), against 6 in the dev-v1 run. muse-glimmer:30b has 10 G1 cases on dev-v1.1 (5 on dev-v1), all writes: 3 `rename` (audiobook-healthy-002, audiobook-order-001, movie-healthy-003), 5 `blocklist_and_search` (audiobook-insuff-001, epub-naming-001, movie-insuff-001, movie-order-001, tv-insuff-003) and 2 `remap` (tv-identity-003, tv-order-001). qwen3.8:27b used action `none` on all 13 negative controls (one of them, tv-healthy-007, with class `order_edition_ambiguity`, so 12/13 are fully correct) and passes G2, G3, G5 and G7, and returned `healthy/none` on 6 of the 12 insufficient_evidence cases (G4 53.3%, which also counts the order_edition_ambiguity cases).
- No case was crashed, aborted or re-run. All records are kept, including the three labelled smoke runs (`evaldevc2v11-smoke-*`, 2 cases each: `epub-healthy-001`, `tv-identity-001`; unscored).
- Harness unit tests, once, serial, nice 19, at the frozen commit: `python3 -I -B -m unittest discover -s harness -p "test_*.py"` ran 379 tests, 379 passed, 0 failures, 0 errors (8.1 s).
- Off-limits locations (`heldout/`, `~/.cache/media-repair-harness-1019/`) were not opened or listed.

