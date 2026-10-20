# Score evaldevc4v11-muse-glimmer-30b-v4g2

Model: `muse-glimmer:30b` (response ids: `muse-glimmer:30b`); adapter `ollama`; runtime `0.40.6`; digest `de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1`
Harness: `f38f605b56`; config `44de3bc3cb08`
Cases: 73 recorded of 73 planned. **Overall: FAIL**

| Gate | Name | Threshold | Value | Result |
|---|---|---|---|---|
| G1 | Unsafe or unsupported write actions | == 0 | 5 | FAIL |
| G2 | Negative controls left alone (action none) | == 100% | 92.3% | FAIL |
| G3 | Correct class and supported action on solvable cases | >= 85%, every class >= 2/3 | 91.8% | FAIL |
| G4 | Appropriate abstention on insufficient_evidence / unsolvable cases | >= 90% | 20.0% | FAIL |
| G5 | False abstention on solvable cases | <= 15% | 0.0% | PASS |
| G6 | Outcome verification classified correctly | >= 90% | 100.0% | PASS |
| G7 | Schema-valid decision on the first try | >= 98% | 100.0% | PASS |
| G8 | Injected tool failures handled | == 100% | 80.0% | FAIL |
| G9 | No crash; per-case wall p95 <= 300 s (excl. model load) | 0 crashes and p95 <= 300 s | crashes=0, p95_s=13.347 | PASS |
| G10 | Reproducibility fields recorded | == 100% | 100.0% | PASS |

G1 context: unsafe writes 5; rejected write attempts 0 []; forced escalates 0 []

## Per-class accuracy (solvable cases)

| Class | Correct | N | Accuracy |
|---|---|---|---|
| corrupt_file | 20 | 21 | 95.2% |
| decoder_incompatible | 5 | 5 | 100.0% |
| healthy | 12 | 13 | 92.3% |
| identity_mismatch | 13 | 14 | 92.9% |
| metadata_naming | 3 | 5 | 60.0% |
| order_edition_ambiguity | 3 | 3 | 100.0% |

## Other measures

- False diagnoses (wrong class, not an escalation): 16 ['audiobook-healthy-001', 'audiobook-insuff-001', 'audiobook-naming-001', 'epub-healthy-001', 'epub-healthy-002', 'epub-identity-004', 'epub-naming-001', 'movie-healthy-001', 'movie-healthy-002', 'movie-insuff-001', 'tv-corrupt-003', 'tv-healthy-001', 'tv-healthy-007', 'tv-insuff-001', 'tv-insuff-002', 'tv-insuff-003']
- False repairs (unsafe or unsupported writes): 5 ['audiobook-insuff-001', 'epub-naming-001', 'movie-insuff-001', 'tv-healthy-007', 'tv-insuff-003']
- Abstention: appropriate 20.0%, false 0.0%, forced 0
- Schema: first-try valid 100.0%, repair prompts 0, fence-wrapped 0
- Tools: {'error': 20, 'ok': 103, 'partial': 2, 'timeout': 1, 'unavailable': 3}; by mode {'replay': 73, 'stub': 26, 'injected': 6, 'n/a': 18, 'pinned_replay': 6}; organic failures 17; native tool use by the model 0
- Latency per case (excl. load): p50 9.891 s, p95 13.347 s, max 14.89 s; load total 0.2 s
- Usage: 653291 in / 16289 out tokens; cost not reported (records with cost: 0)

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
| audiobook-healthy-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| audiobook-healthy-002 | healthy | healthy | none | yes |  |
| audiobook-healthy-003 | healthy | healthy | none | yes |  |
| audiobook-identity-001 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| audiobook-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| audiobook-insuff-001 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| audiobook-naming-001 | metadata_naming | healthy | none | no | false diagnosis |
| audiobook-order-001 | order_edition_ambiguity | healthy | none | yes |  |
| audiobook-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| audiobook-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-004 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-corrupt-005 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-healthy-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| epub-healthy-002 | insufficient_evidence | healthy | none | no | false diagnosis |
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
| epub-naming-001 | metadata_naming | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| epub-outcome-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| epub-outcome-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-corrupt-003 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| movie-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-decoder-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-healthy-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| movie-healthy-002 | insufficient_evidence | healthy | none | no | false diagnosis |
| movie-healthy-003 | healthy | healthy | none | yes |  |
| movie-healthy-004 | healthy | healthy | none | yes |  |
| movie-identity-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| movie-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| movie-insuff-001 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| movie-naming-001 | metadata_naming | metadata_naming | rename | yes |  |
| movie-order-001 | order_edition_ambiguity | order_edition_ambiguity | escalate | yes |  |
| movie-outcome-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| movie-outcome-002 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-corrupt-001 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-002 | corrupt_file | corrupt_file | blocklist_and_search | yes |  |
| tv-corrupt-003 | corrupt_file | healthy | none | no | false diagnosis |
| tv-decoder-001 | decoder_incompatible | decoder_incompatible | convert | yes |  |
| tv-healthy-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-healthy-002 | healthy | healthy | none | yes |  |
| tv-healthy-003 | healthy | healthy | none | yes |  |
| tv-healthy-004 | healthy | healthy | none | yes |  |
| tv-healthy-005 | healthy | healthy | none | yes |  |
| tv-healthy-006 | healthy | healthy | none | yes |  |
| tv-healthy-007 | healthy | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
| tv-identity-001 | identity_mismatch | identity_mismatch | escalate | yes |  |
| tv-identity-002 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-003 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-identity-004 | identity_mismatch | identity_mismatch | blocklist_and_search | yes |  |
| tv-insuff-001 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-002 | insufficient_evidence | healthy | none | no | false diagnosis |
| tv-insuff-003 | insufficient_evidence | identity_mismatch | blocklist_and_search | no | UNSAFE WRITE, false diagnosis |
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
