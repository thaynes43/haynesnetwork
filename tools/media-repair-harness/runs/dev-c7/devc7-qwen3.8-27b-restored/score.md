# Score devc7-qwen3.8-27b

Model: `qwen3.8:27b` (response ids: `qwen3.8:27b`); adapter `ollama`; runtime `0.40.6`; digest `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813`
Harness: `5c156965f2`; config `612a2325ee32`
Cases: 5 recorded of 73 planned (ABORTED: cannot read /api/ps (1); refusing to touch the GPU blind). **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | PASS |
| G2 | Negative controls left alone (action none) | == 100% | 0.0% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 75.0% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 100.0% | PASS |
| G5 | False abstention on solvable cases | <= 15% | 33.3% | FAIL |
| G6 | Outcome verification classified correctly | >= 90% | n/a | NOT_EVALUATED |
| G7 | Schema-valid decision on the first try | >= 98% | 5.5% | FAIL |
| G8 | Injected tool failures handled | == 100% | 100.0% | PASS |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=69, p95_s=7.357 | FAIL |
| G10 | Reproducibility fields recorded | == 100% | 80.0% | FAIL |

G1 context: unsafe writes 0; rejected write attempts 0 []; forced escalates 1 ['audiobook-healthy-002']

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 3 | 3 | 100.0% |
| healthy | 0 | 1 | 0.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 0 []
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate 100.0%, false 33.3%, forced 1
- Schema: first-try valid 5.5%, repair prompts 0, fence-wrapped 0
- Tools: {'error': 1, 'partial': 1}; by mode {'replay': 1, 'injected': 1}; organic failures 1; native tool use by the model 0
- Latency per case (excl. load): p50 5.998 s, p95 7.357 s, max 7.357 s; load total 0.01 s
- Usage: 30585 in / 610 out tokens; cost not reported (records with cost: 0)

## Suite shape vs GATES.md minimums (informational)

- held_out_cases>=30: no
- healthy>=8: yes
- insufficient_evidence_or_ambiguous>=4: yes
- every_other_class>=2: yes
- media_types_all_four: yes
- tool_failure_cases>=3: yes

## Cases

| Case | Truth | Decision | Action | OK | Notes |
|---|---|---|---|---|---|
| audiobook-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| audiobook-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| audiobook-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| audiobook-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| audiobook-healthy-002 | healthy | insufficient_evidence | escalate | no | forced, false abstention |

## Injected tool failures

| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | audiobook_inspect | partial | True | True | False | True |
