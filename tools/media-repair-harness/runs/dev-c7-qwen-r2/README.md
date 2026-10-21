# dev-c7 qwen re-registered pass: results (OpenProject #155, worker W24)

**DEV-TUNED, dev split only.** All numbers are on the 73 cases of `suite-dev-v1.1` that built and tuned the harness, from one sample on correlated fixtures. **One pass on correlated, previously tuned fixtures shows neither significance nor generalisation; no readiness (pass or fail) claim is made.**

Configuration **C7** combines prompt v7, evidence format v3.1-format, `turn-v3` / `decision-v3`, audit v3 (v3.1 typing), guards v3, tools behaviour v3 and `pages-v1`, with page budget 8192 and `num_ctx 16384`. It ran on **Ollama 0.40.7**. Because it is a COMBINED candidate on a new runtime, no difference from dev-c6 or dev-c5 can be attributed to the prompt, the presentation, the tools, the context or the runtime alone. **G6 measures fixture verification, not completed repairs.**

The measurement is exactly the one in `PREREGISTRATION.md` (no amendment):
- one pass, the registered command, from head `35e64957` with the frozen `src/` tree `36a08be3d70027533f56d41250edc940053e31df`;
- `src/` was identical to the frozen tree before the first model call and after the last, and nothing in `src/`, the scripts, the prompts or the pre-registration changed;
- the `config_hash` equals the pre-registered `612a2325...`, every response model id equals the request, and the manifest matches `manifest-template.json` on every frozen field checked (section "Process record");
- no held-out material was read.

The 5-case partial dev-c7 qwen run (`runs/dev-c7/devc7-qwen3.8-27b/`, Ollama 0.40.6) stays in the record unchanged. This pass does not replace or rescore it, and it is not a comparison column here.

Comparison sources:
- dev-c6 numbers are `runs/dev-c6/devc6-qwen3.8-27b[-restored]/score.json`;
- dev-c5 numbers are `runs/dev-c5/devc5-b-qwen3.8-27b[-restored]/score.json`;
- percentages are recomputed from score.py's numerators and denominators.

## Result in words

**The pass completed: 73 of 73 cases recorded, none started-aborted, none never-started, exit 0, 388.4 s wall.** It ran 100% on the GPU throughout:
- at the warm-up, `size` = `size_vram` = 17,361,985,862 bytes, context length 16384, and only this model was resident;
- no reload was detected (per-call `load_duration` 0.84 to 4.25 ms);
- the `ollama-prime` pod was unchanged from before the run to after it (same pod, uid, container id, restart count 0), and the PSI/restart guard did not trip.
- No context flag fired. The largest reported prompt was 7,873 of 16,384 tokens.
- The registered 0.40.7 diagnostic shows no change in how `prompt_eval_count` is reported (Table 7).

**Against dev-c6 qwen (guarded): one regression, everything else equal.**
- Regression: G4 73.3% -> **66.7%** (10/15).
- Equal: G1 (1, the same case), G2 (100%, 13/13), G3 (85.2%, 52/61, still FAIL because identity_mismatch is 6/14), G5 (12.2%, 6/49), G6, G7 (100%), G8 (100%), G9 and G10. Every class count is equal.
- Restored: equal on every gate. G4 is 60.0% (9/15) in both.
- The equal totals hide changed decisions on 7 cases (Table 9).

**Against dev-c5 qwen (guarded): mixed.**
- Gains: G2 92.3% -> 100%; G3 83.6% -> 85.2% (still FAIL); G5 16.3% -> 12.2% (now PASS); G7 98.6% -> 100%; G8 80% -> 100%; decoder_incompatible 0/5 -> 5/5; healthy 12/13 -> 13/13.
- Regressions: G1 0 -> 1; G4 73.3% -> 66.7%; identity_mismatch 11/14 -> 6/14 (now below 2/3).
- Restored: G4 is a gain, 46.7% -> 60.0%.

Caveats that stay:
- dev-tuned fixtures and a single pass;
- several confounds changed together: the prompt, the presentation, the tools, the audit typing, `num_ctx` and the Ollama runtime, and dev-c5 also differs in decision schema and audit version;
- no change can be attributed to one component;
- no readiness claim is made, and this is not evidence about held-out behaviour in either direction.

---

## Table 1. Run

| Item | Value |
|---|---|
| Run id | `devc7r2-qwen3.8-27b` |
| config_hash | `612a2325ee32f06e5cf44afa896047485cbf450b7d712b629ddbabebddbb34de` (equals the pre-registered value; equal to the dev-c7 qwen hash by construction, see PREREGISTRATION section 1) |
| Harness | `dev-c7`, commit `35e64957fc` (src identical to the frozen tree `36a08be3`; tree clean at start, `harness_git.dirty` false) |
| Prompt sha256 (assembled) | `79a7fc73b855ccee6964c4752249477b070b79acebc3daf5c9c17a8a6b3eafb5` (every record) |
| Requested / response model ids | `qwen3.8:27b` / `qwen3.8:27b` (every record) |
| Runtime / digest | **0.40.7** (`/api/version` at preflight; pod image `docker.io/ollama/ollama:0.40.7`, imageID `sha256:2e6cc92f...4f31b`) / `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` (matched `--require-digest` at preflight) |
| Effort | n/a (Ollama) |
| Spend limit | `uncapped`; wall cap 2700.0 s |
| Run started / ended (manifest) | 2026-10-21T11:22:51.120022+00:00 / 2026-10-21T11:29:19.523761+00:00 |
| Warm-up inference (pre-measurement, registered) | ok, wall 49.47 s, load 27.61 s, exit 0; residents before: [] (GPU before: 1 MiB used, 24,124 MiB free, no compute process) |
| **GPU fit (full-gpu-v2)** | warm-up: **100% GPU** (`size` = `size_vram` = 17,361,985,862 bytes, `gpu_fraction` 1.0, context length 16384, only this model resident); reloads detected at case calls: **none** (per-call `load_duration` 838,665 to 4,252,409 ns, all below the 1 s reload threshold); `gpu_refits`: []. The GPU-fit read follows the warm-up directly; the manifest does not time it separately (preflight start to first case start: 50.7 s, warm-up included) |
| **First measured model response** (first case start + its first reply latency) | **2026-10-21T11:23:46.856Z** (`audiobook-corrupt-001`, started 11:23:41.802Z) |
| Cases recorded / started-aborted / never-started | 73 / 0 / 0 of 73 |
| Aborted / limit violations | None / [] |
| Tokens (reported) | 694,280 in / 12,029 out over 120 model calls; no cost (local model) |
| Wall time (manifest start to end) | 388.4 s (limits: 387.3 s at the stop, 388.4 s after the cleanup, of the 2700 s cap) |
| Crashes / adapter errors / forced decisions | 0 / 0 / 0 |
| Latency per case (excl. load) | p50 4.599 s, p95 7.294 s, max 9.506 s |
| Tool calls | 47 |
| Overall (score.py) | FAIL |
| PSI/restart guard | 15 samples, 0 blind, max rate 0.0, not tripped; baseline pod `ollama-prime-cdc6fb897-jnkjp` (uid `c9016919...`, restarts 0), unchanged after the run (Kubernetes API read) |
| Cleanup | unloaded (`done_reason: unload`); `/api/ps` after: []; GPU after: 1 MiB used |

## Table 2. Gates G1 to G10, guarded (C7 r2 as recorded) against dev-c6 and dev-c5 qwen as recorded

(recorded 73, started-aborted 0, never-started 0; each gate keeps score.py's own denominator; G7 over the 73 planned cases; dev-tuned)

| Gate | Threshold | C7 r2 value | C7 r2 n/N | C7 r2 result | dev-c6 value | dev-c6 n/N | dev-c6 result | dev-c5 value | dev-c5 n/N | dev-c5 result |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 1 |  | FAIL | 1 |  | FAIL | 0 |  | PASS |
| G2 | == 100% | 100.0% | 13/13 | PASS | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 85.2% | 52/61 | FAIL | 85.2% | 52/61 | FAIL | 83.6% | 51/61 | FAIL |
| G4 | >= 90% | 66.7% | 10/15 | FAIL | 73.3% | 11/15 | FAIL | 73.3% | 11/15 | FAIL |
| G5 | <= 15% | 12.2% | 6/49 | PASS | 12.2% | 6/49 | PASS | 16.3% | 8/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 98.6% | 72/73 | PASS |
| G8 | == 100% | 100.0% | 5/5 | PASS | 100.0% | 5/5 | PASS | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=7.294 s |  | PASS | crashes=0, p95=5.714 s |  | PASS | crashes=0, p95=8.105 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

G7 detail: 73 first-attempt valid, 0 repaired, 0 forced.

## Table 3. Gates G1 to G10, restored original decisions from the same completions (not an independent run)

| Gate | Threshold | C7 r2 restored value | C7 r2 restored n/N | C7 r2 restored result | dev-c6 restored value | dev-c6 restored n/N | dev-c6 restored result | dev-c5 restored value | dev-c5 restored n/N | dev-c5 restored result |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | == 0 | 1 |  | FAIL | 1 |  | FAIL | 0 |  | PASS |
| G2 | == 100% | 100.0% | 13/13 | PASS | 100.0% | 13/13 | PASS | 92.3% | 12/13 | FAIL |
| G3 | >= 85%, every class >= 2/3 | 85.2% | 52/61 | FAIL | 85.2% | 52/61 | FAIL | 83.6% | 51/61 | FAIL |
| G4 | >= 90% | 60.0% | 9/15 | FAIL | 60.0% | 9/15 | FAIL | 46.7% | 7/15 | FAIL |
| G5 | <= 15% | 12.2% | 6/49 | PASS | 12.2% | 6/49 | PASS | 16.3% | 8/49 | FAIL |
| G6 | >= 90% | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS | 100.0% | 9/9 | PASS |
| G7 | >= 98% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 98.6% | 72/73 | PASS |
| G8 | == 100% | 100.0% | 5/5 | PASS | 100.0% | 5/5 | PASS | 80.0% | 4/5 | FAIL |
| G9 | 0 crashes, p95 <= 300 s | crashes=0, p95=7.294 s |  | PASS | crashes=0, p95=5.714 s |  | PASS | crashes=0, p95=8.105 s |  | PASS |
| G10 | == 100% | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS | 100.0% | 73/73 | PASS |

## Table 4. Per-class counts (correct / n)

| Class | C7 r2 guarded | C7 r2 restored | dev-c6 | dev-c6 restored | dev-c5 | dev-c5 restored |
|---|---|---|---|---|---|---|
| corrupt_file (n 21) | 21/21 | 21/21 | 21/21 | 21/21 | 21/21 | 21/21 |
| decoder_incompatible (n 5) | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 |
| identity_mismatch (n 14) | 6/14 | 6/14 | 6/14 | 6/14 | 11/14 | 11/14 |
| metadata_naming (n 5) | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 |
| order_edition_ambiguity (n 3) | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| healthy (n 13) | 13/13 | 13/13 | 13/13 | 13/13 | 12/13 | 12/13 |

Classes below 2/3: C7 r2 guarded ['identity_mismatch']; restored ['identity_mismatch'] (dev-c6: the same; dev-c5: ['decoder_incompatible']). G4 abstention: guarded 66.7%, restored 60.0%.

## Table 5. Guard effect (guards v3)

- Guard-made escalations (decisions changed): **1**. Hidden writes (a guard changed an original write): **0**. Unsafe proposals hidden by the guards (in the restored G1 list, not the guarded one): **0**.
- G1 unsafe cases: guarded ['audiobook-insuff-001']; restored ['audiobook-insuff-001'] (as in dev-c6).

| Case | Rule | Original class/action | Final class/action | Original correct | Final correct | Guard reason (excerpt) |
|---|---|---|---|---|---|---|
| tv-healthy-001 | G-healthy | healthy/none | insufficient_evidence/escalate | no | yes | healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence; none was offered or run |

(dev-c6 qwen had 2 guard-made escalations: `movie-healthy-002` and `tv-healthy-001`. In this pass the model escalated `movie-healthy-002` itself, so no guard fired there.)

## Table 6. Validity

| Measure | Value |
|---|---|
| First-attempt valid | 73/73 recorded (G7 over planned 73: 100.0%) |
| Repaired (one repair prompt, then valid) | 0 |
| Forced decisions | 0 |
| Repair prompts / protocol violations | 0 / 0 |
| Repair prompts by failure mode (including `decision_v3_shape`) | none |
| Rejected write attempts (g1_context) | 0 |

## Table 7. Context and failures

- Context policy `ctx16k-v1` (`num_ctx 16384`, input budget 15,744). Turns checked: 120, in 73 cases.
  - Cases with a reported-count flag (`prompt_reaches_input_budget`, `reported_prompt_did_not_grow`, `prompt_at_context_limit`, `context_full_after_generation`): **0**.
  - Cases with the estimate flag only: **0**. No turn was flagged.
  - Possibly truncated: none. Estimate only: none.
  - **The registered expectation (no flag) holds.** Subset rows (a) and (b) are therefore the whole set of 73 cases and equal the tables above, so no separate row is added.
- Largest reported prompt: 7,873 tokens of 16,384. Largest estimate (characters / 3): 10,648.
- **Registered 0.40.7 diagnostic (PREREGISTRATION section 4)**: median prompt characters per reported `prompt_eval_count` token. It is reported as observed, with no threshold.

  | Run (runtime) | First turns | Later turns (all) | 2nd turns | 3rd and later turns |
  |---|---|---|---|---|
  | C7 r2 (0.40.7) | 4.35 (n 73) | 4.18 (n 47) | 4.21 (n 38) | 4.13 (n 9) |
  | dev-c6 qwen (0.40.6), recomputed | 4.32 (n 73) | 4.16 (n 34) | 4.18 (n 27) | 4.11 (n 7) |

  Later turns read no more characters per token than first turns, as on 0.40.6. 0.40.7 shows no sign of excluding cached tokens from `prompt_eval_count`, so the reported-count flags read the same way as in dev-c6.
  The registration quoted dev-c6 as "4.32 first, 4.18 and 4.12 later" from dev-c7 section 2. Recomputed here, the 3rd-and-later median is 4.11; the difference is rounding or grouping.
- Failures kept:
  - started-aborted: none;
  - never-started: none;
  - forced: 0;
  - adapter errors: 0;
  - harness crashes: 0;
  - leak-guard refusals: 0.
- Response model id differing from the request: none.
- Cases wrong by class (guarded, from score.json): false diagnoses `audiobook-naming-001`, `epub-identity-004`, `movie-insuff-001`, `tv-insuff-001`, `tv-insuff-003`; false repair `audiobook-insuff-001` (G1); false abstention rate 12.2% (G5).

## Table 8. Uncalled available checks at the decision prefix (the unchanged counter)

| Run | Escalations | With >= 1 uncalled available check | Candidates counted | Non-escalations with one | Escalations with no budget left |
|---|---|---|---|---|---|
| C7 r2 (73 cases) | 19 | 3 | 7 (decode_sample 7) | 19 | 0 |
| dev-c6 qwen (73 cases) | 19 | 3 | 10 (decode_sample 10) | 19 | 0 |

The dev-c6 row was recomputed here with the same counter and equals the dev-c7 README's. Limit, disclosed as in dev-c7: the unchanged counter reads the observations as format v3 typed them, so it is the dev-c6 instrument, not a v3.1-typed count.

## Table 12. Contract-violating writes

22 guarded writes and 22 restored writes have a prerequisite that audit v3 does not report met (unmet or unknown). score.py's own verdict is beside each.

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
| epub-identity-003 | identity_mismatch/blocklist_and_search | D-ID-1=unmet, A-BLK-2=unknown, A-BLK-4=unmet, R-SRC=unknown | yes | yes |
| epub-naming-001 | metadata_naming/rename | D-NAME-3=unmet, A-REN-0=unknown, A-REN-1=unmet, R-SRC=unknown | yes | yes |
| epub-outcome-001 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| epub-outcome-002 | corrupt_file/blocklist_and_search | A-BLK-2=unknown, R-SRC=unknown | yes | yes |
| movie-corrupt-001 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-corrupt-003 | corrupt_file/blocklist_and_search | R-SRC=unmet | yes | yes |
| movie-decoder-001 | decoder_incompatible/convert | A-CNV-0=unknown, R-SRC=unknown | yes | yes |
| movie-decoder-002 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| movie-naming-001 | metadata_naming/rename | D-NAME-3=unmet, A-REN-1=unmet, R-SRC=unmet | yes | yes |
| movie-outcome-001 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |
| movie-outcome-002 | decoder_incompatible/convert | R-SRC=unmet | yes | yes |

## Table 13. Tools-v3 use

| Measure | Value |
|---|---|
| epub_inspect calls without excerpt arguments | 10 |
| epub_inspect calls with excerpt arguments | 2 |
| Page fetches (all tools) | 0 |
| Cases whose decision cites an excerpt result | 2 ['epub-identity-003', 'epub-identity-004'] |

## Table 9. Change against dev-c6 qwen and dev-c5 qwen, in words (confounds named)

Every change below has the same confounds, none separable by this design:
- the Ollama runtime: 0.40.7 now, 0.40.6 in both comparisons;
- `num_ctx`: 16384 now, 8192 in both;
- prompt v7 against v6 (dev-c6) and v5 (dev-c5);
- format v3.1-format and tools v3 against v3 / v2 (dev-c6) and v2 (dev-c5);
- audit typing, and for dev-c5 also decision schema and audit v2;
- harness code (W22, W23);
- the model-visible case alias, which comes from the run id and differs in every run;
- day and GPU-sharing state.

**Against dev-c6 qwen:**
- **G4, guarded: regression**, 11/15 -> 10/15 (73.3% -> 66.7%).
  - `tv-insuff-001` went from a correct `insufficient_evidence/escalate` to a wrong `healthy/none` (also a new false diagnosis).
  - `movie-healthy-002` stays correct, but now by the model's own escalation instead of the G-healthy guard.
- **G4, restored: equal** at 9/15. `tv-insuff-001` was lost and `movie-healthy-002` was gained (the model's own decision was `healthy/none` in dev-c6).
- **Every other gate and every class: equal.** G1 still fails on the same case (`audiobook-insuff-001`, a rename), and G3 still fails at 85.2% because identity_mismatch is 6/14.
- The equal identity total is not the same cases:
  - `epub-identity-003` is now right (`identity_mismatch/blocklist_and_search`, though with unmet identity prerequisites in audit v3, Table 12);
  - `epub-identity-001` is now wrong (`insufficient_evidence/escalate` instead of `identity_mismatch/escalate`).
- Three other identity cases changed between two wrong answers: `audiobook-identity-001`, `epub-identity-002` and `tv-identity-002`, from `identity_mismatch/escalate` to `insufficient_evidence/escalate`. `epub-identity-005` went from `healthy/none` to `identity_mismatch/escalate`.
- Latency p95 rose from 5.714 s to 7.294 s; G9 still passes.

**Against dev-c5 qwen:**
- Gains:
  - G2 12/13 -> 13/13 (now PASS);
  - G3 51/61 -> 52/61 (83.6% -> 85.2%, still FAIL);
  - G5 8/49 -> 6/49 (16.3% -> 12.2%, now PASS);
  - G7 72/73 -> 73/73;
  - G8 4/5 -> 5/5 (now PASS);
  - decoder_incompatible 0/5 -> 5/5;
  - healthy 12/13 -> 13/13;
  - restored G4 7/15 -> 9/15.
- Regressions:
  - G1 0 -> 1 (`audiobook-insuff-001`, now FAIL);
  - guarded G4 11/15 -> 10/15;
  - identity_mismatch 11/14 -> 6/14 (now below 2/3).
- Equal: G6, G9 (PASS), G10, corrupt_file, metadata_naming and order_edition_ambiguity.

## Statements (verbatim, registered)

- Everything here is dev-tuned. One pass on correlated, previously tuned fixtures: neither significance nor generalisation. No readiness claim.
- C7 is a combined candidate: an effect is not attributable to the prompt, the presentation, the tools, the context or the Ollama runtime alone.
- dev-c6 differs in prompt, evidence format, tools behaviour, audit typing, `num_ctx` (8192 then, 16384 now) and Ollama runtime (0.40.6 then, 0.40.7 now); dev-c5 also in decision schema and audit version (v2).
- The partial dev-c7 qwen run (5 of 73 cases, Ollama 0.40.6) stays in the record unchanged; this pass does not replace or rescore it.
- G6 measures fixture verification, not completed repairs.
- "Guards off" means restored original decisions from the same completions (not an independent run).
- Each gate keeps score.py's own denominator; G7 uses planned cases.

## Process record

- **Measurement go:** the coordinator's written go after the pre-measurement review of #1030 at `35e64957` (Opus; Astra AUDIT-ASTRA-34), with no amendment. Started at 07:22 America/New_York, outside Renovate's 22:00 to 06:00 PR window.
- **Pre-run checks (11:22:40Z, no Ollama call), all passed:**
  - the tree was clean, head `35e64957`;
  - `git ls-tree -r HEAD tools/media-repair-harness/src | sha1sum` = `36a08be3...`, and `git diff cc539654 HEAD -- tools/media-repair-harness/src` was empty;
  - haynes-ops `origin/main` `1c514a7b` pins tag `0.40.7`;
  - the pod `ollama-prime-cdc6fb897-jnkjp` (uid `c9016919-68e0-4912-b9bf-355cb7f19d08`) runs `docker.io/ollama/ollama:0.40.7`, imageID `sha256:2e6cc92ffa43b4b1a2e70e315407e00ac97ec125afc71277d73c7efe01c4f31b`, restarts 0;
  - no open haynes-ops PR names ollama.
- **Activity:** `declare-activity start "dev-c7 qwen r2" --scope ai,ollama-prime --ttl 60m` (id `act-112245-1354897`) at 11:22:45Z, and `declare-activity end` at 11:29:28Z.
- **The pass:**
  - The registered command ran once, from 11:22:51Z to 11:29:19Z, exit 0. Its argv equals `manifest-template.json` `run.argv`.
  - At preflight, `/api/ps` was empty, the installed digest matched, and the server reported 0.40.7.
  - It was followed by the warm-up, the GPU-fit reading and the 73 cases.
  - The runner unloaded the model it loaded. Nothing else was loaded or unloaded, and there was no pull, retry or rerun.
- **After the pass:** the same pod (name, uid, container id `f88393221d1a...`, restarts 0) was still running at 11:29:28Z. `src/` was unchanged again (`36a08be3`, empty diff against `cc539654`).
- **Manifest against `manifest-template.json`: no deviation.** Every one of these matches:
  - argv and `config_hash`, the latter also in every record;
  - case ids, case order and case table hashes;
  - runtime 0.40.7 and the digest;
  - the Ollama options, `context_policy`, `gpu_fit_check` and the PSI guard;
  - the prompt sha256 and the contract versions;
  - the wall cap, the uncapped spend, the page budget and the run id;
  - a clean tree, and every response model id.
- **After the run (offline, no model call):**
  - the run directory was copied unchanged (`diff -r` identical) from `/tmp/claude-1000/mrh-c7r2-runs/` into `devc7r2-qwen3.8-27b/`;
  - `python3 -m media_repair_harness.guard_cli <run> --restore --suite <suite> --out <run>-restored` restored the original decisions (73 records);
  - both views were scored with the unchanged `score.py` through `score_compat` (`score.json`, `score.md`, `score-qwen3.8-27b[-restored].out`);
  - the unchanged uncalled-check counter (`uncalled.summarise`) ran over the records.
- The tables were built offline from these files. The gate numerators are recomputed from score.py's values and denominators; that method reproduces every dev-c6 and dev-c5 qwen cell of the dev-c7 README, and Tables 5, 6, 8, 12 and 13 of its Haiku section.

## Files

- `devc7r2-qwen3.8-27b/`: records, manifest, audit, run summary, `score.json` / `score.md`.
- `devc7r2-qwen3.8-27b-restored/`: restored original decisions, scored.
- `score-qwen3.8-27b.out`, `score-qwen3.8-27b-restored.out`: the scorer's console output.
- Frozen before any model call: `PREREGISTRATION.md`, `manifest-template.json` (and `tests/test_devc7_qwen_r2.py`).
