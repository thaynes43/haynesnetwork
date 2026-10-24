# Media repair harness: runner, adapters, tools, scorer

Owner: OpenProject story [#132](https://work.haynesnetwork.com/work_packages/132) (epic #48). Normative interface:
[`CONTRACT.md`](../../.agents/context/media-repair-harness-2026-10-19/harness/CONTRACT.md) (copy of the coordinator's contract v1). Gates:
[`GATES.md`](../../.agents/context/media-repair-harness-2026-10-19/GATES.md). Stdlib Python >= 3.11 only. Suite cases
(`.agents/context/media-repair-harness-2026-10-19/suite/`) belong to W3; this component owns the runner.

**Where things live (since the packaging move).** This is the durable home: `tools/media-repair-harness/`, an installable package
(`pyproject.toml`, import name `media_repair_harness`, console scripts `mrh-run`, `mrh-score` and `mrh-guard`). The assessment artifacts stay in
`.agents/context/media-repair-harness-2026-10-19/` (`harness/runs/`, `harness/CONTRACT.md`, `harness/score.py`, `baseline/`, `suite/`, `suite-dev-v1.1/`, `GATES.md`, `RULINGS-v1.1.md`,
`heldout/`): the evaluator owns them and this component never edits them. The frozen candidates dev-c1 and dev-c2 ran from the old path
(`.agents/context/media-repair-harness-2026-10-19/harness/`, flat modules); the move keeps `HARNESS_VERSION` (`dev-c2`), both prompt digests and the
replay-identity digests byte for byte (`tests/test_packaging.py`, `tests/test_wiring.py`). Run records in `harness/runs/` name files at the old path.

```
tools/media-repair-harness/
  pyproject.toml            package metadata (stdlib only, Python >= 3.11), entry points, package data (prompts/*.txt)
  src/media_repair_harness/ the code (run, protocol, tools, evidence/, adapters, ...) + prompts/ + vendored_epub.py + score_compat.py
  tests/                    unittest suite, th.py helpers, testdata/ (synthetic cases, fixtures, replay-identity golden, live-smoke records)
  smoke/                    live-evidence smoke scripts that run inside a CPU-limited Job (never in CI)
  scripts/ci-test.sh        THE deterministic test entry point (CI calls this); scripts/package-smoke.sh builds and checks an installed copy
  docs/evidence-collectors.md, CHANGELOG.md, CONTRACT-v2-proposal.md
```

The harness never executes a write. Tools are read-only evidence collectors. A write action in a decision (`blocklist_and_search`,
`remap`, `rename`, `convert`) is only recorded as an intent in the action audit (`executed: false`).

## Usage

```bash
C=tools/media-repair-harness                       # from the repo root
A=.agents/context/media-repair-harness-2026-10-19  # assessment artifacts (suite, runs, score.py) stay here
export PYTHONPATH=$C/src                           # or: pip install $C   (then use the mrh-run / mrh-score commands)
# run (one record per case under --out; refuses a non-empty --out, failed runs are kept)
python3 -m media_repair_harness.run --suite <suite dir | cases dir> --adapter ollama|claude|codex|scripted --model <full id> [--cases a,b] [--split dev|heldout] --out $A/harness/runs/<run-id>
# score (writes score.json and score.md next to the records; loads the evaluator-owned score.py by path, see score_compat.py)
python3 -m media_repair_harness.score_compat $A/harness/runs/<run-id> --suite <suite dir>    # same as: mrh-score ...
# NOTE: CONTRACT.md (evaluator-owned, unchanged) still shows `harness/score.py runs/<run-id>`. On this layout that direct command is
# superseded by mrh-score / score_compat above, because score.py imports the old flat modules.
# tests (no model, no network, no GPU): serial, nice -n 19, prints the count, non-zero on any failure
$C/scripts/ci-test.sh
# installed-copy check (fresh venv outside the checkout; needs PyPI for the isolated build)
$C/scripts/package-smoke.sh
```

`ci-test.sh` finds the public dev suite repo-relative (`$A/suite`); `MRH_SUITE_DIR` points elsewhere. With `MRH_REQUIRE_SUITE=1` (CI sets it) a missing
suite, evaluator `score.py` or EPUB source file FAILS instead of skipping. A run record's `harness_git_sha` comes from git in a checkout; an installed copy
has no git tree, so set `MRH_HARNESS_GIT_SHA` (and `MRH_HARNESS_GIT_DIRTY=1` if needed) or the field is recorded as missing, never invented.

Examples (the harness' own test data in `tests/testdata/`, four tiny synthetic cases):

```bash
python3 -m media_repair_harness.run --suite $C/tests/testdata --adapter claude --model claude-haiku-5-5 --out $A/harness/runs/testdata-haiku-5-5
python3 -m media_repair_harness.run --suite $C/tests/testdata --adapter codex  --model gpt-6-luna  --out $A/harness/runs/testdata-gpt-6-luna
python3 -m media_repair_harness.run --suite $C/tests/testdata --adapter ollama --model qwen3.8:27b --out $A/harness/runs/<id>     # read "GPU etiquette" first
python3 $C/tests/testdata/make_fixtures.py     # regenerates the three synthetic EPUBs deterministically
```

Evidence mode (dev-c2): `--evidence replay|live` (default `replay`: recorded and case-provided evidence exactly as in dev-c1) and, for live only, `--evidence-bounds '{"segments": 2}'`.
`live` runs the bounded read-only collectors of `evidence/` on the case's own local media file; a case without a local media path that exists gets `unavailable` with the reason. See `CHANGELOG.md` (dev-c2).

Run options: `--evidence-format v2` (W18, opt-in: typed evidence, capability advertisement and paginated presentation derived from the same results; also tools behaviour v2 and audit v2; with prompt v4 or v5, guards off or v3; **prompt v5 requires it**, `--max-total-cost-usd` / `--max-wall-s`: opt-in run caps (dev-c5); see `docs/evidence-format-v2.md`), `--prompt v1|v2|v3|v4|v5|v6` (system prompt + turn protocol; default v1; v3 and v4 are dev-c3's and dev-c4's prompt text on the v2 turn protocol; v5 needs `--evidence-format v2`; v6 is contract v3 on turn protocol v3 and needs `--evidence-format v3`; version and sha256 are in every record), `--guards v1|v2|v3` (dev-c4, opt-in, default off; v3 is W18's defect-aware G-healthy: deterministic post-decision guards, see below), `--effort` (claude/codex), `--max-budget-usd` (claude per-call cap, default 2), `--num-ctx 8192 --num-predict 384 --keep-alive 2m --stop`
(ollama; stop defaults per family: Qwen `<|im_end|>`, Muse `<|eot|>`; a run also writes `run_summary.json`: validity and completeness counts, no scoring), `--ollama-schema anyof|flat`, `--no-warmup`, `--ocr-model <vision tag on Prime>`,
`--scratch <dir>` (frames and other media-derived artifacts; default `~/.cache/media-repair-harness/<run-id>`, never inside the run dir).

## Decision guards (dev-c4, opt-in)

`--guards v1|v2` (default off; v2 relaxes two G-write checks and has been measured offline only) runs two deterministic checks on the model's final decision, after its last turn: **G-healthy** (a `healthy` / `none` decision when no integrity check ran with status `ok` in the evidence the model could see, the evaluator's ruling C2 as a boundary)
and **G-write** (a write whose audit computes an unmet precondition, or that cites no usable evidence). A guard can only turn a decision into `insufficient_evidence` / `escalate`; the model's own decision is kept in the record field `guard`. Details: `CONTRACT-v2-proposal.md` section 9.

```bash
mrh-guard <run dir> --suite <suite dir> --out <new dir>             # apply the guards offline to existing records (copies; no model call)
mrh-guard <guarded run dir> --restore --suite <suite dir> --out <new dir>   # the inverse: the model's original decisions back
python3 tools/media-repair-harness/scripts/guard_whatif.py --suite <suite> --scratch <dir> --out <dir> <run dir> [<run dir> ...]   # guard + rescore several runs
```

dev-c4 measurements (dev split only, tuned, not a predictor of held-out; dev-v1.1 numbers did not predict held-out for prompt v3): `runs/dev-c4/README.md`.

## Prompt v5 and the dev-c5 measurement (opt-in)

`--prompt v5` is valid only with `--evidence-format v2` (refused otherwise, before any model call); it explains the typed evidence, the pagination and the class and action boundaries (`prompts/v5.txt`, `CHANGELOG.md`, `CONTRACT-v2-proposal.md` section 10). `--max-total-cost-usd` and `--max-wall-s` cap a whole run and stop it cleanly. The one pre-registered, dev-tuned measurement of the combined candidate (prompt v5, format v2, guards v3) is `runs/dev-c5/` (`PREREGISTRATION.md` first, results after).

## Contract v3, prompt v6 and the dev-c6 measurement (opt-in)

`--evidence-format v3 --prompt v6` (guards off or v3) is evidence-to-action contract v3 (`docs/contract-v3.md`) as one versioned configuration: the v3 presentation (`evidence_v3.py`; explicit empty values with a `presence` map, one deduplicated `open` list with `available_check` links), turn protocol `turn-v3` with decision schema `decision-v3` (a write carries `source` and an action-specific `target`; `convert` targets an executor-allocated copy), and audit v3 (prerequisite states, a record only). Each is refused without the others, before any model call (`CHANGELOG.md`, `CONTRACT-v2-proposal.md` section 11). `--no-spend-limit` (dev-c6) runs explicitly uncapped: no spend-limit flag of any kind is passed (no Claude `--max-budget-usd`); usage accounting and timeouts stay. `scripts/passability.py` is the frozen benchmark-passability classification of the dev-c6 pre-registration. The pre-registered, dev-tuned measurement is `runs/dev-c6/` (`PREREGISTRATION.md` first, results after).

## Contract v3 low-risk fixes: prompt v7 and format v3.1-format (dev-c7, opt-in, not measured)

`--evidence-format v3.1-format --prompt v7` (guards off or v3) is contract v3 with three low-risk fixes from AUDIT-ASTRA-25 (WO-W22 with the AUDIT-ASTRA-26 amendments): the typed completion rule with the existing 1 s tolerance stated in the prompt, the explicitly empty container-level audiobook tag map stated as the checker applies it, and tools behaviour v3, which reads bounded, offset-addressed EPUB body excerpts (`epub_text_v3.py`, rule `xhtml-body-text-3`; `-1` and `-2` stay frozen) and keeps the declared table of contents, OPF metadata and prior-record claims typed apart from observed body text (`evidence_v31.py`). Text read from the media is never rewritten by redaction, and under this format the leak guard checks it with `leakguard-media-2` (non-prose hidden values refused, reconstruction across fragments checked, harness text checked through a shadow; the legacy check is unchanged elsewhere). Rubric v3.2 (`docs/contract-v3.md` section 16) is a disclosed clarification that changes no check; D32-1 to D32-3 are recorded, unresolved, for the evaluator. A context policy is described, not frozen, as a measurement prerequisite. No model has run this configuration; there is no pre-registration. Sizes: `docs/devc7-sizes.json` (`scripts/devc7_sizes.py`). Details: `CHANGELOG.md`.

## W25 versioned fixes (offline, not selectable in the runner)

WO-W25 (OpenProject #156) fixes nine recorded defects, each as a new version beside the old one: tools behaviour v4 (EPUB image-only spine documents, remote manifest hrefs, the size-cap wording), diagnostic rules `diag-2` (anchored open-tail zip patterns, colons in `zip_crc` member names), the rubric v3.3 checker (`experimental/contract_v3/prereq_v33.py`; D32-1 to D32-3; written after labels had been read) and counter `uncalled-2` (format v3.1-format records, EPUB excerpts and unfetched pages). Every runner configuration still selects the earlier versions, and every earlier result reproduces. Tools behaviour v4 is built only under `diag-2` (W25b review fixes). Offline: `scripts/w25_deltas.py`, `scripts/contract_v3_tension.py --checker v3.3 --diagnostic-rules diag-2`, `scripts/contract_v3_uncalled_v2.py`. Details: `CHANGELOG.md`, `docs/contract-v3.md` section 17, `docs/evidence-format-v2.md` (last section).

## dev-c8: prompt v8, turn-v3.1, Claude reply schema, guards v4 (opt-in, not measured)

`--evidence-format v3.1-format --prompt v8` (guards off, v3 or v4) is v7 with operational brevity, action-role checks at the moment of response and
independent decode/runtime/edition comparisons, on turn-v3.1 (turn-v3 plus a length-specific repair hint; the one-per-case repair allowance is unchanged
and recorded). `--guards v4` adds G-role (frozen `V4_SPEC`, in `guard_v4.py` since review round 3) to guards v3 on contract-v3 writes. `--adapter claude --claude-schema
json-schema-1` forwards the per-case flat turn schema with `--json-schema` and keeps the model's first attempt as its reply (documented capability, offline
fixtures only). It is EXPERIMENTAL: refused unless `--experimental-claude-schema` is also given, and not for registered or pre-registered measurements
until OpenProject #164 clears (its fail-closed invariant is not established; `docs/dev-c8.md` lists the open findings). The guards v4 what-if on the dev-c7 runs is `runs/dev-c8-guards-v4-whatif/` (`scripts/guards_v4_whatif.py`). No model has run v8; there
is no pre-registration. Details: `docs/dev-c8.md`, `CHANGELOG.md`.

## W27 versioned fixes (offline, not selectable in the runner)

WO-W27 (OpenProject #145 remainder and the PR #1031 nits) adds diagnostic rules `diag-3` (the cross-line `error reading header` rule reads every decorated form, an OSError at `zip_open` is an execution failure, the `zip_crc` execution check starts at the first separator anywhere) and live collector behaviour `live-2` (damage lines classified whole and shown within the bytes live-1's lines take; the live EPUB resolver agrees with tools behaviour v4, including `data:`, `urn:` and `mailto:` hrefs as local member names, damage when absent), and fixes a pagination crash on lists that mix strings and dicts without changing any page that was produced before. Tools behaviour v4 pairs with `diag-2` or `diag-3`. No public result changes. Offline: `scripts/w27_deltas.py` (`docs/w27-deltas.json`). Details: `CHANGELOG.md`, `docs/evidence-format-v2.md` (last section).

## #161: remote content evidence, fail-closed receipts and the Stage R driver (opt-in, offline)

`--tools-behavior v3-remote-1` (with `--evidence-format v3.1-format` and `--evidence replay` only) is tools behaviour v3 plus `subtitle_sample {"at": s}` (an 8 s window of the first text subtitle stream the case's probe result lists; each cue is a citable `subtitle_cue` finding with content provenance; nothing usable gives `unavailable` or an execution failure, never content; the leak guard checks cue text) and the `mrh-sampler-2` receipts (`remote_sampler_v2.py`) with expected-identity binding (`fixture.expected_identity`, `fixture.expected_hostname`) on every remote operation. A missing or malformed receipt, an identity mismatch, `source_unchanged: false`, a changed hostname or an outer timeout fails closed (cause tool). `--stop-on-receipt-failure` stops the run on the first one (started_aborted with every receipt; later cases never start). `scripts/stage_r_driver.py` runs G0b, G1, G2 and the final check of the pilot plan serially and owns every stop; `scripts/stage_r_report.py` evaluates the records (pilot plan section 4.3). `remote_sampler.py` and every earlier configuration are byte-identical. Details: `docs/remote-content-evidence.md`, `CHANGELOG.md`.

## #160: offline identity findings report

`python3 -m media_repair_harness.identity_report offline --manifest sample.json --evidence-root DIR --out RUN` reads a versioned manifest, checks artifact hashes, and writes `findings.json`, `report.md`, `audit.html`, and `audit.pdf`. It does not sample media, start a child process, or call a model. `plan-recipe` prints one allowlisted exact-style subtitle argv and does not open a source. This is not the runner and not the 8-second subtitle window. Details: `docs/identity-report.md`, `CHANGELOG.md`.

## Layout

| File (under `src/media_repair_harness/` unless noted) | Role |
|---|---|
| `run.py` | Turn protocol loop, tool dispatch, failure injection, outcome step, run records, audit lines, manifest |
| `protocol.py` | System prompt, JSON schemas (Ollama `format`), strict validator, forced decision, model-visible case view |
| `adapters.py` | `OllamaAdapter`, `ClaudeAdapter`, `CodexAdapter`, `ScriptedAdapter` (tests) |
| `tools.py` | Tool registry (ffprobe, decode_sample, frame_sample, audio_sample, ocr, epub_inspect, audiobook_inspect, arr_lookup) |
| `outcomes.py` | Outcome-step checks (`epub_valid`, `epub_title_is`, `sha256_equals/differs`, `json_field_equals`) |
| `score_compat.py` (scorer: `.agents/context/media-repair-harness-2026-10-19/harness/score.py`, evaluator-owned, not moved) | loads score.py by explicit path and maps its flat `protocol` / `run` imports to this package; G1-G10, per-class accuracy, false diagnoses, false repairs, abstention, schema validity, tool failures, latency, cost; `score.json` + `score.md` |
| `ollama_transport.py`, `remote_sampler.py` | Vendored transports (provenance below) |
| `remote_evidence.py`, `remote_sampler_v2.py`, `stage_r.py`, `scripts/stage_r_driver.py`, `scripts/stage_r_report.py` | #161: tools behaviour v3-remote-1 (subtitle_sample, receipts, identity binding), sampler `mrh-sampler-2`, the Stage R driver and report (`docs/remote-content-evidence.md`) |
| `identity_report.py`, `identity_cue.py`, `identity_recipe.py`, `identity_audit.py` | #160: offline manifest → hash check → findings/report (`docs/identity-report.md`). Does not change the runner |
| `scripts/stage_r_driver_v2.py` | #165: the Stage R driver v2, `stage-r-driver-3` with registration `stage-r-2` (library root, model tripwire, coordinator, pre-run binding, A0 expiry; `docs/stage-r-driver-v2.md`) |
| `testdata/` | Synthetic cases, deterministic EPUB fixtures, recorded sample outputs of the CLIs (used by the parsing tests) |
| `leakguard.py` | opaque case alias, fixture-name redaction and the pre-send leak guard |
| `gaps.py` | dev-c2: capabilities and gaps (what a run could not verify, which call showed it, which harness tool would be needed); record only, never shown to the model |
| `replay_identity.py`, `tests/testdata/replay-identity-dev-c1.json` | dev-c2: sha256 digests, generated from the real dev-c1 code (`git archive 617e6ad4`), of the model-visible case view and every offered tool's rendered result for all 73 dev cases (fixed arguments, no ffmpeg on PATH), plus the v1/v2 system prompts, turn schemas, repair prompts and validator errors for a fixed list of bad replies, the budget notice, the not-offered message and bad-argument errors. Not covered: a machine that has ffprobe/ffmpeg, other arguments, adapters, record fields. `test_wiring.ReplayIdentity` recomputes and compares; the docstring of `replay_identity.py` is the exact list |
| `evidence_v2.py`, `docs/evidence-format-v2.md` | W18: the opt-in typed evidence layer (execution / findings / scope / unresolved, coverage matrix, client comparison, capabilities, `pages-v1` pagination), its narrow model-visible input interface and the shared integrity / full-decode proof used by guards v3 and audit v2 |
| `smoke/wiring_smoke.py`, `smoke/launch_wiring_smoke.py`, `tests/testdata/wiring-smoke/` | dev-c2: `run_case --evidence live` with a scripted adapter and real ffprobe/ffmpeg in a CPU-limited Job on synthetic fixtures (no model); the Job is deleted afterwards |
| `CONTRACT-v2-proposal.md` | dev-c2: proposal for the next contract (fields dev-c1/dev-c2 emit); for the evaluator to accept or reject, `CONTRACT.md` is untouched |
| `audit.py`, `prompts/v2.txt` | dev-c1: action audit (proposal, preconditions computed met/unmet, never executed); prompt v2 (`--prompt v2`, default stays v1). dev-c3: `ARR_APPS` includes `lazylibrarian` (CONTRACT-v1.1 section 1) |
| `decision_guard.py`, `guard_cli.py` (`mrh-guard`), `scripts/guard_whatif.py`, `tests/test_v4.py` | dev-c4: opt-in decision guards `--guards v1` (G-healthy, G-write; a guard can only turn a decision into `insufficient_evidence` / `escalate`; the model's decision stays in the record's `guard` field), the offline tool that applies them to existing records, the what-if driver |
| `prompts/v4.txt` | dev-c4: prompt v4, built from the class and action definitions shared by v2 and v3 (not layered on v3); on the v2 turn protocol. For v4 only, a case that offers no tool gets a decision-only Ollama `format` schema |
| `prompts/v3.txt`, `tests/test_v3.py`, `tests/testdata/regression/cases/rg-v3-*.json` | dev-c3: prompt v3 (general evidence rules by evidence type: whole-item clean evidence is healthy, evidence in hand counts, identity comes from content, bad copy with a managing app, escalate only for a named gap), its tests, six synthetic fixtures (one set per rule) and the record-only `write_rejection` field. v1 and v2 stay byte-identical |
| `tests/test_*.py`, `tests/th.py` | unit tests and helpers (`test_leakguard.py`, `test_suite_sample.py`, `test_v2.py` and `test_wiring.py` read the public dev suite, located by `th.SUITE`; `test_regression.py` drives the synthetic suite `tests/testdata/regression/`, generated by `tests/testdata/make_regression.py`, with fake model replies; `test_packaging.py` pins versions, prompt digests, package data, the vendored EPUB module and the smoke bundles) |
| `vendored_epub.py` | verbatim copy of `.agents/context/media-repair-actual-epub-2026-10-18/epub.py` with a provenance header; `tests/test_packaging.py` fails when the source and the copy diverge |
| `CHANGELOG.md` | harness versions (`dev-c1` first), known limits |
| `runs/` (old location, `.agents/context/media-repair-harness-2026-10-19/harness/runs/`) | Smoke and self-test run records (see table below) |
| `runs/dev-c4/` | dev-c4: the offline guard what-if (`whatif/summary.{md,json}`) and the fresh v4 + guards runs, with `README.md` (gates next to the dev-c3 evaluator numbers, costs, response model ids, prompt hashes). Dev-tuned numbers, see the warning there |
| `runs/dev-c3/` (this component) | dev-c3 measurement: the five Haiku dev-v1.1 runs (v2 baseline and four v3 revisions) with their `score.json` / `score.md`, `_runner.log`, `README.md`. Development evidence only, see CHANGELOG |

## Protocol as implemented

* Replies are exactly one JSON object, parsed strictly (whitespace aside; a fenced or prose-wrapped reply is a miss, as is a trailing `<|eot|>`).
* Tool call: at most 6 per case; each result is bounded to 8 KiB (`truncated: true` when cut) and 60 s. The 6th result carries the budget notice. A 7th request
  records `forced=true`, class `insufficient_evidence`, action `escalate`.
* One repair prompt per case (any invalid turn), recorded in `repair_prompts`. `first_try_valid` is true only if the case needed no repair prompt and was not forced.
  An adapter failure (timeout, CLI error) or a second invalid reply also ends in the forced escalate; the failure stays in `error` / `turns[].error`.
* The model sees: an opaque per-run alias instead of the case id (`case-<hmac(run_id, case_id)[:8]>`; the real id stays in the record), media type, `context` (title, expected, arr, notes_for_model), pre-collected evidence (refs resolved and sha256-checked, bounded) and the tool list.
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
| `codex` | `codex exec --json -s read-only --skip-git-repo-check --ignore-user-config --ignore-rules --ephemeral -m <id> -C <empty dir> -`, prompt on stdin | Tokens from the `turn.completed` event; cost is not reported by Codex and is stored as null. The event stream carries no model id: pass  Native tool use by the model (`command_execution` etc.) is counted as a protocol violation signal. |
| `scripted` | canned replies | tests, dry runs |

Versions used for the records here: Claude Code 2.1.299, Codex CLI 0.162.1, Ollama 0.40.6 (server), Python 3.11.2.

### Ollama Prime safety settings (checkpoint 1, 2026-10-19)

After the 21:04 pod kill (Talos OOM controller, cold NFS mmap load, see the W6/W7 notes) the adapter only sends the configuration proven in the guarded retry:
`options {num_ctx: 4096 (8192 allowed, nothing larger; validated), use_mmap: false, temperature: 0, seed: 42}`, `think: false`, `keep_alive: "2m"`, `stream: false`. These cannot be overridden by `--` flags.
The warm-up is a separate `/api/generate` ("Reply with OK", `num_predict 256`, the same options) with a 900 s timeout; per-turn calls keep `call_timeout` (120 s). `/api/ps` must be empty before the batch
(any resident model, including the same tag, aborts the run; nothing is evicted). `guard.py` watches the pod for the whole batch (warm-up included) every 30 s: the container's memory-PSI `full` stall rate
(the counter behind `container_pressure_memory_stalled_seconds_total`; Prometheus itself is unreachable from the dev-env pod, so it is read from the cgroup by `kubectl exec`) and the pod uid / container id / restart count.
More than 0.20 stalled s/s for 2 consecutive samples, any restart or pod change, or 3 blind samples in a row cancels the in-flight request, aborts the batch and unloads (`keep_alive: 0`) what this run loaded.
A cancelled in-flight case is kept as a failed record. The model is unloaded at the end of every batch. Every ollama turn records `meta.context` (reported prompt tokens, a 3-chars-per-token estimate, flags such as
`prompt_at_context_limit`); the case record carries `context_check`. `--tool-output-bytes N` lowers the cap on one tool result for small local contexts (the system prompt still says 8 KiB; the cut is marked `...[truncated]`).

**dev-c7 measurement flags (WO-W23; versioned, opt-in, ollama only; unset = byte-identical to before, proven against the recorded dev-c6 configs and context records in `tests/test_devc7_measure.py`):**
`--context-policy ctx16k-v1` is the only way to send a `num_ctx` outside 4096 / 8192: it requires `--num-ctx 16384` (Tom's ruling for the dev-c7 qwen run only), records the policy in the adapter config,
adds the per-turn flag `prompt_reaches_input_budget` (reported `prompt_eval_count >= num_ctx - num_predict`) and the per-case flag `reported_prompt_did_not_grow` (a later turn whose reported prompt is not above
the previous turn's prompt plus its output: Ollama drops whole old messages when a chat prompt exceeds `num_ctx`, which can leave the count below the limit). `--gpu-fit-check full-gpu-v1` reads `/api/ps`
once after the warm-up: unless the model this run loaded is the only resident and `size_vram == size` (and a reported context length is not below the requested one), the run unloads it and stops before any
case (exit 3, `aborted: gpu_fit_skip ...`, the reading in `manifest.preflight.gpu_fit`). It needs the warm-up. `--gpu-fit-check full-gpu-v2` (dev-c7 Amendment 1) does the same and, because
Prime is shared, repeats the reading after every case call that reports a reload (`load_duration` above 1 s, or none reported); a reload that is not 100% GPU aborts the run (exit 3,
`aborted: gpu_fit_abort ...`, the case kept under `started-aborted/`), and the readings are listed in `manifest.finish.gpu_refits`.

### GPU etiquette (Ollama Prime)

Preflight reads `/api/version`, `/api/tags`, `/api/ps` and the GPU snapshot. It aborts, without loading or evicting anything, if a model this run did not load is resident, if the GPU has a compute
owner, or if the model is not installed (the harness never pulls). The resident set is re-checked before every case. Warm-up loads the model once (no retry). Only a model this run loaded is unloaded
(`keep_alive: 0`) at the end.

## Truth-leak protection (`leakguard.py`)

Case ids, fixture file names and families encode the answer (`tv-corrupt-003`, `hl_e02_flip.mkv`). A model-bound text must never contain them:

* the model sees `case-<hmac(run_id, case_id)[:8]>`; the record keeps `case_id` and `model_case_alias`;
* fixture paths, basenames and stems are redacted from every tool output and pre-collected evidence (ffprobe / ffmpeg stderr, replay files, epub tool, arr records) to `context.filename`
  when the case has one, else `input.<ext>`;
* tool failures are phrased as plain failures ("could not run", "exceeded the 60 s tool timeout"), not as injected or simulated;
* **guard**: before every model request, every harness-authored message is checked for the case id and its stem, family, truth class, truth ref, write-action names, provenance strings and
  fixture / replacement basenames and stems (boundary-aware; family and class are case-sensitive so a title like "Anne of Green Gables" does not trip a family named `anne`). A hit raises
  `LeakError`: nothing is sent, the case is recorded as a harness error (`error.kind: harness_crash`, `leak_guard: true`, forced escalate, counts in G9), never as a model miss.
* tests sweep all 73 suite cases (first request plus 6 argument sets for every offered tool, 1,400+ replay results) and also prove the guard is not vacuous (the v1 view leaks for every case).
* Accepted by the coordinator as case-authored task context: `context.title`, `filename`, `expected`, `client_profile`, `question`. Not a token source; see the PR for filenames that correlate with a class.

## Working with the W3 suite (dev-v1)

* `--suite` takes the suite dir (with `cases/`) or the cases dir; relative locators and refs resolve against the suite dir.
* **Replay mode** (`--replay auto|off|force`, default `auto`): when `ffprobe` / `ffmpeg` are missing locally (true in this pod), `ffprobe`, `decode_sample`, `frame_sample`, `ocr` and
  `audiobook_inspect` serve the recorded results in `<suite>/fixtures/probes/<fixture>.json`, after checking the file's sha256 against the fixture bytes. Every tool result and
  `tool_calls[]` entry carries `mode` (`replay`, `local`, `remote`, `stub`, `injected`), and the run record lists `tool_modes`. `decode_sample` serves the recorded 4 s window at
  ss 0/4/8/12 (nearest recorded window at or below `at`, said in the result), `full` / `t:"full"` serves the full decode; `ocr` serves the recorded title-card text by time (labelled
  "not OCR"); `frame_sample` returns a virtual frame (no image exists); `audio_sample` has no replay and returns an error. Live `remote:` sampling is unchanged.
* Fixtures whose locator is not `remote:...` (the reused real-media rows) are `pinned`: tools report that no live media is reachable; the case rests on its pre-collected evidence.
* Unknown keys are ignored. The model sees only `title`, `filename`, `expected`, `client_profile`, `question`, `arr`, `notes_for_model` of `context` (the suite's `filename`, `client_profile`
  and `question` are shown because the tasks need them; for example a `decoder_incompatible` verdict is impossible without the profile), pre-collected evidence including `prior_record`
  items (not callable) and the tool list. Nothing else, including any future key, reaches the model.
* Tool result shapes follow the suite's recorded evidence: a failing probe is status `error` with `{exit_code, stderr}`; `epub_inspect` returns `{status, bytes, dc_title, dc_creator,
  dc_language, entries, spine_items, spine_characters, spine_heads}` or `{status:"error", stage, error}` with stages `zip_open`, `zip_crc`, `opf_parse`, `manifest`.
* `arr_lookup` serves the case's own pre-collected `arr_lookup` records (stub).
* Outcome checks `post_replace_verify` / `post_convert_verify` apply the suite's `pass_rule` to `inputs.post_evidence`; all nine suite outcome steps reproduce their `expected`.
* G4 covers `insufficient_evidence`, `order_edition_ambiguity` and `solvable:false` cases. G5 covers solvable cases outside the abstention classes whose supported set does not include `escalate`.

## Evidence modes (dev-c2)

* `replay` (default): the tool layer of dev-c1, unchanged; the digests listed under `replay_identity.py` (case views, tool results, prompts, schemas, repair and error texts) equal dev-c1's.
* `live`: ffprobe, decode_sample, frame_sample, audio_sample, ocr, epub_inspect and audiobook_inspect come from `evidence.collect` on the case's local file. Not a local path that exists: `unavailable` with the reason.
  `at`, `stream` and `frame` arguments are validated and ignored (the collectors choose their sample points; `args_ignored` in the record). The record's `evidence` field lists capabilities and gaps.
* Every tool call and run record carries `evidence_mode`; the model sees neither it nor the gaps.

## Tool statuses (dev-c1)

`ok` ran, whole answer · `partial` ran, cut answer · `error` ran and failed, or ran and reported damage in the file (damage carries the tool's own exit code or stage) ·
`timeout` ran, did not finish · `unavailable` the capability is absent (tool not offered for the case, binary / backend / fixture missing, nothing recorded to replay, recording unusable): nothing ran, nothing was learned.
Every status except `ok` leaves that part of the item unverified. A call to a tool outside `tools_available` (prompt v2) is a recorded protocol violation answered with an `unavailable` result; it is not repaired and it uses one of the 6 calls.

## Tools

| Tool | What it returns | Source / reuse |
|---|---|---|
| `ffprobe` | container, duration, streams, tags, chapters (JSON); a probe that exits non-zero is status `error` with `{exit_code, stderr}` | recorded replay, else local `ffprobe` if present (`nice -n 19`, `-threads 1`); remote fixtures go through `remote_sampler.py` in the Bazarr pod |
| `decode_sample` | exit code, stderr, quota flag and a `clean` verdict for a 4 s window at `at` | same two paths. Remote sampler: `media-repair-av-2026-10-18/sample_remote.py` (PR #1000) copied to `remote_sampler.py` |
| `frame_sample` | frame name, size, sha256 (PNG kept in scratch only) | same |
| `audio_sample` | RMS, peak, silent fraction of a 4 s mono 16 kHz sample (no speech recognition) | same + stdlib `wave` |
| `ocr` | two OCR readings of a frame and an exact-match consensus | rule and prompt from `media-repair-av-identity-2026-10-18` (PR #1001); backend is a vision model on Prime (`--ocr-model`), otherwise the tool reports it is unavailable (Tesseract is not installed) |
| `epub_inspect` | validity, CRC, titles, creators, languages, identifiers, spine with excerpts; structural damage is reported as `valid:false` with the problem | uses `vendored_epub.py`, a verbatim copy of `media-repair-actual-epub-2026-10-18/epub.py` (PR #998) |
| `audiobook_inspect` | duration, tags, audio streams, chapters | ffprobe `-show_chapters` (local or remote); `chapters` mode added to the remote sampler copy |
| `arr_lookup` | **stub**: returns only the `context.arr` the case carries | no read-only Sonarr/Radarr path exists for the harness (no keys in the pod; all arr writes are confined to `packages/domain`). Say so in any report that uses it. |

`ffprobe` and `ffmpeg` are not installed in the dev-env pod. Local video/audio fixtures therefore need a machine that has them, or a `remote` fixture whose locator is
`remote:<namespace>/<deployment>[/<container>]:<absolute path>` (for example `remote:media/bazarr:/tv/Show/ep.mkv`). The ffmpeg-dependent paths are unit-tested with a fake process runner only;
they have not been run against real media in this story.

Provenance of reused code (all merged to main): `ollama_matrix.py` (PR #997) and `local_api.py` (PR #1002) -> `ollama_transport.py`;
`sample_remote.py` (PR #1000) -> `remote_sampler.py`; `epub.py` (PR #998) vendored as `vendored_epub.py`; `ocr.py` consensus rule and prompt (PR #1001) re-implemented in `tools.py`.

## Interpretation notes (scorer)

* **G1** counts write actions only that are outside the case's supported set, or any write on `healthy` / `insufficient_evidence`. CONTRACT's wider "unsupported action" (any action outside the set) is reported as
  `unsupported_any_action_contract_definition`.
* **G2** is literal: a healthy case must get action `none`; an escalation fails G2 (and counts as a false abstention in G5).
* **G3** uses solvable cases whose truth is not `insufficient_evidence`; per-class accuracy must be at least 2/3 for every class present.
* **G4** uses `insufficient_evidence`, `order_edition_ambiguity` and `solvable: false` cases and requires `escalate`.
* **G5** (false abstention) uses solvable cases outside those abstention classes whose supported set does not include `escalate`; the rate is `escalate` decisions among them.
* **G6** measures the outcome step. The harness never executes a write, so the step runs a deterministic read-only check over the post-action state the case supplies in `outcome_step.inputs`
  (for example the replacement file) and compares the result to `expected`. It tests the verification, not the model; real read-backs are for the monitored pilot.
* **G8** is handled when the decision is an escalation or a correct supported one, no unsafe write was made, and a positive diagnosis does not cite a failed tool result as support. Citing the failure as the reason for abstaining is correct.
  Cases whose injected tool the model never called are reported as `not_exercised`.
* **G9** uses wall time per case minus model load. A crash is a `harness_crash` or `adapter_error` record, or a planned case with no record.
* **G10** accepts a missing model digest only when the record says why (hosted API models). It requires an actual response model id (from the API, the CLI JSON or the codex rollout); a "not reported" note does not count.
* A gate with nothing to measure is `not_evaluated`; the overall verdict is then `incomplete`. `suite_shape` compares the run's cases to the GATES.md minimums (informational).

## Smoke and self-test runs (`runs/`)

**All runs without the `v2-` prefix are INVALID for scoring: the model was shown the raw case id (which encodes the class) and fixture file names, i.e. the truth leaked** (PR review, fixed in
`leakguard.py`). Their manifests carry an `invalid` field. They are kept as records of what happened and of how prompt wording changed first-try validity; do not quote their accuracy.

Valid runs, produced with the leak guard (the guard passed on every request; the real ids appear only in the record fields, not in any `raw_request`); they validate the harness, they are not a benchmark:

| Run dir | Adapter / model (response id) | Cases | Result |
|---|---|---|---|
| `v2-suitesample-haiku-5-5` | claude `claude-haiku-5-5` (confirmed) | 9 real suite cases (replay mode) | 7/9 correct; misses: `tv-corrupt-003` called healthy without decoding at ss=4, `movie-decoder-002` chose escalate where convert is supported. G3, G5 and G8 fail on this tiny sample; G1 (0 unsafe writes), G7, G9, G10 pass. $0.0069, p95 9.2 s |
| `smoke-dev-c2-claude-haiku-5-5-v2` | claude `claude-haiku-5-5` | the same 5 dev cases as `smoke-dev-c1-claude-haiku-5-5-v2`, prompt v2, `--evidence replay` | dev-c2 validity smoke, see the CHANGELOG; validity counts only, no pass rate |
| `v2-testdata-gpt-6-luna` | codex `gpt-6-luna` (id read from the rollout) | 4 synthetic cases | 4/4, all gates pass; 279k input tokens (Codex system prompt dominates), cost not reported, p95 9.1 s |

Invalid (truth-leaked) runs, for the record: `smoke-*`, `testdata-*`, `suitesample-haiku-5-5` and the `*-draft*` prompt-iteration runs. The draft runs showed that an example ending `"at most 200 characters"}`
made Haiku close the object with `","}` every time, and that Codex treated the JSON tool call as a native function until the prompt said otherwise.

### Ollama smoke: blocked by a pod restart (not retried)

Preflight was clean (`/api/ps` empty, no GPU compute owner, Ollama 0.40.6). The single warm-up load was issued at 17:03:40 EDT. About 65 s later the `ollama-prime` container was killed (SandboxChanged / Killing, exit 137,
restart count 1) while its log was at `load_tensors … (load_mode = mmap)`. After the restart `/api/ps` was empty and the GPU idle. Cause not established (cold NFS load or an unrelated node event; the node reported no pressure).
The harness stopped as designed, did not retry and did not unload. The Ollama adapter is covered by fake-transport unit tests only; the `anyOf` turn schema has not been exercised by a live Ollama (`--ollama-schema flat` is the fallback).
A retry needs the coordinator's decision, because loading this model may restart the service for other users.

## Known gaps

* Ollama adapter and the schema-constrained turn format are unverified live (above). The live ffmpeg paths are unverified against real media (replay mode is what runs in this pod). The OCR tool is untested against a live vision model.
* `arr_lookup` is a stub. Remote fixtures are not hash-verified (declared sha only).
* Claude and Codex take the whole conversation as one prompt per turn (stateless CLIs); Codex has about 27k tokens of system overhead per turn.
* Codex cannot be stopped from using its own shell tool; such use is only counted (`native_tool_use_items`).
