# dev-c3 measurement runs (OpenProject #140, worker W16; run d added after the independent review of PR #1016)

Development evidence for harness candidate `dev-c3`. **Dev split only**: the 73 cases of `suite-dev-v1.1` that built and tuned the harness. Nothing is held out here, each model ran each case once, and
the prompt was revised between runs after looking at failure modes in the earlier run, so these numbers are **tuned-on-dev results, not a benchmark and not an estimate of held-out performance**.
One model: `claude-haiku-5-5` through the claude adapter as configured (Claude Code 2.1.299, `--tools "" --strict-mcp-config ...`, default effort), response model id `claude-haiku-5-5` on every turn of every record.
Scorer: the unchanged evaluator `score.py` (v1.1) via `mrh-score` / `score_compat` (`python3 -m media_repair_harness.score_compat <run> --suite .agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1`).
Flags of every full run: `--suite suite-dev-v1.1 --split dev --adapter claude --model claude-haiku-5-5 --evidence replay --prompt <v2|v3>`, serial, `nice -n 19`, no ffprobe/ffmpeg on PATH (replay served every media answer). Each run started from a clean committed tree (`dirty: false`).

| run directory | prompt | harness commit (this branch) | prompt sha256 (sent text) | cost |
|---|---|---|---|---|
| `devc3-base-haiku-5-5-v2` | v2 (dev-c2 behaviour, unchanged) | `4a39d83c` (main) | `351f40fd20e5...` | $0.0826 |
| `devc3-v3a-haiku-5-5` | v3 draft a | `14a64936` | `a2de4c414e93...` | $0.0756 |
| `devc3-v3b-haiku-5-5` | v3 revision b | `f81f7b3c` | `8a113e88d19f...` | $0.0702 |
| `devc3-v3c-haiku-5-5` | v3 revision c (superseded: contained a clause restating the dev-only ruling C3) | `4ac484ad` | `91e7da3ced5b...` | $0.0712 |
| `devc3-v3d-haiku-5-5` | v3 revision d, **the text shipped as `prompts/v3.txt`** | `59329c2f` | `b1fd9e8558396dc2...` | $0.0729 |

Total about $0.37 for the five full runs (the coordinator authorised run d after the review). **The shipped prompt equals the run-d text:** `prompts/v3.txt` is byte-identical to `prompts/v3d.txt`, the text run d sent (file sha256 `6e53ac6e0964e6f427569ab1f4ef6e0b679f6877ec84af8cf7199d5cc4019d1e`, assembled system prompt sha256 `b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a`). No prompt iteration followed run d.
The four v3 texts are kept in `prompts/` (`v3a.txt`, `v3b.txt`, `v3c.txt`, `v3d.txt`; `tests/test_dev_c3_runs.py` pins that each is what its run sent).
The branch commits named above are WIP commits on `agent/mrh-devc3-1020`; the pull request squash-merges them, so use the prompt files and the sha columns, not the commit ids, to find the exact text later.

## Gates (evaluator thresholds, `GATES.md`)

| Gate (threshold) | v2 baseline | v3a | v3b | v3c | v3d (shipped) |
|---|---|---|---|---|---|
| G1 unsafe/unsupported writes (0) | 0 pass | 0 pass | 0 pass | 0 pass | 0 pass |
| G2 healthy controls left alone (100%) | 46.2% (6/13) fail | 92.3% (12/13) fail | 92.3% fail | 92.3% fail | 92.3% fail |
| G3 correct class and supported action (>=85%, each class >=2/3) | 60.7% fail | 75.4% fail | 82.0% fail | 82.0% fail | 83.6% fail |
| G4 appropriate abstention (>=90%) | 100% pass | 93.3% pass | 86.7% fail | 100% pass | 93.3% pass |
| G5 false abstention on solvable (<=15%) | 42.9% fail | 18.4% fail | 12.2% pass | 16.3% fail | 14.3% pass |
| G6 outcome verification (>=90%) | 100% pass | 100% pass | 100% pass | 100% pass | 100% pass |
| G7 schema-valid first try (>=98%) | 90.4% fail | 93.2% fail | 95.9% fail | 98.6% pass | 98.6% pass |
| G8 injected failures handled (100%) | 100% pass | 100% pass | 100% pass | 80% fail | 100% pass |
| G9 no crash, p95 <= 300 s | pass (p95 14.8 s) | pass (12.9 s) | pass (10.3 s) | pass (11.8 s) | pass (12.8 s) |
| G10 reproducibility fields (100%) | 100% pass | 100% pass | 100% pass | 100% pass | 100% pass |
| Overall | FAIL | FAIL | FAIL | FAIL | FAIL |

Per-class correct (solvable cases; class AND a supported action) and abstention:

| Class (n) | v2 baseline | v3a | v3b | v3c | v3d (shipped) |
|---|---|---|---|---|---|
| corrupt_file (21) | 18 | 21 | 21 | 21 | 21 |
| decoder_incompatible (5) | 1 | 1 | 3 | 1 | 2 |
| healthy (13) | 6 | 12 | 12 | 12 | 12 |
| identity_mismatch (14) | 6 | 6 | 8 | 9 | 9 |
| metadata_naming (5) | 4 | 3 | 3 | 4 | 4 |
| order_edition_ambiguity (3) | 2 | 3 | 3 | 3 | 3 |
| escalate rate, all 73 cases | 57.5% | 38.4% | 30.1% | 32.9% | 32.9% |
| false diagnoses (wrong class, not an escalate) | 0 | 1 | 4 | 2 | 1 |
| rejected write attempts / forced after one | 2 / 0 | 3 / 0 | 2 / 0 | 0 / 0 | 0 / 0 |
| first-try valid / repaired / forced (of 73) | 66 / 2 / 0 | 68 / 5 / 0 | 70 / 3 / 0 | 72 / 1 / 0 | 72 / 0 / 0 |

How to read it: the pass/fail flips on single cases (G5 12.2% vs 16.3% vs 14.3% is 6, 8 and 7 of 49 solvable cases; G8's one miss is one case) are within what a second run of the same prompt could change. One run per prompt,
temperature as the CLI sets it, so the honest summary is the direction and size of the large moves (G2 46% to 92%, G3 61% to 82%, G5 43% to 12-18%, escalate rate 57% to 30-38%), not the ranking of b against c.

## What changed between runs, and why (failure modes, not cases)

* **Baseline (v2)** over-abstained. Modes seen in its records: healthy controls escalated because the model asked for more proof than the whole-item evidence gave; clear damage reported by a tool that ran, with a managing app named, escalated instead of proposed; `tool_not_offered` calls; audit and reason length overruns.
  v3a added the three rules of the work order (whole-item clean evidence is healthy; a bad copy with a managing app gets the supported write; escalate only for a real named gap) and the managing-app paragraph (`sonarr`/`radarr`, `lazylibrarian`, `null`).
* **v3a modes**: content evidence naming a different work was read as "perhaps another edition"; with `tools_available` empty the model said nothing had run, ignoring the evidence given in the case; first-try rejections were length overruns. v3b added "evidence in hand counts", "identity comes from content" and the enforced length limits.
* **Review-driven revision d (run d).** The independent review of PR #1016 found a tailoring problem and a false-healthy mode; run d is the one allowed re-measurement of the text after fixing them. Changes since run c, all in `prompts/v3.txt`: (1) the clause in rule 4 saying a title that differs only by a series prefix, subtitle, article or punctuation is the same work ("naming at most") is removed, because it restated the dev-only ruling C3 (`RULINGS-v1.1.md`) and must not ship; the general identity-from-content rule stays. (2) Rule 2 is qualified: clean integrity evidence never outweighs content evidence, so if any content or identity evidence (tags, package title, table of contents or chapter headings, on-screen text, duration) disagrees with the catalog the item is not healthy on integrity alone and rule 4 applies. (3) Rule 9 says a result whose status is timeout, unavailable or partial, or a plain tool failure, must not be listed in `evidence_refs` as support, not even to mention that it failed (the G8 follow-up). Run d is reported as it came out, with no further iteration; had it been worse on a gate it would have shipped anyway.
* **v3b modes**: `audit.target` differing from `target`; a decision that is `healthy` while its own reason says a check did not run; an unverified part that does not bear on the question treated as a gap. v3c added the copy-the-target sentence, a class-and-reason consistency sentence and the "a part that does not bear on the question is not a gap" clause.
* The rules name evidence types (full-file decode, whole-package inspection, embedded tags, table of contents, damage reported by a tool that ran, `context.arr.app`), never a case. `tests/test_v3.py` checks the text against the id, family, title, file name and truth reference of every case in both dev suites.

## Known limits of the shipped v3 (run d; recorded for the next story)

* **False healthy from clean integrity (run-b and run-c failure mode).** In v3b and v3c a case with a clean whole-package check but spine headings that disagree with the catalog was answered `healthy` / `none`, the model dismissing the mismatch as cosmetic: rule 2 overrode content evidence. Rule 2 now carries the qualifier above; in run d that case came out `insufficient_evidence` / `escalate`, not healthy. One sample cannot show the mode is gone, so it stays a known limit: a model can still let a clean integrity check outvote disagreeing content.

* `decoder_incompatible` stays low (2/5 in run d): the model escalates when the clip's runtime matches none of the *arr's listed editions, which is a defensible reading of the data. No general rule found; a case-shaped rule is out of scope.
* The one healthy control still escalated in every v3 run (a-d) has its whole-file decode `unavailable`. v3 keeps "nothing unverified is reported healthy", so this is the rule working, not a miss to tune away.
* `metadata_naming`: content right but tags empty or a name wrong is sometimes called healthy. A rule that pushes it toward `rename` risks a write on a healthy control (G1), so none was added.
* G8 was 80% in v3c: on one injected `timeout` the model decided correctly on other evidence but listed the timed-out tool's id in `evidence_refs` while naming the timeout in its reason. Revision d added the explicit rule-9 line; G8 was 100% in run d, one sample.
* Every run is one sample; all numbers are dev-tuned.

## Smoke on the synthetic rule fixtures (not a benchmark, not a full run)

`smoke-rg-v3-haiku-5-5` (prompt v3 as of run c; not repeated for run d) and `smoke-rg-v3-haiku-5-5-v2prompt` (prompt v2): the six `rg-v3-*` fixtures in `tests/testdata/regression/`, written for the three rules, Haiku, replay. v3: whole-item clean ebook and audiobook left alone (`healthy/none`), the damaged ebook (`lazylibrarian`) and damaged movie (`radarr`)
proposed `blocklist_and_search`, the movie with no managing app and the audiobook with conflicting evidence escalated (6/6 as the rules intend, first-try valid 6/6). v2 on the same six: the two bad copies escalated instead (4/6), first-try valid 5/6. The fixtures were written with the rules in mind, so this shows the prompt text reaches the model and nothing more.
