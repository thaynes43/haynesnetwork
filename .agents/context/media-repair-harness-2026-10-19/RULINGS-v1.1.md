# Evaluator correction rulings for suite v1.1 (2026-10-20, claude-opus-5-5, evaluator)

Basis: the evaluator's attribution of the dev-c2 failures on the dev split (#137 comment 549) and the dev-v1 adjudication rulings 2-13.

These are construction corrections, made from evidence and before any held-out scoring. dev-v1, held-out-v1, their runs and their scores are never changed or deleted. GATES.md is unchanged.

Owner ruling, 2026-10-20: the evaluator privately audits held-out-v1, applies only the general rules C1, C2 and C5, and seals the result as held-out-v1.1. The v1 tarball stays untouched, and development sees neither version.

| Rule | Correction | Applies to |
|---|---|---|
| **C1. Managing app** | CONTRACT v1.1 extends `context.arr.app` to `sonarr\|radarr\|lazylibrarian\|null`. LazyLibrarian is the estate's book and audiobook manager; its downloads can be failed and searched again. Every EPUB and audiobook case gets `app: lazylibrarian` with synthetic ids. Movie and TV cases whose truth needs a managed write get radarr or sonarr. `arr_lookup` replay text is made consistent with this (no "readarr-like"). `supported_actions` is unchanged except where another ruling changes it. | general |
| **C2. Healthy controls with no integrity evidence** | A case labelled healthy whose model-visible evidence and tools contain no integrity check at all (empty `tools_available`, and only a title or identity record) is relabelled `insufficient_evidence`, `supported_actions [escalate]`, source `human_adjudication`. It leaves the negative-control count. Healthy cases with partial but representative checks keep their label. | general |
| **C3. Series prefix in a healthy EPUB's dc:title** | epub-healthy-005: `truth.class` becomes `metadata_naming`, `accepted_classes [metadata_naming, healthy]`, `supported [rename, none, escalate]`. | dev only, case-specific |
| **C5. Tools offered with no recorded data** | A tool listed in `tools_available` that has no replay data for that case (`audio_sample` in every dev case) is removed from `tools_available`. The test runs against the current replay harness (pinned rows included): a tool stays offered if any call to it returns recorded data. | general |
| **C6. dev-v1 adjudication rulings 2-13** | Applied as written in ADJUDICATION-dev-v1.md. A ruling whose data cannot be produced is recorded as not applied. | dev only |
| **Scorer v1.1** | `score.py` honours `accepted_classes` (default `[truth.class]`). On v1 suites its output is byte-identical to v1, which is proved by rescoring the checkpoint 1 and dev-c2 runs. It also gains the CONTRACT-v2-proposal reporting items: rejected write attempts and forced escalates next to G1, and `calls_by_status`. The injected-`partial` G8 gap is recorded, not changed. | general |
