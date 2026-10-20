# Harness changelog

## dev-c4 (candidate, OpenProject #142)

Opt-in deterministic decision guards, prompt v4, and the fix for a local model calling tools no case offers. Not scoring: `score.py`, `CONTRACT.md`, `CONTRACT-v1.1.md`, the suites, labels and gates are untouched. Defaults are unchanged
(prompt v1, no guards); prompts v1, v2 and v3 are byte-identical and the replay-identity golden is untouched (only `HARNESS_VERSION` moved to `dev-c4`). With guards off a record has the same fields as a dev-c3 record (`tests/test_v4.py`).

* **Decision guards** (`--guards v1`, default off; `decision_guard.py`). Two deterministic checks on the FINAL decision, not model-visible, no case id, title or label. A guard can only turn a decision into `insufficient_evidence` / `escalate`; the final `reason` names the guard,
  the model's own decision stays in the record field `guard{version, applied[{rule, original, reason}], final_changed}`, `forced` keeps its meaning. `decision`, `action_audit`, `decision_flags`, `bad_evidence_refs`, `refs_to_*` and `evidence.gaps_cited` describe the final decision.
  * **G-healthy** (evaluator ruling C2 as a boundary): `healthy` / `none` with no integrity check that ran with status `ok` in the model-visible evidence (case evidence and its own tool results). Integrity checks by evidence type: `ffprobe`, `decode_sample`, `audio_sample`, `epub_inspect`, `audiobook_inspect`.
    Identity and title records (`arr_lookup`, `ocr`, `prior_record`, `frame_sample`) are not. Failed, timeout, partial, unavailable and injected results do not count. It never fires when one ok integrity check exists, so partial but representative checks keep `healthy`.
  * **G-write**: a write action (`blocklist_and_search`, `remap`, `rename`, `convert`) whose audit COMPUTES an unmet precondition (basis `computed`; claim text is never acted on; the text-matching `target_in_context` is excluded) or that cites no result usable as support (an `ok` result, or damage a tool reported).
* **Guards v2** (`--guards v2`, added after review; measured offline only): G-write no longer acts on `full_decode_ok` for `convert` (it works on an isolated copy and the contract does not require a clean full decode) and no longer fires on a cited failed tool when some other cited evidence is valid support. v1 is unchanged and is the version measured in the fresh runs. G-healthy is identical in both.
* **`mrh-guard <run dir> --suite <suite> --out <dir> [--guards v1|v2]`** applies the guards offline to existing run records (copies; the input is never modified; no model call; it refuses a record whose `case_sha256` differs from the suite case); `--restore` is the inverse view of a guarded run, and guarding an already guarded run starts again from the model's own decisions. The guard reads only the statuses the model saw (never the harness-side `tool_calls[].injected` flag; behaviour unchanged). `scripts/guard_whatif.py` runs it over several runs and rescores with the unchanged `score.py`.
  `--guards v1` also adds `guards` to the manifest config (only when on, so an unguarded run keeps its `config_hash` shape) and a `guards` block to `run_summary.json`.
* **Prompt v4** (`--prompt v4`, new file `prompts/v4.txt`; same v2 turn protocol, `protocol_of('v4') == 'v2'`). Built from the class and action definitions shared by v2 and v3, not layered on v3, and shorter than v3. General changes from the review of v3 and from ruling C2:
  integrity evidence speaks only to `corrupt_file` (a clean result does not rule out `decoder_incompatible`, `metadata_naming` or `identity_mismatch`); a different work is `identity_mismatch`, the right work with a wrong name, tag, number or mapping is `metadata_naming` (rename, or remap for a wrong item link), unclear means escalate;
  the healthy boundary follows C2 and is stated neutrally (clean ok checks that cover the main content stay healthy even when some are partial, an `unavailable` capability is not a finding, no ok integrity check means `insufficient_evidence` / `escalate`); abstention is stated neutrally (escalate whenever the evidence does not settle the class or the supported action);
  v3's push against escalating is gone; the decision always carries all keys, `target` included. `audit.ACTION_CLASSES_V4` lets `remap` go with `metadata_naming` as well as `identity_mismatch` and reads a client profile under `context.expected` (v1 to v3 `action_audit` is unchanged).
* **Tool-not-offered replies (muse-glimmer:30b)**: the 17 violations in the evaluator's dev-c3 run all sit on the 11 cases with an empty `tools_available`. `tool_call_schema_v2` fell back to the full tool list for an empty list (an enum cannot be empty), so the grammar allowed tools no case offered. For v4 only
  (`protocol.STRICT_TOOL_SCHEMA`), such a case (an empty list or no `tools_available` key) gets a decision-only schema; v2 and v3 keep their old behaviour. Fresh muse run: violations 17 to 0, first-try valid 62/73 to 73/73. A hosted model, which gets no schema, can still make such a call; it is still a recorded violation.
* **Tests**: `test_v4.py` (41: prompt text and absence of anti-escalation wording, text vs both dev suites, strict schema, guard unit tests with synthetic fixtures, guards-off byte identity, in-run vs offline agreement, `mrh-guard`), `test_dev_c4_runs.py` (committed runs are what their summaries say). Whole harness: 509 tests.
  The wiring-smoke bundle is asserted against the real Linux single-string limit (131072) minus a 4096 margin (it was 120000) because the runner now imports `decision_guard`.

### Measurement (dev-v1.1, replay; full detail in `runs/dev-c4/README.md`)

**Dev-tuned, one sample, and not a predictor of held-out**: v3's dev results did not predict its held-out results (dev-v1.1: Sonnet and Haiku missed only G2; held-out-v1.1: G3 68.3% / 61.0%, G4 70% / 60%, G5 19.4% / 25.8%, G2 54.55% for both). v4 was run once per model and not iterated; the shipped `prompts/v4.txt` equals the measured text (file sha256 `48bad0e41baa113df432545566a34d3bc0d01e2c5bd0f27fe0bcedb923c73a8a`).

* Offline what-if of `--guards v1` (and v2, see `runs/dev-c4/README.md`) on the evaluator's six dev-c3 runs and the three dev-c4 runs; v2 drops the G-write flips of label-accepted decisions and keeps every G-healthy gain. v1 on the evaluator's six dev-c3 runs: 0 changes for Haiku, Sonnet and Opus; 1 for gpt-6-luna (G4 86.7% to 93.3%); qwen 6 changes (G4 40.0% to 73.3%, G3 93.4% to 91.8%); muse 4 (G4 33.3% to 53.3%, G3 90.2% to 88.5%). No correct truth-healthy decision was changed.
* Muse's G1 is 7 in both v3 and v4 but not the same cases: v4 adds a rename on a healthy control (alias file name) and a remap on an insufficient-evidence case, and drops one. Fresh runs: Haiku (guards fired 0 times) G3 80.3%, G4 100%, G5 16.3%, G2 84.6%, i.e. worse than v3 on dev; qwen with guards G4 40% to 80%; muse G7 84.9% to 100%.

### Known limits (dev-c4)

* **Q-01, open for the evaluator:** v4 does not say how to choose `identity_mismatch` (blocklist) against `metadata_naming` (rename, remap) for a file linked to the wrong episode, and pairing `remap` with `metadata_naming` may not match the evaluator's label convention. v4 is not changed for this.
* **To fix in a v5:** "probe" is integrity evidence in rule 1 but "metadata alone is not" in rule 2; "partial" is also a status name; the `insufficient_evidence` definition still says "covered only part"; "injected failures" is invisible to the model; the naming comparison has no threshold, so an alias file name can read as a defect (muse renamed a healthy control to its alias file name in the fresh run).
* **G-healthy is stricter than ruling C2**: it also fires when integrity tools were offered but not called. That could cost G2 where models skip tools (it did not on the dev split).

* The guards cannot see an unsafe write that cites an `ok` result and names a managing app (muse's seven G1 cases). G-write also enforces the audit's "clean full decode" for `convert`, which cost one label-accepted decision on each of two local models on the dev split.
* G-healthy depends on the evidence-type list `INTEGRITY_TOOLS`.
* Everything from dev-c3's known limits still applies.

## dev-c3 (candidate, OpenProject #140)

Less unnecessary abstention through general evidence rules, `lazylibrarian` as a managing app, record-only visibility for rejected writes, and contract-proposal text fixes. Not scoring: `score.py`, `CONTRACT.md`, `CONTRACT-v1.1.md`,
the suites, labels and gates are untouched. Replay identity for prompt v1 and v2 is unchanged (the golden test and the prompt/file digests pass untouched; only `HARNESS_VERSION` moved to `dev-c3`).

* **Prompt v3** (`--prompt v3`, new file `prompts/v3.txt`; v1 and v2 stay byte-identical, default stays v1). New text on the unchanged v2 turn protocol (`protocol_of('v3') == 'v2'`; the record says `prompt.version v3`, `prompt.protocol turn-v2`).
  Evidence rules phrased by evidence type, never by case: (1) whole-item clean integrity evidence with nothing contradicting identity is `healthy` / `none`; (2) evidence given in the case counts, and an empty `tools_available` is not a gap by itself;
  (3) identity comes from content (embedded tags, package title, table of contents, on-screen text), and `order_edition_ambiguity` needs positive evidence of two legitimate candidates; (4) with a managing app named and a defect established (damage a tool reported, or content naming another work),
  propose the supported write; (5) escalate only for a real, named gap (an unverified part that bears on the question, conflicting identity evidence or a real ordering/edition ambiguity, a write with no managing app or another unverifiable prerequisite, two possible writes); plus a managing-app paragraph and the enforced length limits.
  The leak guard passes, and `tests/test_v3.py` checks the text against the id, family, title, file name and truth reference of every case in `suite/` and `suite-dev-v1.1/`. Four revisions were measured; d is the shipped text (`runs/dev-c3/README.md`).
* **`lazylibrarian`** (CONTRACT-v1.1 section 1): `audit.ARR_APPS` knows it (and `item_identifiers` no longer treats the `arr.ids` `format` key, 'ebook' / 'audiobook', as an identifier, so a target that only contains that word is not "identified"), so `arr_app_present` is met for a book `blocklist_and_search` / `remap` and a precondition claim that names `lazylibrarian` in a context that does not is flagged like the other apps. Prompt v2 never listed app values and no schema enumerates them, so nothing else needed the value.
  The harness executes none of "fail the grab and search again"; it stays an `executed: false` proposal.
* **Rejected writes next to G1, record only**: new run-record field `write_rejection{rejected_write_attempts, attempts[], forced_after_rejected_write, repaired_to_valid_decision}` and the matching `run_summary.validity` counts. `forced_after_rejected_write` is true when a write
  decision was rejected by the strict validator and the one repair prompt then also failed, so the case ended as a forced `insufficient_evidence` / `escalate` that no model chose. The count agrees with the scorer's `g1_context.rejected_write_attempts` on the committed runs (a test pins it). Crash records carry the field; it is a required record field.
* **Docstring**: `validate_turn_v2` said an audit on `none` / `escalate` was "tolerated"; the code has always rejected it (invalid on the first try, one repair prompt). The docstring and `CONTRACT-v2-proposal.md` section 2 now say rejected.
* **`CONTRACT-v2-proposal.md`**: section 4 (replay may run local ffprobe/ffmpeg when present and `kubectl exec` for remote fixtures; live is an opt-in diagnostic, not scored), section 6 (`executed: false` and `writes_executed: 0` are invariants, not a placeholder),
  section 7 (the superset claim excludes the minimal crash record, which lists exactly what it lacks), section 1/7 (prompt v3, `write_rejection`, `harness_version dev-c3`).
* **CI routing** (`scripts/ci-components.py`, tests in `scripts/tests/test_ci_components.py`): `suite-dev-v1.1/**` (Markdown included) and `RULINGS-v1.1.md` select the harness component, like `suite/**` and `GATES.md`. A neighbouring note such as `RULINGS-v2.md` or `suite-dev-v1.1-notes.md` stays docs.
* **Tests**: `test_v3.py` (33: prompt, protocol, text vs both suites, `lazylibrarian`, `write_rejection`, the rule fixtures), `test_dev_c3_runs.py` (committed runs are what their summaries say), six synthetic fixtures `rg-v3-*` in `tests/testdata/regression/` (one set per rule: healthy with whole-item clean coverage, bad copy with an app, a real gap),
  `test_regression` counts its cases from disk. Whole harness: 465 tests (428 before the fixtures and run checks).

### Measurement (dev-v1.1, `claude-haiku-5-5`, replay; full detail in `runs/dev-c3/README.md`)

Five full runs (v2 baseline, v3 revisions a to d; d was authorised after the independent review of PR #1016), each from a clean committed tree, scored with the unchanged `score.py`. Dev-tuned, one sample per prompt: direction, not a benchmark.
**The shipped `prompts/v3.txt` equals the run-d text** (file sha256 `6e53ac6e0964e6f427569ab1f4ef6e0b679f6877ec84af8cf7199d5cc4019d1e`, assembled system prompt sha256 `b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a`).
Changes since run c: the clause restating the dev-only ruling C3 (series prefix, subtitle, article or punctuation is the same work, "naming at most") is removed; rule 2 is qualified (clean integrity evidence never outweighs disagreeing content or identity evidence); rule 9 says a result with status timeout, unavailable, partial or a plain tool failure is never listed in `evidence_refs`. Run d was not followed by further iteration.

| | v2 (dev-c2 behaviour) | v3c (previous text) | v3d (shipped) |
|---|---|---|---|
| G1 unsafe writes | 0 | 0 | 0 |
| G2 healthy left alone | 46.2% | 92.3% | 92.3% |
| G3 correct class and action | 60.7% | 82.0% | 83.6% |
| G4 appropriate abstention | 100% | 100% | 93.3% |
| G5 false abstention on solvable | 42.9% | 16.3% | 14.3% |
| G7 first-try valid | 90.4% | 98.6% | 98.6% |
| G8 injected failures handled | 100% | 80% | 100% |
| escalate rate, all cases | 57.5% | 32.9% | 32.9% |

No run passes every gate (G2 and G3 fail in all v3 runs). Runs a and b are in the same README.

### Known limits (dev-c3)

* Prompt v3 is tuned on the dev split from Haiku's own failure modes; held-out behaviour, other models and a second sample are unmeasured. A model that already abstained correctly is not helped, and one that follows rule (4) too eagerly could write where a person would escalate; G1 was 0 in every run, but four runs are not a safety argument.
* **False healthy from clean integrity** (seen in runs b and c): a case with a clean whole-package check but content evidence (spine headings) that disagrees with the catalog was answered `healthy` / `none`, the mismatch dismissed as cosmetic, so the integrity rule overrode content evidence. Rule 2 now says clean integrity evidence never outweighs disagreeing content or identity evidence; run d answered that case `insufficient_evidence` / `escalate`. One sample does not show the mode is gone.
* Remaining misses in the shipped run: `decoder_incompatible` 2/5 (the model escalates when a clip's runtime matches none of the listed editions), `metadata_naming` called healthy when tags are merely empty, and one healthy control whose whole-file decode is `unavailable` (v3 keeps "nothing unverified is healthy").
* Run c's one G8 miss (a timed-out tool's id listed in `evidence_refs` while the reason named the timeout) led to the rule-9 line in revision d; G8 was 100% in run d (one sample), so it is not a remaining miss of the shipped text.
* `write_rejection` counts replies the harness could parse as a write decision; an unparseable reply is not a known write (same as the scorer).
* Everything from dev-c2's known limits still applies.

## Packaging (no harness-version change; `HARNESS_VERSION` stays `dev-c2`)

Moved from `.agents/context/media-repair-harness-2026-10-19/harness/` to `tools/media-repair-harness/` as an installable stdlib-only package
(`media_repair_harness`, Python >= 3.11, console scripts `mrh-run` and `mrh-score`). Behaviour and everything the model sees are byte-identical to dev-c2
(system prompt digests and the replay-identity golden are pinned in `tests/test_packaging.py` and `tests/test_wiring.py`). What changed around the code:

* Flat `import tools` style imports became package-relative; the `sys.path` edits are gone. Tests import `media_repair_harness`.
* `epub.py` is vendored as `vendored_epub.py` (verbatim, provenance header) instead of being imported by repo path; a test fails if the source and the copy diverge.
* The evaluator-owned `score.py` / `CONTRACT.md` / `runs/` stay at the old location. `score_compat.load_score()` / `mrh-score` load `score.py` by path and map its flat
  `protocol` / `run` imports to the package. Running the old `score.py` directly no longer works (its modules moved); use `mrh-score`.
* `run.git_info()` describes the component directory (it used to describe the old harness folder); with no git tree (installed copy) it reads `MRH_HARNESS_GIT_SHA`.
* Job smoke scripts moved to `smoke/` and bundle the package tree. Test entry point: `scripts/ci-test.sh`; installed-copy check: `scripts/package-smoke.sh`.
* `MRH_SUITE_DIR` locates the public dev suite; `MRH_REQUIRE_SUITE=1` turns a missing suite / `score.py` / EPUB source into a failure instead of a skip.

## dev-c2 (candidate, OpenProject #135)

Evidence wiring, `unavailable` everywhere, capabilities and gaps, and a contract proposal. Not scoring: `score.py`, `CONTRACT.md`, the suite, labels and gates are
untouched. Builds on dev-c1 (#1009) and the live collectors (#1010). Default stays `--evidence replay`, and replay is byte-for-byte what dev-c1 showed the model.

### Evidence mode (`--evidence replay|live`, default `replay`)

* **replay** is dev-c1's tool layer unchanged. `test_wiring.ReplayIdentity` recomputes, for all 73 dev cases, the sha256 of every offered tool's rendered result (as
  `run.result_message` sends it, fixed argument set, no ffmpeg on PATH) plus the model-visible case view, and demands equality with
  `testdata/replay-identity-dev-c1.json`, generated from the dev-c1 code before any dev-c2 edit to `tools.py` (`replay_identity.py` is the generator).
* **live** serves `ffprobe`, `decode_sample`, `frame_sample`, `audio_sample`, `ocr`, `epub_inspect` and `audiobook_inspect` from `evidence.collect` on the case's own local media
  file (`tools.live_tool`). No fixture, pinned real media, remote host, a path that does not exist, or a directory for a single-file tool: `unavailable` with the reason, and
  nothing is run. `arr_lookup` is unchanged. The collector deadline is 45 s (`LIVE_DEADLINE_S`), so a slow file ends `partial` inside the 60 s tool timeout; the outer timeout still
  turns a hung collector into `timeout`. `--evidence-bounds '{"segments": 2}'` overrides collector bounds (clamped to the hard maxima, unknown names refused; live only).
  `frame_sample` runs the frames collector with OCR off, `ocr` with OCR on; without tesseract `ocr` is `unavailable` (the frames decoded, the text was not read), as in replay with no OCR backend.
* Every tool result and run record says which mode: `evidence_mode` (`replay`|`live`) on each `tool_calls[]` entry, in the record, in the manifest `config` (so in `config_hash`)
  and in `run_summary.json`. `mode` on a call keeps its dev-c1 meaning (how the answer was produced: `live`, `local`, `remote`, `replay`, `pinned_replay`, `stub`, `injected`).
  Neither is shown to the model: `run.result_message` still sends only type, id, tool, status, truncated, output and calls remaining.
* A live damage finding (`error` with collector `cause: input`) is usable as support in the action audit, like a replay `error` that carries the tool's own `exit_code` / `stage`;
  a tool-side `error` is not. Live calls are kept per call in `tool_calls[].evidence` (kind, coverage, reason, cause, bounds, input fingerprint without the file name) and
  `args_ignored` (model arguments such as `at` that live collection validates but does not use: the collectors choose their own sample points).

### `unavailable` is first-class

`evidence.core.to_tool_result` no longer turns `unavailable` into `error` plus `evidence_status`; the status passes through and `evidence_status` is gone (dev-c1 said the wiring
story should do exactly this). `test_evidence` was updated for it; `tools.STATUSES` and `evidence.STATUSES` are asserted equal.

### Capabilities and gaps (record only)

`gaps.py`, run record field `evidence` (mode, `capabilities[]`, `gaps[]`, `gaps_cited[]`): what was not verified, which call showed it (a citeable `t<n>`), its type (`not_run`,
`incomplete`, `standing`), the area, the reason and the harness tool that would be needed. Never shown to the model, never changes a decision, not scored. A damage finding is evidence,
not a gap. `run_summary.json` counts gaps. `evidence_mode` and `evidence` are required record fields (`record_missing_fields`).

### Contract proposal

`CONTRACT-v2-proposal.md`: a proposal for the evaluator to accept or reject (decision fields, the write-action audit object with `proposed_not_executed`, proposal vs executed vs verified,
tool statuses, capability and gap records, version fields). `CONTRACT.md` is not edited; nothing in it describes scoring.

### Tests

`test_wiring.py` (46 tests): replay identity over the dev suite, explicit replay equals default, no mode or gap field reaches the model, live with a fake collector runner and a fake
`collect` (ok, missing binary, damaged input, timeout, hung collector, partial, missing path, no fixture / pinned / remote, directory, injected failure, bounds mapping, bad arguments, output cap,
OCR without an engine), a real EPUB through the real collector, leak guard (names redacted; a leaking message still raises), `unavailable` status, gaps, run records through `run_case`
and `main`. Whole harness: 379 tests (333 before). `wiring_smoke.py` + `launch_wiring_smoke.py` ran `run_case --evidence live` with a scripted adapter and the real ffprobe/ffmpeg in a
CPU-limited Job on synthetic fixtures (`testdata/wiring-smoke/wiring-smoke.json`; Job deleted).

### Smoke (validity only, not a benchmark)

`runs/smoke-dev-c2-claude-haiku-5-5-v2/` (re-run after the review fixes, replacing the first run): `claude-haiku-5-5` through the claude adapter (same flags as the dev-c1 smoke), prompt v2,
`--evidence replay`, the same 5 dev cases as `smoke-dev-c1-claude-haiku-5-5-v2`, run from the committed tree at `dbb53548` (git dirty flag false). Result: 5/5 records complete, 0 crashes,
0 forced, 0 protocol violations, response model id `claude-haiku-5-5`, 5/5 final decisions valid, cost about 0.006 USD, 4 tool calls all `replay`, 1 recorded gap, no write executed.
**First-try validity was 3/5 this time** (2 repair prompts: one `why` over 200 characters, one `reason` over 400 characters; the first run had 5/5 and the dev-c1 smoke 5/5), so two runs of the same
five cases already differ; the harness did not change what the model is sent. The length misses are not in `failure_modes` (those classify structural mistakes only). Pass rates were not computed.

### Known limits

* **Live mode needs local media.** The dev suite's own cases are replay-shaped (recorded probe results, pinned real media), so a `--evidence live` run over it yields mostly `unavailable`;
  live is meant for cases that carry a local media path, such as the synthetic fixtures or a future suite built from generated media. It has run for real only on the wiring-smoke fixtures.
* Live `ok` means the collection plan ran, not that the media is healthy; sampling finds damage only where it samples (see `evidence/README.md` limits). tesseract is not in the smoke image,
  so live OCR has only fake-runner coverage.
* `at`, `stream` and `frame` arguments have no effect in live mode (recorded in `args_ignored`); replay serves the nearest recorded window instead.
* The replay-identity digests cover the fixed argument set in `replay_identity.CALLS` and the case view, with no ffmpeg on PATH; they do not cover a run on a machine that has ffprobe (the local route is unchanged code).
* Gap `needed_tool` for `standing` gaps is a keyword hint on the collector's wording. `ocr` and `frame_sample` share the frames collector, so one `ocr` call repeats the frame decode.
* Everything from dev-c1's known limits still applies (`score.py` predates `unavailable`; `claim_text` checks are English keyword matches; per-case structured output for Ollama is untested live).

### Review fixes (independent review of PR #1011)

Replay was verified identical to dev-c1; the findings below were all in live mode, the evidence package or the checks. Version stays `dev-c2`.

1. **EPUB `cause`.** A collector limit (`epub_max_members`, an oversized container.xml / OPF) and any `OSError` (permission, I/O) while opening or reading the archive are now `cause: tool`; only a
   damaged archive stays `input`. `gaps.is_damage_finding` follows the record's `cause` first, so a `tool` cause is a gap, never a finding; `audit.usable_as_support` already refuses it. Tests: member cap, an
   unreadable (mode 0) file, an oversized OPF, a genuinely corrupt archive still `input`. Found on the way: `fingerprint` raised on an unreadable file, so `collect()` raised instead of returning an error record; it now returns no fingerprint.
2. **Part names.** Every file and folder name under a folder item is replaced (`part-NN.ext`, `folder-NN`, also the stems and the JSON-escaped forms) in the redactor that runs when the result is bounded, before the leak guard; a part named
   after a class or an action neither reaches the model nor raises `LeakError`. Test: names that are class and action words, through `run_case`. Proposal section 3 updated.
3. **Serial runs.** `--evidence-bounds deadline_s` above `LIVE_DEADLINE_S` (45 s) is cut to it and listed in `bounds_clamped`. When the outer tool timeout fires on a live call, `call_tool` sets a cancel event
   (`Ctx.run` starts no further subprocess), kills the process group the collector thread is waiting on (`evidence.kill_active`) and waits for the thread, so the next call starts alone. Tests: a cooperative hung collector, and a
   real shell-script `ffprobe` whose `sleep` child is verified dead after the timeout.
4. **Unhonored offsets.** In live mode a requested `at` / `ss` / `t` that falls in no sampled window, an audio `stream` other than the first, or a `frame` name now produces a `request_note` in the tool result (generic wording, the
   windows actually sampled) and `request_unmet` in the call record; `gaps.py` records a `requested_not_honored` gap for it. A requested offset inside a sampled window counts as honored.
5. **Crash records.** `gaps.evidence_summary` tolerates `tools_available: null`; `crash_record` never raises (a minimal record with every required field, `error.secondary` naming the second failure, is the fallback); `call_tool` tolerates
   a null tool list. Test: a null-`tools_available` case and a forced `_crash_record` failure, each followed by a case that runs normally in the same batch.
6. **Replay-identity coverage.** The golden is regenerated from the real dev-c1 tree (`git archive 617e6ad4` into a scratch directory, `replay_identity.py` copied in and run there) and now also digests the v1 and v2 system
   prompts, the turn schemas, repair prompts and validator errors / failure modes for 11 bad replies, the budget notice, the forced decision, the not-offered message and six bad-argument errors. The README row and the
   `replay_identity.py` docstring list exactly what is and is not covered (not: a machine with ffprobe/ffmpeg, other arguments, adapters, record fields).
7. **Docs and folder fingerprints.** `evidence/__init__.py` no longer says "not wired". For a folder item `evidence.input` keeps per-part size and head/tail hashes (no names) in `files[]`; the proposal says so.

## dev-c1 (candidate, OpenProject #136) 

Prompt v2, protocol and audit. Builds on W10's WIP (prompt v2 draft, `unavailable` status, pinned replay, `audit.py`). Not scoring: `score.py`,
`CONTRACT.md`, the suite, labels and gates are untouched. Default stays `--prompt v1`; `--prompt v2` selects everything below that is marked v2.

### Tool statuses (both prompts)

One rule, written in `tools.py` and in prompt v2: `ok` ran and answered fully; `partial` ran, cut answer; `error` ran and failed **or** ran and reported
damage in the file (damage carries the tool's own `exit_code` / `stage`); `timeout` ran, did not finish; `unavailable` the capability is absent and
nothing ran (tool not offered for the case, binary / backend / fixture file missing, nothing recorded to replay, recording unusable, evidence file
missing or failing its hash). The five tests that expected `error` for these now expect `unavailable`, and two more places that said `error`
(pre-collected evidence file missing or hash mismatch; replay record that does not match the fixture) became `unavailable` for the same reason.
Pre-collected evidence with `status: unavailable` is no longer coerced to `ok` (it was, in `resolve_evidence`).

### Prompt v2 (`prompts/v2.txt`, sha256 in every record)

* Every class and action is defined by the change it makes and the evidence and recovery prerequisites it needs. Rename: name/path only, same item,
  verified identity, reversible by renaming back. Remap: changes which item the file is linked to, needs evidence of the right target, a free target
  slot and a read back. Blocklist-and-search: not recoverable once the file is replaced, so partial or failed evidence is never enough. Convert:
  isolated copy, clean full decode, stated client.
* Rule: any part of the item that was not verified (tool failed, timed out, unavailable, partial, segment not sampled) is unverified, never healthy;
  decide only what the remaining verified evidence supports, else `insufficient_evidence` + `escalate` naming the unverified part.
* Status meanings, "exactly one action, never a combination", "a call outside tools_available is rejected and uses one of the 6 calls", first key is
  always `type`, do not copy tool-result fields. Write decisions carry `audit` (target, preconditions, readback, verify); an unverified precondition is
  left out and the write becomes an escalation.
* General: no case ids, titles, filenames or expected answers. `test_v2.PromptV2` sweeps every dev-suite id, id stem, family, title, filename and fixture
  name (and the synthetic suite's) against the prompt text, and `leakguard.check_system` runs on the system prompt of every case at run time.

### Protocol and schema (v2; v1 behaves as in checkpoint 1)

* Recorded first-try failure modes are classified generically on every rejected reply (`turns[].failure_modes`): `compound_action`, `unknown_action`,
  `unknown_class`, `missing_type`, `envelope_keys_copied`, `echoed_tool_result`, `stray_comma_quote_close`, `fence_wrapped`, `prose_around_object`,
  `stop_token`, `audit_missing`, `audit_malformed`, `wrong_keys`, `not_json`, `empty_reply`, `adapter_error`. The one repair prompt adds a fixed generic
  hint per mode. Nothing is salvaged: a stray `","}` close is diagnosed, never accepted.
* A well-formed tool call outside `tools_available` is a **protocol violation**: recorded in `protocol_violations[]`, answered with an `unavailable` tool
  result that lists what is offered (the model-chosen name is never echoed back), counted against the 6 calls, no repair prompt, no crash. (The work order
  said "error tool result"; `unavailable` follows the settled semantics: the capability is absent.)
* Legitimate structured output: per-case `format` schema for Ollama with single-value enums (`tool` limited to the case's tools, `action` in the no-write
  schema only `none|escalate`, write schema requires `audit`), `type` first and required. Claude and Codex have no schema channel in these CLI modes, so
  they rely on the prompt text and the strict validator.
* First-try validity is strict and recorded honestly: `first_try_valid` is false after any repair prompt, forced decision, adapter error or protocol
  violation. New `first_try` object (`valid`, `first_reply_valid`, `failure_modes`, `repair_prompts`, `protocol_violations`, `valid_after_repair`),
  `final_decision_valid`, and `turns[].attempt` (`first` / `repair`) with `turns[].reply_valid`. A repaired reply is a later attempt and never rescues the first.

### Leak guard

* `check_system`: the static system prompt is checked for this case's id, id stem, file names and a long provenance string (tokens under 6
  characters are skipped: `a`, `new` are ordinary words). The case **title is not checked**: it is shown to the model in the case context anyway, and one-word
  titles such as `Identity` or `Evidence` are ordinary protocol words that would otherwise crash the case on both prompts (review finding, test with 11 such titles). Hit = harness error, nothing sent, recorded `harness_crash` / `leak_guard: true`.
* Generic harness text (the repair prompt: validator error that lists every class and action, plus hints) is checked for case-specific tokens only.
  Tool-result text never echoes model-chosen names, so a bogus tool called `rename` cannot trip the label check. Tests cover both directions: generic
  definitions pass for all 73 suite cases and the synthetic ones; ids, stems, family, file names, class and action labels in case text are still caught.

### Action audit (`audit.py`, `action_audit` in every record and in `audit.jsonl`)

* A write action produces an audit object: `execution_status: proposed_not_executed` (`no_write_proposed` for none / escalate), `executed: false`,
  intent, target, the model's audit verbatim, `preconditions[] = {id, met, basis, detail}`, `readback_plan`, `verification_plan`, `unmet`.
* Preconditions are computed by the harness from the case data and the run's own tool calls (`basis: computed`): class fits the action, target named and
  found in context, evidence cited and not a failed result, *arr present where required, client profile / full decode for convert, audit target equals
  target. Prerequisites that nothing in the case can confirm (free target slot for remap, undo path for rename, original untouched for convert) are
  `basis: claim_text`: `met` then only means the claim was made.
* A result may be cited as support when it is `ok` or is damage a working tool reported (structured `exit_code` / `stage`); a plain failure message,
  timeout, partial or unavailable result may not. `unverified_parts` lists every non-ok result and `decision_flags` marks healthy/none next to one
  (informational; the decision is never rewritten).
* Records, `audit.jsonl` and `run_summary.json` say proposal / intent / not executed; a test scans them for claims that something was repaired.

### Review fixes (PR #1009)

* OCR replay: the suite author's construction note for a string `frame_text` stays in the run record only (`tool_calls[].recorded_note`); the model-visible
  OCR output is what the call returned, as in v1.
* `prompt.turn_schema_sha256` is the hash of the schema actually sent (Ollama: v1 anyOf or flat, or the v2 per-case schema); adapters that send none
  (claude, codex, scripted) record `null` and `schema_sent: false`.
* v2 validator rejects an `audit` on `none` / `escalate` (first-try invalid), matching the prompt and the Ollama no-write schema. The stray-close repair
  hint now says one double-quote character.

* Audit `target_in_context` is strict: `met` with basis `computed` only when the target equals or contains an identifier of the case's own item (file
  name or path, a linked item id, or the title, with season and episode for a TV item) and names no broader scope (all / every / whole / library /
  series / season / indexer ...). App names, generic words and matches inside free tool or evidence output never count; text found only in free output is
  reported unmet with basis `claim_text` (unverifiable). The 5-case smoke records predate this change (their audits used the looser match).

### Run records and summary

Record: `harness_version` (`dev-c1`), harness git sha + dirty flag (manifest), prompt version + sha256 + turn-schema sha256, `config_hash` (config now
holds the harness version and the v2 schema hash), `fixture_hashes` (declared / actual fixture sha256, sha256 of every evidence text shown),
response model ids, usage and cost, wall times, failed runs preserved. New `run_summary.json` per run: validity and completeness counts only
(`record_missing_fields` names any absent required field), no scoring.

### Tests

`test_v2.py` (prompt, schema, failure modes, violations, leak guard, audit, records) and `test_regression.py` (12 synthetic generic cases in
`testdata/regression/`, generated by `testdata/make_regression.py`: movie, TV, EPUB and audiobook; partial evidence, abstention, failed / timed-out /
partial tools, healthy negatives, edition and order ambiguity; fake model replies). Command and counts are in the PR.

### Smoke (validity only, not a benchmark)

`runs/smoke-dev-c1-claude-haiku-5-5-v2/`: `claude-haiku-5-5` through the existing claude adapter (tools, MCP, settings, slash commands disabled), prompt v2,
5 dev cases (one per injected-failure kind plus a rename-shaped and a healthy-shaped case, picked by shape, not by outcome). Result: 5/5 records complete,
0 crashes, 0 forced, 0 repairs, 0 protocol violations, 5/5 first-try schema valid, response model id `claude-haiku-5-5`, cost about 0.0055 USD. Pass rates
were not computed. Five cases are too few to say the first-try failure modes are gone.

### Known limits

* **Evaluator: compare `calls_by_status`.** `score.py` `organic_failures` ignores `unavailable` (see below), so a drop in organic failures between v1
  checkpoint 1 and dev-c1 can be a relabelling (`error` -> `unavailable`), not fewer failures. Compare `tools.calls_by_status` side by side.
* **v1 on dev-c1 is not a pure checkpoint 1 rerun.** The v1 prompt text is byte-identical (same sha256), but tool statuses (`unavailable`), pinned and
  OCR replay output and the evidence integrity status changed in the shared tool layer, so v1 runs are only comparable with checkpoint 1 with that in mind.
* `score.py` (not touched) predates `unavailable`: its G8 "exercised" test and `organic_failures` count only error / timeout / partial, so an
  `unavailable` result is listed under `calls_by_status` but not treated as a tool failure. The evaluator decides whether that matters.
* Per-case structured output exists for Ollama only and has not run against a live Ollama (no Ollama use in this story). The v2 `anyOf` schema is
  unit-tested for shape only. `--num-predict` defaults to 640 for v2.
* `claim_text` checks are English keyword matches on the model's own audit text; they cannot confirm that a slot is free or that an undo path exists.
* The real `error` damage finding (EPUB zip_open etc.) stays status `error`, as in the suite's recorded evidence, so `unverified_parts` lists it and a
  healthy decision next to it is flagged; a corrupt decision citing it is not penalised by the audit.
* Replay and pinned answers are recorded observations, labelled `replay` / `pinned_replay`; live ffmpeg paths are unchanged and still unverified against
  real media here (W11).
* v1 keeps checkpoint 1 behaviour on purpose (a tool outside `tools_available` is still a repairable miss).
