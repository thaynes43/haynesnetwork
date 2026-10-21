# dev-c7 qwen re-registered pass: PRE-REGISTRATION (OpenProject #155, worker W24)

Committed BEFORE any model call of this story. No warm-up, smoke run, load or hosted call has been made, and no Ollama endpoint (`/api/version`, `/api/tags`, `/api/ps`, `/api/show`, `/api/generate`, `/api/chat`) has been called. The only live reads were git (haynes-ops `origin/main`), the GitHub PR list and one Kubernetes API read of the `ollama-prime` pod's image (section 2). Nothing here changes after the first model response. A change before it is a numbered amendment in a new commit, and every attempt is kept.
**Everything measured here is DEV-TUNED**: the 73 cases of `suite-dev-v1.1` built and tuned the harness, one sample, correlated fixtures. It shows neither significance nor generalisation. No pass or fail readiness is claimed. G6 measures fixture verification, not completed repairs. No held-out material is read.

## 0. Why this pass exists

The dev-c7 qwen run (OpenProject #154, `runs/dev-c7/`) was aborted after 5 of 73 cases: at 04:39:12Z on 2026-10-21 Flux replaced the `ollama-prime` pod to upgrade Ollama from 0.40.6 to 0.40.7 (haynes-ops #4158). The dev-c7 registration forbids a rerun, so none was made. Tom chose **"Re-run qwen only"** on 2026-10-21. This is therefore a **new, separately registered pass** of the same qwen configuration, on the runtime that is now deployed (0.40.7). It is not a rerun, a continuation or a replacement of the dev-c7 qwen run:
* the **5-case partial dev-c7 qwen run stays in the record unchanged** (`runs/dev-c7/devc7-qwen3.8-27b/`, `-restored/`, `score-qwen3.8-27b[-restored].out`; every file's sha256 is pinned in `manifest-template.json`, `partial_dev_c7_qwen_run`, and by `tests/test_devc7_qwen_r2.py`);
* this pass does **not replace, rerun or rescore** it, and it is **not** a comparison column here;
* the dev-c7 Haiku and Astra runs are unaffected and are not repeated.

## 1. What is measured, and what changed from the dev-c7 qwen registration

**The template is `runs/dev-c7/PREREGISTRATION.md` through Amendment 2** (sha256 `b13092298afad492a148f2104a7ab75d7a902b1eb673fbde0d8f6fd72cc64f07`) and its `manifest-template.json` (sha256 `f7bf5fb14a4681fe2b5b84c8b1d737b15ac46cd4fc6ea7f8a3fb915f5363a7f6`). Everything that registration fixes for the **qwen** run applies here unchanged, except the items in the second table below. Its Haiku, Astra and benchmark-passability parts (the Astra run, section 8 and table 11) do not apply: this pass has one run.

| Item | Frozen value (unchanged from dev-c7 qwen; each re-checked on this tree) |
|---|---|
| Configuration | **C7**: `--prompt v7 --evidence-format v3.1-format --guards v3 --evidence replay --tool-output-bytes 8192 --no-spend-limit` on `suite-dev-v1.1`, `--split dev` (prompt v7 + format v3.1-format + `turn-v3` / `decision-v3` + audit v3 + guards v3 + tools behaviour v3 + `pages-v1`), a COMBINED candidate |
| Frozen code | `src/` tree `git ls-tree -r <commit> tools/media-repair-harness/src \| sha1sum` = **`36a08be3d70027533f56d41250edc940053e31df`**, the dev-c7 Amendment 1 tree (`1419f4b7`). Unchanged on main: `git diff 1419f4b7 cc539654 -- tools/media-repair-harness/src` is empty and the tree sha1 at `cc539654` is `36a08be3`. The pass runs from this PR's head, whose `src/` is identical (`git diff cc539654 HEAD -- tools/media-repair-harness/src` empty, and the sha1 above, checked before the first call and after the last) |
| `HARNESS_VERSION` | `dev-c7` |
| Prompt | `prompts/v7.txt` file sha256 `0875cc586b18debb241cfb569b5387a4b5da71064726fc3610bed8776fdfe8f9`; assembled sha256 `79a7fc73b855ccee6964c4752249477b070b79acebc3daf5c9c17a8a6b3eafb5` (19,500 characters) |
| Contract versions | as dev-c7 section 1 (`contract-v3`, `v3.1-format`, `turn-v3`, `decision-v3` sha256 `d26ce3d1...2ad42b`, audit `v3`, tools `v3`, `pages-v1`, rubric `contract-v3-rubric-3.2`, checker `contract-v3-rubric-3.1`, excerpt rule `xhtml-body-text-3`); copied unchanged into `manifest-template.json`, `contract` |
| Suite | `.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1`, `manifest.json` sha256 `9607b7fdcaaa7c5c72530b68998d12554e9cb412398c2004e353e6d0783dd0dd`, 73 cases; case order sha256 `21ec373079f8556a966cdc8309f09bcf7aadbc2184c8e0f0fde50da601930ee5`, case table `c6aee6ae920033eefa60fb8e2502e3028441993951822c94270cca454d15906f` (recomputed on this tree with the runner's own loader) |
| Scorer | `harness/score.py` sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789` through `score_compat.py` `2bdabb592c4db3229270d5aac049bba32d25810f5acba85a10ab6a4958cebe4d`; `GATES.md` `35fd4be96f72ece5e7e54f0dddee5614c28ce78f53561123fd70a1b56a46a40e` |
| Context | `--num-ctx 16384 --context-policy ctx16k-v1`, `num_predict` 640, input budget 15,744 tokens, page budget 8192 (dev-c7 section 2, unchanged; `context-sizing.json` sha256 `7f248ff3...04012f`) |
| GPU safety | `--gpu-fit-check full-gpu-v2` at the warm-up and at every detected reload (dev-c7 section 3 with Amendments 1 and 2, unchanged; `gpu-fit-offline.json` sha256 `75c21482...4e6e`) |
| Wall cap | `--max-wall-s 2700` (one absolute deadline, 180 s cleanup reserve inside it) |
| Spend | `--no-spend-limit` (`config.spend_limit: uncapped`); tokens as reported, no cost (local model) |
| Digest | `--require-digest aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813` (section 3) |
| Ollama options | temperature 0, seed 42, `use_mmap false`, `think false`, `keep_alive 2m`, schema `anyof`, stop per family, warm-up / load timeout 900 s, call timeout 120 s, PSI/restart guard on |
| Analysis scripts (unchanged, pinned) | `passability.py` `253e4d4c...ab330e`, `passability_v3.py` `3b3fa54e...1951cd`, `devc7_context.py` `469d64ea...22552e`, `devc7_gpu_fit.py` `db7aaa44...92838a`, `devc7_sizes.py` `acfd0b1b...9179fc`; full values in `manifest-template.json`. **`passability_v3` stays pinned and unchanged, but dev-c7 registered it for the Astra control only**, so it is not applied to this qwen pass (no table 11) |
| **Expected `config_hash`** | **`612a2325ee32f06e5cf44afa896047485cbf450b7d712b629ddbabebddbb34de`**, rebuilt offline from the registered command (`run.build_parser` + `run.build_adapter` + `run.run_config`) and pinned by `tests/test_devc7_qwen_r2.py`. It **equals** the dev-c7 qwen hash: the config records no path, run id or Ollama runtime version, and nothing it records changed. This pass is told apart from the partial dev-c7 qwen run by `run_id`, `runtime_version`, `started_at` and `harness_git.sha`. A recorded `config_hash` that differs is a deviation and is reported |

**Changed, with the reason for each:**

| Item | dev-c7 qwen | This pass | Why |
|---|---|---|---|
| Run id | `devc7-qwen3.8-27b` | **`devc7r2-qwen3.8-27b`** | A separately registered pass needs its own identity, and the runner refuses a non-empty run directory. Not `devc7-qwen3.8-27b-r2`: dev-c7 section 5 reserves the `-r2` suffix for a same-command preflight retry of Haiku or Astra, which this is not |
| Output and scratch | `OUT=/tmp/claude-1000/mrh-c7-runs`, scratch `/tmp/claude-1000/mrh-c7-scratch/qwen`; copied to `runs/dev-c7/` | `OUT=/tmp/claude-1000/mrh-c7r2-runs`, scratch `/tmp/claude-1000/mrh-c7r2-scratch/qwen` (neither exists at registration); copied to **`runs/dev-c7-qwen-r2/`** | Outside the worktree, so the tree stays clean; a separate directory, so the partial dev-c7 record is never touched |
| Worktree paths in the command | `/home/dev/work/mrh-devc7m-1021/...` | `/home/dev/work/mrh-qwenr2-1021/...` | The W23 worktree was removed after #1029 merged. Same suite, verified by its manifest and case hashes; paths are not in the config |
| Model-visible case alias | `case-<8 hex>` from HMAC(`devc7-qwen3.8-27b`, case id) | from HMAC(`devc7r2-qwen3.8-27b`, case id) | A consequence of the new run id (`leakguard.alias`). The alias is the only model-visible text that differs from the dev-c7 qwen command; it differed between every earlier pair of runs too. Named as a confound (section 8) |
| **Ollama runtime** | 0.40.6 | **0.40.7** | It is what is deployed (section 2). A **new confound** against dev-c6, dev-c5 and the partial dev-c7 run (section 8) |
| **Model digest** | read from the 0.40.6 server at preflight | the same value, **re-read offline** from the recorded manifests; **confirmed only at the runner preflight** (section 3) | No recorded reading from the 0.40.7 server exists |
| Pre-run runtime check | none | git + Kubernetes API, no Ollama call (section 2) | So the pass really runs on the registered 0.40.7 |
| Activity declaration | `"dev-c7 qwen pass"` | `"dev-c7 qwen r2"`, scope `ai,ollama-prime`, ttl 60m | The work order's label |
| Runs and order | qwen, Haiku, Astra | **qwen only** | Tom's ruling |
| Comparison columns | qwen: dev-c6 qwen and dev-c5 qwen | the same; the partial dev-c7 qwen run is **not** a column | 5 cases on another runtime; comparing would be a cut the work order did not ask for |
| Tables | 1 to 13 per run | 1 to 10, 12 and 13 (section 6), with one registered diagnostic added to table 7 (section 4) | Table 11 is Astra-only; the diagnostic is needed because the truncation flags were calibrated on 0.40.6 |

## 2. Runtime: Ollama 0.40.7 (new confound)

* **Deployed:** haynes-ops `kubernetes/main/apps/ai/ollama/prime/app/helmrelease.yaml` pins `docker.io/ollama/ollama` tag `0.40.7` since `91bd893c` (haynes-ops #4158, authored and merged by Renovate at 2026-10-21T04:35:22Z; it changed only the image tag, so `OLLAMA_MODELS`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_LOAD_TIMEOUT` and the absence of `OLLAMA_NUM_PARALLEL` and `OLLAMA_KV_CACHE_TYPE` are as in dev-c7). File blob `7c48b0a3...55b1d1` at haynes-ops `origin/main` `1c514a7b`.
* **Running at registration** (one Kubernetes API read, 2026-10-21T11:10:11Z, no Ollama endpoint called): pod `ollama-prime-cdc6fb897-jnkjp`, started 04:39:14Z, container `app` image `docker.io/ollama/ollama:0.40.7`, imageID `docker.io/ollama/ollama@sha256:2e6cc92ffa43b4b1a2e70e315407e00ac97ec125afc71277d73c7efe01c4f31b`, restarts 0, ready. No open haynes-ops PR changes the ollama image.
* **Pre-run check (registered; no Ollama call), before `declare-activity`:** the HelmRelease tag on haynes-ops `origin/main` is `0.40.7`; the running `app` container's image is `docker.io/ollama/ollama:0.40.7` with the imageID above and restart count 0; no open haynes-ops PR changes the ollama-prime image.
  * If the tag or the image differs, **the pass is not started** and the coordinator is told. Another runtime needs a new registration decision.
  * If such a PR is open, **the pass is not started** and the coordinator is told (Renovate merges these itself, and a merge mid-pass aborts it, as it did dev-c7's). Nothing was loaded, so a later start under this registration is not a rerun.
* **Recorded during and after the run:** `manifest.runtime_version` (the runner's `/api/version` read at preflight) must be `0.40.7`; anything else is a deviation reported in every table. The PSI/restart guard records the pod's name, uid, container id and restart count at the start and aborts the pass if any of them changes (section 5); the pod identity after the run is recorded in the process record.
* **What 0.40.7 can change, named:** numerics and so outputs (even at temperature 0 and seed 42), memory allocation and so the GPU fit (section 4), load time, and how `prompt_eval_count` is reported (section 4). No difference between this pass and dev-c6 or dev-c5 can be attributed to the runtime, or separated from it.

## 3. Model digest

* **Re-read offline from the registered metadata:** `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813`, the `model_digest` recorded by `devc4-v4g-qwen3.8-27b` (2026-10-20T05:36Z), `devc5-b-qwen3.8-27b` (2026-10-20T20:23Z), `devc6-qwen3.8-27b` (2026-10-21T00:19Z) and the partial `devc7-qwen3.8-27b` (preflight 2026-10-21T04:38Z), with installed size 17,741,872,154 bytes in every one. All four readings came from **Ollama 0.40.6**.
* **Not confirmable offline:** no `/api/tags` reading from the 0.40.7 server is recorded. The upgrade changed only the image tag (the same `/models` store), so the installed model is expected to be unchanged, but that is an expectation, not a confirmation.
* **Confirmed at runtime, registered:** `--require-digest` makes the runner compare the installed digest at preflight, after `/api/version` and `/api/tags` and **before anything is loaded**. On a mismatch it exits 3 (`model digest differs from the frozen one ... nothing was loaded`), and the pass is **SKIPPED and recorded**: no load, no case call, no pull, no rerun, and no new digest is adopted. `tests/test_devc7_qwen_r2.py` drives the registered command against a stubbed transport and shows exactly this (no `/api/generate`, no `/api/chat`, every case never-started).

## 4. Context and GPU safety (unchanged rules; what 0.40.7 leaves unverified)

The context policy, its flags, the possibly-truncated and estimate-only labels, the subset rows (a) and (b) and the registered expectation (no flag) are dev-c7 section 2, unchanged. The GPU-fit check (`full-gpu-v2`: one `/api/ps` reading after the warm-up and after every case call that reports a reload; skip at the warm-up, abort at a reload, never a retry), its stated guarantee (Amendment 2), the wall cap and the Prime rules are dev-c7 section 3, unchanged.

Two facts were recorded on 0.40.6 only:
* **GPU fit.** The dev-c7 warm-up on 0.40.6 at `num_ctx 16384` read 100% GPU (`size` = `size_vram` = 17,361,985,862 bytes, context length 16384). The offline estimate (`gpu-fit-offline.json`) uses 0.40.6 metadata and an assumed layout. Neither predicts 0.40.7's allocation: **the runtime check at the warm-up decides**, and a GPU-fit skip is recorded, never retried at a lower context.
* **`prompt_eval_count`.** dev-c7 section 2 relies on 0.40.6 reporting the FULL prompt, cached tokens included (characters per reported token about equal on first and later turns). If 0.40.7 reported fewer tokens on later turns (for example, excluding cached tokens), `reported_prompt_did_not_grow` would fire without truncation. **Registered diagnostic, added to table 7 before any result:** the median characters per reported prompt token on first turns and on later turns of this pass, next to dev-c6 qwen's (4.32 first, 4.18 and 4.12 later). It is reported as observed. No threshold is applied, the flags are computed as registered, and the subset rows are still computed and labelled as registered. If later turns read materially more characters per token than first turns, the report says the reported-count flags may be unreliable on 0.40.7.

## 5. The run (one sample; no smoke run; no rerun)

The **warm-up inference** of the Ollama adapter is a registered pre-measurement model call (`/api/generate`, prompt `Reply with OK`, the frozen options with `num_predict 256`, `keep_alive 2m`, timeout 900 s; receipt `manifest.preflight.warmup`; never scored; once, inside the wall deadline). The first model response to a CASE is the first measured response.

Registered command, run from any directory (no `cd`), with `C=/home/dev/work/mrh-qwenr2-1021/tools/media-repair-harness`, `SUITE=/home/dev/work/mrh-qwenr2-1021/.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1` and `OUT=/tmp/claude-1000/mrh-c7r2-runs`:

```
PYTHONPATH=$C/src python3 -m media_repair_harness.run --adapter ollama --model qwen3.8:27b --suite $SUITE --split dev --prompt v7 --evidence-format v3.1-format --guards v3 --evidence replay --tool-output-bytes 8192 --num-ctx 16384 --context-policy ctx16k-v1 --gpu-fit-check full-gpu-v2 --keep-alive 2m --max-wall-s 2700 --require-digest aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813 --no-spend-limit --out $OUT/devc7r2-qwen3.8-27b --scratch /tmp/claude-1000/mrh-c7r2-scratch/qwen
```

Its argv differs from the dev-c7 qwen argv only in the values of `--suite`, `--out` and `--scratch` (pinned by `tests/test_devc7_qwen_r2.py`).

**Sequence (only after the coordinator's written "measurement go"):**
1. Pre-run checks, no Ollama call: the tree is clean, `src/` is the frozen tree (section 1), and the runtime check of section 2 passes.
2. `declare-activity start "dev-c7 qwen r2" --scope ai,ollama-prime --ttl 60m`.
3. The registered command, once. Its preflight reads `/api/version`, `/api/tags` and `/api/ps`. **`/api/ps` must be empty**: any resident model this run did not load SKIPS the pass (no wait, no eviction, no retry). A digest mismatch SKIPS it (section 3). Then come the warm-up, the GPU-fit reading and the 73 cases, serially.
4. The runner unloads only what this run loaded (`keep_alive: 0`) and reads `/api/ps` once more. Then `declare-activity end <id>`.

Prime rules, unchanged: one resident model, serial, no pulls, no global setting changed, the PSI/restart guard on (a trip aborts cleanly), unload only what this run loaded, and a load failure or timeout aborts with no retry and no replay.

## 6. Retry, repair, abort; after the run; tables

**Retry, repair, abort (dev-c7 section 5 for qwen, unchanged):**
* One generic repair prompt per invalid reply, then a forced `insufficient_evidence` / `escalate`. No whole-case rerun, and no rerun of the pass.
* A failed call is recorded with its receipt and the case ends as a forced escalate.
* A busy `/api/ps`, a digest mismatch or a GPU-fit skip at the warm-up skips the pass.
* These abort it (exit 3): a load failure; a reload that is not 100% GPU; an unreadable `/api/ps`; a PSI/restart guard trip; the wall cap.
* **If anything external restarts or replaces Ollama mid-run, the pass aborts as registered and is not rerun.** The guard trips on a changed pod uid, container id or restart count. An unreadable `/api/ps` also aborts, and the in-flight call is recorded as a forced escalate (an adapter error), as in the partial dev-c7 run.
* Every planned case ends in exactly one of `records_written`, `started_aborted` (kept, unscored) and `never_started`. Each gate keeps score.py's own denominator, and G7 is over the 73 planned cases. A partial pass is labelled PARTIAL in every table.

**After the run (offline, no model call):**
1. The `src/` checks of section 1 are repeated. The `config_hash` is compared with section 1, and the manifest with `manifest-template.json`; any difference is reported as a deviation.
2. The run directory is copied unchanged into `runs/dev-c7-qwen-r2/devc7r2-qwen3.8-27b/` (a skipped or aborted run's too).
3. Restored original decisions: `PYTHONPATH=$C/src python3 -m media_repair_harness.guard_cli <run> --restore --suite $SUITE --out <run>-restored`.
4. Both views are scored with the unchanged `score.py` through `score_compat` (`python3 -m media_repair_harness.score_compat <dir> --suite $SUITE`), kept as `score.json` / `score.md` and `score-qwen3.8-27b[-restored].out`.
5. The unchanged uncalled-check counter (`experimental/contract_v3/uncalled.py`, `summarise`) runs over the records.
6. The contract-violating writes come from the records' audit v3.
7. `runs/dev-c7-qwen-r2/README.md` is written once, with the tables below. Only new files are committed.

**Tables (the dev-c7 section 7 tables for the qwen run; every number labelled dev-tuned; comparison columns dev-c6 qwen and dev-c5 qwen, guarded and restored, percentages recomputed from score.json numerators and denominators):**
* **1 Run.** As dev-c7 table 1, with these items stated:
  * the Ollama runtime version (from the manifest) and the pod image;
  * the GPU-fit outcome at the warm-up and at every detected reload;
  * the warm-up and the GPU-fit reading, reported separately from the wall time;
  * the time of the first measured response.
* **2** Gates guarded. **3** Gates restored.
* **4** Per-class counts. **5** Guard effect. **6** Validity.
* **7** Context and failures, including subsets (a) and (b) and the section 4 diagnostic.
* **8** Uncalled available checks, next to dev-c6 qwen.
* **9** Change against dev-c6 qwen and dev-c5 qwen in words, with the confounds of section 8 named beside each change.
* **10** Statements (below).
* **12** Contract-violating writes. **13** Tools-v3 use.
* No other table, cut, ranking or threshold is added after the results.

**Statements, verbatim in the report:**
* Everything here is dev-tuned. One pass on correlated, previously tuned fixtures: neither significance nor generalisation. No readiness claim.
* C7 is a combined candidate: an effect is not attributable to the prompt, the presentation, the tools, the context or the Ollama runtime alone.
* dev-c6 differs in prompt, evidence format, tools behaviour, audit typing, `num_ctx` (8192 then, 16384 now) and Ollama runtime (0.40.6 then, 0.40.7 now); dev-c5 also in decision schema and audit version (v2).
* The partial dev-c7 qwen run (5 of 73 cases, Ollama 0.40.6) stays in the record unchanged; this pass does not replace or rescore it.
* G6 measures fixture verification, not completed repairs.
* "Guards off" means restored original decisions from the same completions (not an independent run).
* Each gate keeps score.py's own denominator; G7 uses planned cases.

## 7. Comparisons

Columns: **dev-c6 qwen** (`runs/dev-c6/devc6-qwen3.8-27b`, score.json sha256 `b01b1c44...9760`, restored `d31c579a...1423`) and **dev-c5 qwen** (`runs/dev-c5/devc5-b-qwen3.8-27b`, `d47522e9...b55a`, restored `3164bca6...ecb6`); READMEs `66e00c1e...948b` and `fd47b212...700d`. Not columns: the partial dev-c7 qwen run, and the dev-c7 Haiku and Astra runs. A cross-model reading of dev-c7 names the runtime and the day as confounds.

## 8. Confounds, named (none can be separated by this design)

* **Ollama runtime 0.40.7 (new):** dev-c6, dev-c5 and the partial dev-c7 qwen run all ran on 0.40.6. The dev-c7 Haiku and Astra runs use no Ollama but were measured on another day and serving state, so a qwen-against-Haiku or qwen-against-Astra reading carries this confound too.
* `num_ctx 16384` against dev-c6's and dev-c5's 8192.
* Prompt v7 against v6 (dev-c6) and v5 (dev-c5).
* Format v3.1-format and tools behaviour v3 against v3 / v2 (dev-c6) and v2 (dev-c5).
* Audit typing (an excerpt is read as a reading, the legacy heads are withheld); dev-c5 also differs in decision schema and audit version (v2).
* Harness code (W22's dev-c7 changes, W23's measurement flags).
* The model-visible case alias (from the run id; it differs in every run).
* Day and GPU-sharing state on Prime.
* **Same:** suite, cases, case order, scorer, gates, guards v3, the page budget (8192), the tool budget, the model id and the digest (enforced at preflight).

## 9. Hold

The coordinator placed a hold: **no model call of any kind and no Ollama call of any kind** (no `/api/ps`, `/api/show`, warm-up, load or smoke) until a written "measurement go", after a pre-measurement review. Any fix after that review is a new commit recorded here as a numbered amendment, made before any model response. This file, `manifest-template.json` and `tests/test_devc7_qwen_r2.py` are committed during the hold.
`ci-test` (MRH_REQUIRE_SUITE=1, serial, nice 19) is run once at the pre-registration commit, and its count is recorded in the PR description (and in this section at the first amendment, if there is one). No model call and no Ollama call has been made.
