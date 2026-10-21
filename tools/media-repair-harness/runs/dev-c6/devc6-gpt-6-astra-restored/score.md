# Score devc6-gpt-6-astra

Model: `gpt-6-astra` (response ids: `gpt-6-astra`); adapter `codex`; runtime `codex-cli 0.162.1`; digest `None`
Harness: `110cca8377`; config `1b8d301123d2`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | PASS |
| G2 | Negative controls left alone (action none) | == 100% | 92.3% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 55.7% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 80.0% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 42.9% | FAIL |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 100.0% | PASS |
| G8 | Injected tool failures handled | == 100% | 80.0% | FAIL |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=27.344 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

G1 context: unsafe writes 0; rejected write attempts 0 []; forced escalates 0 []

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 9 | 21 | 42.9% |
| decoder_incompatible | 4 | 5 | 80.0% |
| healthy | 12 | 13 | 92.3% |
| identity_mismatch | 5 | 14 | 35.7% |
| metadata_naming | 2 | 5 | 40.0% |
| order_edition_ambiguity | 2 | 3 | 66.7% |

## Other measures

- False diagnoses (wrong class, not an escalation): 6 ['audiobook-insuff-001', 'audiobook-naming-001', 'epub-identity-004', 'tv-corrupt-003', 'tv-insuff-001', 'tv-insuff-002']
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate 80.0%, false 42.9%, forced 0
- Schema: first-try valid 100.0%, repair prompts 0, fence-wrapped 0
- Tools: {'ok': 33, 'error': 1}; by mode {'stub': 17, 'replay': 12, 'n/a': 3, 'injected': 1, 'pinned_replay': 1}; organic failures 0; native tool use by the model 0
- Latency per case (excl. load): p50 8.667 s, p95 27.344 s, max 29.007 s; load total 0.0 s
- Usage: 2928793 in / 14222 out tokens; cost not reported (records with cost: 0)

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
| audiobook-insuff-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| audiobook-naming-001 | metadata_naming | healthy | none | no | false diagnosis |
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
| epub-healthy-005 | metadata_naming | healthy | none | yes |  |
| epub-healthy-006 | healthy | healthy | none | yes |  |
| epub-identity-001 | identity_mismatch | insufficient_evidence | escalate | no |  |
| epub-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| epub-identity-003 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| epub-identity-004 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-identity-005 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| epub-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-insuff-002 | identity_mismatch | identity_mismatch | escalate | yes |  |
| epub-naming-001 | metadata_naming | insufficient_evidence | escalate | no | false abstention |
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
| movie-order-001 | order_edition_ambiguity | insufficient_evidence | escalate | no |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
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
| tv-identity-002 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| tv-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-002 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-003 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| tv-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| tv-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-outcome-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |

## Injected tool failures

| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |
|---|---|---|---|---|---|---|
| audiobook-corrupt-003 | audiobook_inspect | partial | False | True | False | True |
| epub-insuff-001 | epub_inspect | error | True | True | False | True |
| movie-corrupt-003 | decode_sample | timeout | False | True | False | True |
| tv-identity-004 | frame_sample | timeout | False | True | False | True |
| tv-insuff-002 | decode_sample | error | False | False | False | False |
