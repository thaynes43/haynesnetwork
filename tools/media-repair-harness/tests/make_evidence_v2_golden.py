"""Regression golden for the format-v2 rendering (W18).  IMPLEMENTATION-GENERATED: it pins what the current code renders so an unintended change is
noticed; it is NOT the semantic oracle (the expected facts of test_evidence_v2_core / test_evidence_v2_run are written by hand from independent
synthetic observations).  Regenerate deliberately: `python3 tests/make_evidence_v2_golden.py > tests/testdata/evidence-v2-golden.json`.

Covers (a) a fixed list of synthetic observations rendered as first-message evidence blocks and tool replies, with pagination, and (b) the first-message
evidence block and the default tool replies of every public dev case (both dev suites), digested.  Case ids are hashed in the output."""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ev2h  # noqa: E402
import th  # noqa: E402
from media_repair_harness import evidence_v2 as EV2  # noqa: E402
from media_repair_harness import protocol as P  # noqa: E402
from media_repair_harness import run as R  # noqa: E402
from media_repair_harness import tools as T  # noqa: E402

ALIAS = 'case-00000000'
DAMAGE = '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5'


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def synthetic():
    from ev2h import obs, probe_out, decode_out
    chapters = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'T%03d %s' % (i, 'x' * 60)} for i in range(300)]
    cases = {
        'clean_probe_and_windows': ([obs('e1', 'ffprobe', 'ok', probe_out(duration='8.046'), source='case'), obs('e2', 'decode_sample', 'ok', decode_out(), {'ss': 0, 't': 4}, source='case')],
                                    [obs('t1', 'decode_sample', 'ok', decode_out(ss=4, out_time='00:00:04.000000'), {'at': 4})]),
        'damage_next_to_clean': ([obs('e1', 'ffprobe', 'ok', probe_out(duration='8'), source='case')],
                                 [obs('t1', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE), {'at': 4}), obs('t2', 'decode_sample', 'ok', decode_out(), {'at': 0})]),
        'failures': ([], [obs('t1', 'ffprobe', 'error', 'ffprobe failed: could not run'), obs('t2', 'decode_sample', 'timeout', 'decode_sample exceeded the 60 s tool timeout', {'at': 0}),
                          obs('t3', 'audio_sample', 'unavailable', 'no recorded audio levels for this item')]),
        'epub': ([obs('e1', 'epub_inspect', 'error', {'bytes': 3301, 'entries': 7, 'error': 'ParseError: x', 'stage': 'opf_parse', 'status': 'error'}, source='case')], []),
        'big_probe_paginated': ([], [obs('t1', 'ffprobe', 'ok', probe_out(duration='600', chapters=chapters))]),
        'unicode': ([], [obs('t1', 'arr_lookup', 'ok', {'note': '章' * 900, 'emoji': ['😀' * 40] * 30})]),
    }
    out = {}
    for name, (ev, calls) in cases.items():
        ses = EV2.Session(ALIAS, {'client_profile': {'containers': ['matroska,webm'], 'video': 'h264, 8-bit yuv420p, up to 1080p', 'audio': 'aac, up to 2 channels'}}, 'tv',
                          ['ffprobe', 'decode_sample', 'arr_lookup', 'audio_sample'])
        block, n = ses.initial(ev)
        rows = {'initial': sha(json.dumps(block, ensure_ascii=False, separators=(',', ':'))), 'initial_pages': n}
        for i, o in enumerate(calls, 1):
            text, np_ = ses.result(o, o['id'], 5 - i)
            rows['reply_%s' % o['id']] = {'sha': sha(text), 'pages': np_, 'bytes': len(text.encode('utf-8'))}
        rows['stored_page_cursors'] = sorted(ses.pages)
        out[name] = rows
    return out


def suites(root):
    out = {}
    calls = {'arr_lookup': [{}], 'ffprobe': [{}], 'epub_inspect': [{}], 'audiobook_inspect': [{}], 'decode_sample': [{}, {'at': 60}, {'full': True}], 'frame_sample': [{'at': 30}],
             'ocr': [{'at': 30}], 'audio_sample': [{}, {'at': 45}]}
    for name in ('suite', 'suite-dev-v1.1'):
        suite = Path(root) / name
        if not (suite / 'cases').is_dir():
            continue
        for case, case_sha in R.load_cases(suite):
            fx = T.Fixture.from_case(case, suite)
            ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=suite, which=lambda n: None, tools_behavior='v2', keep_raw=True)
            evidence = R.resolve_evidence_raw(case, suite, ctx.redact)
            view = P.case_view(case, [], case_alias=ALIAS)
            ses = EV2.Session(ALIAS, view['context'], view['media_type'], view['tools_available'])
            block, n = ses.initial([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence])
            row = {'case_sha256': case_sha, 'initial': sha(json.dumps(block, ensure_ascii=False, separators=(',', ':'))), 'caps': sha(json.dumps(T.capabilities(ctx), sort_keys=True)),
                   'replies': {}}
            k = 0
            for tool in case.get('tools_available', []):
                for args in calls.get(tool, [{}]):
                    k += 1
                    res = T.call_tool(ctx, tool, args)
                    o = EV2.make_observation('t%d' % k, tool, R.safe_args(args), res['status'], res.get('raw_output', res['output']), res.get('mode'))
                    text, np_ = ses.result(o, 't%d' % k, 3)
                    row['replies']['%s#%s' % (tool, json.dumps(args, sort_keys=True))] = sha(text)
            out['%s:%s' % (name, sha(case['id'])[:12])] = row
    return out


if __name__ == '__main__':
    root = Path(th.SUITE).parent
    print(json.dumps({'note': 'implementation-generated regression golden for the format-v2 rendering; not a semantic oracle', 'synthetic': synthetic(), 'public_dev': suites(root)}, indent=1, sort_keys=True))
