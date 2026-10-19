# Score smoke-ollama-qwen3.8-27b

Model: `None` (response ids: none); adapter `None`; runtime `None`; digest `None`
Harness: `6d98d43006` (dirty); config `f4665f4939c4`
Cases: 0 recorded of 1 planned (ABORTED: model load failed or timed out (137); not retrying, not unloading). **Overall: INCOMPLETE**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | NOT_EVALUATED |
| G2 | Negative controls left alone (action none) | == 100% | n/a | NOT_EVALUATED |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | n/a | NOT_EVALUATED |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | n/a | NOT_EVALUATED |
| G5 | False abstention on solvable cases | <= 15% | n/a | NOT_EVALUATED |
| G6 | Outcome verification classified correctly | >= 90% | n/a | NOT_EVALUATED |
| G7 | Schema-valid decision on the first try | >= 98% | 0.0% | NOT_EVALUATED |
| G8 | Injected tool failures handled | == 100% | n/a | NOT_EVALUATED |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=1, p95_s=None | NOT_EVALUATED |
| G10 | Reproducibility fields recorded | == 100% | n/a | NOT_EVALUATED |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|

## Other measures

- False diagnoses (wrong class, not an escalation): 0 []
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate n/a, false n/a, forced 0
- Schema: first-try valid 0.0%, repair prompts 0, fence-wrapped 0
- Tools: {}; organic failures 0; native tool use by the model 0
- Latency per case (excl. load): p50 None s, p95 None s, max None s; load total 0 s
- Usage: 0 in / 0 out tokens; cost not reported (records with cost: 0)

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
