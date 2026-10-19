"""Test helpers: build tiny suites in a temp dir."""
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESTDATA = HERE / 'testdata'


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
