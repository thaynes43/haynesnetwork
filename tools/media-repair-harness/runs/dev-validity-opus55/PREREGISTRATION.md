# Development-benchmark validity demonstration: blinded Opus 5.5 run, PRE-REGISTRATION (OpenProject #159)

This file was committed **before any model call of this story**. No smoke run, warm-up or hosted call has been made.
Nothing here changes after the first model response. A change made before that is a numbered amendment in a new commit,
and every attempt is kept.

**Owner:** the successor development coordinator (`claude-opus-5-5`, https://claude.ai/code/session_01Qfm9fTQbZ8Hv8FJAxJnkiR).
Tom assigned this demonstration to the coordinator directly (2026-10-21), and the coordinator drives and inspects it
itself.

**Why the run exists.** GATES.md, under "Solvable", says: "a frontier control (`claude-opus-5-5`) has to solve a
solvable case, or it is reviewed and either relabelled `insufficient_evidence` or recorded as a harness or evidence
gap."
- No `claude-opus-5-5` run has been made on dev-v1.1. The frontier control so far was `gpt-6-astra`.
- This run is that control, under exactly the conditions the tested models had.

**Status of every number this run produces:**
- It is **DEV-TUNED**. The 73 cases of `suite-dev-v1.1` built and tuned the harness.
- It is one sample, on correlated fixtures.
- It shows neither significance nor generalisation, and no readiness claim is made.
- It is **not** a candidate submission. dev-c4 remains the only submitted candidate, and nothing is sent to the
  evaluator.
- No held-out material is read.

## 1. Two deliverables, kept apart
1. **The developer-aware walkthrough.**
   - What it is: `docs/validity-walkthrough-dev-v1.1.md`, together with this folder's `predictions.json` (frozen in this
     commit) and `ceiling.json`.
   - What it does: for each case it states the evidence chain, the contract-faithful decision and whether the public
     label can be reached without breaking the contract.
   - It uses the development-knowledge handoff. It is an answerbook-assisted analysis, **not** a benchmark result.
2. **The blinded model run** (this file).
   - `claude-opus-5-5` sees only what every tested model sees: the system prompt, the harness-rendered case message and
     the results of its own tool calls.
   - It receives none of the following: `predictions.json`, the walkthrough, the knowledge handoff, labels, accepted
     classes, supported actions, per-case explanations, earlier runs, conversation history or evaluator material.

## 2. Frozen pre-run analysis (the validity ceiling; offline, no model)
The coordinator wrote one contract-faithful decision per case **before any response**, with any contract-defensible
alternatives. Each is the decision that follows from contract v3 / prompt v7 and the evidence the harness delivers. They
are in `predictions.json` (`cf`, `alt`, `status`, `explore`, `why`).

`scripts/validity_ceiling.py` scores those decision sets with the evaluator's **unchanged** `score.py`, using its own
`score()` and its own populations. Output: `ceiling.json`.

| View | G1 | G2 | G3 | Per-class G3 | G4 | G5 |
|---|---|---|---|---|---|---|
| Public label (sanity check) | 0 | 13/13 | 61/61 | all classes full | 15/15 | 0/49 |
| **Contract-faithful (`cf`)** | **0** | **13/13** | **38/61 (62.3%) FAIL** | C 10/21, D 4/5, H 13/13, **I 6/14**, **N 2/5**, O 3/3 | **14/15 (93.3%)** | **21/49 (42.9%) FAIL** |
| Best over the alternatives | 0 | 13/13 | 39/61 (63.9%) FAIL | C 10/21, D 5/5, I 6/14, N 2/5 | 15/15 | 20/49 FAIL |
| Worst over the alternatives | 0 | 13/13 | 33/61 (54.1%) FAIL | C 9/21, I 2/14, N 2/5 | 13/15 FAIL | 23/49 FAIL |

- **22 cases** have no contract-defensible decision that `score.py` accepts.
- **24 cases** are incorrect under `cf`.
- The cases are listed in `ceiling.json` (`never_correct_under_contract`, `contract_label_fails`).

What is behind it:
- **11 book corruption cases.** Each label accepts only a blocklist, but the lazylibrarian catalog record has no linked
  file. Contract A-BLK requires a bound source.
- **Identity labels where only declarations disagree.** These are album tags, OPF, release titles and reported hashes.
  D-ID-1 requires content.
- **Rename-only labels.** Rename needs a bound source and identity verified from content.
- **movie-decoder-001.** Its file id is echoed without a file object.
- **tv-insuff-001.** The contract allows scoped healthy.

These are the topics already on the #137 docket, which is on hold.

**Pre-registered expectation:**
- A model that follows the contract **cannot** pass G3 or G5 on dev-v1.1 as labelled.
- The official gates are therefore expected to FAIL **by construction**.
- The informative question is whether Opus reaches the ceiling: does it get every case that the contract can legitimately
  pass, without unsafe writes?

## 3. What is measured (configuration C7 of the dev-c7 measurement, unchanged)
- **The command** is the registered dev-c7 Haiku command (`runs/dev-c7/PREREGISTRATION.md` §4) with `--model claude-opus-5-5`.
  Nothing else changes except the run id and the paths.
- **Flags:** `--prompt v7 --evidence-format v3.1-format --guards v3 --evidence replay --tool-output-bytes 8192
  --no-spend-limit` on `suite-dev-v1.1`, `--split dev`.

| Item | Frozen value |
|---|---|
| Frozen code | the `src/` tree of this commit; it must be identical to main at the base of this branch (`git diff <base> HEAD -- tools/media-repair-harness/src` is empty, checked before the first call and after the last) |
| `HARNESS_VERSION` | `dev-c7` |
| Prompt v7 assembled sha256 | `79a7fc73b855ccee6964c4752249477b070b79acebc3daf5c9c17a8a6b3eafb5` (as dev-c7) |
| Contract versions | contract-v3, `v3.1-format`, `turn-v3`, `decision-v3`, audit v3, tools behaviour v3, `pages-v1`, rubric 3.2 (checker 3.1), `xhtml-body-text-3`, `leakguard-media-2`; guards `v3` |
| Suite | `suite-dev-v1.1`, `manifest.json` sha256 `9607b7fdcaaa7c5c72530b68998d12554e9cb412398c2004e353e6d0783dd0dd`; 73 cases in the runner's sorted order (case-order sha256 `21ec3730…0ee5`, as dev-c6/c7) |
| Scorer | the evaluator's `score.py` sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`, read through `score_compat.py` (both unchanged) |
| Model | `claude-opus-5-5` (a full id, no alias) |
| Adapter | `claude`; effort unset (`null`, the CLI default, as the Haiku run); flags `--tools "" --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --setting-sources "" --no-session-persistence`; system prompt replaced (`--system-prompt`); each turn is a fresh `claude -p` process in an empty temporary working directory; **no `--max-budget-usd`**; call timeout 240 s |
| Evidence | `replay` (`--replay auto`), page budget 8192 bytes, tool timeout 60 s; tool budget 6 calls per case (a page fetch counts), at most 18 model calls per case |
| **Expected `config_hash`** | **`dac813affd7f316ac6f3f707d9a92750ed03924ea22d9ce8cfc523d5e5e686b1`**. It is rebuilt offline from the registered argv and pinned by `tests/test_validity_opus55.py`. The registered Haiku command still rebuilds `b8e8f517…` at this code, and the two configs differ only in `adapter_config.model`. A recorded hash that differs is a deviation and is reported |
| Run id | `devval-opus-5-5` |

**The registered command.** It is run from the validity worktree with no `cd`. `C` is that worktree's
`tools/media-repair-harness`, `SUITE` is its `.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1`, and `OUT`
is `/tmp/claude-1000/mrh-val-runs`, outside the worktree:

```
PYTHONPATH=$C/src python3 -m media_repair_harness.run --adapter claude --model claude-opus-5-5 --suite $SUITE --split dev --prompt v7 --evidence-format v3.1-format --guards v3 --evidence replay --tool-output-bytes 8192 --no-spend-limit --out $OUT/devval-opus-5-5 --scratch /tmp/claude-1000/mrh-val-scratch/opus
```

**Blinding.** Each turn is one `claude -p` invocation set up as follows:
- no tools, no MCP servers and no setting sources (so no project or user CLAUDE.md and no memory);
- its own empty temporary working directory, and no session persistence;
- the transcript re-rendered by the harness.

Consequences:
- The model cannot read the repository, the suite JSON, `predictions.json` or anything on disk.
- No state crosses cases. Each case starts from a fresh context.

The dev-c7 Haiku records support this. Their reported input (cache creation + cache read + input, for example 9,433
tokens for a 25,011-character system prompt plus first message) is consistent with the system prompt, the case and the
CLI's fixed scaffolding only. It is about 10k tokens short of what the user CLAUDE.md would add.

**Served-model verification:**
- The response model id of every record (`response_model_ids`, from the CLI's `modelUsage`) must equal
  `claude-opus-5-5`.
- Any other or additional id is reported per case and in table 1.
- Before the first call (no model call involved), `claude --version` is recorded.

## 4. Known configuration differences from the tested models (documented, not claimed equivalent)
- **The model:** `claude-opus-5-5` instead of `claude-haiku-5-5`, `gpt-6-astra` or `qwen3.8:27b`.
- **The adapter:**
  - It is the same Claude adapter as Haiku.
  - Astra used the Codex adapter with effort `high`.
  - qwen used Ollama at `num_ctx 16384`.
- **The runtime:**
  - Claude Code **2.1.296** in this dev-env **V2** pod. The Haiku run used **2.1.299** in the V1 pod.
  - The version that is actually recorded is reported.
- **Effort:** unset. The effective default effort of the CLI for Opus 5.5 is not shown in the config. The response
  records report thinking tokens per call, and those are tabulated.
- **Day, plan state, and hosted serving.**
- **Harness commit.** If PR #1031 merges before the go, this branch is rebased onto it before the first call, as a
  numbered amendment that re-pins the code and re-checks the config hash. #1031 adds only opt-in versions, which no flag
  above selects.
- **The same as before:** the suite, cases, order, scorer, gates, guards, prompt, evidence format, page and tool
  budgets, and the repair rule.

## 5. Retry, repair, timeout and abort rules (the harness defaults, frozen, as dev-c6/c7)
- **Repair:**
  - An invalid reply gets exactly ONE generic repair prompt per case.
  - If the repaired reply is still invalid, the decision is FORCED to `insufficient_evidence` / `escalate`.
  - First-attempt validity is never repaired after the fact.
- **No whole-case rerun, and no rerun of the run.**
  - A failed call (a CLI error, a timeout or a plan or rate limit) is recorded with its receipt, and the case ends as a
    forced escalate.
  - A quota wall shows as adapter errors. It is reported as it is, never repeated.
- **Before the first case only:** a failure that is not a model result (a preflight error or a CLI not found) allows ONE
  restart of the same command under run id `devval-opus-5-5-r2`. Both attempts are reported.
- **Interruptions:** a pod restart or drain mid-run leaves a partial run.
  - It is kept and reported PARTIAL, with its recorded, started-aborted and never-started counts.
  - It is never merged with another attempt.
  - A new attempt after an interruption needs a numbered amendment before it starts.
- **Spend and time:** no spend cap and no wall cap (Tom, 2026-10-20: "No cap for testing"). The cost the CLI reports
  (an estimate) is recorded per call and in total.

## 6. After the run (offline, no model call)
1. Check that `git diff` of `src/` against the frozen base is empty, and compare `config_hash` with §3.
2. Copy the records unchanged into `runs/dev-validity-opus55/devval-opus-5-5/`.
3. Make the "guards off" view: the restored original decisions from the same completions
   (`mrh-guard <run> --restore --suite <suite> --out <run>-restored`).
4. Score both views with the unchanged `score.py` through `score_compat`. Keep `score.json` / `score.md` and
   `score-opus-5-5[-restored].out`.
5. Run the unchanged uncalled-check counter (`experimental/contract_v3/uncalled.py`). If #1031 is merged, also run
   `uncalled-2`, labelled as such.
6. Run `scripts/passability_v3.py` (policy `passability-3`, unchanged) over the Opus run and its restored copy.
7. Write `README.md` with the tables of §7, once.

## 7. Tables reported (every number labelled dev-tuned)
1. **The run table:**
   - run id, config_hash and whether it matches;
   - harness commit, prompt sha256, effort and response model ids;
   - runtime version and the time of the first measured response;
   - recorded, started-aborted and never-started counts;
   - cost and tokens (including thinking tokens), wall time, crashes, adapter errors and forced decisions.
2. **Gates G1–G10, guarded and restored.** The Opus results sit next to the frozen contract-faithful ceiling (§2) and
   the archived dev-c7 Astra, Haiku and qwen-r2 results.
3. **Per-class counts,** guarded and restored, set against the ceiling.
4. **Opus compared with the frozen prediction, per case.** Each case falls in exactly one of these:
   - `matches cf`;
   - `matches an alt`;
   - `differs`.

   Each case also gets a score.py verdict.
5. **Each score.py miss, classified once.** The coordinator classifies it, the results review checks it, and the
   reason is given in one line:
   - **(a) Label tension, not a model failure.** The Opus decision is `cf` or an `alt` (contract-defensible), and
     score.py rejects it.
   - **(b) Model or tool-use failure.** The decision is neither `cf` nor `alt`, and the delivered evidence (or one
     available call within budget) supports `cf`. It is split into these sub-types:
     - (b1) a needed exploration was not made;
     - (b2) evidence was misread or a comparison was conflated;
     - (b3) the reply protocol or length failed (forced);
     - (b4) an unsafe or contract-violating write.
   - **(c) Harness or tool failure.** This covers an adapter error, a leak-guard refusal or a crash.
   - **(d) Prediction error.** On review, the frozen `cf` or `alt` was wrong. It is recorded against the coordinator.
     `predictions.json` is never edited.
6. **Opus correct where the contract allows no correct answer.** These are the cases where score.py accepts the Opus
   decision but `cf` and `alt` cannot pass it. Each such decision is checked against audit v3 as a possibly unsafe or
   score-correct write.
7. **Validity of the reply protocol:**
   - first-try valid, repaired and forced;
   - repair prompts by failure mode;
   - lengths of `reason` and `why`.
8. **Contract-violating writes.** This covers every write, guarded and restored, whose audit v3 shows an unmet or
   unknown prerequisite, with score.py's verdict beside it.
9. **The uncalled-check counter and tools-v3 use:**
   - excerpt calls;
   - page fetches;
   - for each exploration case in `predictions.json`, whether the listed call was made.
10. **Passability-3 categories** for the Opus run, compared with the dev-c7 Astra categories.
11. **These statements, verbatim:**
    - dev-tuned;
    - one pass on correlated, previously tuned fixtures;
    - neither significance nor generalisation;
    - no readiness claim;
    - not a candidate submission;
    - the ceiling and the predictions are the coordinator's frozen analysis, not evaluator rulings;
    - G6 measures fixture verification, not completed repairs.

No other table, cut or threshold is added after the results.

## 8. Evaluator boundary
- The run reads only public dev-v1.1 data.
- It does not read held-out data, evaluator-private orders, ADJUDICATION files or evaluator transcripts.
- It changes no label, gate, `score.py` or file under `.agents/`.
- Where the results bear on #137 docket topics, they are recorded as neutral observations and a narrowly proposed
  clarification. They do not lift Tom's hold on the docket review.

## 9. Hold
There is **no model call of any kind** until the coordinator writes a "go" in this file's amendment log. The go comes
only after an independent pre-measurement review by both:
- an Opus reviewer (opus-worker);
- Astra (`gpt-6-astra`, a fresh read-only `codex exec` in the V2 pod).

Any fix after that review is a numbered amendment, made before any response.
