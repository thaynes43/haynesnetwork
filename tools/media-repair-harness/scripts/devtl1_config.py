#!/usr/bin/env python3
"""dev-tl1 (OpenProject #208): rebuild the pre-registered `config_hash` of every registered command offline.

The registered commands (`runs/dev-tl1/PREREGISTRATION.md` section 3, `runs/dev-tl1/manifest-template.json`) are parsed and run through the runner's own
`main()` with every adapter's `preflight` and `finish` replaced by a stub that raises `AbortRun` before anything is contacted.  `main()` therefore applies
its real option checks (`check_option_combination`, `check_handover_options`, the adapter and context-policy refusals), builds the adapter and the config
and writes `manifest.json` with the `config_hash`; no model, Ollama, llama-server, kubectl, GPU or network is touched.  A combination the runner refuses
raises here with the runner's own message.

    python3 scripts/devtl1_config.py            # print every registered run: id, argv tail, config_hash
    python3 scripts/devtl1_config.py --check    # exit 1 unless every hash equals runs/dev-tl1/manifest-template.json

Stdlib only; reads no held-out material (the suite is the public dev suite).
"""
import argparse
import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))

from media_repair_harness import adapters as A      # noqa: E402
from media_repair_harness import llamacpp_adapter as LA  # noqa: E402
from media_repair_harness import run as R           # noqa: E402

REPO_ROOT = COMPONENT.parents[1]
SUITE = REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
TEMPLATE = COMPONENT / 'runs' / 'dev-tl1' / 'manifest-template.json'

QWEN_DIGEST = 'aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813'
MAX_WALL_S = '3600'

# what every registered command shares: dev-c7's C7 configuration (prompt v7, format v3.1-format, guards v3, replay, page budget 8192, uncapped label) and the wall cap
COMMON = ['--split', 'dev', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3', '--evidence', 'replay', '--tool-output-bytes', '8192',
          '--no-spend-limit', '--max-wall-s', MAX_WALL_S]
QWEN = ['--adapter', 'ollama', '--model', 'qwen3.8:27b', '--num-ctx', '16384', '--context-policy', 'ctx16k-v1', '--gpu-fit-check', 'full-gpu-v2',
        '--keep-alive', '2m', '--require-digest', QWEN_DIGEST]
MUSE = ['--adapter', 'llamacpp', '--model', 'muse-glimmer-30b']
MUSTASK = ['--evidence-handover', 'askable']

TESTDATA = COMPONENT / 'tests' / 'testdata'      # the repository's own test data (cases/ and fixtures/): the smoke's suite
SMOKE_ID = 'devtl1-smoke-muse-glimmer-30b'
SMOKE_CASE = 'td-epub-healthy-001'
# the live smoke: the muse must-ask options on one tiny testdata case, with its own run id and a 300 s wall cap; it is not a measured run
SMOKE = MUSE + ['--cases', SMOKE_CASE] + [x if x != MAX_WALL_S else '300' for x in COMMON[2:]] + MUSTASK

# run id -> the command's options up to (not including) --suite / --out / --scratch, which are paths and are not part of the config
REGISTERED = {
    'devtl1-qwen3.8-27b-handed': QWEN + COMMON,
    'devtl1-qwen3.8-27b-mustask': QWEN + COMMON + MUSTASK,
    'devtl1-muse-glimmer-30b-handed': MUSE + COMMON,
    'devtl1-muse-glimmer-30b-mustask': MUSE + COMMON + MUSTASK,
}


def _abort(self):
    raise A.AbortRun('offline config build: stopped before any call')


def build(options, suite=SUITE):
    """-> (exit code, manifest) of the runner's `main()` on `options` with the adapters stubbed so that nothing is contacted."""
    with tempfile.TemporaryDirectory(prefix='devtl1-config-') as work:
        out = Path(work) / 'run'
        argv = list(options) + ['--suite', str(suite), '--out', str(out), '--scratch', str(Path(work) / 'scratch')]
        with mock.patch.object(A.OllamaAdapter, 'preflight', _abort), mock.patch.object(LA.LlamaCppAdapter, 'preflight', _abort), \
                mock.patch.object(A.OllamaAdapter, 'finish', lambda self: {}), mock.patch.object(LA.LlamaCppAdapter, 'finish', lambda self: {}), \
                contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            code = R.main(argv)
        manifest = json.loads((out / 'manifest.json').read_text())
    return code, manifest


def config_hash(options, suite=SUITE):
    code, manifest = build(options, suite)
    if code != 3 or manifest.get('aborted') != 'offline config build: stopped before any call':
        raise RuntimeError('the runner did not reach the stub preflight (exit %s, aborted %r)' % (code, manifest.get('aborted')))
    return manifest['config_hash'], manifest['config']


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='compare with runs/dev-tl1/manifest-template.json and exit 1 on any difference')
    args = ap.parse_args(argv)
    rows = {rid: config_hash(opts)[0] for rid, opts in REGISTERED.items()}
    rows[SMOKE_ID] = config_hash(SMOKE, TESTDATA)[0]
    for rid, h in rows.items():
        print('%s  %s' % (h, rid))
    if args.check:
        tpl = json.loads(TEMPLATE.read_text())
        expected = {rid: run['expected_config_hash'] for rid, run in tpl['runs'].items()}
        expected[SMOKE_ID] = tpl['smoke']['expected_config_hash']
        bad = [rid for rid, h in rows.items() if expected.get(rid) != h]
        if bad:
            print('MISMATCH: %s' % ', '.join(bad), file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
