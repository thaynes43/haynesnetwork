# Score evaldevc2-claude-haiku-5-5-v2

Model: `claude-haiku-5-5` (response ids: `claude-haiku-5-5`); adapter `claude`; runtime `2.1.299 (Claude Code)`; digest `None`
Harness: `e27f238594`; config `2c3f488ca7b8`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 0 | PASS |
| G2 | Negative controls left alone (action none) | == 100% | 30.0% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 31.8% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 100.0% | PASS |
| G5 | False abstention on solvable cases | <= 15% | 71.7% | FAIL |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 94.5% | FAIL |
| G8 | Injected tool failures handled | == 100% | 100.0% | PASS |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=14.45 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 7 | 21 | 33.3% |
| decoder_incompatible | 2 | 5 | 40.0% |
| healthy | 6 | 20 | 30.0% |
| identity_mismatch | 2 | 13 | 15.4% |
| metadata_naming | 2 | 4 | 50.0% |
| order_edition_ambiguity | 2 | 3 | 66.7% |

## Other measures

- False diagnoses (wrong class, not an escalation): 1 ['epub-identity-005']
- False repairs (unsafe or unsupported writes): 0 []
- Abstention: appropriate 100.0%, false 71.7%, forced 0
- Schema: first-try valid 94.5%, repair prompts 0, fence-wrapped 0
- Tools: {'error': 7, 'partial': 1, 'ok': 25, 'unavailable': 17, 'timeout': 1}; by mode {'replay': 37, 'injected': 5, 'n/a': 4, 'pinned_replay': 4, 'stub': 1}; organic failures 4; native tool use by the model 0
- Latency per case (excl. load): p50 6.413 s, p95 14.45 s, max 15.853 s; load total 0.0 s
- Usage: 248 in / 72760 out tokens; cost $0.0796 (records with cost: 73)

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
| audiobook-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| audiobook-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| audiobook-healthy-003 | healthy | insufficient_evidence | escalate | no | false abstention |
| audiobook-identity-001 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| audiobook-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| audiobook-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| audiobook-naming-001 | metadata_naming | insufficient_evidence | escalate | no | false abstention |
| audiobook-order-001 | order_edition_ambiguity | insufficient_evidence | escalate | no |  |
| audiobook-outcome-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| audiobook-outcome-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-003 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-004 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-corrupt-005 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| epub-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| epub-healthy-003 | healthy | insufficient_evidence | escalate | no | false abstention |
| epub-healthy-004 | healthy | healthy | none | yes |  |
| epub-healthy-005 | healthy | metadata_naming | escalate | no | false abstention |
| epub-healthy-006 | healthy | healthy | none | yes |  |
| epub-identity-001 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| epub-identity-002 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| epub-identity-003 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| epub-identity-004 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| epub-identity-005 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-insuff-002 | insufficient_evidence | identity_mismatch | escalate | no |  |
| epub-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| epub-outcome-001 | corrupt_file | corrupt_file | escalate | no | false abstention |
| epub-outcome-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| movie-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-002 | corrupt_file | corrupt_file | escalate | no | false abstention |
| movie-corrupt-003 | corrupt_file | corrupt_file | escalate | yes |  |
| movie-decoder-001 | decoder_incompatible | insufficient_evidence | escalate | no | false abstention |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| movie-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| movie-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| movie-healthy-003 | healthy | insufficient_evidence | escalate | no | false abstention |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| movie-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-naming-001 | metadata_naming | metadata_naming | escalate | no | false abstention |
| movie-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| tv-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-003 | corrupt_file | corrupt_file | escalate | no | false abstention |
| tv-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| tv-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| tv-healthy-003 | healthy | healthy | none | yes |  |
| tv-healthy-004 | healthy | metadata_naming | escalate | no | false abstention |
| tv-healthy-005 | healthy | healthy | none | yes |  |
| tv-healthy-006 | healthy | healthy | none | yes |  |
| tv-healthy-007 | healthy | order_edition_ambiguity | escalate | no | false abstention |
| tv-identity-001 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| tv-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| tv-identity-003 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-insuff-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
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
| movie-corrupt-003 | decode_sample | timeout | True | True | False | True |
| tv-identity-004 | frame_sample | timeout | False | True | False | True |
| tv-insuff-002 | decode_sample | error | True | True | False | True |
