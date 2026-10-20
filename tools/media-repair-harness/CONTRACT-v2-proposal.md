# Harness contract v2: PROPOSAL (harness `dev-c5`)

**Status: proposal.** This file describes what the harness candidates dev-c1, dev-c2, dev-c3 and dev-c4 emit and accept, so that the independent evaluator can
accept, amend or reject it as the next contract. It is written by the harness side and binds nothing: `CONTRACT.md` (v1), `score.py`, the suite, the labels
and `GATES.md` are untouched and remain the evaluator's. Nothing here says how any field is, or should be, scored. Where this text and the code disagree, the code
and its tests (`test_v2.py`, `test_regression.py`, `test_wiring.py`) are the fact and this file is the bug.

What differs from v1 is marked **new in dev-c1**, **new in dev-c2**, **new in dev-c3** or **new in dev-c4**; everything unmarked is v1 behaviour kept as it was.

## 1. Versions

| field | where | value now |
|---|---|---|
| `harness_version` | every run record, manifest, `run_summary.json` | `dev-c5` (dev-c4, dev-c3, dev-c2, dev-c1 before; `protocol.HARNESS_VERSION`) |
| `record_version` | every run record | `1` (a full record is a superset of v1's, no field removed or renamed; the **minimal crash record** is not, see section 7) |
| `prompt.version`, `prompt.sha256`, `prompt.protocol` | run record | `v1`, `v2`, `v3` (**new in dev-c3**), `v4` (**new in dev-c4**) or `v5` (**new in dev-c5**), sha256 of the exact system text sent, `turn-v1` / `turn-v2` (v3, v4 and v5 are new prompt text on the v2 turn protocol, so their `protocol` is `turn-v2`) |
| `prompt.turn_schema_sha256`, `prompt.schema_sent` | run record | hash of the schema actually sent, or `null` and `false` (only the Ollama adapter sends one) |
| `config_hash` | run record, manifest | hash of the run configuration, including `harness_version`, `prompt_version`, `evidence_mode`, `evidence_bounds` and, only when guards are on, `guards` (**new in dev-c4**) |
| `guards` | manifest `config` | `v1` only when the run used `--guards v1` (**new in dev-c4**); the key is absent otherwise, so an unguarded run keeps the config shape it had |
| `evidence_mode` | run record, manifest `config`, `run_summary.json`, every tool call | `replay` or `live` (**new in dev-c2**) |

Prompt v1 and v2 are byte-identical to dev-c2's, v3 to dev-c3's and v4 to dev-c4's (pinned by digest in `tests/test_packaging.py`); v5 (**new in dev-c5**) is a separate file that is valid only with `--evidence-format v2` and is refused with the legacy format. It uses v4's per-case tool-enum schema and class table, and defines the format v2 fields (section 10) as decisions: it does not settle Q-01. `protocol_of('v4') == 'v2'`: the turn protocol and the strict validator are unchanged. For v4 only, the per-case Ollama `format` schema is exact about the tool enum: a case that offers no tool (`tools_available == []`) gets no tool-call branch (v2 and v3 fall back to the full tool list there, which is how a local model called tools no case offered). A hosted model, which gets no schema, can still make such a call; it is still recorded as a `tool_not_offered` protocol violation and answered `unavailable`.

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
| `guard{version, applied[{rule, original, reason}], final_changed}` | dev-c4 | **only when `--guards v1` is on**; section 9. `decision` and the fields derived from it describe the FINAL decision; the model's own decision is `guard.applied[].original`. |
| `write_rejection{rejected_write_attempts, attempts[], forced_after_rejected_write, repaired_to_valid_decision, note}` | dev-c3 | **record only, shown next to G1, no gate reads it.** A parseable write decision the strict v2 validator rejected is counted (the same turns as the evaluator's `rejected_write_attempts`). `forced_after_rejected_write: true` marks the case where the one repair prompt then also failed, so the case ended as a forced `insufficient_evidence` / `escalate` that no model chose. `run_summary.validity` counts both |

`run_summary.json` (validity and completeness counts only, no scoring) adds `validity.rejected_write_attempts` and `validity.forced_after_rejected_write` (dev-c3), `evidence_mode` and `evidence{tool_calls_by_evidence_mode, gaps, gaps_by_type}`. `record_missing_fields`
lists any required field that is absent; `evidence_mode` and `evidence` are required (dev-c2) and so is `write_rejection` (dev-c3).

## 8. Points for the evaluator

1. `score.py` (not touched here) predates `unavailable`; how it treats that status is the evaluator's to look at.
2. dev-c2 `replay` equals dev-c1 in what the model sees, but v1-prompt runs on dev-c1/dev-c2 are not a pure checkpoint 1 rerun (see CHANGELOG, dev-c1 known limits).
3. `live` is for local media only. Real library media (pinned rows) cannot be live; those cases get `unavailable`.
4. A live record's `ok` is "the collection plan ran", never "the media is fine"; `coverage.not_verified` always says what was not covered.
5. Open: whether `evidence.gaps` should be cited by id in a decision (today a decision cites `t<n>` and `gaps_cited` is derived), and whether `needed_tool` belongs in the contract or stays a harness hint.
6. Guards (dev-c4) change what the scorer reads (`decision`), so a guarded run is scored as a different candidate from the same run unguarded. Both views are reproducible from one guarded run (`guard.applied[].original`, `mrh-guard --restore`). Which view counts for a gate is the evaluator's decision.

## 9. Decision guards (**new in dev-c4**, opt-in)

`--guards v1|v2` (default off; v1 is the version measured in the dev-c4 runs, v2 relaxes two G-write checks, below) runs two deterministic checks on the model's final decision, after its last turn. They are not model-visible, they use no case id, title or label,
and they can only turn a decision into `insufficient_evidence` / `escalate` (never into a write or a diagnosis). The final decision's `reason` names the guard; the model's own full
decision is kept in `guard.applied[].original`; `forced` keeps its meaning (the harness forced a decision after a failed repair) and a guard does not set it. `action_audit`,
`decision_flags`, `bad_evidence_refs`, `refs_to_*` and `evidence.gaps_cited` are recomputed for the final decision. With guards off the record has no `guard` key and equals a dev-c3-shaped record.

* **G-healthy** (the evaluator's ruling C2 as a mechanical boundary): fires on `healthy` / `none` when the evidence the model could see (case-provided evidence and its own tool results) holds no
  integrity check that ran with status `ok`. Integrity checks, by evidence type: a probe (`ffprobe`), a decode or sampled decode (`decode_sample`, `audio_sample`), a package or archive check (`epub_inspect`),
  an audiobook stream check (`audiobook_inspect`). Identity and title records (`arr_lookup`, `ocr`, `prior_record`, a `frame_sample` handle) are not integrity checks. Failed, timed out, partial, unavailable
  and injected results do not count as ok. It never fires when at least one ok integrity check exists, so a healthy item with partial but representative checks keeps `healthy`.
* **G-write**: fires on a write action (`blocklist_and_search`, `remap`, `rename`, `convert`) when a precondition the action audit COMPUTES from the case data is unmet (basis `computed`; a precondition that only rests on
  the model's claim text is never acted on), or when no `evidence_refs` entry points to a result usable as support (an `ok` result of a tool or of case-provided evidence, or damage a tool that ran reported about the file).
  Whether the cited text really shows a defect is not decided here. The text-matching `target_in_context` check stays in `action_audit` but is not a reason to overrule (it misread a correct target in the offline what-if). For the guard,
  `remap` is consistent with `metadata_naming` as well as `identity_mismatch`, and a client profile under `context.expected.client_profile` counts (the dev-v1.1 shape); `action_audit` of v1 to v3 runs keeps its old reading.

**Guards v2** (measured offline only): G-write ignores the audit's `full_decode_ok` for `convert` (it works on an isolated copy and this contract does not require a clean full decode) and ignores `no_failed_tool_cited` when `cited_evidence_supports` is met. G-healthy is identical. `guard.version` says which one ran.

`mrh-guard <run dir> --suite <suite> --out <dir> [--guards v1|v2]` applies the guards offline to existing records (copies; the input is never modified; no model call) and writes manifest, run summary and audit lines, so the copy scores with the
unchanged `score.py`. It refuses a record whose `case_sha256` differs from the suite case. `mrh-guard --restore` is the inverse view of a guarded run (the original decisions back, to score it as if guards were off). Guarding an already guarded record starts again from the model's own decision. The guard reads only the status the model saw, not the harness-side `injected` flag. `run_summary.json` of a guarded run has `guards{version, applied_by_rule, decisions_changed}`.

### Open questions and known limits (dev-c4)

* **Q-01 (for the evaluator to rule on).** Prompt v4 does not say how to choose between `identity_mismatch` (blocklist_and_search) and `metadata_naming` (rename, or remap) for a file linked to the wrong episode. Pairing `remap` with `metadata_naming` (the dev-c4 audit table for v4 and the guards accept it) may not match the label convention, where `remap` has so far been paired with `identity_mismatch`. v4 is not changed for this.
* **v4 wording to fix in a v5:** "probe" counts as integrity evidence while the text also says "metadata alone is not"; "partial" is also a status name; the `insufficient_evidence` definition still says "covered only part"; "injected failures" is not visible to the model; the naming comparison has no threshold, so an alias can read as a defect.
* **G-healthy is stricter than ruling C2.** It also fires when integrity tools were offered but not called and the case holds no integrity evidence, which could cost G2 where a model skips tools.

## 10. Prompt v5 and evidence format v2 (**new in dev-c5**, opt-in)

`--evidence-format v2` (W18; `docs/evidence-format-v2.md`) changes what a model is shown, and `--prompt v5` (W19) is the only prompt that explains it; v5 is refused without the format. v4 may still be used with the format (a measurement of the format alone).
`--max-total-cost-usd` and `--max-wall-s` (dev-c5) are opt-in run caps: the run stops cleanly before the cap, the manifest lists the cases not run and `limits_state`. Neither changes a record's fields or any scorer-read value.
What v5 asks of a model, in short: separate execution (did a tool run) from integrity (what it found); treat `unknown`, `*_unclassified` and `decoder_warning` as certifying nothing; judge coverage against the reported question (no percentage, no full-file rule); count only the selected streams for a client; weigh catalog, declarations and content differently;
read a cursor as opaque and a page fetch as one of the six calls; cite only ids that were emitted. Positive damage supports `corrupt_file`; clean results never cancel it and support health only inside their scope; `convert` needs no clean full decode of the source; an established class with missing action prerequisites is kept and escalated.
Q-01 remains open for the evaluator (v5 gives no ruling and no example). Deferred to OpenProject #147: the identity comparison table, the ordering / edition table and richer content inspection.

## 11. Contract v3 wired with prompt v6 (**new in dev-c6**, opt-in)

`--evidence-format v3 --prompt v6` (W21, OpenProject #151) is evidence-to-action contract v3 (`docs/contract-v3.md`, rubric v3.0 frozen plus v3.1) as ONE versioned configuration: the v3 presentation (`evidence_v3.py`, which reuses the frozen `experimental/contract_v3/` modules unchanged), turn protocol `turn-v3`, decision schema `decision-v3` and audit v3. They are valid only together and only with prompt v6, with guards off or v3; every other combination with a v3 element is refused before any model call (`run.check_option_combination`), and every earlier combination keeps its rule. A run that does not select format v3 never imports the contract-v3 modules.
What changes for a model: a write carries `source {"ref"}` (the catalog record that binds this file, or `case_item` for an unmanaged item) and an action-specific `target` object (`release_of_source`, `destination_slot`, `rename_of_source`, `isolated_copy` allocated by the executor); `none` and `escalate` carry neither and no write needs an audit object. The evidence keeps explicit empty / null / false / zero values with a `presence` map, lists every unresolved statement once in `open` with its sources and `available_check` links ("may inspect", never "will resolve"), and a tool result shows only the open items that are new or changed plus `open_removed`.
What changes for the record: `action_audit` is audit v3 (every diagnosis, action and role prerequisite with its state and the references that decided it, the execution prerequisites listed for the executor); it is a record and changes no decision. Guards v3 apply unchanged (they read class, action, evidence_refs and the shown observations, never the target); a guard or forced escalate has no `target` key under turn-v3. The scorer reads `decision.class` and `decision.action` only, so the unchanged `score.py` scores v3 records through `score_compat`.
Q-01 stays open (v6 says both classes are accepted for `remap`). Measurement: `runs/dev-c6/` (pre-registered).

