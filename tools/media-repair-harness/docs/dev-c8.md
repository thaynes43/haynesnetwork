# dev-c8: prompt v8, reply-contract hardening (turn-v3.1), Claude reply schema, guards v4

Story: OpenProject #158 (epic #48), WO-W26 with the AUDIT-ASTRA-36 amendments and the coordinator's reconciliation with the validity evidence
(#159). Source: AUDIT-ASTRA-35. Offline only: no model was called for this version, and there is no pre-registration and no measurement. Every earlier
configuration (prompts v1 to v7, formats v2, v3 and v3.1-format, guards v1 to v3, the legacy Claude adapter) is unchanged; their recorded runs and replays
are untouched. Scorer, labels and the G4 population are not changed (evaluator tensions stay recorded).

| Piece | Selected by | Version recorded |
|---|---|---|
| Prompt v8 | `--prompt v8` (with `--evidence-format v3.1-format` only) | `prompt.version` `v8`, `prompt.sha256` |
| Length-specific repair hint | prompt v8 | `prompt.protocol` `turn-v3.1`, `prompt.repair_allowance`, `repair_prompts[].repair_protocol` |
| Claude reply schema | `--adapter claude --claude-schema json-schema-1` | `adapter_config.adapter_version` `claude-schema-1`, `prompt.schema_sent`, `prompt.schema_mode` |
| Guards v4 | `--guards v4` (format v3.1-format only); offline `scripts/guards_v4_whatif.py` | `guard.version` `v4`, `guard.role_checks` |

## 1. Prompt v8 (`prompts/v8.txt`)

v8 is v7 with three changes and nothing else (`tests/test_devc8.py` checks the line diff):

* **(a) Concise output, made operational.** A `BREVITY` section: lengths are counted after JSON decoding; the hard limits (reason 400, why 200) are
  unchanged and enforced; the targets (reason about 300, why about 120) are guidance, not extra validation failures. A reason states the decisive
  observation, **any material limitation that affects the decision** (a decisive contradiction, an unresolved comparison, where a claim comes from, the
  unchecked scope of a healthy decision) and the decision; it does not restate satisfied rules. Brevity is neutral: escalating is as valid as leaving the
  item alone or proposing a write. Generic examples of a healthy decision, an escalation and a permitted write (each under the soft budget) and of a `why`.
  Step 5 no longer asks the reason to list "what was and was not verified" (A35's contributing pressure); it asks for what decided it and the material
  limitation that remains.
* **(b) Action roles at the moment of response (step 8).** Uncontradicted identity versus content-verified identity (rename needs the second; a file name,
  tag, package metadata, declared table of contents or a non-`report_content` prior-record claim never verifies it), and the managed versus unmanaged
  source role (`case_item` only when `context.arr.app` is null). If a role is not filled: keep the class and escalate. Q-01 is not settled (v7's sentence
  that both remap classes are accepted is kept verbatim; no mapping example).
* **(c) Independent comparisons.** M4 is rewritten: the container duration against the catalog (or wanted edition) runtime is a separate check from
  decode completion (M3); a full decode that completes shows only that the file decodes to the duration it states and never resolves a
  container-catalog disagreement. M7 says edition uncertainty means several fitting candidates with no evidenced selection (an absent edition field alone
  is not it; one candidate leaves nothing to choose; a decode or a runtime that fits several selects none). Step 3 keeps the three comparisons apart.
  This is the validity evidence's top target (#159: a full decode treated as resolving the runtime conflict); the frozen checker already keeps M4
  independent of decode completion (`prereq.material`), and `tests/test_devc8.py` has generic regressions for it.

Hashes: file `fe016088a9472387c1c20ca7f80800af9b01be45353d752b0fca37d56331003f`, assembled (sent) `2e7cd2df2a9ddc8730491ad88a89e46c164979ac2cae908ccb0e2bf12b7ecae8`,
22,726 characters (v7: 19,500). Generality: no case id, title, file name or dev number; checked against both public suites (146 cases) and the leak guard.

## 2. turn-v3.1: the length-specific repair hint

Turn rules, decision schema (`decision-v3`), validator and hard limits are turn-v3's. Only the repair prompt changes, for prompt v8:

* A reply that fails **only** on a length limit (`reason` over 400 or `why` over 200 decoded characters; detected by re-validating the reply with the
  over-long field replaced by a one-character placeholder) gets: the field, its decoded length, the hard limit and the soft budget, and a request to
  rewrite the field as a short summary of the decisive evidence (for `why`: of what the call should show), with any material limitation that affects the
  decision and without restating satisfied rules. It never says which decision to make.
* A reply with a length failure **and** another error gets the turn-v3 repair prompt with one length hint per field added to its hints. A reply with no
  length failure gets exactly the turn-v3 repair prompt.
* Failure mode `length_limit` is added to the turn's modes (first-try failure modes keep it).
* **The repair allowance is unchanged and recorded**: one repair prompt per case for any invalid reply; a later invalid reply (for example an overflow
  after the case's repair was already used on an earlier turn) ends in the forced escalate. `prompt.repair_allowance` and the run config carry it; each
  `repair_prompts[]` entry carries `repair_protocol`, `length_only` and `length_fields`. Raw replies stay in `turns[].text` untruncated.

Synthetic tests cover the real failure shapes of #159 and A35 without their text: an over-long reason on a write, on an escalation and an over-long why on
a tool call; 400/401 and 200/201 boundaries in ASCII, two-byte, three-byte and astral characters, as raw UTF-8 and as `\u` escapes (a surrogate pair is one
character), and `\n`/`\t` escapes; mixed length and semantic errors; and an overflow after the repair is used.

## 3. Claude reply schema: finding and adapter version claude-schema-1

**Finding (help text and documentation only; no model call, no `claude -p` probe).** The pod's CLI (`claude --version`: 2.1.296; the dev-c7 records name
the version they ran with) **advertises** `--json-schema <schema>` in `claude --help` ("JSON Schema for structured output validation", print mode). The
documentation (code.claude.com: CLI reference, headless mode, Agent SDK structured outputs) says:

* with `--output-format json` the result carries the validated object in `structured_output`; a run that ends without valid output has no such field;
* the CLI adds a tool named `StructuredOutput`; the model's reply is that tool's input; the CLI validates it client-side and **re-prompts on a mismatch**
  until it is valid or the run ends with subtype `error_max_structured_output_retries`; no documented flag sets that retry count;
* an invalid schema exits before the run; `format` is an annotation only.

So "the CLI can take a schema", but the advertised path would hide first-try failures and grant a silent extra repair (A36 item 4) if used as is: the `json`
envelope shows only the final, CLI-repaired object. Help and docs do not establish whether `--tools ""` (which this adapter must pass) keeps the
`StructuredOutput` tool, or how a top-level `anyOf` schema is accepted.

**Adapter version claude-schema-1** (opt-in, `--claude-schema json-schema-1`; unset is the legacy adapter, byte for byte):

* sends the per-case **flat** turn schema (one object type at the top level; the harness's strict validator still decides) with `--json-schema`, and
  `--output-format stream-json --verbose`, so every StructuredOutput attempt and every CLI validation result is visible;
* the reply is the model's **first** StructuredOutput attempt. Later CLI-internal attempts, the CLI's own validation messages, the final
  `structured_output` and the result text are recorded in `turns[].meta.schema` and never used: no extra repair, first-try failures stay first-try
  failures. `error_max_structured_output_retries` with an attempt still yields the first attempt;
* no attempt: the result text is the reply (empty when none), recorded as `reply_source`; a non-JSON stream line, a stream without a result event, or any
  other CLI error is an adapter error with the call's receipt (tokens, cost);
* `schema_sent` is true only when every model call carried the flag **and** the CLI's own init event listed `StructuredOutput`. An init event without it
  stops the run (`AbortRun`) instead of recording a schema that was not sent; an init event without a tool list records `schema_sent: false`;
* usage and cost come from the result event (they cover the CLI's internal attempts too); the CLI version is recorded from `claude --version` (and the
  init event's `claude_code_version` when present).

Offline fixtures (`tests/test_devc8.py`) are built from the documented event shapes; they verify schema forwarding, native envelope extraction, malformed
and missing output, usage accounting and truthful recording. **Not verified: any live behaviour** (whether `--tools ""` keeps the tool, the exact event
fields of 2.1.296, schema acceptance). The first live use needs one bounded call in a measurement story; until then Claude runs keep harness-side
validation with `schema_sent: false`, as before.

## 4. Guards v4 (G-role): frozen specification

Frozen in `decision_guard.V4_SPEC` (sha256 pinned in `tests/test_devc8.py`) and committed before any dev-c7 what-if count was computed (A36 item 1).

* **Inherits** guards v3 unchanged (G-healthy v3, G-write v3), evaluated first. The unknown exemption applies to the new checks only.
* **Scope:** a decision-v3 write on a contract-v3 record. The audit is the record audit's own `targets.audit_v3` (rubric v3.1 checker), over the
  observations shown to the model; `source.ref` is resolved through page origins first (a page of a result stands for that result).
* **Prerequisite ids:** `A-REN-1` (identity content-verified, rename); `A-REN-0`, `A-BLK-2`, `A-MAP-2`, `A-CNV-0` (source bound); `A-BLK-1`, `A-MAP-1`
  (managing app); `R-SRC` (the cited source qualifies).
* **States:** `met` passes; `unknown` never fires; `unmet` fires unless a non-enforcement predicate holds.

| Check, audit state `unmet` | v4 status |
|---|---|
| managing app absent | enforced (the context is always delivered) |
| a complete managed record of this item links a different file | enforced; `undelivered` if such a record was not fully delivered |
| unmanaged item, source is not `case_item` | enforced |
| managed item, the cited source (after page-origin resolution) is not a shown binding record | enforced; `undelivered` if a deciding record was not fully delivered |
| identity contradicted by recognised content | enforced |
| any content row the comparator matched to no catalog value | `unrecognized` (the content may carry identity the comparator cannot read): not enforced |
| identity contested (a declaration disagrees, no content settles it) | enforced |
| identity uncontradicted (no content agrees on an identity attribute) | enforced (missing) |
| any of the above when an identity-bearing or deciding result was not fully delivered | `undelivered`: not enforced |

Not enforced, by design: every `unknown` (for example a managed item cited as `case_item` when no record states the linked file); content the checker
cannot recognise. Known limit in the other direction: G-role is only as complete as the frozen comparator; a second on-screen title that is simply another
name matches no catalog value, so identity stays content-verified and G-role does not fire (a test records this). An `unmet` is a computed audit state,
not proof that enforcement is reliable; declarations and prior-record claims are never promoted to content (the checker's statement kinds decide;
`report_content` is content by the frozen checker's rule, not by v4).

Tests (synthetic, generic, frozen with the spec): two positive controls (a managed rename on uncontradicted identity with `case_item`; a bound rename whose
only content agrees on the title while a declared year disagrees), score-correct and contract-correct writes with every prerequisite met, unknown-only
writes, a recognition false negative, content-versus-declaration controls, contradictory evidence, source-role substitutions, page-origin and
uncalled-result swaps, undelivered pages, and the inherited v3 behaviour.

`mrh-guard` is a pinned input of the dev-c7 qwen-r2 registration and stays unchanged, so it refuses v4; `apply_to_record(..., 'v4')` refuses a record
that is not contract v3.
