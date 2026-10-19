# Score testdata-claude-claude-haiku-5-5

Model: `claude-haiku-5-5` (response ids: `claude-haiku-5-5`); adapter `claude`; runtime `2.1.299 (Claude Code)`; digest `None`
Harness: `6d98d43006` (dirty); config `e463be504936`
Cases: 4 recorded of 4 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | PASS |
| G2 | Negative controls left alone (action none) | == 100% | 100.0% | PASS |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 100.0% | PASS |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 100.0% | PASS |
| G5 | False abstention on solvable cases | <= 15% | 0.0% | PASS |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 75.0% | FAIL |
| G8 | Injected tool failures handled | == 100% | 100.0% | PASS |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=7.835 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 1 | 1 | 100.0% |
| healthy | 1 | 1 | 100.0% |
| identity_mismatch | 1 | 1 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 0 []
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate 100.0%, false 0.0%, forced 0
- Schema: first-try valid 75.0%, repair prompts 1, fence-wrapped 0
- Tools: {'ok': 3}; organic failures 0; native tool use by the model 0
- Latency per case (excl. load): p50 6.997 s, p95 7.835 s, max 7.835 s; load total 0.0 s
- Usage: 16 in / 1925 out tokens; cost $0.0027 (records with cost: 4)

## Suite shape vs GATES.md minimums (informational)

- held_out_cases>=30: no
- healthy>=8: no
- insufficient_evidence_or_ambiguous>=4: no
- every_other_class>=2: no
- media_types_all_four: no
- tool_failure_cases>=3: no

## Cases

| Case | Truth | Decision | Action | OK | Notes |
|---|---|---|---|---|---|
| td-epub-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| td-epub-healthy-001 | healthy | healthy | none | yes |  |
| td-epub-mismatch-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| td-tv-noevidence-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |

## Injected tool failures

| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |
|---|---|---|---|---|---|---|
| td-tv-noevidence-001 | decode_sample | timeout | False | True | False | True |
