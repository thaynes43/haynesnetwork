"""What the model sees in replay mode, as hashes (dev-c2 replay-identity check).

`digest_case(case, suite_dir)` drives every offered tool of a case through `tools.call_tool` with a fixed argument set (no ffmpeg on PATH,
so local fixtures take the recorded-replay route), renders each result exactly as `run.result_message` sends it, and adds the model-visible
case view (context and pre-collected evidence).  It returns sha256 digests only, so the golden file `testdata/replay-identity-dev-c1.json`
holds no answers: case keys are hashes of the case id.  The golden was generated from the dev-c1 code (`git show 617e6ad4`) before the
dev-c2 wiring touched `tools.py`; `test_wiring.ReplayIdentity` recomputes it and demands equality.  Regenerate only on purpose:
`python3 replay_identity.py <suite dir> > testdata/replay-identity-dev-c1.json` from a checkout of the code whose output is the reference.
"""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import protocol as P  # noqa: E402
import run as R  # noqa: E402
import tools as T  # noqa: E402

# One fixed call list per tool; arguments are the public numeric/option ones.  ocr runs after frame_sample so its frame name exists.
CALLS = {
    'arr_lookup': [{}],
    'ffprobe': [{}],
    'epub_inspect': [{}],
    'audiobook_inspect': [{}],
    'decode_sample': [{}, {'at': 60}, {'full': True}],
    'frame_sample': [{'at': 30}],
    'ocr': [{'at': 30}, {'frame': 'frame@30'}],
    'audio_sample': [{}, {'at': 45}],
}
ORDER = ('arr_lookup', 'ffprobe', 'epub_inspect', 'audiobook_inspect', 'decode_sample', 'frame_sample', 'ocr', 'audio_sample')


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def digest_case(case, suite_dir, **ctx_kw):
    scratch = tempfile.mkdtemp()
    fixture = T.Fixture.from_case(case, suite_dir)
    ctx = T.Context(case, fixture, scratch, suite_dir=suite_dir, which=lambda name: None, **ctx_kw)
    evidence = R.resolve_evidence(case, suite_dir, ctx.redact)
    view = json.dumps(P.case_view(case, evidence, case_alias='case-00000000'), ensure_ascii=False, sort_keys=True)
    calls = {}
    offered = case.get('tools_available', [])
    for tool in ORDER:
        if tool not in offered:
            continue
        for i, args in enumerate(CALLS[tool]):
            res = T.call_tool(ctx, tool, args)
            calls['%s#%d' % (tool, i)] = sha(R.result_message('t1', tool, res, 5))
    return {'view': sha(view), 'calls': calls}


def digest_suite(suite_dir):
    out = {}
    for case, case_sha in R.load_cases(suite_dir):
        out[sha(case['id'])[:16]] = dict(digest_case(case, R.suite_root(suite_dir)), case_sha256=case_sha)
    return out


if __name__ == '__main__':
    print(json.dumps({'reference': 'dev-c1 (617e6ad4)', 'cases': digest_suite(sys.argv[1])}, indent=1, sort_keys=True))
