# Evidence format v2, guards v3 and the audit bug fixes (W18)

Owner: OpenProject story [#144](https://work.haynesnetwork.com/work_packages/144) (epic #48). Source: the Astra audit of the dev-c4 evidence and instructions (#143, sections 2 and 3, items P0) and
its review. Everything here is **opt-in**: with the new options unset, every request, run record and scorer-read field is what `origin/main` 7abf11fb produced
(`tests/testdata/legacy-e2e-golden.json`, the replay-identity golden and the prompt and schema digests). `HARNESS_VERSION` stays `dev-c4`; the candidate version bump belongs to the W19 freeze.

## Options and the versions they select

| Option | Selects | Valid with |
|---|---|---|
| `--evidence-format v2` | evidence format v2 (typed layer, capabilities, pagination), **tools behaviour v2** (bugs a, d, e), **audit v2** (bug b) | prompt `v4` (and a future `v5`); guards off or `--guards v3` |
| `--guards v3` | G-healthy v3 (bug c); G-write as in v2 | any prompt, with or without the format |

Anything else that uses a new option is refused up front with an explicit message (`run.check_option_combination`): `--evidence-format v2` with prompt v1, v2 or v3, and with `--guards v1` or `v2`. Unknown values are refused by the parser.
The manifest `config` (and so `config_hash`) gains `evidence_format`, `tools_behavior`, `audit_version`, `page_contract` and `wire_bytes` only when the format is on, and `guards: "v3"` when guards v3 is on; an unset run keeps the earlier config shape.
The run record gains `evidence_format{version, page_contract, wire_bytes, tools_behavior, audit_version, capabilities, messages[], final_summary}` and `action_audit.audit_version` only for a v2 run, and
`tool_calls[].raw_output` (the uncut redacted text the typed layer was derived from) when the format is v2 or guards are v3. `run_summary.json` gains `evidence_format`.

## The five audit bugs, each fixed under a version (the earlier behaviour stays under the earlier version)

| Bug | Earlier behaviour (kept for v1) | Fixed behaviour |
|---|---|---|
| a. `decode_sample(full=true)` | local and remote fallback ran a 4 s window and called it full | **tools v2**: local runs a real full decode of the first video and first audio stream inside the existing 25 s limit (`window_s: "full"`, `completed_to_eof`); at the limit it returns status `partial` with the window that actually ran, `completed_to_eof: false` and `request_unmet`. Remote cannot (8 MiB, 25 s): status `partial`, the 4 s window, `request_unmet`. A replay without a recorded full decode is `unavailable`, not a crash. No limit is raised |
| b. `audit.compute` `full_decode_ok` | true when a full-argument call returned `ok` | **audit v2**: true only on affirmative completion evidence -- an exit-0 full decode whose decoded span reaches the KNOWN container duration (a tool's own `completed_to_eof: true` is a claim that is checked against the span; an unknown duration or span leaves completion unknown) -- a clean result, no unmet request and a **recorded stream scope**; absent proof is not met, with the reason in `detail`. A result is a full decode only when it says so (`window_s: "full"`); a request for one proves nothing |
| c. G-healthy | presence of any `ok` integrity result | **guards v3**: all shown evidence and tool results are examined, read through the SAME text the model saw (the bounded `output` in the legacy format, never `raw_output`); a known integrity defect contradicts healthy even next to clean results (order independent); an `ok` result that reports a defect is not clean; unknown fields are neither clean nor damaged; an EPUB collector's `valid:false` vetoes healthy; no clean integrity result still abstains. The reason names the finding, its kind and location and the observation id; the model's decision stays in `guard.applied[].original`. A guard can only turn a decision into `insufficient_evidence` / `escalate` and never infers whole-file health from a clean sample |
| d. `live_tool` truncation flag | the collector's flag was dropped | **tools v2**: kept (`truncated: true`, `collector_truncated`) |
| e. sampled coverage | overlapping windows were added up (`sampled_fraction` 1.5 on an 8 s file) | **tools v2**: the union of the windows, clipped to the duration; `decoded_s_total_windows` keeps the sum |

## What the model sees under `--evidence-format v2`

The typed layer (`evidence_v2.py`) is a deterministic function of **model-visible observations only**: an `Observation` is `{id, tool, args, status, output, backend, source, collector_truncated}` and the
case context the model already sees. The case object is never passed in, so no truth, accepted class, supported action, solvability, family, correction, provenance, outcome step, injection flag or
fixture path can reach the output; the harness-side `injected` backend marker is dropped, so no backend is shown for such a result. Args echoed back are limited to known numeric/boolean options and a frame handle (`run.safe_args`).

First message: `case_id, media_type, context, tools_available, tool_call_budget, capabilities, evidence_format, evidence`. `evidence` = `{alerts, [page], items, facts, coverage, client_comparison}`.
Tool reply: the same envelope keys as before (`type, id, tool, status, truncated, output, tool_calls_remaining`); `output` is a nested object, not JSON in a string.

* **Per result**: `execution` (`state` ran / failed / timed_out / unavailable, the raw `status`, `cause` input / tool / unknown for failures, `completion` complete / partial / none, `output_truncated`, `reason`);
  `findings` (`kind`, `known_defect`, `location`, raw-excerpt `detail`, `src`); `scope` (requested against completed: window, offsets, `to_end_of_file`, streams, stages, intervals); `unresolved`; `conflicts` (a status `ok` with a defect, exit 0 with decoder errors, a request not honored, a decoded span shorter than the container duration, two different container durations); `facts` (compact parse, units in the key names: `_s`, `_bytes`, `_bps`, `_hz`, `_px`).
  `ok` never implies a clean file; a collection failure never implies a defect; a non-zero exit alone and any unrecognised error text stay `known_defect: false`. Recognised damage wording is a small general libav / package list (`DAMAGE_RX`), not a case list.
* **Alerts** come first: conflicts, then known defects, then execution failures, one short entry each naming the id of its detail. They are repeated on every page and never dropped to fit.
* **Coverage matrix** (`coverage`): container; time intervals per stream (the union of the windows that name the stream, damaged overriding clean in an overlap, clipped to the known duration, `unknown` when the duration or the stream selection is not recorded); the stream list with a decode state; chapters (`clean`, `damaged`, `partly_checked`, `not_checked`); EPUB package stages in the inspector's order. It describes checks performed, never a diagnosis or a "representative enough" verdict. It is recomputed from the observations shown so far and appears in a reply only when it changed.
* **Client comparison** (`client_comparison`): only when the case **states** a client (`context.client_profile` or `context.expected.client_profile`; a structured profile or the prose forms, e.g. "h264, 8-bit yuv420p, up to 1080p"). Each selected stream field (container, codec, bit depth, pixel format, resolution, audio codec, channels, layout) is `supported` / `unsupported` / `unknown`; the stream selection is stated (`recorded`, `only_stream_of_type`, `ambiguous`; an ambiguous or unrecorded selection cannot support an overall claim); profile fields that are not read are listed. No client is inferred and incompatibility is not damage.
* **Capabilities** (`capabilities`, per offered tool): backend (`replay`, `pinned_replay`, `local`, `remote`, `live`, `stub`), availability before the call, recorded offsets, window length, and whether a full decode exists (`recorded`, `not_recorded`, `bounded run`, `not_possible`). It reads which offsets exist and never a recorded result.
* **Pagination (`pages-v1`)**: every message is at most 8192 UTF-8 bytes (the first message's `evidence` block, and each tool reply as a whole, budget notice included). A page is the repeated header (identity, alerts, execution) plus whole units in priority order, never a structure cut in the middle; a split list says `"<field>_shown": "n of N"`; a unit too large for any page is replaced by a marker in `page.oversize`; long strings are cut with `...[+N chars not shown]`. `page` = `{contract, source, n, of, next, next_costs_tool_call, elsewhere, conflicts_total}`. `next` is an opaque stable cursor that embeds the case alias (another case's cursor does not resolve); fetching it is a tool call `{"tool": "<an offered tool>", "args": {"cursor": "..."}}` that **uses one of the 6 calls** (recorded as `tool: "page"`, `continuation: true`, never an observation for the guards). A case that offers no tool cannot page: the first page says so (`page.retrieval`) and keeps the counts and alerts. `truncated` in the envelope means the tool or collector cut its own output; pagination is not truncation.
* A decision may cite a finding id (`t2.f1`); the record credits its observation (`t2`) and stores the decision as written.

## Limits and deferrals

* Not in W18: the identity comparison table and the ordering / edition table (audit P1), richer content inspection (EPUB body, audiobook speech), prompt v5 (it must define the new fields and pagination and keep the schema contract) and every model run. They belong to W19 / dev-c5.
* The replay recordings state no stream selection for a decode window, so decode intervals of replay data sit in the `unrecorded` row, per-stream decode states are `unknown`, and `full_decode_ok` (audit v2) is not met for them. Filling that gap needs new recordings.
* Prose client profiles are read by a fixed grammar (video and audio codec lists, `N-bit`, pixel format, `up to Np`, `up to N channels`); anything it does not read is listed under `not_compared`, not guessed. Profile and HDR fields are not compared.
* The container duration is taken from the first `ok` probe-type result; the decoded-span check uses a single one-second allowance (`EOF_TOLERANCE_S`) for container rounding and unequal stream lengths.
* Guards v3 on an old record (`mrh-guard --guards v3`) reads the stored `output`, which the legacy format cut at 8 KiB; a cut that breaks the JSON is `unknown`, never clean or damaged.
* The coverage and client sections repeat in a reply when they change, which costs context on small local models; the size is bounded by the 8 KiB envelope, and a reply that does not fit pages them.
* Excluded volatile record fields in the compatibility golden: `started_at`, every `wall` / `wall_s` / `elapsed_s`, `harness_git_sha`; a live collector's clock is fixed in the golden so `elapsed_s` is stable.

## Tests

`tests/test_evidence_v2_core.py` (typed findings, coverage matrix, client comparison, metamorphic pairs, guards v3, audit v2, robustness) and `tests/test_evidence_v2_run.py` (legacy compatibility against the origin/main golden, option
combinations, the tool bug fixes, capabilities, the runner integration over the replay, local, remote and live branches, rendering, pagination, leakage and looking-ahead sentinels on complete requests, the public dev suites, a regression golden).
Expected values are written by hand from synthetic observations; the public-suite checks verify traceability to the recorded observations and explicit unknowns; `tests/testdata/evidence-v2-golden.json` pins renderings as a regression check only.

## Review fixes (PR #1023, Astra 3 and the independent review)

* **Unknown stays unknown.** A defect is only a positive, recognised observation (libav damage wording in `DAMAGE_RX`, a package stage failure, a collector's `cause: input`); other decoder or probe text is `decoder_messages_unclassified` / `probe_messages` with `known_defect: false`, an `unclassified` interval, and integrity `unknown`. Clean needs a positive observation: an `ok` probe needs a parsed container and streams (an empty `{}` is unknown); a decode needs exit 0, a present blank stderr and frames, a decoded span or bytes read. A run that failed, timed out or never ran certifies nothing clean. A plain-text integrity output is kept as `facts.raw`; only explicit damage wording in it is a defect (the harness's own cut markers are removed first).
* **Live book collectors.** The real EPUB schema (`valid`, `stages_passed`, `stage`/`error`, `dc_*`, `findings[{severity, what}]`) and audiobook schema (`files[]` with format, tags, streams, chapters, per-part decode windows, probe state, `tag_consistency`) are normalised; facts are kept, recognised damage is a defect, `valid:false` vetoes healthy, decode windows are per part (`coverage.parts`), not on one timeline.
* **Guards and capabilities read only what is shown.** `raw_output` is kept for format v2 only (its typed pages carry the whole text); the legacy format with guards v3 reads the shown, bounded text. The capability advertisement is built from operation metadata (which recordings, offsets, ranges and keys exist), never from an uncalled result; `ocr` lists `recorded_reading_ranges_s`, which discloses where a reading is recorded, not what it says.
* **Client grammar.** Prose is read only when every word is recognised (codec names, `N-bit`, a pixel format, `up to Np`, `up to N channels`, `or`/`and`); `only`, `no`, `not`, `except` and any other word make the clause unread (listed in `not_compared`, nothing compared). `video_profiles` / `audio_profiles` (structured) compare the codec profile. `summary.complete` is true only when every stated field was compared with a known verdict, the selection is unambiguous, the container was compared and no statement went unread; it never means the file will play.
* **One reference resolver** (`run.make_resolver`): an observation id, or a finding / conflict id that was actually emitted (`t1.f1`), resolves to its observation; `t1.nonexistent` stays a bad reference. The guards and the record use it; the decision is stored as written.
* **Pagination keeps everything retrievable.** A long string keeps its first 400 characters and a pointer (`...[+N chars: detail <id>]`); the whole text is a `details` unit on a later page. Large structures are split into units of at most 2400 bytes, never dropped. The first message is budgeted as a whole (context and capabilities included); every stored page is sized against the worst-case fetch envelope (longest offered tool name, the sixth call, the budget notice). `page` carries `alerts_total` and `conflicts_total` (the true conflict count). `--tool-output-bytes` is the page budget under format v2 (2048 to 8192, recorded as `wire_bytes`).
* **Chapter coverage is per stream** (`by_stream`); there is no combined chapter label.
* The wiring-smoke bundle is gzip (no lzma dependency in the Job image), capped at 240000 bytes in total because client-side `kubectl apply` stores the manifest in an annotation limited to 262144 bytes.

## Second fix pass (Astra 4 and the re-review of 5a576d70)

* **Damage wording only in diagnostics.** `damage_wording()` is applied to decoder / probe stderr, an inspector's error message and a collector's error lines, never to titles, tags, chapter names, paths or the harness's own notes. File names and paths inside a diagnostic are removed first and a negated mention ("no corrupt frames found") is not damage. Unparsed (cut) JSON contributes only the values of its diagnostic keys (`stderr`, `error`, ...); plain text is the tool's own message. A permission or other execution error that mentions `corrupt.mkv` is an execution failure (`cause: tool`). Generic words (`truncated`, `end of file`, `damaged`, `corrupt` alone) are no longer in the list.
* **Live full decode** uses the same affirmative check as every backend: a decoded span that reaches the known duration (the collector's own, or another shown result's); a shorter span is `decoded_span_shorter_than_duration`, an unknown span or duration leaves completion unknown.
* **Client grammar is structural.** A bit depth or pixel format belongs to the codec it follows and is applied to that codec; one that precedes every codec ("8-bit hevc"), a second `up to` limit or any unknown word makes the clause unread, so a recognised token is always used in a comparison or the clause is not read.
* **One resolver everywhere**: `evidence_v2.reference_resolver` is used by the runner, `decision_guard.apply` (online and offline), `apply_to_record` and `--restore`; the offline path recomputes the emitted finding ids from the record's own observations, uses audit v2 and raw evidence for v2 records.
* **Pagination**: list elements keep their index (`_i`) when an element is split; unit, chunk and string limits scale with the page budget (`Limits`); a message that cannot fit (an oversized context, or a unit that cannot fit a page) raises `PageBudgetError`, which the runner records as a harness error, so nothing is ever sent over the limit; the `elsewhere` counts are grouped by section so the page object stays small; under tools v2 the live collector is cut at the raw cap, not at the page budget.
* **Raw diagnostics** are all kept in `facts.diagnostics` (one entry per collector message, classified or not); a timeout keeps the windows its output shows (it certifies nothing as a whole); an EPUB `valid:false` veto is a `collector_verdict` alert (`known_defect: false`, `vetoes: healthy`), distinct from a `defect`.

## Third fix pass (Astra 5 and the re-review of 4328e342)

* **Damage recognition is a positive allow-list** (`DAMAGE_ALLOW_LIST`), replacing the negation heuristic. A diagnostic LINE (decoder / probe stderr, an inspector's error, a collector's error line; cut JSON contributes only the values of its `stderr` / `error` keys) is damage only if, after its decoration is stripped (`[name @ 0x...]`, `pipe:N:`, `in#N`, `<input>:`, a file path, an exception type, an ffmpeg wrapper such as `Error while decoding stream #0:0:`), it STARTS with one of the fixed messages below. Each line is classified on its own, so a permission line, a title or a note can never erase a damage line elsewhere. Anything unmatched is `unclassified`: kept in `facts.diagnostics`, integrity unknown. There is no negation logic and no bare-word matching ("corrupt frames: 0" and "pipe:0: Invalid data found" both come out right by construction). Sources are the library message texts (and the public dev replay data); no phrasing is invented.

| Pattern (anchored at the start of the message) | Source |
|---|---|
| `moov atom not found` | libavformat/mov.c; public dev replay |
| `Invalid data found when processing input` | AVERROR_INVALIDDATA (libavutil/error.c); public dev replay |
| `EBML header parsing failed` | libavformat/matroskadec.c; public dev replay |
| `(?:stream \d+, offset 0x[0-9a-fA-F]+: )?partial file` | libavformat/mov.c |
| `Element at 0x[0-9a-fA-F]+ ending at 0x[0-9a-fA-F]+ exceeds containing master element ending at 0x[0-9a-fA-F]+` | libavformat/matroskadec.c; public dev replay |
| `File ended prematurely(?: at pos\. \d+ \(0x[0-9a-fA-F]+\))?` | libavformat/matroskadec.c; public dev replay |
| `Failed to find two consecutive MPEG audio frames` | libavformat/mp3dec.c; public dev replay |
| `error reading header` | libavformat/mov.c |
| `Could not find codec parameters for stream \d+` | libavformat/demux.c |
| `error while decoding MB \d+ \d+, bytestream -?\d+` | libavcodec/h264_slice.c |
| `cabac decode of qscale diff failed at \d+ \d+` | libavcodec/h264_cabac.c; public dev replay |
| `corrupted macroblock \d+ \d+ \(total_coeff=-?\d+\)` | libavcodec/h264_cavlc.c |
| `concealing \d+ DC, \d+ AC, \d+ MV errors in [IPBS] frame` | libavcodec/error_resilience.c |
| `ac-tex damaged at \d+ \d+` | libavcodec/mpeg12dec.c, mpeg4videodec.c |
| `Invalid NAL unit size \(\d+ > \d+\)` | libavcodec/h2645_parse.c |
| `Error splitting the input into NAL units` | libavcodec/h2645_parse.c |
| `non-existing PPS \d+ referenced` | libavcodec/h264_slice.c |
| `missing picture in access unit with size \d+` | libavcodec/h264dec.c |
| `corrupt decoded frame in stream \d+` | fftools/ffmpeg.c |
| `corrupt input packet in stream \d+` | fftools/ffmpeg.c |
| `Packet corrupt \(stream = \d+, dts = \S+\)` | libavformat/mpegts.c |
| `Bad CRC-32 for file .+` | Python zipfile.BadZipFile |
| `CRC mismatch in member .+` | this harness: tools._epub_stage (zipfile.testzip) |
| `File is not a zip file` | Python zipfile.BadZipFile |
| `Truncated (?:central directory\|file header)` | Python zipfile.BadZipFile |
| `Bad (?:offset for central directory\|magic number for (?:central directory\|file header))` | Python zipfile.BadZipFile |
| `Corrupt (?:zip64 )?extra field.*` | Python zipfile.BadZipFile |
| `Corrupt zip64 end of central directory (?:locator\|record)` | Python zipfile.BadZipFile |
| `Zip64 end of central directory record not found` | Python zipfile.BadZipFile |
| `Overlapped entries: .+ \(possible zip bomb\)` | Python zipfile.BadZipFile |
| `not well-formed \(invalid token\): line \d+, column \d+` | expat via xml.etree.ElementTree.ParseError; public dev replay |
| `no element found: line \d+, column \d+` | expat via ParseError |
| `(?:mismatched tag\|unclosed token\|junk after document element\|syntax error\|unclosed CDATA section): line \d+, column \d+` | expat via ParseError |
| `manifest names \d+ member\(s\) that are not in the archive` | this harness: evidence/epubtool.py |
| `container\.xml names .+, which is not in the archive` | this harness: evidence/epubtool.py |

Execution errors have their own anchored patterns, also per line (a tool failure, `cause: tool`, never damage):

* `Permission denied`
* `No such file or directory`
* `Operation not permitted`
* `Input/output error`
* `Cannot allocate memory`
* `Read-only file system`
* `Too many open files`
* `Connection (?:refused|reset by peer)`
* `Resource temporarily unavailable`
* `Is a directory`
* `Not a directory`

* **Live probe stderr** (and each audiobook part's `probe_stderr`, and the record-level excerpt) goes through the same matcher: an `ok` probe with `File ended prematurely` on stderr is damaged, with other text unknown, never clean; every line is kept in `facts.diagnostics` with its class.
* **Pagination no longer crashes on a splittable unit.** When the alerts alone would not fit they are shortened in two steps (one short string each, then grouped by type and kind with the first ids, the full id lists retrievable as `alert_ids` units); a unit that does not fit the space left is divided further (an element of a list keeps its `_i` index); `elsewhere` is grouped by section (`details`, `alert_ids` are one key each); with no tool offered the `retrieval` sentence is counted in the budget. Only an indivisible unit, or a header that cannot fit in its shortest form, raises `PageBudgetError`.
* **Accepted minimum budget: `MIN_WIRE_BYTES` = 2560.** Over both public dev suites (first message and default replies of every case) `PageBudgetError` counts are: 2048 bytes: 32 runs (11 + 5 cases); 2304: 6 runs (2 + 1 cases); 2560, 2816, 3072, 4096, 8192: 0. The runner refuses `--tool-output-bytes` below 2560 (and above 8192) under format v2.
* **Client restrictions after `up to`** are consumed: a depth or pixel format after the limit belongs to the codec before it and is compared ("hevc up to 1080p, 8-bit" against a 10-bit file is unsupported).
* **Timeout wording** separates the windows the call observed from the unfinished remainder.
