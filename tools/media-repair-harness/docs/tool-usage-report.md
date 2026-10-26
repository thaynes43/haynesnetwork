# Per-tool usage report (OpenProject #207)

Reproduce (from the repository root; stdlib only, no model, no network):

```
python3 tools/media-repair-harness/scripts/tool_usage_report.py \
  --runs-root tools/media-repair-harness/runs/dev-c3 \
  --runs-root tools/media-repair-harness/runs/dev-c4 \
  --runs-root tools/media-repair-harness/runs/dev-c5 \
  --runs-root tools/media-repair-harness/runs/dev-c6 \
  --runs-root tools/media-repair-harness/runs/dev-c7 \
  --runs-root tools/media-repair-harness/runs/dev-c7-qwen-r2 \
  --suite-dir .agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1 \
  --suite-dir .agents/context/media-repair-harness-2026-10-19/suite \
  --out-md tools/media-repair-harness/docs/tool-usage-report.md \
  --out-json tools/media-repair-harness/docs/tool-usage-report.json
```

## Summary

- Scope: 5 full local-model runs (muse-glimmer:30b x1, qwen3.8:27b x4), 365 cases scored in all, suite dev-v1.1; the partial dev-c7 qwen run is left out. Correlation only.
- muse-glimmer:30b (runs: 1) calls, as cases called of cases offering the tool, with total calls and the share of results with status ok: ffprobe 33 of 45, 33 calls, 91%; arr_lookup 28 of 62, 28 calls, 100%; decode_sample 28 of 34, 29 calls, 90%; epub_inspect 17 of 17, 18 calls, 50%; audiobook_inspect 11 of 11, 13 calls, 54%; frame_sample 4 of 34, 4 calls, 75%; ocr 4 of 34, 4 calls, 75%. An error status is often a real finding (a damaged file), not a tool fault.
- qwen3.8:27b (runs: 4) calls, as cases called of cases offering the tool, with total calls and the share of results with status ok: audiobook_inspect 42 of 44, 42 calls, 57%; decode_sample 36 of 136, 42 calls, 71%; arr_lookup 30 of 248, 30 calls, 100%; epub_inspect 21 of 68, 24 calls, 71%; ocr 16 of 136, 20 calls, 95%; frame_sample 8 of 136, 9 calls, 67%; ffprobe 2 of 180, 2 calls, 100%.
- Only reachable by asking (the case supplies no output of that type): audiobook_inspect called in 53 of 55 offering cases; frame_sample called in 12 of 170 offering cases.
- Output already supplied up front in at least 90% of the offering cases, so zero calls is not zero use: arr_lookup (supplied in 290 of 310; still called in 58 cases, 42 of them with the output already shown); decode_sample (supplied in 155 of 170; still called in 64 cases, 58 of them with the output already shown); epub_inspect (supplied in 80 of 85; still called in 38 cases, 33 of them with the output already shown); ffprobe (supplied in 225 of 225; still called in 35 cases, 35 of them with the output already shown).
- Never offered in any scanned run: audio_sample (offered in none of the 1762 records scanned, as-run and restored; suites offer it in: 45 cases in dev-v1, 0 cases in dev-v1.1; 2 requests for it were answered unavailable); subtitle_sample (offered in none of the 1762 records scanned, as-run and restored; suites offer it in: 0 cases in dev-v1, 0 cases in dev-v1.1).
- Outcomes that go with use (correlation; a model may call because a case looks hard; flagged at a gap of 10 points or more with 10 or more cases each side): muse-glimmer:30b arr_lookup: correct 24/28 (86%) when called vs 25/34 (74%) when offered and not called; qwen3.8:27b arr_lookup: correct 22/30 (73%) when called vs 188/218 (86%) when offered and not called. The two models point opposite ways for arr_lookup.
- Wrong-episode/wrong-content (identity_mismatch, all 14 cases per run), muse-glimmer:30b correct by round: dev-c4 13/14; misses in all: 1, of which 0 named identity_mismatch but chose an unsupported action (0 escalated). On the 4 tv identity run-cases it made 1 arr_lookup, 2 decode_sample, 2 ffprobe, 1 frame_sample, 1 ocr; output was supplied up front for arr_lookup in 2, decode_sample in 3, ffprobe in 3, ocr in 2, prior_record in 1.
- Wrong-episode/wrong-content (identity_mismatch, all 14 cases per run), qwen3.8:27b correct by round: dev-c4 13/14; dev-c5 11/14 (11/14 with guards undone); dev-c6 6/14 (6/14 with guards undone); dev-c7-qwen-r2 6/14 (6/14 with guards undone); misses in all: 20, of which 11 named identity_mismatch but chose an unsupported action (11 escalated). On the 16 tv identity run-cases it made 6 arr_lookup, 2 frame_sample, 7 ocr; output was supplied up front for arr_lookup in 8, decode_sample in 12, ffprobe in 12, ocr in 8, prior_record in 4.
- For the tool-lift run: the clean on/off arms are the call-only tools (audiobook_inspect, frame_sample); ocr is supplied in only part of its cases (65 of 170), so its arm mixes both effects. For arr_lookup, decode_sample, epub_inspect, ffprobe switching calls off leaves the supplied output in place, so an arm that also hides it is a separate, larger experiment to decide on purpose. audio_sample and subtitle_sample need fixtures with replay data before any arm.
- Frontier models for comparison: claude-haiku-5-5 272 calls over 9 full runs (flagged: arr_lookup correct 6/36 (17%) when called vs 412/522 (79%) when not, audiobook_inspect correct 37/59 (63%) when called vs 30/40 (75%) when not; mixes rounds, see caveats); gpt-6-astra 75 calls over 2 full runs (flagged: arr_lookup correct 7/38 (18%) when called vs 67/86 (78%) when not; mixes rounds, see caveats) (section 4).

## Caveats (read before any number below)

- One pass per model and round: a single sample, so a difference of a few cases is noise.
- The dev suite is dev-tuned: its fixtures and the harness were shaped against these cases. This says nothing about held-out or production media.
- Replay evidence: tool output was recorded earlier and played back. A model that calls a tool gets the recorded result, not a live one.
- Prompt, evidence format, guards and tool behaviour changed between rounds (columns in section 1), so runs are not repeats of one setup.
- Which tools a case offers depends on its media type, and models call more when a case looks hard, so called-vs-not-called correctness is confounded by difficulty and class.
- The decision guards (G-healthy, G-write) can overturn a decision depending on which checks ran. The primary runs are as-run (guards on). Guards-undone figures come from the paired `-restored` runs and are labelled as such.
- No causal claim, no readiness claim, no claim about held-out performance.

## 1. Runs covered

Counts below are counts of per-case record files in the named directory (`tools/media-repair-harness/runs/...`). `restored` is the paired `<run>-restored` directory, if one exists.

| run | role | model | harness | configuration | cases | correct (as run) | correct (guards undone) | forced | protocol violations | cases with zero / some calls |
|---|---|---|---|---|---|---|---|---|---|---|
| dev-c3/devc3-base-haiku-5-5-v2 | frontier | claude-haiku-5-5 | dev-c2 | prompt v2, format default, guards off | 73 | 49/73 | no restored run | 0 | 5 | 38 / 35 |
| dev-c3/devc3-v3a-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c3 | prompt v3, format default, guards off | 73 | 58/73 | no restored run | 0 | 0 | 46 / 27 |
| dev-c3/devc3-v3b-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c3 | prompt v3, format default, guards off | 73 | 60/73 | no restored run | 0 | 0 | 47 / 26 |
| dev-c3/devc3-v3c-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c3 | prompt v3, format default, guards off | 73 | 61/73 | no restored run | 0 | 0 | 47 / 26 |
| dev-c3/devc3-v3d-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c3 | prompt v3, format default, guards off | 73 | 63/73 | no restored run | 0 | 1 | 51 / 22 |
| dev-c4/devc4-v4g-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c4 | prompt v4, format default, guards v1 | 73 | 61/73 | no restored run | 0 | 1 | 45 / 28 |
| dev-c4/devc4-v4g-muse-glimmer-30b | local | muse-glimmer:30b | dev-c4 | prompt v4, format default, guards v1 | 73 | 60/73 | no restored run | 0 | 0 | 11 / 62 |
| dev-c4/devc4-v4g-qwen3.8-27b | local | qwen3.8:27b | dev-c4 | prompt v4, format default, guards v1 | 73 | 66/73 | no restored run | 0 | 0 | 46 / 27 |
| dev-c5/devc5-b-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c5 | prompt v5, format v2, guards v3 | 73 | 53/73 | 53/73 | 0 | 0 | 48 / 25 |
| dev-c5/devc5-b-qwen3.8-27b | local | qwen3.8:27b | dev-c5 | prompt v5, format v2, guards v3 | 73 | 60/73 | 56/73 | 0 | 0 | 43 / 30 |
| dev-c6/devc6-gpt-6-astra | frontier | gpt-6-astra | dev-c6 | prompt v6, format v3, guards v3 | 73 | 43/73 | 43/73 | 0 | 0 | 45 / 28 |
| dev-c6/devc6-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c6 | prompt v6, format v3, guards v3 | 73 | 43/73 | 43/73 | 1 | 0 | 51 / 22 |
| dev-c6/devc6-qwen3.8-27b | local | qwen3.8:27b | dev-c6 | prompt v6, format v3, guards v3 | 73 | 61/73 | 59/73 | 0 | 0 | 46 / 27 |
| dev-c7-qwen-r2/devc7r2-qwen3.8-27b | local | qwen3.8:27b | dev-c7 | prompt v7, format v3.1-format, guards v3 | 73 | 60/73 | 59/73 | 0 | 0 | 35 / 38 |
| dev-c7/devc7-gpt-6-astra | frontier | gpt-6-astra | dev-c7 | prompt v7, format v3.1-format, guards v3 | 73 | 45/73 | 45/73 | 0 | 0 | 44 / 29 |
| dev-c7/devc7-haiku-5-5 | frontier | claude-haiku-5-5 | dev-c7 | prompt v7, format v3.1-format, guards v3 | 73 | 40/73 | 40/73 | 2 | 0 | 42 / 31 |
| dev-c7/devc7-qwen3.8-27b | local | qwen3.8:27b | dev-c7 | prompt v7, format v3.1-format, guards v3 | PARTIAL 5 of 73 (cannot read /api/ps (1); refusing to touch the GPU blind) | 4/5 | 4/5 | 1 | 0 | 3 / 2 |

Integrity: every record's `case_sha256` equals the sha256 of the suite case file, and every record's own capability list equals the suite `tools_available` in all 17 primary runs.

Restored runs: used only in the "guards undone" columns. Where a primary run has no restored sibling its guards-undone figure is unavailable (dev-c3 ran without guards).

## 2. What each suite offers, and tools never offered

**Suite dev-v1.1** (73 cases, `.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1`)

| tool or evidence type | cases offering it (tools_available) | cases carrying pre-supplied evidence of that type |
|---|---|---|
| ffprobe | 45 | 45 |
| decode_sample | 34 | 31 |
| frame_sample | 34 | 0 |
| audio_sample | 0 | 0 |
| ocr | 34 | 13 |
| epub_inspect | 17 | 16 |
| audiobook_inspect | 11 | 0 |
| arr_lookup | 62 | 58 |
| subtitle_sample | 0 | 0 |
| prior_record | 0 | 13 |

**Suite dev-v1** (73 cases, `.agents/context/media-repair-harness-2026-10-19/suite`)

| tool or evidence type | cases offering it (tools_available) | cases carrying pre-supplied evidence of that type |
|---|---|---|
| ffprobe | 45 | 45 |
| decode_sample | 34 | 31 |
| frame_sample | 34 | 0 |
| audio_sample | 45 | 0 |
| ocr | 34 | 13 |
| epub_inspect | 17 | 16 |
| audiobook_inspect | 11 | 0 |
| arr_lookup | 62 | 58 |
| subtitle_sample | 0 | 0 |
| prior_record | 0 | 13 |

**Offers and requests per tool across every scanned record (as-run and restored); zero in the offer column is a tool never offered**

| tool | cases offering it, by suite | records whose capability list offered it | requests for it by a model | records scanned |
|---|---|---|---|---|
| ffprobe | dev-v1.1: 45, dev-v1: 45 | 1088 | 37 | 1762 |
| decode_sample | dev-v1.1: 34, dev-v1: 34 | 816 | 285 | 1762 |
| frame_sample | dev-v1.1: 34, dev-v1: 34 | 816 | 27 | 1762 |
| audio_sample | dev-v1.1: 0, dev-v1: 45 | 0 | 2 | 1762 |
| ocr | dev-v1.1: 34, dev-v1: 34 | 816 | 70 | 1762 |
| epub_inspect | dev-v1.1: 17, dev-v1: 17 | 408 | 127 | 1762 |
| audiobook_inspect | dev-v1.1: 11, dev-v1: 11 | 272 | 175 | 1762 |
| arr_lookup | dev-v1.1: 62, dev-v1: 62 | 1496 | 230 | 1762 |
| subtitle_sample | dev-v1.1: 0, dev-v1: 0 | 0 | 0 | 1762 |

Reading: `audio_sample` is offered in 0 cases of suite dev-v1.1 (build_v11 correction C5 removed it: no replay data) and in 45 cases of the older suite dev-v1, but no run in scope used dev-v1; its only requests were two Haiku calls in dev-c3 (harness dev-c2) that the harness answered `unavailable` because the case did not offer it. `subtitle_sample` (#161, tools behaviour `v3-remote-1`) is in no suite case and in no record, offered or requested.

## 3. Local models: per run, per tool

### dev-c4/devc4-v4g-muse-glimmer-30b

muse-glimmer:30b, prompt v4, format default, guards v1; 73 cases scored, 60 correct as run; 129 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 33 / 33 (33 of those cases already had its output) | ok 30, error 3 | 44 / 33 | 25/33 (76%) | 9/12 (75%) | 34/44 (77%) vs 0/1 (0%) |
| decode_sample | 34 | 31 | 28 / 29 (25 of those cases already had its output) | ok 26, error 2, timeout 1 | 14 / 26 | 22/28 (79%) | 4/6 (67%) | 24/29 (83%) vs 2/5 (40%) |
| frame_sample | 34 | 0 | 4 / 4 | ok 3, unavailable 1 | 0 / 1 | 4/4 (100%) | 22/30 (73%) | 1/1 (100%) vs 25/33 (76%) |
| ocr | 34 | 13 | 4 / 4 (1 of those cases already had its output) | ok 3, unavailable 1 | 11 / 2 | 4/4 (100%) | 22/30 (73%) | 9/12 (75%) vs 17/22 (77%) |
| epub_inspect | 17 | 16 | 17 / 18 (16 of those cases already had its output) | ok 9, error 9 | 16 / 16 | 15/17 (88%) | - | 14/16 (88%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 11 / 13 | ok 7, partial 2, error 4 | 0 / 10 | 8/11 (73%) | - | 8/10 (80%) vs 0/1 (0%) |
| arr_lookup | 62 | 58 | 28 / 28 (24 of those cases already had its output) | ok 28 | 48 / 25 | 24/28 (86%) | 25/34 (74%) | 40/51 (78%) vs 9/11 (82%) |
| prior_record | 0 | 13 | 0 / 0 | - | 7 / 0 | - | - | 6/7 (86%) vs 6/6 (100%) |

### dev-c4/devc4-v4g-qwen3.8-27b

qwen3.8:27b, prompt v4, format default, guards v1; 73 cases scored, 66 correct as run; 38 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 43 / 0 | - | 39/45 (87%) | 38/43 (88%) vs 1/2 (50%) |
| decode_sample | 34 | 31 | 10 / 10 (7 of those cases already had its output) | ok 8, timeout 1, unavailable 1 | 25 / 9 | 9/10 (90%) | 20/24 (83%) | 24/27 (89%) vs 5/7 (71%) |
| frame_sample | 34 | 0 | 4 / 5 | ok 2, timeout 1, unavailable 2 | 0 / 1 | 3/4 (75%) | 26/30 (87%) | 1/1 (100%) vs 28/33 (85%) |
| ocr | 34 | 13 | 4 / 6 (1 of those cases already had its output) | ok 5, unavailable 1 | 13 / 3 | 3/4 (75%) | 26/30 (87%) | 14/16 (88%) vs 15/18 (83%) |
| epub_inspect | 17 | 16 | 3 / 3 (2 of those cases already had its output) | error 3 | 16 / 2 | 3/3 (100%) | 13/14 (93%) | 15/16 (94%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 11 / 11 | ok 6, partial 1, error 4 | 0 / 10 | 10/11 (91%) | - | 9/10 (90%) vs 1/1 (100%) |
| arr_lookup | 62 | 58 | 3 / 3 | ok 3 | 53 / 2 | 3/3 (100%) | 52/59 (88%) | 49/55 (89%) vs 6/7 (86%) |
| prior_record | 0 | 13 | 0 / 0 | - | 6 / 0 | - | - | 6/6 (100%) vs 6/7 (86%) |

### dev-c5/devc5-b-qwen3.8-27b

qwen3.8:27b, prompt v5, format v2, guards v3; 73 cases scored, 60 correct as run, 56 correct with guards undone; 50 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 2 / 2 (2 of those cases already had its output) | ok 2 | 38 / 2 | 2/2 (100%) | 33/43 (77%) | 28/38 (74%) vs 7/7 (100%) |
| decode_sample | 34 | 31 | 9 / 11 (9 of those cases already had its output) | ok 7, error 2, unavailable 2 | 23 / 8 | 6/9 (67%) | 19/25 (76%) | 17/25 (68%) vs 8/9 (89%) |
| frame_sample | 34 | 0 | 4 / 4 | ok 4 | 0 / 1 | 1/4 (25%) | 24/30 (80%) | 0/1 (0%) vs 25/33 (76%) |
| ocr | 34 | 13 | 6 / 8 (1 of those cases already had its output) | ok 8 | 13 / 6 | 3/6 (50%) | 22/28 (79%) | 14/18 (78%) vs 11/16 (69%) |
| epub_inspect | 17 | 16 | 7 / 8 (6 of those cases already had its output) (+2 page continuations) | ok 6, error 2 | 16 / 6 | 6/7 (86%) | 10/10 (100%) | 15/16 (94%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 11 / 11 | ok 6, partial 1, error 4 | 0 / 11 | 10/11 (91%) | - | 10/11 (91%) vs - |
| arr_lookup | 62 | 58 | 6 / 6 (3 of those cases already had its output) | ok 6 | 52 / 5 | 5/6 (83%) | 46/56 (82%) | 44/54 (81%) vs 7/8 (88%) |
| prior_record | 0 | 13 | 0 / 0 | - | 9 / 0 | - | - | 6/9 (67%) vs 4/4 (100%) |

### dev-c6/devc6-qwen3.8-27b

qwen3.8:27b, prompt v6, format v3, guards v3; 73 cases scored, 61 correct as run, 59 correct with guards undone; 34 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 39 / 0 | - | 38/45 (84%) | 32/39 (82%) vs 6/6 (100%) |
| decode_sample | 34 | 31 | 6 / 8 (6 of those cases already had its output) | ok 5, error 3 | 22 / 6 | 4/6 (67%) | 26/28 (93%) | 22/25 (88%) vs 8/9 (89%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 30/34 (88%) | - vs 30/34 (88%) |
| ocr | 34 | 13 | 3 / 3 | ok 3 | 13 / 3 | 3/3 (100%) | 27/31 (87%) | 13/16 (81%) vs 17/18 (94%) |
| epub_inspect | 17 | 16 | 1 / 1 | error 1 | 16 / 1 | 1/1 (100%) | 13/16 (81%) | 14/17 (82%) vs - |
| audiobook_inspect | 11 | 0 | 10 / 10 | ok 6, partial 1, error 3 | 0 / 9 | 7/10 (70%) | 1/1 (100%) | 6/9 (67%) vs 2/2 (100%) |
| arr_lookup | 62 | 58 | 12 / 12 (9 of those cases already had its output) | ok 12 | 55 / 11 | 8/12 (67%) | 44/50 (88%) | 49/59 (83%) vs 3/3 (100%) |
| prior_record | 0 | 13 | 0 / 0 | - | 11 / 0 | - | - | 9/11 (82%) vs 2/2 (100%) |

### dev-c7-qwen-r2/devc7r2-qwen3.8-27b

qwen3.8:27b, prompt v7, format v3.1-format, guards v3; 73 cases scored, 60 correct as run, 59 correct with guards undone; 47 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 40 / 0 | - | 37/45 (82%) | 33/40 (82%) vs 4/5 (80%) |
| decode_sample | 34 | 31 | 11 / 13 (11 of those cases already had its output) | ok 10, error 3 | 18 / 10 | 9/11 (82%) | 20/23 (87%) | 22/25 (88%) vs 7/9 (78%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 29/34 (85%) | - vs 29/34 (85%) |
| ocr | 34 | 13 | 3 / 3 | ok 3 | 13 / 3 | 3/3 (100%) | 26/31 (84%) | 13/16 (81%) vs 16/18 (89%) |
| epub_inspect | 17 | 16 | 10 / 12 (9 of those cases already had its output) | ok 11, error 1 | 14 / 10 | 8/10 (80%) | 7/7 (100%) | 15/17 (88%) vs - |
| audiobook_inspect | 11 | 0 | 10 / 10 | ok 6, partial 1, error 3 | 0 / 10 | 7/10 (70%) | 1/1 (100%) | 7/10 (70%) vs 1/1 (100%) |
| arr_lookup | 62 | 58 | 9 / 9 (6 of those cases already had its output) | ok 9 | 54 / 6 | 6/9 (67%) | 46/53 (87%) | 48/56 (86%) vs 4/6 (67%) |
| prior_record | 0 | 13 | 0 / 0 | - | 12 / 0 | - | - | 8/12 (67%) vs 1/1 (100%) |

### dev-c7/devc7-qwen3.8-27b (PARTIAL: 5 of 73 cases, aborted: cannot read /api/ps (1); refusing to touch the GPU blind)

qwen3.8:27b, prompt v7, format v3.1-format, guards v3; 5 cases scored, 4 correct as run, 4 correct with guards undone; 2 calls in total, 1 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 4 | 4 | 0 / 0 | - | 3 / 0 | - | 3/4 (75%) | 3/3 (100%) vs 0/1 (0%) |
| audiobook_inspect | 4 | 0 | 2 / 2 | partial 1, error 1 | 0 / 2 | 2/2 (100%) | 1/2 (50%) | 2/2 (100%) vs 1/2 (50%) |
| arr_lookup | 4 | 4 | 0 / 0 | - | 1 / 0 | - | 3/4 (75%) | 1/1 (100%) vs 2/3 (67%) |
| prior_record | 0 | 1 | 0 / 0 | - | 1 / 0 | - | - | 1/1 (100%) vs - |

## 4. Frontier comparison: per run, per tool

Same columns as section 3. Frontier models are the Haiku 5.5 and gpt-6-astra runs; they are here for comparison, not as a target.

### dev-c3/devc3-base-haiku-5-5-v2

claude-haiku-5-5, prompt v2, format default, guards off; 73 cases scored, 49 correct as run; 39 calls in total, 0 forced, 5 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 45 / 0 | - | 30/45 (67%) | 30/45 (67%) vs - |
| decode_sample | 34 | 31 | 22 / 23 (19 of those cases already had its output) (+2 requested while not offered) | ok 17, error 2, timeout 1, unavailable 3 | 19 / 21 | 17/22 (77%) | 7/12 (58%) | 20/29 (69%) vs 4/5 (80%) |
| frame_sample | 34 | 0 | 2 / 2 | error 1, unavailable 1 | 0 / 1 | 1/2 (50%) | 23/32 (72%) | 0/1 (0%) vs 24/33 (73%) |
| audio_sample | 0 | 0 | 0 / 0 (+2 requested while not offered) | - | 0 / 0 | - | - | - vs - |
| ocr | 34 | 13 | 1 / 1 | ok 1 | 13 / 1 | 1/1 (100%) | 23/33 (70%) | 10/14 (71%) vs 14/20 (70%) |
| epub_inspect | 17 | 16 | 1 / 1 (+1 requested while not offered) | error 1 | 16 / 1 | 1/1 (100%) | 10/16 (62%) | 11/17 (65%) vs - |
| audiobook_inspect | 11 | 0 | 11 / 11 | ok 6, partial 1, error 4 | 0 / 10 | 6/11 (55%) | - | 5/10 (50%) vs 1/1 (100%) |
| arr_lookup | 62 | 58 | 1 / 1 | ok 1 | 58 / 1 | 0/1 (0%) | 41/61 (67%) | 40/59 (68%) vs 1/3 (33%) |
| prior_record | 0 | 13 | 0 / 0 | - | 13 / 0 | - | - | 9/13 (69%) vs - |

### dev-c3/devc3-v3a-haiku-5-5

claude-haiku-5-5, prompt v3, format default, guards off; 73 cases scored, 58 correct as run; 31 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 45 / 0 | - | 36/45 (80%) | 36/45 (80%) vs - |
| decode_sample | 34 | 31 | 16 / 17 (15 of those cases already had its output) | ok 11, error 2, timeout 1, unavailable 3 | 19 / 15 | 14/16 (88%) | 13/18 (72%) | 21/28 (75%) vs 6/6 (100%) |
| frame_sample | 34 | 0 | 1 / 1 | ok 1 | 0 / 1 | 1/1 (100%) | 26/33 (79%) | 1/1 (100%) vs 26/33 (79%) |
| ocr | 34 | 13 | 3 / 3 | ok 3 | 13 / 3 | 2/3 (67%) | 25/31 (81%) | 13/16 (81%) vs 14/18 (78%) |
| epub_inspect | 17 | 16 | 1 / 1 | error 1 | 16 / 1 | 1/1 (100%) | 14/16 (88%) | 15/17 (88%) vs - |
| audiobook_inspect | 11 | 0 | 8 / 8 | ok 6, error 2 | 0 / 8 | 6/8 (75%) | 3/3 (100%) | 6/8 (75%) vs 3/3 (100%) |
| arr_lookup | 62 | 58 | 1 / 1 | ok 1 | 58 / 1 | 1/1 (100%) | 50/61 (82%) | 50/59 (85%) vs 1/3 (33%) |
| prior_record | 0 | 13 | 0 / 0 | - | 13 / 0 | - | - | 8/13 (62%) vs - |

### dev-c3/devc3-v3b-haiku-5-5

claude-haiku-5-5, prompt v3, format default, guards off; 73 cases scored, 60 correct as run; 27 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 45 / 0 | - | 39/45 (87%) | 39/45 (87%) vs - |
| decode_sample | 34 | 31 | 17 / 17 (16 of those cases already had its output) | ok 12, error 1, unavailable 4 | 19 / 17 | 13/17 (76%) | 16/17 (94%) | 24/29 (83%) vs 5/5 (100%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 29/34 (85%) | - vs 29/34 (85%) |
| ocr | 34 | 13 | 1 / 1 | ok 1 | 13 / 1 | 1/1 (100%) | 28/33 (85%) | 11/14 (79%) vs 18/20 (90%) |
| epub_inspect | 17 | 16 | 1 / 1 | error 1 | 16 / 1 | 1/1 (100%) | 14/16 (88%) | 15/17 (88%) vs - |
| audiobook_inspect | 11 | 0 | 8 / 8 | ok 6, error 2 | 0 / 8 | 7/8 (88%) | 3/3 (100%) | 7/8 (88%) vs 3/3 (100%) |
| arr_lookup | 62 | 58 | 0 / 0 | - | 58 / 0 | - | 54/62 (87%) | 53/58 (91%) vs 1/4 (25%) |
| prior_record | 0 | 13 | 0 / 0 | - | 13 / 0 | - | - | 7/13 (54%) vs - |

### dev-c3/devc3-v3c-haiku-5-5

claude-haiku-5-5, prompt v3, format default, guards off; 73 cases scored, 61 correct as run; 27 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 45 / 0 | - | 37/45 (82%) | 37/45 (82%) vs - |
| decode_sample | 34 | 31 | 18 / 18 (16 of those cases already had its output) | ok 12, error 1, timeout 1, unavailable 4 | 17 / 18 | 15/18 (83%) | 13/16 (81%) | 23/29 (79%) vs 5/5 (100%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 28/34 (82%) | - vs 28/34 (82%) |
| ocr | 34 | 13 | 1 / 1 | ok 1 | 13 / 1 | 1/1 (100%) | 27/33 (82%) | 12/14 (86%) vs 16/20 (80%) |
| epub_inspect | 17 | 16 | 2 / 2 (1 of those cases already had its output) | ok 1, error 1 | 16 / 2 | 2/2 (100%) | 13/15 (87%) | 15/17 (88%) vs - |
| audiobook_inspect | 11 | 0 | 6 / 6 | ok 6 | 0 / 6 | 4/6 (67%) | 5/5 (100%) | 4/6 (67%) vs 5/5 (100%) |
| arr_lookup | 62 | 58 | 0 / 0 | - | 58 / 0 | - | 52/62 (84%) | 51/58 (88%) vs 1/4 (25%) |
| prior_record | 0 | 13 | 0 / 0 | - | 12 / 0 | - | - | 10/12 (83%) vs 0/1 (0%) |

### dev-c3/devc3-v3d-haiku-5-5

claude-haiku-5-5, prompt v3, format default, guards off; 73 cases scored, 63 correct as run; 24 calls in total, 0 forced, 1 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 44 / 0 | - | 38/45 (84%) | 37/44 (84%) vs 1/1 (100%) |
| decode_sample | 34 | 31 | 14 / 15 (14 of those cases already had its output) (+1 requested while not offered) | ok 10, error 2, unavailable 3 | 15 / 10 | 12/14 (86%) | 17/20 (85%) | 20/25 (80%) vs 9/9 (100%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 29/34 (85%) | - vs 29/34 (85%) |
| ocr | 34 | 13 | 1 / 1 | ok 1 | 13 / 1 | 1/1 (100%) | 28/33 (85%) | 12/14 (86%) vs 17/20 (85%) |
| epub_inspect | 17 | 16 | 1 / 1 | error 1 | 16 / 0 | 1/1 (100%) | 14/16 (88%) | 14/16 (88%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 6 / 6 | ok 6 | 0 / 6 | 4/6 (67%) | 5/5 (100%) | 4/6 (67%) vs 5/5 (100%) |
| arr_lookup | 62 | 58 | 1 / 1 | ok 1 | 57 / 0 | 0/1 (0%) | 53/61 (87%) | 51/57 (89%) vs 2/5 (40%) |
| prior_record | 0 | 13 | 0 / 0 | - | 13 / 0 | - | - | 11/13 (85%) vs - |

### dev-c4/devc4-v4g-haiku-5-5

claude-haiku-5-5, prompt v4, format default, guards v1; 73 cases scored, 61 correct as run; 33 calls in total, 0 forced, 1 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 45 / 0 | - | 38/45 (84%) | 38/45 (84%) vs - |
| decode_sample | 34 | 31 | 19 / 20 (19 of those cases already had its output) (+1 requested while not offered) | ok 15, error 2, unavailable 3 | 12 / 16 | 16/19 (84%) | 13/15 (87%) | 21/25 (84%) vs 8/9 (89%) |
| frame_sample | 34 | 0 | 1 / 1 | ok 1 | 0 / 1 | 1/1 (100%) | 28/33 (85%) | 1/1 (100%) vs 28/33 (85%) |
| ocr | 34 | 13 | 4 / 5 (1 of those cases already had its output) | ok 4, unavailable 1 | 13 / 2 | 3/4 (75%) | 26/30 (87%) | 13/15 (87%) vs 16/19 (84%) |
| epub_inspect | 17 | 16 | 1 / 1 | error 1 | 16 / 0 | 1/1 (100%) | 13/16 (81%) | 13/16 (81%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 6 / 6 | ok 4, error 2 | 0 / 6 | 5/6 (83%) | 4/5 (80%) | 5/6 (83%) vs 4/5 (80%) |
| arr_lookup | 62 | 58 | 0 / 0 | - | 57 / 0 | - | 52/62 (84%) | 50/57 (88%) vs 2/5 (40%) |
| prior_record | 0 | 13 | 0 / 0 | - | 13 / 0 | - | - | 10/13 (77%) vs - |

### dev-c5/devc5-b-haiku-5-5

claude-haiku-5-5, prompt v5, format v2, guards v3; 73 cases scored, 53 correct as run, 53 correct with guards undone; 29 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 39 / 0 | - | 33/45 (73%) | 27/39 (69%) vs 6/6 (100%) |
| decode_sample | 34 | 31 | 14 / 16 (13 of those cases already had its output) | ok 12, error 2, unavailable 2 | 21 / 11 | 10/14 (71%) | 17/20 (85%) | 23/29 (79%) vs 4/5 (80%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 27/34 (79%) | - vs 27/34 (79%) |
| ocr | 34 | 13 | 2 / 2 (1 of those cases already had its output) | ok 2 | 13 / 1 | 1/2 (50%) | 26/32 (81%) | 8/13 (62%) vs 19/21 (90%) |
| epub_inspect | 17 | 16 | 1 / 1 | error 1 | 16 / 0 | 1/1 (100%) | 12/16 (75%) | 12/16 (75%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 8 / 8 | ok 6, error 2 | 0 / 8 | 3/8 (38%) | 3/3 (100%) | 3/8 (38%) vs 3/3 (100%) |
| arr_lookup | 62 | 58 | 2 / 2 | ok 2 | 50 / 1 | 1/2 (50%) | 45/60 (75%) | 38/51 (75%) vs 8/11 (73%) |
| prior_record | 0 | 13 | 0 / 0 | - | 13 / 0 | - | - | 9/13 (69%) vs - |

### dev-c6/devc6-gpt-6-astra

gpt-6-astra, prompt v6, format v3, guards v3; 73 cases scored, 43 correct as run, 43 correct with guards undone; 34 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 38 / 0 | - | 30/45 (67%) | 23/38 (61%) vs 7/7 (100%) |
| decode_sample | 34 | 31 | 4 / 6 (4 of those cases already had its output) | ok 6 | 19 / 4 | 2/4 (50%) | 24/30 (80%) | 16/22 (73%) vs 10/12 (83%) |
| frame_sample | 34 | 0 | 2 / 2 | ok 2 | 0 / 0 | 0/2 (0%) | 26/32 (81%) | - vs 26/34 (76%) |
| ocr | 34 | 13 | 2 / 2 (1 of those cases already had its output) | ok 2 | 13 / 2 | 1/2 (50%) | 25/32 (78%) | 11/14 (79%) vs 15/20 (75%) |
| epub_inspect | 17 | 16 | 4 / 4 (3 of those cases already had its output) | ok 3, error 1 | 16 / 3 | 1/4 (25%) | 5/13 (38%) | 5/16 (31%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 3 / 3 | ok 3 | 0 / 3 | 1/3 (33%) | 3/8 (38%) | 1/3 (33%) vs 3/8 (38%) |
| arr_lookup | 62 | 58 | 17 / 17 (15 of those cases already had its output) | ok 17 | 44 / 17 | 2/17 (12%) | 34/45 (76%) | 34/58 (59%) vs 2/4 (50%) |
| prior_record | 0 | 13 | 0 / 0 | - | 12 / 0 | - | - | 7/12 (58%) vs 0/1 (0%) |

### dev-c6/devc6-haiku-5-5

claude-haiku-5-5, prompt v6, format v3, guards v3; 73 cases scored, 43 correct as run, 43 correct with guards undone; 23 calls in total, 1 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 43 / 0 | - | 30/45 (67%) | 28/43 (65%) vs 2/2 (100%) |
| decode_sample | 34 | 31 | 4 / 5 (4 of those cases already had its output) | ok 5 | 21 / 4 | 3/4 (75%) | 22/30 (73%) | 16/24 (67%) vs 9/10 (90%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 25/34 (74%) | - vs 25/34 (74%) |
| ocr | 34 | 13 | 1 / 1 | ok 1 | 13 / 1 | 1/1 (100%) | 24/33 (73%) | 12/14 (86%) vs 13/20 (65%) |
| epub_inspect | 17 | 16 | 1 / 1 | error 1 | 15 / 0 | 1/1 (100%) | 5/16 (31%) | 5/15 (33%) vs 1/2 (50%) |
| audiobook_inspect | 11 | 0 | 3 / 3 | ok 2, partial 1 | 0 / 3 | 2/3 (67%) | 3/8 (38%) | 2/3 (67%) vs 3/8 (38%) |
| arr_lookup | 62 | 58 | 13 / 13 (11 of those cases already had its output) | ok 13 | 45 / 9 | 1/13 (8%) | 35/49 (71%) | 34/53 (64%) vs 2/9 (22%) |
| prior_record | 0 | 13 | 0 / 0 | - | 12 / 0 | - | - | 7/12 (58%) vs 0/1 (0%) |

### dev-c7/devc7-gpt-6-astra

gpt-6-astra, prompt v7, format v3.1-format, guards v3; 73 cases scored, 45 correct as run, 45 correct with guards undone; 41 calls in total, 0 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 37 / 0 | - | 32/45 (71%) | 25/37 (68%) vs 7/8 (88%) |
| decode_sample | 34 | 31 | 3 / 4 (3 of those cases already had its output) | ok 4 | 20 / 3 | 2/3 (67%) | 25/31 (81%) | 18/23 (78%) vs 9/11 (82%) |
| frame_sample | 34 | 0 | 1 / 1 | ok 1 | 0 / 0 | 0/1 (0%) | 27/33 (82%) | - vs 27/34 (79%) |
| ocr | 34 | 13 | 2 / 3 (1 of those cases already had its output) | ok 3 | 13 / 2 | 1/2 (50%) | 26/32 (81%) | 11/14 (79%) vs 16/20 (80%) |
| epub_inspect | 17 | 16 | 6 / 9 (5 of those cases already had its output) | ok 8, error 1 | 13 / 5 | 3/6 (50%) | 3/11 (27%) | 5/16 (31%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 3 / 3 | ok 3 | 0 / 3 | 2/3 (67%) | 3/8 (38%) | 2/3 (67%) vs 3/8 (38%) |
| arr_lookup | 62 | 58 | 21 / 21 (19 of those cases already had its output) | ok 21 | 46 / 21 | 5/21 (24%) | 33/41 (80%) | 37/60 (62%) vs 1/2 (50%) |
| prior_record | 0 | 13 | 0 / 0 | - | 12 / 0 | - | - | 7/12 (58%) vs 0/1 (0%) |

### dev-c7/devc7-haiku-5-5

claude-haiku-5-5, prompt v7, format v3.1-format, guards v3; 73 cases scored, 40 correct as run, 40 correct with guards undone; 39 calls in total, 2 forced, 0 protocol violations.

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 0 / 0 | - | 40 / 0 | - | 27/45 (60%) | 23/40 (58%) vs 4/5 (80%) |
| decode_sample | 34 | 31 | 3 / 3 (3 of those cases already had its output) | ok 3 | 21 / 3 | 1/3 (33%) | 22/31 (71%) | 15/23 (65%) vs 8/11 (73%) |
| frame_sample | 34 | 0 | 0 / 0 | - | 0 / 0 | - | 23/34 (68%) | - vs 23/34 (68%) |
| ocr | 34 | 13 | 2 / 2 (1 of those cases already had its output) | ok 2 | 13 / 2 | 1/2 (50%) | 22/32 (69%) | 10/14 (71%) vs 13/20 (65%) |
| epub_inspect | 17 | 16 | 8 / 13 (7 of those cases already had its output) | ok 11, error 2 | 13 / 7 | 4/8 (50%) | 2/9 (22%) | 6/15 (40%) vs 0/2 (0%) |
| audiobook_inspect | 11 | 0 | 3 / 3 | ok 3 | 0 / 3 | 0/3 (0%) | 4/8 (50%) | 0/3 (0%) vs 4/8 (50%) |
| arr_lookup | 62 | 58 | 18 / 18 (17 of those cases already had its output) | ok 18 | 40 / 14 | 3/18 (17%) | 30/44 (68%) | 31/52 (60%) vs 2/10 (20%) |
| prior_record | 0 | 13 | 0 / 0 | - | 11 / 0 | - | - | 7/11 (64%) vs 0/2 (0%) |

## 5. Pooled per model (full runs only; run-cases are not independent samples)

### muse-glimmer:30b (local): dev-c4/devc4-v4g-muse-glimmer-30b

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 45 | 45 | 33 / 33 (33 of those cases already had its output) | ok 30, error 3 | 44 / 33 | 25/33 (76%) | 9/12 (75%) | 34/44 (77%) vs 0/1 (0%) |
| decode_sample | 34 | 31 | 28 / 29 (25 of those cases already had its output) | ok 26, error 2, timeout 1 | 14 / 26 | 22/28 (79%) | 4/6 (67%) | 24/29 (83%) vs 2/5 (40%) |
| frame_sample | 34 | 0 | 4 / 4 | ok 3, unavailable 1 | 0 / 1 | 4/4 (100%) | 22/30 (73%) | 1/1 (100%) vs 25/33 (76%) |
| ocr | 34 | 13 | 4 / 4 (1 of those cases already had its output) | ok 3, unavailable 1 | 11 / 2 | 4/4 (100%) | 22/30 (73%) | 9/12 (75%) vs 17/22 (77%) |
| epub_inspect | 17 | 16 | 17 / 18 (16 of those cases already had its output) | ok 9, error 9 | 16 / 16 | 15/17 (88%) | - | 14/16 (88%) vs 1/1 (100%) |
| audiobook_inspect | 11 | 0 | 11 / 13 | ok 7, partial 2, error 4 | 0 / 10 | 8/11 (73%) | - | 8/10 (80%) vs 0/1 (0%) |
| arr_lookup | 62 | 58 | 28 / 28 (24 of those cases already had its output) | ok 28 | 48 / 25 | 24/28 (86%) | 25/34 (74%) | 40/51 (78%) vs 9/11 (82%) |
| prior_record | 0 | 13 | 0 / 0 | - | 7 / 0 | - | - | 6/7 (86%) vs 6/6 (100%) |

### qwen3.8:27b (local): dev-c4/devc4-v4g-qwen3.8-27b, dev-c5/devc5-b-qwen3.8-27b, dev-c6/devc6-qwen3.8-27b, dev-c7-qwen-r2/devc7r2-qwen3.8-27b

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 180 | 180 | 2 / 2 (2 of those cases already had its output) | ok 2 | 160 / 2 | 2/2 (100%) | 147/178 (83%) | 131/160 (82%) vs 18/20 (90%) |
| decode_sample | 136 | 124 | 36 / 42 (33 of those cases already had its output) | ok 30, error 8, timeout 1, unavailable 3 | 88 / 33 | 28/36 (78%) | 85/100 (85%) | 85/102 (83%) vs 28/34 (82%) |
| frame_sample | 136 | 0 | 8 / 9 | ok 6, timeout 1, unavailable 2 | 0 / 2 | 4/8 (50%) | 109/128 (85%) | 1/2 (50%) vs 112/134 (84%) |
| ocr | 136 | 52 | 16 / 20 (2 of those cases already had its output) | ok 19, unavailable 1 | 52 / 15 | 12/16 (75%) | 101/120 (84%) | 54/66 (82%) vs 59/70 (84%) |
| epub_inspect | 68 | 64 | 21 / 24 (17 of those cases already had its output) (+2 page continuations) | ok 17, error 7 | 62 / 19 | 18/21 (86%) | 43/47 (91%) | 59/66 (89%) vs 2/2 (100%) |
| audiobook_inspect | 44 | 0 | 42 / 42 | ok 24, partial 4, error 14 | 0 / 40 | 34/42 (81%) | 2/2 (100%) | 32/40 (80%) vs 4/4 (100%) |
| arr_lookup | 248 | 232 | 30 / 30 (18 of those cases already had its output) | ok 30 | 214 / 24 | 22/30 (73%) | 188/218 (86%) | 190/224 (85%) vs 20/24 (83%) |
| prior_record | 0 | 52 | 0 / 0 | - | 38 / 0 | - | - | 29/38 (76%) vs 13/14 (93%) |

### claude-haiku-5-5 (frontier): dev-c3/devc3-base-haiku-5-5-v2, dev-c3/devc3-v3a-haiku-5-5, dev-c3/devc3-v3b-haiku-5-5, dev-c3/devc3-v3c-haiku-5-5, dev-c3/devc3-v3d-haiku-5-5, dev-c4/devc4-v4g-haiku-5-5, dev-c5/devc5-b-haiku-5-5, dev-c6/devc6-haiku-5-5, dev-c7/devc7-haiku-5-5

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 405 | 405 | 0 / 0 | - | 391 / 0 | - | 308/405 (76%) | 295/391 (75%) vs 13/14 (93%) |
| decode_sample | 306 | 279 | 127 / 134 (119 of those cases already had its output) (+4 requested while not offered) | ok 97, error 12, timeout 3, unavailable 22 | 164 / 115 | 101/127 (80%) | 140/179 (78%) | 183/241 (76%) vs 58/65 (89%) |
| frame_sample | 306 | 0 | 4 / 4 | ok 2, error 1, unavailable 1 | 0 / 3 | 3/4 (75%) | 238/302 (79%) | 2/3 (67%) vs 239/303 (79%) |
| audio_sample | 0 | 0 | 0 / 0 (+2 requested while not offered) | - | 0 / 0 | - | - | - vs - |
| ocr | 306 | 117 | 16 / 17 (3 of those cases already had its output) | ok 16, unavailable 1 | 117 / 13 | 12/16 (75%) | 229/290 (79%) | 101/128 (79%) vs 140/178 (79%) |
| epub_inspect | 153 | 144 | 17 / 22 (8 of those cases already had its output) (+1 requested while not offered) | ok 12, error 10 | 140 / 12 | 13/17 (76%) | 97/136 (71%) | 106/146 (73%) vs 4/7 (57%) |
| audiobook_inspect | 99 | 0 | 59 / 59 | ok 45, partial 2, error 12 | 0 / 58 | 37/59 (63%) | 30/40 (75%) | 36/58 (62%) vs 31/41 (76%) |
| arr_lookup | 558 | 522 | 36 / 36 (28 of those cases already had its output) | ok 36 | 481 / 26 | 6/36 (17%) | 412/522 (79%) | 398/504 (79%) vs 20/54 (37%) |
| prior_record | 0 | 117 | 0 / 0 | - | 113 / 0 | - | - | 78/113 (69%) vs 0/4 (0%) |

### gpt-6-astra (frontier): dev-c6/devc6-gpt-6-astra, dev-c7/devc7-gpt-6-astra

| tool | offered (cases) | pre-supplied evidence (cases) | called (cases / calls) | call results | cited: pre-supplied / called (cases) | correct: offered and called | correct: offered, not called | correct: evidence cited vs not cited |
|---|---|---|---|---|---|---|---|---|
| ffprobe | 90 | 90 | 0 / 0 | - | 75 / 0 | - | 62/90 (69%) | 48/75 (64%) vs 14/15 (93%) |
| decode_sample | 68 | 62 | 7 / 10 (7 of those cases already had its output) | ok 10 | 39 / 7 | 4/7 (57%) | 49/61 (80%) | 34/45 (76%) vs 19/23 (83%) |
| frame_sample | 68 | 0 | 3 / 3 | ok 3 | 0 / 0 | 0/3 (0%) | 53/65 (82%) | - vs 53/68 (78%) |
| ocr | 68 | 26 | 4 / 5 (2 of those cases already had its output) | ok 5 | 26 / 4 | 2/4 (50%) | 51/64 (80%) | 22/28 (79%) vs 31/40 (78%) |
| epub_inspect | 34 | 32 | 10 / 13 (8 of those cases already had its output) | ok 11, error 2 | 29 / 8 | 4/10 (40%) | 8/24 (33%) | 10/32 (31%) vs 2/2 (100%) |
| audiobook_inspect | 22 | 0 | 6 / 6 | ok 6 | 0 / 6 | 3/6 (50%) | 6/16 (38%) | 3/6 (50%) vs 6/16 (38%) |
| arr_lookup | 124 | 116 | 38 / 38 (34 of those cases already had its output) | ok 38 | 90 / 38 | 7/38 (18%) | 67/86 (78%) | 71/118 (60%) vs 3/6 (50%) |
| prior_record | 0 | 26 | 0 / 0 | - | 24 / 0 | - | - | 14/24 (58%) vs 0/2 (0%) |

### Same case, same model, different round

Only cases where that model's runs disagree on calling an offered tool. Holds case difficulty fixed; the round (prompt, format, guards) still differs between the runs, and rounds differ in overall accuracy, so this is still a correlation.

**qwen3.8:27b (local)**

| tool | cases where runs disagree | runs that called: correct | runs that did not call: correct |
|---|---|---|---|
| ffprobe | 2 | 2/2 (100%) | 4/6 (67%) |
| decode_sample | 18 | 28/32 (88%) | 37/40 (92%) |
| frame_sample | 7 | 4/8 (50%) | 12/20 (60%) |
| ocr | 7 | 8/12 (67%) | 8/16 (50%) |
| epub_inspect | 11 | 14/17 (82%) | 23/27 (85%) |
| audiobook_inspect | 2 | 6/6 (100%) | 2/2 (100%) |
| arr_lookup | 15 | 13/18 (72%) | 30/42 (71%) |

**claude-haiku-5-5 (frontier)**

| tool | cases where runs disagree | runs that called: correct | runs that did not call: correct |
|---|---|---|---|
| decode_sample | 25 | 85/109 (78%) | 93/116 (80%) |
| frame_sample | 3 | 3/4 (75%) | 14/23 (61%) |
| ocr | 6 | 12/16 (75%) | 24/38 (63%) |
| epub_inspect | 7 | 4/8 (50%) | 33/55 (60%) |
| audiobook_inspect | 10 | 36/50 (72%) | 30/40 (75%) |
| arr_lookup | 23 | 6/36 (17%) | 129/171 (75%) |

**gpt-6-astra (frontier)**

| tool | cases where runs disagree | runs that called: correct | runs that did not call: correct |
|---|---|---|---|
| decode_sample | 1 | 0/1 (0%) | 1/1 (100%) |
| frame_sample | 1 | 0/1 (0%) | 0/1 (0%) |
| epub_inspect | 2 | 2/2 (100%) | 2/2 (100%) |
| arr_lookup | 4 | 3/4 (75%) | 3/4 (75%) |

## 6. By class (local models, pooled over full runs)

Class is the case's truth class. Columns: cases offering the tool, cases with pre-supplied evidence of its type, cases where it was called (calls), correct when offered and called, correct when offered and not called.

### muse-glimmer:30b: identity_mismatch (14 run-cases, 13 correct as run) <- identity_mismatch, see section 7

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 5 | 5 | 3 / 3 | 3/3 (100%) | 2/2 (100%) |
| decode_sample | 4 | 4 | 3 / 3 | 3/3 (100%) | 1/1 (100%) |
| frame_sample | 4 | 0 | 1 / 1 | 1/1 (100%) | 3/3 (100%) |
| ocr | 4 | 3 | 1 / 1 | 1/1 (100%) | 3/3 (100%) |
| epub_inspect | 4 | 4 | 4 / 4 | 3/4 (75%) | - |
| audiobook_inspect | 1 | 0 | 1 / 1 | 1/1 (100%) | - |
| arr_lookup | 9 | 8 | 5 / 5 | 4/5 (80%) | 4/4 (100%) |
| prior_record | 0 | 5 | 0 / 0 | - | - |

### muse-glimmer:30b: corrupt_file (21 run-cases, 19 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 14 | 14 | 7 / 7 | 6/7 (86%) | 6/7 (86%) |
| decode_sample | 9 | 6 | 9 / 9 | 8/9 (89%) | - |
| frame_sample | 9 | 0 | 2 / 2 | 2/2 (100%) | 6/7 (86%) |
| ocr | 9 | 0 | 2 / 2 | 2/2 (100%) | 6/7 (86%) |
| epub_inspect | 7 | 7 | 7 / 8 | 7/7 (100%) | - |
| audiobook_inspect | 5 | 0 | 5 / 6 | 4/5 (80%) | - |
| arr_lookup | 21 | 21 | 11 / 11 | 11/11 (100%) | 8/10 (80%) |

### muse-glimmer:30b: decoder_incompatible (5 run-cases, 4 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 5 | 5 | 5 / 5 | 4/5 (80%) | - |
| decode_sample | 5 | 5 | 4 / 4 | 4/4 (100%) | 0/1 (0%) |
| frame_sample | 5 | 0 | 0 / 0 | - | 4/5 (80%) |
| ocr | 5 | 0 | 0 / 0 | - | 4/5 (80%) |
| arr_lookup | 5 | 4 | 1 / 1 | 0/1 (0%) | 4/4 (100%) |
| prior_record | 0 | 1 | 0 / 0 | - | - |

### muse-glimmer:30b: metadata_naming (5 run-cases, 3 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 3 | 3 | 2 / 2 | 2/2 (100%) | 0/1 (0%) |
| decode_sample | 2 | 2 | 2 / 2 | 2/2 (100%) | - |
| frame_sample | 2 | 0 | 0 / 0 | - | 2/2 (100%) |
| ocr | 2 | 2 | 0 / 0 | - | 2/2 (100%) |
| epub_inspect | 2 | 2 | 2 / 2 | 1/2 (50%) | - |
| audiobook_inspect | 1 | 0 | 1 / 1 | 0/1 (0%) | - |
| arr_lookup | 5 | 5 | 2 / 2 | 1/2 (50%) | 2/3 (67%) |

### muse-glimmer:30b: order_edition_ambiguity (3 run-cases, 2 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 3 | 3 | 3 / 3 | 2/3 (67%) | - |
| decode_sample | 2 | 2 | 1 / 1 | 0/1 (0%) | 1/1 (100%) |
| frame_sample | 2 | 0 | 0 / 0 | - | 1/2 (50%) |
| ocr | 2 | 2 | 0 / 0 | - | 1/2 (50%) |
| audiobook_inspect | 1 | 0 | 1 / 1 | 1/1 (100%) | - |
| arr_lookup | 3 | 3 | 1 / 1 | 1/1 (100%) | 1/2 (50%) |

### muse-glimmer:30b: insufficient_evidence (12 run-cases, 8 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 5 | 5 | 3 / 3 | 0/3 (0%) | 1/2 (50%) |
| decode_sample | 4 | 4 | 3 / 4 | 0/3 (0%) | 1/1 (100%) |
| frame_sample | 4 | 0 | 1 / 1 | 1/1 (100%) | 0/3 (0%) |
| ocr | 4 | 1 | 1 / 1 | 1/1 (100%) | 0/3 (0%) |
| epub_inspect | 1 | 0 | 1 / 1 | 1/1 (100%) | - |
| audiobook_inspect | 1 | 0 | 1 / 2 | 0/1 (0%) | - |
| arr_lookup | 6 | 5 | 2 / 2 | 2/2 (100%) | 0/4 (0%) |
| prior_record | 0 | 7 | 0 / 0 | - | - |

### muse-glimmer:30b: healthy (13 run-cases, 11 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 10 | 10 | 10 / 10 | 8/10 (80%) | - |
| decode_sample | 8 | 8 | 6 / 6 | 5/6 (83%) | 1/2 (50%) |
| frame_sample | 8 | 0 | 0 / 0 | - | 6/8 (75%) |
| ocr | 8 | 5 | 0 / 0 | - | 6/8 (75%) |
| epub_inspect | 3 | 3 | 3 / 3 | 3/3 (100%) | - |
| audiobook_inspect | 2 | 0 | 2 / 2 | 2/2 (100%) | - |
| arr_lookup | 13 | 12 | 6 / 6 | 5/6 (83%) | 6/7 (86%) |

### qwen3.8:27b: identity_mismatch (56 run-cases, 36 correct as run) <- identity_mismatch, see section 7

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 20 | 20 | 0 / 0 | - | 14/20 (70%) |
| decode_sample | 16 | 16 | 0 / 0 | - | 12/16 (75%) |
| frame_sample | 16 | 0 | 2 / 2 | 2/2 (100%) | 10/14 (71%) |
| ocr | 16 | 12 | 5 / 7 | 5/5 (100%) | 7/11 (64%) |
| epub_inspect | 16 | 16 | 8 / 10 | 5/8 (62%) | 4/8 (50%) |
| audiobook_inspect | 4 | 0 | 4 / 4 | 2/4 (50%) | - |
| arr_lookup | 36 | 32 | 10 / 10 | 4/10 (40%) | 19/26 (73%) |
| prior_record | 0 | 20 | 0 / 0 | - | - |

### qwen3.8:27b: corrupt_file (84 run-cases, 83 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 56 | 56 | 0 / 0 | - | 55/56 (98%) |
| decode_sample | 36 | 24 | 12 / 12 | 12/12 (100%) | 23/24 (96%) |
| frame_sample | 36 | 0 | 0 / 0 | - | 35/36 (97%) |
| ocr | 36 | 0 | 0 / 0 | - | 35/36 (97%) |
| epub_inspect | 28 | 28 | 2 / 2 | 2/2 (100%) | 26/26 (100%) |
| audiobook_inspect | 20 | 0 | 18 / 18 | 18/18 (100%) | 2/2 (100%) |
| arr_lookup | 84 | 84 | 2 / 2 | 2/2 (100%) | 81/82 (99%) |

### qwen3.8:27b: decoder_incompatible (20 run-cases, 14 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 20 | 20 | 0 / 0 | - | 14/20 (70%) |
| decode_sample | 20 | 20 | 0 / 0 | - | 14/20 (70%) |
| frame_sample | 20 | 0 | 0 / 0 | - | 14/20 (70%) |
| ocr | 20 | 0 | 0 / 0 | - | 14/20 (70%) |
| arr_lookup | 20 | 16 | 0 / 0 | - | 14/20 (70%) |
| prior_record | 0 | 4 | 0 / 0 | - | - |

### qwen3.8:27b: metadata_naming (20 run-cases, 16 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 12 | 12 | 0 / 0 | - | 8/12 (67%) |
| decode_sample | 8 | 8 | 0 / 0 | - | 8/8 (100%) |
| frame_sample | 8 | 0 | 0 / 0 | - | 8/8 (100%) |
| ocr | 8 | 8 | 0 / 0 | - | 8/8 (100%) |
| epub_inspect | 8 | 8 | 3 / 3 | 3/3 (100%) | 5/5 (100%) |
| audiobook_inspect | 4 | 0 | 4 / 4 | 0/4 (0%) | - |
| arr_lookup | 20 | 20 | 2 / 2 | 2/2 (100%) | 14/18 (78%) |

### qwen3.8:27b: order_edition_ambiguity (12 run-cases, 12 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 12 | 12 | 0 / 0 | - | 12/12 (100%) |
| decode_sample | 8 | 8 | 1 / 1 | 1/1 (100%) | 7/7 (100%) |
| frame_sample | 8 | 0 | 0 / 0 | - | 8/8 (100%) |
| ocr | 8 | 8 | 0 / 0 | - | 8/8 (100%) |
| audiobook_inspect | 4 | 0 | 4 / 4 | 4/4 (100%) | - |
| arr_lookup | 12 | 12 | 2 / 2 | 2/2 (100%) | 10/10 (100%) |

### qwen3.8:27b: insufficient_evidence (48 run-cases, 36 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 20 | 20 | 1 / 1 | 1/1 (100%) | 7/19 (37%) |
| decode_sample | 16 | 16 | 12 / 18 | 4/12 (33%) | 2/4 (50%) |
| frame_sample | 16 | 0 | 5 / 6 | 1/5 (20%) | 5/11 (45%) |
| ocr | 16 | 4 | 7 / 9 | 3/7 (43%) | 3/9 (33%) |
| epub_inspect | 4 | 0 | 4 / 5 | 4/4 (100%) | - |
| audiobook_inspect | 4 | 0 | 4 / 4 | 2/4 (50%) | - |
| arr_lookup | 24 | 20 | 7 / 7 | 5/7 (71%) | 7/17 (41%) |
| prior_record | 0 | 28 | 0 / 0 | - | - |

### qwen3.8:27b: healthy (52 run-cases, 50 correct as run)

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 40 | 40 | 1 / 1 | 1/1 (100%) | 37/39 (95%) |
| decode_sample | 32 | 32 | 11 / 11 | 11/11 (100%) | 19/21 (90%) |
| frame_sample | 32 | 0 | 1 / 1 | 1/1 (100%) | 29/31 (94%) |
| ocr | 32 | 20 | 4 / 4 | 4/4 (100%) | 26/28 (93%) |
| epub_inspect | 12 | 12 | 4 / 4 | 4/4 (100%) | 8/8 (100%) |
| audiobook_inspect | 8 | 0 | 8 / 8 | 8/8 (100%) | - |
| arr_lookup | 52 | 48 | 7 / 7 | 7/7 (100%) | 43/45 (96%) |

## 7. identity_mismatch: wrong-episode and wrong-content files

The owner's goal is a local model scanning a whole TV series for such files. The suite has 4 tv identity cases (`tv-identity-*`); the table lists every full run.

| run | model | identity_mismatch cases correct, all media (as run) | guards undone | misses that named identity_mismatch but chose another action |
|---|---|---|---|---|
| dev-c4/devc4-v4g-muse-glimmer-30b | muse-glimmer:30b | 13/14 (93%) | no restored run | 0 of 1 |
| dev-c4/devc4-v4g-qwen3.8-27b | qwen3.8:27b | 13/14 (93%) | no restored run | 0 of 1 |
| dev-c5/devc5-b-qwen3.8-27b | qwen3.8:27b | 11/14 (79%) | 11/14 (79%) | 2 of 3 |
| dev-c6/devc6-qwen3.8-27b | qwen3.8:27b | 6/14 (43%) | 6/14 (43%) | 6 of 8 |
| dev-c7-qwen-r2/devc7r2-qwen3.8-27b | qwen3.8:27b | 6/14 (43%) | 6/14 (43%) | 3 of 8 |

Per tv identity case (local runs). Each cell is `pre-supplied evidence of the type / calls made` and a star when the final decision cited it; `-` means the case does not offer the tool and carries none.

| run | case | correct | decision class/action | ffprobe | decode_sample | frame_sample | ocr | arr_lookup | prior_record |
|---|---|---|---|---|---|---|---|---|---|
| dev-c4/devc4-v4g-muse-glimmer-30b | tv-identity-001 | yes | identity_mismatch/escalate | - | - | - | - | - | 1/0* |
| dev-c4/devc4-v4g-muse-glimmer-30b | tv-identity-002 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0* | 0/1 | 1/1* | 0/1 | - |
| dev-c4/devc4-v4g-muse-glimmer-30b | tv-identity-003 | yes | identity_mismatch/blocklist_and_search | 1/1* | 1/1* | 0/0 | 1/0* | 1/0* | - |
| dev-c4/devc4-v4g-muse-glimmer-30b | tv-identity-004 | yes | identity_mismatch/blocklist_and_search | 1/1* | 1/1* | 0/0 | 0/0 | 1/0* | - |
| dev-c4/devc4-v4g-qwen3.8-27b | tv-identity-001 | yes | identity_mismatch/escalate | - | - | - | - | - | 1/0* |
| dev-c4/devc4-v4g-qwen3.8-27b | tv-identity-002 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0* | 0/1 | 1/1* | 0/1 | - |
| dev-c4/devc4-v4g-qwen3.8-27b | tv-identity-003 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/0 | 1/0* | 1/0* | - |
| dev-c4/devc4-v4g-qwen3.8-27b | tv-identity-004 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/1 | 0/3* | 1/0* | - |
| dev-c5/devc5-b-qwen3.8-27b | tv-identity-001 | yes | identity_mismatch/escalate | - | - | - | - | - | 1/0* |
| dev-c5/devc5-b-qwen3.8-27b | tv-identity-002 | yes | identity_mismatch/blocklist_and_search | 1/0 | 1/0 | 0/0 | 1/0* | 0/1 | - |
| dev-c5/devc5-b-qwen3.8-27b | tv-identity-003 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/0 | 1/0* | 1/0* | - |
| dev-c5/devc5-b-qwen3.8-27b | tv-identity-004 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/0 | 0/1* | 1/0* | - |
| dev-c6/devc6-qwen3.8-27b | tv-identity-001 | yes | identity_mismatch/escalate | - | - | - | - | - | 1/0* |
| dev-c6/devc6-qwen3.8-27b | tv-identity-002 | NO | identity_mismatch/escalate | 1/0* | 1/0* | 0/0 | 1/0* | 0/1* | - |
| dev-c6/devc6-qwen3.8-27b | tv-identity-003 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/0 | 1/0* | 1/0* | - |
| dev-c6/devc6-qwen3.8-27b | tv-identity-004 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/0 | 0/1* | 1/1* | - |
| dev-c7-qwen-r2/devc7r2-qwen3.8-27b | tv-identity-001 | yes | identity_mismatch/escalate | - | - | - | - | - | 1/0* |
| dev-c7-qwen-r2/devc7r2-qwen3.8-27b | tv-identity-002 | NO | insufficient_evidence/escalate | 1/0 | 1/0 | 0/0 | 1/0* | 0/1* | - |
| dev-c7-qwen-r2/devc7r2-qwen3.8-27b | tv-identity-003 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/0 | 1/0* | 1/0* | - |
| dev-c7-qwen-r2/devc7r2-qwen3.8-27b | tv-identity-004 | yes | identity_mismatch/blocklist_and_search | 1/0* | 1/0 | 0/0 | 0/1* | 1/1* | - |

Pooled over local runs, identity_mismatch only (all media):

**muse-glimmer:30b**: 14 run-cases, 13 correct as run.

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 5 | 5 | 3 / 3 | 3/3 (100%) | 2/2 (100%) |
| decode_sample | 4 | 4 | 3 / 3 | 3/3 (100%) | 1/1 (100%) |
| frame_sample | 4 | 0 | 1 / 1 | 1/1 (100%) | 3/3 (100%) |
| ocr | 4 | 3 | 1 / 1 | 1/1 (100%) | 3/3 (100%) |
| epub_inspect | 4 | 4 | 4 / 4 | 3/4 (75%) | - |
| audiobook_inspect | 1 | 0 | 1 / 1 | 1/1 (100%) | - |
| arr_lookup | 9 | 8 | 5 / 5 | 4/5 (80%) | 4/4 (100%) |
| prior_record | 0 | 5 | 0 / 0 | - | - |

**qwen3.8:27b**: 56 run-cases, 36 correct as run.

| tool | offered | pre-supplied | called (cases / calls) | correct: called | correct: not called |
|---|---|---|---|---|---|
| ffprobe | 20 | 20 | 0 / 0 | - | 14/20 (70%) |
| decode_sample | 16 | 16 | 0 / 0 | - | 12/16 (75%) |
| frame_sample | 16 | 0 | 2 / 2 | 2/2 (100%) | 10/14 (71%) |
| ocr | 16 | 12 | 5 / 7 | 5/5 (100%) | 7/11 (64%) |
| epub_inspect | 16 | 16 | 8 / 10 | 5/8 (62%) | 4/8 (50%) |
| audiobook_inspect | 4 | 0 | 4 / 4 | 2/4 (50%) | - |
| arr_lookup | 36 | 32 | 10 / 10 | 4/10 (40%) | 19/26 (73%) |
| prior_record | 0 | 20 | 0 / 0 | - | - |

## 8. Fields the records could not support

- Whether a result was actually used by the model beyond being cited: the records hold the cited refs, not the reasoning, so "cited" is the only usefulness signal here.
- Per-tool wall time and cost: not computed (records carry per-turn time and usage, not a per-tool split that this report attributes).
- Guards-undone figures exist only for dev-c5, dev-c6, dev-c7 and dev-c7-qwen-r2 (paired `-restored` runs); dev-c3 ran without guards, and dev-c4 has no restored run (its guards v1 scores are in `runs/dev-c4/unguarded-scores`, not read here).
- The dev-c7 qwen run stopped after 5 of 73 cases (GPU API check); it is listed and flagged but kept out of every pooled number.
- Tool use on held-out cases: not read (forbidden by the work order).
- dev-c8 what-if and dev-validity-opus55 runs are outside this report's scope.
