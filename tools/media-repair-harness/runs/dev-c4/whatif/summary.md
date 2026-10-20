# Guard what-if (`--guards v1`, offline)

Label: dev-tuned, offline, no model calls; one dev-c3 run per model. Suite `suite-dev-v1.1`. Gate cells are `before -> after` (the unchanged score.py).

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 0 PASS | 0 PASS | 1 FAIL | 1 FAIL | 0 PASS | 7 FAIL |
| G2 | 92.3% FAIL | 92.3% FAIL | 92.3% FAIL | 61.5% FAIL | 92.3% FAIL | 92.3% FAIL |
| G3 | 88.5% PASS | 90.2% PASS | 91.8% PASS | 77.0% FAIL | 93.4% PASS -> **91.8% PASS** | 90.2% FAIL -> **88.5% FAIL** |
| G4 | 93.3% PASS | 93.3% PASS | 93.3% PASS | 86.7% FAIL -> **93.3% PASS** | 40.0% FAIL -> **73.3% FAIL** | 33.3% FAIL -> **53.3% FAIL** |
| G5 | 8.2% PASS | 6.1% PASS | 6.1% PASS | 18.4% FAIL | 2.0% PASS -> **4.1% PASS** | 0.0% PASS -> **2.0% PASS** |
| G6 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| G7 | 98.6% PASS | 100.0% PASS | 95.9% FAIL | 97.3% FAIL | 100.0% PASS | 84.9% FAIL |
| G8 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 80.0% FAIL | 80.0% FAIL |
| G9 | crashes 0, p95 12.157s PASS | crashes 0, p95 11.518s PASS | crashes 0, p95 16.669s PASS | crashes 0, p95 31.988s PASS | crashes 0, p95 7.709s PASS | crashes 0, p95 15.495s PASS |
| G10 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |

## Decisions changed by a guard

| Model | Case | Truth | Rule | Before | After | Correct before | Correct after |
|---|---|---|---|---|---|---|---|
| gpt-6-luna | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | epub-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | movie-decoder-001 | decoder_incompatible | G-write | decoder_incompatible/convert | insufficient_evidence/escalate | True | False |
| qwen3.8:27b | movie-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| qwen3.8:27b | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | audiobook-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | epub-healthy-002 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |
| muse-glimmer:30b | movie-decoder-001 | decoder_incompatible | G-write | decoder_incompatible/convert | insufficient_evidence/escalate | True | False |
| muse-glimmer:30b | tv-healthy-001 | insufficient_evidence | G-healthy | healthy/none | insufficient_evidence/escalate | False | True |

## Required check

- claude-haiku-5-5: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-sonnet-5-5: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- claude-opus-5-5: decisions changed 0; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: none
- gpt-6-luna: decisions changed 1; correct truth-healthy decisions changed: none; correct -> wrong: none; wrong -> correct: ['movie-healthy-002']
- qwen3.8:27b: decisions changed 6; correct truth-healthy decisions changed: none; correct -> wrong: ['movie-decoder-001']; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-002', 'tv-healthy-001']
- muse-glimmer:30b: decisions changed 4; correct truth-healthy decisions changed: none; correct -> wrong: ['movie-decoder-001']; wrong -> correct: ['audiobook-healthy-001', 'epub-healthy-002', 'tv-healthy-001']
