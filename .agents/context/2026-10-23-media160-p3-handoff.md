# #160 / PR #1039 P3 correction handoff — 2026-10-23

P3 corrected the final-head review findings on the existing PR branch only. Source was
not installed, deployed, or merged. This pass made zero media reads and zero operations.

## Corrections

- M1: the trusted adapter accepts `argv: null` only for genuine `stat` receipts; every
  other file mode still requires a string argv list.
- M2: fake runner receipts now use a real newline and retain matching original stdout;
  a same-runner positive control passes and refusal assertions name their terminal cause.
- M3: synthetic identity mismatch proves zero source bytes with `start_ok: false` and
  adapter refusal; repeated default-quota reads exceed 8 MiB of requested input and
  stop exactly at 8,388,608 bytes with exhaustion recorded.
- L1/L2/N1: the root guard checks actual NUL/newline characters before runner use,
  invalid quota types/values refuse before runner use, and identity fields use exact
  signed/unsigned 64-bit maxima (with signed mtime preserved).

## Evidence

`PYTHONPATH=../src nice -n 19 python3 -m unittest -v test_remote_sampler_v3_quota.py`
passed 10 tests. P3 still requires final independent exact-head review and the
coordinator's CI/merge/read-back workflow. P2 remains closed FIX-NEEDED in its original
history; P3 did not resume, reset, or extend it.
