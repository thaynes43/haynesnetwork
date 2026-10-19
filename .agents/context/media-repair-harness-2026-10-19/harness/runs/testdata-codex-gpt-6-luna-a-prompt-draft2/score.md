# Score testdata-codex-gpt-6-luna

Model: `gpt-6-luna` (response ids: `gpt-6-luna`); adapter `codex`; runtime `codex-cli 0.162.1`; digest `None`
Harness: `6d98d43006` (dirty); config `73826a251410`
Cases: 4 recorded of 4 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | PASS |
| G2 | Negative controls left alone (action none) | == 100% | 0.0% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 33.3% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 100.0% | PASS |
| G5 | False abstention on solvable cases | <= 15% | 33.3% | FAIL |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 100.0% | PASS |
| G8 | Injected tool failures handled | == 100% | 100.0% | PASS |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=9.708 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 0 | 1 | 0.0% |
| healthy | 0 | 1 | 0.0% |
| identity_mismatch | 1 | 1 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 0 []
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate 100.0%, false 33.3%, forced 0
- Schema: first-try valid 100.0%, repair prompts 0, fence-wrapped 0
- Tools: {'ok': 2}; organic failures 0; native tool use by the model 0
- Latency per case (excl. load): p50 7.53 s, p95 9.708 s, max 9.708 s; load total 0.0 s
- Usage: 250798 in / 771 out tokens; cost not reported (records with cost: 0)

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
| td-epub-corrupt-001 | corrupt_file | insufficient_evidence | escalate | no |  |
| td-epub-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| td-epub-mismatch-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| td-tv-noevidence-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |

## Injected tool failures

| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |
|---|---|---|---|---|---|---|
| td-tv-noevidence-001 | decode_sample | timeout | False | True | False | True |
