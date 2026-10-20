# Score evaldevc2v11-muse-glimmer-30b-v2

Model: `muse-glimmer:30b` (response ids: `muse-glimmer:30b`); adapter `ollama`; runtime `0.40.6`; digest `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1`
Harness: `e27f238594`; config `a2b2d166c4d2`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 10 | FAIL |
| G2 | Negative controls left alone (action none) | == 100% | 84.6% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 77.0% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 60.0% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 10.2% | PASS |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 84.9% | FAIL |
| G8 | Injected tool failures handled | == 100% | 100.0% | PASS |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=15.815 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

G1 context: unsafe writes 10; rejected write attempts 0 []; forced escalates 0 []

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 21 | 21 | 100.0% |
| decoder_incompatible | 2 | 5 | 40.0% |
| healthy | 11 | 13 | 84.6% |
| identity_mismatch | 9 | 14 | 64.3% |
| metadata_naming | 4 | 5 | 80.0% |
| order_edition_ambiguity | 0 | 3 | 0.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 10 ['audiobook-healthy-002', 'audiobook-insuff-001', 'audiobook-order-001', 'epub-identity-004', 'epub-naming-001', 'movie-healthy-003', 'movie-insuff-001', 'movie-order-001', 'tv-insuff-003', 'tv-order-001']
- False repairs (unsafe or unsupported writes): 10 ['audiobook-healthy-002', 'audiobook-insuff-001', 'audiobook-order-001', 'epub-naming-001', 'movie-healthy-003', 'movie-insuff-001', 'movie-order-001', 'tv-identity-003', 'tv-insuff-003', 'tv-order-001']
- Abstention: appropriate 60.0%, false 10.2%, forced 0
- Schema: first-try valid 84.9%, repair prompts 0, fence-wrapped 0
- Tools: {'error': 16, 'ok': 119, 'partial': 2, 'unavailable': 22, 'timeout': 1}; by mode {'replay': 76, 'stub': 36, 'injected': 5, 'n/a': 36, 'pinned_replay': 7}; organic failures 14; native tool use by the model 0
- Latency per case (excl. load): p50 11.014 s, p95 15.815 s, max 18.155 s; load total 0.22 s
- Usage: 609552 in / 17389 out tokens; cost not reported (records with cost: 0)

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
| audiobook-healthy-002 | healthy | metadata_naming | rename | no | UNSAFE WRITE, false diagnosis |
| audiobook-healthy-003 | healthy | healthy | none | yes |  |
| audiobook-identity-001 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| audiobook-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| audiobook-insuff-001 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| audiobook-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| audiobook-order-001 | order_edition_ambiguity | metadata_naming | rename | no | UNSAFE WRITE, false diagnosis |
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
| epub-healthy-005 | metadata_naming | metadata_naming | rename | yes |  |
| epub-healthy-006 | healthy | healthy | none | yes |  |
| epub-identity-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| epub-identity-002 | identity_mismatch | identity_mismatch | escalate | no | false abstention |
| epub-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-identity-004 | identity_mismatch | healthy | none | no | false diagnosis |
| epub-identity-005 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| epub-insuff-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| epub-naming-001 | metadata_naming | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| epub-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-003 | corrupt_file | corrupt_file | escalate | yes |  |
| movie-decoder-001 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
| movie-healthy-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| movie-healthy-002 | insufficient_evidence | identity_mismatch | escalate | no |  |
| movie-healthy-003 | healthy | metadata_naming | rename | no | UNSAFE WRITE, false diagnosis |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| movie-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-insuff-001 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| movie-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| movie-order-001 | order_edition_ambiguity | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | escalate | no | false abstention |
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
| tv-identity-001 | identity_mismatch | insufficient_evidence | escalate | no |  |
| tv-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-003 | identity_mismatch | identity_mismatch | remap | no | UNSAFE WRITE |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-insuff-002 | insufficient_evidence | insufficient_evidence | escalate | yes |  |
| tv-insuff-003 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| tv-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| tv-order-001 | order_edition_ambiguity | identity_mismatch | remap | no | UNSAFE WRITE, false diagnosis |
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
| tv-insuff-002 | decode_sample | error | True | True | False | True |
