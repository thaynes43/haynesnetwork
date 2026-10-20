"""Media repair harness: a read-only evidence and decision harness for media-repair models (stdlib only, Python >= 3.11).

Modules: protocol (turn protocol, prompts, HARNESS_VERSION), tools / evidence (read-only evidence tools and live collectors), adapters (model
transports), run (the unified runner, `mrh-run`), audit / gaps / leakguard / guard / outcomes (run-time checks), replay_identity (what a model
is shown in replay mode), score_compat (loads the evaluator-owned score.py by path, `mrh-score`).  See the component README.
"""
