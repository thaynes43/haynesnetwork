"""Mocked end-to-end scenarios for the legacy-compatibility golden (W18).

`scenarios()` runs `run.run_case` with a scripted model over the replay, local-binary, remote, live, pinned and case-evidence branches
and returns, per scenario, digests of (a) every request the model was sent and (b) the run record without its volatile fields.
`tests/testdata/legacy-e2e-golden.json` was generated from the code of origin/main 7abf11fb (before the evidence-format-v2 change) by
`python3 tests/legacy_e2e.py > tests/testdata/legacy-e2e-golden.json`; `test_evidence_v2.LegacyCompatibility` recomputes it on the
current tree with every new option unset.  Only names that exist in both trees are used.

Volatile record fields excluded from the digest (they differ on every run and are not model-visible): `started_at`, `wall` and every
`wall_s`, `elapsed_s`, `bounds`-free timing keys of a live collector, and `harness_git_sha`.  Everything else is compared.
"""
import hashlib
import io
import json
import sys
import tempfile
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import th  # noqa: E402
import test_evidence as TE  # noqa: E402
from media_repair_harness import adapters as A  # noqa: E402
from media_repair_harness import run as R  # noqa: E402
from media_repair_harness import tools as T  # noqa: E402

VOLATILE = {'started_at', 'wall', 'wall_s', 'elapsed_s', 'harness_git_sha'}
FIX = th.TESTDATA / 'fixtures'


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha(obj):
    return hashlib.sha256(canon(obj).encode()).hexdigest()


def strip(obj):
    if isinstance(obj, dict):
        return {k: strip(v) for k, v in obj.items() if k not in VOLATILE}
    if isinstance(obj, list):
        return [strip(v) for v in obj]
    return obj


def digest(rec, adapter):
    return {'requests': sha(adapter.calls), 'record': sha(strip(rec)), 'n_requests': len(adapter.calls),
            'tool_results': sha([[c.get('status'), c.get('output'), c.get('truncated')] for c in rec['tool_calls']]),
            'decision': sha(rec['decision'])}


class Completed:
    def __init__(self, rc=0, out=b'', err=b''):
        self.returncode, self.stdout, self.stderr = rc, out, err


def wav_bytes(seconds=1, rate=16000, amp=1000):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b''.join((amp if i % 2 else -amp).to_bytes(2, 'little', signed=True) for i in range(rate * seconds)))
    return buf.getvalue()


PNG = b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\rIHDR' + (64).to_bytes(4, 'big') + (48).to_bytes(4, 'big') + b'\x08\x02\x00\x00\x00' + b'x' * 20

PROBE_REC = {'exit_code': 0, 'stderr': '', 'format': {'format_name': 'matroska,webm', 'duration': '8.046000', 'size': '90286', 'bit_rate': '89769', 'tags': {'title': 'Lamp Oil'}},
             'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'profile': 'High', 'pix_fmt': 'yuv420p', 'width': 256, 'height': 192, 'tags': {}},
                         {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'profile': 'LC', 'channels': 1, 'sample_rate': '22050', 'tags': {}}],
             'chapters': [{'start': '0.000000', 'end': '2.000000', 'title': 'Cold open'}, {'start': '2.000000', 'end': '8.000000', 'title': 'Lamp Oil'}]}
DEC_CLEAN = {'exit_code': 0, 'frames': 40, 'out_time': '00:00:04.000000', 'stderr': '', 't': 4}
DEC_BAD = {'exit_code': 0, 'frames': 27, 'out_time': '00:00:04.000000', 'stderr': '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5', 'ss': 4, 't': 4}
REPLAY_FILE = {'fixture': 'x.mkv', 'bytes': 100, 'tool_version': 'ffmpeg/ffprobe 8.1.2', 'ffprobe': PROBE_REC,
               'decode_sample': {'0': dict(DEC_CLEAN, ss=0), '4': DEC_BAD, '8': {'exit_code': 0, 'frames': 0, 'out_time': None, 'stderr': '', 'ss': 8, 't': 4},
                                 'full': {'exit_code': 0, 'frames': 67, 'out_time': '00:00:08.000000', 'stderr': DEC_BAD['stderr']}},
              'audio_sample': {'0': {'rms_dbfs': -20.1, 'peak_dbfs': -3.0, 'silent_fraction': 0.0, 'samples': 64000}},
              'frame_text': [{'t0': 0, 't1': 2, 'text': 'HARBOR LIGHTS / S01E02 / LAMP OIL'}]}


def tc(tool, args=None):
    return {'type': 'tool_call', 'tool': tool, 'args': args or {}, 'why': 'w'}


def dec(cls='insufficient_evidence', action='escalate', refs=(), target=None, **kw):
    d = {'type': 'decision', 'class': cls, 'action': action, 'target': target, 'confidence': 0.7, 'evidence_refs': list(refs), 'reason': 'r'}
    d.update(kw)
    return d


def suite_with(case, media=True, probes=True):
    ts = th.TempSuite([case])
    if media:
        ts.add_file('media/x.mkv', b'not really media' * 50)
    if probes:
        rec = dict(REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest())
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec).encode())
    return ts


def run(case, ts, replies, prompt='v4', adapter_model='scripted-model', **kw):
    ad = A.ScriptedAdapter(adapter_model, replies)
    scratch = tempfile.mkdtemp()
    rec = R.run_case(case, 'sha-' + case['id'], ad, ts.root, scratch, run_id='golden', prompt_version=prompt, **kw)
    return rec, ad


TRUTH = {'class': 'healthy', 'source': 'construction', 'ref': 'zqxv-ref-9'}


def tv_case(cid='gold-001', **kw):
    base = dict(media='tv', fixture={'kind': 'local', 'locator': 'media/x.mkv', 'sha256': hashlib.sha256(b'not really media' * 50).hexdigest()},
                context={'title': 'Harbor Lights S01E02', 'filename': 'Harbor Lights - S01E02 - Lamp Oil.mkv', 'expected': {'series': 'Harbor Lights', 'season': 1, 'episode': 2, 'runtime_s': 8},
                         'arr': {'app': 'sonarr', 'ids': {'seriesId': 990001, 'episodeFileId': 990202}}, 'notes_for_model': 'n'},
                tools_available=['ffprobe', 'decode_sample', 'frame_sample', 'ocr', 'audio_sample', 'arr_lookup'],
                evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(PROBE_REC)},
                          {'id': 'e2', 'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': 'ok', 'output': json.dumps(DEC_BAD)}])
    base.update(kw)
    case = th.make_case(id=cid, **base)
    case['truth'] = dict(TRUTH)
    case['provenance'] = 'zqxv provenance 7'
    return case


def scenario_replay():
    case = tv_case('gold-replay-001')
    ts = suite_with(case)
    replies = [tc('ffprobe'), tc('decode_sample'), tc('decode_sample', {'at': 4}), tc('decode_sample', {'full': True}),
               tc('ocr', {'at': 1}), tc('audio_sample'), dec('corrupt_file', 'escalate', ['e2', 't4'])]
    rec, ad = run(case, ts, replies, which=th.NO_BINARIES)
    return rec, ad


def scenario_local():
    case = tv_case('gold-local-001')
    ts = suite_with(case, probes=False)
    probe_json = json.dumps({'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'width': 256, 'height': 192, 'pix_fmt': 'yuv420p'}],
                             'format': {'format_name': 'matroska,webm', 'duration': '8.046', 'size': '90286', 'bit_rate': '89769'}}).encode()

    def runner(cmd, capture_output=True, timeout=None):
        exe = [c for c in cmd if 'ffprobe' in c or 'ffmpeg' in c][0]
        if 'ffprobe' in exe:
            return Completed(0, probe_json, b'')
        if 'wav' in cmd:
            return Completed(0, wav_bytes(), b'')
        if 'png' in cmd:
            return Completed(0, PNG, b'')
        return Completed(0, b'', b'[h264 @ 0x0] error while decoding MB 1 1' if '-ss' in cmd and cmd[cmd.index('-ss') + 1] == '4' else b'')
    replies = [tc('ffprobe'), tc('decode_sample'), tc('decode_sample', {'at': 4}), tc('decode_sample', {'full': True}), tc('frame_sample', {'at': 2}),
               tc('audio_sample', {'at': 1}), dec('insufficient_evidence', 'escalate', ['t2'])]
    return run(case, ts, replies, runner=runner, which=lambda n: '/usr/bin/' + n if n in ('ffmpeg', 'ffprobe') else None)


def scenario_remote():
    case = tv_case('gold-remote-001', fixture={'kind': 'remote', 'locator': 'remote:media/bazarr:/tv/x.mkv'})
    ts = th.TempSuite([case])

    def runner(cmd, input=None, capture_output=True, timeout=None):
        mode = cmd[cmd.index('-') + 1]
        info = {'exit_code': 0, 'stdout_bytes': 0, 'stderr': '', 'bytes_read': 4096, 'quota_exhausted': False}
        if mode == 'probe':
            out = json.dumps({'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'width': 640, 'height': 480}], 'format': {'format_name': 'matroska,webm', 'duration': '60'}}).encode()
            return Completed(0, out, json.dumps(info).encode())
        if mode == 'decode' and '--at' in cmd and cmd[cmd.index('--at') + 1] == '30.0':
            info['stderr'] = '[h264 @ 0x0] error while decoding MB 2 2'
        return Completed(0, b'', json.dumps(info).encode())
    replies = [tc('ffprobe'), tc('decode_sample'), tc('decode_sample', {'at': 30}), tc('decode_sample', {'full': True}), dec('corrupt_file', 'escalate', ['t3'])]
    return run(case, ts, replies, runner=runner)


def scenario_live():
    case = tv_case('gold-live-001')
    ts = suite_with(case, probes=False)
    path = ts.root / 'media' / 'x.mkv'
    fake = TE.Fake([(TE.prog('ffprobe', '-show_format'), TE.RunResult(0, TE.probe_json(duration=8.0, chapters=[(0, 4, 'A'), (4, 8, 'B')]), b'')),
                    (TE.prog('ffmpeg', '-progress'), lambda argv: TE.RunResult(0, TE.progress(float(argv[argv.index('-t') + 1]) if '-t' in argv else 8.0), b''))] + TE.VERSION)
    which = TE.which_with('ffmpeg', 'ffprobe')
    assert path.is_file()
    replies = [tc('ffprobe'), tc('decode_sample'), tc('decode_sample', {'full': True, 'at': 3}), tc('audio_sample', {'stream': 1}), dec('insufficient_evidence', 'escalate', ['t2'])]
    return run(case, ts, replies, evidence_mode='live', evidence_runner=fake, evidence_which=which, which=lambda n: None)


def scenario_pinned():
    case = tv_case('gold-pinned-001', fixture={'kind': 'remote', 'sha256': 'ab' * 32, 'locator': 'radarr movie 1 file 2 (pinned observation)'},
                   replay=[{'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': 'ok', 'output': json.dumps(DEC_CLEAN)},
                           {'tool': 'decode_sample', 'args': {'full': True}, 'status': 'ok', 'output': json.dumps({'exit_code': 0, 'out_time': '00:00:08.000000', 'frames': 67, 'stderr': ''})},
                           {'tool': 'ocr', 'args': {'ss': 1}, 'status': 'ok', 'output': 'HARBOR LIGHTS'}])
    ts = th.TempSuite([case])
    replies = [tc('ffprobe'), tc('decode_sample'), tc('decode_sample', {'at': 40}), tc('decode_sample', {'full': True}), tc('frame_sample', {'at': 1}), tc('ocr', {'frame': 'frame@1'}),
               dec('healthy', 'none', ['e1', 't3'])]
    return run(case, ts, replies)


def scenario_epub_and_arr():
    case = th.make_case(id='gold-epub-001', media='epub', fixture={'kind': 'local', 'locator': 'media/td-right.epub'},
                        context={'title': 'The Lantern Ledger', 'expected': {'title': 'The Lantern Ledger'}, 'arr': {'app': 'lazylibrarian', 'ids': {'bookId': 'll-1'}}, 'notes_for_model': 'n'},
                        tools_available=['epub_inspect', 'arr_lookup'],
                        evidence=[{'id': 'e1', 'tool': 'epub_inspect', 'args': {}, 'status': 'error',
                                   'output': json.dumps({'bytes': 3301, 'error': 'ParseError: not well-formed', 'stage': 'opf_parse', 'status': 'error'})}])
    case['truth'] = dict(TRUTH)
    case['provenance'] = 'zqxv provenance 7'
    ts = th.TempSuite([case])
    ts.add_file('media/td-right.epub', (FIX / 'td-right.epub').read_bytes())
    replies = [tc('epub_inspect'), tc('arr_lookup'), dec('corrupt_file', 'escalate', ['e1', 't1'])]
    return run(case, ts, replies, which=th.NO_BINARIES)


def scenario_injected_and_guards():
    case = tv_case('gold-inject-001', inject_tool_failure={'tool': 'decode_sample', 'mode': 'partial'}, evidence=[],
                   context={'title': 'T', 'filename': 'Harbor Lights - S01E02 - Lamp Oil.mkv', 'expected': {}, 'arr': {'app': 'sonarr', 'ids': {'episodeFileId': 990202}}, 'notes_for_model': 'n'})
    ts = suite_with(case)
    replies = [tc('decode_sample', {'full': True}), tc('ffprobe'), dec('healthy', 'none', ['t1', 't2'])]
    out = {}
    for g in (None, 'v1', 'v2'):
        ts_ = suite_with(case)
        out['guards_%s' % g] = run(case, ts_, list(replies), which=th.NO_BINARIES, guards=g)
    # guards that fire: a healthy decision with no integrity check, and a write that cites nothing usable
    case2 = tv_case('gold-guard-001', evidence=[], tools_available=['arr_lookup', 'ffprobe'])
    audit = {'target': 'Harbor Lights - S01E02 - Lamp Oil.mkv', 'preconditions': ['sonarr manages it'], 'readback': 'queue', 'verify': 'new file'}
    for g in ('v1', 'v2'):
        out['guard_fires_healthy_%s' % g] = run(case2, suite_with(case2), [tc('arr_lookup'), dec('healthy', 'none', ['t1'])], which=th.NO_BINARIES, guards=g)
        out['guard_fires_write_%s' % g] = run(case2, suite_with(case2), [tc('arr_lookup'), dec('corrupt_file', 'blocklist_and_search', ['t1'],
                                             target='Harbor Lights - S01E02 - Lamp Oil.mkv', audit=audit)], which=th.NO_BINARIES, guards=g)
    return out


def scenarios():
    out = {}
    for name, fn in (('replay', scenario_replay), ('local', scenario_local), ('remote', scenario_remote), ('live', scenario_live), ('pinned', scenario_pinned),
                     ('epub_and_arr', scenario_epub_and_arr)):
        rec, ad = fn()
        out[name] = digest(rec, ad)
    for key, (rec, ad) in scenario_injected_and_guards().items():
        out[key] = digest(rec, ad)
    return out


if __name__ == '__main__':
    print(json.dumps({'reference': 'origin/main 7abf11fb', 'scenarios': scenarios()}, indent=1, sort_keys=True))
