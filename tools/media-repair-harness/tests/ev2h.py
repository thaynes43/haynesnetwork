"""Helpers for the evidence-format-v2 tests: hand-written observations (the expected values in the tests are written by hand from these inputs, never
produced by the implementation), small case builders and a scripted run."""
import hashlib
import json
import tempfile
from pathlib import Path

import th
from media_repair_harness import adapters as A
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import tools as T


def obs(id, tool, status='ok', output=None, args=None, backend=None, source='tool', truncated=False):
    if output is not None and not isinstance(output, str):
        output = json.dumps(output)
    return EV2.make_observation(id, tool, args or {}, status, output if output is not None else '', backend, source, truncated)


def decode_out(ss=0, t=4, exit_code=0, frames=40, out_time='00:00:04.000000', stderr='', **extra):
    d = {'exit_code': exit_code, 'frames': frames, 'out_time': out_time, 'ss': ss, 't': t, 'stderr': stderr}
    d.update(extra)
    return d


def probe_out(duration='8.0', fmt='matroska,webm', streams=None, chapters=None, stderr=''):
    streams = streams if streams is not None else [
        {'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'profile': 'High', 'pix_fmt': 'yuv420p', 'width': 640, 'height': 480},
        {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'profile': 'LC', 'channels': 2, 'sample_rate': '48000'}]
    d = {'exit_code': 0, 'stderr': stderr, 'format': {'format_name': fmt, 'duration': duration, 'size': '1000', 'bit_rate': '1000'}, 'streams': streams,
         'chapters': chapters or []}
    return d


def derive_one(o, duration=None):
    return EV2.derive(o, duration)


def analysis(observations, context=None):
    return EV2.analyze(observations, context or {})


def view_of(case_like, evidence_obs, alias='case-00000000'):
    ses = EV2.Session(alias, case_like.get('context', {}), case_like.get('media_type', 'tv'), case_like.get('tools_available', []))
    block, n = ses.initial(evidence_obs)
    return ses, block, n


class SpyAdapter(A.ScriptedAdapter):
    """A scripted model that also keeps everything it was SENT: the system prompt, the messages and the schema (`full`), not just the messages."""

    def __init__(self, model, replies):
        super().__init__(model, replies)
        self.full = []

    def complete(self, system, messages, schema=None):
        self.full.append({'system': system, 'messages': json.loads(json.dumps(messages)), 'schema': json.loads(json.dumps(schema)) if schema is not None else None})
        return super().complete(system, messages, schema)

    def sent_text(self):
        """Everything sent to the model in every call, as one string."""
        return json.dumps(self.full, ensure_ascii=False)


def scripted_run(case, suite, replies, prompt='v4', **kw):
    ad = SpyAdapter('scripted-model', replies)
    rec = R.run_case(case, 'sha-' + case['id'], ad, suite.root, tempfile.mkdtemp(), run_id='ev2', prompt_version=prompt, **kw)
    return rec, ad


def tc(tool, args=None):
    return {'type': 'tool_call', 'tool': tool, 'args': args or {}, 'why': 'w'}


def dec(cls='insufficient_evidence', action='escalate', refs=(), target=None, **kw):
    d = {'type': 'decision', 'class': cls, 'action': action, 'target': target, 'confidence': 0.7, 'evidence_refs': list(refs), 'reason': 'r'}
    d.update(kw)
    return d


def case_with(evidence=(), tools=('ffprobe', 'decode_sample', 'arr_lookup'), cid='ev2-001', **kw):
    kw.setdefault('media', 'tv')
    case = th.make_case(id=cid, tools_available=list(tools), evidence=list(evidence), **kw)
    case['truth'] = {'class': 'zxq_truth_class', 'source': 'construction', 'ref': 'zxq-truth-ref-71'}
    case['provenance'] = 'zxq provenance 71'
    case['family'] = 'zxq-family-71'
    return case


def ev(i, tool, status='ok', output=None, args=None):
    return {'id': i, 'tool': tool, 'args': args or {}, 'status': status, 'output': output if isinstance(output, str) or output is None else json.dumps(output)}


def wire(messages):
    return '\n'.join(m['content'] for m in messages if m['role'] == 'user')


def fetch_all(ses, first_text, tool=None, call_id='t6', remaining=0, notice=True):
    """Fetch every page of a reply by following its cursors, the way a model would: as the SIXTH call, with the budget notice appended (the worst case for the
    8192-byte limit).  -> list of wire texts, the first one included."""
    tool = tool or max(ses.tools or ['ffprobe'], key=len)
    suffix = ('\n' + P.BUDGET_MESSAGE) if notice else ''
    texts = [first_text]
    body = json.loads(first_text.split('\n')[0])
    out = body['output'] if 'output' in body else body['evidence']
    cur = (out.get('page') or {}).get('next')
    while cur:
        status, t = ses.fetch(cur, call_id, tool, remaining, suffix)
        assert status == 'ok', t[:200]
        texts.append(t)
        cur = (json.loads(t.split('\n')[0])['output'].get('page') or {}).get('next')
    return texts


def walk_leaves(obj, path=()):
    """Every (path, scalar) of a nested structure; a list index is not part of the path (so a split list reads as one path)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk_leaves(v, path + (k,))
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_leaves(v, path)
    else:
        yield path, obj
