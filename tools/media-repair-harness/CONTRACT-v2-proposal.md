# Harness contract v2: PROPOSAL (harness `dev-c3`)

**Status: proposal.** This file describes what the harness candidates dev-c1, dev-c2 and dev-c3 emit and accept, so that the independent evaluator can
accept, amend or reject it as the next contract. It is written by the harness side and binds nothing: `CONTRACT.md` (v1), `score.py`, the suite, the labels
and `GATES.md` are untouched and remain the evaluator's. Nothing here says how any field is, or should be, scored. Where this text and the code disagree, the code
and its tests (`test_v2.py`, `test_regression.py`, `test_wiring.py`) are the fact and this file is the bug.

What differs from v1 is marked **new in dev-c1**, **new in dev-c2** or **new in dev-c3**; everything unmarked is v1 behaviour kept as it was.

## 1. Versions

| field | where | value now |
|---|---|---|
| `harness_version` | every run record, manifest, `run_summary.json` | `dev-c3` (dev-c2, dev-c1 before; `protocol.HARNESS_VERSION`) |
| `record_version` | every run record | `1` (a full record is a superset of v1's, no field removed or renamed; the **minimal crash record** is not, see section 7) |
| `prompt.version`, `prompt.sha256`, `prompt.protocol` | run record | `v1`, `v2` or `v3` (**v3 new in dev-c3**), sha256 of the exact system text sent, `turn-v1` / `turn-v2` (v3 is new prompt text on the v2 turn protocol, so its `protocol` is `turn-v2`) |
| `prompt.turn_schema_sha256`, `prompt.schema_sent` | run record | hash of the schema actually sent, or `null` and `false` (only the Ollama adapter sends one) |
| `config_hash` | run record, manifest | hash of the run configuration, including `harness_version`, `prompt_version`, `evidence_mode` and `evidence_bounds` |
| `evidence_mode` | run record, manifest `config`, `run_summary.json`, every tool call | `replay` or `live` (**new in dev-c2**) |

Prompt v1 and v2 are byte-identical to dev-c2's (pinned by digest in `tests/test_packaging.py`); v3 is a separate file.

A comparison across versions should compare `harness_version`, `prompt.sha256` and `evidence_mode` first: the same prompt text (v1) behaves differently under
dev-c1 and dev-c2 only where noted in `CHANGELOG.md`.

## 2. Model turns

Strict JSON, exactly one object per reply, at most 6 tool calls, one repair prompt (unchanged from v1).

```json
{"type":"tool_call","tool":"<name from tools_available>","args":{},"why":"<=200 chars"}
```

Decision, prompt v2 (**new in dev-c1**). `action` is exactly one value, never a combination. A write action requires a non-empty `target` and an `audit` object;
`none` and `escalate` may not carry an `audit`.

```json
{"type":"decision","class":"<class>","action":"none|escalate","target":null,"reason":"<=400","confidence":0.0,"evidence_refs":["e1","t2"]}
{"type":"decision","class":"<class>","action":"blocklist_and_search|remap|rename|convert","target":"<non-empty>","reason":"<=400","confidence":0.0,
 "evidence_refs":["e1","t2"],"audit":{"target":"...","preconditions":["<=160 chars each, 1 to 6"],"readback":"<=240","verify":"<=240"}}
```

An audit on `none` or `escalate` is **rejected** by the validator (not tolerated): the reply is invalid on the first try and gets the one repair prompt.

Classes and actions are the v1 sets. A tool call outside the case's `tools_available` is a **protocol violation** (**new in dev-c1**, prompt v2 only): it is
answered with a tool result of status `unavailable`, counts against the 6 calls, is recorded in `protocol_violations[]`, and gets no repair prompt.
Prompt v1 keeps the v1 behaviour (a repairable miss).

## 3. Tool results

### Statuses (**new in dev-c1**: `unavailable`; one rule for every tool and every evidence mode)

| status | meaning |
|---|---|
| `ok` | the tool ran and answered fully (a sample is a full answer about the sample) |
| `partial` | the tool ran and returned a cut or incomplete answer |
| `error` | the tool ran, or its input was validated, and it failed; **or** it ran and reported damage in the file (a finding: the tool's own `exit_code` / `stage`, or in live mode `cause: input`) |
| `timeout` | the tool ran and did not finish in time |
| `unavailable` | the capability is absent and nothing ran, so nothing was learned: tool not offered for the case, binary / backend / fixture / media path missing, nothing recorded to replay, recording unusable, evidence file missing or failing its hash |

`unavailable` is never an empty success. Like `error`, `timeout` and `partial` it leaves the part it was meant to check **unverified**, never healthy.
In dev-c2 `unavailable` is carried as itself everywhere, including the live collectors' output (dev-c1's collector-to-harness mapping that turned it into `error` plus
`evidence_status` is removed).

### What the model sees

Only `{type:"tool_result", id, tool, status, truncated, output, tool_calls_remaining}` (plus the budget notice after the 6th). `output` is text, bounded to 8 KiB (`truncated`
says when it was cut). The case file name and path are redacted from `output`; for a folder item (an audiobook) every file and folder name under it is replaced by a neutral name (`part-NN.ext`, `folder-NN`) before the text is bounded and before the leak guard looks at it, so a part named after a class or an action cannot reach the model or stop the run. In live mode a request the collector did not honor adds a `request_note` key to the JSON text (what was asked for, that it was not honored, which windows were sampled instead). Nothing below the next heading is sent to a model.

### What the record keeps per call (`tool_calls[]`)

`id` (`t1`..), `turn`, `tool`, `args`, `why`, `status`, `output` (as shown), `truncated`, `wall_s`, and, when they apply:

| field | meaning |
|---|---|
| `mode` | how the answer was produced: `live` (collector), `local` / `remote` (dev-c1's direct ffprobe/ffmpeg routes), `replay`, `pinned_replay`, `stub` (arr_lookup), `injected` |
| `evidence_mode` | the run's selected mode, `replay` or `live` (**new in dev-c2**; the same on every call of a run) |
| `live_ran` | live mode only: whether a collector actually ran (`false` = refused before running, e.g. no local media path) |
| `evidence` | live mode, collector ran: `{kind, status, coverage{verified, not_verified}, reason, cause (input|tool), tool_version, bounds, bounds_clamped, input (size + head/tail hashes, no file name; for a folder item `files[]` with the same per part, in order, and `count`), elapsed_s}`; `cause: input` means the file is damaged or unreadable by the tool, `cause: tool` a collector limit, an environment error or a tool failure, and only `input` is a finding |
| `args_ignored` | live mode: arguments that were accepted and validated but have no effect (the collectors choose their own sample points) |
| `request_unmet` | live mode: `[{arg, requested, sampled_at_s?}]` for each requested offset, audio stream or earlier frame the collector did not examine (a requested offset inside a sampled window counts as honored); the same text is in the tool result as `request_note` |
| `injected` | the result replaced by an injected failure (`inject_tool_failure`) |
| `protocol_violation` | `tool_not_offered` |
| `recorded_note` | replay only: the suite author's construction note, never shown to the model |

## 4. Evidence modes (**new in dev-c2**)

`--evidence replay|live`, default `replay`.

* **replay** is the default and the scored mode. It is dev-c1's tool layer unchanged. What the model sees for a given case, tool and arguments is byte for byte what dev-c1 showed (`test_wiring.ReplayIdentity`
  compares sha256 digests, generated from the real dev-c1 code, of the case view and every offered tool's rendered result for all 73 dev cases with a fixed argument set, and of the v1 and v2 system prompts,
  the turn schemas, repair prompts and validator errors for a fixed list of bad replies, the budget notice, the not-offered message and bad-argument errors; it does not cover a machine with ffprobe/ffmpeg installed,
  other arguments, adapters or record fields; `replay_identity.py` lists it exactly). Sources: recorded probe results for local
  fixtures, recorded observations of pinned real media, case-provided *arr records, and the local ffprobe/ffmpeg route when those binaries exist (`--replay auto|off|force`).
  **Replay may therefore run a local `ffprobe` / `ffmpeg` when present, and `kubectl exec` into the pinned target for a remote fixture** (**new in dev-c3 text, behaviour unchanged since dev-c1**;
  CONTRACT-v1.1 section 4 says the same). A result is always labelled by `mode` (`replay`, `pinned_replay`, `local`, `remote`, `stub`, `injected`), and no gate reads `mode`.
  Replay data is recorded data, labelled by `mode`; a run on a machine with ffprobe/ffmpeg can show a model different probe text from a run without them.
* **live** is an **opt-in diagnostic, not scored**: nothing in this contract, the gates or the evaluator's runs depends on it, and the dev suites' cases are replay-shaped (mostly `unavailable` under live). It serves ffprobe, decode_sample, frame_sample, audio_sample, ocr, epub_inspect and audiobook_inspect from the bounded read-only collectors in `evidence/` (stdlib Python, the
  real binaries, no write, serial, `nice 19`, per-call deadline 45 s inside the 60 s tool timeout; a larger `deadline_s` is cut to it and listed in `bounds_clamped`; if the tool timeout fires anyway the running child is killed and the collector stopped before the next call, so calls stay serial), run on the case's own local media file. A case whose fixture is not a local path that
  exists (no fixture, pinned real media, remote host, missing file) gets `unavailable` with the reason and nothing is run. `arr_lookup` is not media and behaves as in replay.
  `ocr` needs `tesseract`; without it the record says the text was not read. The model chooses a tool and numeric arguments; the path always comes from the case.

The collector record (`evidence/README.md`) carries `status`, `coverage.verified` / `coverage.not_verified`, `bounds`, `reason`, `cause` and the partial input fingerprint. Its `ok` means the
plan ran to the end, not that the media is healthy; findings (decoder errors, tag mismatches, `valid: false`) are inside `output`.

## 5. Capabilities and gaps (**new in dev-c2**, record only)

`evidence` in the run record (not the per-call `evidence`) lets an `escalate` decision cite what was not verified. It is derived from the calls and the case; the model is not
shown it; no decision is changed by it.

```
evidence: { mode, capabilities[], gaps[], gaps_cited[], note }
capabilities[]: { tool, offered, calls, statuses{status: n}, live_kind|null }          one per harness tool
gaps[]:         { id, call, tool, status, evidence_mode, type, area, reason|null, needed_tool|null, needed_note }
gaps_cited[]:   ids of gaps whose `call` appears in the decision's evidence_refs
```

* `type`: `not_run` (unavailable, timeout, or a tool-side error: everything the tool covers is unverified), `incomplete` (partial), `standing` (the tool answered and its own record states what the
  answer does not cover, e.g. a sample is not the whole file), `requested_not_honored` (live mode: the call asked for an offset, audio stream or earlier frame that was not examined; `area` says what was asked and what was sampled).
* `call` is a `t<n>` id, citeable in `evidence_refs` like any tool result. `needed_tool` names the harness tool that would be needed to verify the area; `null` when no harness tool can.
  `needed_note` is a short text. The `standing` mapping is a keyword hint on the collector's own wording, not a rule.
* A damage finding (a working tool reported damage) is evidence, not a gap. A tool that was not offered appears in `capabilities` with `offered: false`; a call to it appears as a `not_run` gap.
* Pre-collected case `evidence[]` that did not come back `ok` stays in `unverified_parts[]` as before; `gaps` covers the run's own tool calls.

## 6. Write actions: proposal, execution, verification

The harness executes no write: no change to media, Sonarr, Radarr, Plex, Lidarr, Bookshelf, LazyLibrarian or any library. Every record carries `action_audit` (**new in dev-c1**), also written as
one line per case to `audit.jsonl`:

```
action_audit: { execution_status: "proposed_not_executed" | "no_write_proposed", executed: false, write_intent, intent{class, action, target}, target, note,
                audit (the model's object, verbatim | null), claimed_preconditions[], readback_plan, verification_plan,
                preconditions[]{id, met, basis: "computed"|"claim_text", detail}, preconditions_unmet, unmet[], outcome_step }
```

Three states are kept apart, and only the first is ever produced by the harness (the second and third exist as words in the record, never as events):

| state | meaning | in the record |
|---|---|---|
| **proposed** | the decision names a write action | `execution_status: proposed_not_executed`, `write_intent: true` |
| **executed** | a write happened | never produced. **`executed: false` on every `action_audit` and `writes_executed: 0` in `run_summary.json` are invariants of this contract** (CONTRACT-v1.1 section 4): a record that says otherwise violates it. They are not a placeholder for a future executor; an executor would need a new contract. `record_missing_fields` flags any record whose `executed` is not `false` |
| **verified** | a write was read back and its effect checked | not produced. `readback_plan` / `verification_plan` are the model's text about what would be checked. `outcome_step` is the suite's own after-the-fact check on the case data, unchanged from v1 |

`preconditions[]` is computed by the harness from the case data and the run's own tool calls (`basis: computed`), or only records that the model's audit text made a claim nothing in the case can
confirm (`basis: claim_text`: `met` then means the claim was made, not that it is true). A result may be cited as support when it is `ok` or is a damage finding; a plain failure, a
timeout, a partial or an `unavailable` result may not. `unverified_parts[]` lists every non-`ok` result, and `decision_flags[]` marks a `healthy` / `none` decision beside a non-empty list
(informational; the decision is never rewritten). No record, summary or audit line says anything was repaired.

## 7. Run record

Existing v1 fields are kept (CONTRACT.md "Run record") in every full record. **The superset claim excludes the minimal crash record**: when even the full crash record cannot be built (a malformed case file breaks one
of its computed fields), `run._minimal_crash_record` writes a smaller record that lacks `bad_evidence_refs`, `evidence_shown`, `fixture`, `injected_failure`, `model_digest`, `model_digest_na_reason`, `outcome`,
`refs_to_failed_tools`, `refs_to_non_ok_tools`, `split`, `suite_version` and, because it has no harness manifest, `harness_git_sha` and `config_hash`. It still says `forced: true`, `error.kind: harness_crash`, a
forced `insufficient_evidence` / `escalate` decision and `executed: false`, and `record_missing_fields` reports the two required fields it lacks. A consumer must not assume every field of a full record in a crash record. Added or changed:

| field | since | content |
|---|---|---|
| `harness_version`, `harness_git_sha` (+ dirty flag in the manifest), `config_hash`, `run_id` | dev-c1 | as named |
| `prompt{version, sha256, protocol, turn_schema_sha256, schema_sent}` | dev-c1 | see section 1 |
| `first_try{valid, first_reply_valid, failure_modes[], repair_prompts, protocol_violations, valid_after_repair}`, `first_try_valid`, `final_decision_valid` | dev-c1 | a repaired, forced, adapter-failed or violating case is not first-try valid |
| `turns[].attempt` (`first`/`repair`), `turns[].reply_valid`, `turns[].failure_modes[]` | dev-c1 | generic classification of rejected replies; nothing is salvaged |
| `protocol_violations[]` | dev-c1 | `{turn, call, kind, tool, answered_with}` |
| `unverified_parts[]`, `decision_flags[]`, `refs_to_non_ok_tools[]` | dev-c1 | informational |
| `action_audit` | dev-c1 | section 6 |
| `fixture_hashes{fixture, evidence_shown_sha256}` | dev-c1 | declared and actual fixture sha256, sha256 of every evidence text shown |
| `evidence_mode`, `evidence{...}` | dev-c2 | sections 4 and 5 |
| `tool_calls[].evidence_mode / live_ran / evidence / args_ignored` | dev-c2 | section 3 |
| `write_rejection{rejected_write_attempts, attempts[], forced_after_rejected_write, repaired_to_valid_decision, note}` | dev-c3 | **record only, shown next to G1, no gate reads it.** A parseable write decision the strict v2 validator rejected is counted (the same turns as the evaluator's `rejected_write_attempts`). `forced_after_rejected_write: true` marks the case where the one repair prompt then also failed, so the case ended as a forced `insufficient_evidence` / `escalate` that no model chose. `run_summary.validity` counts both |

`run_summary.json` (validity and completeness counts only, no scoring) adds `validity.rejected_write_attempts` and `validity.forced_after_rejected_write` (dev-c3), `evidence_mode` and `evidence{tool_calls_by_evidence_mode, gaps, gaps_by_type}`. `record_missing_fields`
lists any required field that is absent; `evidence_mode` and `evidence` are required (dev-c2) and so is `write_rejection` (dev-c3).

## 8. Points for the evaluator

1. `score.py` (not touched here) predates `unavailable`; how it treats that status is the evaluator's to look at.
2. dev-c2 `replay` equals dev-c1 in what the model sees, but v1-prompt runs on dev-c1/dev-c2 are not a pure checkpoint 1 rerun (see CHANGELOG, dev-c1 known limits).
3. `live` is for local media only. Real library media (pinned rows) cannot be live; those cases get `unavailable`.
4. A live record's `ok` is "the collection plan ran", never "the media is fine"; `coverage.not_verified` always says what was not covered.
5. Open: whether `evidence.gaps` should be cited by id in a decision (today a decision cites `t<n>` and `gaps_cited` is derived), and whether `needed_tool` belongs in the contract or stays a harness hint.
