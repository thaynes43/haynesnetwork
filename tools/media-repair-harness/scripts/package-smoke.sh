#!/usr/bin/env bash
# Out-of-tree package smoke: build + install the package into a fresh venv OUTSIDE the checkout, then from a directory outside the checkout
# import it, check its resources load, run the runner --help and one scripted-adapter case on a synthetic testdata case.
# Nothing here reads the repo tree at run time except the testdata case copied into the scratch dir; no model, ffmpeg, network (after install) or media.
#
#   tools/media-repair-harness/scripts/package-smoke.sh            # pip builds in an isolated env (needs PyPI for setuptools)
#   MRH_SMOKE_NO_ISOLATION=1 tools/.../package-smoke.sh            # offline: the venv needs setuptools>=70 or the `wheel` package already (the stock python3-venv has neither)
#   MRH_SMOKE_DIR=/some/dir tools/.../package-smoke.sh              # scratch location (must be outside the checkout); default mktemp
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENT="$(dirname "$HERE")"
SCRATCH="${MRH_SMOKE_DIR:-$(mktemp -d)}"
case "$(cd "$SCRATCH" && pwd -P)/" in
  "$(cd "$COMPONENT/../.." && pwd -P)/"*) echo "package-smoke: scratch dir must be outside the checkout" >&2; exit 2;;
esac
trap '[ -n "${MRH_SMOKE_KEEP:-}" ] || rm -rf "$SCRATCH"' EXIT

# 1. a clean copy of exactly what a wheel is built from (keeps build/ and egg-info out of the checkout)
mkdir -p "$SCRATCH/pkgsrc" "$SCRATCH/run"
cp "$COMPONENT/pyproject.toml" "$COMPONENT/README.md" "$SCRATCH/pkgsrc/"
cp -r "$COMPONENT/src" "$SCRATCH/pkgsrc/src"
find "$SCRATCH/pkgsrc" -name __pycache__ -type d -prune -exec rm -rf {} +

# 2. fresh venv, non-editable install
python3 -m venv "$SCRATCH/venv"
PIPFLAGS=()
[ -z "${MRH_SMOKE_NO_ISOLATION:-}" ] || PIPFLAGS=(--no-build-isolation)
nice -n 19 "$SCRATCH/venv/bin/pip" install --quiet --disable-pip-version-check "${PIPFLAGS[@]}" "$SCRATCH/pkgsrc"

# 3. run from a directory that is not the checkout, with no PYTHONPATH
cp -r "$COMPONENT/tests/testdata/cases" "$COMPONENT/tests/testdata/fixtures" "$SCRATCH/run/"
cat >"$SCRATCH/run/script.json" <<'JSON'
[{"type": "tool_call", "tool": "epub_inspect", "args": {}, "why": "package smoke"},
 {"type": "decision", "class": "healthy", "action": "none", "target": null, "confidence": 0.9, "evidence_refs": [], "reason": "package smoke"}]
JSON
cd "$SCRATCH/run"
unset PYTHONPATH
PY="$SCRATCH/venv/bin/python"

"$SCRATCH/venv/bin/mrh-run" --help >/dev/null
"$SCRATCH/venv/bin/mrh-guard" --help >/dev/null
"$SCRATCH/venv/bin/mrh-score" --help >/dev/null 2>&1 || true   # needs the evaluator's score.py (MRH_SCORE_PY); --help alone must not be required

nice -n 19 "$PY" - <<PY
import hashlib, importlib.resources as res, pathlib, sys
import media_repair_harness as m
from media_repair_harness import protocol as P, replay_identity as RI, tools, vendored_epub
where = pathlib.Path(m.__file__).resolve()
assert 'site-packages' in where.parts, where              # installed copy, not a source tree
assert '$COMPONENT' not in str(where)
assert P.HARNESS_VERSION == 'dev-c4'
assert P.get_prompt('v2')['sha256'] == '351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a'
assert P.get_prompt('v1')['sha256'] == '30749f5dc7065a2ddd70967cd6888e91d237030e1b025bc6dac19ca51fed9ee8'
assert hashlib.sha256(res.files('media_repair_harness').joinpath('prompts/v2.txt').read_bytes()).hexdigest() == 'b63a9e9b5558a1f1fbb94fcdd8624d1c3e46f8990a3af2d2a00c0a480521ec04'
assert hashlib.sha256(res.files('media_repair_harness').joinpath('prompts/v3.txt').read_bytes()).hexdigest() == '6e53ac6e0964e6f427569ab1f4ef6e0b679f6877ec84af8cf7199d5cc4019d1e'
assert tools.REMOTE_SAMPLER.is_file() and tools._epub_module() is vendored_epub
print('resources ok:', where.parent)
PY

SMOKE_SHA="$(git -C "$COMPONENT" rev-parse HEAD 2>/dev/null || echo smoke-sha-unavailable)"
export MRH_HARNESS_GIT_SHA="$SMOKE_SHA"
nice -n 19 "$SCRATCH/venv/bin/mrh-run" --suite "$SCRATCH/run" --adapter scripted --model scripted-1 --prompt v2 --script "$SCRATCH/run/script.json" \
  --cases td-epub-healthy-001 --out "$SCRATCH/run/out" --scratch "$SCRATCH/run/scratch" >"$SCRATCH/run/run.log" 2>&1 || { cat "$SCRATCH/run/run.log"; exit 1; }
nice -n 19 "$PY" - <<PY
import json, pathlib
rec = json.loads(pathlib.Path('out/td-epub-healthy-001.json').read_text())
call = rec['tool_calls'][0]
assert call['tool'] == 'epub_inspect' and call['status'] == 'ok', call   # the vendored epub module ran against the fixture
assert rec['decision']['class'] == 'healthy' and rec['decision']['action'] == 'none' and not rec['forced'], rec['decision']
assert rec['harness_version'] == 'dev-c4', rec['harness_version']
assert rec['harness_git_sha'] == '$SMOKE_SHA', rec['harness_git_sha']   # no git tree beside the installed copy: the sha comes from MRH_HARNESS_GIT_SHA
man = json.loads(pathlib.Path('out/manifest.json').read_text())
print('scripted case ok; harness_git_sha recorded as:', man['harness_git']['sha'])
PY
echo "package-smoke: PASS"
