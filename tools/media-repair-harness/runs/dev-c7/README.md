# dev-c7 measurement results (OpenProject #154, worker W23)

**DEV-TUNED, dev split only.** All numbers are on the 73 cases of `suite-dev-v1.1` that built and tuned the harness, one sample per model, correlated fixtures. **One pass on correlated, previously tuned fixtures shows neither significance nor generalisation; no readiness (pass or fail) claim is made.** Configuration **C7** = prompt v7 + evidence format v3.1-format + turn protocol `turn-v3` / decision schema `decision-v3` + audit v3 (v3.1 typing) + guards v3 + tools behaviour v3 + `pages-v1`, page budget 8192, qwen at `num_ctx 16384`: a COMBINED candidate, so no difference from dev-c6 or dev-c5 can be attributed to the prompt, the presentation, the tools or the context alone. **G6 measures fixture verification, not completed repairs.**
The measurement is exactly the one in `PREREGISTRATION.md` through Amendment 2: three runs in the registered order (qwen, Haiku, then `gpt-6-astra` as the frontier control and benchmark check), the registered commands, from head `5c156965` with the frozen `src/` tree `36a08be3d70027533f56d41250edc940053e31df`. `src/` was identical to the frozen tree before the first model call (04:38:24Z) and after the last (05:09:58Z); nothing in `src/`, the scripts, the prompts or the pre-registration changed before or during the runs, and v7 was not iterated. Every run's `config_hash` equals the pre-registered one (qwen `612a2325...`, Haiku `b8e8f517...`, Astra `be2e0e59...`), every response model id equals the request, and the manifests match `manifest-template.json` on every frozen field. No held-out material was read. dev-c6 numbers are `runs/dev-c6/*/score.json`; dev-c5 numbers are `runs/dev-c5/*/score.json`; percentages are recomputed from score.py's numerators and denominators.

## Result in words

**qwen3.8:27b: ABORTED after 5 of 73 cases, by an event outside this measurement. PARTIAL; no regression or gain can be read from it.** The GPU check at the warm-up passed (100% GPU, `size_vram == size` = 17,361,985,862 bytes, context length 16384). At 04:39:12Z, 33 s into the pass, Flux replaced the `ollama-prime` pod to upgrade Ollama from 0.40.6 to 0.40.7 (haynes-ops #4158, merged 04:35:21Z). The call in flight (`audiobook-healthy-002`) failed in transit and was recorded as a forced escalate (an adapter error). The next case's `/api/ps` read failed, so the runner stopped as registered: `aborted: cannot read /api/ps (1); refusing to touch the GPU blind`, exit 3. Cases: 5 recorded (4 model decisions and the forced one), 0 started-aborted, 68 never started. No reload was detected before the stop (every per-call `load_duration` was at most 1.2 ms). The registered cleanup unload failed because the pod was already gone; the pod's termination had freed the GPU. A read-only check of the replacement pod (Ollama 0.40.7) at 04:40:17Z showed `/api/ps` empty. The registration forbids a rerun ("a load failure ... aborts; none is repeated"; no rerun of any run), so none was made. A complete qwen measurement needs a new registered decision, and it would run on Ollama 0.40.7: a new confound against dev-c6's 0.40.6.

**claude-haiku-5-5 against dev-c6 (guarded): mostly WORSE.**
- Regressions:
  - G3 54.1% -> **50.8%** (31/61);
  - G4 86.7% -> **73.3%** (11/15);
  - G5 46.9% -> **51.0%** (25/49);
  - decoder_incompatible 4/5 -> **3/5** (now below 2/3);
  - identity_mismatch 5/14 -> 4/14;
  - order_edition_ambiguity 3/3 -> 2/3;
  - forced decisions 1 -> 2.
- Gains:
  - G7 47.9% -> **65.8%** (48/73), still a FAIL;
  - corrupt_file 7/21 -> 8/21.
- Unchanged: G1 (0), G2 (92.3%, 12/13), G6, G8 (80%), G10, metadata_naming (2/5) and healthy (12/13).

**Haiku against dev-c5:**
- Worse: G3 68.8% -> 50.8%, G4 93.3% -> 73.3%, G5 28.6% -> 51.0%, G7 98.6% -> 65.8%, G8 100% -> 80%, corrupt_file 20/21 -> 8/21 and decoder 5/5 -> 3/5.
- Better: G2 69.2% -> 92.3% and healthy 9/13 -> 12/13.
- Equal: identity (4/14), naming (2/5) and order (2/3).

Haiku's G7 shortfall is still the reply length limits (22 first replies with a `reason` over 400 characters and 3 with a `why` over 200, each sent the one repair prompt); the two forced decisions are replies still too long after it.

**gpt-6-astra (frontier control, effort high) against dev-c6 Astra: slightly BETTER, still failing the same gates.**
- Gains: G2 92.3% -> **100%** (13/13, now PASS), G3 55.7% -> **59.0%** (36/61), order_edition_ambiguity 2/3 -> 3/3 and healthy 12/13 -> 13/13.
- Equal: G1 (0), G4 (80.0%, 12/15), G5 (42.9%, 21/49), G6, G7 (100%), G8 (80%), G10, corrupt_file (9/21), decoder (4/5), identity (5/14) and naming (2/5).
- The frontier control still fails G3 and G5 by wide margins. That is the benchmark check this run was registered for (Table 11).
- The passability report has 29 rows (dev-c6: 31):
  - 1 model error (`movie-insuff-001`);
  - 1 obtainable-but-not-obtained (`tv-corrupt-003`, a one-call `decode_sample` witness, as in dev-c6);
  - 1 score-correct write with unknown prerequisites;
  - 17 undetermined;
  - 9 evidence gaps.
- Astra again got none of the 6 label-tension cases right.

Caveats that stay: dev-tuned fixtures, a single pass per model, several confounds (prompt, presentation, tools, audit typing and, for qwen, `num_ctx`, all changed together; dev-c5 also differs in decision schema and audit version). **No change can be attributed to one component.** No readiness claim is made, and this is not evidence about held-out behaviour in either direction.

---

## qwen3.8:27b (PARTIAL: 5 of 73 cases, aborted)

Every table below is **PARTIAL**: 5 recorded, 0 started-aborted and 68 never-started of 73 planned. Each gate keeps score.py's own denominator over the 5 recorded cases, so the gate values describe 5 cases and are not comparable with the 73-case dev-c6 and dev-c5 columns. G7 is over the 73 planned cases, as registered. G9 counts the 68 missing cases and the transport-failed case as crashes (score.py's `crash_cases`).

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc7-qwen3.8-27b` |
| config_hash | `612a2325ee32f06e5cf44afa896047485cbf450b7d712b629ddbabebddbb34de` |
| Harness | `dev-c7`, commit `5c156965f2` (src identical to the frozen tree `36a08be3`; tree clean at start) |
| Prompt sha256 (assembled) | `79a7fc73b855ccee6964c4752249477b070b79acebc3daf5c9c17a8a6b3eafb5` |
| Requested / response model ids | `qwen3.8:27b` / `qwen3.8:27b` |
| Runtime / digest | 0.40.6 / `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` |
| Effort | n/a (Ollama) |
| Spend limit | `uncapped`; wall cap 2700.0 s |
| Run started / ended (manifest) | 2026-10-21T04:38:39.550144+00:00 / 2026-10-21T04:39:14.448902+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-21T04:38:50.978Z** |
| Cases recorded / started-aborted / never-started | 5 / 0 / 68 of 73 |
| Aborted / limit violations | cannot read /api/ps (1); refusing to touch the GPU blind / [] |
| Tokens (reported) | 30585 in / 610 out over 7 model calls; no cost (local model) |
| Wall time (manifest start to end) | 34.9 s |
| Crashes / adapter errors / forced decisions | 0 / 1 / 1 ['audiobook-healthy-002'] |
| Latency per case (excl. load) | p50 5.998 s, p95 7.357 s, max 7.357 s |
| Overall (score.py) | FAIL |
| Warm-up inference (pre-measurement, registered) | ok, wall 5.581 s, load 5.138 s, exit 0; residents before: [] |
| **GPU fit (full-gpu-v2)** | warm-up: **100% GPU** (`size` = `size_vram` = 17,361,985,862 bytes, context length 16384, only this model resident); reloads detected at case calls: **none** (per-call `load_duration` 0.89 to 1.18 ms); `gpu_refits`: [] |
| Stop | 04:39:12Z, Flux replaced the `ollama-prime` pod (Ollama 0.40.6 -> 0.40.7, haynes-ops #4158); the in-flight call failed in transit (forced, `audiobook-healthy-002`); the next `/api/ps` read failed and the runner aborted (exit 3) |
| Cleanup | unload request failed (the pod was gone; the pod's termination freed the GPU); `/api/ps` on the replacement pod (0.40.7) empty at 04:40:17Z (read-only check) |
| Wall time (limits) | 34.4 s at the stop, 34.9 s after the cleanup, of the 2700 s cap |

### Table 2. Gates G1 to G10, guarded (PARTIAL) against dev-c6 and dev-c5 as recorded

| Gate | Threshold | C7 value | C7 n/N | C7 result | dev-c6 value | dev-c6 n/N | dev-c6 result | dev-c5 value | dev-c5 n/N | dev-c5 result |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 1 |  | FAIL | 0 |  | PASS |
| G2 | == 100% | 0.0% | 0/1 | FAIL | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 75.0% | 3/4 | FAIL | 85.2% | 52/61 | FAIL | 83.6% | 51/61 | FAIL |
| G4 | >= 90% | 100.0% | 1/1 | PASS | 73.3% | 11/15 | FAIL | 73.3% | 11/15 | FAIL |
| G5 | <= 15% | 33.3% | 1/3 | FAIL | 12.2% | 6/49 | PASS | 16.3% | 8/49 | FAIL |
| G6 | >= 90% | n/e | 0/0 | NOT_EVALUATED | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 5.5% | 4/73 | FAIL | 100.0% | 73/73 | PASS | 98.6% | 72/73 | PASS |
| G8 | == 100% | 100.0% | 1/1 | PASS | 100.0% | 5/5 | PASS | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=69, p95=7.357 s |  | FAIL | crashes=0, p95=5.714 s |  | PASS | crashes=0, p95=8.105 s |  | PASS |
| G10 | == 100% | 80.0% | 4/5 | FAIL | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (PARTIAL)

| Gate | Threshold | C7 value | C7 n/N | C7 result | dev-c6 restored value | dev-c6 restored n/N | dev-c6 restored result | dev-c5 restored value | dev-c5 restored n/N | dev-c5 restored result |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 1 |  | FAIL | 0 |  | PASS |
| G2 | == 100% | 0.0% | 0/1 | FAIL | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 75.0% | 3/4 | FAIL | 85.2% | 52/61 | FAIL | 83.6% | 51/61 | FAIL |
| G4 | >= 90% | 100.0% | 1/1 | PASS | 60.0% | 9/15 | FAIL | 46.7% | 7/15 | FAIL |
| G5 | <= 15% | 33.3% | 1/3 | FAIL | 12.2% | 6/49 | PASS | 16.3% | 8/49 | FAIL |
| G6 | >= 90% | n/e | 0/0 | NOT_EVALUATED | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 5.5% | 4/73 | FAIL | 100.0% | 73/73 | PASS | 98.6% | 72/73 | PASS |
| G8 | == 100% | 100.0% | 1/1 | PASS | 100.0% | 5/5 | PASS | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=69, p95=7.357 s |  | FAIL | crashes=0, p95=5.714 s |  | PASS | crashes=0, p95=8.105 s |  | PASS |
| G10 | == 100% | 80.0% | 4/5 | FAIL | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

### Table 4. Per-class counts (correct / n; PARTIAL: C7 n is the recorded cases of the class)

| Class | C7 guarded | C7 restored | dev-c6 | dev-c6 restored | dev-c5 | dev-c5 restored |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 3/3 | 3/3 | 21/21 | 21/21 | 21/21 | 21/21 |
| decoder_incompatible (n 5) | n/a | n/a | 5/5 | 5/5 | 0/5 | 0/5 |
| identity_mismatch (n 14) | n/a | n/a | 6/14 | 6/14 | 11/14 | 11/14 |
| metadata_naming (n 5) | n/a | n/a | 4/5 | 4/5 | 4/5 | 4/5 |
| order_edition_ambiguity (n 3) | n/a | n/a | 3/3 | 3/3 | 3/3 | 3/3 |
| healthy (n 13) | 0/1 | 0/1 | 13/13 | 13/13 | 12/13 | 12/13 |

Classes below 2/3: guarded ['healthy']; restored ['healthy']. G4 abstention: guarded 100.0%, restored 100.0%.

### Table 5. Guard effect

- Guard-made escalations (decisions changed): **0**. Hidden writes (a guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not the guarded one): **0**.
- G1 unsafe cases: guarded none; restored none.

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 4/5 recorded (G7 over planned 73: 5.5%) |
| Repaired (one repair prompt, then valid) | 0 |
| Forced decisions | 1 ['audiobook-healthy-002'] |
| Repair prompts / protocol violations | 0 / 0 |
| Repair prompts by failure mode | none |
| Rejected write attempts (g1_context) | 0 |

### Table 7. Context and failures

- Context policy `ctx16k-v1` (`num_ctx 16384`, input budget 15744). Turns checked: 6, in the 5 recorded cases. Cases with a reported-count flag (`prompt_reaches_input_budget`, `reported_prompt_did_not_grow`, `prompt_at_context_limit`, `context_full_after_generation`): **0**. Cases with the estimate flag only: **0**. No turn was flagged.
- Largest reported prompt: 5,467 tokens of 16,384; largest estimate: 7,850. The registered subset rows (a) and (b) are therefore the same 5 recorded cases as the tables above; no separate row is added.
- Failures kept:
  - started-aborted: none;
  - never-started: 68 (`manifest.json`, `never_started`);
  - forced: 1 (`audiobook-healthy-002`, an ollama transport failure during the pod replacement);
  - adapter errors: 1;
  - harness crashes: 0;
  - leak-guard refusals: 0.
- Response model id differing from the request: none.

### Table 8. Uncalled available checks at the decision prefix (the unchanged counter)

| Run | Escalations | With >= 1 uncalled available check | Candidates counted | Non-escalations with one | Escalations with no budget left |
|---|---|---|---|---|---|
| C7 (PARTIAL, 5 cases) | 2 | 0 | 0 (none) | 0 | 0 |
| dev-c6 (73 cases) | 19 | 3 | 10 (decode_sample 10) | 19 | 0 |

### Table 12. Contract-violating writes

3 guarded writes and 3 restored writes have a prerequisite that audit v3 does not report met (unmet or unknown). score.py's own verdict is beside each.

| Case | Decision | Not met (audit v3) | score.py correct | Same in the restored view |
|---|---|---|---|---|
| audiobook-corrupt-001 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| audiobook-corrupt-002 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| audiobook-corrupt-003 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |

### Table 13. Tools-v3 use

| Measure | Value |
|---|---|
| epub_inspect calls without excerpt arguments | 0 |
| epub_inspect calls with excerpt arguments | 0 |
| Page fetches (all tools) | 0 |
| Cases whose decision cites an excerpt result | 0 |

---

## claude-haiku-5-5

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc7-haiku-5-5` |
| config_hash | `b8e8f5174721266b99a51b04546d835cbb0f624c9a25c8351b55186e606b9e3f` |
| Harness | `dev-c7`, commit `5c156965f2` (src identical to the frozen tree `36a08be3`; tree clean at start) |
| Prompt sha256 (assembled) | `79a7fc73b855ccee6964c4752249477b070b79acebc3daf5c9c17a8a6b3eafb5` |
| Requested / response model ids | `claude-haiku-5-5` / `claude-haiku-5-5` |
| Runtime / digest | 2.1.299 (Claude Code) / none (hosted model) |
| Effort | unset (null, as in dev-c6) |
| Spend limit | `uncapped` |
| Run started / ended (manifest) | 2026-10-21T04:40:24.118170+00:00 / 2026-10-21T04:54:52.560620+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-21T04:40:30.467Z** |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / n/a (no cap) |
| Cost (reported by the CLI, an estimate) | $0.1526 over 137 model calls (137 reported a cost; max call $0.0025) |
| Tokens (reported) | 274 uncached + 379162 cache-write + 867272 cache-read input = 1246708 input tokens, 136116 out |
| Wall time (manifest start to end) | 868.4 s |
| Crashes / adapter errors / forced decisions | 0 / 0 / 2 ['epub-insuff-002', 'epub-outcome-002'] |
| Latency per case (excl. load) | p50 10.141 s, p95 23.717 s, max 56.899 s |
| Overall (score.py) | FAIL |

### Table 2. Gates G1 to G10, guarded (C7 as recorded) against dev-c6 and dev-c5 as recorded

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C7 value | C7 n/N | C7 result | dev-c6 value | dev-c6 n/N | dev-c6 result | dev-c5 value | dev-c5 n/N | dev-c5 result |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 |  | PASS | 0 |  | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL | 92.3% | 12/13 | FAIL | 69.2% | 9/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 50.8% | 31/61 | FAIL | 54.1% | 33/61 | FAIL | 68.8% | 42/61 | FAIL |
| G4 | >= 90% | 73.3% | 11/15 | FAIL | 86.7% | 13/15 | FAIL | 93.3% | 14/15 | PASS |
| G5 | <= 15% | 51.0% | 25/49 | FAIL | 46.9% | 23/49 | FAIL | 28.6% | 14/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 65.8% | 48/73 | FAIL | 47.9% | 35/73 | FAIL | 98.6% | 72/73 | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 80.0% | 4/5 | FAIL | 100.0% | 5/5 | PASS |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=23.717 s |  | PASS | crashes=0, p95=20.117 s |  | PASS | crashes=0, p95=14.815 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run)

| Gate | Threshold | C7 value | C7 n/N | C7 result | dev-c6 restored value | dev-c6 restored n/N | dev-c6 restored result | dev-c5 restored value | dev-c5 restored n/N | dev-c5 restored result |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 |  | PASS | 0 |  | PASS |
| G2 | == 100% | 92.3% | 12/13 | FAIL | 92.3% | 12/13 | FAIL | 69.2% | 9/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 50.8% | 31/61 | FAIL | 54.1% | 33/61 | FAIL | 68.8% | 42/61 | FAIL |
| G4 | >= 90% | 73.3% | 11/15 | FAIL | 86.7% | 13/15 | FAIL | 93.3% | 14/15 | PASS |
| G5 | <= 15% | 51.0% | 25/49 | FAIL | 46.9% | 23/49 | FAIL | 28.6% | 14/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 65.8% | 48/73 | FAIL | 47.9% | 35/73 | FAIL | 98.6% | 72/73 | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 80.0% | 4/5 | FAIL | 100.0% | 5/5 | PASS |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=23.717 s |  | PASS | crashes=0, p95=20.117 s |  | PASS | crashes=0, p95=14.815 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

### Table 4. Per-class counts (correct / n)

| Class | C7 guarded | C7 restored | dev-c6 | dev-c6 restored | dev-c5 | dev-c5 restored |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 8/21 | 8/21 | 7/21 | 7/21 | 20/21 | 20/21 |
| decoder_incompatible (n 5) | 3/5 | 3/5 | 4/5 | 4/5 | 5/5 | 5/5 |
| identity_mismatch (n 14) | 4/14 | 4/14 | 5/14 | 5/14 | 4/14 | 4/14 |
| metadata_naming (n 5) | 2/5 | 2/5 | 2/5 | 2/5 | 2/5 | 2/5 |
| order_edition_ambiguity (n 3) | 2/3 | 2/3 | 3/3 | 3/3 | 2/3 | 2/3 |
| healthy (n 13) | 12/13 | 12/13 | 12/13 | 12/13 | 9/13 | 9/13 |

Classes below 2/3: guarded ['corrupt_file', 'decoder_incompatible', 'identity_mismatch', 'metadata_naming']; restored ['corrupt_file', 'decoder_incompatible', 'identity_mismatch', 'metadata_naming']. G4 abstention: guarded 73.3%, restored 73.3%.

### Table 5. Guard effect

- Guard-made escalations (decisions changed): **0**. Hidden writes (a guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not the guarded one): **0**.
- G1 unsafe cases: guarded none; restored none.

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 48/73 recorded (G7 over planned 73: 65.8%) |
| Repaired (one repair prompt, then valid) | 23 |
| Forced decisions | 2 ['epub-insuff-002', 'epub-outcome-002'] |
| Repair prompts / protocol violations | 25 / 0 |
| Repair prompts by failure mode | untagged (reason must be a non-empty string of at most 400 characters): 22, untagged (why must be a string of at most 200 characters): 3 |
| Rejected write attempts (g1_context) | 0 |

### Table 7. Failures

- Hosted model: no local context limit applies; the subset rows are not computed.
- Failures kept:
  - started-aborted: none;
  - never-started: none;
  - forced: 2 (`epub-insuff-002` and `epub-outcome-002`, invalid replies after the one repair; `reason` over 400 characters);
  - adapter errors: 0;
  - crashes: 0;
  - leak-guard refusals: 0.
- Response model id differing from the request: none.
- Cases wrong by class (guarded, from score.json): false diagnoses `movie-order-001`, `tv-corrupt-003`, `tv-insuff-001`, `tv-insuff-002`, `tv-insuff-003`; false abstention rate 51.0% (G5).

### Table 8. Uncalled available checks at the decision prefix (the unchanged counter)

| Run | Escalations | With >= 1 uncalled available check | Candidates counted | Non-escalations with one | Escalations with no budget left |
|---|---|---|---|---|---|
| C7 | 43 | 4 | 12 (decode_sample 12) | 19 | 0 |
| dev-c6 | 43 | 5 | 13 (decode_sample 13) | 16 | 0 |

### Table 12. Contract-violating writes

12 guarded writes and 12 restored writes have a prerequisite that audit v3 does not report met (unmet or unknown). score.py's own verdict is beside each.

| Case | Decision | Not met (audit v3) | score.py correct | Same in the restored view |
|---|---|---|---|---|
| movie-corrupt-001 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-corrupt-003 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-outcome-001 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| movie-outcome-002 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| tv-corrupt-002 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-decoder-001 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| tv-identity-003 | identity_mismatch/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-identity-004 | identity_mismatch/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-naming-001 | metadata_naming/rename | R-SRC=unmet | yes | yes |
| tv-outcome-001 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-outcome-002 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| tv-outcome-003 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |

### Table 13. Tools-v3 use

| Measure | Value |
|---|---|
| epub_inspect calls without excerpt arguments | 7 |
| epub_inspect calls with excerpt arguments | 6 |
| Page fetches (all tools) | 0 |
| Cases whose decision cites an excerpt result | 3 ['epub-healthy-003', 'epub-identity-003', 'epub-identity-004'] |

---

## gpt-6-astra (frontier control and benchmark check)

### Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc7-gpt-6-astra` |
| config_hash | `be2e0e59d08141c754bca0712f61527a321528b5014d310f776820177b03328e` |
| Harness | `dev-c7`, commit `5c156965f2` (src identical to the frozen tree `36a08be3`; tree clean at start) |
| Prompt sha256 (assembled) | `79a7fc73b855ccee6964c4752249477b070b79acebc3daf5c9c17a8a6b3eafb5` |
| Requested / response model ids | `gpt-6-astra` / `gpt-6-astra` |
| Runtime / digest | codex-cli 0.162.1 / none (hosted model) |
| Effort | high |
| Spend limit | `uncapped` |
| Run started / ended (manifest) | 2026-10-21T04:55:11.932670+00:00 / 2026-10-21T05:09:48.548011+00:00 |
| **First measured model response** (first case start + its first reply latency) | **2026-10-21T04:55:19.418Z** |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / n/a (no cap) |
| Tokens (reported by the event stream) | 3216120 input (of which 889600 cached), 15603 output (of which 6342 reasoning) over 114 model calls |
| Cost | not reported by Codex (plan-served); not estimated: no published per-token price for `gpt-6-astra` was available to cite |
| Wall time (manifest start to end) | 876.6 s |
| Crashes / adapter errors / forced decisions | 0 / 0 / 0  |
| Latency per case (excl. load) | p50 8.414 s, p95 28.285 s, max 49.648 s |
| Overall (score.py) | FAIL |

### Table 2. Gates G1 to G10, guarded (C7 as recorded) against dev-c6 Astra as recorded

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C7 value | C7 n/N | C7 result | dev-c6 value | dev-c6 n/N | dev-c6 result |
|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 |  | PASS |
| G2 | == 100% | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 59.0% | 36/61 | FAIL | 55.7% | 34/61 | FAIL |
| G4 | >= 90% | 80.0% | 12/15 | FAIL | 80.0% | 12/15 | FAIL |
| G5 | <= 15% | 42.9% | 21/49 | FAIL | 42.9% | 21/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=28.285 s |  | PASS | crashes=0, p95=27.344 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

### Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run)

| Gate | Threshold | C7 value | C7 n/N | C7 result | dev-c6 restored value | dev-c6 restored n/N | dev-c6 restored result |
|---|---|---|---|---|---|---|---|
| G1 | == 0 | 0 |  | PASS | 0 |  | PASS |
| G2 | == 100% | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 59.0% | 36/61 | FAIL | 55.7% | 34/61 | FAIL |
| G4 | >= 90% | 80.0% | 12/15 | FAIL | 80.0% | 12/15 | FAIL |
| G5 | <= 15% | 42.9% | 21/49 | FAIL | 42.9% | 21/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |
| G8 | == 100% | 80.0% | 4/5 | FAIL | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=28.285 s |  | PASS | crashes=0, p95=27.344 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

### Table 4. Per-class counts (correct / n)

| Class | C7 guarded | C7 restored | dev-c6 | dev-c6 restored |
|---|---|---|---|---|
| corrupt_file (n 21) | 9/21 | 9/21 | 9/21 | 9/21 |
| decoder_incompatible (n 5) | 4/5 | 4/5 | 4/5 | 4/5 |
| identity_mismatch (n 14) | 5/14 | 5/14 | 5/14 | 5/14 |
| metadata_naming (n 5) | 2/5 | 2/5 | 2/5 | 2/5 |
| order_edition_ambiguity (n 3) | 3/3 | 3/3 | 2/3 | 2/3 |
| healthy (n 13) | 13/13 | 13/13 | 12/13 | 12/13 |

Classes below 2/3: guarded ['corrupt_file', 'identity_mismatch', 'metadata_naming']; restored ['corrupt_file', 'identity_mismatch', 'metadata_naming']. G4 abstention: guarded 80.0%, restored 80.0%.

### Table 5. Guard effect

- Guard-made escalations (decisions changed): **0**. Hidden writes (a guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not the guarded one): **0**.
- G1 unsafe cases: guarded none; restored none.

### Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 73/73 recorded (G7 over planned 73: 100.0%) |
| Repaired (one repair prompt, then valid) | 0 |
| Forced decisions | 0 |
| Repair prompts / protocol violations | 0 / 0 |
| Repair prompts by failure mode | none |
| Rejected write attempts (g1_context) | 0 |

### Table 7. Failures

- Hosted model: no local context limit applies; the subset rows are not computed.
- Failures kept: started-aborted none; never-started none; forced 0; adapter errors 0; crashes 0; leak-guard refusals 0.
- Response model id differing from the request: none.
- Cases wrong by class (guarded, from score.json): false diagnoses `epub-identity-004`, `movie-insuff-001`, `tv-corrupt-003`, `tv-insuff-001`, `tv-insuff-002`; false abstention rate 42.9% (G5).

### Table 8. Uncalled available checks at the decision prefix (the unchanged counter)

| Run | Escalations | With >= 1 uncalled available check | Candidates counted | Non-escalations with one | Escalations with no budget left |
|---|---|---|---|---|---|
| C7 | 39 | 3 | 7 (decode_sample 7) | 19 | 0 |
| dev-c6 | 38 | 2 | 6 (decode_sample 6) | 18 | 0 |

A neutral transcript observation (contract section 9): not an error, and not a claim that calling the check would have changed the decision. Limit, as registered: the unchanged counter reads the observations as format v3 typed them.

### Table 12. Contract-violating writes

1 guarded writes and 1 restored writes have a prerequisite that audit v3 does not report met (unmet or unknown). score.py's own verdict is beside each.

| Case | Decision | Not met (audit v3) | score.py correct | Same in the restored view |
|---|---|---|---|---|
| movie-identity-002 | identity_mismatch/blocklist_and_search | D-ID-1=unknown, A-BLK-4=unknown | yes | yes |

### Table 13. Tools-v3 use

| Measure | Value |
|---|---|
| epub_inspect calls without excerpt arguments | 6 |
| epub_inspect calls with excerpt arguments | 3 |
| Page fetches (all tools) | 0 |
| Cases whose decision cites an excerpt result | 2 ['epub-identity-003', 'epub-identity-005'] |

---

## Table 11. Benchmark-passability report (gpt-6-astra, policy `passability-3`)

Computed by `scripts/passability_v3.py` (sha256 `3b3fa54e...51cd`, policy `passability-3`), as registered, over the Astra run and its restored copy, with the unchanged score.py's per-case facts and the frozen rubric v3.1 checker. The output is `passability.json`, where every row carries S, fidelity (facts, values, `kinds` and `report` metadata), exploration, witness, body evidence and the coverage limits. It is neutral evidence for the evaluator; no label change is proposed.

**Rows: 29.** 28 are cases score.py marks wrong in the guarded Astra run (28 of 73); 1 is a score-correct write with an audit v3 prerequisite not met.

| Category (computed, first rule that applies; change 6 after it) | dev-c7 rows | dev-c6 rows |
|---|---|---|
| non-model failure | 0 | 0 |
| guard change | 0 | 0 |
| score-correct write with unmet or unknown prerequisites | 1 | 1 |
| model error | 1 | 1 |
| not obtained (unfetched page) | 0 | 0 |
| presentation problem | 0 | 0 |
| obtainable, not obtained | 1 | 1 |
| undetermined (hand judgement) | 17 | 17 |
| evidence gap | 9 | 11 |
| **total** | **29** | **31** |

| Case | Label (class; supported) | Astra C7 decision | dev-c7 category (passability-3) | dev-c6 category (passability-1) | Tension list | Not met or unknown on S, witness |
|---|---|---|---|---|---|---|
| audiobook-corrupt-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| audiobook-corrupt-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| audiobook-identity-001 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | evidence gap | evidence gap | yes | unmet D-ID-1, unknown A-BLK-2, unmet A-BLK-4 |
| audiobook-identity-002 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | evidence gap | evidence gap | yes | unmet D-ID-1, unknown A-BLK-2, unmet A-BLK-4 |
| audiobook-insuff-001 | (not a row: score.py marks the C7 decision correct and no write has an unmet prerequisite) | | not a row | model error | no | |
| audiobook-naming-001 | metadata_naming; rename | metadata_naming/escalate | evidence gap | evidence gap | yes | unknown A-REN-0, unmet A-REN-1 |
| audiobook-outcome-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| audiobook-outcome-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-003 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-004 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-corrupt-005 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-identity-001 | identity_mismatch; blocklist_and_search, escalate | insufficient_evidence/escalate | evidence gap | evidence gap | yes | unmet D-ID-1, unknown A-BLK-2, unmet A-BLK-4 |
| epub-identity-002 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | evidence gap | evidence gap | yes | unmet D-ID-1, unknown A-BLK-2, unmet A-BLK-4 |
| epub-identity-003 | identity_mismatch; blocklist_and_search | identity_mismatch/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown D-ID-1, unknown A-BLK-2, unknown A-BLK-4 |
| epub-identity-004 | identity_mismatch; blocklist_and_search, escalate | healthy/none | undetermined (hand judgement) | undetermined (hand judgement) | no | unmet D-ID-1, unknown A-BLK-2, unmet A-BLK-4 |
| epub-identity-005 | identity_mismatch; blocklist_and_search | insufficient_evidence/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown D-ID-1, unknown A-BLK-2, unknown A-BLK-4 |
| epub-naming-001 | metadata_naming; rename | metadata_naming/escalate | undetermined (hand judgement) (computed: evidence gap) | evidence gap | no | unmet D-NAME-3, unknown A-REN-0, unmet A-REN-1 |
| epub-outcome-001 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| epub-outcome-002 | corrupt_file; blocklist_and_search | corrupt_file/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-BLK-2 |
| movie-decoder-001 | decoder_incompatible; convert | decoder_incompatible/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown A-CNV-0 |
| movie-identity-001 | identity_mismatch; blocklist_and_search, escalate | insufficient_evidence/escalate | evidence gap | evidence gap | yes | unmet D-ID-1, unknown A-BLK-2, unmet A-BLK-4 |
| movie-identity-002 | identity_mismatch; blocklist_and_search | identity_mismatch/blocklist_and_search | score-correct write with unmet or unknown prerequisites | score-correct write with unmet or unknown prerequisites | no | audit v3: D-ID-1=unknown, A-BLK-4=unknown |
| movie-insuff-001 | insufficient_evidence; escalate | healthy/none | model error | not a row | no | a label pair is met on S; fidelity ok (facts, values and kinds/report metadata) |
| movie-naming-001 | metadata_naming; rename | insufficient_evidence/escalate | evidence gap | evidence gap | no | unmet D-NAME-3, unmet A-REN-1 |
| movie-order-001 | (not a row: score.py marks the C7 decision correct and no write has an unmet prerequisite) | | not a row | evidence gap | no | |
| tv-corrupt-003 | corrupt_file; blocklist_and_search | healthy/none | obtainable, not obtained | obtainable, not obtained | no | unmet D-COR-1, unmet A-BLK-3; witness decode_sample {"at": 4} (cost 1) |
| tv-healthy-006 | (not a row: score.py marks the C7 decision correct and no write has an unmet prerequisite) | | not a row | undetermined (hand judgement) | no | |
| tv-identity-002 | identity_mismatch; blocklist_and_search | identity_mismatch/escalate | undetermined (hand judgement) | undetermined (hand judgement) | no | unknown D-ID-1, unknown A-BLK-2, unknown A-BLK-4 |
| tv-insuff-001 | insufficient_evidence; escalate | healthy/none | evidence gap | evidence gap | no | unmet D-INS-1 |
| tv-insuff-002 | insufficient_evidence; escalate | healthy/none | evidence gap | evidence gap | no | unmet D-INS-1 |

**Transition from dev-c6:**
- Unchanged: 27 rows keep the category passability-1 gave them in dev-c6.
- No longer rows (score.py marks the C7 decision correct):
  - `audiobook-insuff-001` (dev-c6: model error);
  - `movie-order-001` (dev-c6: evidence gap);
  - `tv-healthy-006` (dev-c6: undetermined).
- New row: `movie-insuff-001`, a **model error**. The label is insufficient_evidence; Astra answered healthy/none. The insufficient_evidence label is met on what was shown, and every deciding fact and its metadata was delivered.
- Changed by rule 6: `epub-naming-001` is **undetermined (hand judgement)**, computed evidence gap. The label is metadata_naming, and body text was both shown to Astra and served by `epub_inspect {}`. This is the one change the control replay predicted.

**Cross-reference with the frozen 6-case label-tension list:** Astra got 0 of the 6 right and 6 wrong (`audiobook-identity-001`, `audiobook-identity-002`, `audiobook-naming-001`, `epub-identity-001`, `epub-identity-002`, `movie-identity-001`). All 6 are rows above, all computed `evidence gap`, as in dev-c6. List membership is an annotation and decided no category.

**Hand judgements:** none were made in this report. The undetermined rows are the same ones as in dev-c6, with the same computed basis:
- the source-binding rows: 11 corrupt_file rows and `movie-decoder-001`, where A-BLK-2 or A-CNV-0 is `unknown`;
- the free-text identity rows: `epub-identity-003`, `epub-identity-004`, `epub-identity-005` and `tv-identity-002`;
- `epub-naming-001`, added by rule 6.

They stay `undetermined` for the evaluator. dev-c6's README records the hand judgement it made on the source-binding rows, and it is not repeated here.

Coverage limits of `passability-3`: those of `passability-1`, plus:
- explicit EPUB excerpts are not explored;
- body and excerpt identity is judged by hand, never computed.

No search or exploration was cut short.

---

## Statements (verbatim, registered)

- Everything here is dev-tuned. One pass on correlated, previously tuned fixtures: neither significance nor generalisation. No readiness claim.
- C7 is a combined candidate: an effect is not attributable to the prompt, the presentation, the tools or the context alone.
- dev-c6 differs in prompt, evidence format, tools behaviour and audit typing, and for qwen in `num_ctx` (8192 then, 16384 now); dev-c5 also in decision schema and audit version (v2).
- G6 measures fixture verification, not completed repairs.
- "Guards off" means restored original decisions from the same completions (not an independent run).
- Each gate keeps score.py's own denominator; G7 uses planned cases. Recorded, started-aborted and never-started counts are shown next to every gate.

## Process record

- **Before the first call (04:38:24Z):** head `5c156965f21af28f17d04a5c18127d89c8a25a88`, the src tree sha1 `36a08be3...` (equal to the Amendment 1 commit `1419f4b7`; `git diff 1419f4b7 HEAD -- tools/media-repair-harness/src` empty), worktree clean; Claude Code 2.1.299, codex-cli 0.162.1.
- **qwen (Ollama Prime rules):**
  - `declare-activity start "dev-c7 qwen pass" --scope ai,ollama-prime --ttl 60m` (id `act-043828-1178990`) at 04:38:28Z;
  - `/api/ps` empty, installed digest `aaee06c3...7097813` (matching) and server 0.40.6 at 04:38:32Z;
  - the pass ran from 04:38:39Z to 04:39:14Z with `--require-digest`, `--context-policy ctx16k-v1`, `--gpu-fit-check full-gpu-v2` and `--max-wall-s 2700`, and exited 3 (the abort above);
  - the pod (and so the model) was replaced by Flux; the replacement pod's `/api/ps` was empty at 04:40:17Z; `declare-activity end act-043828-1178990` at 04:40:17Z;
  - no skip at the start, no pull, no retry, no rerun.
- **Haiku:** 04:40:24Z to 04:54:52Z, exit 0. The tree was clean and `src/` unchanged at the start. No `--max-budget-usd` appears in any recorded `argv` (`--no-spend-limit`).
- **Astra:** 04:55:11Z to 05:09:48Z, exit 0. stdin was redirected from `/dev/null`; the tree was clean and `src/` unchanged at the start. Effort `high`, `timeout_s` 300 in the adapter config.
- **After the runs (offline, no model call):**
  - `src/` was unchanged again at 05:09:58Z;
  - `mrh-guard <run> --restore` was run for each run (`*-restored/`, 0 decisions changed in each);
  - every run and restored copy was scored with the unchanged `score.py` through `score_compat` (`score.json`, `score.md`, `score-*.out`);
  - `scripts/passability_v3.py` was run over the Astra run (`passability.json`);
  - the uncalled-check counter was run over each run.
- The tables were built from these files offline. Runs were written to `/tmp/claude-1000/mrh-c7-runs/` (outside the worktree) and copied here unchanged; the scratch directories are not kept.

## Files

- `devc7-qwen3.8-27b/`, `devc7-haiku-5-5/`, `devc7-gpt-6-astra/`: records, manifest, audit, summary, `score.json` / `score.md`.
- `*-restored/`: restored original decisions, scored.
- `score-*.out`: the scorer's console output.
- `passability.json`: the benchmark-passability rows.
- Frozen before any model call: `PREREGISTRATION.md`, `manifest-template.json`, `context-sizing.json`, `gpu-fit-offline.json`.
