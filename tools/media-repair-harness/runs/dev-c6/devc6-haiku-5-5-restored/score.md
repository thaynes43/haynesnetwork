# Score devc6-haiku-5-5

Model: `claude-haiku-5-5` (response ids: `claude-haiku-5-5`); adapter `claude`; runtime `2.1.299 (Claude Code)`; digest `None`
Harness: `110cca8377`; config `236730a25043`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | PASS |
| G2 | Negative controls left alone (action none) | == 100% | 92.3% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 54.1% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 86.7% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 46.9% | FAIL |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 47.9% | FAIL |
| G8 | Injected tool failures handled | == 100% | 80.0% | FAIL |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=20.117 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

G1 context: unsafe writes 0; rejected write attempts 2 ['movie-corrupt-003', 'movie-identity-002']; forced escalates 1 ['epub-identity-003']

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 7 | 21 | 33.3% |
| decoder_incompatible | 4 | 5 | 80.0% |
| healthy | 12 | 13 | 92.3% |
| identity_mismatch | 5 | 14 | 35.7% |
| metadata_naming | 2 | 5 | 40.0% |
| order_edition_ambiguity | 3 | 3 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 4 ['epub-identity-005', 'tv-corrupt-003', 'tv-insuff-001', 'tv-insuff-002']
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate 86.7%, false 46.9%, forced 1
- Schema: first-try valid 47.9%, repair prompts 38, fence-wrapped 0
- Tools: {'ok': 21, 'partial': 1, 'error': 1}; by mode {'stub': 13, 'injected': 2, 'replay': 8}; organic failures 0; native tool use by the model 0
- Latency per case (excl. load): p50 10.444 s, p95 20.117 s, max 26.752 s; load total 0.0 s
- Usage: 268 in / 123153 out tokens; cost $0.1350 (records with cost: 73)

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
| audiobook-corrupt-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| audiobook-corrupt-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| audiobook-corrupt-003 | corrupt_file | corrupt_file | escalate | yes |  |
| audiobook-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| audiobook-healthy-002 | healthy | healthy | none | yes |  |
| audiobook-healthy-003 | healthy | healthy | none | yes |  |
| audiobook-identity-001 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| audiobook-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| audiobook-insuff-001 | insufficient_evidence | metadata_naming | escalate | yes |  |
| audiobook-naming-001 | metadata_naming | metadata_naming | escalate | no | false abstention |
| audiobook-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| audiobook-outcome-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| audiobook-outcome-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-003 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-004 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-005 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-healthy-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-healthy-003 | healthy | healthy | none | yes |  |
| epub-healthy-004 | healthy | healthy | none | yes |  |
| epub-healthy-005 | metadata_naming | metadata_naming | escalate | yes |  |
| epub-healthy-006 | healthy | healthy | none | yes |  |
| epub-identity-001 | identity_mismatch | insufficient_evidence | escalate | no |  |
| epub-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| epub-identity-003 | identity_mismatch | insufficient_evidence | escalate | no | forced, false abstention |
| epub-identity-004 | identity_mismatch | insufficient_evidence | escalate | no |  |
| epub-identity-005 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-insuff-002 | identity_mismatch | identity_mismatch | escalate | yes |  |
| epub-naming-001 | metadata_naming | metadata_naming | escalate | no | false abstention |
| epub-outcome-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-outcome-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| movie-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-decoder-001 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-healthy-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-healthy-003 | healthy | healthy | none | yes |  |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | insufficient_evidence | escalate | no |  |
| movie-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-naming-001 | metadata_naming | insufficient_evidence | escalate | no | false abstention |
| movie-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-corrupt-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| tv-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-003 | corrupt_file | healthy | none | no | false diagnosis |
| tv-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-healthy-002 | healthy | healthy | none | yes |  |
| tv-healthy-003 | healthy | healthy | none | yes |  |
| tv-healthy-004 | healthy | healthy | none | yes |  |
| tv-healthy-005 | healthy | healthy | none | yes |  |
| tv-healthy-006 | healthy | insufficient_evidence | escalate | no | false abstention |
| tv-healthy-007 | healthy | healthy | none | yes |  |
| tv-identity-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| tv-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| tv-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-002 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-003 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| tv-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| tv-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-outcome-003 | corrupt_file | corrupt_file | escalate | no | false abstention |

## Injected tool failures

| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | audiobook_inspect | partial | True | True | False | True |
| epub-insuff-001 | epub_inspect | error | True | True | False | True |
| movie-corrupt-003 | decode_sample | timeout | False | True | False | True |
| tv-identity-004 | frame_sample | timeout | False | True | False | True |
| tv-insuff-002 | decode_sample | error | False | False | False | False |
