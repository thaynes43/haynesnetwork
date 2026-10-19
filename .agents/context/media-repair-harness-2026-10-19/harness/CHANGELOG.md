# Harness changelog

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
