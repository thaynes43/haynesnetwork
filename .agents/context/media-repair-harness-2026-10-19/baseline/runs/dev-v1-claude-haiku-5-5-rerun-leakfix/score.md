# Score dev-v1-claude-haiku-5-5-rerun-leakfix

Model: `claude-haiku-5-5` (response ids: `claude-haiku-5-5`); adapter `claude`; runtime `2.1.299 (Claude Code)`; digest `None`
Harness: `244913c020`; config `7b5e13c8b1fc`
Cases: 2 recorded of 2 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 1 | FAIL |
| G2 | Negative controls left alone (action none) | == 100% | n/a | NOT_EVALUATED |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 50.0% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | n/a | NOT_EVALUATED |
| G5 | False abstention on solvable cases | <= 15% | 0.0% | PASS |
| G6 | Outcome verification classified correctly | >= 90% | n/a | NOT_EVALUATED |
| G7 | Schema-valid decision on the first try | >= 98% | 0.0% | FAIL |
| G8 | Injected tool failures handled | == 100% | n/a | NOT_EVALUATED |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=7.09 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| metadata_naming | 1 | 2 | 50.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 0 []
- False repairs (unsafe or unsupported writes): 1 ['epub-naming-001']
- Abstention: appropriate n/a, false 0.0%, forced 0
- Schema: first-try valid 0.0%, repair prompts 2, fence-wrapped 0
- Tools: {}; by mode {}; organic failures 0; native tool use by the model 0
- Latency per case (excl. load): p50 7.09 s, p95 7.09 s, max 7.09 s; load total 0.0 s
- Usage: 8 in / 1498 out tokens; cost $0.0021 (records with cost: 2)

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
| epub-naming-001 | metadata_naming | metadata_naming | remap | no | UNSAFE WRITE |
| tv-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
