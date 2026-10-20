# dev-c2 evaluator dev re-run (suite dev-v1, prompt v2, replay evidence)

OpenProject #137 (haynes-media-repair). Worker W11. **DEV results only**: the 73 `dev-v1` cases built and tuned the harness, nothing is held out, each model ran each case once. Purely factual; this file makes no recommendation about the held-out run. Scorer: the UNCHANGED `harness/score.py` (`git diff 05bc746d e27f2385 -- harness/score.py` is empty). Checkpoint 1 numbers come from `baseline/runs/dev-v1-*/score.json` (haiku: the original run with its 2 leak-guard crashes, not the merged rerun).

## 1. Identity

| Item | Value |
|---|---|
| Candidate | `dev-c2`, main commit `e27f23859418d6e2110fc90c8342c5420afc5264` (worktree `agent/mrh-eval-devc2-1019`, clean, `dirty: false` in every run manifest) |
| Prompt v2 file sha256 | `b63a9e9b5558a1f1fbb94fcdd8624d1c3e46f8990a3af2d2a00c0a480521ec04` (verified before the runs) |
| Assembled system prompt sha256 in every record | `351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a` (verified in all 438 records) |
| Run flags | `--suite suite --split dev --prompt v2 --evidence replay` (Ollama: `--num-ctx 8192 --keep-alive 2m`), 73 cases, serial, `nice -n 19` |
| Suite | dev-v1, manifest sha256 `2343b397d837c1ae32106ff2cde21cdc4804bec2a6d5a676619f65f4655bc4da` (unchanged) |
| Tooling | Claude Code 2.1.299, Codex CLI 0.162.1, Ollama server 0.40.6, Python 3.11.2 |
| ffprobe / ffmpeg on PATH | **absent** where the runs executed (dev-env pod), so replay mode served every ffprobe/decode/frame/ocr/audiobook result |

| Model | Run id | config_hash | Response model id(s) | Digest | Prompt sha | Started (UTC) |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | `evaldevc2-claude-haiku-5-5-v2` | `2c3f488ca7b8` (cp1 `7b5e13c8b1fc`) | claude-haiku-5-5 | none (hosted model) | ok | 2026-10-20T00:40:41 |
| claude-sonnet-5-5 | `evaldevc2-claude-sonnet-5-5-v2` | `16b1fd60db5c` (cp1 `b6404655552e`) | claude-sonnet-5-5 | none (hosted model) | ok | 2026-10-20T00:49:35 |
| claude-opus-5-5 | `evaldevc2-claude-opus-5-5-v2` | `cf351657868d` (cp1 `e772f1fdb538`) | claude-opus-5-5 | none (hosted model) | ok | 2026-10-20T00:58:57 |
| gpt-6-luna | `evaldevc2-gpt-6-luna-v2` | `51464f32d1a8` (cp1 `2cfc1eabe522`) | gpt-6-luna | none (hosted model) | ok | 2026-10-20T01:12:23 |
| qwen3.8:27b | `evaldevc2-qwen3.8-27b-v2` | `e43152e64b93` (cp1 `eb97bdc5c331`) | qwen3.8:27b | `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` (checkpoint 1: identical) | ok | 2026-10-20T01:28:05 |
| muse-glimmer:30b | `evaldevc2-muse-glimmer-30b-v2` | `a2b2d166c4d2` (cp1 `13a4d71c1fe4`) | muse-glimmer:30b | `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1` (checkpoint 1: identical) | ok | 2026-10-20T01:34:44 |

Full config hashes are in each `runs/<id>/manifest.json`. The hosted-model response ids equal the requested ids on every turn of every record. Two separately labelled Ollama smoke runs (`evaldevc2-smoke-*`, 2 cases each, before the full passes, per the evaluator addendum) came back with 0 adapter errors, 0 schema rejections and the same digests; they are not scored.

## 2. Gates G1-G10: dev-c2 v2 vs checkpoint 1

Each cell: dev-c2 v2 / checkpoint 1. Gate thresholds are those of `GATES.md` (unchanged). G3 additionally needs every class >= 2/3.

| Gate | Threshold | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|---|
| G1 | 0 | 0 PASS / 2 FAIL | 1 FAIL / 2 FAIL | 1 FAIL / 1 FAIL | 0 PASS / 4 FAIL | 0 PASS / 5 FAIL | 5 FAIL / 9 FAIL |
| G2 | 100% | 30.0% FAIL / 65.0% FAIL | 50.0% FAIL / 85.0% FAIL | 50.0% FAIL / 100.0% PASS | 35.0% FAIL / 60.0% FAIL | 90.0% FAIL / 95.0% FAIL | 60.0% FAIL / 70.0% FAIL |
| G3 | >=85%, classes >=2/3 | 31.8% FAIL / 65.1% FAIL | 43.9% FAIL / 81.8% FAIL | 48.5% FAIL / 86.4% FAIL | 34.8% FAIL / 71.2% FAIL | 60.6% FAIL / 86.4% FAIL | 47.0% FAIL / 71.2% FAIL |
| G4 | >=90% | 100.0% PASS / 80.0% FAIL | 100.0% PASS / 60.0% FAIL | 100.0% PASS / 70.0% FAIL | 100.0% PASS / 80.0% FAIL | 70.0% FAIL / 50.0% FAIL | 60.0% FAIL / 50.0% FAIL |
| G5 | <=15% | 71.7% FAIL / 30.0% FAIL | 55.0% FAIL / 10.0% PASS | 51.7% FAIL / 8.3% PASS | 66.7% FAIL / 20.0% FAIL | 35.0% FAIL / 1.7% PASS | 48.3% FAIL / 18.3% FAIL |
| G6 | >=90% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| G7 | >=98% | 94.5% FAIL / 84.9% FAIL | 91.8% FAIL / 97.3% FAIL | 84.9% FAIL / 100.0% PASS | 98.6% PASS / 91.8% FAIL | 100.0% PASS / 100.0% PASS | 84.9% FAIL / 84.9% FAIL |
| G8 | 100% | 100.0% PASS / 80.0% FAIL | 100.0% PASS / 60.0% FAIL | 100.0% PASS / 60.0% FAIL | 100.0% PASS / 80.0% FAIL | 80.0% FAIL / 80.0% FAIL | 80.0% FAIL / 80.0% FAIL |
| G9 | 0 crashes, p95<=300 s | 0 crash, p95 14.4 s PASS / 2 crash, p95 10.3 s FAIL | 0 crash, p95 18.9 s PASS / 0 crash, p95 18.2 s PASS | 0 crash, p95 22.1 s PASS / 0 crash, p95 20.0 s PASS | 0 crash, p95 35.3 s PASS / 0 crash, p95 28.2 s PASS | 0 crash, p95 8.7 s PASS / 0 crash, p95 6.4 s PASS | 0 crash, p95 16.9 s PASS / 0 crash, p95 14.9 s PASS |
| G10 | 100% | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS | 100.0% PASS / 100.0% PASS |
| Overall | all pass | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |

### G1 and related counts (dev-c2 v2)

| Model | G1 unsafe (dev-c2) | G1 (cp1) | Rejected write attempts (dev-c2) | Forced escalates (dev-c2) | Forced (cp1) | Repair prompts (dev-c2) | Cases with a protocol violation (dev-c2) |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 0 | 2 | 0 | 0 | 2 | 0 | 4 |
| claude-sonnet-5-5 | 1 | 2 | 1 | 0 | 0 | 6 | 0 |
| claude-opus-5-5 | 1 | 1 | 6 | 0 | 0 | 11 | 0 |
| gpt-6-luna | 0 | 4 | 1 | 0 | 0 | 1 | 0 |
| qwen3.8:27b | 0 | 5 | 0 | 0 | 0 | 0 | 0 |
| muse-glimmer:30b | 5 | 9 | 0 | 0 | 0 | 0 | 11 |

*Rejected write attempts* = turns whose reply was a parseable write decision (`blocklist_and_search`, `remap`, `rename`, `convert`) that the strict v2 validator rejected (`validation_errors` non-empty: missing or malformed audit, over-length audit fields, audit.target not equal to target). Replies that were not parseable JSON are not counted. Checkpoint 1 had no audit object, so the count has no cp1 equivalent. *Forced* = no valid decision after the step budget or after a failed repair (`action=escalate, forced=true`).

### G1 unsafe cases (dev split, case ids)

| Model | dev-c2 v2 | checkpoint 1 |
|---|---|---|
| claude-haiku-5-5 | (none) | epub-healthy-005, movie-healthy-002 |
| claude-sonnet-5-5 | epub-healthy-005 | epub-healthy-005, epub-insuff-002 |
| claude-opus-5-5 | epub-healthy-005 | epub-insuff-002 |
| gpt-6-luna | (none) | audiobook-healthy-003, epub-insuff-002, epub-naming-001, tv-healthy-006 |
| qwen3.8:27b | (none) | audiobook-insuff-001, epub-insuff-002, epub-naming-001, movie-naming-001, tv-naming-001 |
| muse-glimmer:30b | movie-insuff-001, movie-order-001, tv-healthy-007, tv-insuff-003, tv-order-001 | audiobook-healthy-002, audiobook-insuff-001, audiobook-naming-001, audiobook-order-001, epub-insuff-002, epub-naming-001, movie-naming-001, tv-insuff-003, tv-naming-001 |

## 3. Per-class correct counts (class AND a supported action; dev-c2 / cp1)

| Class (n) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| corrupt_file (21) | 7 / 19 | 10 / 20 | 10 / 21 | 9 / 20 | 10 / 20 | 10 / 21 |
| decoder_incompatible (5) | 2 / 5 | 4 / 5 | 4 / 5 | 2 / 5 | 5 / 5 | 4 / 0 |
| identity_mismatch (13) | 2 / 4 | 1 / 8 | 3 / 6 | 3 / 6 | 4 / 11 | 3 / 10 |
| metadata_naming (4) | 2 / 0 | 2 / 2 | 2 / 3 | 0 / 1 | 2 / 0 | 2 / 0 |
| order_edition_ambiguity (3) | 2 / 2 | 2 / 2 | 3 / 2 | 2 / 3 | 2 / 2 | 0 / 2 |
| healthy (20) | 6 / 13 | 10 / 17 | 10 / 20 | 7 / 12 | 17 / 19 | 12 / 14 |
| insufficient_evidence (G4 abstention) | 100% / 80% | 100% / 60% | 100% / 70% | 100% / 80% | 70% / 50% | 60% / 50% |

| Media (correct/n) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| movie | 6/15 / 10/15 | 11/15 / 14/15 | 12/15 / 14/15 | 6/15 / 11/15 | 13/15 / 14/15 | 10/15 / 8/15 |
| tv | 11/20 / 14/20 | 14/20 / 18/20 | 15/20 / 18/20 | 12/20 / 16/20 | 17/20 / 17/20 | 15/20 / 16/20 |
| epub | 3/19 / 11/19 | 3/19 / 13/19 | 3/19 / 15/19 | 4/19 / 14/19 | 6/19 / 16/19 | 4/19 / 15/19 |
| audiobook | 1/12 / 8/12 | 1/12 / 9/12 | 2/12 / 10/12 | 1/12 / 6/12 | 4/12 / 10/12 | 2/12 / 8/12 |

| Measure (dev-c2 / cp1) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| False diagnoses | 1 / 6 | 2 / 9 | 3 / 6 | 1 / 7 | 7 / 9 | 7 / 8 |
| False abstention on solvable (G5) | 71.7% / 30.0% | 55.0% / 10.0% | 51.7% / 8.3% | 66.7% / 20.0% | 35.0% / 1.7% | 48.3% / 18.3% |
| Escalate rate, all cases | 75.3% / 39.7% | 61.6% / 16.4% | 58.9% / 16.4% | 71.2% / 28.8% | 39.7% / 8.2% | 50.7% / 21.9% |

False diagnosis case ids (dev-c2 v2):

- claude-haiku-5-5: epub-identity-005
- claude-sonnet-5-5: epub-healthy-005, epub-identity-005
- claude-opus-5-5: epub-healthy-005, epub-identity-004, epub-identity-005
- gpt-6-luna: epub-identity-005
- qwen3.8:27b: audiobook-naming-001, audiobook-order-001, epub-identity-004, epub-identity-005, tv-healthy-007, tv-insuff-002, tv-insuff-003
- muse-glimmer:30b: epub-identity-004, epub-identity-005, movie-insuff-001, movie-order-001, tv-healthy-007, tv-insuff-003, tv-order-001

## 4. Latency, usage and cost (dev-c2 v2; cp1 in brackets)

| Model | Case latency p50 / p95 / max (s) | Tokens as reported | Cost |
|---|---|---|---|
| claude-haiku-5-5 | 6.4 / 14.4 / 15.9 [4.5 / 10.3 / 12.4] | 248 in / 72,760 out [212 / 43,647] | $0.0796 [$0.0535] |
| claude-sonnet-5-5 | 7.1 / 18.9 / 21.9 [5.6 / 18.2 / 22.1] | 278 in / 44,898 out [226 / 26,785] | $1.4171 [$0.9616] |
| claude-opus-5-5 | 10.6 / 22.1 / 24.4 [7.9 / 20.0 / 23.9] | 300 in / 51,099 out [274 / 35,435] | $3.1807 [$2.5237] |
| gpt-6-luna | 7.0 / 35.3 / 42.2 [4.1 / 28.2 / 34.3] | 3,885,557 in / 14,093 out [3,009,158 / 11,807] | not reported [not reported] |
| qwen3.8:27b | 3.9 / 8.7 / 11.4 [3.7 / 6.4 / 8.2] | 382,711 in / 13,976 out [217,403 / 10,455] | not reported [not reported] |
| muse-glimmer:30b | 8.4 / 16.9 / 19.4 [9.7 / 14.9 / 17.2] | 606,072 in / 14,977 out [546,901 / 15,652] | not reported [not reported] |

Total reported Claude API-equivalent cost of the three Claude runs: $4.6773 (Codex and Ollama report none). Hosted-model token counts are as the CLIs report them (Claude cache tokens are not in `input_tokens`).

## 5. Tool calls: status, modes and remote use

**`organic_failures` in score.json is not comparable with checkpoint 1**: dev-c1/dev-c2 added the `unavailable` status (capability absent, nothing ran) and `score.py` does not count it in `organic_failures`, while checkpoint 1 recorded the same situations as `error`. Use `calls_by_status` below; the cp1 column is its own `calls_by_status` for orientation only.

| Model | calls_by_status (dev-c2) | calls_by_status (cp1) | organic_failures dev-c2 (not comparable) | organic_failures cp1 | Native tool use items |
|---|---|---|---|---|---|
| claude-haiku-5-5 | error 7, ok 25, partial 1, timeout 1, unavailable 17 | error 10, ok 12, partial 1, timeout 1 | 4 | 9 | 0 |
| claude-sonnet-5-5 | error 9, ok 35, partial 1, timeout 3, unavailable 12 | error 17, ok 19, partial 1, timeout 1 | 6 | 15 | 0 |
| claude-opus-5-5 | error 7, ok 44, partial 1, timeout 1, unavailable 13 | error 20, ok 42, partial 1, timeout 1 | 4 | 16 | 0 |
| gpt-6-luna | error 6, ok 38, partial 1, timeout 1, unavailable 9 | error 10, ok 12 | 4 | 9 | 0 |
| qwen3.8:27b | error 15, ok 37, partial 1, timeout 2, unavailable 19 | error 37, ok 44, partial 1 | 13 | 35 | 0 |
| muse-glimmer:30b | error 24, ok 103, partial 1, timeout 2, unavailable 31 | error 85, ok 161, partial 1, timeout 2 | 21 | 82 | 0 |

| Model | tool_calls[].mode distribution | evidence_mode of calls | remote or local (live) tool calls | Total tool calls |
|---|---|---|---|---|
| claude-haiku-5-5 | None 4, injected 5, pinned_replay 4, replay 37, stub 1 | replay 51 | 0 | 51 |
| claude-sonnet-5-5 | injected 7, pinned_replay 5, replay 44, stub 4 | replay 60 | 0 | 60 |
| claude-opus-5-5 | None 4, injected 5, pinned_replay 5, replay 49, stub 3 | replay 66 | 0 | 66 |
| gpt-6-luna | None 2, injected 4, pinned_replay 7, replay 39, stub 3 | replay 55 | 0 | 55 |
| qwen3.8:27b | None 7, injected 5, pinned_replay 10, replay 49, stub 3 | replay 74 | 0 | 74 |
| muse-glimmer:30b | None 37, injected 6, pinned_replay 7, replay 85, stub 26 | replay 161 | 0 | 161 |

No record shows a `remote` or `local` call: every tool result was a recorded replay, a stub, an injected failure or an `unavailable`/pinned answer. The harness never ran kubectl, the PVE/Unraid hosts or any media tool for the cases; the only kubectl use in these runs is the Ollama adapter transport and the PSI/restart guard (`kubectl exec` into `ollama-prime` for `/api/*` and `memory.pressure`), on the two Ollama models. `pinned_replay` = the reused real-media rows whose media is not reachable, answered from the case evidence.

## 6. Schema validity (G7) and first-try failure modes

| Model | First-try valid (of 73) | Repaired | Forced | Protocol violations (tool not offered) | Adapter errors | Crashes | First-try failure modes (record counts) |
|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 69 | 0 | 0 | 4 | 0 | 0 | tool_not_offered 4 |
| claude-sonnet-5-5 | 67 | 6 | 0 | 0 | 0 | 0 | audit_malformed 1 |
| claude-opus-5-5 | 62 | 11 | 0 | 0 | 0 | 0 | audit_malformed 6, prose_around_object 4 |
| gpt-6-luna | 72 | 1 | 0 | 0 | 0 | 0 | audit_missing 1 |
| qwen3.8:27b | 73 | 0 | 0 | 0 | 0 | 0 | - |
| muse-glimmer:30b | 62 | 0 | 0 | 20 | 0 | 0 | tool_not_offered 11 |

## 7. Injected tool failures (G8)

| Case (dev-c2 v2) | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | handled | handled | handled | handled | handled | handled |
| epub-insuff-001 | handled | handled | handled | handled | handled | handled |
| movie-corrupt-003 | handled | handled | handled | handled | handled | FAIL (cited failed tool) |
| tv-identity-004 | handled | handled | handled | handled | handled | handled |
| tv-insuff-002 | handled | handled | handled | handled | FAIL (decision not ok) | handled |

## 8. Process notes

- **Anomaly for the reader (factual, no recommendation):** under prompt v2 every model escalates far more than at checkpoint 1 (escalate rate and G5 above). G2 detail: healthy cases escalated instead of left alone: claude-haiku-5-5 14/20; claude-sonnet-5-5 9/20; claude-opus-5-5 9/20; gpt-6-luna 13/20; qwen3.8:27b 2/20; muse-glimmer:30b 7/20. Sampled replies on healthy cases (for example claude-opus-5-5 on epub-healthy-001, audiobook-healthy-001, movie-healthy-001) escalate because the item was never verified by a tool ("no tools were offered", "integrity remains unverified"), which is what the v2 prompt text asks for ("any unverified part is unverified, never healthy"). The G4 abstention gate rises to 100% for the four hosted models for the same reason. Replay mode has no recorded probe for most healthy rows, so these results do not show what a model does when a live probe is clean.
- Ollama rules observed: `num_ctx 8192`, `use_mmap false`, temperature 0, seed 42, `think false`, `keep_alive 2m`, 900 s warm-up, `/api/ps` empty before each smoke and each full pass, PSI/restart guard on (30 s samples), no pulls. No guard abort, pod uid and restart count unchanged (1) before and after, `/api/ps` empty at the end; the batch was wrapped in one `declare-activity` (scope ai, ollama-prime), ended afterwards.
- No case was crashed, aborted or re-run. All records are kept, including the two smoke runs and runner stdout/stderr (`_runner.*`).
- Run output was written outside the repo worktree and copied here afterwards; `score.py` ran on the copies (`score.json`, `score.md`, `_score.stdout` in each run dir; its exit code 1 means overall FAIL, not a crash).
- Harness unit tests, once, serial, nice 19, at the frozen commit: `python3 -I -B -m unittest discover -s harness -p "test_*.py"` ran 379 tests, 379 passed, 0 failures, 0 errors (8.1 s).
- Off-limits locations (`heldout/`, `~/.cache/media-repair-harness-1019/`) were not opened or listed.
