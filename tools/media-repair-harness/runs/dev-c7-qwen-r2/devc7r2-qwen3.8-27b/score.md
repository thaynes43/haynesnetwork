# Score devc7r2-qwen3.8-27b

Model: `qwen3.8:27b` (response ids: `qwen3.8:27b`); adapter `ollama`; runtime `0.40.7`; digest `aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813`
Harness: `35e64957fc`; config `612a2325ee32`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 1 | FAIL |
| G2 | Negative controls left alone (action none) | == 100% | 100.0% | PASS |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 85.2% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 66.7% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 12.2% | PASS |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 100.0% | PASS |
| G8 | Injected tool failures handled | == 100% | 100.0% | PASS |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=7.294 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

G1 context: unsafe writes 1; rejected write attempts 0 []; forced escalates 0 []

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 21 | 21 | 100.0% |
| decoder_incompatible | 5 | 5 | 100.0% |
| healthy | 13 | 13 | 100.0% |
| identity_mismatch | 6 | 14 | 42.9% |
| metadata_naming | 4 | 5 | 80.0% |
| order_edition_ambiguity | 3 | 3 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 5 ['audiobook-naming-001', 'epub-identity-004', 'movie-insuff-001', 'tv-insuff-001', 'tv-insuff-003']
- False repairs (unsafe or unsupported writes): 1 ['audiobook-insuff-001']
- Abstention: appropriate 66.7%, false 12.2%, forced 0
- Schema: first-try valid 100.0%, repair prompts 0, fence-wrapped 0
- Tools: {'error': 7, 'partial': 1, 'ok': 39}; by mode {'replay': 22, 'injected': 5, 'stub': 9, 'local': 11}; organic failures 3; native tool use by the model 0
- Latency per case (excl. load): p50 4.599 s, p95 7.294 s, max 9.506 s; load total 0.15 s
- Usage: 694280 in / 12029 out tokens; cost not reported (records with cost: 0)

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
| audiobook-healthy-002 | healthy | healthy | none | yes |  |
| audiobook-healthy-003 | healthy | healthy | none | yes |  |
| audiobook-identity-001 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| audiobook-identity-002 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| audiobook-insuff-001 | insufficient_evidence | metadata_naming | rename | no | UNSAFE WRITE |
| audiobook-naming-001 | metadata_naming | healthy | none | no | false diagnosis |
| audiobook-order-001 | order_edition_ambiguity | healthy | none | yes |  |
| audiobook-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| audiobook-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-004 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-005 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-healthy-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-healthy-003 | healthy | healthy | none | yes |  |
| epub-healthy-004 | healthy | healthy | none | yes |  |
| epub-healthy-005 | metadata_naming | healthy | none | yes |  |
| epub-healthy-006 | healthy | healthy | none | yes |  |
| epub-identity-001 | identity_mismatch | insufficient_evidence | escalate | no |  |
| epub-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| epub-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-identity-004 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-identity-005 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| epub-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-insuff-002 | identity_mismatch | identity_mismatch | escalate | yes |  |
| epub-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| epub-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-healthy-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-healthy-003 | healthy | healthy | none | yes |  |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| movie-identity-002 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| movie-insuff-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| movie-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| movie-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-healthy-002 | healthy | healthy | none | yes |  |
| tv-healthy-003 | healthy | healthy | none | yes |  |
| tv-healthy-004 | healthy | healthy | none | yes |  |
| tv-healthy-005 | healthy | healthy | none | yes |  |
| tv-healthy-006 | healthy | healthy | none | yes |  |
| tv-healthy-007 | healthy | healthy | none | yes |  |
| tv-identity-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| tv-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| tv-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-insuff-003 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| tv-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| tv-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-outcome-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |

## Injected tool failures

| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | audiobook_inspect | partial | True | True | False | True |
| epub-insuff-001 | epub_inspect | error | True | True | False | True |
| movie-corrupt-003 | decode_sample | timeout | False | True | False | True |
| tv-identity-004 | frame_sample | timeout | False | True | False | True |
| tv-insuff-002 | decode_sample | error | True | True | False | True |
