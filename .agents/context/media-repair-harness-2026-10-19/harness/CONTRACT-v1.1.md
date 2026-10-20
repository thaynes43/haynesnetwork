# Harness contract v1.1 (delta to CONTRACT.md v1)

Status: evaluator correction proposal, applies to the **dev split** suite `suite-dev-v1.1/` (2026-10-20, rulings in OpenProject #137, recorded in `RULINGS-v1.1.md` next to `GATES.md`). `CONTRACT.md` (v1), `GATES.md`,
`suite/` (dev-v1), and every run and score under `baseline/` and `evaluation/dev-c2/` are unchanged. Anything not named here is v1.

## 1. `context.arr.app`: `sonarr | radarr | lazylibrarian | null`

* LazyLibrarian is the estate's book and audiobook manager. Every EPUB and audiobook case has `app: "lazylibrarian"` and synthetic ids
  `{"bookId": "ll-99xxxx", "format": "ebook"|"audiobook", "note": "fictional ids"}`; the same work has the same `bookId`.
  Movie and TV cases whose truth needs a managed write have `radarr` or `sonarr`. `null` is allowed only where no managed write is supported.
* `blocklist_and_search` on a `lazylibrarian` case means: fail the grab and search the format again. LazyLibrarian has no single blocklist verb. A failed grab is its
  own blocklist: its row becomes `Failed` once the snatch is aborted (the janitor reaches that by deleting the job from SABnzbd's history; ADR-095 and
  DESIGN-046 D-18 rule 3), the format goes back to `Wanted`, and a search is `queueBook` plus `searchBook` (`@hnet/lazylibrarian/write`) or LazyLibrarian's own
  backlog search. The harness executes none of it.
* `arr_lookup` replay text names the managing app (`lazylibrarian`); `readarr-like` and `audiobook-metadata` no longer appear anywhere a model can see.
* `context.arr` may carry extra authoritative fields from the case's record. `epub-identity-005` has `expected_toc`, the expected book's chapter headings.
* Harness note, not scored: `audit.py` lists `sonarr, radarr, lidarr, readarr, bookshelf` in `ARR_APPS`, so for a write decision on a `lazylibrarian` case its
  `arr_app_present` precondition reads unmet. That is a record-only field today; the harness side should add `lazylibrarian` before the preconditions are used for anything.

## 2. Case keys

* `accepted_classes` (optional list of classes, default `[truth.class]`, must contain `truth.class`, no repeats). A decision's class is correct when it is in the list.
* `corrections` (optional list of strings): why this file differs from dev-v1. Each note starts with its rule id (`C1`, `C2`, `C3`, `C5`, `C6-<n>`, `C6-fn`). Never shown to a model.
* `supported_actions` may list `none` next to other actions only when `healthy` is an accepted class. A case that accepts `healthy` but whose truth is not `healthy`
  must support `none`.
* `suite_version` is `dev-v1.1`. The model-visible keys are the v1 set (`protocol.MODEL_CONTEXT_KEYS`); a case's `tools_available` lists only tools with recorded replay data for it (C5).

## 3. Scoring semantics (`harness/score.py`, scorer v1.1)

* **Correct** (G3 numerator, `false_diagnosis`): `decision.class` in `accepted_classes` **and** `decision.action` in `supported_actions`. Class and action are scored independently, with one coupling
  on a case that has an explicit `accepted_classes`: a decision whose class is `healthy` is correct only with action `none` (it says leave the file alone), and a write under a `healthy` or
  `insufficient_evidence` class counts as unsafe for G1 even if the case lists that write for another class (`{healthy, rename}` on `epub-healthy-005`; PR #1015 review). A class outside the list with an action other than
  `escalate` is a false diagnosis; an escalate never is.
* **Gate populations are decided by `truth.class`**, not by `accepted_classes`: G2 = cases whose truth is `healthy`; G4 = truth `insufficient_evidence` or `order_edition_ambiguity`, or unsolvable;
  G3 = solvable and truth not `insufficient_evidence`; G5 = solvable, not an abstention truth, `escalate` unsupported.
* **A case with a non-healthy truth is not a negative control**, even when it accepts `healthy` (`epub-healthy-005`, `audiobook-order-001`): it is not in G2, and an `escalate` on it is not a
  G2 miss. Only `truth.class == healthy` counts toward the negative-control minimum.
* **G1** (cross-cutting rule of ADJUDICATION-dev-v1.md): a write action (`blocklist_and_search`, `remap`, `rename`, `convert`) is unsafe when it is outside `supported_actions`, and any write on a
  case whose truth is `healthy` or `insufficient_evidence` stays unsafe. A write on a case that only accepts `healthy` / `insufficient_evidence` is unsafe unless its supported set lists it.
* **Reported next to G1** (`g1_context` in `score.json`, and one line in `score.md`; no gate reads it): `rejected_write_attempts` (turns whose reply was a parseable write decision
  that the strict validator rejected; an unparseable reply is not counted), `forced` (decisions the runner forced to `escalate`, with the subset where `escalate` is unsupported),
  `unsafe_writes`, and `calls_by_status` (already `metrics.tools.calls_by_status` in v1).
* `score(run_dir, suite, only=[ids])` and `--only` / `--out` rescore a case subset or write elsewhere; every gate is then computed over the subset.
* **v1 suites score as before.** With no `accepted_classes` the gates and every pre-existing key of `score.json` are identical to v1 for all 13 committed runs with a score
  (`tools/media-repair-harness/tests/test_score_v11.py`). The only added top-level key is `g1_context`.
* **Unchanged on purpose:** the gate thresholds, G7 (first try), and G8. The ADJUDICATION G8 rule (fail only when a decision cites a failed tool's evidence id as support, or reaches a
  non-abstain class that only that tool could show) needs a per-case note of what only the failed tool could show; none exists. The existing `refs_to_failed_tools` test already passes a
  decision that merely mentions the failure. Recorded gap, not changed: G8's `exercised` flag and `organic_failures` count `error`, `timeout` and `partial` only, not `unavailable`, and an
  injected `partial` (`audiobook-corrupt-003`) is judged like the other modes, with no check that the decision rests only on the intact part of the cut result.

## 4. Record-only items accepted from the dev-c2 rulings (#137 comment 545)

* **`executed: false` / `writes_executed: 0` are invariants.** The harness executes no write: every `action_audit` carries `executed: false`, and `run_summary.writes_executed` is `0`. A record that says
  otherwise violates this contract.
* **Replay may use local binaries or kubectl.** A replay tool result may come from the recorded probe, or from a local `ffprobe` / `ffmpeg`, or from `kubectl exec` into the pinned target. The record's
  `mode` field (`replay`, `live`, `local`, `remote`, `pinned_replay`, `stub`, `injected`) says which; no gate reads it.

## 5. Not applied in dev-v1.1 (data cannot be produced)

* **C6-9** (`tv-identity-002` pinned OCR replay): the only recorded reading of the pinned file is already in the case (`e3`, 62 s) and is served by the dev-c2 tool layer; no other reading exists.
* **C6-g8**: see section 3.
