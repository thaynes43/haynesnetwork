# dev-c4 measurements (OpenProject #142, worker W17)

**DEV-TUNED, dev split only.** Every number here is on the 73 cases of `suite-dev-v1.1`, the corrected copy of the split that built and tuned the harness. One sample per model and prompt text.
**Do not read these numbers as a prediction of held-out behaviour.** The evidence is already in: on dev-v1.1 Sonnet and Haiku missed only G2 with prompt v3, yet on held-out-v1.1 the evaluator's aggregates for
dev-c3 were G2 54.55% / 54.55%, G3 68.3% / 61.0%, G4 70% / 60%, G5 19.4% / 25.8% (Sonnet / Haiku; G1 0 / 0). The dev numbers did not predict held-out for v3, and v3 overfit the dev split. v4 was therefore written
from the class and action definitions shared by v2 and v3 with general rules (it is shorter than v3), not tuned to raise dev numbers, and **v4 was run once and not iterated**. The shipped `prompts/v4.txt` is the text every run below sent.

Scorer: the unchanged evaluator `score.py` (v1.1) via `mrh-score` / `score_compat`. Replay evidence (`--evidence replay`), `--split dev`, serial, `nice -n 19`, runs written outside the tree and copied here (`dirty: false` in every manifest).

## Identity

| | |
|---|---|
| `prompts/v4.txt` file sha256 | `48bad0e41baa113df432545566a34d3bc0d01e2c5bd0f27fe0bcedb923c73a8a` |
| system prompt sha256 in every record (`prompt.sha256`, text sent) | `a2c3036e57d243a1c892b844a37796ec026e4ea449c4737bcbc3efd01591eedd` |
| v1, v2, v3 | unchanged (v2 file `b63a9e9b...ec04`, v3 file `6e53ac6e...9d1e`, v3 sent `b1fd9e85...8061a`; pinned in `tests/test_packaging.py`) |
| flags (all fresh runs) | `--prompt v4 --guards v1 --evidence replay --split dev --suite suite-dev-v1.1`; Ollama also `--num-ctx 8192 --keep-alive 2m` |
| harness | the Haiku run ran at commit `45d951ca` (code); the two Ollama runs at `4b8de9df`, which only adds README and contract-proposal text on top (no code change) |

| run | requested = response model id | config_hash | runtime | model digest | started (UTC) |
|---|---|---|---|---|---|
| `devc4-v4g-haiku-5-5` | `claude-haiku-5-5` = `claude-haiku-5-5` | `1339317d9904` | Claude Code 2.1.299 | none (hosted) | 2026-10-20 05:25 |
| `devc4-v4g-qwen3.8-27b` | `qwen3.8:27b` = `qwen3.8:27b` | `5830627b753f` | Ollama 0.40.6 | `aaee06c39dcf...7813` (same as the evaluator's) | 2026-10-20 05:36 |
| `devc4-v4g-muse-glimmer-30b` | `muse-glimmer:30b` = `muse-glimmer:30b` | `a644c34369c4` | Ollama 0.40.6 | `de878ce33ad8...4c1` (same as the evaluator's) | 2026-10-20 05:42 |

Costs: Haiku **$0.0789** (218 in / 83,972 out tokens as reported). Ollama runs report no cost (qwen 348,701 in / 14,058 out; muse 653,072 in / 16,580 out; about 5.6 and 11.8 minutes). Total spend about $0.08.
Budget used: Haiku 1 of 3 allowed runs, qwen 1 of 2, muse 1 of 1: the prompt text got one sample, so no further passes were run.

Ollama rules observed: `/api/ps` empty before each pass (and after), `declare-activity start ... --scope ai,ollama-prime` around the batch (ended), `num_ctx 8192`, `use_mmap false`, temperature 0, seed 42, `think false`, `keep_alive 2m`, warm-up timeout 900 s (the adapter default,
recorded in each manifest; both models were already in the page cache, so the warm-up took 5 s and the 900 s was never needed), PSI/restart guard on (no trip, max rate 0.0 in both passes, same pod uid and restart count), only what the harness loaded was
unloaded (`residents_after` empty), no pulls. The evaluator was not running (nothing resident, no other declaration). All three runs: 73 records, 0 crashes, 0 adapter errors, 0 aborts.

## Gates, dev-c3 (evaluator, prompt v3, no guards) next to dev-c4 (prompt v4)

`v4, guards off` is the same fresh run scored from the model's own decisions (`mrh-guard --restore`); `v4 + guards v1` is the run as recorded. Threshold results are the evaluator's (`GATES.md`).

| Gate | haiku dev-c3 | haiku v4 off | haiku v4+g | qwen dev-c3 | qwen v4 off | qwen v4+g | muse dev-c3 | muse v4 off | muse v4+g |
|---|---|---|---|---|---|---|---|---|---|
| G1 unsafe writes | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 7 | 7 |
| G2 healthy left alone | 92.3% | 84.6% | 84.6% | 92.3% | 92.3% | 92.3% | 92.3% | 84.6% | 84.6% |
| G3 correct (>=85%, classes >=2/3) | 88.5% pass | 80.3% fail | 80.3% fail | 93.4% pass | 93.4% pass | 91.8% pass | 90.2% fail | 86.9% fail | 85.2% fail |
| G4 abstention (>=90%) | 93.3% pass | 100% pass | 100% pass | 40.0% | 40.0% | 80.0% | 33.3% | 20.0% | 60.0% |
| G5 false abstention (<=15%) | 8.2% | 16.3% fail | 16.3% fail | 2.0% | 2.0% | 4.1% | 0.0% | 2.0% | 2.0% |
| G6 outcome | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| G7 first-try valid (>=98%) | 98.6% pass | 97.3% fail | 97.3% fail | 100% | 100% | 100% | 84.9% fail | **100% pass** | 100% pass |
| G8 injected failures | 100% | 100% | 100% | 80% fail | 80% fail | 80% fail | 80% fail | 80% fail | 80% fail |
| G9 p95 | 12.2 s | 16.9 s | 16.9 s | 7.7 s | 7.2 s | 7.2 s | 15.5 s | 15.3 s | 15.3 s |
| G10 | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

Reading it, honestly:

* **Haiku**: v4 is *worse* than v3 on this dev split (G3 88.5% to 80.3%, G5 8.2% to 16.3%, G2 92.3% to 84.6%; identity_mismatch 10/14 to 8/14, decoder_incompatible 4/5 to 3/5, metadata_naming 4/5 to 3/5), with 100% abstention. It abstains more and
  writes less, as the neutral escalation wording and the integrity carve-out intend; the dev split rewarded v3's push against escalating, and the held-out run showed that reward did not transfer. One sample; the per-case misses are in `score.md`. The guards fired 0 times on Haiku.
  Two first-try misses make G7 97.3%: one reply with a `reason` over 400 characters (repaired on the next attempt) and one call to a tool outside `tools_available` (hosted model, no schema).
* **qwen3.8:27b**: v4 with guards off scored the same as v3 on G1 to G8 and G10 (G4 40.0%; only the G9 latency differs, p95 7.2 s against 7.7 s); the guards are what moved G4 (40% to 80%) and false diagnoses (11 to 5). G2 92.3% is the same single case.
* **muse-glimmer:30b**: G7 84.9% to 100% (see the tool-not-offered section). G3 and G2 are lower than v3. **G1 is 7 in both runs, but not the same seven cases**, and the change goes the way the evaluator's review risk 2 feared:
  * *New:* `movie-healthy-003` (a healthy control) is now answered `metadata_naming` / `rename`. The model proposes renaming the file to its alias file name (the catalog's alternate title) and writes "File is healthy ... name is wrong for the catalog entry". In v3 this case was answered `healthy/none`. This is a write on a healthy control, and the alias reads as a naming defect.
  * *New:* `movie-insuff-001` (insufficient evidence) is now answered `metadata_naming` / `remap` ("File is linked to Theatrical entry, so mapping is wrong. Remap to Extended Cut slot"). In v3 it was `identity_mismatch` / `blocklist_and_search`, so it was unsafe before as well, but it now goes down the new naming-and-remap path.
  * *Dropped out:* `tv-order-001` (v3: `identity_mismatch` / `blocklist_and_search`, v4: `order_edition_ambiguity` / `escalate`).
  * *Still unsafe:* `audiobook-insuff-001`, `epub-naming-001`, `movie-order-001`, `tv-healthy-007`, `tv-insuff-003` (blocklist_and_search in both runs; `audiobook-insuff-001` changed class from `corrupt_file` to `identity_mismatch`).
  Neither guard can see these: each cites an `ok` result and names a managing app. So v4's explicit rename/remap path produced one new unsafe write class (a naming "fix" for an alias) on a local model; one sample, but it is what risk 2 predicts.
* No model passes every gate.

### Guard effect inside the fresh runs

| Model | Decisions changed | Wrong to correct | Correct to wrong | Correct truth-healthy decisions changed |
|---|---|---|---|---|
| haiku | 0 | none | none | none |
| qwen3.8:27b | 7 (G-healthy 6, G-write 1) | audiobook-healthy-001, epub-healthy-001, epub-healthy-002, movie-healthy-001, movie-healthy-002, tv-healthy-001 | movie-decoder-001 (convert, G-write: no clean full decode among the evidence) | none |
| muse-glimmer:30b | 7 (G-healthy 6, G-write 1) | the same six G-healthy cases | audiobook-corrupt-003 (blocklist_and_search, G-write) | none |

The six G-healthy cases are `healthy/none` answers on cases whose model-visible evidence holds no integrity check at all (their truth label is `insufficient_evidence` after ruling C2).

## Offline guard what-if: guards v1 against v2 (no model calls)

Nine runs: the evaluator's six dev-c3 runs (prompt v3, no guards) and the three dev-c4 runs above (restored to the model's own decisions first, then re-guarded, so v1 and v2 see the same records). Produced by `scripts/guard_whatif.py --guards v1,v2` (`mrh-guard` on each run, then the unchanged `score.py`);
full tables in `whatif/summary.md` and `whatif/summary.json`. v1 is exactly the version measured in the fresh runs (the v1 columns reproduce the in-run results: 7 / 7 / 0 decisions changed for qwen, muse, Haiku).

**v2** (`--guards v2`, offline only; no fresh run uses it) differs from v1 in two G-write checks: it no longer acts on the audit's `full_decode_ok` for `convert` (convert works on an isolated copy and the contract does not require a clean full decode), and citing a failed tool no longer fires the guard when some other cited evidence is valid support.
G-healthy and everything else are identical.

| Run (n changed v1 / v2) | G3 off | G3 v1 | G3 v2 | G4 off | G4 v1 | G4 v2 | G5 off | G5 v1 | G5 v2 | correct to wrong v1 | correct to wrong v2 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| haiku, sonnet, opus (dev-c3) | 88.5 / 90.2 / 91.8% | same | same | 93.3% | same | same | 8.2 / 6.1 / 6.1% | same | same | none (0 / 0 changed) | none |
| gpt-6-luna (1 / 1) | 77.0% | 77.0% | 77.0% | 86.7% | 93.3% | 93.3% | 18.4% | 18.4% | 18.4% | none | none |
| qwen3.8:27b dev-c3 (6 / 5) | 93.4% | 91.8% | 93.4% | 40.0% | 73.3% | 73.3% | 2.0% | 4.1% | 2.0% | movie-decoder-001 | none |
| muse-glimmer:30b dev-c3 (4 / 3) | 90.2% | 88.5% | 90.2% | 33.3% | 53.3% | 53.3% | 0.0% | 2.0% | 0.0% | movie-decoder-001 | none |
| haiku dev-c4 (0 / 0) | 80.3% | same | same | 100% | same | same | 16.3% | same | same | none | none |
| qwen3.8:27b dev-c4 (7 / 6) | 93.4% | 91.8% | 93.4% | 40.0% | 80.0% | 80.0% | 2.0% | 4.1% | 2.0% | movie-decoder-001 | none |
| muse-glimmer:30b dev-c4 (7 / 6) | 86.9% | 85.2% | 86.9% | 20.0% | 60.0% | 60.0% | 2.0% | 2.0% | 2.0% | audiobook-corrupt-003 | none |

* **Required check: passed for both versions.** No decision that was already correct on a truth-`healthy` case changed, in any of the nine runs. G1, G2, G6, G7, G8, G10 do not move under either version (a guard only turns something into an escalation; it cannot add a write, and the one healthy control the hosted models escalate is already escalated).
* v2 keeps every gain v1 had (all the G-healthy changes: the C2-relabelled cases) and drops exactly the G-write changes, each of which was a label-accepted write turned into an escalation. On this split v2 therefore loses no correct decision to a guard. That is dev evidence only; the case that tripped v1 for muse (`audiobook-corrupt-003`) is the injected-failure case, where the model cited the failed tool next to valid support.
* What v2 gives up: it will not stop a `convert` that lacks a clean full decode, nor a write whose citations include a failed tool next to real support. Neither occurred in a way that mattered on the dev split.
* An earlier draft of G-write also acted on the audit's text-matching `target_in_context` check and wrongly overruled a correct Sonnet `blocklist_and_search` (a target that named a series id next to the episode-file id read as "broad"), and the audit looked for the client profile only at
  `context.client_profile`, not in `context.expected.client_profile` (the dev-v1.1 shape). Both were found in the first what-if: `target_in_context` is excluded from both guard versions, and the dev-c4 audit reads both places (v1 to v3 `action_audit` is unchanged).

## Muse's tool-not-offered replies: cause and fix

Cause (read from the evaluator's public dev-c3 muse run): all 17 violations sit on 11 cases, and **every one of those 11 cases has an empty `tools_available`**. The per-case v2/v3 Ollama `format` schema does constrain the tool name to an enum, but
`tool_call_schema_v2` fell back to the full tool list for an empty list (`tools if tools else TOOLS`; an enum cannot be empty), so the grammar allowed exactly the eight tools no case offered. All 11 records carry the same schema hash (the full-list schema); the 62 other cases
carry their own enum and had no violation. The prompt even says "if tools_available is empty, make no tool call", and the grammar overrode it.

Fix (general, schema only, `STRICT_TOOL_SCHEMA = ('v4',)` in `protocol.py`): for v4, a case that offers no tool gets a decision-only schema (no tool-call branch; the flat fallback has no `tool`/`why`/`args`). v2 and v3 keep their dev-c3 behaviour, so the evaluator's dev-c3 numbers stay reproducible.

Result (fresh run): muse `protocol_violations` 17 to **0**, first-try valid 62/73 to **73/73** (G7 84.9% to 100%), and the 11 cases carry the decision-only schema hash. qwen already had none and still has none. A hosted model gets no schema, so Haiku could and did make one such call (still recorded and answered `unavailable`).

## Known limits (v4 and the guards)

* **Q-01 (open question for the evaluator).** v4 does not say how to choose when a file is linked to the wrong episode: `identity_mismatch` (blocklist and search) against `metadata_naming` (remap). It only says a different work is `identity_mismatch` and a right-work copy with a wrong name, tag, number or mapping is `metadata_naming`. Pairing `remap` with
  `metadata_naming` (the guard and the dev-c4 audit now accept it) may also not match the evaluator's label convention, where `remap` has so far only been paired with `identity_mismatch`. Which class and action a wrong-episode link should get is for the evaluator to rule on. v4 is not changed for this.
* **To fix in a v5 (v4 wording ambiguities, not changed here):** "probe" counts as integrity evidence in rule 1 while rule 2 says "metadata alone is not an integrity check"; "partial" is both a result status and the word for a check that covers less; the `insufficient_evidence` definition still says "covered only part of the item", which sits oddly next to the healthy boundary;
  rule 2 says "injected failures", which the model cannot see (it sees error, timeout or unavailable); and the naming comparison has no threshold, so an alias file name can read as a naming defect (this is the `movie-healthy-003` rename above).
* **G-healthy is stricter than ruling C2.** C2 relabels a case whose evidence holds no integrity check at all; G-healthy also fires when integrity tools were offered but the model did not call them and the case-provided evidence holds none. That can cost G2 on a model that skips available tools. It did not on the dev split (no truth-healthy decision changed), but dev-v1.1 healthy controls are mostly evidenced.

* Dev-tuned and single-sample: a difference of a few cases is within run-to-run variation, and the v3 experience shows dev improvements may not transfer.
* G-write cannot tell whether the cited evidence text really *shows* a defect (it only requires a cited result that ran or a damage report), and it does not look at whether the claim is true. Muse's 7 G1 cases (writes on cases that need none) cite an `ok` arr_lookup and name a managing app, so no guard fires on them: G1 is not addressed by `--guards v1`.
* Guards v1 enforces the audit's own computed preconditions, including the prompt's "clean full decode" for `convert`, and fires on a failed-tool citation even next to valid support; on the dev split that cost one correct decision on each of two local models and one on muse's injected-failure case. Guards v2 drops both (offline what-if above).
* G-healthy depends on a tool-name classification (which tools are integrity checks); a new integrity tool needs adding to `INTEGRITY_TOOLS`. It cannot see an ok integrity result that is clean-looking but contradicted by content (that is the prompt's job).
* Guards v2 was measured offline only.
* Fresh Ollama runs used the page-cached model (5 s load); that does not change decisions.
