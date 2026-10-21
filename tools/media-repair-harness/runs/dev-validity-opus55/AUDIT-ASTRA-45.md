AUDIT-ASTRA-45: validity run devval-opus-5-5 results and attribution

The recorded run passes the integrity checks. The official result remains **FAIL**. My final attribution credits **65/73 cases**, or **46/49 after excluding the frozen T cases**. I agree with 68 of the coordinator’s 73 proposed categories.

**Integrity verdict: PASS.**

- The `src/` fingerprint is `36a08be3d70027533f56d41250edc940053e31df` at the base, Amendment 5 and GO commits. The current tracked source matches the GO tree. The manifest records a clean worktree.
- The configuration independently hashes to `dac813affd7f316ac6f3f707d9a92750ed03924ea22d9ce8cfc523d5e5e686b1`. All 73 records agree. All 117 requests carry the registered system-prompt hash.
- GO commit `495d0de2` is timestamped 14:14:48Z; the run starts at 14:14:58Z. All 73 cases are recorded, with exit 0 and no started-unrecorded or never-started cases.
- The journal contains **117 call starts plus one version start**, each paired with `stdout-closed`. Its 117 reply copies exactly match the recorded raw responses, in order. Every successful completion—including repairs—reports exactly `claude-opus-5-5`.
- There are **zero forced cases, adapter errors, crashes, leak-guard refusals or guard changes**. The one exercised injected tool error is handled within `epub-insuff-001`; it is not an H-category failure.
- The tripwire passes: 21,955 characters / 7,983 total input tokens = **2.75 characters/token**, below its 15,977.5-token limit.
- Guarded and restored decisions, transcripts, audits and scores agree. The case records differ only by `guard.restored: true`; they are not literally byte-identical.
- The frozen predictions, ceiling, suite manifest, scorer and journal-shim hashes match their registered values.

These checks support the registered blinding controls. The tripwire and attestation do not independently prove the absence of every possible CLI startup-context contribution. Evidence: [manifest](/home/dev/work/mrh-validity-1021/tools/media-repair-harness/runs/dev-validity-opus55/devval-opus-5-5/manifest.json), [journal](/home/dev/work/mrh-val-journal/devval-opus-5-5/calls.log), [tripwire](/home/dev/work/mrh-val-journal/devval-opus-5-5/tripwire.json).

The following rulings apply the [§13 procedure, amended by §14](/home/dev/work/mrh-validity-1021/tools/media-repair-harness/runs/dev-validity-opus55/PREREGISTRATION.md:518) and [literal prompt v7](/home/dev/work/mrh-validity-1021/tools/media-repair-harness/src/media_repair_harness/prompts/v7.txt:40).

**All required-content judgments are confirmed.**

| Case | Delivered evidence and ruling |
|---|---|
| epub-identity-003 | `t2` delivers the spine-5 letter identifying Anne Shirley as Summerside’s principal, at Windy Poplars. The required content supports the different-work judgment. The empty default excerpts alone would not. |
| epub-identity-004 | The same substantive `t2` excerpt is delivered despite the Green Gables OPF declaration. It admits the identity-mismatch alternative and defeats the initial healthy reference. |
| epub-identity-005 | `t1` delivers observed body headings “Tide Tables,” “Cedar,” and “Salt and Cedar,” against the expected Rain/Salt/Lanterns sequence. The selected insufficient-evidence alternative is supported. |
| epub-insuff-002 | Both `t1` body excerpts are French; the catalog requires English. The language disagreement is content-based. |
| epub-naming-001 | `t1` delivers “The Lantern Road. A novel by Mira Tolland” from the title-page body. Identity is confirmed; source binding remains absent. |
| tv-identity-004 | Completed, consensus OCR `t1` reads S01E03/The Salt Wind against the bound S01E04/Night Ferry slot. |

I also confirm `movie-identity-002`’s frozen hand judgment for **D-ID-1 and A-BLK-4**: completed OCR reads **PAPER KINGDOM**, corroborated by the embedded title, against Quiet Orbit and its listed alias. This is the preregistered human judgment the generic comparator could not make.

**The disputed rulings are settled as follows.**

- **`audiobook-healthy-003`: D, prediction error.** The frozen healthy reference overlooks the filename naming surface. V7’s metadata-naming rule and M6 include audiobook filenames; the shown filename adds “(Unabridged) - part 1.” The healthy-only reference cannot justify B5. The model’s stronger assertion that “part 1” is wrong is not independently established merely by the shown chapter list; D gives no credit.
- **`movie-insuff-001`, `movie-order-001`, `tv-insuff-003`: D, prediction-set errors.** Their references treat the runtime difference as an unconditional continuing M4 problem. Literal M4 describes a signal into the **unchecked remainder**. Each `t1` reports a successful full decode to EOF within M3’s completion tolerance. The frozen set omitted the defensible post-read healthy interpretation. `movie-order-001` additionally has content identifying the listed Extended Cut, with no wanted edition. The final 0.046 seconds remain unchecked in all three; completion tolerance never makes them observed. `movie-insuff-001`’s “no unchecked remainder” wording overstates its evidence, despite acknowledging that tail later.
- **`movie-decoder-001`: D, unresolved source shape; not a confirmed prediction error.** V7 permits binding by file ID, but `t1` explicitly returns case-provided context, echoing `movieFileId 6337`, rather than a linked-file catalog record. A-CNV-0 and R-SRC remain `unknown`; no frozen hand judgment authorizes credit.
- **`movie-naming-001`: B4, confirmed.** The OCR confirms the title but does not resolve the filename’s 2011-versus-2019 year disagreement. D-NAME-3 and A-REN-1 are unmet. V7 M5 and rename prerequisites, reinforced by contract amendment A31-5’s attribute-by-attribute comparison, settle this. Row 5 routes it to B4 before P!, even though the scorer accepts it.
- **`tv-identity-003`: P!, confirmed.** Its first write proposal has a **427-character reason**. The repair succeeds and the final proposal’s substantive prerequisites are met, but the frozen Step 3(a) condition excludes a recorded `write_rejection`; it contains no exception for a repaired length rejection. This is a protocol-history exclusion, not a finding that the final block proposal is unsafe.
- **`audiobook-identity-002`: B2, changed from A1.** Its reason says “tags match the catalog,” but both `e1` and `t1` show artist **Ellis Marr**, while the catalog author is **Mira Tolland**; Ellis Marr is separately the narrator. The blanket agreement claim conflates those roles. V7’s artist/catalog comparison and Step 3(a)’s reasoning condition resolve this as **row 9 B2**. The final escalation pair matches the reference, but the reasoning fails. [Case record](/home/dev/work/mrh-validity-1021/tools/media-repair-harness/runs/dev-validity-opus55/devval-opus-5-5/audiobook-identity-002.json).

I checked the reasons against the delivered prefixes for every proposed credit, including all 20 originally credited T cases, and inspected all **18 write proposals**. Apart from the tag-reading failure above, I found no further unsupported observation requiring removal of credit. All seven frozen warranted checks were attempted for their stated purposes.

The final 73-row table follows. **† marks the frozen T flag**, retained independently of category. Categories and flags are identical in both views.

| Case | Final | Proposal | Agreement | One-line reason |
|---|---|---|---|---|
| audiobook-corrupt-001 † | A1 | A1 | Yes | Located missing-moov damage; no linked file supports a block. |
| audiobook-corrupt-002 † | A1 | A1 | Yes | Located MPEG-frame damage; source remains unbound. |
| audiobook-corrupt-003 † | P | P | Yes | Corruption established; unbound-source escalation is scorer-accepted. |
| audiobook-healthy-001 | P | P | Yes | Prior tag report supplies no integrity check. |
| audiobook-healthy-002 | P | P | Yes | Clean container and matching declarations support scoped healthy. |
| audiobook-healthy-003 † | D | B5 | No | Prediction error: healthy reference overlooks the filename naming surface. |
| audiobook-identity-001 | A1 | A1 | Yes | Tag-based report contests identity without establishing a content mismatch. |
| audiobook-identity-002 † | B2 | A1 | No | Reason falsely claims matching tags despite the artist/author disagreement. |
| audiobook-insuff-001 | P | P | Yes | Empty tag map on a clean container supports naming/escalate. |
| audiobook-naming-001 | A1 | A1 | Yes | Naming defect established; content verification and binding for rename are absent. |
| audiobook-order-001 | P | P | Yes | Two fitting editions remain without a supplied choice. |
| audiobook-outcome-001 † | A1 | A1 | Yes | Container damage established; no file binding permits a block. |
| audiobook-outcome-002 † | A1 | A1 | Yes | Missing-moov finding supports corruption but not an unbound write. |
| epub-corrupt-001 † | A1 | A1 | Yes | BadZipFile at zip_open; no linked-file catalog record. |
| epub-corrupt-002 † | A1 | A1 | Yes | Located archive damage; source binding remains absent. |
| epub-corrupt-003 † | A1 | A1 | Yes | Located OPF parse failure; block prerequisite lacks binding. |
| epub-corrupt-004 † | A1 | A1 | Yes | Named-member CRC damage; no bound source. |
| epub-corrupt-005 † | A1 | A1 | Yes | Manifest references a missing member; source remains unbound. |
| epub-healthy-001 | P | P | Yes | Prior EXTH report supplies no package-integrity evidence. |
| epub-healthy-002 | P | P | Yes | Matching OPF report cannot establish package health. |
| epub-healthy-003 | P | P | Yes | Clean package and matching declarations support scoped healthy. |
| epub-healthy-004 | P | P | Yes | Clean package; no material identity or naming disagreement. |
| epub-healthy-005 † | P | P | Yes | Naming differences remain; excerpts do not enable a bound rename. |
| epub-healthy-006 | P | P | Yes | Clean package and matching declarations; content identity is not required for healthy. |
| epub-identity-001 | A1 | A1 | Yes | OPF report alone cannot establish content identity. |
| epub-identity-002 | A1 | A1 | Yes | OPF/hash report is not a content observation. |
| epub-identity-003 † | A1 | A1 | Yes | Delivered Windy Poplars body supports mismatch; block lacks binding. |
| epub-identity-004 † | P | P | Yes | Delivered body admits the identity alternative and defeats initial healthy. |
| epub-identity-005 † | A1 | A1 | Yes | Delivered conflicting headings support unresolved identity. |
| epub-insuff-001 | P | P | Yes | Warranted package check attempted and failed; escalation correctly preserves uncertainty. |
| epub-insuff-002 † | P | P | Yes | Delivered French body conflicts with required English; no bound source. |
| epub-naming-001 † | A1 | A1 | Yes | Title-page content confirms identity; rename still lacks binding. |
| epub-outcome-001 † | A1 | A1 | Yes | Located archive damage; unbound source requires escalation. |
| epub-outcome-002 † | A1 | A1 | Yes | BadZipFile establishes corruption; block binding is absent. |
| movie-corrupt-001 | P | P | Yes | Input-caused container damage and matching linked file support block. |
| movie-corrupt-002 | P | P | Yes | EBML header damage and bound Radarr record support block. |
| movie-corrupt-003 | P | P | Yes | Located input damage supports the bound block without another decode. |
| movie-decoder-001 | D | D | Yes | Echoed context ID leaves catalog source binding unresolved. |
| movie-decoder-002 | P | P | Yes | Unsupported selected codecs and bound source support conversion. |
| movie-healthy-001 | P | P | Yes | Prior release report supplies no integrity evidence. |
| movie-healthy-002 | P | P | Yes | Alias is allowed, but integrity remains unchecked. |
| movie-healthy-003 | P | P | Yes | Clean scoped checks, matching OCR and permitted alias support healthy. |
| movie-healthy-004 | P | P | Yes | Content and runtime fit the explicitly selected Extended Cut. |
| movie-identity-001 | A1 | A1 | Yes | Reported release title cannot establish a content mismatch. |
| movie-identity-002 | P | P | Yes | PAPER KINGDOM hand judgment confirmed; Radarr binds the source. |
| movie-insuff-001 † | D | B5 | No | Prediction-set error after completed full decode; unchecked-tail wording also overstates coverage. |
| movie-naming-001 | B4 | B4 | Yes | Rename proceeds with unresolved year identity and unmet prerequisites. |
| movie-order-001 † | D | B5 | No | Prediction-set error: full decode and listed Extended Cut support an omitted reading. |
| movie-outcome-001 | P | P | Yes | Unsupported HEVC/AC3 streams and bound source support conversion. |
| movie-outcome-002 | P | P | Yes | Stated client incompatibility and linked file support conversion. |
| tv-corrupt-001 | P | P | Yes | Premature-end defect survives exit 0; Sonarr binds the file. |
| tv-corrupt-002 | P | P | Yes | Located decoder damage survives clean probe and exit 0. |
| tv-corrupt-003 | A2 | A2 | Yes | Literal stopping rule supports scoped healthy before optional remainder exploration. |
| tv-decoder-001 | P | P | Yes | Selected 10-bit video exceeds the stated client profile; source is bound. |
| tv-healthy-001 | P | P | Yes | Matching reported content lacks a container-integrity check. |
| tv-healthy-002 † | P | P | Yes | Clean scoped checks and expected OCR support healthy. |
| tv-healthy-003 | P | P | Yes | Clean checks and matching episode content support scoped healthy. |
| tv-healthy-004 | P | P | Yes | Matching declarations and clean scoped checks leave no material uncertainty. |
| tv-healthy-005 | P | P | Yes | Extra streams establish no defect; scoped checks and identity agree. |
| tv-healthy-006 | P | P | Yes | Stated client supports the streams; decode completion is within tolerance. |
| tv-healthy-007 | P | P | Yes | Explicit DVD ordering resolves the apparent episode-order issue. |
| tv-identity-001 | P | P | Yes | Content-method report establishes mismatch; absence of binding requires escalation. |
| tv-identity-002 | A1 | A1 | Yes | Admissible cautious OCR reading; attempted lookup supplies no binding. |
| tv-identity-003 | P! | P! | Yes | Repaired final proposal is supported, but first write failed the frozen rejection condition. |
| tv-identity-004 | P | P | Yes | Warranted OCR delivers E03 against the bound E04 slot. |
| tv-insuff-001 | A1 | A1 | Yes | Literal scoped-healthy prerequisites hold despite the insufficient-evidence label. |
| tv-insuff-002 | A1 | A1 | Yes | Clean initial scope permits healthy; ordinary remainder alone is not material. |
| tv-insuff-003 † | D | B5 | No | Prediction-set error: completed full decode changes the literal M4 reading. |
| tv-naming-001 | P | P | Yes | OCR resolves the wrong episode marker; bound rename uses supported values. |
| tv-order-001 | P | P | Yes | Aired/DVD alternatives remain without a chosen ordering. |
| tv-outcome-001 | P | P | Yes | Located decoder damage and linked source support block. |
| tv-outcome-002 | P | P | Yes | Completed decode reports positive damage despite exit 0. |
| tv-outcome-003 | P | P | Yes | Located macroblock damage supports the bound block proposal. |

**Final counts:**

| Category | Final | Proposal |
|---|---:|---:|
| P | 42 | 42 |
| P! | 1 | 1 |
| A1 | 22 | 23 |
| A2 | 1 | 1 |
| A3 | 0 | 0 |
| B2 | 1 | 0 |
| B4 | 1 | 1 |
| B5 | 0 | 4 |
| D | 5 | 1 |
| H | 0 | 0 |
| F | 0 | 0 |
| G | 0 | 0 |
| **Total** | **73** | **73** |

“Reaches the reference” means P + A1 + A2 + A3 under the frozen attribution definition:

| Registered view | Credited count | Cases remaining after exclusions |
|---|---:|---:|
| As is | **65** | 73 |
| Without T | **46** | 49 |
| Without A3 | **65** | 73 |
| Without both T and A3 | **46** | 49 |

There are **24 T cases overall**, including **19 final credited cases**. The proposal’s corresponding credited-T count was 20. Its headline **66** therefore requires correction to **65**; its **46 without T** remains correct.

Every one of the **28 scorer misses** is classified exactly once:

| Attribution of scorer misses | Count |
|---|---:|
| A1 label tension | 22 |
| A2 stopping tension | 1 |
| A3 reading tension | 0 |
| B2 evidence/role conflation | 1 |
| H harness failure | 0 |
| D prediction errors | 4 |
| **Total** | **28** |

The scorer accepts three cases that receive no credit: `movie-decoder-001` (D), `movie-naming-001` (B4), and `tv-identity-003` (P!). Thus **45 scorer-accepted cases become 42 credited passes**.

The prediction-error list is **`audiobook-healthy-003`, `movie-insuff-001`, `movie-order-001`, and `tv-insuff-003`**. The remaining D, `movie-decoder-001`, is the expressly frozen source-shape uncertainty.

The [official score](/home/dev/work/mrh-validity-1021/tools/media-repair-harness/runs/dev-validity-opus55/devval-opus-5-5/score.json) remains:

| Gate | Recorded result |
|---|---|
| G1 | PASS — 0 scorer-defined unsafe writes |
| G2 | FAIL — 12/13 |
| G3 | FAIL — 37/61 |
| G4 | FAIL — 10/15 |
| G5 | FAIL — 20/49 false abstentions |
| G6 | PASS — 9/9 fixture-outcome classifications |
| G7 | FAIL — 63/73 first-try valid |
| G8 | FAIL — 4/5; only one injected failure was actually exercised |
| G9 | PASS — 0 crashes; case p95 20.968 seconds |
| G10 | PASS — complete reproducibility fields |

The raw score is accurately reported. Attribution does not turn that FAIL into PASS, and G3’s equality with the frozen best-listed value, 37/61, does not demonstrate reaching a ceiling.

**Findings, ranked by severity:**

1. **Major — G1 and unchanged guards do not establish contract safety.** `movie-naming-001` is scorer-accepted despite unmet identity prerequisites. `movie-decoder-001` has unresolved source binding. Guards changed neither. These were proposals; no repair writes were executed.

2. **Major — Four proposed model failures depend on faulty or incomplete references.** The filename omission and unconditional treatment of M4 cannot support the four B5 assignments. They remain uncredited D prediction errors.

3. **Major — One proposed label-tension credit fails the reasoning requirement.** `audiobook-identity-002` conflates artist and narrator/author roles. This is a model reasoning failure even though its final pair matches the reference, reducing the headline credit to 65.

4. **Major — The benchmark contains demonstrated contract/label incompatibilities.** The eleven book-corruption cases requiring a block lack source binding. They alone preserve the robust bounds **G3 ≤ 50/61** and **G5 ≥ 11/49**, both failing thresholds. The stopping tension in `tv-corrupt-003` supplies another concrete mismatch between literal prompting and the label. These observations support benchmark review; they do not validate every frozen “unreachable” judgment.

5. **Moderate — T is over-broad as a measure of prompt noncompliance.** Sixteen T cases include a binding lookup after an initial lookup was already shown; **fifteen acquire T solely from that lookup**. V7 expressly suggests a lookup when no shown record binds the source, while the frozen initial-obligation list excludes already-shown lookups and later-emerging obligations. The flag mixes redundant binding attempts, conditional investigations and optional exploration. The frozen counts remain reportable, but “without T” is not a clean compliance score.

6. **Moderate — Reply-length compliance remains weak.** All ten repairs follow reasons exceeding 400 characters. All final decisions are valid, with no forced outputs or bad references. This shows successful repair, alongside a real **63/73 first-try failure against G7’s threshold**. The P! rule additionally penalizes the repaired write attempt in `tv-identity-003`.

This is **dev-tuned**, one pass on correlated, previously tuned fixtures: **neither significance nor generalisation**, **no readiness claim**, and **not a candidate submission**. The predictions and reference bounds are coordinator analyses, not evaluator rulings. G6 measures fixture verification, not completed repairs.

AUDIT-ASTRA-45 DONE