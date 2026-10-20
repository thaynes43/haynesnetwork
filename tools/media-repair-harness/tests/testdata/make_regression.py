#!/usr/bin/env python3
"""Writes the synthetic regression suite for the harness' own tests: testdata/regression/cases/*.json.

Generic, invented titles; no third-party content and nothing from the W3 suite.  Movie, TV and audiobook rows are *pinned*
(a recorded observation, no media behind them: every tool answer is labelled replay) so the tests need no ffmpeg; the EPUB rows
use the deterministic fixtures in testdata/fixtures (make_fixtures.py).  They cover partial evidence, abstention, failed and
timed-out tools, healthy negatives and edition / order ambiguity.  The tests drive them with FAKE model replies: this suite checks
the harness' protocol, tool statuses, audit and records, not any model.
Run `python3 make_regression.py` to regenerate; the output is deterministic.
"""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / 'regression' / 'cases'
FIX = HERE / 'fixtures'
PROV = 'new (harness regression data; synthetic, invented for this test)'


def sha(name):
    return hashlib.sha256((FIX / name).read_bytes()).hexdigest()


def case(cid, media, truth, supported, solvable, title, expected, tools, arr=None, notes='', fixture=None, evidence=(), replay=(),
         inject=None, outcome=None, client_profile=None):
    ctx = {'title': title, 'expected': expected, 'arr': {'app': arr, 'ids': {}}, 'notes_for_model': notes}
    if client_profile:
        ctx['client_profile'] = client_profile
    c = {'id': cid, 'suite_version': 'harness-regression-v1', 'split': 'dev', 'media_type': media,
         'family': cid.rsplit('-', 1)[0], 'truth': {'class': truth[0], 'source': 'construction', 'ref': truth[1]},
         'supported_actions': list(supported), 'solvable': solvable, 'context': ctx,
         'fixture': fixture or {'kind': 'remote', 'sha256': None, 'locator': 'recorded observation of a synthetic row; no media is reachable'},
         'evidence': list(evidence), 'tools_available': list(tools), 'provenance': PROV}
    if replay:
        c['replay'] = list(replay)
    if inject:
        c['inject_tool_failure'] = inject
    if outcome:
        c['outcome_step'] = outcome
    return c


def ffprobe_ok(duration=5400.0):
    return json.dumps({'exit_code': 0, 'stderr': '', 'format': {'format_name': 'matroska,webm', 'duration': str(duration)},
                       'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'profile': 'High', 'pix_fmt': 'yuv420p'},
                                   {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}]}, sort_keys=True)


def decode(clean=True, full=False):
    return json.dumps({'exit_code': 0, 'stderr': '' if clean else 'error while decoding', 'quota_exhausted': False, 'scope': 'whole file' if full else '4 s window'}, sort_keys=True)


EPUB_TOOLS = ['epub_inspect', 'arr_lookup']


def cases():
    right, wrong, corrupt = ('../fixtures/td-right.epub', None, '../fixtures/td-corrupt.epub')
    ledger = {'title': 'The Lantern Ledger', 'author': 'Ines Varga', 'language': 'en'}
    out = [
        case('rg-movie-healthy-001', 'movie', ('healthy', 'whole-file decode and the container probe are recorded clean'), ['none'], True,
             'Example Movie', {'runtime_s': 5400, 'language': 'en'}, ['ffprobe', 'decode_sample', 'arr_lookup'], arr='radarr',
             notes='Routine check, no complaint.',
             evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': ffprobe_ok()},
                       {'id': 'e2', 'tool': 'decode_sample', 'args': {'full': True}, 'status': 'ok', 'output': decode(True, True)}]),
        case('rg-movie-partial-001', 'movie', ('insufficient_evidence', 'only a 4 s window was ever decoded; the rest of the file is unverified'), ['escalate'], False,
             'Example Movie Two', {'runtime_s': 6000, 'language': 'en'}, ['ffprobe', 'decode_sample', 'arr_lookup'], arr='radarr',
             notes='Playback stutters near the end, says a viewer.',
             evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': ffprobe_ok(6000.0)}],
             replay=[{'tool': 'decode_sample', 'args': {'at': 0}, 'status': 'ok', 'output': decode(True)}]),
        case('rg-movie-limited-001', 'movie', ('insufficient_evidence', 'no decode tool is offered, so nothing can show the whole file decodes'), ['escalate'], False,
             'Example Movie Three', {'runtime_s': 5000, 'language': 'en'}, ['ffprobe', 'arr_lookup'], arr='radarr', notes='A viewer reports a glitch.',
             evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': ffprobe_ok(5000.0)}]),
        case('rg-tv-timeout-001', 'tv', ('insufficient_evidence', 'the decode tool times out; the file body is unverified'), ['escalate'], False,
             'Example Show', {'series': 'Example Show', 'season': 1, 'episode': 3, 'runtime_s': 1320}, ['ffprobe', 'decode_sample', 'arr_lookup'], arr='sonarr',
             notes='Episode freezes halfway.', inject={'tool': 'decode_sample', 'mode': 'timeout'},
             evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': ffprobe_ok(1320.0)}]),
        case('rg-tv-failed-probe-001', 'tv', ('insufficient_evidence', 'the recorded probe failed; only a window decodes'), ['escalate'], False,
             'Example Show', {'series': 'Example Show', 'season': 1, 'episode': 4, 'runtime_s': 1320}, ['ffprobe', 'decode_sample', 'arr_lookup'], arr='sonarr',
             notes='Looks wrong to a viewer.',
             evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'error', 'output': 'ffprobe: probe failed (host unavailable)'}],
             replay=[{'tool': 'decode_sample', 'args': {'at': 0}, 'status': 'ok', 'output': decode(True)}]),
        case('rg-tv-order-001', 'tv', ('order_edition_ambiguity', 'content is right under two legitimate episode orders; the evidence does not choose'), ['escalate'], False,
             'Example Show', {'series': 'Example Show', 'season': 2, 'episode': 5, 'order': 'catalog uses one order; the broadcast used another'},
             ['ffprobe', 'ocr', 'arr_lookup'], arr='sonarr', notes='Episode seems to be in the wrong place in the list.',
             evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': ffprobe_ok(1320.0)},
                       {'id': 'e2', 'tool': 'prior_record', 'args': {}, 'status': 'ok', 'output': 'The on-screen title card matches the broadcast-order episode 6 and the catalog-order episode 5.'}]),
        case('rg-epub-healthy-001', 'epub', ('healthy', 'the archive opens, the OPF parses, title and author match'), ['none'], True,
             'The Lantern Ledger', ledger, EPUB_TOOLS, notes='Routine check.',
             fixture={'kind': 'local', 'sha256': sha('td-right.epub'), 'locator': right}),
        case('rg-epub-corrupt-001', 'epub', ('corrupt_file', 'the archive is truncated; epub_inspect reports an unreadable zip'), ['blocklist_and_search', 'escalate'], True,
             'The Lantern Ledger', ledger, EPUB_TOOLS, arr='bookshelf', notes='Readers report this book will not open.',
             fixture={'kind': 'local', 'sha256': sha('td-corrupt.epub'), 'locator': corrupt},
             outcome={'check': 'epub_valid', 'inputs': {'path': corrupt}, 'expected': 'not_repaired'}),
        case('rg-epub-edition-001', 'epub', ('order_edition_ambiguity', 'two editions exist and nothing in the file says which is wanted'), ['escalate'], False,
             'The Lantern Ledger', dict(ledger, edition='either the first or the revised edition'), EPUB_TOOLS, arr='bookshelf',
             notes='The library holds one file; the catalog lists a first and a revised edition, and the request does not name one.',
             fixture={'kind': 'local', 'sha256': sha('td-right.epub'), 'locator': right}),
        case('rg-audiobook-healthy-001', 'audiobook', ('healthy', 'duration, tags and chapters agree with the catalog'), ['none'], True,
             'Example Audiobook', {'title': 'Example Audiobook', 'duration_s': 7200, 'chapters': 3}, ['audiobook_inspect', 'arr_lookup'], arr='bookshelf',
             notes='Routine check.',
             replay=[{'tool': 'audiobook_inspect', 'args': {}, 'status': 'ok', 'output': json.dumps(
                 {'format': 'mov,mp4,m4a', 'duration_s': 7200.0, 'tags': {'title': 'Example Audiobook'}, 'chapter_count': 3,
                  'audio_streams': [{'index': 0, 'codec_name': 'aac', 'channels': 2}]}, sort_keys=True)}]),
        case('rg-audiobook-failed-001', 'audiobook', ('insufficient_evidence', 'the only inspection tool fails'), ['escalate'], False,
             'Example Audiobook Two', {'title': 'Example Audiobook Two', 'duration_s': 5400}, ['audiobook_inspect', 'arr_lookup'], arr='bookshelf',
             notes='Stops partway through, says a listener.', inject={'tool': 'audiobook_inspect', 'mode': 'error'}),
        case('rg-audiobook-partial-001', 'audiobook', ('insufficient_evidence', 'the inspection output is cut off; the chapters after the cut are unverified'), ['escalate'], False,
             'Example Audiobook Three', {'title': 'Example Audiobook Three', 'duration_s': 5400, 'chapters': 12}, ['audiobook_inspect', 'arr_lookup'], arr='bookshelf',
             notes='Chapter list looks short.', inject={'tool': 'audiobook_inspect', 'mode': 'partial'},
             replay=[{'tool': 'audiobook_inspect', 'args': {}, 'status': 'ok', 'output': json.dumps(
                 {'format': 'mov,mp4,m4a', 'duration_s': 5400.0, 'tags': {'title': 'Example Audiobook Three'}, 'chapter_count': 12,
                  'chapters': [{'start_s': 450.0 * i, 'end_s': 450.0 * (i + 1), 'title': 'Part %d' % (i + 1)} for i in range(12)]}, sort_keys=True)}]),
    ]
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for c in cases():
        (OUT / (c['id'] + '.json')).write_text(json.dumps(c, indent=2, sort_keys=True) + '\n')
        print(c['id'])


if __name__ == '__main__':
    main()
