# Must-ask reachability (OpenProject #209)

Reproduce (from the repository root; stdlib only, no model, no GPU, no network):

```
python3 tools/media-repair-harness/scripts/must_ask_reachability.py
```

Check against the committed files: `... must_ask_reachability.py --check`. Suite `.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1` (dev-v1.1), harness `dev-c8`, handover `handover-1`.

Computed in the configuration of the registered local-model runs: `--evidence-format v3.1-format --prompt v7 --guards v3 --evidence replay --evidence-handover none`, tool output 8192 bytes. For each case the real runner ran with a scripted adapter making exactly the calls below; a "pages" count is the run's own, and a result of more than one page costs one more call per extra page.

## Summary

- 73 cases. **Fully reachable within the 6-call budget: 59.** Partially reachable: 3. Unreachable: 11.
- 162 of 176 withheld entries come back byte for byte, with their recorded status, from one call each. The rest, by reason: injected_failure 1, no_tool 13.
- A call with no arguments (a time then means 0 s) already returns 144 of those entries; the other 18 need an argument the prompt describes (`at` seconds or `full`): decode_sample {"full":true} x5, ocr {"at":1.0} x11, ocr {"at":62.0} x2.
- Most calls any case needs: 4 (4 counting every extra page). Cases over the budget: none.
- `--evidence-handover askable` keeps the 14 entries no offered call can return in the first message; it changes nothing for 11 cases.
- Flags: injected_failure 1, no_tool 13, no_tools_offered 11.

Reasons: `no_tool` = no harness tool produces the entry (`prior_record`); `tool_not_offered` = its tool is not in the case's `tools_available`; `injected_failure` = the case injects a failure (error, timeout or a cut partial result) into every call of that tool, so the recorded output cannot be returned whole; `differs` = the call returned something else (none expected); `over_budget` = more than 6 calls. Status: fully = every withheld entry reachable and all pages within 6 calls; partially = some; unreachable = none.

## Per case

| case | class | fixture | tools | withheld | reachable | calls (pages) | status | flags | unreachable entries |
|---|---|---|---|---|---|---|---|---|---|
| audiobook-corrupt-001 | corrupt_file | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-corrupt-002 | corrupt_file | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-corrupt-003 | corrupt_file | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-healthy-001 | insufficient_evidence | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| audiobook-healthy-002 | healthy | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-healthy-003 | healthy | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-identity-001 | identity_mismatch | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| audiobook-identity-002 | identity_mismatch | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-insuff-001 | insufficient_evidence | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-naming-001 | metadata_naming | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-order-001 | order_edition_ambiguity | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-outcome-001 | corrupt_file | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| audiobook-outcome-002 | corrupt_file | local | 3 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-corrupt-001 | corrupt_file | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-corrupt-002 | corrupt_file | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-corrupt-003 | corrupt_file | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-corrupt-004 | corrupt_file | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-corrupt-005 | corrupt_file | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-healthy-001 | insufficient_evidence | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| epub-healthy-002 | insufficient_evidence | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| epub-healthy-003 | healthy | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-healthy-004 | healthy | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-healthy-005 | metadata_naming | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-healthy-006 | healthy | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-identity-001 | identity_mismatch | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| epub-identity-002 | identity_mismatch | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| epub-identity-003 | identity_mismatch | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-identity-004 | identity_mismatch | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-identity-005 | identity_mismatch | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-insuff-001 | insufficient_evidence | local | 2 | e1 arr_lookup | e1 via arr_lookup {} | 1 (1) | fully_reachable | - | - |
| epub-insuff-002 | identity_mismatch | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-naming-001 | metadata_naming | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-outcome-001 | corrupt_file | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| epub-outcome-002 | corrupt_file | local | 2 | e1 epub_inspect, e2 arr_lookup | e1 via epub_inspect {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| movie-corrupt-001 | corrupt_file | local | 5 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| movie-corrupt-002 | corrupt_file | local | 5 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| movie-corrupt-003 | corrupt_file | local | 5 | e1 ffprobe, e2 arr_lookup | e1 via ffprobe {}, e2 via arr_lookup {} | 2 (2) | fully_reachable | - | - |
| movie-decoder-001 | decoder_incompatible | remote | 5 | e1 ffprobe, e2 decode_sample, e3 prior_record | e1 via ffprobe {}, e2 via decode_sample {"at":0.0} | 2 (2) | partially_reachable | no_tool | e3 prior_record (no_tool) |
| movie-decoder-002 | decoder_incompatible | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"full":true}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| movie-healthy-001 | insufficient_evidence | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| movie-healthy-002 | insufficient_evidence | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| movie-healthy-003 | healthy | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| movie-healthy-004 | healthy | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| movie-identity-001 | identity_mismatch | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| movie-identity-002 | identity_mismatch | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| movie-insuff-001 | insufficient_evidence | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| movie-naming-001 | metadata_naming | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| movie-order-001 | order_edition_ambiguity | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| movie-outcome-001 | decoder_incompatible | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"full":true}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| movie-outcome-002 | decoder_incompatible | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"full":true}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-corrupt-001 | corrupt_file | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-corrupt-002 | corrupt_file | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-corrupt-003 | corrupt_file | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-decoder-001 | decoder_incompatible | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"full":true}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-healthy-001 | insufficient_evidence | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| tv-healthy-002 | healthy | remote | 5 | e1 ffprobe, e2 decode_sample, e3 ocr | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":62.0} | 3 (3) | fully_reachable | - | - |
| tv-healthy-003 | healthy | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| tv-healthy-004 | healthy | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-healthy-005 | healthy | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-healthy-006 | healthy | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"full":true}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-healthy-007 | healthy | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| tv-identity-001 | identity_mismatch | none | 0 | e1 prior_record | - | 0 (0) | unreachable | no_tools_offered no_tool | e1 prior_record (no_tool) |
| tv-identity-002 | identity_mismatch | remote | 5 | e1 ffprobe, e2 decode_sample, e3 ocr | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":62.0} | 3 (3) | fully_reachable | - | - |
| tv-identity-003 | identity_mismatch | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| tv-identity-004 | identity_mismatch | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-insuff-001 | insufficient_evidence | remote | 5 | e1 ffprobe, e2 decode_sample, e3 prior_record | e1 via ffprobe {}, e2 via decode_sample {"at":0.0} | 2 (2) | partially_reachable | no_tool | e3 prior_record (no_tool) |
| tv-insuff-002 | insufficient_evidence | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e3 via arr_lookup {} | 2 (2) | partially_reachable | injected_failure | e2 decode_sample (injected_failure) |
| tv-insuff-003 | insufficient_evidence | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-naming-001 | metadata_naming | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| tv-order-001 | order_edition_ambiguity | local | 5 | e1 ffprobe, e2 decode_sample, e3 ocr, e4 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via ocr {"at":1.0}, e4 via arr_lookup {} | 4 (4) | fully_reachable | - | - |
| tv-outcome-001 | corrupt_file | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-outcome-002 | corrupt_file | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |
| tv-outcome-003 | corrupt_file | local | 5 | e1 ffprobe, e2 decode_sample, e3 arr_lookup | e1 via ffprobe {}, e2 via decode_sample {"at":0.0}, e3 via arr_lookup {} | 3 (3) | fully_reachable | - | - |

The full per-entry table (call arguments, returned status, pages, askable) is in `must-ask-reachability.json`.

