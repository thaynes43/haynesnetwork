# Score evaldevc4v11-claude-opus-5-5-v4g2

Model: `claude-opus-5-5` (response ids: `claude-opus-5-5`); adapter `claude`; runtime `2.1.299 (Claude Code)`; digest `None`
Harness: `f38f605b56`; config `3f129a230445`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 1 | FAIL |
| G2 | Negative controls left alone (action none) | == 100% | 92.3% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 93.4% | PASS |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 86.7% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 4.1% | PASS |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 95.9% | FAIL |
| G8 | Injected tool failures handled | == 100% | 80.0% | FAIL |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=23.696 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

G1 context: unsafe writes 1; rejected write attempts 2 ['movie-naming-001', 'tv-outcome-002']; forced escalates 0 []

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 21 | 21 | 100.0% |
| decoder_incompatible | 4 | 5 | 80.0% |
| healthy | 12 | 13 | 92.3% |
| identity_mismatch | 12 | 14 | 85.7% |
| metadata_naming | 5 | 5 | 100.0% |
| order_edition_ambiguity | 3 | 3 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 3 ['epub-identity-004', 'movie-insuff-001', 'tv-insuff-002']
- False repairs (unsafe or unsupported writes): 1 ['movie-insuff-001']
- Abstention: appropriate 86.7%, false 4.1%, forced 0
- Schema: first-try valid 95.9%, repair prompts 3, fence-wrapped 0
- Tools: {'error': 7, 'partial': 1, 'ok': 42, 'timeout': 1, 'unavailable': 4}; by mode {'replay': 41, 'injected': 5, 'n/a': 2, 'pinned_replay': 4, 'stub': 3}; organic failures 4; native tool use by the model 0
- Latency per case (excl. load): p50 10.168 s, p95 23.696 s, max 28.203 s; load total 0.0 s
- Usage: 262 in / 50710 out tokens; cost $2.8546 (records with cost: 73)

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
| audiobook-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| audiobook-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| audiobook-insuff-001 | insufficient_evidence | metadata_naming | escalate | yes |  |
| audiobook-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| audiobook-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
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
| epub-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-identity-004 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-identity-005 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-insuff-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| epub-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-decoder-001 | decoder_incompatible | insufficient_evidence | escalate | no | false abstention |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-healthy-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-healthy-003 | healthy | healthy | none | yes |  |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | insufficient_evidence | escalate | no |  |
| movie-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-insuff-001 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| movie-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| movie-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| tv-healthy-003 | healthy | healthy | none | yes |  |
| tv-healthy-004 | healthy | healthy | none | yes |  |
| tv-healthy-005 | healthy | healthy | none | yes |  |
| tv-healthy-006 | healthy | healthy | none | yes |  |
| tv-healthy-007 | healthy | healthy | none | yes |  |
| tv-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
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
| audiobook-corrupt-003 | audiobook_inspect | partial | True | True | False | True |
| epub-insuff-001 | epub_inspect | error | True | True | False | True |
| movie-corrupt-003 | decode_sample | timeout | True | True | False | True |
| tv-identity-004 | frame_sample | timeout | False | True | False | True |
| tv-insuff-002 | decode_sample | error | True | False | False | False |
