# Score dev-v1-ollama-muse-glimmer-30b

Model: `muse-glimmer:30b` (response ids: `muse-glimmer:30b`); adapter `ollama`; runtime `0.40.6`; digest `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1`
Harness: `c61b6c6211`; config `13a4d71c1fe4`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 9 | FAIL |
| G2 | Negative controls left alone (action none) | == 100% | 70.0% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 71.2% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 50.0% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 18.3% | FAIL |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 84.9% | FAIL |
| G8 | Injected tool failures handled | == 100% | 80.0% | FAIL |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=14.904 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 21 | 21 | 100.0% |
| decoder_incompatible | 0 | 5 | 0.0% |
| healthy | 14 | 20 | 70.0% |
| identity_mismatch | 10 | 13 | 76.9% |
| metadata_naming | 0 | 4 | 0.0% |
| order_edition_ambiguity | 2 | 3 | 66.7% |

## Other measures

- False diagnoses (wrong class, not an escalation): 8 ['audiobook-healthy-002', 'audiobook-insuff-001', 'audiobook-order-001', 'epub-identity-004', 'epub-identity-005', 'epub-insuff-002', 'tv-insuff-002', 'tv-insuff-003']
- False repairs (unsafe or unsupported writes): 9 ['audiobook-healthy-002', 'audiobook-insuff-001', 'audiobook-naming-001', 'audiobook-order-001', 'epub-insuff-002', 'epub-naming-001', 'movie-naming-001', 'tv-insuff-003', 'tv-naming-001']
- Abstention: appropriate 50.0%, false 18.3%, forced 0
- Schema: first-try valid 84.9%, repair prompts 11, fence-wrapped 0
- Tools: {'error': 85, 'ok': 161, 'partial': 1, 'timeout': 2}; by mode {'replay': 157, 'stub': 32, 'injected': 6, 'n/a': 54}; organic failures 82; native tool use by the model 0
- Latency per case (excl. load): p50 9.658 s, p95 14.904 s, max 17.21 s; load total 0.29 s
- Usage: 546901 in / 15652 out tokens; cost not reported (records with cost: 0)

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
| audiobook-healthy-001 | healthy | healthy | none | yes |  |
| audiobook-healthy-002 | healthy | metadata_naming | remap | no | UNSAFE WRITE, false diagnosis |
| audiobook-healthy-003 | healthy | order_edition_ambiguity | escalate | no | false abstention |
| audiobook-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| audiobook-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| audiobook-insuff-001 | insufficient_evidence | metadata_naming | remap | no | UNSAFE WRITE, false diagnosis |
| audiobook-naming-001 | metadata_naming | metadata_naming | remap | no | UNSAFE WRITE |
| audiobook-order-001 | order_edition_ambiguity | metadata_naming | remap | no | UNSAFE WRITE, false diagnosis |
| audiobook-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| audiobook-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-004 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-005 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-healthy-001 | healthy | healthy | none | yes |  |
| epub-healthy-002 | healthy | healthy | none | yes |  |
| epub-healthy-003 | healthy | healthy | none | yes |  |
| epub-healthy-004 | healthy | healthy | none | yes |  |
| epub-healthy-005 | healthy | healthy | none | yes |  |
| epub-healthy-006 | healthy | healthy | none | yes |  |
| epub-identity-001 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
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
| movie-decoder-001 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| movie-healthy-001 | healthy | insufficient_evidence | escalate | no | false abstention |
| movie-healthy-002 | healthy | identity_mismatch | escalate | no | false abstention |
| movie-healthy-003 | healthy | healthy | none | yes |  |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-insuff-001 | insufficient_evidence | order_edition_ambiguity | escalate | no |  |
| movie-naming-001 | metadata_naming | metadata_naming | remap | no | UNSAFE WRITE |
| movie-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| tv-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-decoder-001 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| tv-healthy-001 | healthy | healthy | none | yes |  |
| tv-healthy-002 | healthy | insufficient_evidence | escalate | no | false abstention |
| tv-healthy-003 | healthy | healthy | none | yes |  |
| tv-healthy-004 | healthy | decoder_incompatible | escalate | no | false abstention |
| tv-healthy-005 | healthy | healthy | none | yes |  |
| tv-healthy-006 | healthy | healthy | none | yes |  |
| tv-healthy-007 | healthy | healthy | none | yes |  |
| tv-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-insuff-002 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-003 | insufficient_evidence | corrupt_file | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| tv-naming-001 | metadata_naming | metadata_naming | remap | no | UNSAFE WRITE |
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
| tv-identity-004 | frame_sample | timeout | True | True | False | True |
| tv-insuff-002 | decode_sample | error | True | False | False | False |
