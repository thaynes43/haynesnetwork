# Guard what-if (offline)

Label: dev-tuned, offline, no model calls; one run per model. Suite `suite-dev-v1.1`. Cells: guards off, then each guard version (the unchanged score.py). A cell is shown once when the versions agree with off.

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b | claude-haiku-5-5 [dev-c4 v4] | qwen3.8:27b [dev-c4 v4] | muse-glimmer:30b [dev-c4 v4] |
|---|---|---|---|---|---|---|---|---|---|
| G1 | 0 PASS | 0 PASS | 1 FAIL | 1 FAIL | 0 PASS | 7 FAIL | 0 PASS | 0 PASS | 7 FAIL |
| G2 | 92.3% FAIL | 92.3% FAIL | 92.3% FAIL | 61.5% FAIL | 92.3% FAIL | 92.3% FAIL | 84.6% FAIL | 92.3% FAIL | 84.6% FAIL |
| G3 | 88.5% PASS | 90.2% PASS | 91.8% PASS | 77.0% FAIL | off 93.4% PASS; **v1** 91.8% PASS; **v2** 93.4% PASS | off 90.2% FAIL; **v1** 88.5% FAIL; **v2** 90.2% FAIL | 80.3% FAIL | off 93.4% PASS; **v1** 91.8% PASS; **v2** 93.4% PASS | off 86.9% FAIL; **v1** 85.2% FAIL; **v2** 86.9% FAIL |
| G4 | 93.3% PASS | 93.3% PASS | 93.3% PASS | off 86.7% FAIL; **v1** 93.3% PASS; **v2** 93.3% PASS | off 40.0% FAIL; **v1** 73.3% FAIL; **v2** 73.3% FAIL | off 33.3% FAIL; **v1** 53.3% FAIL; **v2** 53.3% FAIL | 100.0% PASS | off 40.0% FAIL; **v1** 80.0% FAIL; **v2** 80.0% FAIL | off 20.0% FAIL; **v1** 60.0% FAIL; **v2** 60.0% FAIL |
| G5 | 8.2% PASS | 6.1% PASS | 6.1% PASS | 18.4% FAIL | off 2.0% PASS; **v1** 4.1% PASS; **v2** 2.0% PASS | off 0.0% PASS; **v1** 2.0% PASS; **v2** 0.0% PASS | 16.3% FAIL | off 2.0% PASS; **v1** 4.1% PASS; **v2** 2.0% PASS | 2.0% PASS |
| G6 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| G7 | 98.6% PASS | 100.0% PASS | 95.9% FAIL | 97.3% FAIL | 100.0% PASS | 84.9% FAIL | 97.3% FAIL | 100.0% PASS | 100.0% PASS |
| G8 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 80.0% FAIL | 80.0% FAIL | 100.0% PASS | 80.0% FAIL | 80.0% FAIL |
| G9 | crashes 0, p95 12.157s PASS | crashes 0, p95 11.518s PASS | crashes 0, p95 16.669s PASS | crashes 0, p95 31.988s PASS | crashes 0, p95 7.709s PASS | crashes 0, p95 15.495s PASS | crashes 0, p95 16.949s PASS | crashes 0, p95 7.187s PASS | crashes 0, p95 15.35s PASS |
| G10 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |

## Decisions changed by a guard

| Model | Version | Case | Truth | Rule | Before | After | Correct before | Correct after |
|---|---|---|---|---|---|---|---|---|
| gpt-6-luna | v1 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| gpt-6-luna | v2 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v1 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v1 | epub-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v1 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v1 | movie-decoder-001 | decoder_incompatible | G-write | decoder_incompatible/convert | insufficient_evidence/escalate | True | False |
| qwen3.8:27b | v1 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v1 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v2 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v2 | epub-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v2 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v2 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | v2 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | v1 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | v1 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | v1 | movie-decoder-001 | decoder_incompatible | G-write | decoder_incompatible/convert | insufficient_evidence/escalate | True | False |
| muse-glimmer:30b | v1 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | v2 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | v2 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | v2 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v1 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v1 | epub-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v1 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v1 | movie-decoder-001 | decoder_incompatible | G-write | decoder_incompatible/convert | insufficient_evidence/escalate | True | False |
| qwen3.8:27b [dev-c4 v4] | v1 | movie-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v1 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v1 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v2 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v2 | epub-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v2 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v2 | movie-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v2 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b [dev-c4 v4] | v2 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v1 | audiobook-corrupt-003 | corrupt_file | G-write | corrupt_file/blocklist_and_search | insufficient_evidence/escalate | True | False |
| muse-glimmer:30b [dev-c4 v4] | v1 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v1 | epub-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v1 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v1 | movie-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v1 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v1 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v2 | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v2 | epub-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v2 | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v2 | movie-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v2 | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b [dev-c4 v4] | v2 | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |

## Required check

- claude-haiku-5-5, v1: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-haiku-5-5, v2: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-sonnet-5-5, v1: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-sonnet-5-5, v2: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-opus-5-5, v1: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-opus-5-5, v2: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- gpt-6-luna, v1: decisions changed 1; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: ['movie-healthy-002']
- gpt-6-luna, v2: decisions changed 1; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: ['movie-healthy-002']
- qwen3.8:27b, v1: decisions changed 6; correct truth-healthy decisions changed: none; correct -> wrong: ['movie-decoder-001']; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-002', 'tv-healthy-001']
- qwen3.8:27b, v2: decisions changed 5; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-002', 'tv-healthy-001']
- muse-glimmer:30b, v1: decisions changed 4; correct truth-healthy decisions changed: none; correct -> wrong: ['movie-decoder-001']; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-002', 'tv-healthy-001']
- muse-glimmer:30b, v2: decisions changed 3; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-002', 'tv-healthy-001']
- claude-haiku-5-5 [dev-c4 v4], v1: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-haiku-5-5 [dev-c4 v4], v2: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- qwen3.8:27b [dev-c4 v4], v1: decisions changed 7; correct truth-healthy decisions changed: none; correct -> wrong: ['movie-decoder-001']; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-001', 'movie-healthy-002', 'tv-healthy-001']
- qwen3.8:27b [dev-c4 v4], v2: decisions changed 6; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-001', 'movie-healthy-002', 'tv-healthy-001']
- muse-glimmer:30b [dev-c4 v4], v1: decisions changed 7; correct truth-healthy decisions changed: none; correct -> wrong: ['audiobook-corrupt-003']; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-001', 'movie-healthy-002', 'tv-healthy-001']
- muse-glimmer:30b [dev-c4 v4], v2: decisions changed 6; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-001', 'movie-healthy-002', 'tv-healthy-001']
