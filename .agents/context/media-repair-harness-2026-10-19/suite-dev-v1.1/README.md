# Media repair harness: dev suite `dev-v1.1` (evaluator correction proposal)

A corrected copy of the **dev** suite. dev-v1 (`../suite/`) is frozen: its cases, manifest, runs and scores are untouched, and so are the fixture bytes. Held-out data is not here.
Rulings: OpenProject #137, [`../RULINGS-v1.1.md`](../RULINGS-v1.1.md) (2026-10-20): C1 (managing app), C2 (healthy controls with no integrity evidence), C3 (`epub-healthy-005`), C5 (tools with no recorded data),
C6 (dev-v1 adjudication rulings 2 to 13 and the cross-cutting rulings in `../ADJUDICATION-dev-v1.md`). Contract delta: `../harness/CONTRACT-v1.1.md`. Scorer: `../harness/score.py` (v1.1).

```
suite-dev-v1.1/
  cases/<id>.json   73 cases, derived from ../suite/cases by build_v11.py; each carries a `corrections` list naming the rule that changed it
  fixtures          symlink to ../suite/fixtures (same bytes, same replay probes, same generators)
  manifest.json     suite_version dev-v1.1, derived_from dev-v1, sha256 of every case and fixture, counts, corrections_by_rule
  suite.py          validate | list | stats | manifest  (the dev-v1 tool plus the v1.1 checks; stdlib only)
  build_v11.py      the deterministic derivation (--check rebuilds in memory and compares)
```

Commands: `python3 -I -B suite.py validate`, `python3 -I -B build_v11.py --check`; tests: `tools/media-repair-harness/scripts/ci-test.sh` (`test_suite_v11.py`, `test_score_v11.py`).

## Shape

| class | dev-v1 | dev-v1.1 |
|---|---|---|
| identity_mismatch | 13 | 14 |
| corrupt_file | 21 | 21 |
| decoder_incompatible | 5 | 5 |
| metadata_naming | 4 | 5 |
| order_edition_ambiguity | 3 | 3 |
| insufficient_evidence | 7 | 12 |
| healthy (negative controls) | 20 | 13 |

Two more cases accept `healthy` (`epub-healthy-005`, `audiobook-order-001`) but are not negative controls. 73 cases, 5 injected failures, 9 outcome steps, as before.

## What changed, by rule

| Rule | Cases | Change |
|---|---|---|
| C1 | 36 | every EPUB and audiobook case (34): `context.arr` = `lazylibrarian` + synthetic ids, `arr_lookup` evidence names `lazylibrarian`; `movie-identity-001` radarr, `tv-identity-001` sonarr |
| C2 | 6 | `audiobook-healthy-001`, `epub-healthy-001`, `epub-healthy-002`, `movie-healthy-001`, `movie-healthy-002`, `tv-healthy-001`: healthy to insufficient_evidence, supported `[escalate]`, source human_adjudication |
| C3 | 1 | `epub-healthy-005`: metadata_naming, accepted `[metadata_naming, healthy]`, supported `[rename, none, escalate]` |
| C5 | 45 | `audio_sample` removed from `tools_available` (no replay data in any case) |
| C6-2 | 1 | `epub-insuff-002` to identity_mismatch (wrong-language release), supported `[blocklist_and_search, escalate]` |
| C6-3 | 1 | `epub-identity-005`: `context.arr.expected_toc` added |
| C6-4, 5, 7, 8 | 4 | `epub-identity-004`, `epub-identity-001`, `movie-identity-001`, `tv-identity-001`: `escalate` added to the supported set (no `remap` for `tv-identity-001`) |
| C6-6 | 1 | `epub-identity-002`: arr app and ids (done by C1) |
| C6-11, 12, 13 | 3 | `accepted_classes` on `audiobook-order-001`, `audiobook-insuff-001`, `movie-insuff-001` (and `none` supported on the first) |
| C6-fn | 12 | filename bias: defective cases (corrupt, decoder, identity, with a plain name) get scene-style, dotted or edition-tagged names like the healthy controls; the same name in the `arr_lookup` `relativePath`; fixture bytes untouched |

Not applied (recorded in `../harness/CONTRACT-v1.1.md` and the rescore report): C6-9 (no further recorded OCR exists for the pinned row), the G8 cross-cutting clause (no per-case data). No change by ruling: C6-1, C6-10; the four
naming cases keep `rename` only (the file is already in its right slot, so `remap` would not fix them).

Every case file differs from dev-v1 in `suite_version`; a case is **stale** for a record when its model-visible content (context, evidence, `tools_available`) differs. The rescore of the existing dev runs
is in `../evaluation/dev-v1.1-rescore/REPORT.md`.
