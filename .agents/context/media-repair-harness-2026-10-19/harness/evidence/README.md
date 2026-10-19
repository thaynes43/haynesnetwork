# Live bounded evidence collectors (OpenProject #138)

Read-only collectors that run the real `ffprobe` / `ffmpeg` / `tesseract` (when present) or stdlib zip and XML code on one input
and return honest records: what was verified, what was **not**, which bounds applied, and why anything failed. Stdlib Python only
(3.11 and 3.14 exercised). **Not wired into `tools.py` or `run.py`**; `to_tool_result` shows how a record maps onto the harness'
tool-result shape so the wiring story can do it later.

```python
import sys; sys.path.insert(0, '<harness dir>')
from evidence import collect, to_tool_result
records = collect('/path/to/file.mkv', ['probe', 'decode', 'frames', 'audio'], {'segments': 2})     # one record per kind, in order
records = collect('/path/to/book/', ['audiobook'])                                                  # folder of parts, or a list of part files
records = collect('/path/to/b.epub', ['epub'])
tool_result = to_tool_result(records[0], cap=8192)       # {status, output (JSON text, bounded), truncated, mode, wall_s, tool, evidence_status}
```

`collect(path, kinds=None, bounds=None, *, runner=None, which=None, replay=None, scratch_dir=None)` never raises for a bad input or a
crashed collector (that becomes an `error` record); it raises `ValueError` only for programmer errors (unknown kind, unknown or ill-typed bound).
`runner` and `which` are injection points for tests.

## Kinds

| kind | harness tool it would back | what it does |
|---|---|---|
| `probe` | `ffprobe` | one `ffprobe` (`-show_format -show_streams -show_chapters`, probesize 5 MB): container, duration, streams, language and title tags, chapters |
| `decode` | `decode_sample` | head, tail and N spread segments (default 3 interior, 4 s each) decoded to the null muxer with `-progress`; counts decoder error lines, flags segments that decode far less than their window (seek past a truncated end). Whole-file decode only with `full_decode: true` and under `full_max_bytes` (64 MiB) / `full_timeout_s` (60 s); otherwise refused or cut and reported `partial` |
| `frames` | `frame_sample` + `ocr` | PNG frames at spread offsets (head to tail), size and hash, identical-frame check; OCR with `tesseract` when on PATH (a reading, not ground truth), else said not to be read. Pictures are never kept |
| `audio` | `audio_sample` | per segment and audio stream: `volumedetect` mean and max level, `silencedetect` runs (default below -50 dB for 0.5 s or more), near-silent and no-audio states, stream language and title tags, missing-language finding |
| `epub` | `epub_inspect` | zip open, member CRC pass, `mimetype`, `container.xml`, OPF parse, title, creator, language, identifier, manifest members present, spine idrefs, every spine XHTML parsed as XML |
| `audiobook` | `audiobook_inspect` | per part: ffprobe chapters and duration, chapter gaps/overlaps/duplicates/empty titles, sampled audio decode; across parts: tag consistency (album, artist, album_artist, composer, genre, date) and track numbering |

## Record

```
tool, harness_tool, tool_version, mode (live|replay), status (ok|partial|unavailable|error|timeout),
coverage {verified: [...], not_verified: [...]}, bounds {the values used}, bounds_clamped (only if a request was cut to a hard maximum),
stderr (scrubbed, capped excerpt), elapsed_s, output {structured findings}, reason, cause (error only), input (partial fingerprint)
```

* **status** describes the collection: `ok` = it ran to the end of its plan (findings such as decoder errors, `valid: false` or tag mismatches are in `output.findings`, not hidden in the status);
  `partial` = some part of the plan did not run or finish (cap, deadline, timeout, missing optional binary, unknown duration, a frame produced with errors, an audiobook part that could not be read), and `coverage.not_verified` and `reason` say which;
  `timeout` = nothing finished inside its timeout; `unavailable` = a required binary is missing (`reason` names it, nothing was run, `coverage.verified` is empty);
  `error` = it could not do its job. `cause` separates **`input`** (the file is damaged or unreadable: ffprobe exits non-zero, not a zip, a CRC failure, the OPF or a manifest member is broken; the suite's recorded
  stages `zip_open`, `zip_crc`, `opf_parse`, `manifest`) from **`tool`** (a binary could not start, output cap hit, JSON unparsable, collector crashed).
* Nothing is called healthy. A clean sample says so in `not_verified` ("a clean sample does not prove whole-file health"); `ok` on `decode` with `clean: true` means the sampled windows were clean and nothing more.
* **mode** is `live` for anything run now. `replay` is only produced from a recording passed as `replay=` (records list, `{kind: record}` dict, or a JSON file with `{"records": [...]}`): the recorded record is served with `mode: "replay"`,
  `recorded_from`, and is refused (`unavailable`) when the input's size and head/tail hashes differ from the recording's `input`. Kinds absent from the recording run live.
* `input` is a **partial** fingerprint only (size, SHA-256 of the first and last MiB). The whole file is never hashed or read except where a collector decodes it.
* Paths never appear in output: the input path and base name are replaced by `<input>` in stderr excerpts and errors (`output` carries only the base names the parts of an audiobook have, in `files[].name`).
* `to_tool_result` puts status, reason, cause, replay_note, bounds_clamped, coverage and stderr first and `output` last; when the text exceeds the cap it is `output` that is cut (a string ending in `...[output truncated]`), so the object stays valid JSON.
* `to_tool_result`: `unavailable` becomes tool-result status `error` with `evidence_status: "unavailable"` beside it, because the harness' `ToolResult` knows `ok|partial|error|timeout` only. The wiring story should either add `unavailable`
  to `ToolResult` or keep that mapping.

## Bounds and safety

Defaults and hard maxima are in `core.BOUND_SPEC` (a request above the hard maximum is cut and listed in `bounds_clamped`; an unknown bound name raises). Main ones: `timeout_s` 20 per subprocess (max 60), `deadline_s` 120 per collector
(a subprocess timeout never exceeds the time left), `segments` 3, `segment_s` 4, `max_segments` 10, `frames` 3, `max_stdout_bytes` 4 MiB, `max_frame_bytes` 8 MiB (one PNG), `max_stderr_bytes` 64 KiB, `stderr_excerpt_bytes` 1500, `max_files` 50 parts,
`epub_max_members` 5000, `epub_max_uncompressed_bytes` 128 MiB, `epub_max_member_bytes` 8 MiB, `epub_max_opf_bytes` 2 MiB (container.xml and the OPF are read whole), `epub_max_xhtml_docs` 200.

* argv lists only, no shell; every child runs at `nice 19` with `-threads 1` and `OMP_THREAD_LIMIT=1` (tesseract), in its own process group (killed on timeout), stdin closed, stdout and stderr in temp files capped with `RLIMIT_FSIZE`, core dumps off.
  A child killed by the file-size cap (SIGXFSZ, restored to its default in the child) is reported as the collector's own cap (`cause: tool`, segment/frame state `output_cap`), never as a damaged file.
* Every ffmpeg/ffprobe call gets `-protocol_whitelist file,pipe` and `-i <absolute path>`: the input path is made absolute in `collect()` (subprocesses run in the scratch dir), so a name starting with `-` or `concat:` cannot be read as an option or a protocol.
  Limit: `file` stays allowed, so a playlist-style input that names other local files can still make ffmpeg open them.
* Inputs are opened read-only (ffmpeg/ffprobe read them; the zip is opened for reading). Every output goes to the `-f null` muxer or to a temp dir (PNG frames) that is deleted when `collect` returns; frames are deleted as soon as they are read.
* Serial only: no parallel subprocesses. Heavy runs (generation, decoding real media) belong in a CPU-limited Job, not the dev-env pod; this pod has no ffmpeg.
* EPUB: the zip is streamed through CRC checking inside the byte cap, a member that inflates past its declared size is a `zip_crc` failure, documents with `<!ENTITY` declarations are not parsed (reported), nothing is extracted.

## Limits (read before relying on a record)

* Sampling finds damage only where it samples. In the live smoke a byte-flipped clip was caught in 2 of 4 sampled windows while `ffprobe` of the same file was clean; a damaged region between samples would be missed.
  Full decode is capped, and covers the first video and first audio stream only.
* `frames` OCR needs `tesseract`; it is **not installed** in the Bazarr image used for the smoke or in this pod, so the live records show `ocr: unavailable`. The OCR path is covered by fake-runner tests only.
* `audio` reports levels and silence, not speech; the language tag is read, never checked against what is said.
* ffprobe's `probesize` bound (5 MB) means stream changes later in a large file are not seen by `probe`.
* Seeking uses input `-ss` (keyframe-accurate enough for sampling); on a truncated file whose header still declares the full duration, late windows decode little or nothing and are flagged `short`, or the decoder reports `File ended prematurely`.
* `audiobook` cross-part checks use only the parts ffprobe could read; unreadable parts are listed in `findings` and the track-number check is then marked not run (`tag_consistency.track_note`).
* No Ollama, scoring, suite or held-out data is involved; the collectors know nothing about cases.

## Files

| file | role |
|---|---|
| `__init__.py` | `collect`, `load_replay`, re-exports |
| `core.py` | bounds, subprocess runner, `Ctx`, record builder, `to_tool_result`, replay |
| `avtools.py` | probe, decode, frames, audio, audiobook collectors |
| `epubtool.py` | EPUB collector |
| `test_evidence.py` | 100 unit tests (the last class is the regression set for the independent review of PR 1010): fake runner for every collector (ok, partial, timeout, missing binary, corrupt input), real zips for EPUB, real subprocess runner with tiny python children |
| `live_smoke.py`, `launch_smoke.py` | the live smoke: generate synthetic fixtures and collect inside a CPU-limited Job, then fetch the records and delete the Job |
| `testdata/live-smoke/` | records from that run, labelled live, with `RUN.json` (image digest, ffmpeg/ffprobe/python versions, fixture hashes) and `SUMMARY.md` |

Tests: `nice -n 19 python3 -m unittest discover -s <harness dir> -p 'test_*.py'` (this folder is a package, so the existing command finds them), or
`python3 -m unittest discover -s <harness dir>/evidence -t <harness dir> -p 'test_*.py'` for these alone.

Live smoke: `python3 launch_smoke.py --out testdata/live-smoke` (default image `ghcr.io/home-operations/bazarr:1.6.2`: python3 and ffmpeg 8.1.2, no tesseract; cpu limit 1, refuses above 2; the package travels in the Job spec as a base64 tarball,
the Job is deleted at the end). The Job pod runs as non-root with the restricted pod security profile the `dev` namespace enforces.
