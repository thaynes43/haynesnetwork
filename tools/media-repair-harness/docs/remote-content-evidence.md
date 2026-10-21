# Remote content evidence, fail-closed receipts and the Stage R driver (#161)

- **Story:** OpenProject #161 (epic #48), the prerequisite of the pilot plan (#160).
- **Specification:** `docs/pilot-plan-v3.md` (v3.2) section 3, items 1 to 6, and sections 4.1 to 4.4 for how the driver is used.
- **Status:** offline engineering only. No model call, no cluster access, no production read was made for it. Every test uses fake runners or the real
  sampler run locally on synthetic files.

## 1. Versions added (all opt-in; no default changes)

| Version | Where | Selected by |
|---|---|---|
| Tools behaviour `v3-remote-1` | `remote_evidence.py`, hooks in `tools.py` | `--tools-behavior v3-remote-1` (with `--evidence-format v3.1-format` and `--evidence replay` only) |
| Sampler `mrh-sampler-2` | `remote_sampler_v2.py` | sent only by tools behaviour `v3-remote-1` and the driver |
| Runner stop option | `run.py` (`RemoteStop`) | `--stop-on-receipt-failure` (only with `--tools-behavior v3-remote-1`) |
| Driver `stage-r-driver-1`, registration `stage-r-1` | `scripts/stage_r_driver.py` | the coordinator, after approval |
| Report `stage-r-report-1` | `scripts/stage_r_report.py`, `stage_r.py` | offline |

Unchanged: `remote_sampler.py` (`mrh-sampler-1`, the PR #1000 copy) is byte-identical and is still what every earlier tools behaviour sends;
`protocol.TOOLS`, `tools.REGISTRY`, every prompt, every schema, the config of every earlier option set, and every recorded run. A run without the new
options has no `remote_evidence` record field, no receipts and the same config hash as before. Tests: `tests/test_remote_evidence.py`
(`LegacyIdentity`), and the existing replay-identity and recorded-config tests.

A run with the option records, in its config, `tools_behavior: v3-remote-1` and `remote_evidence` (the sampler sha256 and every bound below), and
`stop_on_receipt_failure: true` when set. Each case record gets `remote_evidence` (expected identity, bound hostname and its source, operation count, every
receipt with its argv and outcome, the fatal state, the subtitle stream); each tool call carries `receipts` (record only, never in a model-bound message).

## 2. `subtitle_sample {"at": s}` (item 1)

- **Stream.** The first stream whose `codec_type` is `subtitle` and whose `codec_name` is `subrip`, `ass`, `ssa` or `mov_text`, in the first `ok` ffprobe
  result of the case evidence (for Stage R: the G1 probe the driver injects). It is chosen when the case starts; no sampler call chooses it, and a `stream`
  argument is refused as bad arguments. The capability advertisement states the stream and the argument form (prompt v7 is unchanged).
- **Offsets.** Only the model chooses `at`, within its 6 calls. Nothing is pre-chosen.
- **Window.** 8 s (`SUBTITLE_WINDOW_S`) from `at`, through `mrh-sampler-2 subtitle` (remote: 25 s, 8 MiB input quota) or local `ffmpeg` (25 s).
- **Output.** `{stream, window, cue_count, cues: [{cue, start_s, end_s, text}], note}`. Rule `srt-cues-1`: SRT blocks of an index line, a timing line and
  text; formatting tags removed, lines joined, whitespace collapsed; a cue left empty is dropped; at most 40 cues of at most 300 characters (`partial`
  beyond). A cue time is the window start plus the time inside the window.
- **Typed evidence.** Each cue is a finding of kind `subtitle_cue` (`known_defect: false`), so its id (`t3.f2`) is citable and resolves like any finding;
  its location is the stream, the cue times and the cue number. The item's `kinds` is `{provenance: observed, fields: {cues: content}}`. It is a reading,
  never an integrity check.
- **Nothing usable is never content.** No text stream in the probe, or no probe: `unavailable`, nothing invoked. An empty window: `unavailable` (the
  text says the sampler ran and the window held no cue). Malformed SRT or invalid UTF-8: `error`, cause `tool`. A failed extraction: `error`. None of these
  carries a cue.
- **Scope limits (not failures).** The input quota: `partial`, the cues before the cut are kept, a cut last block is dropped. A sampler-internal timeout with
  a valid receipt: `timeout`, the complete cues before it are kept.
- **Leak guard.** Cue text is media text: it is never rewritten by redaction, and `leakguard-media-2` checks it (each cue a source, adjoining cues joined),
  while the legacy check reads a shadow with every cue text blanked. A hit is a harness error and nothing is sent.

## 3. Receipts, identity binding and the stop (items 2 to 4)

`mrh-sampler-2` ends every invocation with one terminal receipt, the last stderr line:

| Field | Meaning |
|---|---|
| `receipt`, `mode`, `hostname` | `mrh-sampler-2`, the mode run, `socket.gethostname()` of the pod |
| `exit_code`, `error`, `stderr` | the tool's exit (int), `timeout` (the sampler's own 25 s), or `error` (the sampler could not run the operation) |
| `stdout_bytes`, `bytes_read`, `quota_exhausted`, `requests` | what it wrote, what it read, the 8 MiB quota flag |
| `wall_seconds`, `timed_out` | its own wall and timeout state |
| `source_unchanged` | size and mtime_ns after the operation equal those before it (file modes) |
| `identity` | `expected` (from `--expect-size` / `--expect-mtime-ns`), `start`, `end`, `start_ok`, `end_ok`; a start mismatch reads nothing |
| `listing` | `list` only: `complete`, `matching`, `scanned`, `cap` |

**One 25 s budget per invocation:** the start identity stat, the operation and the end identity stat share one deadline, and the operation stops 2 s
early so the end check still fits; a sampler-internal timeout therefore always ends with its receipt well inside the 60 s outer deadline (`mrh-sampler-1`
gave each step its own 25 s). New modes: `stat` now runs under that limit (`mrh-sampler-1`'s did not); `list <dir> [--prefix p]` scans the whole directory, counts only entries
matching the prefix toward the cap of 500, returns name, type, size and mtime_ns, opens no file, and is `complete` only when fewer than 500 entries matched
and the scan finished in time.

**Fatal** (`remote_evidence.FATAL_KINDS`; the result is an execution failure, cause `tool`, and its output is never used):
`missing_receipt`, `malformed_receipt` (shape, types, `stdout_bytes` not equal to the bytes received, a timeout without `timed_out`, a completed file
operation without `source_unchanged`), `identity_mismatch` (expected, start and end must all equal the bound identity), `source_changed`,
`hostname_changed` (the run's host is the case's `expected_hostname`, else the first receipt's), `outer_timeout` (60 s per operation, covering
`kubectl exec` itself), `exec_failed`, `no_expected_identity` (nothing is invoked), `operation_cap`. Once a binding is fatal every later operation is
refused without invoking anything (`stopped`). With `--stop-on-receipt-failure` the runner stops at once: the case is written to `started-aborted/` with
every receipt and its rejected write attempts, the model is not called again, and later cases never start (exit 3).

**Not fatal:** `quota_exhausted`, or a sampler-internal timeout with a valid terminal receipt: they limit that operation's completed scope.

**Registered deadlines and caps** (`remote_evidence`): 25 s for the whole sampler invocation, 60 s outer per operation, 600 s harness wall per target
(`--max-wall-s`), 2 h for all of Stage R, $10 in total (`--max-total-cost-usd`, the remainder per target). The exec target is configurable
(`fixture.exec_target`, registration `exec.target`; default `deploy/<deployment>`).

## 4. The Stage R driver (item 5)

`scripts/stage_r_driver.py --registration G0A.json --out DIR [--commit-repo DIR] [--no-pod-health]`. One process, serial, owning every stop. The
registration (`stage-r-1`) holds every case-specific value; the script holds none:

```json
{"registration": "stage-r-1",
 "exec": {"namespace": "...", "deployment": "...", "container": "app", "target": "deploy/..."},
 "discovery": {"mount_path_regex": "...", "series_prefix": "...", "season_dirs": {"<key>": "<regex>"}},
 "targets": [{"key": "...", "role": "offender|verified|held", "file_id": 0, "bytes": 0, "season": "<key>",
              "basename": "<recorded>" , "case_template": "cases/<key>.json"},
             {"key": "...", "role": "verified", "bytes": 0, "season": "<key>", "marker": "<name marker>", "case_template": "..."}],
 "harness_args": ["--adapter", "claude", "--model", "claude-opus-5-5", "--prompt", "v7", "--evidence-format", "v3.1-format", "--guards", "v3"],
 "early_stop_roles": ["offender"],
 "limits": {"target_wall_s": 600, "stage_wall_s": 7200, "total_cost_usd": 10.0, "g2_operations": 6}}
```

`harness_args` may not set what the driver owns (suite, cases, out, scratch, split, evidence mode, tools behaviour, the stop option, the caps), nor any
prefix of those flags (argparse accepts an unambiguous prefix).

1. **G0b.** A read-only `kubectl get deploy`: exactly one volume mount of the exec container matches `mount_path_regex`, else stop. Then four `list`
   calls: the mount with the series prefix (exactly one directory), the series directory (each season regex matches exactly one directory), and each
   season directory. Every listing must be complete, else stop before any media read. A target's locator is the one listed regular file matching its
   recorded basename and bytes, or (with `marker`) its bytes and the marker in its name, recorded as `discovered`; no unique match drops it. The manifest
   (`g0b-manifest.json`) is written, and committed with `--commit-repo`, before any media byte is read; a commit failure stops. The filled cases go
   through the leak guard. With pod health on, the pod UID, the container's restartCount and readiness are recorded.
2. **G1.** Per target: `stat` (it must match the manifest bytes and the listed mtime_ns, else the target is dropped; it sets the identity) and `probe`
   bound to it. If no target of an `early_stop_roles` role has a text subtitle stream, the driver stops with exit 4 and no model call.
3. **G2.** Per target: the pod check, the case filled with its locator, `expected_identity`, `expected_hostname`, `max_operations` and the G1 probe as
   the FIRST case evidence (so `subtitle_sample` takes its stream from it; a filled case that would select another stream than the G1 probe names stops
   Stage R), the leak guard again, then one harness run (`--tools-behavior v3-remote-1 --stop-on-receipt-failure --max-wall-s 600
   --max-total-cost-usd <remainder>`). A run that did not record the case normally stops Stage R. WRITE-CONTROL stops it after that case.
4. **Final check.** A `stat` bound to the G1 identity; any difference in size, mtime_ns, head or tail hash marks the target INVALID, which stops.

Each operation needs the 60 s outer deadline to fit inside the 2 h Stage R deadline, and each target 600 s plus two operations. Exit: 0 every phase ran, 3 a
stop, 4 the early stop, 2 a bad registration. `stage-r-state.json` (rewritten after every operation) holds every argv and receipt, the phases, the pod
readings, each target's identity, probe, run directory, write attempts, final fingerprint and outcome, and the stop.

## 5. The report (section 4.3)

`scripts/stage_r_report.py --state OUT/stage-r-state.json --adjudication ADJ.json [--out r.json] [--md r.md]`. The adjudication is the reviewer's
input: `{"verdicts": [{"target", "cue", "verdict": "accepted|rejected|ambiguous"}]}`; a verdict for an undelivered cue or an unknown target is refused.
Per target: the execution (R, F, H, STOP, INVALID, DROPPED; a target never started after a stop is STOP), proposal safety over every raw write attempt
(validator rejections, every reply that parses as a write decision, the restored original and the final decision; WRITE-CONTROL on any non-offender),
collection (CUE, ERR, NOCUE), and for R the diagnosis from the restored (pre-guard) decision by the first matching row (`stage_r.diagnose`), else the
role's default. Only cited cue ids count as citing a cue; a cited result id is listed (`cited_results_with_cues`) but is not a cue. An ambiguous cue gives
LIMIT. A cited cue without a verdict leaves the diagnosis pending. Stage R is INCOMPLETE when any target is not R (or adjudication is pending), ACCEPTED only
with every target R, no WRITE-CONTROL, no FAIL and every offender PASS, else NOT_ACCEPTED; failures and limits are always listed.

## 6. Known limits

- Prompt v7 does not describe `subtitle_sample`; its argument form is in the capability advertisement. A model may cite the whole result (`t3`) instead of
  a cue (`t3.f2`); the report does not count that as citing a cue.
- `mrh-sampler-2` has run only locally in tests, with fake ffprobe and ffmpeg; its ffmpeg argv equals `mrh-sampler-1`'s except the subtitle `-t`. It has
  not run in a pod or on real media.
- A fault in the middle of an operation is detected at that operation's end (plan section 4.4). The driver's pod-health check is a read-only `kubectl get
  pods` by deployment selector, and it requires the pod name to equal the sampler's hostname.
- The G1 probe is case evidence (provenance `recorded` in the typed view), although Stage R observed it.
