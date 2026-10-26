# dev-tl1 results: do the existing tools carry the local models? (OpenProject #208)

Pre-registration: [PREREGISTRATION.md](PREREGISTRATION.md) and amendments 1 to 3. Suite dev-v1.1 has 73 cases (heldout/ was never opened). Every run used the frozen `src/` tree `d1e669d3...`, and every `config_hash` matches its registration. Records are in the run folders. Scores are in `score-*.out` (`score_compat`, gates G1 to G10) and the paired comparisons in `compare-*.out` (from `compare.py`).

**Arms.** *Handed* gives the model all the recorded evidence in its first message, which is how earlier runs worked. *Must-ask* (`--evidence-handover askable`) withholds every entry an offered tool can return, so the model has to call a tool to see it. The arms differ on 62 cases. The other 11 give identical input and serve as the noise control.

| | qwen3.8 27B (Prime, full GPU) | | muse-glimmer 30B (talosw04) | | nemotron-3.5-bolt 74B-A9B IQ2 (Prime, partial CPU) | |
|---|---|---|---|---|---|---|
| arm | handed | must-ask | handed | must-ask | handed | must-ask |
| run | `-handed` | `-mustask-r2` | `-handed-a2` | `-mustask-a2` | `-handed` | `-mustask-r2` |
| correct, all 73 | 59 | 59 | 50 | 43 | 47 | 46 |
| correct, 62 differing | 51 | 51 | 47 | 40 | 41 | 40 |
| flips (lost, gained) | | 4, 4 | | 10, 3 | | 4, 3 |
| noise control, 11 identical | 8 | 8 | 3 | 3 | 6 | 6 |
| identity_mismatch, of 14 | 5 | 6 | 5 | 3 | 2 | 3 |
| tool calls on the 62 | 44 | 152 | 83 | 231 | 128 | 204 |
| withheld entries obtained, of 162 | | 109 | | 123 | | 123 |
| must-ask cases with no call | | 0 of 62 | | 0 of 62 | | 0 of 62 |
| unsafe or unsupported writes (G1) | 1 | 0 | 0 | 1 | 2 | 4 |
| forced decisions | 0 | 1 | 0 | 0 | 0 | 1 |
| median s per case | 4.3 | 5.6 | 68.8 | 64.0 | 8.4 | 8.5 |

Unsafe-write cases: qwen handed `audiobook-insuff-001`. Muse must-ask `audiobook-healthy-003`. Nemotron handed `tv-identity-004` and `tv-naming-001`. Nemotron must-ask `movie-order-001`, `tv-healthy-007`, `tv-identity-003` and `tv-order-001`. Nothing was written: these runs replay recorded evidence, and the writes were the model's decision only.

## What it says

1. **Every model uses the tools when it has to.** In must-ask, all three called a tool in all 62 differing cases and retrieved 109 to 123 of the 162 withheld entries. The tools are not going unused. Earlier runs simply handed their output over in advance.
2. **Having to ask costs qwen and Nemotron nothing:** 51/51 and 41/40 on the differing cases, with flips balanced. **It costs Muse 7 cases** (10 lost, 3 gained). That is consistent with its long reasoning at a 3072-token budget, though this design cannot separate the causes.
3. **qwen3.8 27B remains the best local model:** most correct, fastest, and no unsafe write in the must-ask arm. Nemotron is fast but the least safe. It renames or re-downloads files whose real problem is identity, ordering or nothing. Muse is about 12 times slower than qwen and less accurate.
4. **identity_mismatch is the common gap** (2 to 6 of 14 for every model and arm). Most misses name the right class but escalate, or misjudge which title the file really is. More evidence-fetching did not fix it, so it is a judgment and evidence-content problem, not a tool-access one.

## Named limits

One pass per arm at temperature 0. The reasoning settings and reply budgets differ by model (qwen `think:false`/640, muse minimal reasoning/3072, nemotron `think:false`/640), so compare within a model, not across. Nemotron is a 2-bit quantization on a partial CPU load. The must-ask aborts (`qwen ... -mustask`, `nemotron ... -mustask`) were the Prime compute-owner preflight catching the previous arm's runner still holding 256 MiB. Both were rerun as `-r2` under section 6, and the aborted records are kept. Muse's first handed arm (token-capped) and its smokes are kept as non-results.
