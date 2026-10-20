# Harness changelog

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
