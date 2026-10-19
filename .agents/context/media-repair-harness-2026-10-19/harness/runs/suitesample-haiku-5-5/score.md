# Score suitesample-haiku-5-5

Model: `claude-haiku-5-5` (response ids: `claude-haiku-5-5`); adapter `claude`; runtime `2.1.299 (Claude Code)`; digest `None`
Harness: `8fc5381cfe` (dirty); config `7b5e13c8b1fc`
Cases: 9 recorded of 9 planned. **Overall: PASS**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | PASS |
| G2 | Negative controls left alone (action none) | == 100% | 100.0% | PASS |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 87.5% | PASS |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 100.0% | PASS |
| G5 | False abstention on solvable cases | <= 15% | 0.0% | PASS |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 100.0% | PASS |
| G8 | Injected tool failures handled | == 100% | 100.0% | PASS |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=10.728 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 4 | 5 | 80.0% |
| decoder_incompatible | 1 | 1 | 100.0% |
| healthy | 1 | 1 | 100.0% |
| order_edition_ambiguity | 1 | 1 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 1 ['tv-corrupt-003']
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate 100.0%, false 0.0%, forced 0
- Schema: first-try valid 100.0%, repair prompts 0, fence-wrapped 0
- Tools: {'partial': 1, 'error': 2, 'ok': 2}; by mode {'injected': 1, 'replay': 3, 'stub': 1}; organic failures 2; native tool use by the model 0
- Latency per case (excl. load): p50 3.93 s, p95 10.728 s, max 10.728 s; load total 0.0 s
- Usage: 28 in / 5138 out tokens; cost $0.0069 (records with cost: 9)

## Suite shape vs GATES.md minimums (informational)

- held_out_cases>=30: no
- healthy>=8: no
- insufficient_evidence_or_ambiguous>=4: no
- every_other_class>=2: no
- media_types_all_four: yes
- tool_failure_cases>=3: no

## Cases

| Case | Truth | Decision | Action | OK | Notes |
|---|---|---|---|---|---|
| audiobook-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-healthy-004 | healthy | healthy | none | yes |  |
| movie-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-corrupt-003 | corrupt_file | healthy | none | no | false diagnosis |
| tv-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| tv-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |

## Injected tool failures

| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | audiobook_inspect | partial | True | True | False | True |
| movie-corrupt-003 | decode_sample | timeout | False | True | False | True |
