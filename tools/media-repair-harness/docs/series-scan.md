# Read-only series scan (#213)

`scripts/series_scan.py` turns every video file of one TV series folder on the media share into a truth-free harness case, runs the existing runner over the
cases with the local model, and aggregates a findings report. It is a driver: it adds no model, tool or scorer. It reuses the Stage R machinery
(`remote_evidence.run_operation` with the `mrh-sampler-2` receipts, the Stage R driver's listing check, fingerprint check and probe evidence) unchanged.

## Rules

- **Read-only.** The only cluster call is `kubectl -n <ns> exec -i deploy/<name> -c <container> -- python3 - <mode> ...` with the sampler modes `list`, `stat`
  and `probe` (discovery) and, in the run, the runner's own remote tools (`probe`, `decode`, `frame`, `audio`, `subtitle`). Every operation is bound to
  the file's identity (`size`, `mtime_ns`, `dev`, `ino`), to one allowed root and to one pod hostname, and fails closed on a missing or malformed receipt, an
  identity or host change, a path outside the root or an outer timeout. Nothing writes to media, the catalog, an *arr, Plex or the cluster.
- **Sidecar subtitles** (`.srt`, `.ass` next to a video) are recorded by name and never opened. (`subtitle_sample` reads a subtitle *stream inside* the video.)
- **Private directory.** Discovery, the suite, the run records and the report hold real library paths and titles. Use a directory outside git, for example
  `~/media-scan-213/`. The script refuses an `--out` inside a git work tree. Commit nothing from it except `summary.json` (counts only, no path, no title).
- **Truth-free cases.** Every case has `split: "scan"`, `truth: null` and `supported_actions: []`. `media_repair_harness.scan_suite.validate_scan_case`
  accepts that only for `split == "scan"`. The evaluator-owned `suite.py` and `score.py` are unchanged and do not accept it; `mrh-score` (installed entry point `scan_suite.score_main`) refuses a scan
  suite or a scan run directory with a clear message; the scorer would otherwise fail on `truth: null`. A scan is reported, never scored.
- **The model never sees the real file name.** The runner's leak guard treats a remote fixture's basename as a forbidden token, so the case carries the parsed
  `expected {series, season, episode, episode_title}` and no `context.filename`; tool output that names the file is rewritten to `input.<ext>`.

## Steps

All four steps take the same private directory (`PRIV`). Placeholders below are the pilot's.

```bash
cd tools/media-repair-harness
PRIV=~/media-scan-213

# 1. discover: list the season folder, verify each file (stat) and probe it (ffprobe), bind the hostname. Needs kubectl exec into the media pod.
python3 scripts/series_scan.py discover --target media/bazarr/app --root /data/haynestower \
    --series-dir "/data/haynestower/Media/TV Shows/Pokémon" --season 1 --out $PRIV

# 2. build: offline. One case per file in $PRIV/suite/{cases,manifest.json}.
python3 scripts/series_scan.py build --discovery $PRIV/discovery.json --out $PRIV

# 3. run: prints the runner command (and checks the options offline). Add --execute to run it; --limit N for a first small batch.
python3 scripts/series_scan.py run --suite $PRIV/suite --out $PRIV/run --limit 3
python3 scripts/series_scan.py run --suite $PRIV/suite --out $PRIV/run --execute

# 4. report: $PRIV/report.md (private) and $PRIV/summary.json (counts only).
python3 scripts/series_scan.py report --run $PRIV/run --discovery $PRIV/discovery.json --out $PRIV/report.md
```

### discover

Lists the series folder, picks the season folder(s) (`Season N`; `--season N` selects one, otherwise every season folder plus loose files), lists each, and
for every `.mkv .mp4 .avi .m4v` entry runs `stat` (its start identity must equal the listing's, else the file is skipped and recorded) and `probe` bound to
that identity (`--no-probe` skips it; then `subtitle_sample` has no stream to use). Writes `discovery.json` (per file: path, size, mtime_ns, dev, ino, head
and tail fingerprints, the probe evidence, sidecar names) and `discovery-receipts.json` (every receipt). A listing is `complete` only below the sampler's
`LIST_CAP` of 500 entries per directory: a truncated listing, a missing or malformed receipt, a changed hostname or any other fail-closed operation stops
discovery with exit 3, writes `discovery-failed.json` and no `discovery.json`. A file that changes between the listing and its stat is skipped and listed
under `skipped`. Time bound: `--max-wall-s` (default 3600 s); each file costs two `kubectl exec` calls (about 2 to 10 s), so 82 files take well under
30 minutes.

### build

`discovery.json` to `suite/cases/<id>.json` plus `suite/manifest.json`. Deterministic: the same discovery gives byte-identical files (sorted paths, sorted
keys). Case id: `scan-sSSeEEE-<first 8 hex of sha256(path)>` (`scan-unparsed-<hex>` for a name that does not parse). The name is parsed as
`<Series> (<year>) - SxxEyy[-Ezz] - <Title>.<ext>`; an unparsable name gets null `expected` fields and a note. `context.arr` is `{}` with the note "No Sonarr
data is available for this file." The tools offered are the remote-capable ones: `ffprobe`, `decode_sample`, `frame_sample`, `audio_sample`,
`subtitle_sample`. The probe is the case's first evidence (`e1`), as in Stage R. Every case passes the leak guard before anything is written. Refuses a
non-empty `suite/`.

### run

Prints the command (always runs the runner's own option checks first, offline, with the adapter stubbed, as `devtl1_config.py` does):

```
python3 -m media_repair_harness.run --adapter ollama --model qwen3.8:27b --num-ctx 16384 --context-policy ctx16k-v1 --gpu-fit-check full-gpu-v2
  --keep-alive 10m --prompt v7 --evidence-format v3.1-format --guards v3 --evidence replay --tools-behavior v3-remote-1 --tool-output-bytes 8192
  --no-spend-limit --max-wall-s <cap> --split scan --suite SUITE --cases <ids> --out RUN/batch-NNN --scratch RUN/scratch/batch-NNN
```

`--tools-behavior v3-remote-1` needs `--evidence-format v3.1-format` and `--evidence replay`; it works with the ollama adapter. `--stop-on-receipt-failure`
is off by default: a fail-closed remote operation fails that tool call (cause tool, listed in the report) and the scan goes on; add the flag to stop the
whole batch at the first one.

**Resume.** The runner refuses a non-empty `--out`, so each invocation is a new batch directory `RUN/batch-NNN` over the cases that have no record yet in any
batch (`--cases`). Run the same command again after an abort, a wall cap or a crash and it continues with the remaining cases. A record that carries an
`error` (harness crash, adapter error) counts as done unless `--retry-errors` is given; the report uses the latest batch's record for a case.

**Time bound.** The wall cap is `900 s + 240 s * pending cases` (`--base-wall-s`, `--per-case-wall-s` or `--max-wall-s` override it); 82 cases give 20,580 s
(5.7 h) as a ceiling, not an estimate. The runner stops cleanly at the cap (exit 3), keeps the records written, and the next `run` resumes. Each remote
operation is bounded at 25 s in the sampler and 60 s outside, and six tool calls per case. One model on the GPU, one case at a time. Use `--limit 3` first.

### report

Reads one or more run directories (a `RUN` root of `batch-NNN` directories, or single runner out dirs) and `discovery.json`. `report.md` (private): totals by
class and action, tool call statuses, every non-healthy finding with its reason, every tool failure (fail-closed kind and an excerpt), missing cases, and a
per-file table (season, episode, class, action, confidence, tools called with statuses, failed tools, forced, repairs, wall seconds). `summary.json` holds
counts only (no path, no title, no case id) and is safe to commit.

## Tests

`tests/test_series_scan.py` (serial, in `scripts/ci-test.sh`): discovery against the real sampler on a synthetic library (including a truncated listing, a
missing receipt, a changed hostname and a file changed after its listing), name parsing, deterministic build, the scan-case validator, the scorer refusal,
the run command and its offline option check, resume, a scripted run of built cases through the real runner, and report aggregation from fake records. All
paths are made up; nothing contacts a cluster, Ollama or the network.
