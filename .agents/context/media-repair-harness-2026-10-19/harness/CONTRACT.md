# Harness contract v1 (shared by W3 suite and W4 runner)

Normative gates: `.agents/context/media-repair-harness-2026-10-19/GATES.md` on main (PR #1003, 9285641a).
W4 commits this file as `harness/CONTRACT.md`. A change to this contract needs the coordinator's approval and
must be recorded there.

Repo root for this effort: `.agents/context/media-repair-harness-2026-10-19/`
- `suite/` is owned by W3: `cases/<id>.json`, `fixtures/` (generators and small synthetic files only), `manifest.json`, `suite.py`
- `harness/` is owned by W4: runner, adapters, tools, scorer, tests

## Case file (`suite/cases/<id>.json`)

```json
{
  "id": "tv-corrupt-001", "suite_version": "dev-v1", "split": "dev",
  "media_type": "movie|tv|epub|audiobook",
  "family": "short grouping key; same family never spans dev and heldout",
  "truth": {"class": "identity_mismatch|corrupt_file|decoder_incompatible|metadata_naming|order_edition_ambiguity|insufficient_evidence|healthy",
            "source": "deterministic|construction|authoritative_metadata|human_adjudication",
            "ref": "how the truth was established (command + result digest, generator seed, record URL)"},
  "supported_actions": ["none|escalate|blocklist_and_search|remap|rename|convert"],
  "solvable": true,
  "context": {"title": "...", "expected": {"series": "...", "season": 1, "episode": 34, "runtime_s": 1320, "language": "en"},
              "arr": {"app": "sonarr|radarr|null", "ids": {}}, "notes_for_model": "neutral task framing only"},
  "fixture": {"kind": "local|remote|none", "sha256": "...", "bytes": 0, "locator": "path outside git or remote ref; never a secret"},
  "evidence": [{"id": "e1", "tool": "ffprobe", "args": {}, "status": "ok|error|timeout|partial", "output": "inline text or {\"ref\": path, \"sha256\": ...}"}],
  "tools_available": ["ffprobe", "decode_sample", "frame_sample", "audio_sample", "ocr", "epub_inspect", "audiobook_inspect", "arr_lookup"],
  "inject_tool_failure": {"tool": "decode_sample", "mode": "error|timeout|partial"} ,
  "outcome_step": {"check": "name of a verification check", "inputs": {}, "expected": "repaired|not_repaired"},
  "provenance": "reused from <path@sha> | new"
}
```
Optional keys: `inject_tool_failure`, `outcome_step`. The model never sees `truth`, `supported_actions`,
`solvable`, `family` or `provenance`. Pre-collected `evidence` is shown. `tools_available` may be called live.

## Model turn protocol (strict JSON, one object per turn)

Tool call: `{"type":"tool_call","tool":"<name>","args":{...},"why":"<=200 chars"}`. At most 6 tool calls per case,
and each result is bounded (8 KiB of text, a 60 s tool timeout).
Final answer:
```json
{"type":"decision","class":"<class>","action":"<action>","target":"<file/release/episode ref or null>",
 "confidence":0.0,"evidence_refs":["e1","t2"],"reason":"<=400 chars"}
```
Invalid JSON or schema counts as a G7 miss. The runner may send one repair prompt, which is recorded, but the
first-try validity is what gets scored. If there is no decision after the step budget, the runner records
`action=escalate, class=insufficient_evidence, forced=true`.

## Run record (`runs/<run-id>/<case-id>.json`)

The run record holds: the model id requested and the response model id (from the API or CLI output),
runtime/version and model digest, harness git sha, config hash, case sha256, every request and response raw,
tool calls with their status, usage (input/output tokens, cost if reported), wall times (load, per turn, total),
the final decision, `forced`, and the outcome-step result. A failed run is written with an `error` field. It is
never discarded.

## Scoring

`harness/score.py runs/<run-id>` computes G1–G10 per GATES.md and writes `score.json` plus a short table.
An unsupported action means `action ∉ supported_actions`, or any write action (`blocklist_and_search`, `remap`,
`rename`, `convert`) on `healthy` or `insufficient_evidence`.
