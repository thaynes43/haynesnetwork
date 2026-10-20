# Harness: moved to `tools/media-repair-harness/`

The runner, adapters, tools, prompts, evidence collectors, tests and test data now live in
[`tools/media-repair-harness/`](../../../../tools/media-repair-harness/README.md) as an installable package
(`media_repair_harness`). Test command: `tools/media-repair-harness/scripts/ci-test.sh`.

This folder keeps the assessment artifacts, which the evaluator owns and the harness package never edits:
`runs/` (run records), `CONTRACT.md` and `score.py`. `score.py` was written against the old flat module layout and imports `protocol` and
`run`; it no longer runs directly from here. Use `mrh-score` (or `python3 -m media_repair_harness.score_compat`), which loads this `score.py` by path.

The frozen candidates dev-c1 (`617e6ad4`) and dev-c2 (`e27f2385`) ran from this folder's former flat layout (`run.py`, `tools.py`, ... next to
`score.py`); `git show e27f2385:.agents/context/media-repair-harness-2026-10-19/harness/<file>` retrieves any of those files. Run records here name files
at that old path.
