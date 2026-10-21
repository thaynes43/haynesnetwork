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
| Driver `stage-r-driver-2`, registration `stage-r-1` | `scripts/stage_r_driver.py` | the coordinator, after approval |
| Report `stage-r-report-1` | `scripts/stage_r_report.py`, `stage_r.py` | offline |

Unchanged: `remote_sampler.py` (`mrh-sampler-1`, the PR #1000 copy) is byte-identical and is still what every earlier tools behaviour sends;
`protocol.TOOLS`, `tools.REGISTRY`, every prompt, every schema, the config of every earlier option set, and every recorded run. A run without the new
options has no `remote_evidence` record field, no receipts and the same config hash as before. Tests: `tests/test_remote_evidence.py`
(`LegacyIdentity`), and the existing replay-identity and recorded-config tests.

A run with the option records, in its config, `tools_behavior: v3-remote-1` and `remote_evidence` (the sampler sha256 and every bound below), and
`stop_on_receipt_failure: true` when set. Each case record gets `remote_evidence` (expected identity, bound hostname and its source, operation count, every
receipt with its argv and outcome, the fatal state, the subtitle stream, `delivered_cue_ids` and `write_attempts`); each tool call carries `receipts` (record
only, never in a model-bound message).

The typed layer reads a `subtitle_sample` observation as cue findings, and the leak guard treats cue text as media text, ONLY inside a v3-remote-1 run
(`remote_evidence.enabled()`, set by `run.run_case`; the offline `mrh-guard` is a pinned input of recorded measurements and is not changed, so it reads
such a record's subtitle observations with the legacy reading: call it inside `remote_evidence.enabled()` to reproduce the online one). Everywhere else a case whose evidence names
`subtitle_sample` is read exactly as on the base (an unknown record, checked by the legacy guard, and named "its subject" when it settled nothing: the
subtitle wording of that sentence is gated too; `tests/test_remote_evidence.Round3` compares the model-visible messages with the base byte for byte).
`--tools-behavior` is refused with the experimental `--claude-schema` mode (#1035), whose guard re-runs a case with a fixed argument set. The #161
options of `run_case` (`tools_behavior`, `stop_on_receipt_failure`, `remote_state`, `remote_time_left`) are keyword-only, and every call is bound to
`_run_case`'s signature before the schema-mode refusal, so no positional form can carry them past it.

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
| `exit_code`, `error`, `stderr` | the tool's exit (int), `timeout` (the sampler's own 25 s), or `error` (the sampler could not run the operation, bad arguments included) |
| `stdout_bytes`, `bytes_read`, `quota_exhausted`, `requests` | what it wrote, what it read, the 8 MiB quota flag |
| `wall_seconds`, `timed_out` | its own wall and timeout state |
| `source_unchanged` | the OPENED file's end identity equals its start identity and the path still names it (file modes) |
| `identity` | `expected` (from `--expect-size`, `--expect-mtime-ns`, `--expect-dev`, `--expect-ino`), `start`, `end` (each `{size, mtime_ns, dev, ino}` of the opened descriptor), `start_ok`, `end_ok`, `same_file` (the path still names the opened file); a start mismatch reads nothing |
| `confined` | with `--root`: the path is absolute, normalised, symlink-free in every component and under the real root |
| `argv` | the ffmpeg/ffprobe argv (`-protocol_whitelist http,tcp`: the loopback range server only) |
| `listing` | `list` only: `directory`, `prefix`, `complete`, `matching`, `scanned`, `cap` |

The source is opened ONCE (`O_NOFOLLOW`; a listing's directory with `O_DIRECTORY | O_NOFOLLOW` and listed from that descriptor) and every byte, the
fingerprint and every range read, comes from that descriptor; the path is never reopened. Confinement has two halves: the pre-check before the open (the
path absolute, normalised, symlink-free and under the real root) and the descriptor check after it (the kernel's name of the OPENED object,
`/proc/self/fd/N`, must be exactly the requested path). A swap between the two (a component replaced by a symlink) makes the names differ. When that name
cannot be read (no `/proc`), confinement cannot be verified and the operation is refused (`confined: false`, nothing read): it is never skipped.
`confined` is true only after the descriptor check. Every receipt field is required on every exit kind, typed (booleans are booleans; identities and
counts are integers compared as integers, so a huge JSON integer is out of range and never converted to a float; wall time finite and at most the
sampler's 25 s plus 5) and consistent with itself (a completed operation carries no error; a stat reads at most 2 MiB and a listing none; bytes read
by ffmpeg need a range request) (`source_unchanged` exactly when start equals end and `same_file`; the
`start_ok` / `end_ok` verdicts agree with the identities; the quota flag only with the quota read) and with what was received (`stdout_bytes`). Any exception while reading or validating a receipt is a fatal `malformed_receipt` (or
`missing_receipt`), never an ordinary tool error.

**One 25 s budget per invocation:** the start identity stat, the operation and the end identity stat share one deadline, and the operation stops 2 s
early so the end check still fits; a sampler-internal timeout therefore always ends with its receipt well inside the 60 s outer deadline (`mrh-sampler-1`
gave each step its own 25 s). New modes: `stat` now runs under that limit (`mrh-sampler-1`'s did not); `list <dir> [--prefix p]` scans the whole directory, counts only entries
matching the prefix toward the cap of 500, returns name, type, size and mtime_ns, opens no file, and is `complete` only when fewer than 500 entries matched
and the scan finished in time.

**Fatal** (`remote_evidence.FATAL_KINDS`; the result is an execution failure, cause `tool`, and its output is never used):
`exec_failed` (a non-zero exec exit, even with a receipt line, or an exec that raised), `missing_receipt`, `malformed_receipt` (above),
`identity_mismatch` (expected, start and end must all equal the bound identity and the path must still name the opened file; an operation that read
something without a verified end is one too), `source_changed`, `not_confined`, `hostname_changed` (the run's host is the case's `expected_hostname`,
else the first receipt's), `outer_timeout` (60 s per operation, covering `kubectl exec` itself), and, with nothing invoked, `no_expected_identity`,
`no_allowed_root`, `operation_cap` and `target_deadline` (an operation starts only if its 60 s outer deadline fits the time left of `--max-wall-s`). Once a binding is fatal every later operation is
refused without invoking anything (`stopped`). With `--stop-on-receipt-failure` the runner stops at once: the case is written to `started-aborted/` with
every receipt and its rejected write attempts, the model is not called again, and later cases never start (exit 3).

**Not fatal:** `quota_exhausted`, or a sampler-internal timeout with a valid terminal receipt: they limit that operation's completed scope.

**Registered deadlines and caps** (`remote_evidence`): 25 s for the whole sampler invocation, 60 s outer per operation, 600 s harness wall per target
(`--max-wall-s`), 2 h for all of Stage R, $10 in total (`--max-total-cost-usd`, the remainder per target). The exec target is configurable
(`fixture.exec_target`, registration `exec.target`; default `deploy/<deployment>`).

## 4. The Stage R driver (item 5)

`scripts/stage_r_driver.py --registration G0A.json --out DIR --commit-repo DIR`. One process, serial, owning every stop; an unexpected error is a recorded
`driver_error` stop, and the terminal state (`exit_code`) is always written. The registration (`stage-r-1`) holds every case-specific value; the script
holds none. It is validated before anything starts: the roster by role that registration `stage-r-1` requires (exactly two offenders, three verified and
one held target: pilot plan section 4.1, the six files, and section 4.3, all six ending R with both offenders PASS; only role counts are in code, never a
target name, id, size or episode), safe target keys and case ids (one path component), `early_stop_roles` required (section 4.2.4), limits
finite, positive and at most the registered ceilings, rules that compile, templates without `inject_tool_failure`, case templates that stay under the
registration's directory (no symlink out), and the G0a configuration of section 4.2: `--guards v3` exactly once in `harness_args` (as C7) and every case's
`tools_available` exactly ffprobe, decode_sample, subtitle_sample and arr_lookup (no frame or OCR tool). The state records `registration_sha256` and the
sha256 of every case template file (`case_templates_sha256`); the report checks both:

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

1. **G0b.** A read-only `kubectl get deploy`: exactly one volume mount of the exec container FULLY matches `mount_path_regex`, else stop. The pod baseline
   is validated at once (exactly one pod, ready, a restart count) and its name must be the hostname the first receipt binds. Then four `list` calls: the
   mount with the series prefix (exactly one directory), the series directory (each season rule fully matches exactly one directory), and each season
   directory. Every listing must be complete and consistent (the directory and prefix asked for, equal counts in the receipt and the body, `scanned` at least
   `matching`, every entry `{name, type, size, mtime_ns, dev, ino}` with a safe name inside the prefix: no `/`, NUL, control character, `.` or `..`, valid
   UTF-8), else stop before any media read. A target's locator is the one listed regular file matching its recorded basename and bytes, or (with `marker`)
   its bytes and the marker in its name, recorded as `discovered`; no unique match drops it. The manifest (`g0b-manifest.json`) is written and COMMITTED
   (mandatory; the hook must confirm a commit holding exactly the manifest's bytes) before any media byte is read; anything else stops. The filled cases go
   through the leak guard.
2. **G1.** Per target, between two pod checks: `stat` (its start identity must equal the listing's size, mtime_ns, device and inode and the manifest bytes,
   else the target is dropped; its fingerprint must be well formed and agree with the receipt, else stop; it sets the identity) and `probe` bound to it. If
   no target of an `early_stop_roles` role has a text subtitle stream, the driver stops with exit 4 and no model call.
3. **G2.** Per target: the pod check, the case filled with its locator, `expected_identity`, `expected_hostname`, `max_operations` and the G1 probe as
   the FIRST case evidence (so `subtitle_sample` takes its stream from it; a filled case that would select another stream than the G1 probe names stops
   Stage R), the leak guard again, then one harness run (`--tools-behavior v3-remote-1 --stop-on-receipt-failure --max-wall-s 600
   --max-total-cost-usd <remainder>`). A run that did not record the case normally, or whose record holds a fatal operation, stops Stage R. WRITE-CONTROL
   (any raw write attempt on a non-offender, whatever its validity) stops it when that case returns, BEFORE its final stat: section 4.4 ("Stage R stops
   after that case") read with section 3.5 ("after any fatal path the driver starts no further operation"), so nothing is invoked after the offending case
   and the target is STOP (WRITE-CONTROL). A pod check follows each target.
4. **Final check.** A `stat` bound to the G1 identity; a malformed fingerprint stops; any difference in size, mtime_ns, device, inode, head or tail hash
   marks the target INVALID, which stops. A stop that a later check raises against a recorded target (a pod restart after it) marks that target STOP.

Each operation needs the 60 s outer deadline to fit inside the 2 h Stage R deadline, and each target 600 s plus two operations. Exit: 0 every phase ran, 3 a
stop, 4 the early stop, 2 a bad registration. `stage-r-state.json` (rewritten after every operation) holds every argv and receipt, the phases, the pod
readings, each target's identity, probe, run directory, write attempts, final fingerprint and outcome, and the stop.

## 5. The report (section 4.3)

`scripts/stage_r_report.py --state OUT/stage-r-state.json --registration G0A.json --adjudication ADJ.json [--out r.json] [--md r.md]`. The registration
must be the one the driver ran (its canonical sha256), and a state without a terminal exit code is refused. The adjudication is the reviewer's input:
`{"verdicts": [{"target", "cue", "verdict": "accepted|rejected|ambiguous"}]}`; a verdict for an undelivered cue or an unknown target is refused. Per target:
the execution (R, F, H, STOP, INVALID, DROPPED; a target never started after a stop is STOP), proposal safety over every raw write attempt, ONCE per model
reply, whatever its validity (strict, fenced or prose JSON, or an `"action": "<write>"` pair; the validator's rejections and the restored and final decisions
mark the same reply), each with its own audit (that proposal against the evidence shown before its turn, or its schema failure), WRITE-CONTROL on any
non-offender; collection (CUE, ERR, NOCUE) over the cues that actually reached the model (`delivered_cues`, defined below); and for R the diagnosis from the restored (pre-guard) decision by the first matching row (`stage_r.diagnose`), else
the role's default. Only delivered cue ids count as citing a cue. A cited cue without a verdict leaves the diagnosis pending only where the matching row
depends on it (an unconditional row applies). Stage R is ACCEPTED only when the driver ended with exit 0, no stop and nothing skipped, the results match the
complete registration (every registered target with its role, nothing else), every target is R, there is no WRITE-CONTROL and no FAIL, and every registered
offender PASSes; a driver stop or failure, a missing target, a non-R target or a pending adjudication is INCOMPLETE; anything else NOT_ACCEPTED.

### Raw write attempts: rule `write-intent-5`

Every model reply is read with these two rules, and each attempt records its evidence (`evidence`: the structural reading, or each matched stem with its
position and an excerpt), so a reviewer sees exactly why it counted.

**Rule A, a schema-valid reply: structure only.** This applies when the whole reply strictly parses as one JSON value AND is a schema-valid protocol
decision (decision-v3, or the v2 decision shape) or tool call.
* It is read structurally only: no string is ever scanned as text.
* The parse keeps every duplicate key.
* An action-like key counts when it binds a write action as:
  * a string whose first one to three words (split on whitespace, `/`, `,`, `+`, `-`, `_`), canonicalised, name one;
  * any element of a list;
  * an object whose `name`, `type` or `action` field names one.
* This holds at any depth.

An **action-like key** (`is_action_key`) is an identifier whose components (split at `_`, `-`, `.`, spaces and camel-case humps, trailing digits
removed) include `action`, `actions`, `operation` or `operations`. A **write action** is compared with separators and case stripped (`canonical_action`).

**Rule B, any other reply: stem anywhere.** This covers a reply that does not parse, or that parses but is not a schema-valid decision or tool call: a
prose string, a bare object, a decision with one schema error, or a duplicated key.
* The reply counts as a write attempt when a write-action stem appears anywhere in its text as a word start. There is no key, no window and no negation
  guard.
* **Stems** (`write_stems()`, derived from `protocol.WRITE_ACTIONS` and nowhere else): the first word of each write action, with a final `e` dropped, so
  `renam`, `remap`, `convert` and `blocklist`.
  * They match case-insensitively at a word start (no letter before the stem, or a camel-case hump: `doRename`).
  * An optional separator is allowed between letters (`block list`, `re-name`).
  * Every inflection shares the stem: `rename`, `renamed`, `renaming`, `remapped`, `converted`, `blocklisted`.
* **Span exclusion, by decoding, never by fence syntax:**
  * Every JSON object span is found with `json.JSONDecoder().raw_decode` at each `{` (at most 256 positions, each span at most 65,536 characters, duplicate
    keys kept).
  * A span that decodes AND is a schema-valid decision or tool call is read with rule A and left out of the scan; the text around it is scanned. This
    covers any fence (```` ```json ````, ```` ``` json ````, `~~~`, four backticks), CRLF and no fence alike.
  * A span that decodes but is not schema-valid stays in the scan and is ALSO read with rule A.

**The trade-off, stated plainly.**
* Rule B is complete for any write proposal that names its action, in any wording, list, table, heading or layout.
* It also counts negated or incidental mentions in a reply that is not a valid decision: "I would not rename it", `transaction: convert`, a JSON string of
  prose.
* On a verified or held target that is WRITE-CONTROL, and Stage R ends INCOMPLETE. It fails safe, never as a pass, and the recorded excerpt shows the
  reviewer the mention.
* A schema-valid decision or tool call is never scanned, so its `reason` or `why` may mention any action.

**Bounded property tests** (`tests/test_remote_evidence.Round4`, seeded, serial, under a second):
* **6,266 generated writes, all counted.** They span 19 key and value syntaxes (three put the write far from or without its key: a heading gap, a numbered list after the key, a long key) × the four write actions in eight casings and separators × 14 wrappers:
  none, fences of five kinds, prose before or after, a numbered list, a heading, a table, nested bullets, a long prefix and CRLF.
* **3,001 schema-valid parsed replies, none counted.** These are decisions and tool calls whose prose fields mention keys and write actions in seven
  syntaxes.

### Delivered cues

A cue is delivered when a finding object of kind `subtitle_cue` carrying its id was inside a user message the model was sent in a call that COMPLETED
(the adapter returned a reply; a failed call delivers nothing), after the leak guard passed it. Delivery is read from the structure of the harness's own
messages (each parsed as the JSON envelope it is: the first page, a tool result or a fetched page), never by searching their text: media text is always a
string value and cannot form such an object, so cue text that looks like an id is never delivery. The record keeps, per delivered cue, `text_seen` (exactly
the finding text the model saw, clipped where the typed layer clipped it) and `clipped`; the report gives the adjudicator that text, never more.

## 6. Known limits

- Prompt v7 does not describe `subtitle_sample`; its argument form is in the capability advertisement. A model may cite the whole result (`t3`) instead of
  a cue (`t3.f2`); the report does not count that as citing a cue.
- `mrh-sampler-2` has run only locally in tests, with fake ffprobe and ffmpeg; its ffmpeg argv equals `mrh-sampler-1`'s except the subtitle `-t` and
  `-protocol_whitelist http,tcp`, which is unverified against a real ffmpeg. It has not run in a pod or on real media. The `/proc/self/fd` confinement
  check needs Linux `/proc`; without it every operation is refused (fail closed).
- A fault in the middle of an operation is detected at that operation's end (plan section 4.4). The driver's pod-health check is a read-only `kubectl get
  pods` by deployment selector, and it requires the pod name to equal the sampler's hostname.
- The G1 probe is case evidence (provenance `recorded` in the typed view), although Stage R observed it.

## 7. The wiring smoke bundle

`smoke/launch_wiring_smoke.py` ships the package to a Job in one manifest annotation (ceiling 240000 bytes). After the rebase onto dev-c8 the bundle reached
245212 bytes (main alone: 239508). The bundle now carries its Python files without `#` comments (`strip_comments`): only COMMENT tokens are removed,
on the tokenizer's own physical lines (`io.StringIO(...).readlines()`, never `str.splitlines()`, which also splits at U+2028 inside a string), every line
kept, a PEP 263 encoding cookie and a shebang kept. The bundler checks every module before it ships (`check_stripped`): an identical AST, identical string
tokens, the same encoding declaration and line count; any difference aborts the build. 213028 bytes. The code that runs is unchanged.
