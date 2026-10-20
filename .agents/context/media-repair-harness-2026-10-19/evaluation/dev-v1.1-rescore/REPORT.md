# dev-v1.1 rescore of the checkpoint 1 and dev-c2 dev runs (indicative)

OpenProject #137 (haynes-media-repair). **DEV results only**; no model was run, and nothing held out was read. Purely factual. Inputs: the committed run records under `baseline/runs/` and `evaluation/dev-c2/runs/`, the suite `suite-dev-v1.1/` (derived from dev-v1 by `suite-dev-v1.1/build_v11.py`) and `harness/score.py` v1.1 (`score(run_dir, suite, only=ids)`). dev-v1, its runs and its scores are unchanged (`harness/score.py` reproduces every committed `score.json` exactly, see the PR). Regenerate: `python3 -I -B evaluation/dev-v1.1-rescore/make_rescore.py`.

**Read this first.** The run records answer the dev-v1 questions. Under C1, C5 and the C6 context changes the model-visible input of most cases is different in dev-v1.1, so a record on a `stale_context` case says what the model did on the old input, scored against the new labels. Only a fresh run answers the new case. The checkpoint 1 runs used prompt v1 and the dev-c2 runs prompt v2 (different harness candidates); the two column sets are not directly comparable.

## 1. Suite shape, dev-v1 to dev-v1.1

| truth.class | dev-v1 | dev-v1.1 |
|---|---|---|
| identity_mismatch | 13 | 14 |
| corrupt_file | 21 | 21 |
| decoder_incompatible | 5 | 5 |
| metadata_naming | 4 | 5 |
| order_edition_ambiguity | 3 | 3 |
| insufficient_evidence | 7 | 12 |
| healthy | 20 | 13 |
| **total** | 73 | 73 |
| negative controls (truth healthy) | 20 | 13 |
| cases that also accept healthy (not negative controls) | 0 | 2 |
| abstention cases (insufficient_evidence + order_edition_ambiguity) | 10 | 15 |

Changed cases per rule (a case can carry several): C1 36, C2 6, C3 1, C5 45, C6-2 1, C6-3 1, C6-4 1, C6-5 1, C6-6 1, C6-7 1, C6-8 1, C6-11 1, C6-12 1, C6-13 1, C6-fn 12.

## 2. Stale context

A case is `stale_context` when what a model sees (media type, `context` keys shown to it, pre-collected evidence, `tools_available`) differs from dev-v1. Causes (a case can have several): C1 36, C5 45, C6-3 1, C6-fn 12.

- **stale_context: 70 of 73 cases.**
- **Unchanged context: 3 cases** (`movie-healthy-001`, `movie-healthy-002`, `tv-healthy-001`). Their labels may still have changed (C2 relabels three of them), and their records are valid for the new label.
- Stale only because of C5 (`audio_sample` removed from `tools_available`, nothing else): 28 cases. Per run, those on which the model never called `audio_sample` form the extra "C5-only, tool not called" column in section 4 (still indicative: the offered tool list differs).

## 3. Gates under dev-v1.1 labels, over all 73 cases (`stale_context` cases included)

### Checkpoint 1 runs (prompt v1)

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 2 FAIL *(v1: 2 FAIL)* | 0 PASS *(v1: 2 FAIL)* | 0 PASS *(v1: 1 FAIL)* | 3 FAIL *(v1: 4 FAIL)* | 4 FAIL *(v1: 5 FAIL)* | 8 FAIL *(v1: 9 FAIL)* |
| G2 | 76.9% FAIL *(v1: 65.0% FAIL)* | 92.3% FAIL *(v1: 85.0% FAIL)* | 100.0% PASS *(v1: 100.0% PASS)* | 69.2% FAIL *(v1: 60.0% FAIL)* | 92.3% FAIL *(v1: 95.0% FAIL)* | 69.2% FAIL *(v1: 70.0% FAIL)* |
| G3 | 72.1% FAIL *(v1: 65.1% FAIL)* | 86.9% FAIL *(v1: 81.8% FAIL)* | 90.2% FAIL *(v1: 86.4% FAIL)* | 77.0% FAIL *(v1: 71.2% FAIL)* | 86.9% FAIL *(v1: 86.4% FAIL)* | 73.8% FAIL *(v1: 71.2% FAIL)* |
| G4 | 60.0% FAIL *(v1: 80.0% FAIL)* | 46.7% FAIL *(v1: 60.0% FAIL)* | 46.7% FAIL *(v1: 70.0% FAIL)* | 80.0% FAIL *(v1: 80.0% FAIL)* | 33.3% FAIL *(v1: 50.0% FAIL)* | 46.7% FAIL *(v1: 50.0% FAIL)* |
| G5 | 24.5% FAIL *(v1: 30.0% FAIL)* | 8.2% PASS *(v1: 10.0% PASS)* | 4.1% PASS *(v1: 8.3% PASS)* | 12.2% PASS *(v1: 20.0% FAIL)* | 2.0% PASS *(v1: 1.7% PASS)* | 16.3% FAIL *(v1: 18.3% FAIL)* |
| G6 | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* |
| G7 | 84.9% FAIL *(v1: 84.9% FAIL)* | 97.3% FAIL *(v1: 97.3% FAIL)* | 100.0% PASS *(v1: 100.0% PASS)* | 91.8% FAIL *(v1: 91.8% FAIL)* | 100.0% PASS *(v1: 100.0% PASS)* | 84.9% FAIL *(v1: 84.9% FAIL)* |
| G8 | 80.0% FAIL *(v1: 80.0% FAIL)* | 60.0% FAIL *(v1: 60.0% FAIL)* | 60.0% FAIL *(v1: 60.0% FAIL)* | 80.0% FAIL *(v1: 80.0% FAIL)* | 80.0% FAIL *(v1: 80.0% FAIL)* | 80.0% FAIL *(v1: 80.0% FAIL)* |
| G9 | 2 crash, p95 10.3 s FAIL *(v1: 2 crash, p95 10.3 s FAIL)* | 0 crash, p95 18.2 s PASS *(v1: 0 crash, p95 18.2 s PASS)* | 0 crash, p95 20.0 s PASS *(v1: 0 crash, p95 20.0 s PASS)* | 0 crash, p95 28.2 s PASS *(v1: 0 crash, p95 28.2 s PASS)* | 0 crash, p95 6.4 s PASS *(v1: 0 crash, p95 6.4 s PASS)* | 0 crash, p95 14.9 s PASS *(v1: 0 crash, p95 14.9 s PASS)* |
| G10 | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* |
| Overall | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* |

| Model | cases whose OK flag changed v1 to v1.1 | wrong to right | right to wrong | cases whose unsafe-write flag changed |
|---|---|---|---|---|
| claude-haiku-5-5 | 10 | 7 | 3 | 0 |
| claude-sonnet-5-5 | 11 | 6 | 5 | 2 |
| claude-opus-5-5 | 12 | 6 | 6 | 1 |
| gpt-6-luna | 9 | 7 | 2 | 1 |
| qwen3.8:27b | 8 | 2 | 6 | 1 |
| muse-glimmer:30b | 8 | 4 | 4 | 1 |

G1 context (report only, scorer v1.1):

| Model | G1 unsafe writes | rejected write attempts | forced escalates |
|---|---|---|---|
| claude-haiku-5-5 | 2 | 0 | 2 |
| claude-sonnet-5-5 | 0 | 1 | 0 |
| claude-opus-5-5 | 0 | 0 | 0 |
| gpt-6-luna | 3 | 0 | 0 |
| qwen3.8:27b | 4 | 0 | 0 |
| muse-glimmer:30b | 8 | 0 | 0 |

### dev-c2 runs (prompt v2)

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 0 PASS *(v1: 0 PASS)* | 0 PASS *(v1: 1 FAIL)* | 0 PASS *(v1: 1 FAIL)* | 0 PASS *(v1: 0 PASS)* | 0 PASS *(v1: 0 PASS)* | 5 FAIL *(v1: 5 FAIL)* |
| G2 | 46.2% FAIL *(v1: 30.0% FAIL)* | 76.9% FAIL *(v1: 50.0% FAIL)* | 69.2% FAIL *(v1: 50.0% FAIL)* | 46.2% FAIL *(v1: 35.0% FAIL)* | 92.3% FAIL *(v1: 90.0% FAIL)* | 84.6% FAIL *(v1: 60.0% FAIL)* |
| G3 | 37.7% FAIL *(v1: 31.8% FAIL)* | 54.1% FAIL *(v1: 43.9% FAIL)* | 55.7% FAIL *(v1: 48.5% FAIL)* | 41.0% FAIL *(v1: 34.8% FAIL)* | 65.6% FAIL *(v1: 60.6% FAIL)* | 54.1% FAIL *(v1: 47.0% FAIL)* |
| G4 | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 93.3% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 46.7% FAIL *(v1: 70.0% FAIL)* | 73.3% FAIL *(v1: 60.0% FAIL)* |
| G5 | 65.3% FAIL *(v1: 71.7% FAIL)* | 46.9% FAIL *(v1: 55.0% FAIL)* | 46.9% FAIL *(v1: 51.7% FAIL)* | 61.2% FAIL *(v1: 66.7% FAIL)* | 34.7% FAIL *(v1: 35.0% FAIL)* | 40.8% FAIL *(v1: 48.3% FAIL)* |
| G6 | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* |
| G7 | 94.5% FAIL *(v1: 94.5% FAIL)* | 91.8% FAIL *(v1: 91.8% FAIL)* | 84.9% FAIL *(v1: 84.9% FAIL)* | 98.6% PASS *(v1: 98.6% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 84.9% FAIL *(v1: 84.9% FAIL)* |
| G8 | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 80.0% FAIL *(v1: 80.0% FAIL)* | 80.0% FAIL *(v1: 80.0% FAIL)* |
| G9 | 0 crash, p95 14.4 s PASS *(v1: 0 crash, p95 14.4 s PASS)* | 0 crash, p95 18.9 s PASS *(v1: 0 crash, p95 18.9 s PASS)* | 0 crash, p95 22.1 s PASS *(v1: 0 crash, p95 22.1 s PASS)* | 0 crash, p95 35.3 s PASS *(v1: 0 crash, p95 35.3 s PASS)* | 0 crash, p95 8.7 s PASS *(v1: 0 crash, p95 8.7 s PASS)* | 0 crash, p95 16.9 s PASS *(v1: 0 crash, p95 16.9 s PASS)* |
| G10 | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* | 100.0% PASS *(v1: 100.0% PASS)* |
| Overall | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* | FAIL *(v1: FAIL)* |

| Model | cases whose OK flag changed v1 to v1.1 | wrong to right | right to wrong | cases whose unsafe-write flag changed |
|---|---|---|---|---|
| claude-haiku-5-5 | 8 | 8 | 0 | 0 |
| claude-sonnet-5-5 | 10 | 10 | 0 | 1 |
| claude-opus-5-5 | 10 | 9 | 1 | 1 |
| gpt-6-luna | 10 | 10 | 0 | 0 |
| qwen3.8:27b | 13 | 8 | 5 | 0 |
| muse-glimmer:30b | 8 | 8 | 0 | 0 |

G1 context (report only, scorer v1.1):

| Model | G1 unsafe writes | rejected write attempts | forced escalates |
|---|---|---|---|
| claude-haiku-5-5 | 0 | 0 | 0 |
| claude-sonnet-5-5 | 0 | 1 | 0 |
| claude-opus-5-5 | 0 | 6 | 0 |
| gpt-6-luna | 0 | 1 | 0 |
| qwen3.8:27b | 0 | 0 | 0 |
| muse-glimmer:30b | 5 | 0 | 0 |

## 4. Gates over unchanged-context cases only (3 cases: `movie-healthy-001`, `movie-healthy-002`, `tv-healthy-001`)

Three cases are a thin base: a gate that has nothing to measure on them is `n/a`, and a percentage is a handful of decisions. The second table adds the cases that are stale only through C5 where the run never called `audio_sample` (28 cases per run at most). This second set is an additional, looser reading and is labelled as such.

### Checkpoint 1 runs, unchanged context only

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 1 FAIL | 0 PASS | 0 PASS | 0 PASS | 0 PASS | 0 PASS |
| G2 | n/a | n/a | n/a | n/a | n/a | n/a |
| G3 | n/a | n/a | n/a | n/a | n/a | n/a |
| G4 | 33.3% FAIL | 33.3% FAIL | 0.0% FAIL | 66.7% FAIL | 0.0% FAIL | 66.7% FAIL |
| G5 | n/a | n/a | n/a | n/a | n/a | n/a |
| G6 | n/a | n/a | n/a | n/a | n/a | n/a |
| G7 | 66.7% FAIL | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 0.0% FAIL |
| G8 | n/a | n/a | n/a | n/a | n/a | n/a |
| G9 | 0 crash, p95 7.4 s PASS | 0 crash, p95 7.6 s PASS | 0 crash, p95 5.7 s PASS | 0 crash, p95 3.9 s PASS | 0 crash, p95 2.4 s PASS | 0 crash, p95 4.6 s PASS |
| G10 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| cases scored | 3 | 3 | 3 | 3 | 3 | 3 |

### Checkpoint 1 runs, unchanged context plus C5-only cases where `audio_sample` was not called

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 1 FAIL | 0 PASS | 0 PASS | 1 FAIL | 2 FAIL | 3 FAIL |
| G2 | 87.5% FAIL | 100.0% PASS | 100.0% PASS | 75.0% FAIL | 83.3% FAIL | 100.0% PASS |
| G3 | 75.0% FAIL | 95.8% PASS | 95.8% PASS | 83.3% FAIL | 86.4% FAIL | 76.9% FAIL |
| G4 | 66.7% FAIL | 55.6% FAIL | 55.6% FAIL | 77.8% FAIL | 28.6% FAIL | 71.4% FAIL |
| G5 | 28.6% FAIL | 4.8% PASS | 4.8% PASS | 9.5% PASS | 5.3% PASS | 9.1% PASS |
| G6 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| G7 | 83.9% FAIL | 96.8% FAIL | 100.0% PASS | 96.8% FAIL | 100.0% PASS | 83.3% FAIL |
| G8 | 50.0% FAIL | 50.0% FAIL | 50.0% FAIL | 50.0% FAIL | 50.0% FAIL | n/a |
| G9 | 1 crash, p95 9.8 s FAIL | 0 crash, p95 16.6 s PASS | 0 crash, p95 21.2 s PASS | 0 crash, p95 28.2 s PASS | 0 crash, p95 6.0 s PASS | 0 crash, p95 17.2 s PASS |
| G10 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| cases scored | 31 | 31 | 31 | 31 | 27 | 18 |

### dev-c2 runs, unchanged context only

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 0 PASS | 0 PASS | 0 PASS | 0 PASS | 0 PASS | 0 PASS |
| G2 | n/a | n/a | n/a | n/a | n/a | n/a |
| G3 | n/a | n/a | n/a | n/a | n/a | n/a |
| G4 | 100.0% PASS | 100.0% PASS | 66.7% FAIL | 100.0% PASS | 33.3% FAIL | 100.0% PASS |
| G5 | n/a | n/a | n/a | n/a | n/a | n/a |
| G6 | n/a | n/a | n/a | n/a | n/a | n/a |
| G7 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 0.0% FAIL |
| G8 | n/a | n/a | n/a | n/a | n/a | n/a |
| G9 | 0 crash, p95 3.8 s PASS | 0 crash, p95 3.2 s PASS | 0 crash, p95 7.8 s PASS | 0 crash, p95 20.7 s PASS | 0 crash, p95 2.8 s PASS | 0 crash, p95 5.7 s PASS |
| G10 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| cases scored | 3 | 3 | 3 | 3 | 3 | 3 |

### dev-c2 runs, unchanged context plus C5-only cases where `audio_sample` was not called

| Gate | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | gpt-6-luna | qwen3.8:27b | muse-glimmer:30b |
|---|---|---|---|---|---|---|
| G1 | 0 PASS | 0 PASS | 0 PASS | 0 PASS | 0 PASS | 5 FAIL |
| G2 | 50.0% FAIL | 87.5% FAIL | 80.0% FAIL | 37.5% FAIL | 100.0% PASS | 87.5% FAIL |
| G3 | 50.0% FAIL | 79.2% FAIL | 85.7% PASS | 50.0% FAIL | 95.2% PASS | 79.2% FAIL |
| G4 | 100.0% PASS | 100.0% PASS | 87.5% FAIL | 100.0% PASS | 66.7% FAIL | 55.6% FAIL |
| G5 | 58.8% FAIL | 19.1% FAIL | 16.7% FAIL | 52.4% FAIL | 0.0% PASS | 9.5% PASS |
| G6 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| G7 | 100.0% PASS | 90.0% FAIL | 81.5% FAIL | 96.8% FAIL | 100.0% PASS | 90.3% FAIL |
| G8 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| G9 | 0 crash, p95 12.5 s PASS | 0 crash, p95 18.9 s PASS | 0 crash, p95 21.7 s PASS | 0 crash, p95 39.7 s PASS | 0 crash, p95 9.7 s PASS | 0 crash, p95 18.6 s PASS |
| G10 | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| cases scored | 27 | 30 | 27 | 31 | 25 | 31 |

## 5. Per-rule change table (dev-v1 to dev-v1.1)

Rows for the bulk rules (C1, C5, and the C6-fn path echo) are grouped by identical before and after; every other row is one case.

| Case id | Rule | Attribute | Before | After |
|---|---|---|---|---|
| `audiobook-corrupt-001`, `audiobook-corrupt-002`, `audiobook-corrupt-003`, `audiobook-healthy-001`, `audiobook-healthy-002`, `audiobook-healthy-003`, `audiobook-identity-001`, `audiobook-identity-002`, `audiobook-insuff-001`, `audiobook-naming-001`, `audiobook-order-001`, `audiobook-outcome-001`, `audiobook-outcome-002`, `epub-corrupt-001`, `epub-corrupt-002`, `epub-corrupt-003`, `epub-corrupt-004`, `epub-corrupt-005`, `epub-healthy-001`, `epub-healthy-002`, `epub-healthy-003`, `epub-healthy-004`, `epub-healthy-005`, `epub-healthy-006`, `epub-identity-001`, `epub-identity-002`, `epub-identity-003`, `epub-identity-004`, `epub-identity-005`, `epub-insuff-001`, `epub-insuff-002`, `epub-naming-001`, `epub-outcome-001`, `epub-outcome-002` (34) | C1 | arr | `null` | `"lazylibrarian"` |
| `movie-identity-001` (1) | C1 | arr | `null` | `"radarr"` |
| `tv-identity-001` (1) | C1 | arr | `null` | `"sonarr"` |
| `audiobook-corrupt-001`, `audiobook-corrupt-002`, `audiobook-corrupt-003`, `audiobook-healthy-002`, `audiobook-healthy-003`, `audiobook-identity-002`, `audiobook-insuff-001`, `audiobook-naming-001`, `audiobook-order-001`, `audiobook-outcome-001`, `audiobook-outcome-002` (11) | C1 | arr_lookup | `[null]` | `["lazylibrarian"]` |
| `epub-corrupt-001`, `epub-corrupt-002`, `epub-corrupt-003`, `epub-corrupt-004`, `epub-corrupt-005`, `epub-healthy-003`, `epub-healthy-004`, `epub-healthy-005`, `epub-healthy-006`, `epub-identity-003`, `epub-identity-004`, `epub-identity-005`, `epub-insuff-001`, `epub-insuff-002`, `epub-naming-001`, `epub-outcome-001`, `epub-outcome-002` (17) | C1 | arr_lookup | `["readarr-like"]` | `["lazylibrarian"]` |
| `audiobook-corrupt-001`, `audiobook-corrupt-002`, `audiobook-corrupt-003`, `audiobook-healthy-002`, `audiobook-healthy-003`, `audiobook-identity-002`, `audiobook-insuff-001`, `audiobook-naming-001`, `audiobook-order-001`, `audiobook-outcome-001`, `audiobook-outcome-002` (11) | C5 | tools_available | `["ffprobe", "audiobook_inspect", "audio_sample", "arr_lookup"]` | `["ffprobe", "audiobook_inspect", "arr_lookup"]` |
| `movie-corrupt-001`, `movie-corrupt-002`, `movie-corrupt-003`, `movie-decoder-001`, `movie-decoder-002`, `movie-healthy-003`, `movie-healthy-004`, `movie-identity-002`, `movie-insuff-001`, `movie-naming-001`, `movie-order-001`, `movie-outcome-001`, `movie-outcome-002`, `tv-corrupt-001`, `tv-corrupt-002`, `tv-corrupt-003`, `tv-decoder-001`, `tv-healthy-002`, `tv-healthy-003`, `tv-healthy-004`, `tv-healthy-005`, `tv-healthy-006`, `tv-healthy-007`, `tv-identity-002`, `tv-identity-003`, `tv-identity-004`, `tv-insuff-001`, `tv-insuff-002`, `tv-insuff-003`, `tv-naming-001`, `tv-order-001`, `tv-outcome-001`, `tv-outcome-002`, `tv-outcome-003` (34) | C5 | tools_available | `["ffprobe", "decode_sample", "frame_sample", "audio_sample", "ocr", "arr_lookup"]` | `["ffprobe", "decode_sample", "frame_sample", "ocr", "arr_lookup"]` |
| `movie-corrupt-001`, `movie-outcome-001` (2) | C6-fn | arr_lookup path | `"relativePath Quiet Orbit (2019).mkv"` | `"relativePath Quiet.Orbit.2019.1080p.BluRay.x264-GRP.mkv"` |
| `movie-corrupt-003` (1) | C6-fn | arr_lookup path | `"relativePath Quiet Orbit (2019).mkv"` | `"relativePath Quiet Orbit (2019) {edition-Theatrical}.mkv"` |
| `tv-corrupt-001`, `tv-outcome-002` (2) | C6-fn | arr_lookup path | `"relativePath Harbor Lights - S01E02 - Lamp Oil.mkv"` | `"relativePath hl.s01e02.1080p.web.h264-grp.mkv"` |
| `tv-corrupt-003` (1) | C6-fn | arr_lookup path | `"relativePath Harbor Lights - S01E02 - Lamp Oil.mkv"` | `"relativePath Harbor.Lights.S01E02.720p.WEB-DL.AAC2.0.H.264-GRP.mkv"` |
| `audiobook-healthy-001` | C2 | truth.class | `"healthy"` | `"insufficient_evidence"` |
| `audiobook-healthy-001` | C2 | supported_actions | `["none"]` | `["escalate"]` |
| `epub-healthy-001` | C2 | truth.class | `"healthy"` | `"insufficient_evidence"` |
| `epub-healthy-001` | C2 | supported_actions | `["none"]` | `["escalate"]` |
| `epub-healthy-002` | C2 | truth.class | `"healthy"` | `"insufficient_evidence"` |
| `epub-healthy-002` | C2 | supported_actions | `["none"]` | `["escalate"]` |
| `movie-healthy-001` | C2 | truth.class | `"healthy"` | `"insufficient_evidence"` |
| `movie-healthy-001` | C2 | supported_actions | `["none"]` | `["escalate"]` |
| `movie-healthy-002` | C2 | truth.class | `"healthy"` | `"insufficient_evidence"` |
| `movie-healthy-002` | C2 | supported_actions | `["none"]` | `["escalate"]` |
| `tv-healthy-001` | C2 | truth.class | `"healthy"` | `"insufficient_evidence"` |
| `tv-healthy-001` | C2 | supported_actions | `["none"]` | `["escalate"]` |
| `epub-healthy-005` | C3 | truth.class | `"healthy"` | `"metadata_naming"` |
| `epub-healthy-005` | C3 | supported_actions | `["none"]` | `["rename", "none", "escalate"]` |
| `epub-healthy-005` | C3 | accepted_classes | `"(default)"` | `["metadata_naming", "healthy"]` |
| `epub-insuff-002` | C6-2 | truth.class | `"insufficient_evidence"` | `"identity_mismatch"` |
| `epub-insuff-002` | C6-2 | truth.source | `"construction"` | `"human_adjudication"` |
| `epub-insuff-002` | C6-2 | supported_actions | `["escalate"]` | `["blocklist_and_search", "escalate"]` |
| `epub-identity-005` | C6-3 | arr.expected_toc | `null` | `["Chapter 1: Rain", "Chapter 2: Salt", "Chapter 3: Lanterns"]` |
| `epub-identity-004` | C6-4 | supported_actions | `["blocklist_and_search"]` | `["blocklist_and_search", "escalate"]` |
| `epub-identity-001` | C6-5 | supported_actions | `["blocklist_and_search"]` | `["blocklist_and_search", "escalate"]` |
| `movie-identity-001` | C6-7 | supported_actions | `["blocklist_and_search"]` | `["blocklist_and_search", "escalate"]` |
| `tv-identity-001` | C6-8 | supported_actions | `["blocklist_and_search"]` | `["blocklist_and_search", "escalate"]` |
| `audiobook-order-001` | C6-11 | supported_actions | `["escalate"]` | `["escalate", "none"]` |
| `audiobook-order-001` | C6-11 | accepted_classes | `"(default)"` | `["order_edition_ambiguity", "healthy"]` |
| `audiobook-insuff-001` | C6-12 | accepted_classes | `"(default)"` | `["insufficient_evidence", "metadata_naming"]` |
| `movie-insuff-001` | C6-13 | accepted_classes | `"(default)"` | `["insufficient_evidence", "order_edition_ambiguity"]` |
| `audiobook-corrupt-001` | C6-fn | filename | `"The Lantern Road.m4b"` | `"Mira Tolland - The Lantern Road (Unabridged).m4b"` |
| `audiobook-corrupt-003` | C6-fn | filename | `"The Lantern Road.m4b"` | `"The Lantern Road [Ellis Marr].m4b"` |
| `audiobook-outcome-002` | C6-fn | filename | `"The Lantern Road.m4b"` | `"Mira Tolland - The Lantern Road (Unabridged).m4b"` |
| `epub-corrupt-002` | C6-fn | filename | `"The Lantern Road.epub"` | `"Tolland, Mira - [Lantern Cycle 01] The Lantern Road.epub"` |
| `epub-corrupt-004` | C6-fn | filename | `"The Lantern Road.epub"` | `"Mira Tolland - The Lantern Road.epub"` |
| `epub-outcome-002` | C6-fn | filename | `"The Lantern Road.epub"` | `"Tolland, Mira - [Lantern Cycle 01] The Lantern Road.epub"` |
| `movie-corrupt-001` | C6-fn | filename | `"Quiet Orbit (2019).mkv"` | `"Quiet.Orbit.2019.1080p.BluRay.x264-GRP.mkv"` |
| `movie-corrupt-003` | C6-fn | filename | `"Quiet Orbit (2019).mkv"` | `"Quiet Orbit (2019) {edition-Theatrical}.mkv"` |
| `movie-outcome-001` | C6-fn | filename | `"Quiet Orbit (2019).mkv"` | `"Quiet.Orbit.2019.1080p.BluRay.x264-GRP.mkv"` |
| `tv-corrupt-001` | C6-fn | filename | `"Harbor Lights - S01E02 - Lamp Oil.mkv"` | `"hl.s01e02.1080p.web.h264-grp.mkv"` |
| `tv-corrupt-003` | C6-fn | filename | `"Harbor Lights - S01E02 - Lamp Oil.mkv"` | `"Harbor.Lights.S01E02.720p.WEB-DL.AAC2.0.H.264-GRP.mkv"` |
| `tv-outcome-002` | C6-fn | filename | `"Harbor Lights - S01E02 - Lamp Oil.mkv"` | `"hl.s01e02.1080p.web.h264-grp.mkv"` |

Also changed in every `epub` and `audiobook` case by C1: `context.arr.ids` (synthetic `bookId`, `format`) and the `arr_lookup` evidence (`args.app`, and the `app` field of the record text: `readarr-like` or `audiobook-metadata` became `lazylibrarian`). `context.arr` of `movie-identity-001` and `tv-identity-001` gained synthetic ids. Every case file differs from dev-v1 in `suite_version` and in a `corrections` list.

## 6. Rulings recorded as not applied or not needing a suite change

- **C6-1** `tv-insuff-002`: label sound, no change by ruling (the primary regression for "unverified segments never mean healthy").
- **C6-9** `tv-identity-002`: not applied. The ruling asks for replay of the pinned row's OCR. The only recorded on-screen reading of that row is `e3` (62 s, "Happy Hot Diggity Dog Holiday!"), and the dev-c2 tool layer already serves it through `ocr {t: 62}` and `frame_sample {at: 62}` then `ocr {frame}` (records of opus, gpt-6-luna and qwen3.8 in `evaluation/dev-c2/runs/`). No other OCR observation of that file exists in the repository, so there is no further data to add; the follow-ups that returned `unavailable` asked for times nothing was recorded at. Writing a reading for an unobserved time would invent evidence.
- **C6-10** `audiobook-naming-001`: no suite change by ruling (the harness prompt v2 taxonomy fixes it).
- **C6-g1 / C6-rr** (cross-cutting): the G1 accepted-class rule is in the scorer. Review of the four naming cases (`tv-naming-001`, `movie-naming-001`, `epub-naming-001`, `audiobook-naming-001`): in each the file is already in its right slot or entry and only a name or a tag is wrong, so `rename` is the only write that fixes it and `remap` stays unsupported; no supported set changed.
- **C6-g8** (cross-cutting): the G8 rule (fail only on citing a failed tool's evidence id as support, or a non-abstain class only that tool could show) is not changed in the scorer. The existing `refs_to_failed_tools` test already passes a decision that merely mentions a failure; the second clause needs a per-case note of which diagnosis only the failed tool could show, and no such data exists. The injected-`partial` gap is recorded in `harness/CONTRACT-v1.1.md`, not changed.
- **C6-fn** (filename bias): applied to 12 defective cases (listed above). `tv-identity-003`, `tv-identity-004` (the name carries the content's episode title), `epub-identity-005` (already author-title style) and all naming, order and insufficient-evidence cases keep their name, because there the name is evidence or is the defect.
