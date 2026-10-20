# dev-c5 measurement: PRE-REGISTRATION (OpenProject #146, worker W19)

Committed BEFORE any model response, smoke runs included. Nothing here is changed after the first model response; a change is a separately labelled experiment with its own directory, and every attempt is kept.
**Everything measured here is DEV-TUNED**: the 73 cases of `suite-dev-v1.1` built and tuned the harness, one sample per model, correlated fixtures. It shows neither significance nor generalisation (dev-c3's dev numbers did not predict held-out).
No pass or fail readiness is claimed. G6 measures fixture verification, not completed repairs. No held-out material is read.

## 1. What is measured

Configuration **B** (the candidate): `--prompt v5 --evidence-format v2 --guards v3 --evidence replay` on `suite-dev-v1.1`, `--split dev`. B is a COMBINED candidate (prompt v5 + evidence format v2 + guards v3 + audit v2 + tools v2); two runs
cannot attribute any difference from dev-c4 to the prompt or to the format. dev-c4 used prompt v4, legacy evidence and guards v2 (guards v1 columns appear only in the older dev-c4 README), so prompt, format, guards and harness fixes are all confounded with each other.

| Item | Frozen value |
|---|---|
| Frozen code commit | `8ee818c6` (`agent/mrh-devc5-1020`); the run starts from a clean checkout whose `src/` and `prompts/` are identical to it (`git diff 8ee818c6 HEAD -- tools/media-repair-harness/src` empty, checked and recorded before the first call) |
| `HARNESS_VERSION` | `dev-c5` |
| `prompts/v5.txt` file sha256 | `3ea39017906d30ff72cfe579857c194517263d53cf5f13592309fa593572b71e` |
| Assembled system prompt sha256 (`prompt.sha256` in every record) | `9715dc4ca5de307899100764d481481cc7e2e2fd16641af45540a18e983dbab7` (15,876 characters) |
| Prompts v1 to v4 sha256 (unchanged) | v1 `30749f5d...`, v2 `351f40fd...`, v3 `b1fd9e85...`, v4 `a2c3036e...` (full values pinned in `tests/test_v5.py`) |
| Per-case turn schema | the v4 schema (`P.turn_schema('v5', tools)` equals `turn_schema('v4', tools)`); sent only by the Ollama adapter |
| Suite | `.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1`, `manifest.json` sha256 `9607b7fdcaaa7c5c72530b68998d12554e9cb412398c2004e353e6d0783dd0dd`, 73 cases |
| Case order (the runner's sorted order, serial) | sha256 of the ids joined by newlines `21ec373079f8556a966cdc8309f09bcf7aadbc2184c8e0f0fde50da601930ee5`; table of case sha256 values `c6aee6ae920033eefa60fb8e2502e3028441993951822c94270cca454d15906f`; the ids are listed in `manifest-template.json` |
| Scorer | the evaluator's `harness/score.py` sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, loaded by `score_compat.py` sha256 `2bdabb592c4db3229270d5aac049bba32d25810f5acba85a10ab6a4958cebe4d` (both unchanged since dev-c4; asserted in `tests/test_v5.py`, which also rescores two committed dev-c4 runs to their committed `score.json`) |
| Gates and comparison source | `GATES.md` sha256 `35fd4be96f72ece5e7e54f0dddee5614c28ce78f53561123fd70a1b56a46a40e`; dev-c4 numbers from `evaluation/dev-c4-v1.1/REPORT.md` sha256 `dca7334e959ee2667cbbb0de2a017dbd5e0b1d10ce3ce0ede9275b64291f3735` (evaluator-owned, public), same suite and scorer |
| Guards | `v3` (`guard.version` in every record); the decision as recorded is the guarded one |
| Evidence | `replay` (`--replay auto`), `--tool-output-bytes 8192` (the page budget, recorded as `wire_bytes`), tool timeout 60 s, tools behaviour v2, audit v2, `pages-v1` |
| Tool budget | 6 calls per case, a page fetch counts as one; `MAX_MODEL_CALLS` 18 per case |

## 2. Runs (one sample each; no iteration of v5 after a measured run; no smoke run before them)

There is no smoke run: the first model response is the first measured case. A failure before any case completes that is not a model result (CLI not found, `/api/ps` busy, load failure) leaves its directory in place and the run is repeated with the same frozen configuration under a new run id; that attempt is reported.
Checks that call no model (`claude --version`, `/api/ps`, `/api/tags`, `git`, offline tests) are allowed.

| | Haiku | qwen |
|---|---|---|
| model id (requested; the response id is recorded and must equal it) | `claude-haiku-5-5` | `qwen3.8:27b` on Ollama Prime |
| adapter | `claude` (Claude Code 2.1.299 on the pod at registration; the runtime version is recorded), effort unset (`null`), flags `--tools "" --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --setting-sources "" --no-session-persistence`, `--max-budget-usd 2.0` per call (default), call timeout 240 s, no output-token setting beyond the CLI's | `ollama`: `num_ctx 8192`, `num_predict 640`, `use_mmap false`, temperature 0, seed 42, `think false`, `keep_alive 2m`, schema `anyof` (the v4-style per-case tool enum), stop per family (default), warm-up and load timeout 900 s, call timeout 120 s, PSI/restart guard on |
| model digest | none (hosted) | `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` (dev-c4 and checkpoint 1); the run proceeds only if `/api/tags` shows this digest |
| flags | `--adapter claude --model claude-haiku-5-5 --suite <suite-dev-v1.1> --split dev --prompt v5 --evidence-format v2 --guards v3 --evidence replay --max-total-cost-usd 0.60` | `--adapter ollama --model qwen3.8:27b --suite <suite-dev-v1.1> --split dev --prompt v5 --evidence-format v2 --guards v3 --evidence replay --num-ctx 8192 --keep-alive 2m --max-wall-s 1800` |
| run id | `devc5-b-haiku-5-5` | `devc5-b-qwen3.8-27b` |
| hard cap | cumulative reported cost **$0.60**: the run stops cleanly before the next case that could take it to the cap (judged against the dearest case so far; a second check before every model call), the cases not run are recorded as a BUDGET-LIMITED PARTIAL | **30 minutes** wall time for the whole pass, warm-up and load included, counted from just before the adapter preflight; the run stops cleanly, unloads only what it loaded, and records the rest as NOT RUN |
| order | first | second, after the Haiku run, and only if the Ollama rules below hold |

Ollama rules (mandatory): `declare-activity start "dev-c5 qwen3.8:27b dev pass" --scope ai,ollama-prime --ttl 45m` before and `declare-activity end <id>` after; `/api/ps` must be EMPTY first, and if any model is resident that this run did not load the qwen pass is SKIPPED and reported (no wait, no retry);
one resident model, serial, the PSI/restart guard on (a trip aborts the pass cleanly), unload only what this run loaded, no pulls, no global settings change. A busy Ollama skips only the qwen pass; everything else continues. The Haiku run does not depend on it.

## 3. Retry, repair, timeout and abort rules (the harness defaults, frozen)

* **Repair:** a reply that is not one valid JSON object, or fails the strict validator, gets exactly ONE generic repair prompt (the validator error plus a fixed hint per failure mode). If the repaired reply is also invalid the decision is FORCED to `insufficient_evidence` / `escalate` and recorded `forced`. First-attempt validity is never repaired after the fact.
* **No whole-case rerun, ever.** A model call that fails (CLI error, 240 s Claude timeout, Ollama transport error or 120 s call timeout) is recorded, the case ends as a forced escalate, and the run moves on. Tool calls over the budget, tools not offered and repeated calls are recorded violations and answered `unavailable`.
* **Aborts** (the run stops, remaining cases are recorded as not run): GPU busy or foreign resident model, model not installed (no pulls), load failure or timeout (not retried), PSI/restart guard trip, the two caps above. Exit status 3 and the reason are in the manifest; `records_written` against `case_ids` lists what ran.
* **Context overflow (qwen, 8192 tokens):** Ollama truncates an over-long prompt silently and nothing is done to prevent it (`num_ctx` is fixed at 8192; the system prompt, the cases and the page budget are frozen). Each turn is flagged by the adapter from the REPORTED token counts (`prompt_at_context_limit`, `context_full_after_generation`) and, separately, by the 3-characters-per-token ESTIMATE (`estimated_prompt_exceeds_context`, pessimistic and not evidence of truncation).
  The report states the number of turns and cases with a reported-count flag next to every qwen table, scores all 73 cases as recorded, and adds one qwen row for the cases with no reported-count flag (an offline `score.py --only` rescore, labelled as a subset). Nothing is rerun. Offline, before the freeze: the v5 system prompt plus the largest first message of either public dev suite is below the 8192-token estimate (a test in `tests/test_v5.py`); a case with several large tool replies can still pass it.
* **Hosted models:** the response model id of every record is checked against the request; any difference is reported in the table.

## 4. After the runs (offline, no model call)

"Guards off" is called **restored original decisions from the same completions (not an independent run)**: `mrh-guard <run> --restore --suite <suite> --out <copy>` (the run is untouched), scored with the same unchanged scorer. dev-c4 columns are the evaluator's Sections 2 (guarded, guards v2) and 2b (restored original decisions) of the REPORT named above.

## 5. The tables that will be reported, exactly (per model run; the same layout for both; every number labelled dev-tuned)

1. **Run table:** run id, config_hash, harness commit, prompt sha256, response model ids, runtime version, digest, cases recorded of 73, cases not run (ids and the reason), aborted, cost and tokens as reported (Haiku), wall time (qwen, warm-up reported separately), crashes, adapter errors, forced decisions.
2. **Gates G1 to G10, guarded against guarded:** B as recorded (guards v3) next to dev-c4 as recorded (guards v2, legacy evidence, prompt v4), with threshold, PASS/FAIL, and the numerator and denominator of G2, G3, G4, G5, G6, G7, G8 (G7 also as first-attempt valid, repaired and forced counts).
3. **Gates G1 to G10, original against original:** B restored original decisions next to dev-c4 restored original decisions (Section 2b), same layout.
4. **Per-class G3:** correct / n for corrupt_file, decoder_incompatible, identity_mismatch, metadata_naming, order_edition_ambiguity, healthy (and the G4 abstention share for insufficient_evidence), guarded and original, B next to dev-c4, with the classes below 2/3.
5. **Guard effect:** unsafe proposals hidden by the guards (a guard-changed original write that score.py's rule counts unsafe), all hidden writes, every guard-made escalation (case, rule, original class/action, whether the original and the final were correct), G1 on guarded against original decisions.
6. **Validity:** first-attempt valid, repaired, forced, protocol violations, repair prompts, rejected write attempts (`g1_context`).
7. **Context (qwen):** turns and cases flagged, and the subset row of section 3. **Failures and partial runs** stay in the tables as "not run" or "forced", never dropped.
8. **Statements, verbatim in the report:** dev-tuned; one pass on correlated, previously tuned fixtures; neither significance nor generalisation; no readiness claim; B is a combined candidate so an effect is not attributable to the prompt or to the format; dev-c4 differs in prompt, evidence format, guards version and harness fixes; G6 measures fixture verification, not completed repairs.
G2, G3 per class, G4 and G5 are of interest and are not targets. No other table, cut, ranking or threshold is added after the results.

## 6. Hold

The coordinator placed a hold: no model call (smoke, Haiku, Ollama) until an explicit "measurement go" and until an independent re-review of the last two harness changes (the zlib classification and the page origin) has cleared. This file and `manifest-template.json` are committed during the hold.
