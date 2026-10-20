"""Wiring smoke for `--evidence live`.  Runs INSIDE a CPU-limited batch Job (see launch_wiring_smoke.py), never in the dev-env pod.

Generates small public synthetic fixtures (lavfi test pattern and sine tone, a stdlib zip EPUB; no real library media), then drives the
harness' own `run.run_case` in live evidence mode with a scripted adapter (no model) over four synthetic cases, with the real ffprobe /
ffmpeg and the real collectors.  Prints one JSON document between two marker lines.  Checks the wiring, not any model or any score.

    python3 wiring_smoke.py          # needs ffmpeg and ffprobe on PATH
"""
import json
import os
import platform
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))   # live_smoke.py sits next to this file and puts the package on sys.path

import live_smoke as LS  # noqa: E402
from media_repair_harness import adapters as A  # noqa: E402
from media_repair_harness import run as R  # noqa: E402

BEGIN, END = '===MRH-WIRING-SMOKE-BEGIN===', '===MRH-WIRING-SMOKE-END==='


def tool(name, **args):
    return {'type': 'tool_call', 'tool': name, 'args': args, 'why': 'wiring smoke'}


def decision(refs):
    return {'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'target': None, 'confidence': 0.5, 'evidence_refs': refs,
            'reason': 'wiring smoke: scripted decision citing the tool results'}


def case(cid, media, locator, tools, kind='local'):
    return {'id': cid, 'suite_version': 'wiring-smoke', 'split': 'dev', 'media_type': media, 'family': 'f-' + cid,
            'truth': {'class': 'insufficient_evidence', 'source': 'construction', 'ref': 'synthetic generator seed 7'}, 'supported_actions': ['escalate'], 'solvable': False,
            'context': {'title': 'Synthetic item', 'expected': {}, 'arr': {'app': None, 'ids': {}}, 'notes_for_model': 'Check the item.'},
            'fixture': {'kind': kind, 'locator': locator}, 'evidence': [], 'tools_available': tools, 'provenance': 'new'}


def main():
    started = time.time()
    work = Path(tempfile.mkdtemp(prefix='mrh-wiring-', dir=os.environ.get('TMPDIR') or '/tmp'))
    log = []
    have_x264, have_aac = LS.encoders()
    venc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-g', '20'] if have_x264 else ['-c:v', 'mpeg4', '-q:v', '12', '-g', '20']
    aenc = ['-c:a', 'aac', '-b:a', '24k'] if have_aac else ['-c:a', 'libmp3lame', '-b:a', '32k']
    good = work / 'clip-a.mkv'
    LS.ff(['-f', 'lavfi', '-i', 'testsrc2=size=256x192:rate=10:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=22050:duration=12'] + venc +
          ['-pix_fmt', 'yuv420p'] + aenc + ['-ac', '1', '-metadata:s:a:0', 'language=eng', str(good)], log)
    data = bytearray(good.read_bytes())
    off = len(data) * 55 // 100
    data[off:off + 2048] = b'\xff' * 2048
    (work / 'clip-b.mkv').write_bytes(bytes(data))
    LS.make_epub(work / 'book-a.epub')
    ep = (work / 'book-a.epub').read_bytes()
    (work / 'book-b.epub').write_bytes(ep[: len(ep) // 2])
    media = ['ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr', 'epub_inspect', 'arr_lookup']

    plans = [
        (case('ws-video-1', 'movie', 'clip-a.mkv', media), [tool('ffprobe'), tool('decode_sample'), tool('audio_sample'), tool('frame_sample'), tool('ocr'), tool('decode_sample', full=True)], ['t2', 't5']),
        (case('ws-video-2', 'movie', 'clip-b.mkv', media), [tool('ffprobe'), tool('decode_sample'), tool('decode_sample', full=True)], ['t2', 't3']),
        (case('ws-epub-1', 'epub', 'book-b.epub', media), [tool('epub_inspect'), tool('ffprobe')], ['t1']),
        (case('ws-missing-1', 'movie', 'not-there.mkv', media), [tool('ffprobe'), tool('decode_sample')], ['t1']),
    ]
    out_cases = {}
    for c, calls, refs in plans:
        ad = A.ScriptedAdapter('scripted-1', calls + [decision(refs)])
        rec = R.run_case(c, 'sha', ad, work, work / 'scratch', run_id='wiring-smoke', prompt_version='v2', evidence_mode='live')
        rec.update(harness_git_sha='smoke', config_hash='smoke', run_id='wiring-smoke')
        out_cases[c['id']] = {
            'evidence_mode': rec['evidence_mode'], 'forced': rec['forced'], 'first_try_valid': rec['first_try_valid'], 'missing_fields': R.record_missing_fields(rec),
            'tool_calls': [{k: t.get(k) for k in ('id', 'tool', 'args', 'status', 'mode', 'evidence_mode', 'live_ran', 'truncated', 'wall_s', 'args_ignored', 'output')} for t in rec['tool_calls']],
            'evidence': rec['evidence'], 'decision': rec['decision'], 'error': rec.get('error'), 'action_audit_executed': rec['action_audit']['executed']}

    def ver(cmd):
        try:
            import subprocess
            return subprocess.run(cmd, capture_output=True, timeout=10, stdin=subprocess.DEVNULL).stdout.decode().splitlines()[0]
        except Exception as e:  # noqa: BLE001
            return 'unavailable: %s' % e

    doc = {'label': 'LIVE: harness run_case in --evidence live mode with a scripted adapter (no model), real ffprobe/ffmpeg inside a CPU-limited batch Job, synthetic fixtures; not replay, not real library media',
           'python': platform.python_version(), 'ffmpeg': ver(['ffmpeg', '-version']), 'ffprobe': ver(['ffprobe', '-version']),
           'tesseract': (ver(['tesseract', '--version']) if shutil.which('tesseract') else 'not installed in the Job image'),
           'generation_notes': log, 'elapsed_s': round(time.time() - started, 2), 'cases': out_cases}
    shutil.rmtree(work, ignore_errors=True)
    print(BEGIN)
    print(json.dumps(doc, indent=1, sort_keys=True))
    print(END)


if __name__ == '__main__':
    main()
