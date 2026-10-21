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

*Superseded by Amendment 1:* the reviewed reference decisions are in `predictions-a1.json` → `ceiling-a1.json`, and the
headline is the robust 11-case bound. This table is kept as originally frozen.

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

**Blinding.** Each turn is one fresh `claude -p` process (Amendment 1 corrects the original wording):
- no tools, no MCP servers and no setting sources;
- no session persistence;
- the transcript re-rendered by the harness;
- run in **one** empty temporary working directory that the adapter allocates per run, not per turn;
- under the **scrubbed environment** of Amendment 1, item 5.

Consequences:
- The model cannot read the repository, the suite JSON, the predictions or anything on disk.
- No conversation state crosses turns or cases.
- Ordinary user and project memory is gated off by `--setting-sources ""`.
- The CLI's own startup context outside the rendered prompt is attested, not proven absent (Amendment 1, item 5).

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

## 10. Amendment 1 (committed before any model call; the original commit `4c03e789` is not rewritten, and its history is the git log)

**Why.** These are the independent pre-measurement reviews of `4c03e789`:
- **Opus:** go with amendments (M1 to M3 and the minors).
- **Astra:** `AUDIT-ASTRA-38`, no-go as frozen (blocker 1, majors 2 to 4, minors 5 and 6).

Both confirmed:
- `src/` is unchanged.
- The config hash `dac813af…` holds, differing from Haiku's only in `adapter_config.model`.
- All 73 first messages and system prompts equal Haiku's turn 0 after alias substitution.
- No harness path delivers labels, predictions or the walkthrough.
- The no-pass conclusion survives.

**Still no model call has been made.**

| # | Finding | Change |
|---|---|---|
| 1 | Astra 2 and the per-case table; Opus M2 and the per-case disputes: some reference decisions contradicted prompt v7 read literally, and some alternatives broke diagnosis rules | `predictions.json` stays unchanged (sha256 `86b4424a…7668`). The registered reference set is now **`predictions-a1.json`** (sha256 `0cfb5d74b52da6eb69abd4793feb439cd414c1c2b9adfc9f7984a8adb74ef260`). It has one rule for alternatives and a `requires` field: the calls whose delivered results an option needs. Literal-v7 references (Deciding 3 spends calls only on material items): tv-corrupt-003, tv-insuff-002, epub-identity-004 and epub-identity-005 become H/none, and movie-order-001 becomes U/escalate. Alternatives removed: audiobook-insuff-001 U, movie-insuff-001 O, movie-naming-001 N, tv-insuff-001 U, tv-insuff-002 U, movie-decoder-001 D/convert (source shape unsettled, not counted), epub-healthy-005 H, and escalate-instead-of-a-met-write (movie-corrupt-003, tv-identity-003, tv-identity-004). Alternatives added: epub-healthy-005 U, movie-identity-002 U, epub-identity-005 I or U after `epub_inspect {}`, tv-identity-002 H. epub-identity-004's recipe is corrected: `{}` returns empty default excerpts, so `{"spine":5,"offset":0,"length":1200}` is needed |
| 2 | Astra 2: "ceiling" overclaimed | `ceiling-a1.json` (sha256 `17b8ce0c9f1e02d0f65b5555110c35105cdfce4a796cf56ea56177d018627401`) gives the **reference decisions** G3 35/61 (C 9/21, I 5/14, N 2/5, O 2/3), G4 13/15 and G5 20/49, and the **best among listed options** G3 37/61, G4 13/15 and G5 19/49. 26 cases have no listed contract-consistent decision that `score.py` accepts. These are reference points, not a proven ceiling. **The headline is the robust bound:** the 11 book-corruption cases alone force G3 ≤ 50/61 and G5 ≥ 11/49, and corrupt_file < 2/3 |
| 3 | Astra 1 (blocker), Opus M3 and the minors: the attribution could credit failures | Tables 4 and 5 are replaced by the **attribution rules** below |
| 4 | Astra 4: interruptions could mislabel a started case | The call journal and categories below |
| 5 | Opus M1, Astra 5: environment and CLI context | The scrubbed environment, the attestation and the tripwire below |
| 6 | Astra 6: model check per record | The served-model check per turn below |
| 7 | Opus minor: missing dev-c7 §5 rules | A leak-guard refusal is a harness error of that case, kept in every denominator and never retried. Started-aborted and unrecorded cases are not scored, and G7 is measured over the 73 planned cases |
| 8 | Opus minors: fixtures, rebase, render check | The pre-run checks below. **No rebase onto #1031.** The `src/` tree sha1 is `36a08be3d70027533f56d41250edc940053e31df`, the dev-c7 measurement's frozen `src/`, which the Haiku run used |
| 9 | Opus nit: report kind | The movie-identity-001 basis now says `report_unknown` |
| 10 | Text corrections | §3 Blinding is corrected in place (one temp directory per run; scrubbed environment). §2's original table is kept and marked superseded. The walkthrough is regenerated from `predictions-a1.json` (version A1) |

### Attribution rules (replacing §7 tables 4 and 5)
Every case gets exactly one category. The rules are applied **separately to the guarded decision and to the restored
original decision**, and both are reported.

**Precedence (the first rule that applies decides):**
- **H, harness or tool.** An adapter error, a crash, a leak-guard refusal, or a started-but-unrecorded case. It is not
  a model result and is never credited.
- **F, forced.** The one repair failed and the decision was forced. This is a protocol failure on the model side,
  never credited, even when the forced pair equals a reference.
- **Otherwise,** the decision is evaluated:
  - **Descriptive only:** whether it matches `cf`, matches an `alt` (with its index), or matches none. A match is a
    statistic, **never** a certificate of contract compliance.
  - **Contract-consistent** means all of the following hold:
    1. every call in the matched option's `requires` was made before the decision and returned `ok`, with the needed
       content in the transcript;
    2. the record has no `bad_evidence_refs`, no `protocol_violations`, no `write_rejection` and, for a write, no
       references to failed or non-ok tools;
    3. for a write, audit v3 shows no unmet prerequisite, and the source and target agree with the bound record;
    4. the reason names the decisive observation and asserts no observation that was not delivered. The results
       reviewer checks this on every case below where credit depends on it.

**Categories once the decision has been evaluated:**
- **P, credited pass.** `score.py` accepts the decision, and it is contract-consistent.
- **P!, score-correct but contract-inconsistent.** `score.py` accepts it but it fails a check, for example a block
  without binding. It goes to table 6. It is not a credited pass.
- **A1, label tension.** The decision is contract-consistent, `score.py` rejects it, and the case is in `ceiling-a1.json`
  `never_correct_under_contract`.
- **A2, stopping tension.** The decision is contract-consistent (the literal reference), `score.py` rejects it, and a
  listed option passes only through optional calls (tv-corrupt-003, epub-identity-004).
- **B, model failure.** The decision is not contract-consistent. Sub-types:
  - **B1:** a call that a material item warrants was not made;
  - **B2:** evidence was misread, conflated or invalidly referenced;
  - **B4:** an unsafe or contract-violating write;
  - **B5:** escalate or none where the literal reference decision is a write or class whose prerequisites were met.
- **D, unresolved** (B5 and the other B sub-types take precedence when they apply). The decision matches no listed option, but it may be contract-consistent, or the reference itself
  may be wrong. **The independent results reviewer decides each D,** with a contract citation, as either a prediction
  error (counted against the coordinator) or a B. The D count appears in the headline. The predictions files are never
  edited after this amendment.

**"Opus reaches the reference"** is stated only over P, A1 and A2 cases. H, F and P! are never counted toward it.

### Interruptions (call journal)
- **The shim.** The harness reaches the CLI through `scripts/claude_call_journal.sh` (sha256
  `2edceb579b447a45eaabfa2682630fbfb6d8ad7941d9c5ec0be4619092b4636f`), installed first on `PATH` as `claude`.
  - It is a pass-through. It never reads stdin or logs arguments. Bytes, stderr and the exit status are unchanged;
    `tests/test_validity_opus55.py` checks this with a fake binary.
  - It appends the start, end and exit status of every call to `calls.log`.
  - It keeps a durable copy of each call's stdout reply in the journal directory
    `/home/dev/work/mrh-val-journal/devval-opus-5-5/`, on the persistent volume.
- **The run log.** The runner's stdout and stderr are tee'd to `run.log` in the same directory. The runner prints one
  line per completed case.
- **Categories after an interruption.** The runner is serial, in a fixed order:
  - **recorded:** the case has a record;
  - **started-unrecorded:** the journal shows calls after the previous case's completion line;
  - **never-started:** every case after that one;
  - **start-unknown:** used only if the journal itself is lost.
- **Never merged.** An interrupted attempt is kept and reported PARTIAL. Any further attempt needs a numbered amendment
  first, and attempts are never merged.

### Environment, attestation and tripwire
**The registered launch.** It runs with no `cd`, and `$J` is the journal directory:

```
env -i HOME=$HOME PATH=/home/dev/work/mrh-val-shim:/usr/local/bin:/usr/bin:/bin CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR LANG=C.UTF-8 PYTHONPATH=$C/src MRH_CLAUDE_REAL=/usr/local/bin/claude MRH_CALL_JOURNAL=$J nice -n 10 python3 -m media_repair_harness.run <the §3 arguments> 2>&1 | tee $J/run.log
```

Here `/home/dev/work/mrh-val-shim/claude` is a symlink to the shim.

**The environment.**
- The variable names passed are recorded. Values are never recorded.
- Session, messaging, agentd and effort variables are dropped (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_EFFORT`,
  `AGENTD_*`).
- Auth comes from the CLI's own config directory.
- Disclosed difference: the Haiku run inherited its V1 session environment.

**The attestation**, made before the go and without a model:
- `claude --version` through the shim, in the scrubbed environment;
- no `/etc/claude-code` managed settings;
- no `~/.claude/projects/` memory directory for any `mrh-claude-*` working directory;
- `CLAUDE_CODE_EFFORT_LEVEL` unset.

**The tripwire.** When the first call completes, total input tokens (input + cache creation + cache read) are compared
with the characters sent (system prompt plus message):
- If the tokens exceed `chars / 2.0 + 5000`, the run is stopped at once and reported PARTIAL.
  - That much extra startup context, about the size of a CLAUDE.md, would mean the blinding claim is false.
  - The Haiku runs sent 2.62–2.79 characters per token, all in.
- The run resumes only after an investigation and a numbered amendment.

### Served model, per turn
- Every **successful** completion, repairs and final answers included, must report exactly one `modelUsage` key,
  `claude-opus-5-5`.
- A missing identity is **unverified**, and an extra or different id is a **deviation**.
- Both are reported per case and in table 1. Failed calls keep their own uncertainty.

### Pre-run checks (no model; recorded before the go)
1. The `src/` tree sha1 is `36a08be3…`.
2. The config hash rebuilds as `dac813af…`.
3. `tests/test_validity_opus55.py` passes. That includes render equivalence, 73/73 first messages identical to Haiku's
   turn 0 after alias substitution.
4. The four pod-local EPUB sha256 values match KNOWLEDGE-CHECKPOINT-RECEIPT.
5. The shim sha256 matches, and the attestation above is recorded.
6. No other `claude -p` run of this story is active.

**Hold.** The hold of §9 continues. The go needs a delta re-review of this amendment by both reviewers.

## 11. Amendment 2 (committed before any model call; earlier text stays as committed, and its history is the git log)

**Why.**
- The Opus delta re-review of `b88e4329` returned go-with-amendments: must-fix items 1–3, and minor items 4–9.
- Astra's delta re-review of Amendment 1 (attempt 1) failed at 13:27Z with `Selected model is at capacity`, before it
  gave any verdict. That is a provider failure, not a review result. Its log is kept as
  `AUDIT-ASTRA-39-attempt1-capacity-failed.log`.
- Astra re-reviews Amendments 1 and 2 together before the go.
- **Still no model call has been made.**

| # | Finding | Change |
|---|---|---|
| 1 | Opus 1: contract-consistent matches of a rule-(i) alternative that score.py rejects, where the reference passes, had no category. tv-identity-004's U alternative broke rule (ii) | New category **A3, reading tension.** The decision is contract-consistent and matches a rule-(i) alternative, score.py rejects it, and the reference decision passes. It is not a credited pass and not a model failure. It is listed per case. **`predictions-a2.json`** (sha256 `dce1bfd962cde8622722dd35b2d30450b86271f87bc5748b0da9f67e53b967d5`) drops tv-identity-004's alternative. `predictions-a1.json` and `predictions.json` stay unchanged. **`ceiling-a2.json`** (sha256 `b7c4057cd260175921821cccaf15c3ecf0f448b88591df3730ee1b130f44cbdf`): reference decisions G3 35/61, G4 13/15, G5 20/49; best among listed options G3 37/61, G5 19/49; 26 unreachable cases (24 in the G3 population, plus tv-insuff-001/002 in G4) |
| 2 | Opus 2: F covered only a failed repair | **F = the record's `forced` is true and the case is not H.** That covers a failed repair, the 18-model-call limit, a call past the 6-call budget, and any other forced path |
| 3 | Opus 3: the shim was not transparent on a timeout kill | The shim now **`exec`s the real CLI** (sha256 `8b54299d0005b981ce4cf4578f22511712b6af3f7ed392cdcfde856f3c414b59`), so the killed process is the CLI. Its stdout is copied through a process-substituted `tee`, and the journal logs `start` and `stdout-closed`. The exit status is the CLI's own. `tests/test_validity_opus55.py` adds a timeout test: the killed slow fake never finishes |
| 4 | Opus 4: the guarded view can credit a guard-made pair | **"Opus reaches the reference" is stated on the restored view.** In the guarded view, a decision that a guard changed is category **G, guard-made**, and is never credited |
| 5 | Opus 5 | Contract-consistency condition 3 now reads: for a write, audit v3 shows **no unmet or unknown** prerequisite |
| 6 | Opus 6: `requires` was too narrow or too vague | `requires` now names the **content** that must be delivered before the decision, plus one witness call sequence. Condition 1 now reads: the named content was delivered in the transcript before the decision, by **any** call that delivers it |
| 7 | Opus 7: the walkthrough §1 | Corrected in version A2. The 26 cases are 24 in G3 plus 2 in G4. Astra's dev-c7 movie-order-001 O/escalate is a contract inconsistency under the reference, which explains 36 against 35 |
| 8 | Opus 8: pre-run checks | **Check 1:** the src fingerprint is computed as `git ls-tree -r <commit> tools/media-repair-harness/src \| sha1sum` = `36a08be3…` (git tree id `f5cf693e`). **Check 3:** run with `MRH_VALIDITY_REQUIRE_ALL=1`, which makes the render-equivalence test require **73/73** in this pod. **Environment names:** recorded as `env -i <the registered variables> python3 -c 'import os,json; print(json.dumps(sorted(os.environ)))' > $J/env-names.json` |
| 9 | Opus 9 | movie-decoder-001's exclusion of D/convert is recorded as an explicit **exception to rule (i)** (source shape unsettled; conservative) |

**Summary of the final category set.** The precedence is **H > F > G** (guarded view only), then the evaluated
categories **P, P!, A1, A2, A3, B (B1, B2, B4, B5) and D**. The registered reference set is `predictions-a2.json` with
`ceiling-a2.json`.

## 12. Amendment 3 (committed before any model call; earlier text stays as committed, and its history is the git log)

**Why.** These reviews cover Amendments 1 and 2 together:
- **Astra** `AUDIT-ASTRA-39` (attempt 2) at `08161978`: no-go.
  - Blocker 1: credit for stopping before a material read; references not tested against later counterevidence.
  - Major 2: the consistency rules rejected valid reference writes.
  - Major 3: journal gaps, and records on node-local `/tmp`.
  - Minors 4 and 5.
- **Opus:** go on Amendment 2.

Astra reproduced the arithmetic, the robust bound, the hashes and 73/73 render equivalence. **Still no model call has
been made.**

| # | Finding | Change |
|---|---|---|
| 1 | Astra 1: alternatives that stop before a material read | **`predictions-a3.json`** (sha256 `0d01d7efd1771dc293728521cf6c650f04667519330a426b41f19b1a3259a09a`) removes the U/escalate alternatives of epub-identity-003 and epub-naming-001. Each alternative now carries `alt_kind`: **i** is another reading of a contract clause, and **ii** is the decision after a call on a *non-material* item. An **ii** is a sensitivity view: its trajectory deviates from literal Deciding 3. The new `defeated_by` field names the delivered evidence that makes an initially admissible reference inadmissible. `ceiling-a3.json` is byte-identical to `ceiling-a2.json` (sha256 `b7c4057c…`; reference G3 35/61, G4 13/15, G5 20/49; 26 unreachable). The files a2, a1 and the original stay unchanged |
| 2 | Astra 1 and 2: attribution | The **attribution procedure** below **supersedes** the consistency conditions and the category list of §10 and §11. The categories H, F and G keep their precedence |
| 3 | Astra 2: references to non-ok results; checker-unknown judgements | A reference to a non-ok result is allowed when it is an error result carrying a located `known_defect` whose cause is not `tool` (prompt v7 Deciding 5, A-BLK-3). An `unknown` audit prerequisite is credited **only** when the case's frozen `hand_judgement` names it and the independent results reviewer confirms that judgement on the actual transcript. **This applies to movie-identity-002 only:** D-ID-1 and A-BLK-4, the title card PAPER KINGDOM. Otherwise the case is D |
| 4 | Astra 3: journal | The shim (sha256 `7665358141a634e7cb15432b944336ac922e06afacdf763fdc3521399ee4ce7b`) **refuses to start the CLI (exit 97)** when the journal directory, the start record or the reply copy cannot be written. It tags the preflight `--version` call `kind=version`. Every run record now goes to the **persistent volume**: `--out /home/dev/work/mrh-val-runs/devval-opus-5-5`. `--out` is not part of the config, so the config hash is unchanged. The interruption categories are widened below |
| 5 | Astra 4: trajectory and decision | Walkthrough §5 and this procedure treat rule-(ii) paths as sensitivity views that deviate from literal Deciding 3, never as plain compliance. Comparisons with the archived Astra run are decision-pair disagreements, not instruction audits |
| 6 | Astra 5: precision | epub-identity-003's witness is now `epub_inspect {}` → `epub_inspect {"spine":5,"offset":0,"length":1200}`. Walkthrough §1 now lists O 2/3 as meeting the threshold |

### Attribution procedure (authoritative; applied to each case, in both the restored and the guarded view)
**Step 0 (precedence).** Assign the first category that applies:
- **H:** an adapter error, crash, leak-guard refusal, or a started-but-unrecorded case;
- **F:** the record is `forced` and the case is not H;
- **G:** a decision that a guard changed (guarded view only).

None of these is credited.

**Step 1 (prefix).** The *prefix* is everything delivered before the final decision: the first message, every tool
result and every fetched page.

**Step 2 (admissible options).** A listed option (`cf` or `alt`) is admissible at the prefix when **both** hold:
1. the content its `requires` names was delivered in the prefix, by any call;
2. no delivered evidence matches one of its `defeated_by` entries.

These defeaters are mechanical, and always apply to `healthy` and `none`:
- a delivered `known_defect` finding;
- a delivered collector veto.

A content defeater is judged by the results reviewer. A disputed content defeater makes the case D.

**Step 3 (match).** Compare the decision with the admissible options.
- **(a) It matches an admissible option.** The decision is *consistent* when all of these hold:
  - no `bad_evidence_refs`, `protocol_violations` or `write_rejection`;
  - references to non-ok results only under the A-BLK-3 exception (item 3 above);
  - for a write:
    - audit v3 shows no `unmet` prerequisite;
    - every `unknown` prerequisite is covered by a confirmed `hand_judgement`;
    - the source and target agree with the bound record;
  - the reasoning asserts nothing that was not delivered (checked by the reviewer).

  Then classify:
  - **P:** consistent, and `score.py` accepts it. It is flagged **T** when the matched option is a rule-(ii)
    alternative (a trajectory deviation).
  - **A1:** consistent, rejected, and the case is unreachable (`never_correct_under_contract`).
  - **A2:** consistent, rejected, the matched option is the reference, and a listed option passes only through a
    rule-(ii) call.
  - **A3:** consistent, rejected, a rule-(i) alternative, and the reference passes.
  - **P!:** not consistent, but `score.py` accepts it (table 6).
  - **B4:** not consistent, and it is a write with an unmet prerequisite.
  - **B2:** not consistent in any other way.
- **(b) It matches no admissible option.**
  - **B4:** a write whose audit shows an unmet prerequisite.
  - **B5:** escalate or none, where the reference decision was admissible at this prefix and is a write or another
    class.
  - **D:** anything else. That includes stopping before a material read: the results reviewer records B1, B2 or a
    prediction error, with a contract citation. D is **never credited**.

**Reported claims (restored view):**
- **"Reaches the reference":** the count of P, A1, A2 and A3. It is reported twice, with and without P/T.
- **Separately reported:** the counts of H, F, P!, B and D.
- **The guarded view** is reported alongside, with G.

### Interruption categories (replacing those of §10)
- **recorded:** the case has a record in the persistent `--out`.
- **started-unrecorded:** `kind=call` journal entries follow the previous case's completion line in `run.log`.
- **never-started:** every case after a started-unrecorded case, when `run.log` and the journal both end there
  without a gap.
- **start-unknown:** the state of a case cannot be told apart. That includes a missing or partial `run.log`, a shim
  refusal (exit 97), and a journal start with no matching `stdout-closed` while later activity exists.

A started-unrecorded case's transcript may be incomplete. Its durable reply copies are reported as they are, never as a
record.

**Registered command (updated).** Only `--out` changes:
`--out /home/dev/work/mrh-val-runs/devval-opus-5-5`. Everything else is as in §3 and §10.

## 13. Amendment 4 (committed before any model call; earlier text stays as committed, and its history is the git log)

**Why.**
- **Opus delta review of `002fca2d`:** go-with-amendments.
  - Must-fix: P! and B4 overlap; the routing of an unconfirmed `hand_judgement` was contradictory.
  - Minors: report A3 separately; `manifest-template.json` still had the old `--out`.
- **Astra `AUDIT-ASTRA-41`:** no-go.
  - Blocker: a reference match was credited without a material check (epub-insuff-001).
  - Major: overlapping categories and contradictory routing.
  - Major: T missed trajectory deviations that land in A1.
  - Minor: walkthrough wording.

Both reproduced the hashes, the arithmetic, the robust bound and 73/73 render equivalence. **Still no model call has
been made.**

| # | Finding | Change |
|---|---|---|
| 1 | Astra 1: credit without a material check | **`predictions-a4.json`** (sha256 `543aa7565249895f0e0549a0fd1e0306e18df255fbd3d5fee30587609ec7ae8e`) adds **`warranted`**: the checks called for by items material at the initial prefix, frozen by one rule. **W1:** an integrity tool when M1 is open (epub-insuff-001 only; every other open-M1 case already shows damage). **W2:** a content tool when identity is contested and an offered tool can deliver content. **W3:** `arr_lookup` when a write class is established, a managing app is set and no shown record binds the source, as prompt v7 directs. 20 cases carry entries. Checks that cannot settle an item are excluded and named in `_about`. `ceiling-a4.json` is byte-identical to a3 (`b7c4057c…`). a3, a2, a1 and the original stay unchanged |
| 2 | Astra 2, Opus 1 and 2: overlap and contradiction | The **final procedure** below states one strict precedence, with `unmet` and `unknown` read from `prerequisites[].state` |
| 3 | Astra 3: T | T is computed **from the trajectory**, independently of the category: any `kind=call` that is neither a `warranted` check, nor its follow-up (the next excerpt or page of the same read), nor a page fetch of such a result. Claims are reported with and without **all** T cases |
| 4 | Opus 3 | Claims are also reported with and without A3 |
| 5 | Opus 4 | `manifest-template.json` now shows `--out /home/dev/work/mrh-val-runs/devval-opus-5-5`. The config hash is unaffected |
| 6 | Astra 4 | Walkthrough version A4 aligns its wording. Stopping at the literal reference is a stopping-policy tension: A2 when a listed option passes through an optional call, A1 when the case is unreachable. Exploring anyway is T. tv-corrupt-003's basis is rewritten in a4 |
| 7 | Both | **The independent results reviewer is the arbiter.** The coordinator proposes a category for every case and the reviewer (Astra, or an independent Opus reviewer if Astra is unavailable) assigns it. Both are reported, and any disagreement is D |

### Final attribution procedure (supersedes §12's Step 3; Steps 0 to 2 and the interruption categories stay)
Apply the first rule that holds, in this order, to each case, in the restored and the guarded views.

| Order | Rule | Category |
|---|---|---|
| 1 | Adapter error, crash, leak-guard refusal, or started but unrecorded | **H** |
| 2 | `forced` | **F** |
| 3 | A guard changed the decision (guarded view) | **G** |
| 4 | A `warranted` check was not attempted (no call to that tool for that purpose, failed attempts included) and calls remained | **D** (the reviewer notes B1 or why not) |
| 5 | No listed option is admissible at the prefix (Step 2), or the decision matches none | **B4** for a write with any `state == "unmet"` prerequisite; **B5** for escalate or none where the reference was admissible and is a write or another class; **D** otherwise |
| 6 | It matches an admissible option, but a judgement is unresolved: an `unknown` prerequisite without a reviewer-confirmed `hand_judgement`, a disputed content defeater, or a disputed reasoning claim | **D** |
| 7 | `score.py` accepts it and any consistency check fails (Step 3(a) checks) | **P!** |
| 8 | Any prerequisite with `state == "unmet"` on a write | **B4** |
| 9 | Any other consistency check fails | **B2** |
| 10 | Consistent and `score.py` accepts | **P** |
| 11 | Consistent, `score.py` rejects, and the case is unreachable | **A1** |
| 12 | Consistent, `score.py` rejects, and a listed option passes only through a rule-(ii) call | **A2** |
| 13 | Consistent, `score.py` rejects, a rule-(i) alternative, and the reference passes | **A3** |

**T** is a separate flag on any case, set by the trajectory rule of item 3.

**Reported claims (restored view; the guarded view alongside, with G):**
- "Reaches the reference" = P + A1 + A2 + A3. It is reported four ways: as is, without T, without A3, and without both.
- **Also reported:** the counts of H, F, D, P!, B2, B4 and B5; the coordinator's proposed category beside the
  reviewer's for every case; and the T cases.

## 14. Amendment 5 (committed before any model call; earlier text stays as committed, and its history is the git log)

**Why.** The delta reviews of `6f837bd8` were:
- **Opus:** go-with-amendments. Must-fix: the `warranted` list did not apply its own rule consistently. Minor: add a
  catch-all row.
- **Astra `AUDIT-ASTRA-42`:** **go-with-amendments**, and explicitly "no remaining blocker to collecting the official
  `score.py` measurement with independent attribution and D as the default". The majors:
  1. A budget exhausted by unrelated calls could bypass the diligence check.
  2. The `warranted` list was inconsistent: W3 was missing on two audiobook rename cases, W3 was conditional on three
     EPUB cases, and epub-healthy-005 had mixed readings.

Both confirmed:
- the 13-row table is ordered and non-overlapping;
- every one of the 81 frozen reference and alternative pairs is covered;
- the six earlier probes resolve as intended;
- the hashes, the arithmetic and 73/73 render equivalence hold.

This amendment applies exactly the fixes both verdicts asked for. **Still no model call has been made.**

| # | Finding | Change |
|---|---|---|
| 1 | Astra 1 | Row 4 now reads: **a `warranted` check was never attempted in the trajectory → D**, whatever budget remains at the decision. Calls spent elsewhere do not excuse it. A failed attempt counts as an attempt |
| 2 | Astra 2, Opus must-fix | **`predictions-a5.json`** (sha256 `eb0890f968fc4865cfb709a6619e6714c37996ac08517bc9291441379496b6ae`) applies one rule (its `_about`). A check is warranted at the **initial** prefix when it inspects a material item **and** its result could change the class or the action, given the other prerequisites. **W1:** integrity, when M1 is open. **W2:** content, when the shown declarations contest identity and an offered tool can deliver content not already delivered. **W3:** `arr_lookup`, when a write class is established initially, the item is unbound and **no lookup result is already shown**. Checks that become warranted only after another read are not initial obligations. Result: 7 cases (epub-insuff-001 W1; epub-insuff-002, epub-identity-003, epub-naming-001 and tv-identity-004 W2; movie-decoder-001 and tv-identity-002 W3). The book cases, the two audiobook rename cases and epub-healthy-005 carry none, because each already shows its LazyLibrarian lookup result. `ceiling-a5.json` gives the same views as a3 and a4. a4 and every earlier file stay unchanged |
| 3 | Opus minor | A final row is added to the §13 table: **14, anything else → D** |
| 4 | Process | The go is given on these exact fixes. **Astra, the independent results reviewer, arbitrates every category after the run.** Any residual disagreement about an obligation or a judgement is D, never credit |

## 15. GO

**2026-10-21T14:14:48Z: GO.** Written by the coordinator after the following:
- **Opus:** go on Amendment 5.
- **Astra:** `AUDIT-ASTRA-42`, go-with-amendments, with no remaining blocker to the measurement. Its fixes are applied
  exactly in Amendment 5.
- **Pre-run checks 1–6 at `42291dcc`** all pass. They are recorded in the journal as `prerun-checks-a5.md`.

**The run.** One attempt, run id `devval-opus-5-5`, using:
- the registered §3 command, with `--out /home/dev/work/mrh-val-runs/devval-opus-5-5`;
- the §10 environment and shim launch;
- the tripwire watcher.

**No model call was made before this commit.** The results reviewer applies the §13 table as amended in §14. The
reviewer reads row 4 as "a warranted check never attempted → D, whatever budget remains".
