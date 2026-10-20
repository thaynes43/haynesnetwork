#!/usr/bin/env bash
# Deterministic harness tests: serial unittest discovery under nice -n 19, non-zero exit on any failure, prints the test count.
# Run from the repo root (any directory works; the script locates itself).  This is the entry point CI calls; keep its path and name.
#
#   tools/media-repair-harness/scripts/ci-test.sh
#
# MRH_REQUIRE_SUITE=1 (CI sets it) makes a missing public dev suite or evaluator score.py a FAILURE instead of a skip.
# No ffmpeg, no network, no model, no Ollama: fixtures are tiny synthetic files and fake runners.  Serial on purpose (CPU budget).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENT="$(dirname "$HERE")"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
export PYTHONPATH="$COMPONENT/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
set +e
nice -n 19 python3 -m unittest discover -s "$COMPONENT/tests" -t "$COMPONENT/tests" -p 'test_*.py' >"$LOG" 2>&1
STATUS=$?
set -e
tail -n 40 "$LOG"
COUNT="$(sed -n 's/^Ran \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$LOG" | tail -n 1)"
if [ -z "$COUNT" ]; then
  echo "ci-test: unittest did not report a test count (import error or crash); failing" >&2
  exit 1
fi
if [ "$COUNT" -eq 0 ]; then
  echo "ci-test: zero tests ran; failing" >&2
  exit 1
fi
echo "ci-test: $COUNT tests, unittest exit status $STATUS"
exit "$STATUS"
