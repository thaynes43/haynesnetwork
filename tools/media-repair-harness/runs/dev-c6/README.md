# dev-c6 measurement results (OpenProject #151, worker W21)

**DEV-TUNED, dev split only.** All numbers are on the 73 cases of `suite-dev-v1.1` that built and tuned the harness, one sample per model, correlated fixtures. **One pass on correlated, previously tuned fixtures shows neither significance nor generalisation; no readiness (pass or fail) claim is made.** Configuration **C6** = prompt v6 + evidence format v3 + turn protocol `turn-v3` / decision schema `decision-v3` + audit v3 + guards v3 (+ tools v2, `pages-v1`): a COMBINED candidate, so no difference from dev-c5 or dev-c4 can be attributed to the prompt, the presentation or the schema alone. dev-c5 used prompt v5, evidence format v2, the v2 decision schema and audit v2; dev-c4 also used guards v2, the legacy format and earlier harness code. **G6 measures fixture verification, not completed repairs.**
The measurement is exactly the one in `PREREGISTRATION.md` through Amendment 2: three passes in the registered order (qwen, Haiku, then `gpt-6-astra` as the frontier control and benchmark check), the registered commands, frozen code commit `a6122505` at head `110cca83`. `src/` was identical to `a6122505` before the first model call (2026-10-21T00:19:23Z) and after the last (00:52:49Z); nothing in `src/`, the prompts, the pre-registration or `scripts/passability.py` changed before or during the runs, and v6 was not iterated. Every manifest matches `manifest-template.json` on every frozen field (no deviation). No held-out material was read. dev-c5 numbers are `runs/dev-c5/*/score.json`; dev-c4 numbers are the evaluator's public `evaluation/dev-c4-v1.1/REPORT.md` (sections 2 and 2b, and its class table; percentages as published).

## Result in words

**qwen3.8:27b against dev-c5 (guarded): mixed.** Gains: G2 (healthy left alone) 92.3% -> 100% (13/13), G3 83.6% -> 85.2% (52/61), G5 (false abstention) 16.3% -> 12.2% (6/49, now inside the 15% limit), G7 98.6% -> 100%, G8 80% -> 100%, and decoder_incompatible **0/5 -> 5/5**. Regressions: identity_mismatch **11/14 -> 6/14** (below 2/3, so G3 still fails), and G1 0 -> **1** (a rename on `audiobook-insuff-001`, an insufficient_evidence case: an unsafe write under score.py). G4 is equal guarded (73.3%) and higher restored (46.7% -> 60.0%). **Against dev-c4 qwen:** G3 91.8% -> 85.2%, G5 2.0% -> 12.2%, G1 0 -> 1, G4 80.0% -> 73.3% and identity 13/14 -> 6/14 are worse; G8 80% -> 100%, decoder 4/5 -> 5/5, healthy 12/13 -> 13/13 and corrupt 20/21 -> 21/21 are better; G2 and G7 are equal at 100%. qwen's score-correct writes include 23 that audit v3 does not fully support (table 12: mostly a source binding that no shown record establishes, or a cited source that does not bind it).

**claude-haiku-5-5 against dev-c5 (guarded): WORSE overall.** Regressions: G3 68.8% -> **54.1%** (33/61), G5 28.6% -> **46.9%** (23/49), G7 98.6% -> **47.9%** (35/73), G4 93.3% -> 86.7%, G8 100% -> 80%, corrupt_file **20/21 -> 7/21** and decoder 5/5 -> 4/5. Gains: G2 69.2% -> 92.3% (12/13), healthy 9/13 -> 12/13, identity 4/14 -> 5/14, order 2/3 -> 3/3. **Against dev-c4 Haiku:** G3 80.3% -> 54.1%, G5 16.3% -> 46.9%, G7 98.6% -> 47.9%, G4 100% -> 86.7%, G8 100% -> 80%, corrupt 21/21 -> 7/21 and identity 7/14 -> 5/14 are worse; G1 (0), G2 (92.3%), healthy (12/13), naming (2/5), order (3/3) and decoder (4/5) are equal. The G7 drop is 37 first replies whose `reason` exceeded the enforced 400 characters (and one tool call whose `why` exceeded 200), each fixed by the one repair prompt, plus one forced decision (`epub-identity-003`). Prompt v6 states the limits; v5 also asked for "one or two sentences" and "Be terse". That difference is a candidate explanation, not a tested one.

**gpt-6-astra (frontier control, effort high; no earlier run to compare):** G1 0 (PASS), G2 92.3%, G3 **55.7%** (34/61), G4 80.0%, G5 **42.9%** (21/49), G7 100%, G8 80%; corrupt 9/21, decoder 4/5, identity 5/14, naming 2/5, order 2/3, healthy 12/13. The frontier control fails G3 and G5 by wide margins under C6, which is the benchmark check this pass was registered for (Table 11).

**One pattern across the hosted runs (an observation, not a causal claim).** Under contract v3 a `blocklist_and_search` also needs a source binding, a managing-app record whose linked file is this case's file. On 11 corrupt_file cases (audiobook and EPUB) no shown record binds the source and the exploration found none to obtain; Astra and Haiku kept the class `corrupt_file` and escalated, as the action prerequisite says, and score.py marks that wrong (the label supports only the write). qwen blocklisted the same cases (21/21), and audit v3 reports the binding `unknown` on those writes. The passability report judges these rows, by hand and marked as such, an evidence gap on source binding; no label change is proposed. **How much source binding accounts for (an observation, not a causal claim):** the 12 source-binding rows of the Astra run (the 11 corrupt_file cases and `movie-decoder-001`, Table 11) are 12 of its 21 false abstentions. If those 12 had counted as correct, Astra would still fail both gates: G5 would be 9/49 (18.4%, against the 15% limit) and G3 46/61 (75.4%), with identity_mismatch 5/14 and metadata_naming 2/5 still below 2/3.

Caveats that stay: dev-tuned fixtures, a single pass per model, several confounds (prompt, presentation, decision schema and audit all changed together, and dev-c4 also differs in guards and harness code). **No change can be attributed to one component.** No readiness claim is made, and this is not evidence about held-out behaviour in either direction.

---

## qwen3.8:27b

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc6-qwen3.8-27b` |
| config_hash | `212d33621005` |
| Harness | `dev-c6`, commit `110cca8377` (`src/` identical to the frozen code commit `a6122505`; tree clean at start) |
| Prompt sha256 (assembled) | `f828f9ac0df6a92e03bd6b0368f1675193be0f295abdcd3d5c3415677ba0a126` |
| Requested / response model ids | `qwen3.8:27b` / `qwen3.8:27b` |
| Runtime / digest | 0.40.6 / `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` |
| Effort | n/a (Ollama) |
| Spend limit | `uncapped` (`--no-spend-limit`; no spend-limit flag of any kind) ; wall cap 1800 s |
| Run started (manifest) | 2026-10-21T00:19:45.993371+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-21T00:19:57.721Z UTC** |
| Warm-up inference (pre-measurement, registered) | receipt: ok=True, wall 5.58 s, load 5.066 s, exit_code 0, error None; residents before: []; loaded by this run: True |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / [] |
| Tokens (reported) | 522657 in / 11348 out over 107 model calls; no cost (local model) |
| Wall time (whole pass, warm-up and cleanup included) | 303.4 s of the 1800 s cap (after cleanup 304.5 s); unloaded by this run: True; residents after: [] |
| Crashes / adapter errors / forced decisions | 0 / 0 / 0 |
| Latency per case (excl. load) | p50 3.832 s, p95 5.714 s, max 9.104 s |
| Overall (score.py) | FAIL (guarded), FAIL (restored) |

### Table 2. Gates G1 to G10, guarded (C6 as recorded, guards v3) against dev-c5 as recorded (guards v3, prompt v5, format v2) and dev-c4 as recorded (guards v2, prompt v4, legacy evidence)

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C6 value | C6 n/N | C6 result | dev-c5 value | dev-c5 n/N | dev-c5 result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 1 |  | FAIL | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL | 100.0% | PASS |
| G3 | >= 85%, every class >= 2/3 | 85.2% | 52/61 | FAIL | 83.6% | 51/61 | FAIL | 91.8% | PASS |
| G4 | >= 90% | 73.3% | 11/15 | FAIL | 73.3% | 11/15 | FAIL | 80.0% | FAIL |
| G5 | <= 15% | 12.2% | 6/49 | PASS | 16.3% | 8/49 | FAIL | 2.0% | PASS |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS | 98.6% | 72/73 | PASS | 100.0% | PASS |
| G8 | == 100% | 100.0% | 5/5 | PASS | 80.0% | 4/5 | FAIL | 80.0% | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=5.714 s |  | PASS | crashes=0, p95=8.105 s |  | PASS | p95 7.6 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run), against dev-c5 restored and dev-c4 own decisions (REPORT section 2b)

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C6 value | C6 n/N | C6 result | dev-c5 value | dev-c5 n/N | dev-c5 result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 1 |  | FAIL | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL | 100.0% | PASS |
| G3 | >= 85%, every class >= 2/3 | 85.2% | 52/61 | FAIL | 83.6% | 51/61 | FAIL | 91.8% | PASS |
| G4 | >= 90% | 60.0% | 9/15 | FAIL | 46.7% | 7/15 | FAIL | 40.0% | FAIL |
| G5 | <= 15% | 12.2% | 6/49 | PASS | 16.3% | 8/49 | FAIL | 2.0% | PASS |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS | 98.6% | 72/73 | PASS | 100.0% | PASS |
| G8 | == 100% | 100.0% | 5/5 | PASS | 80.0% | 4/5 | FAIL | 80.0% | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=5.714 s |  | PASS | crashes=0, p95=8.105 s |  | PASS | p95 7.6 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 4. Per-class counts (correct / n)

| Class | C6 guarded | C6 restored | dev-c5 guarded | dev-c5 restored | dev-c4 guarded | dev-c4 own decisions |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 21/21 | 21/21 | 21/21 | 21/21 | 20/21 | 20/21 |
| decoder_incompatible (n 5) | 5/5 | 5/5 | 0/5 | 0/5 | 4/5 | 4/5 |
| identity_mismatch (n 14) | 6/14 | 6/14 | 11/14 | 11/14 | 13/14 | 13/14 |
| metadata_naming (n 5) | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 |
| order_edition_ambiguity (n 3) | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| healthy (n 13) | 13/13 | 13/13 | 12/13 | 12/13 | 12/13 | 12/13 |

Classes below 2/3: guarded identity_mismatch; restored identity_mismatch. G4 abstention on insufficient_evidence / unsolvable: guarded 73.3%, restored 60.0%.

### Table 5. Guard effect (guards v3)

- Guard-made escalations (decisions changed): **2**. Hidden writes (a guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not the guarded one): **0** [].
- G1 unsafe cases: guarded ['audiobook-insuff-001']; restored ['audiobook-insuff-001'].

| Case | Rule | Original class/action | Final class/action | Original correct | Final correct | Guard reason (excerpt) |
|---|---|---|---|---|---|---|
| movie-healthy-002 | G-healthy | healthy/none | insufficient_evidence/escalate | no | yes | healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence; none  |
| tv-healthy-001 | G-healthy | healthy/none | insufficient_evidence/escalate | no | yes | healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence; none  |

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 73/73 (G7 over planned 73: 100.0%) |
| Repaired (one repair prompt, then valid) | 0 |
| Forced decisions | 0  |
| Repair prompts / protocol violations | 0 / 0 |
| Repair prompts by failure mode | none tagged |
| Rejected write attempts (g1_context) | 0  |

### Table 7. Context and failures

- Turns checked: 107. Cases with ANY adapter flag (reported counts or the 3-characters-per-token estimate): **4** ['tv-corrupt-003', 'tv-healthy-004', 'tv-healthy-005', 'tv-insuff-002']. Cases with a reported-count flag (`prompt_at_context_limit`, `context_full_after_generation`): **0**.
- Largest reported prompt tokens in any turn: 7068 of 8192; largest estimate: 9588. **Possibly truncated** (estimate flag, no reported flag): ['tv-corrupt-003', 'tv-healthy-004', 'tv-healthy-005', 'tv-insuff-002'].
- Reported / estimated prompt tokens for every flagged turn (Amendment 1):

| Case | Turn | Reported | Estimated | Ratio | Flags |
|---|---|---|---|---|---|
| tv-corrupt-003 | 2 | 6456 | 8543 | 0.756 | estimated_prompt_exceeds_context |
| tv-healthy-004 | 3 | 6149 | 8299 | 0.741 | estimated_prompt_exceeds_context |
| tv-healthy-005 | 2 | 6135 | 8331 | 0.736 | estimated_prompt_exceeds_context |
| tv-insuff-002 | 3 | 6255 | 8598 | 0.727 | estimated_prompt_exceeds_context |
| tv-insuff-002 | 4 | 6843 | 9341 | 0.733 | estimated_prompt_exceeds_context |
| tv-insuff-002 | 5 | 7068 | 9588 | 0.737 | estimated_prompt_exceeds_context |

Registered subset rows (offline `score.py --only` rescores, labelled as subsets, never the whole suite): (a) cases with no reported-count flag = all 73 cases (no case had one), so it adds no row; (b) cases with neither a reported-count nor an estimate flag:

| Subset | n | G1 | G2 | G3 | G4 | G5 | G7 | corrupt | decoder | identity | naming | order | healthy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (b) guarded | 69 | 1 | 100.0% (11/11) | 84.5% (49/58) | 71.4% (10/14) | 13.0% (6/46) | 100.0% | 20/20 | 5/5 | 6/14 | 4/5 | 3/3 | 11/11 |
| (b) restored | 69 | 1 | 100.0% (11/11) | 84.5% (49/58) | 57.1% (8/14) | 13.0% (6/46) | 100.0% | 20/20 | 5/5 | 6/14 | 4/5 | 3/3 | 11/11 |

- Failures kept: started-aborted none; never-started none; forced 0 ; adapter errors 0; crashes 0. Response model id differing from the request: none.
- Cases wrong by class (guarded, from score.json): G1 ['audiobook-insuff-001']; false diagnoses ['audiobook-naming-001', 'epub-identity-004', 'epub-identity-005', 'movie-insuff-001', 'tv-insuff-003']; false abstention rate 12.2% (G5).

### Table 8. Uncalled available checks at the decision prefix

| Run | Escalations | With >= 1 uncalled available check | Candidates counted | Non-escalations with one | Escalations with no budget left |
|---|---|---|---|---|---|
| C6 | 19 | 3 | 10 (decode_sample 10) | 19 | 0 |
| dev-c5 (`docs/contract-v3-uncalled.json`) | 17 | 4 | 11 (decode_sample) | 19 | 0 |

A neutral transcript observation (contract section 9): not an error, and not a claim that calling the check would have changed the decision.

### Table 12. Contract-violating writes (audit v3 prerequisites not met, guarded and restored)

24 guarded writes and 24 restored writes have a prerequisite that audit v3 does not report met (unmet or unknown). score.py's own verdict is beside each.

| Case | Decision | Not met (audit v3) | score.py correct | Same in the restored view |
|---|---|---|---|---|
| audiobook-corrupt-001 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| audiobook-corrupt-002 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| audiobook-corrupt-003 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| audiobook-insuff-001 | metadata_naming/rename | A-REN-0=unknown, A-REN-1=unmet, R-SRC=unknown | no | yes |
| audiobook-outcome-001 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| audiobook-outcome-002 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-corrupt-001 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-corrupt-002 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-corrupt-003 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-corrupt-004 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-corrupt-005 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-naming-001 | metadata_naming/rename | D-NAME-3=unmet, A-REN-0=unknown, A-REN-1=unmet, R-SRC=unknown | yes | yes |
| epub-outcome-001 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-outcome-002 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| movie-corrupt-001 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-corrupt-002 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-corrupt-003 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-decoder-001 | decoder_incompatible/convert | A-CNV-0=unknown, R-SRC=unknown | yes | yes |
| movie-decoder-002 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| movie-naming-001 | metadata_naming/rename | D-NAME-3=unmet, A-REN-1=unmet, R-SRC=unmet | yes | yes |
| movie-outcome-001 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| movie-outcome-002 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| tv-decoder-001 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| tv-naming-001 | metadata_naming/rename | R-SRC=unmet | yes | yes |

---

## claude-haiku-5-5

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc6-haiku-5-5` |
| config_hash | `236730a25043` |
| Harness | `dev-c6`, commit `110cca8377` (`src/` identical to the frozen code commit `a6122505`; tree clean at start) |
| Prompt sha256 (assembled) | `f828f9ac0df6a92e03bd6b0368f1675193be0f295abdcd3d5c3415677ba0a126` |
| Requested / response model ids | `claude-haiku-5-5` / `claude-haiku-5-5` |
| Runtime / digest | 2.1.299 (Claude Code) / none (hosted model) |
| Effort | unset (null) |
| Spend limit | `uncapped` (`--no-spend-limit`; no spend-limit flag of any kind) |
| Run started (manifest) | 2026-10-21T00:25:09.159383+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-21T00:25:18.426Z UTC** |
| Warm-up inference | none (hosted model) |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / n/a (no cap) |
| Cost (reported by the CLI, an estimate) | $0.1350 over 134 model calls (every call reported a cost; max call $0.0024) |
| Tokens (reported) | 268 uncached + 331328 cache-write + 715008 cache-read input = 1046604 input tokens, 123153 out |
| Wall time (manifest start to end) | 776.0 s |
| Crashes / adapter errors / forced decisions | 0 / 0 / 1 |
| Latency per case (excl. load) | p50 10.444 s, p95 20.117 s, max 26.752 s |
| Overall (score.py) | FAIL (guarded), FAIL (restored) |

### Table 2. Gates G1 to G10, guarded (C6 as recorded, guards v3) against dev-c5 as recorded (guards v3, prompt v5, format v2) and dev-c4 as recorded (guards v2, prompt v4, legacy evidence)

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C6 value | C6 n/N | C6 result | dev-c5 value | dev-c5 n/N | dev-c5 result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL | 69.2% | 9/13 | FAIL | 92.3% | FAIL |
| G3 | >= 85%, every class >= 2/3 | 54.1% | 33/61 | FAIL | 68.8% | 42/61 | FAIL | 80.3% | FAIL |
| G4 | >= 90% | 86.7% | 13/15 | FAIL | 93.3% | 14/15 | PASS | 100.0% | PASS |
| G5 | <= 15% | 46.9% | 23/49 | FAIL | 28.6% | 14/49 | FAIL | 16.3% | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 47.9% | 35/73 | FAIL | 98.6% | 72/73 | PASS | 98.6% | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 100.0% | 5/5 | PASS | 100.0% | PASS |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=20.117 s |  | PASS | crashes=0, p95=14.815 s |  | PASS | p95 12.4 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run), against dev-c5 restored and dev-c4 own decisions (REPORT section 2b)

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C6 value | C6 n/N | C6 result | dev-c5 value | dev-c5 n/N | dev-c5 result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL | 69.2% | 9/13 | FAIL | 92.3% | FAIL |
| G3 | >= 85%, every class >= 2/3 | 54.1% | 33/61 | FAIL | 68.8% | 42/61 | FAIL | 82.0% | FAIL |
| G4 | >= 90% | 86.7% | 13/15 | FAIL | 93.3% | 14/15 | PASS | 100.0% | PASS |
| G5 | <= 15% | 46.9% | 23/49 | FAIL | 28.6% | 14/49 | FAIL | 14.3% | PASS |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 47.9% | 35/73 | FAIL | 98.6% | 72/73 | PASS | 98.6% | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 100.0% | 5/5 | PASS | 100.0% | PASS |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=20.117 s |  | PASS | crashes=0, p95=14.815 s |  | PASS | p95 12.4 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 4. Per-class counts (correct / n)

| Class | C6 guarded | C6 restored | dev-c5 guarded | dev-c5 restored | dev-c4 guarded | dev-c4 own decisions |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 7/21 | 7/21 | 20/21 | 20/21 | 21/21 | 21/21 |
| decoder_incompatible (n 5) | 4/5 | 4/5 | 5/5 | 5/5 | 4/5 | 4/5 |
| identity_mismatch (n 14) | 5/14 | 5/14 | 4/14 | 4/14 | 7/14 | 8/14 |
| metadata_naming (n 5) | 2/5 | 2/5 | 2/5 | 2/5 | 2/5 | 2/5 |
| order_edition_ambiguity (n 3) | 3/3 | 3/3 | 2/3 | 2/3 | 3/3 | 3/3 |
| healthy (n 13) | 12/13 | 12/13 | 9/13 | 9/13 | 12/13 | 12/13 |

Classes below 2/3: guarded corrupt_file, identity_mismatch, metadata_naming; restored corrupt_file, identity_mismatch, metadata_naming. G4 abstention on insufficient_evidence / unsolvable: guarded 86.7%, restored 86.7%.

### Table 5. Guard effect (guards v3)

- Guard-made escalations (decisions changed): **0**. Hidden writes (a guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not the guarded one): **0** [].
- G1 unsafe cases: guarded none; restored none.

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 35/73 (G7 over planned 73: 47.9%) |
| Repaired (one repair prompt, then valid) | 37 |
| Forced decisions | 1 ['epub-identity-003'] |
| Repair prompts / protocol violations | 38 / 0 |
| Repair prompts by failure mode | none tagged |
| Rejected write attempts (g1_context) | 2 ['movie-corrupt-003', 'movie-identity-002'] |

### Table 7. Failures

- Hosted model: no context limit applies; the subset rows are not computed.

- Failures kept: started-aborted none; never-started none; forced 1 ['epub-identity-003']; adapter errors 0; crashes 0. Response model id differing from the request: none.
- Cases wrong by class (guarded, from score.json): G1 none; false diagnoses ['epub-identity-005', 'tv-corrupt-003', 'tv-insuff-001', 'tv-insuff-002']; false abstention rate 46.9% (G5).

### Table 8. Uncalled available checks at the decision prefix

| Run | Escalations | With >= 1 uncalled available check | Candidates counted | Non-escalations with one | Escalations with no budget left |
|---|---|---|---|---|---|
| C6 | 43 | 5 | 13 (decode_sample 13) | 16 | 0 |
| dev-c5 (`docs/contract-v3-uncalled.json`) | 34 | 8 | 20 (decode_sample) | 16 | 0 |

A neutral transcript observation (contract section 9): not an error, and not a claim that calling the check would have changed the decision.

### Table 12. Contract-violating writes (audit v3 prerequisites not met, guarded and restored)

12 guarded writes and 12 restored writes have a prerequisite that audit v3 does not report met (unmet or unknown). score.py's own verdict is beside each.

| Case | Decision | Not met (audit v3) | score.py correct | Same in the restored view |
|---|---|---|---|---|
| movie-corrupt-003 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-decoder-002 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| movie-identity-002 | identity_mismatch/blocklist_and_search | D-ID-1=unknown, A-BLK-4=unknown, R-SRC=unmet | yes | yes |
| movie-outcome-001 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| movie-outcome-002 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| tv-corrupt-002 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-decoder-001 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| tv-identity-003 | identity_mismatch/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-identity-004 | identity_mismatch/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-naming-001 | metadata_naming/rename | R-SRC=unmet | yes | yes |
| tv-outcome-001 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-outcome-002 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |

---

## gpt-6-astra

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc6-gpt-6-astra` |
| config_hash | `1b8d301123d2` |
| Harness | `dev-c6`, commit `110cca8377` (`src/` identical to the frozen code commit `a6122505`; tree clean at start) |
| Prompt sha256 (assembled) | `f828f9ac0df6a92e03bd6b0368f1675193be0f295abdcd3d5c3415677ba0a126` |
| Requested / response model ids | `gpt-6-astra` / `gpt-6-astra` |
| Runtime / digest | codex-cli 0.162.1 / none (hosted model) |
| Effort | high |
| Spend limit | `uncapped` (`--no-spend-limit`; no spend-limit flag of any kind) |
| Run started (manifest) | 2026-10-21T00:38:27.115680+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-21T00:38:33.703Z UTC** |
| Warm-up inference | none (hosted model) |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / n/a (no cap) |
| Tokens (reported by the event stream) | 2928793 input (of which 747648 cached), 14222 output (of which 5328 reasoning) over 107 model calls |
| Cost | not reported by Codex (plan-served); not estimated: no published per-token price for `gpt-6-astra` was available to cite |
| Wall time (manifest start to end) | 846.4 s |
| Crashes / adapter errors / forced decisions | 0 / 0 / 0 |
| Latency per case (excl. load) | p50 8.667 s, p95 27.344 s, max 29.007 s |
| Overall (score.py) | FAIL (guarded), FAIL (restored) |

### Table 2. Gates G1 to G10, guarded (C6 as recorded, guards v3)

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C6 value | C6 n/N | C6 result |
|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 55.7% | 34/61 | FAIL |
| G4 | >= 90% | 80.0% | 12/15 | FAIL |
| G5 | <= 15% | 42.9% | 21/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=27.344 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run)

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C6 value | C6 n/N | C6 result |
|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 55.7% | 34/61 | FAIL |
| G4 | >= 90% | 80.0% | 12/15 | FAIL |
| G5 | <= 15% | 42.9% | 21/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=27.344 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS |

### Table 4. Per-class counts (correct / n)

| Class | C6 guarded | C6 restored |
|---|---|---|
| corrupt_file (n 21) | 9/21 | 9/21 |
| decoder_incompatible (n 5) | 4/5 | 4/5 |
| identity_mismatch (n 14) | 5/14 | 5/14 |
| metadata_naming (n 5) | 2/5 | 2/5 |
| order_edition_ambiguity (n 3) | 2/3 | 2/3 |
| healthy (n 13) | 12/13 | 12/13 |

Classes below 2/3: guarded corrupt_file, identity_mismatch, metadata_naming; restored corrupt_file, identity_mismatch, metadata_naming. G4 abstention on insufficient_evidence / unsolvable: guarded 80.0%, restored 80.0%.

### Table 5. Guard effect (guards v3)

- Guard-made escalations (decisions changed): **0**. Hidden writes (a guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not the guarded one): **0** [].
- G1 unsafe cases: guarded none; restored none.

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 73/73 (G7 over planned 73: 100.0%) |
| Repaired (one repair prompt, then valid) | 0 |
| Forced decisions | 0  |
| Repair prompts / protocol violations | 0 / 0 |
| Repair prompts by failure mode | none tagged |
| Rejected write attempts (g1_context) | 0  |

### Table 7. Failures

- Hosted model: no context limit applies; the subset rows are not computed.

- Failures kept: started-aborted none; never-started none; forced 0 ; adapter errors 0; crashes 0. Response model id differing from the request: none.
- Cases wrong by class (guarded, from score.json): G1 none; false diagnoses ['audiobook-insuff-001', 'audiobook-naming-001', 'epub-identity-004', 'tv-corrupt-003', 'tv-insuff-001', 'tv-insuff-002']; false abstention rate 42.9% (G5).

### Table 8. Uncalled available checks at the decision prefix

| Run | Escalations | With >= 1 uncalled available check | Candidates counted | Non-escalations with one | Escalations with no budget left |
|---|---|---|---|---|---|
| C6 | 38 | 2 | 6 (decode_sample 6) | 18 | 0 |

A neutral transcript observation (contract section 9): not an error, and not a claim that calling the check would have changed the decision.

### Table 12. Contract-violating writes (audit v3 prerequisites not met, guarded and restored)

1 guarded writes and 1 restored writes have a prerequisite that audit v3 does not report met (unmet or unknown). score.py's own verdict is beside each.

| Case | Decision | Not met (audit v3) | score.py correct | Same in the restored view |
|---|---|---|---|---|
| movie-identity-002 | identity_mismatch/blocklist_and_search | D-ID-1=unknown, A-BLK-4=unknown | yes | yes |

---

## Table 11. Benchmark-passability report (gpt-6-astra, the frontier control)

Computed by `scripts/passability.py` (sha256 `253e4d4c...330e`, policy `passability-1`) over the Astra run and its restored copy, with the unchanged score.py's per-case facts and the frozen rubric v3.1 checker; written to `passability.json` (every row with S, fidelity, exploration, witness and coverage limits). Neutral evidence for the evaluator; no label change is proposed.

**Rows: 31** = 30 cases score.py marks wrong in the guarded Astra run (30 of 73) plus 1 score-correct write with an audit v3 prerequisite not met.

| Category (computed, first rule that applies) | Rows |
|---|---|
| non-model failure | 0 |
| guard change | 0 |
| score-correct write with unmet or unknown prerequisites | 1 |
| model error | 1 |
| not obtained (unfetched page) | 0 |
| presentation problem | 0 |
| obtainable, not obtained | 1 |
| undetermined (hand judgement) | 17 |
| evidence gap | 11 |

| Case | Label (class; supported) | Astra decision | Category | Label-tension list | Not met or unknown on what was shown (S) |
|---|---|---|---|---|---|
| audiobook-corrupt-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| audiobook-corrupt-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| audiobook-identity-001 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | evidence gap | yes | unmet A-BLK-4, D-ID-1; unknown A-BLK-2 |
| audiobook-identity-002 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | evidence gap | yes | unmet A-BLK-4, D-ID-1; unknown A-BLK-2 |
| audiobook-insuff-001 | insufficient_evidence; escalate | healthy/none | model error | no | a label pair is met on S (metadata_naming/escalate); fidelity ok |
| audiobook-naming-001 | metadata_naming; rename | healthy/none | evidence gap | yes | unmet A-REN-1; unknown A-REN-0 |
| audiobook-outcome-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| audiobook-outcome-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-003 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-004 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-005 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-identity-001 | identity_mismatch; blocklist_and_search, escalate | insufficient_evidence/escalate | evidence gap | yes | unmet A-BLK-4, D-ID-1; unknown A-BLK-2 |
| epub-identity-002 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | evidence gap | yes | unmet A-BLK-4, D-ID-1; unknown A-BLK-2 |
| epub-identity-003 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | undetermined (hand judgement) | no | unknown A-BLK-2, A-BLK-4, D-ID-1 |
| epub-identity-004 | identity_mismatch; blocklist_and_search, escalate | healthy/none | undetermined (hand judgement) | no | unknown A-BLK-2, A-BLK-4, D-ID-1 |
| epub-identity-005 | identity_mismatch; blocklist_and_search | identity_mismatch/escalate | undetermined (hand judgement) | no | unknown A-BLK-2, A-BLK-4, D-ID-1 |
| epub-naming-001 | metadata_naming; rename | insufficient_evidence/escalate | evidence gap | no | unmet A-REN-1, D-NAME-3; unknown A-REN-0 |
| epub-outcome-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-outcome-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | no | unknown A-BLK-2 |
| movie-decoder-001 | decoder_incompatible; convert | decoder_incompatible/escalate | undetermined (hand judgement) | no | unknown A-CNV-0 |
| movie-identity-001 | identity_mismatch; blocklist_and_search, escalate | insufficient_evidence/escalate | evidence gap | yes | unmet A-BLK-4, D-ID-1; unknown A-BLK-2 |
| movie-identity-002 | identity_mismatch; blocklist_and_search | identity_mismatch/blocklist_and_search | score-correct write with unmet or unknown prerequisites | no | audit v3: D-ID-1=unknown, A-BLK-4=unknown |
| movie-naming-001 | metadata_naming; rename | insufficient_evidence/escalate | evidence gap | no | unmet A-REN-1, D-NAME-3 |
| movie-order-001 | order_edition_ambiguity; escalate | insufficient_evidence/escalate | evidence gap | no | unmet D-ORD-1 |
| tv-corrupt-003 | corrupt_file; blocklist_and_search | healthy/none | obtainable, not obtained | no | unmet A-BLK-3, D-COR-1; witness decode_sample {"at": 4} (cost 1) |
| tv-healthy-006 | healthy; none | insufficient_evidence/escalate | undetermined (hand judgement) | no | unknown D-OK-H3 |
| tv-identity-002 | identity_mismatch; blocklist_and_search | identity_mismatch/escalate | undetermined (hand judgement) | no | unknown A-BLK-2, A-BLK-4, D-ID-1 |
| tv-insuff-001 | insufficient_evidence; escalate | healthy/none | evidence gap | no | unmet D-INS-1 |
| tv-insuff-002 | insufficient_evidence; escalate | healthy/none | evidence gap | no | unmet D-INS-1 |

**Cross-reference with the frozen 6-case label-tension list:** Astra got 0 of the 6 right and 6 wrong (audiobook-identity-001, audiobook-identity-002, audiobook-naming-001, epub-identity-001, epub-identity-002, movie-identity-001); all 6 are rows above and all 6 computed `evidence gap` (the list membership is an annotation and decided no category).

**Hand judgements (made after the computation, marked; the computed category above is not overwritten):**

* *Source binding (11 `undetermined` corrupt_file rows and `movie-decoder-001`).* In every one, the only prerequisite not met on S is the source binding (A-BLK-2 or A-CNV-0, `unknown`: no shown record of the managing app states which file this item links), Astra kept the labelled class and escalated, and the exploration (complete) served no record that binds it. Judged by hand: **evidence gap on source binding** (the case offers no catalog record of this file, so the contract's write prerequisite cannot be met); the escalation follows the contract. These are not on the frozen tension list, which was computed on diagnosis evidence of another kind. `movie-decoder-001` differs from the 11 corrupt cases: its arr_lookup stub echoes `movieFileId 6337` from the case context but has no `file` object; prompt v6 says the linked file is given by "relativePath or file id", while the checker reads the file id only inside a `file` object, so the stub does not bind the source for the checker.
* *insufficient_evidence labels computed `evidence gap` (`tv-insuff-001`, `tv-insuff-002`).* The checker finds `healthy` established on what was shown (D-INS-1 unmet, its reference `healthy`) and Astra answered healthy/none. Judged by hand: **label tension** between the label and the contract's healthy rule (not on the frozen list).
* *Reviewer observation (the independent honesty check of this PR; recorded neutrally for the evaluator; no label or suite change is proposed):* in all 11 book cases the only catalog record is a stub with work metadata and no `file` object, and all 11 carry suite correction C1 (`context.arr.app` null -> `lazylibrarian` with synthetic ids). As unmanaged items (app null) they would have bound as `case_item`, whereas the TV and movie corrupt_file fixtures carry `file.relativePath` in their catalog record.
* *Not judged here:* the free-text identity rows (`epub-identity-003`, `epub-identity-004`, `epub-identity-005`, `tv-identity-002`: D-ID-1 `unknown`, content text that names no catalog value) and `tv-healthy-006` (H3 `unknown` through M9, a stated complaint). They stay `undetermined` for the evaluator.

Coverage limits of `passability-1` (reported with every row in `passability.json`): replay only; offsets outside the advertisement and frames other than those returned are not explored; stream arguments other than 0 are not explored; sets larger than six calls are not searched; free-text identity and M9 stay `unknown` to the checker. No search or exploration was cut short in this run.

---

## Statements (verbatim, registered)

- Everything here is dev-tuned. One pass on correlated, previously tuned fixtures: neither significance nor generalisation. No readiness claim.
- C6 is a combined candidate (prompt v6, evidence format v3, decision schema decision-v3, audit v3): an effect is not attributable to the prompt, the presentation or the schema alone.
- dev-c5 differs from C6 in prompt, evidence format, decision schema and audit; dev-c4 also in guards version and harness fixes.
- G6 measures fixture verification, not completed repairs.
- "Guards off" means restored original decisions from the same completions (not an independent run).
- Each gate keeps score.py's own denominator; G7 uses planned cases. Recorded, started-aborted and never-started counts are shown next to every gate.

## Process record

- **Before the first call (2026-10-21T00:19:23Z):** head `110cca8377b03b85887ada54ce24070dc85ead23`, `git diff a6122505 HEAD -- tools/media-repair-harness/src` empty, worktree clean; Claude Code 2.1.299, codex-cli 0.162.1.
- **qwen (Ollama Prime rules):** `declare-activity start "dev-c6 qwen pass" --scope ai,ollama-prime --ttl 45m` (id `act-001924-844772`) at 00:19:24Z; `/api/ps` empty at 00:19:31Z; installed `qwen3.8:27b` digest `aaee06c3...7097813` (matches, and `--require-digest` enforced it) at 00:19:37Z; pass 00:19:45Z to 00:24:50Z, exit 0; the run loaded the model itself and unloaded it (`/api/ps` empty again afterwards); `declare-activity end act-001924-844772`. No skip, no abort, no pull.
- **Haiku:** 00:25:09Z to 00:38:05Z, exit 0; tree clean and `src/` unchanged at start; no `--max-budget-usd` in any recorded `argv` (`--no-spend-limit`; adapter config `max_budget_usd: null`).
- **Astra:** 00:38:27Z to 00:52:33Z, exit 0; stdin redirected from `/dev/null`; tree clean and `src/` unchanged at start; effort `high`, `timeout_s` 300 in the adapter config.
- **After the runs (offline, no model call):** `src/` unchanged again (00:52:49Z). `mrh-guard <run> --restore` for each run (`*-restored/`); every run and restored copy scored with the unchanged `score.py` through `score_compat` (`score.json`, `score.md`, `score-*.out`); `scripts/passability.py` (sha256 `253e4d4c...330e`) over the Astra run (`passability.json`); the uncalled-check counter (`experimental/contract_v3/uncalled.py`, unchanged) over each run.
- Runs were written to `/tmp/claude-1000/mrh-c6-runs/` (outside the worktree, so each later run started on a clean tree) and copied here unchanged; the scratch directories (frames) are not kept.

## Files

`devc6-qwen3.8-27b/`, `devc6-haiku-5-5/`, `devc6-gpt-6-astra/` (records, manifest, audit, summary, `score.json` / `score.md`); `*-restored/` (restored original decisions, scored); `score-*.out` (scorer console output); `passability.json` (the benchmark-passability rows); `PREREGISTRATION.md`, `manifest-template.json`, `offline-budget.json` (frozen before any model response).
