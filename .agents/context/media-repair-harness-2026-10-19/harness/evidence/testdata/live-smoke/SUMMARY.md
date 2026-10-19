# Live smoke records

LIVE: collected by the real ffprobe/ffmpeg inside a CPU-limited batch Job on synthetic fixtures; not replay, not real library media.

Image `ghcr.io/home-operations/bazarr:1.6.2` (`ghcr.io/home-operations/bazarr@sha256:17dc1cff22e99694ffbfb06555526cb47a66b362b4d6c982f06b557f7caae2bb`), ffmpeg/ffprobe: ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers. Python 3.14.7. Tesseract: not installed in the Job image.
Job limits: cpu 1, memory 1Gi, ephemeral 2Gi; the Job was deleted after the records were read. Fixtures are generated inside the Job and are not committed (names, sizes and sha256 are in `RUN.json`).

| fixture | tool | status | cause | mode | what the record says |
|---|---|---|---|---|---|
| `book-bad/` | audiobook | ok |  | live | part3.m4b: ffprobe error (ffprobe exited 1: the container could not be read); tags differ or are missing across parts |
| `book/` | audiobook | ok |  | live |  |
| `broken-manifest.epub` | epub | error | input | live | manifest: manifest names 1 member(s) that are not in the archive: ['OEBPS/ch2.xhtml'] |
| `broken-xhtml.epub` | epub | ok |  | live | 1 spine document(s) are not well-formed XML (first: OEBPS/ch1.xhtml) |
| `corrupt.mkv` | probe | ok |  | live |  |
| `corrupt.mkv` | decode | ok |  | live | 2 of 4 sampled segments produced decoder errors |
| `corrupt.mkv` | frames | ok |  | live |  |
| `corrupt.mkv` | audio | ok |  | live |  |
| `good.epub` | epub | ok |  | live |  |
| `good.mkv` | probe | ok |  | live |  |
| `good.mkv` | decode | ok |  | live |  |
| `good.mkv` | frames | ok |  | live |  |
| `good.mkv` | audio | ok |  | live |  |
| `good.mkv#ffmpeg-hidden-from-PATH` | decode | unavailable |  | live | ffmpeg not found on PATH |
| `good.mkv#ffmpeg-hidden-from-PATH` | frames | unavailable |  | live | ffmpeg not found on PATH |
| `good.mkv#ffmpeg-hidden-from-PATH` | audio | unavailable |  | live | ffmpeg not found on PATH |
| `good.mkv#ffprobe-hidden-from-PATH` | probe | unavailable |  | live | ffprobe not found on PATH |
| `good.mkv#ffprobe-hidden-from-PATH` | decode | partial |  | live | duration unknown (ffprobe not found on PATH): only the head was sampled |
| `good.mkv#full-decode` | decode | ok |  | live |  |
| `good.mkv#full-decode-over-byte-cap` | decode | partial |  | live | full decode requested but refused: file is 183096 bytes, over the full_max_bytes cap of 1024 |
| `truncated.epub` | epub | error | input | live | zip_open: BadZipFile: File is not a zip file |
| `truncated.mkv` | probe | ok |  | live |  |
| `truncated.mkv` | decode | ok |  | live | 3 of 4 sampled segments produced decoder errors |
| `truncated.mkv` | frames | partial |  | live | frame at 6.023s: no_frame; frame at 11.546s: no_frame |
| `truncated.mkv` | audio | ok |  | live | audio stream 1: 1 of 4 segments not normal (no_audio) |
| `truncated.mkv#full-decode` | decode | ok |  | live | 3 of 4 sampled segments produced decoder errors; full decode produced 1 error line(s) |
