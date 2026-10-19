# Score dev-v1-codex-gpt-6-luna

Model: `gpt-6-luna` (response ids: `gpt-6-luna`); adapter `codex`; runtime `codex-cli 0.162.1`; digest `None`
Harness: `c61b6c6211`; config `2cfc1eabe522`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 4 | FAIL |
| G2 | Negative controls left alone (action none) | == 100% | 60.0% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 71.2% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 80.0% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 20.0% | FAIL |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 91.8% | FAIL |
| G8 | Injected tool failures handled | == 100% | 80.0% | FAIL |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=28.248 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 20 | 21 | 95.2% |
| decoder_incompatible | 5 | 5 | 100.0% |
| healthy | 12 | 20 | 60.0% |
| identity_mismatch | 6 | 13 | 46.2% |
| metadata_naming | 1 | 4 | 25.0% |
| order_edition_ambiguity | 3 | 3 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 7 ['audiobook-healthy-003', 'epub-identity-004', 'epub-identity-005', 'epub-insuff-002', 'tv-corrupt-003', 'tv-healthy-006', 'tv-insuff-002']
- False repairs (unsafe or unsupported writes): 4 ['audiobook-healthy-003', 'epub-insuff-002', 'epub-naming-001', 'tv-healthy-006']
- Abstention: appropriate 80.0%, false 20.0%, forced 0
- Schema: first-try valid 91.8%, repair prompts 6, fence-wrapped 0
- Tools: {'error': 10, 'ok': 12}; by mode {'replay': 15, 'n/a': 4, 'injected': 1, 'stub': 2}; organic failures 9; native tool use by the model 0
- Latency per case (excl. load): p50 4.106 s, p95 28.248 s, max 34.332 s; load total 0.0 s
- Usage: 3009158 in / 11807 out tokens; cost not reported (records with cost: 0)

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
| audiobook-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| audiobook-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| audiobook-healthy-003 | healthy | metadata_naming | remap | no | UNSAFE WRITE, false diagnosis |
| audiobook-identity-001 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| audiobook-identity-002 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| audiobook-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| audiobook-naming-001 | metadata_naming | insufficient_evidence | escalate | no | false abstention |
| audiobook-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| audiobook-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| audiobook-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-004 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-005 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| epub-healthy-002 | healthy | healthy | none | yes |  |
| epub-healthy-003 | healthy | healthy | none | yes |  |
| epub-healthy-004 | healthy | healthy | none | yes |  |
| epub-healthy-005 | healthy | healthy | none | yes |  |
| epub-healthy-006 | healthy | healthy | none | yes |  |
| epub-identity-001 | identity_mismatch | insufficient_evidence | escalate | no | false abstention |
| epub-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-identity-004 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-identity-005 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-insuff-002 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| epub-naming-001 | metadata_naming | metadata_naming | remap | no | UNSAFE WRITE |
| epub-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| movie-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| movie-healthy-003 | healthy | healthy | none | yes |  |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| movie-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-insuff-001 | insufficient_evidence | order_edition_ambiguity | escalate | no |  |
| movie-naming-001 | metadata_naming | insufficient_evidence | escalate | no | false abstention |
| movie-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-003 | corrupt_file | healthy | none | no | false diagnosis |
| tv-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-healthy-001 | healthy | healthy | none | yes |  |
| tv-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| tv-healthy-003 | healthy | healthy | none | yes |  |
| tv-healthy-004 | healthy | healthy | none | yes |  |
| tv-healthy-005 | healthy | healthy | none | yes |  |
| tv-healthy-006 | healthy | decoder_incompatible | convert | no | UNSAFE WRITE, false diagnosis |
| tv-healthy-007 | healthy | healthy | none | yes |  |
| tv-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-004 | identity_mismatch | insufficient_evidence | escalate | no |  |
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
| audiobook-corrupt-003 | audiobook_inspect | partial | False | True | False | True |
| epub-insuff-001 | epub_inspect | error | True | True | False | True |
| movie-corrupt-003 | decode_sample | timeout | False | True | False | True |
| tv-identity-004 | frame_sample | timeout | False | True | False | True |
| tv-insuff-002 | decode_sample | error | False | False | False | False |
