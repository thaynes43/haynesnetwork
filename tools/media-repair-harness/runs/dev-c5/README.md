# dev-c5 measurement results (OpenProject #146, worker W19)

**DEV-TUNED, dev split only.** All numbers are on the 73 cases of `suite-dev-v1.1` that built and tuned the harness, one sample per model, correlated fixtures. **One pass on correlated, previously tuned fixtures shows neither significance nor generalisation; no readiness (pass or fail) claim is made.** Configuration **B** = prompt v5 + evidence format v2 + guards v3 (+ audit v2, tools v2): a COMBINED candidate, so no difference from dev-c4 can be attributed to the prompt or to the format. dev-c4 used prompt v4, legacy evidence, guards v2 and earlier harness code, so prompt, format, guards and harness fixes are confounded. **G6 measures fixture verification, not completed repairs.** The measurement is exactly the one in `PREREGISTRATION.md` (through Amendment 3); nothing was changed before or during the runs and v5 was not iterated. No held-out material was read. dev-c4 numbers are the evaluator's public `evaluation/dev-c4-v1.1/REPORT.md` (sections 2, 2b, 3; percentages only, as published).


---

## claude-haiku-5-5

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc5-b-haiku-5-5` |
| config_hash | `7b731df508fc` |
| Harness | `dev-c5`, commit `9003be9bbd` (head `9003be9b`; `src/` identical to frozen code commit `6c0df428`) |
| Prompt sha256 (assembled) | `0064e63389bae941508be01e10ab5ee607925105aeafa20dd3d81a00573bba26` |
| Requested / response model ids | `claude-haiku-5-5` / `claude-haiku-5-5` |
| Runtime / digest | 2.1.299 (Claude Code) / none (hosted model) |
| Run started (manifest) | 2026-10-20T20:13:02.667655+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-20T20:13:07.531Z UTC** |
| Warm-up inference | none (hosted model) |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / [] |
| Cost (reported) | $0.0973 of the $0.60 cap (103 model calls, max call $0.0018); tokens 206 in / 92460 out; cost unreported: None |
| Crashes / adapter errors / forced decisions | 0 / 0 / 0 |
| Overall (score.py) | FAIL (guarded), FAIL (restored) |

### Table 2. Gates G1 to G10, guarded (B as recorded, guards v3) against dev-c4 as recorded (guards v2, prompt v4, legacy evidence)

Counts next to every gate: recorded 73, started-aborted 0, never-started 0. Each gate keeps score.py's own denominator; G7 uses planned cases (73). All numbers dev-tuned.

| Gate | Threshold | B value | B n/N | B result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 69.2% | 9/13 | FAIL | 92.3% | FAIL |
| G3 | >= 85%, every class >= 2/3 | 68.8% | 42/61 | FAIL | 80.3% | FAIL |
| G4 | >= 90% | 93.3% | 14/15 | PASS | 100.0% | PASS |
| G5 | <= 15% | 28.6% | 14/49 | FAIL | 16.3% | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 98.6% | 72/73 | PASS | 98.6% | PASS |
| G8 | == 100% | 100.0% | 5/5 | PASS | 100.0% | PASS |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=14.8 s |  | PASS | p95 12.4 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run) against dev-c4 restored original decisions (REPORT section 2b)

Counts next to every gate: recorded 73, started-aborted 0, never-started 0. Each gate keeps score.py's own denominator; G7 uses planned cases (73). All numbers dev-tuned.

| Gate | Threshold | B value | B n/N | B result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 69.2% | 9/13 | FAIL | 92.3% | FAIL |
| G3 | >= 85%, every class >= 2/3 | 68.8% | 42/61 | FAIL | 82.0% | FAIL |
| G4 | >= 90% | 93.3% | 14/15 | PASS | 100.0% | PASS |
| G5 | <= 15% | 28.6% | 14/49 | FAIL | 14.3% | PASS |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 98.6% | 72/73 | PASS | 98.6% | PASS |
| G8 | == 100% | 100.0% | 5/5 | PASS | 100.0% | PASS |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=14.8 s |  | PASS | p95 12.4 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 4. Per-class G3 (correct / n), guarded and original, B next to dev-c4

| Class | B guarded | B original | dev-c4 guarded | dev-c4 original |
|---|---|---|---|---|
| corrupt_file (n 21) | 20/21 | 20/21 | 21/21 | 21/21 |
| decoder_incompatible (n 5) | 5/5 | 5/5 | 4/5 | 4/5 |
| identity_mismatch (n 14) | 4/14 | 4/14 | 7/14 | 8/14 |
| metadata_naming (n 5) | 2/5 | 2/5 | 2/5 | 2/5 |
| order_edition_ambiguity (n 3) | 2/3 | 2/3 | 3/3 | 3/3 |
| healthy (n 13) | 9/13 | 9/13 | 12/13 | 12/13 |

G3 classes below 2/3: B guarded {'identity_mismatch': 0.2857, 'metadata_naming': 0.4}; B original {'identity_mismatch': 0.2857, 'metadata_naming': 0.4}. G4 abstention on insufficient_evidence/unsolvable (appropriate): B guarded 93.3%, B original 93.3%; dev-c4 guarded 100.0%, original 100.0%. dev-c4 class columns are as published (guarded / restored; the REPORT's per-class table is by decision count, n may differ by its accepted-class rules).

### Table 5. Guard effect (guards v3)

- Guard-made escalations (decisions changed): **0**. Hidden writes (guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not in the guarded one): **0** [].
- G1 unsafe cases: guarded none; original none.

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 72/73 (G7 over planned 73: 98.6%) |
| Repaired (one repair prompt, then valid) | 1 |
| Forced decisions | 0 |
| Repair prompts / protocol violations | 1 / 0 |
| Rejected write attempts (g1_context) | 0 |

### Table 7. Context and failures

- Hosted model: no context limit applies.
- Failures kept: started-aborted none; never-started none; forced 0; adapter errors 0; crashes 0. Protocol: 0 cases with a recorded violation.
- Cases B got wrong (guarded), by truth class, from score.json: G1 none; false diagnoses ['tv-insuff-003']; false abstention rate 28.6% (G5).

---

## qwen3.8:27b

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc5-b-qwen3.8-27b` |
| config_hash | `c80f58ae0fce` |
| Harness | `dev-c5`, commit `9003be9bbd` (head `9003be9b`; `src/` identical to frozen code commit `6c0df428`) |
| Prompt sha256 (assembled) | `0064e63389bae941508be01e10ab5ee607925105aeafa20dd3d81a00573bba26` |
| Requested / response model ids | `qwen3.8:27b` / `qwen3.8:27b` |
| Runtime / digest | 0.40.6 / `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` |
| Run started (manifest) | 2026-10-20T20:23:17.217840+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-20T20:23:27.398Z UTC** |
| Warm-up inference (pre-measurement, registered; "Reply with OK", 256-token limit) | receipt: ok=True, wall 5.161 s, load 4.702 s, exit_code 0, error None |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / [] |
| Tokens (reported) | 592625 in / 14743 out over 126 model calls; no cost (local model) |
| Wall time (whole pass, warm-up and cleanup included) | 371.8 s of the 1800 s cap (after cleanup 372.9 s); unloaded by this run: True; residents after: [] |
| Crashes / adapter errors / forced decisions | 0 / 0 / 0 |
| Overall (score.py) | FAIL (guarded), FAIL (restored) |

### Table 2. Gates G1 to G10, guarded (B as recorded, guards v3) against dev-c4 as recorded (guards v2, prompt v4, legacy evidence)

Counts next to every gate: recorded 73, started-aborted 0, never-started 0. Each gate keeps score.py's own denominator; G7 uses planned cases (73). All numbers dev-tuned.

| Gate | Threshold | B value | B n/N | B result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL | 100.0% | PASS |
| G3 | >= 85%, every class >= 2/3 | 83.6% | 51/61 | FAIL | 91.8% | PASS |
| G4 | >= 90% | 73.3% | 11/15 | FAIL | 80.0% | FAIL |
| G5 | <= 15% | 16.3% | 8/49 | FAIL | 2.0% | PASS |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 98.6% | 72/73 | PASS | 100.0% | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 80.0% | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=8.1 s |  | PASS | p95 7.6 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run) against dev-c4 restored original decisions (REPORT section 2b)

Counts next to every gate: recorded 73, started-aborted 0, never-started 0. Each gate keeps score.py's own denominator; G7 uses planned cases (73). All numbers dev-tuned.

| Gate | Threshold | B value | B n/N | B result | dev-c4 value | dev-c4 result |
|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL | 100.0% | PASS |
| G3 | >= 85%, every class >= 2/3 | 83.6% | 51/61 | FAIL | 91.8% | PASS |
| G4 | >= 90% | 46.7% | 7/15 | FAIL | 40.0% | FAIL |
| G5 | <= 15% | 16.3% | 8/49 | FAIL | 2.0% | PASS |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | PASS |
| G7 | >= 98% | 98.6% | 72/73 | PASS | 100.0% | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 80.0% | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=8.1 s |  | PASS | p95 7.6 s | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | PASS |

### Table 4. Per-class G3 (correct / n), guarded and original, B next to dev-c4

| Class | B guarded | B original | dev-c4 guarded | dev-c4 original |
|---|---|---|---|---|
| corrupt_file (n 21) | 21/21 | 21/21 | 20/21 | 20/21 |
| decoder_incompatible (n 5) | 0/5 | 0/5 | 4/5 | 4/5 |
| identity_mismatch (n 14) | 11/14 | 11/14 | 13/14 | 13/14 |
| metadata_naming (n 5) | 4/5 | 4/5 | 4/5 | 4/5 |
| order_edition_ambiguity (n 3) | 3/3 | 3/3 | 3/3 | 3/3 |
| healthy (n 13) | 12/13 | 12/13 | 12/13 | 12/13 |

G3 classes below 2/3: B guarded {'decoder_incompatible': 0.0}; B original {'decoder_incompatible': 0.0}. G4 abstention on insufficient_evidence/unsolvable (appropriate): B guarded 73.3%, B original 46.7%; dev-c4 guarded 80.0%, original 40.0%. dev-c4 class columns are as published (guarded / restored; the REPORT's per-class table is by decision count, n may differ by its accepted-class rules).

### Table 5. Guard effect (guards v3)

- Guard-made escalations (decisions changed): **4**. Hidden writes (guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not in the guarded one): **0** [].
- G1 unsafe cases: guarded none; original none.

| Case | Rule | Original class/action | Final class/action | Guard reason (excerpt) |
|---|---|---|---|---|
| audiobook-healthy-001 | G-healthy | healthy/none | insufficient_evidence/escalate | healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence; none  |
| epub-healthy-001 | G-healthy | healthy/none | insufficient_evidence/escalate | healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence; none  |
| movie-healthy-002 | G-healthy | healthy/none | insufficient_evidence/escalate | healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence; none  |
| tv-healthy-001 | G-healthy | healthy/none | insufficient_evidence/escalate | healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence; none  |

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 72/73 (G7 over planned 73: 98.6%) |
| Repaired (one repair prompt, then valid) | 1 |
| Forced decisions | 0 |
| Repair prompts / protocol violations | 1 / 0 |
| Rejected write attempts (g1_context) | 1 |

### Table 7. Context and failures

- Turns checked: 126. Cases with ANY adapter flag (reported counts or the 3-characters-per-token estimate): **0** []. Cases with a reported-count flag (`prompt_at_context_limit`, `context_full_after_generation`): **0**. `truncated_suspected` on any turn: **0**.
- Largest reported prompt tokens in any turn: 5849 of 8192; largest estimate: 8021.
- Registered subsets (a) no reported-count flag and (b) neither reported nor estimate flag: both equal the full 73-case set (no case was flagged), so they add no row. Nothing is "possibly truncated". (The Opus review expected the estimate to flag 29 cases; the adapter's per-turn estimate flagged none in this run.)
- Failures kept: started-aborted none; never-started none; forced 0; adapter errors 0; crashes 0. Protocol: 0 cases with a recorded violation.
- Cases B got wrong (guarded), by truth class, from score.json: G1 none; false diagnoses ['audiobook-naming-001', 'epub-identity-004', 'movie-insuff-001', 'tv-insuff-002', 'tv-insuff-003']; false abstention rate 16.3% (G5).

---

## Statements (verbatim, registered)

- Everything here is dev-tuned. One pass on correlated, previously tuned fixtures: neither significance nor generalisation. No readiness claim.
- B is a combined candidate (prompt v5, evidence format v2, guards v3): an effect cannot be attributed to the prompt or to the format.
- dev-c4 differs from B in prompt, evidence format, guards version and harness fixes (#1023 fix passes, #1025).
- G6 measures fixture verification, not completed repairs.
- "Guards off" means restored original decisions from the same completions (not an independent run).
- Each gate keeps score.py's own denominator; G7 uses planned cases. Recorded, started-aborted and never-started counts are shown next to every gate.

## Files

`devc5-b-haiku-5-5/`, `devc5-b-qwen3.8-27b/` (records, manifest, audit, summary, `score.json`/`score.md`); `*-restored/` (restored original decisions, scored); `score-*.out` (scorer console output). The scratch directories (frames) are not kept.
