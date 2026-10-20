"""Test helpers: build tiny suites in a temp dir."""
import functools
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESTDATA = HERE / 'testdata'
COMPONENT = HERE.parent                      # tools/media-repair-harness
REPO_ROOT = COMPONENT.parents[1]             # the haynesnetwork checkout
# The public dev suite (the same cases the evaluator scores; labels are not read here).  Located repo-relative by default; MRH_SUITE_DIR
# points elsewhere (an out-of-tree checkout of the suite).  Held-out data is never read by this harness's tests.
DEFAULT_SUITE = REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite'
SUITE = Path(os.environ['MRH_SUITE_DIR']) if os.environ.get('MRH_SUITE_DIR') else DEFAULT_SUITE
EPUB_SOURCE = REPO_ROOT / '.agents' / 'context' / 'media-repair-actual-epub-2026-10-18' / 'epub.py'


def require_suite():
    """Called by every test that needs the public dev suite.  A missing suite SKIPS, except when MRH_REQUIRE_SUITE=1 (CI sets it),
    where it FAILS: a quietly skipped suite test must not read as green."""
    if (SUITE / 'cases').is_dir() and any((SUITE / 'cases').glob('*.json')):
        return SUITE
    msg = 'public dev suite not found at %s (set MRH_SUITE_DIR)' % SUITE
    if os.environ.get('MRH_REQUIRE_SUITE') == '1':
        raise AssertionError(msg + '; MRH_REQUIRE_SUITE=1 forbids skipping')
    raise unittest.SkipTest(msg)


def needs_suite(obj):
    """Decorator for a TestCase class (checked once in setUpClass) or a single test method."""
    if isinstance(obj, type):
        orig = obj.__dict__.get('setUpClass')

        def setUpClass(cls):
            require_suite()
            if orig is not None:
                orig.__func__(cls)
        obj.setUpClass = classmethod(setUpClass)
        return obj

    @functools.wraps(obj)
    def wrapper(*a, **kw):
        require_suite()
        return obj(*a, **kw)
    return wrapper


def make_case(id='c1', truth='healthy', supported=('none',), solvable=True, media='epub', split='dev', **extra):
    case = {'id': id, 'suite_version': 't', 'split': split, 'media_type': media, 'family': 'f-' + id,
            'truth': {'class': truth, 'source': 'construction', 'ref': 'test'}, 'supported_actions': list(supported), 'solvable': solvable,
            'context': {'title': 'T', 'expected': {}, 'arr': {'app': None, 'ids': {}}, 'notes_for_model': 'n'},
            'fixture': {'kind': 'none'}, 'evidence': [], 'tools_available': ['arr_lookup', 'ffprobe', 'decode_sample', 'epub_inspect', 'frame_sample', 'ocr', 'audio_sample', 'audiobook_inspect'],
            'provenance': 'new'}
    case.update(extra)
    return case


class TempSuite:
    def __init__(self, cases):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'suite'
        (self.root / 'cases').mkdir(parents=True)
        for c in cases:
            (self.root / 'cases' / (c['id'] + '.json')).write_text(json.dumps(c))

    def add_file(self, rel, data):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def cleanup(self):
        self.tmp.cleanup()


def decision(cls='healthy', action='none', refs=None, **kw):
    d = {'type': 'decision', 'class': cls, 'action': action, 'target': None, 'confidence': 0.8, 'evidence_refs': refs or [], 'reason': 'r'}
    d.update(kw)
    return d


def tool_call(tool='arr_lookup', args=None):
    return {'type': 'tool_call', 'tool': tool, 'args': args or {}, 'why': 'w'}
