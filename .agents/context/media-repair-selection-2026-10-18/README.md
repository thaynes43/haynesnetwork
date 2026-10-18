# Bounded model-driven EPUB candidate selection

Sole owner session01a14fc4-44b7-79b3-b7f9-95f4276da250, branch agent/media-repair-selection-1018, Saga43 existing stories #64/#69/#61/#62/#65/#67/#68/#63. Prerequisite PR998 merged 9ed8462d: two independently identified EPUBs and immutable private pristine copies. Prior documentary and actual-pair artifacts remain unchanged.

Scope: three contrived arrangements from that existing pair: valid candidate among same-series wrong work and a damaged copy; valid candidate against misleading metadata and damage; no-valid control containing wrong work, misleading wrong work and damage. These are fixture experiments, not new historical incidents. No new book retrieval, library scan, live catalog/metadata/media writes, download, restart, other agents or production promotion.

Acceptance: model requests actual bounded inspection; opaque model choice/abstention preserved; evaluate hidden identity/integrity truth, evidence support and unsafe proposals before guards; independently verify any selected fixture output and unchanged originals/pristines. Both exact installed models get identical candidate order, tool behavior and budgets, with appropriate per-request terminators. Record raw traces/resources and required current-head CI/review/authorized squash merge. Stop here; no semantic retries or after-response tuning.

Budget proposed before inference: 45m execution plus 30m CI/review/closeout, one owner/model. Three cases/model, at most four turns/case (three inspection actions plus final), one tool call/turn, at most three tool calls/case, 256 output tokens/turn (1024/case), context8192, temperature0/seed42, per-call remote60s/local65s and per-case wall180s. No follow-up run to improve scores. No CPU burners or wide/looped local tests; serial checks under nice19.

Tool protocol: strict JSON actions inspect/select/abstain over opaque candidate IDs. Only inspect is dispatched, with a fixed allowlist into private copies; no model code/shell/path access. It returns real ZIP/package/spine/XHTML integrity, actual OPF metadata and bounded body samples, never identity verdicts or known-answer fingerprints. A selection cites returned observation fields. Harness never substitutes an answer or overrides abstention. Guard validates only proposed candidates for fixture execution; unsafe proposals remain counted even when blocked.

Evaluator-only provenance/truth is separate from model-visible case manifests and observations; candidate mapping contains no answer hint in exposed IDs. Freeze exact cases, truth, protocol, tools and evaluator before replies. Full books/body dumps stay private; git contains only minimal excerpts, bounded outputs and receipts. Existing independent primary-text proof from PR998 remains the adjudication basis, and post-selection uses an independent parser/fingerprints withheld from the model.

Ordered follow-on: AV-NEXT.md authorizes a distinct AV checkpoint only after this PR lands through required CI/review/merge. Tracker owns the canonical AV story/acceptance. No AV access/extraction/inference occurs during this increment; transition will be reported after merge. Existing issue992 pause remains outside that narrow next authorization.

## Reproduction and closeout

Use Python stdlib only. From repository root:

```bash
P=.agents/context/media-repair-selection-2026-10-18
nice -n 19 python3 "$P/evaluate.py" # offline scoring, no models/private media needed
nice -n 19 python3 "$P/summarize.py" # offline latency/resources from preserved traces
# The following require the existing authorized private fixtures:
nice -n 19 python3 -m unittest discover -s "$P" -p test_selection.py
nice -n 19 python3 "$P/verify_post.py"
```

Fresh authorized execution sequence in a fresh artifact/private destination: `python3 prepare.py`, `python3 freeze.py`, `python3 run.py --model qwen3.8:27b`, verify idle transition, then `python3 run.py --model muse-glimmer:30b`, followed by scoring/post verification. Paths are deliberately scoped to this work order; prepare/freeze/run refuse existing destination directories/manifests. Do not regenerate/overwrite frozen completed artifacts. `freeze.py` captures all protocol, cases, truth, tools, evaluation/guard and imported module hashes before replies; no manual manifest extension or after-response evaluation change was used. `verify_post.py` and summarize.py are post-run receipt utilities, not model-visible tools or changed selection/scoring logic.

Raw traces under runs/ retain each complete request/response, model-requested observation and resource sample. `evaluate.py` is the normative pre-inference scoring/guard implementation. Its evidence_supported name means citation-field coverage, not semantic entailment; see REPORT.md for the unsafe proposal with genuine but contradictory citations. Six structural/selection-safety tests passed serially. Full media stays in private `/home/dev/.cache/media-repair-selection-1018`; no library access beyond the two exact original hash rechecks. Selected outputs remain private and are copies, never live replacement.

Result: Qwen one verified selection, one extra abstention, one correct no-valid abstention; Muse two verified selections and one unsafe wrong-work/no-valid proposal blocked. No further EPUB inference/tuning follows. Canonical queued AV story #128 will be read/picked up only after this increment lands; tracker acceptance remains separate.
