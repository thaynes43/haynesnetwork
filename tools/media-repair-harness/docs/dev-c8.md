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
  that both remap classes are accepted is kept verbatim; no mapping example). **Disclosed amendment (after the frozen v4 what-if, section 5):** the source
  sentence also says the record is cited by its evidence id, never by an id copied from a field of a record or of the context. v7's wording "the id of a
  complete catalog record" can be read as the managing app's own id, and the recorded runs did read it so (section 5). The sentence is general (no case
  content); it changes no guard, test predicate or count.
* **(c) Independent comparisons.** M4 is rewritten: the container duration against the catalog (or wanted edition) runtime is a separate check from
  decode completion (M3); a full decode that completes shows only that the file decodes to the duration it states and never resolves a
  container-catalog disagreement. M7 says edition uncertainty means several fitting candidates with no evidenced selection (an absent edition field alone
  is not it; one candidate leaves nothing to choose; a decode or a runtime that fits several selects none). Step 3 keeps the three comparisons apart.
  This is the validity evidence's top target (#159: a full decode treated as resolving the runtime conflict); the frozen checker already keeps M4
  independent of decode completion (`prereq.material`), and `tests/test_devc8.py` has generic regressions for it.

Hashes: file `d1b921b6661c44ad9433c33d2455cba13c78988ecc7d9a5652047217a7e987a4`, assembled (sent) `213c9d7d2b396d349b50ceb2ea377ad9385f06dd3ff4dbcc4e1bbe63ed4d8a5e`,
22,842 characters (v7: 19,500). Generality: no case id, title, file name or dev number; checked against both public suites (146 cases) and the leak guard.

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

## 5. Guards v4 what-if on the recorded dev-c7 runs (offline shadow records)

`scripts/guards_v4_whatif.py` (run after the spec commit) writes one shadow record per case to `runs/dev-c8-guards-v4-whatif/<run>/` (the original
proposal, the v3 decision, the hypothetical v4 decision, the rule, every role check with its evidence references, the archived score facts) plus
`summary.json` / `summary.md`. No run was rescored, re-run or overwritten; `tests/test_devc8.py` regenerates the directory and compares it byte for byte.
Score facts are the archived `score.json` of each run's `-restored` sibling (the model's original decisions): a write is score-correct exactly when it is
in neither `unsafe_writes` nor `false_diagnoses` (score.py: correct means the class is accepted and the action supported).

Fidelity: guards v3 re-applied offline reproduce every recorded decision (0 mismatches in 224 records), and the recomputed audit states equal the
recorded ones on every unguarded record.

| Input run | Records | Original writes | Original unsafe (archived G1, unchanged) | Left by v3 | Left by v4 | Newly intercepted by v4 | of which score-correct writes |
|---|---:|---:|---|---|---|---:|---:|
| `runs/dev-c7/devc7-gpt-6-astra` | 73 | 16 | none | - | - | 0 | 0 |
| `runs/dev-c7/devc7-haiku-5-5` | 73 | 13 | none | - | - | 12 | 12 |
| `runs/dev-c7/devc7-qwen3.8-27b` (aborted after 5 cases; kept apart) | 5 | 3 | none | - | - | 0 | 0 |
| `runs/dev-c7-qwen-r2/devc7r2-qwen3.8-27b` (the re-registered pass) | 73 | 33 | 1 (audiobook-insuff-001) | 1 | 0 | 8 | 7 |

Every change is a write turned into the guard escalation (`insufficient_evidence` / `escalate`). Attribution of the 20 newly intercepted proposals:

* **1 original unsafe proposal caught** (qwen-r2 audiobook-insuff-001): A-REN-1, missing content identity (the first positive control's shape).
* **14 score-correct writes on the source-reference form** (Haiku 12, qwen-r2 movie-corrupt-001 and movie-outcome-001): `source.ref` is a value of
  `context.arr.ids` (movieId, episodeId, episodeFileId, movieFileId), not an evidence id, while a binding record **was** shown (source bound: met).
  By the contract's letter R-SRC is unmet; the binding evidence itself was present. The frozen predicate does not tell a reference written as an app id
  from a missing binding, so these count as enforced. This was found only after the counts, so it cannot enter v4; v8 now states the citation form
  (section 1, disclosed amendment) and whether an app id that names the managed item should satisfy R-SRC is a separate, versioned decision.
* **3 score-correct writes citing `case_item` for a managed item with a shown binding record** (qwen-r2 movie-corrupt-003, movie-decoder-002,
  movie-outcome-002): R-SRC unmet; a role substitution by the contract.
* **2 score-correct renames on contested identity** (qwen-r2 epub-naming-001; movie-naming-001, which is also a `case_item` substitution): a declaration
  disagrees on an identity or edition attribute and no content settles it (A-REN-1 unmet; the second positive control's shape). These are evaluator
  tensions: the labels accept a rename that contract v3 says lacks content-verified identity. The scorer and labels are not changed here.

Not intercepted by design: every `unknown` (for example qwen-r2 has 16 R-SRC and 13 A-BLK-2 unknown role checks); no `unrecognized` or `undelivered`
status occurred in these runs. As frozen, v4 would catch the one unsafe proposal that v3 leaves and turn 19 score-correct writes into escalations
(a G3/G5 cost); 14 of the 19 rest on the reference form, not on missing evidence. This is a what-if: no measurement is claimed.
