# Evidence-to-action contract v3 (proposal) and the frozen blinded rubric

Owner: OpenProject story [#150](https://work.haynesnetwork.com/work_packages/150) (epic #48), WO-W20 with the AUDIT-ASTRA-16 amendments. Basis: AUDIT-ASTRA-15 (the dev-c5 regression diagnosis, its ranked hypotheses 1 to 4 and its recommended next step) and AUDIT-ASTRA-1 sections 2 and 3.

**Status: proposal plus offline prototypes.** Nothing here is a selectable production configuration. The prototypes live in `src/media_repair_harness/experimental/contract_v3/`, which no runner, guard, audit or CLI module imports. Prompts v1 to v5, the legacy format, evidence format v2, tools behaviour v1/v2, guards v1 to v3 and audit v1/v2 are byte-identical to main `f81b0093`; dev-c5's failed result and every earlier run are untouched. Wiring v3 into the runner, a prompt that explains it, and any measurement are later stories.

**What the tests prove.** The synthetic tests prove contract invariants (presence states survive, facts are preserved through deduplication and pagination, links cannot carry a result, prerequisites are checked against actual values and provenance, version combinations are refused). They do not predict, and are not evidence of, a recovery in any model's score.

<!-- BEGIN FROZEN RUBRIC contract-v3-rubric-1 -->
## 1. Terms

* **Observation**: one model-visible result: a case evidence item (`e1`, ...) or a tool result (`t1`, ...), with its id, tool, safe arguments, raw status and output. Format v2's typed layer (`evidence_v2.derive`) is reused unchanged to read it.
* **Statement kind** (what a fact is). `catalog`: what the case and its managing app say the item should be (`context.title`, `context.expected.*`, `context.arr.*`, `arr_lookup`). `declaration`: what the file says about itself (file name, container tags, chapter titles, OPF `dc:*`, stream languages, container duration). `content`: what was observed in the media (OCR text, EPUB spine text, subtitle text). `content_picture`: a picture without text (a frame handle). `integrity`: whether bytes and structure parse or decode (probe container parse, decode windows, package stages, audiobook container). `integrity_signal`: signal statistics (audio levels). `client`: the stated client. `report_*`: a prior record's own claim, typed by its stated `evidence_method` (`report_hash`, `report_declaration`, `report_content`, else `report_unknown`; a method naming both declaration and content words is the weaker `report_declaration`). `complaint`: `context.question` / `notes_for_model`.
* **Provenance**: `observed` (a tool of this run), `recorded` (case evidence or a replayed recording), `reported` (a prior record's claim), `stated` (the case context).
* **Presence** of a field: `absent` (no key), `null`, `empty` (`""`, `[]`, `{}`), `false`, `zero`, `populated`. These six never collapse into each other. For a whole source: `not_checked` (nothing that would carry the field ran) and `unknown` (it ran and the field cannot be read). An explicitly empty value is an observation; an absent one is not.

## 2. Canonical atomic facts and presentation

A canonical atomic fact is `(source id, source tool, statement kind, provenance, execution state, raw status, scope, field path, presence, value)`. The v3 presentation:

1. keeps **every** canonical fact of the v2 typed layer, plus the explicit empty, null, false and zero values the v2 fact filters dropped (`format.tags = {}`, an empty chapter list, an empty title). Nothing else is added;
2. deduplicates **presentation only**: an identical scope statement (for example "nothing was decoded: stream contents are unchecked by this result") is shown once with **all** of its source ids. Identical wording from different observations is not interchangeable: each source keeps its own entry in the canonical set and its own id in the group;
3. keeps conflicts, raw diagnostics (`facts.diagnostics`), findings and execution with their own item, and repeats the damage, conflict, veto and execution alerts on every page (page-local), as format v2 does;
4. words scope statements neutrally: a scope fact says what was or was not checked, never that a check is needed or required, and never that the item is healthy or not;
5. paginates with the v2 page contract (`pages-v1`, the same budgets and `PageBudgetError`); the canonical facts reconstructed from all pages equal those of one unpaginated rendering.

## 3. Generic triage: the question, its axes and material uncertainty

A case with no specific complaint (`notes_for_model` only) asks one generic question: *is anything wrong with this item that one of the actions addresses?* It has five axes: **integrity**, **identity**, **naming**, **ordering**, **client** (the last only when a client is stated). A `context.question` narrows nothing away; it adds its subject.

An unresolved item is **material** when resolving it could change the class or the action. With no specific complaint, these are material, and nothing else is:

| Id | Axis | Material uncertainty |
|---|---|---|
| M1 | integrity | no positively clean integrity result at the container or package level (each one failed, timed out, was unavailable, unknown, or was not made) |
| M2 | integrity | an unclassified diagnostic inside a checked scope (`*_unclassified`, `probe_messages`, `input_failure`, `exit_nonzero_unclassified`); a `decoder_warning` alone is not material and is not clean |
| M3 | integrity | a material conflict: `status_ok_with_defect`, `exit_zero_with_decoder_errors`, `decoded_span_shorter_than_duration`, `duration_mismatch` (`request_not_honored` only limits the completed scope) |
| M4 | integrity | a signal that points into the unchecked remainder: a container duration that disagrees with the catalog runtime beyond tolerance (the larger of 1.0 s and 5 %), a decoded span shorter than the container, or a complaint that names an unchecked part |
| M5 | identity | an identity attribute (title, series, episode number, episode title, author) or edition attribute (language, year, narrator, edition) of any declaration, content or report that disagrees with the catalog after the case-supplied aliases, alternate titles, editions and orderings, and that no content observation settles |
| M6 | naming | a naming-surface declaration that is explicitly empty or differs from the catalog. Naming surface: movie and tv, the file name; epub, the file name, `dc:title`, `dc:creator`; audiobook, the file name and the title, album and artist tags. Absent is not evidence |
| M7 | ordering | two legitimate candidates listed by the case that the observations fit, with no case-supplied choice that settles them |
| M8 | client | a stated client with an unknown verdict, an unread clause, or an ambiguous or unrecorded stream selection |
| M9 | any | a complaint whose subject no shown observation reaches |

**An unchecked remainder is not material by itself, and it is never clean.** It stays listed as not checked. No full decode is a universal prerequisite of anything.

## 4. Sufficient evidence for `healthy` / `none`

All four must hold. `healthy` means "no material problem in the checks performed", with the unchecked scope stated; it never means the whole file is certified.

| Id | Requirement |
|---|---|
| H1 | at least one integrity result ran with status ok and is positively clean inside its stated scope (a parsed container with streams, a package with every stage clean, a decoded window with frames and no messages) |
| H2 | no `known_defect` finding and no collector veto in any shown result, whatever its execution state |
| H3 | no material uncertainty M1 to M9 |
| H4 | identity is uncontradicted (no M5). Positive content confirmation of identity is not required for `none`, which changes nothing |

## 5. Diagnosis prerequisites (what establishes a class)

Identity levels: **contradicted_by_content** (a content or report_content observation disagrees with the catalog on an identity or edition attribute), **contested** (only declarations, report_declaration or report_hash disagree; nothing in content settles it), **content_verified** (a content or report_content observation agrees on an identity attribute and nothing contradicts it), **uncontradicted** (nothing disagrees and nothing in content confirms).

| Class | Prerequisites |
|---|---|
| corrupt_file | D-COR-1: a located `known_defect` finding from a tool that ran (a partial or timed-out result keeps its positive findings for the diagnosis) |
| decoder_incompatible | D-DEC-1 a stated client; D-DEC-2 an `unsupported` verdict on a selected stream whose selection is `recorded` or `only_stream_of_type` |
| identity_mismatch | D-ID-1: identity `contradicted_by_content`. Declarations, tags, reported hashes, a duration, a clean decode or a catalog record never satisfy it |
| metadata_naming | D-NAME-1 an M6 naming-surface defect; D-NAME-2 H1 (a positively clean integrity result: a good copy); D-NAME-3 identity `uncontradicted` or `content_verified` (contested or contradicted is not naming) |
| order_edition_ambiguity | D-ORD-1 two or more legitimate candidates listed by the case; D-ORD-2 no case-supplied choice (`series_order`, `library_episode_order`, wanted or monitored edition) that selects one |
| healthy | H1 to H4 |
| insufficient_evidence | no other class established and healthy not established |

A diagnosis prerequisite is checked against actual values, scope, status and provenance, not the kind of observation alone (section 8).

## 6. Action prerequisites, source binding and action targets

**Source binding** ties a proposal to the item under triage: the managing app's record of the linked file (`relativePath` or file id) equals the case's file name or file id; for an unmanaged item, the case item itself. Source binding is **not** proof of content identity or of health.

**Action target** is action specific:

| Action | Classes | Source | Target | Proposal prerequisites | Execution prerequisites (executor only) |
|---|---|---|---|---|---|
| none | healthy | - | - | the healthy diagnosis | - |
| escalate | any | - | - | none | - |
| blocklist_and_search | identity_mismatch, corrupt_file | bound source | the release of the bound source | A-BLK-1 managed app; A-BLK-2 source bound; A-BLK-3 (corrupt) a support-grade located defect: from a result that ran to completion, or an error result whose cause is not `tool`; A-BLK-4 (identity) identity contradicted by content from a completed result | the release record still links the bound source; the blocklist entry is recorded so it can be removed |
| remap | identity_mismatch, metadata_naming (Q-01 stays the evaluator's) | bound source | the destination slot | A-MAP-1 managed app; A-MAP-2 source bound; A-MAP-3 content names the item the file really is and the catalog lists it; A-MAP-4 an evidenced free destination slot: a catalog record of that slot shows no linked file (explicit null, empty or `hasFile: false`; absent is not evidence) | the slot is still free (collision check); no file is overwritten or deleted |
| rename | metadata_naming | bound source | the source, with `old_value` and `new_value` | A-REN-0 source bound; A-REN-1 identity `content_verified`; A-REN-2 the current naming-surface value, populated; A-REN-3 the catalog value, populated and different | the new name does not collide; the old value is recorded for the undo |
| convert | decoder_incompatible | bound source | an isolated copy, **allocated and named by the executor** | A-CNV-0 source bound; A-CNV-1 a stated client; A-CNV-2 an unsupported selected stream with a recorded or only-stream selection | allocation and naming of the copy; no-overwrite; validation of the copy against the client |

For `convert`, a destination name from the model is **not** a prerequisite, and a missing one is not a missing prerequisite; a model must not invent one. A clean full decode of the source is not a prerequisite either. Allocation, creation, collision and no-overwrite checks stay with the executor and outside this story.

**Decision schema `decision-v3`** (prototype, `targets.py`): a write carries `source: {"ref": "<the evidence id that binds the source>"}` and a `target` object of the action's kind: `release_of_source {source_ref}`, `destination_slot {slot_ref, slot_free_ref}`, `rename_of_source {old_value, new_value}`, `isolated_copy {allocated_by: "executor"}` (any path or name in it is refused). `none` and `escalate` carry neither.

**Versioning.** Protocol `turn-v3`, schema `decision-v3`, audit `v3` and evidence format `v3` form one contract version and are valid only together, with a prompt that declares contract v3 (none exists yet). Every combination of a v3 element with prompts v1 to v5, with turn-v2, with audit v1/v2 or with evidence formats legacy/v2 is refused; in particular unchanged v5 with the v3 target semantics. Every existing combination keeps its existing rule (`run.check_option_combination`, unchanged).

## 7. Capability links (`available_check`)

Each unresolved item of the v3 presentation carries `available_check`: zero, one or many candidates `{tool, args, scope, availability}`. A link is a **pure function** of the observations already shown, the capabilities already advertised and the static tool semantics (`TOOL_SEMANTICS`). It means "this offered tool may inspect this scope", never "it will resolve it", and it never carries, hints at or orders by a result. Availability is `available`, `unavailable` (advertised as not available, or the advertisement says the mode is not recorded or not possible), `unknown` (nothing advertised), `called` or `called_failed` (an equivalent call is already shown). Offsets: every advertised offset whose window intersects the unresolved interval, in the advertised order; `any` gives one template at the interval start; never an offset selected by a recorded result. Scopes no offered tool can inspect (the stream selection of a replayed window, EPUB body text beyond the shown heads, speech) have zero candidates. The remaining budget is not an input of a link.

## 8. Checking a prerequisite against an observation

A prerequisite is met only by a fact whose **statement kind and provenance** are allowed (`CHECKS` in `rubric.py`), whose **execution state and status** are allowed, whose **value** passes the named check, whose **scope** covers the claim and, for an action, whose subject is the **bound source or target**. Excluded, always: a clean decode or any integrity result for identity; a tag, a reported hash or a reported declaration for content; an absent field for an empty one; a request for a result. Checker outputs are prerequisite states (`met`, `unmet`, `unknown`) with the fact references that decided them; no checker or renderer emits `sufficient`, `solvable`, a recommended action, a truth or a label.

Identity comparison (generic, deterministic): values are case-folded, accents removed, non-alphanumerics collapsed. A content text **agrees** when it contains a catalog title, alias, alternate title or episode title as a token sequence, or an episode marker equal to the catalog's (after a case-supplied ordering); it **disagrees** when it is a typed title field, or carries an episode marker, that matches no catalog value; free text that mentions no catalog value is `not_comparable`, not disagreement.

## 9. Uncalled checks at the decision prefix

For a decision, the prefix is everything shown before it. An **uncalled available check** is a link candidate that is `available`, for an offered tool, with arguments valid for the advertisement, that repeats no call already made (and no call that failed, timed out or was unavailable), while the remaining budget at the decision is at least one. The count is a neutral observation about the transcript, never a recoverable error.
<!-- END FROZEN RUBRIC contract-v3-rubric-1 -->

## 10. Prototypes (experimental, not selectable)

All under `src/media_repair_harness/experimental/contract_v3/`; nothing outside `experimental/` imports them (tested), and `run.EVIDENCE_FORMATS` is still `('v2',)`.

| Module | What it does |
|---|---|
| `rubric.py` | the frozen rubric as data (`RUBRIC`, sha256 pinned): statement kinds, presence states, naming surfaces, material uncertainty M1 to M9, H1 to H4, identity levels, `CHECKS` (allowed and excluded kinds per check), diagnosis and action prerequisites, execution prerequisites, link and uncalled rules, forbidden output fields. Exported as JSON in `docs/contract-v3-prerequisites.json` |
| `presence.py` | the six presence states per typed field of every typed source (ffprobe, audiobook_inspect, epub_inspect, decode_sample, audio_sample, ocr, the live collectors, arr_lookup, prior_record), `not_checked` / `unknown` per source, and exactly the explicit empty / null / false / zero values that the v2 filters dropped (`evidence_v2.py` probe filter, audiobook filter, EPUB filter, decode `error_lines`) |
| `facts.py` | canonical atomic facts; the v3 presentation (`render`): items without per-item caveats, one `open` list of deduplicated unresolved statements with every source id and their `available_check`, facts with the explicit empties and a `presence` map, coverage and client comparison once, alerts and `open_total` on every page, paginated with the unchanged `pages-v1` code; `reassemble` and `facts_from_body` rebuild the canonical facts from the pages |
| `links.py` | typed open items (each v2 unresolved template mapped to a scope; coverage rows not checked) and the pure link function |
| `targets.py` | `decision-v3` validation (source binding, action-specific targets, executor-allocated copy), the all-or-nothing version check (no v3 element with prompts v1 to v5, v5 explicitly), and an audit v3 prototype that reports every prerequisite state and the execution prerequisites |
| `prereq.py` | the checker: each prerequisite against actual values, execution state, scope, kind and provenance; outputs states and references only |
| `uncalled.py` | the decision-prefix counter over recorded runs |

Offline scripts (no model call): `scripts/contract_v3_uncalled.py`, `scripts/contract_v3_tension.py`, `scripts/contract_v3_sizes.py`.

## 11. Tests

| File | Area | Tests |
|---|---|---|
| `tests/test_contract_v3_facts.py` | presence states (six-way, every typed source, live records, not_checked / unknown), explicit empties restored and only those, paired negatives, deduplication with every source kept, conflicts and diagnostics local, pagination reassembly at 8192 / 4096 / 2560 with alerts and `open_total` on every page, neutral wording, no verdict field, leakage | 15 |
| `tests/test_contract_v3_links.py` | links unchanged when uncalled clean / damaged / error recordings are swapped under the real advertisement, no result or budget input, advertised offsets only, zero / many / unknown / called / called_failed, template coverage, decision-prefix counting with arguments, budget, earlier calls and failures, page fetches | 7 |
| `tests/test_contract_v3_prereq.py` | frozen rubric and document digests, no full decode and no integrity identity in the rubric, no verdict field, damage and support grade by execution state (partial, error with cause tool, decoder_warning, unclassified), healthy without full decode and with the remainder still unchecked, identity from content but not from tags, reported hashes, reported declarations or clean decodes, free text not a disagreement, consistent identifier and title substitution, observation permutation, naming surface empty versus absent versus null / false / zero, edition fit, source binding verified / different / missing, convert without a destination and with an invented one, remap free / occupied / unstated slot, rename old and new values, version combinations, the machine-readable table equal to the rubric | 19 |
| `tests/test_contract_v3_baseline.py` | no production import of the prototypes, no v3 runner option, pinned dev-c4 / dev-c5 manifests, dev-c5 failed result kept, the 146 dev-c5 transcripts (both base runs; the restored views have identical transcripts) re-rendered offline with requests, decisions, guard outcomes, reference resolution, audit, capabilities, page logs and summaries equal to the records, and the 1101 dev-c4 records' guard outcomes reproduced, label-tension notes never read by any module | 7 |

Expected values are written by hand from the synthetic observations, or derived from the raw recorded observations; none is produced by the code under test.

## 12. Results

**Uncalled available checks at the decision prefix (dev-c5, `docs/contract-v3-uncalled.json`).** Counted from the model's own decision (before guards), the two base runs (the restored views share their transcripts):

| Run | Escalations | With at least one uncalled available check | Candidates counted | Escalations with no budget left |
|---|---|---|---|---|
| claude-haiku-5-5 | 34 | 8 | 20, all `decode_sample` (windows inside the unchecked time, or the recorded full decode) | 0 |
| qwen3.8:27b | 17 | 7 | 23, all `decode_sample` | 0 |

19 non-escalation decisions of each run also had one. These are transcript observations, not errors, and not a claim that calling the check would have changed the decision.

**Neutral label-tension list (`docs/contract-v3-label-tension.md`, id and reason only).** 6 of 73 public dev cases: `audiobook-identity-001`, `audiobook-identity-002`, `epub-identity-001`, `epub-identity-002`, `movie-identity-001` (the identity_mismatch label needs a content observation that disagrees with the catalog; the case holds only declarations or reported claims and no offered tool yields content; two of them also have no evidenced source binding for their blocklist-only label), and `audiobook-naming-001` (the rename-only label needs content-verified identity, which no offered tool yields). Labels are unchanged and the contract is not weakened; the evaluator decides.

**Size within the existing page limits (`docs/contract-v3-sizes.json`, the 73 dev-c5 first messages, same frame and page contract).** At 8192 bytes: v2 median 2569 / max 5439 bytes, v3 median 2877 / max 6836, one page each, 0 `PageBudgetError`. At 2560: v2 38 multi-page first messages, v3 54 (max 5 pages), 0 errors. v3 is larger mainly because of the `available_check` lists; smaller is not claimed.

## 13. Limits and open questions

* **Prototypes, not production.** Nothing here is wired into the runner, so no model has seen a v3 request, and the synthetic tests say nothing about scores. Wiring, a prompt that declares contract v3 (and explains `open`, `presence` and `available_check`), and any measurement are later stories.
* **Free-text identity is judged, not computed.** The checker compares typed fields and episode markers; free text that names no catalog value is `not_comparable`, so a different work named only in free text is `unknown` to the checker. The model's judgement remains necessary there.
* **Edition fit is by runtime only**; episode-order fit is not computed (two listed orders count as two candidates unless a choice settles them).
* **Source binding** reads the managing app's file record (`relativePath`, file id). A case whose catalog record names no file leaves binding `unknown`, which is what two of the tension entries report.
* **Q-01 stays open** (remap with identity_mismatch versus metadata_naming): the rubric accepts both, as v4 and the guards do.
* **M9** (a complaint whose subject no observation reaches) is stated as `unknown` by the checker: whether an observation reaches a free-text complaint is judged.
* The rubric text was written after the required reading of AUDIT-ASTRA-15, which names the truth of some dev cases; it names no case and contains no case-specific rule, and no suite label, truth field or scorer output was opened before the freeze commit `59e15d49`.
