# Media repair harness: runner, adapters, tools, scorer

Owner: OpenProject story [#132](https://work.haynesnetwork.com/work_packages/132) (epic #48). Normative interface:
[`CONTRACT.md`](CONTRACT.md) (copy of the coordinator's contract v1). Gates: [`../GATES.md`](../GATES.md).
Stdlib Python 3.11 only. Suite cases (`../suite/`) belong to W3; this directory owns the runner.

The harness never executes a write. Tools are read-only evidence collectors. A write action in a decision (`blocklist_and_search`,
`remap`, `rename`, `convert`) is only recorded as an intent in the action audit (`executed: false`).

## Usage

```bash
H=.agents/context/media-repair-harness-2026-10-19/harness
# run (one record per case under --out; refuses a non-empty --out, failed runs are kept)
python3 $H/run.py --suite <suite dir | cases dir> --adapter ollama|claude|codex|scripted --model <full id> [--cases a,b] [--split dev|heldout] --out $H/runs/<run-id>
# score (writes score.json and score.md next to the records)
python3 $H/score.py $H/runs/<run-id> --suite <suite dir>
# tests (no model, no network, no GPU)
nice -n 19 python3 -m unittest discover -s $H -p 'test_*.py'
```

Examples (the harness' own test data in `testdata/`, four tiny synthetic cases):

```bash
python3 $H/run.py --suite $H/testdata --adapter claude --model claude-haiku-5-5 --out $H/runs/testdata-haiku-5-5
python3 $H/run.py --suite $H/testdata --adapter codex  --model gpt-6-luna --codex-record-session --out $H/runs/testdata-gpt-6-luna
python3 $H/run.py --suite $H/testdata --adapter ollama --model qwen3.8:27b --out $H/runs/<id>     # read "GPU etiquette" first
python3 $H/testdata/make_fixtures.py     # regenerates the three synthetic EPUBs deterministically
```

Run options: `--effort` (claude/codex), `--max-budget-usd` (claude per-call cap, default 2), `--num-ctx 8192 --num-predict 384 --keep-alive 2m --stop`
(ollama; stop defaults per family: Qwen `<|im_end|>`, Muse `<|eot|>`), `--ollama-schema anyof|flat`, `--no-warmup`, `--ocr-model <vision tag on Prime>`,
`--scratch <dir>` (frames and other media-derived artifacts; default `~/.cache/media-repair-harness/<run-id>`, never inside the run dir).

## Layout

| File | Role |
|---|---|
| `run.py` | Turn protocol loop, tool dispatch, failure injection, outcome step, run records, audit lines, manifest |
| `protocol.py` | System prompt, JSON schemas (Ollama `format`), strict validator, forced decision, model-visible case view |
| `adapters.py` | `OllamaAdapter`, `ClaudeAdapter`, `CodexAdapter`, `ScriptedAdapter` (tests) |
| `tools.py` | Tool registry (ffprobe, decode_sample, frame_sample, audio_sample, ocr, epub_inspect, audiobook_inspect, arr_lookup) |
| `outcomes.py` | Outcome-step checks (`epub_valid`, `epub_title_is`, `sha256_equals/differs`, `json_field_equals`) |
| `score.py` | G1-G10, per-class accuracy, false diagnoses, false repairs, abstention, schema validity, tool failures, latency, cost; `score.json` + `score.md` |
| `ollama_transport.py`, `remote_sampler.py` | Vendored transports (provenance below) |
| `testdata/` | Synthetic cases, deterministic EPUB fixtures, recorded sample outputs of the CLIs (used by the parsing tests) |
| `test_*.py`, `th.py` | 89 unit tests and helpers |
| `runs/` | Smoke and self-test run records (see table below) |

## Protocol as implemented

* Replies are exactly one JSON object, parsed strictly (whitespace aside; a fenced or prose-wrapped reply is a miss, as is a trailing `<|eot|>`).
* Tool call: at most 6 per case; each result is bounded to 8 KiB (`truncated: true` when cut) and 60 s. The 6th result carries the budget notice. A 7th request
  records `forced=true`, class `insufficient_evidence`, action `escalate`.
* One repair prompt per case (any invalid turn), recorded in `repair_prompts`. `first_try_valid` is true only if the case needed no repair prompt and was not forced.
  An adapter failure (timeout, CLI error) or a second invalid reply also ends in the forced escalate; the failure stays in `error` / `turns[].error`.
* The model sees: id, media type, `context` (title, expected, arr, notes_for_model), pre-collected evidence (refs resolved and sha256-checked, bounded) and the tool list.
  It never sees truth, supported actions, solvable, family, provenance, split, fixture, injection or outcome step. Tools take numeric/option arguments only; the media path comes
  from the case fixture, so a model cannot read other files.
* `inject_tool_failure {tool, mode}`: `error` and `timeout` replace the tool result without running it; `partial` runs the tool and cuts its output in half. Recorded with `injected: true`.
* Outcome step: see "Interpretation notes".
* Records: `runs/<id>/<case>.json` (all fields in CONTRACT.md: requested and response model ids, runtime version, model digest or the reason there is none, harness git sha plus dirty flag,
  config hash, case sha256, fixture sha256 check, every raw request and response, tool calls, usage and cost where reported, wall times split into load / turns / tools, decision, forced, outcome, action audit),
  `audit.jsonl` (one intent line per case), `manifest.json` (config, versions, preflight and finish snapshots, abort reason).

## Adapters and verified flags

| Adapter | Invocation | Notes |
|---|---|---|
| `ollama` | `kubectl -n ai exec -i deploy/ollama-prime -c app -- timeout N bash -c '… /dev/tcp/127.0.0.1:11434 …'` | `/api/chat`, `format` = turn schema, temperature 0, seed 42, `think:false`, `num_ctx 8192`, `num_predict 384`, per-family stop. Records digest (`/api/tags`), version (`/api/version`), native load/prompt/eval durations, GPU snapshot before and after. |
| `claude` | `claude -p --model <id> --output-format json --system-prompt … --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --setting-sources "" --no-session-persistence --max-budget-usd N`, prompt on stdin, empty cwd | Response model id from `modelUsage`, usage and `total_cost_usd` from the JSON. **Cost trap:** without the tools/MCP/settings flags a trivial call loaded about 430k cache tokens (0.43 USD) in this pod; with them it is about 0.0001 USD. |
| `codex` | `codex exec --json -s read-only --skip-git-repo-check --ignore-user-config --ignore-rules --ephemeral -m <id> -C <empty dir> -`, prompt on stdin | Tokens from the `turn.completed` event; cost is not reported by Codex and is stored as null. The event stream carries no model id: pass `--codex-record-session` to keep the rollout so the id can be read back (client-side value, labelled as such). Native tool use by the model (`command_execution` etc.) is counted as a protocol violation signal. |
| `scripted` | canned replies | tests, dry runs |

Versions used for the records here: Claude Code 2.1.299, Codex CLI 0.162.1, Ollama 0.40.6 (server), Python 3.11.2.

### GPU etiquette (Ollama Prime)

Preflight reads `/api/version`, `/api/tags`, `/api/ps` and the GPU snapshot. It aborts, without loading or evicting anything, if a model this run did not load is resident, if the GPU has a compute
owner, or if the model is not installed (the harness never pulls). The resident set is re-checked before every case. Warm-up loads the model once (no retry). Only a model this run loaded is unloaded
(`keep_alive: 0`) at the end.

## Tools

| Tool | What it returns | Source / reuse |
|---|---|---|
| `ffprobe` | container, duration, streams, tags (JSON); a probe that exits non-zero is reported as a finding (status ok) | local `ffprobe` if present (`nice -n 19`, `-threads 1`); remote fixtures go through `remote_sampler.py` in the Bazarr pod |
| `decode_sample` | exit code, stderr, quota flag and a `clean` verdict for a 4 s window at `at` | same two paths. Remote sampler: `media-repair-av-2026-10-18/sample_remote.py` (PR #1000) copied to `remote_sampler.py` |
| `frame_sample` | frame name, size, sha256 (PNG kept in scratch only) | same |
| `audio_sample` | RMS, peak, silent fraction of a 4 s mono 16 kHz sample (no speech recognition) | same + stdlib `wave` |
| `ocr` | two OCR readings of a frame and an exact-match consensus | rule and prompt from `media-repair-av-identity-2026-10-18` (PR #1001); backend is a vision model on Prime (`--ocr-model`), otherwise the tool reports it is unavailable (Tesseract is not installed) |
| `epub_inspect` | validity, CRC, titles, creators, languages, identifiers, spine with excerpts; structural damage is reported as `valid:false` with the problem | imports `media-repair-actual-epub-2026-10-18/epub.py` (PR #998) by path |
| `audiobook_inspect` | duration, tags, audio streams, chapters | ffprobe `-show_chapters` (local or remote); `chapters` mode added to the remote sampler copy |
| `arr_lookup` | **stub**: returns only the `context.arr` the case carries | no read-only Sonarr/Radarr path exists for the harness (no keys in the pod; all arr writes are confined to `packages/domain`). Say so in any report that uses it. |

`ffprobe` and `ffmpeg` are not installed in the dev-env pod. Local video/audio fixtures therefore need a machine that has them, or a `remote` fixture whose locator is
`remote:<namespace>/<deployment>[/<container>]:<absolute path>` (for example `remote:media/bazarr:/tv/Show/ep.mkv`). The ffmpeg-dependent paths are unit-tested with a fake process runner only;
they have not been run against real media in this story.

Provenance of reused code (all merged to main): `ollama_matrix.py` (PR #997) and `local_api.py` (PR #1002) -> `ollama_transport.py`;
`sample_remote.py` (PR #1000) -> `remote_sampler.py`; `epub.py` (PR #998) imported; `ocr.py` consensus rule and prompt (PR #1001) re-implemented in `tools.py`.

## Interpretation notes (scorer)

* **G1** counts write actions only that are outside the case's supported set, or any write on `healthy` / `insufficient_evidence`. CONTRACT's wider "unsupported action" (any action outside the set) is reported as
  `unsupported_any_action_contract_definition`.
* **G2** is literal: a healthy case must get action `none`; an escalation fails G2 (and counts as a false abstention in G5).
* **G3 / G5** use solvable cases whose truth is not `insufficient_evidence`; per-class accuracy must be at least 2/3 for every class present. A false abstention is an `escalate` where `escalate` is not a supported action.
* **G4** uses `insufficient_evidence` and `solvable: false` cases and requires `escalate`.
* **G6** measures the outcome step. The harness never executes a write, so the step runs a deterministic read-only check over the post-action state the case supplies in `outcome_step.inputs`
  (for example the replacement file) and compares the result to `expected`. It tests the verification, not the model; real read-backs are for the monitored pilot.
* **G8** is handled when the decision is an escalation or a correct supported one, no unsafe write was made, and a positive diagnosis does not cite a failed tool result as support. Citing the failure as the reason for abstaining is correct.
  Cases whose injected tool the model never called are reported as `not_exercised`.
* **G9** uses wall time per case minus model load. A crash is a `harness_crash` or `adapter_error` record, or a planned case with no record.
* **G10** accepts a missing model digest only when the record says why (hosted API models).
* A gate with nothing to measure is `not_evaluated`; the overall verdict is then `incomplete`. `suite_shape` compares the run's cases to the GATES.md minimums (informational).

## Smoke and self-test runs (`runs/`)

All use the four synthetic cases in `testdata/`; they validate the harness, they are not a benchmark. Records were produced on a working tree one commit ahead of the recorded sha (`harness_git.dirty: true`);
re-run them with the commands above. Superseded runs are kept: they document how prompt wording changed first-try validity.

| Run dir | Adapter / model | Result |
|---|---|---|
| `smoke-haiku-5-5`, `testdata-haiku-5-5` | claude `claude-haiku-5-5` (response id confirmed) | final prompt; 4/4 correct, all gates pass, about 0.0024 USD for the four cases |
| `smoke-gpt-6-luna`, `testdata-gpt-6-luna` | codex `gpt-6-luna` (id read from the rollout) | final prompt; 4/4, all gates pass, 335k input tokens (Codex's own system prompt dominates), cost not reported |
| `*-a-prompt-draft1`, `*-b-prompt-draft2` | claude haiku | first-try JSON failures: the example `"why":"short reason, at most 200 characters"}` made Haiku end the object with `","}` every time (3/3); fixed by dropping the limit from the example |
| `testdata-codex-gpt-6-luna-a-prompt-draft2` | codex | Luna said "the tools are not callable here" on the corrupt-file case and escalated; fixed by stating the JSON tool call is not a native function call |
| `*-c-prompt-draft3`, `*-d-prompt-draft4` | claude, codex | intermediate prompt versions (draft 4 added the reason-length rule after a 400+ character reason) |
| `smoke-ollama-qwen3.8-27b` | ollama `qwen3.8:27b` | **aborted, no model call completed**: see below |

### Ollama smoke: blocked by a pod restart (not retried)

Preflight was clean (`/api/ps` empty, no GPU compute owner, Ollama 0.40.6). The single warm-up load was issued at 17:03:40 EDT. About 65 s later the `ollama-prime` container was killed (SandboxChanged / Killing, exit 137,
restart count 1) while its log was at `load_tensors … (load_mode = mmap)`. After the restart `/api/ps` was empty and the GPU idle. Cause not established (cold NFS load or an unrelated node event; the node reported no pressure).
The harness stopped as designed, did not retry and did not unload. The Ollama adapter is covered by fake-transport unit tests only; the `anyOf` turn schema has not been exercised by a live Ollama (`--ollama-schema flat` is the fallback).
A retry needs the coordinator's decision, because loading this model may restart the service for other users.

## Known gaps

* Ollama adapter and the schema-constrained turn format are unverified live (above). The ffmpeg-based tools are unverified against real media. The OCR tool is untested against a live vision model.
* `arr_lookup` is a stub. Remote fixtures are not hash-verified (declared sha only).
* Claude and Codex take the whole conversation as one prompt per turn (stateless CLIs); Codex has about 27k tokens of system overhead per turn.
* Codex cannot be stopped from using its own shell tool; such use is only counted (`native_tool_use_items`).
