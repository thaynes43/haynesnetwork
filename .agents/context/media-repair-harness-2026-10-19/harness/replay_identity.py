"""What the model is sent in replay mode, as sha256 digests (dev-c2 replay-identity check).

COVERED (and compared by `test_wiring.ReplayIdentity` against `testdata/replay-identity-dev-c1.json`):
  per dev-suite case (all 73) - the model-visible case view (context + pre-collected evidence, as `protocol.case_view` renders it with
      a fixed alias) and, for every tool the case offers, the rendered tool result (`run.result_message`, i.e. status, truncated, output and
      calls remaining; not wall time or record-only fields) for a fixed argument set (`CALLS`), with no ffmpeg on PATH so local fixtures take
      the recorded-replay route;
  protocol - the v1 and v2 system prompt texts, the Ollama turn schemas (v1 anyOf and flat, v2 per tool set, anyOf and flat, and their parts),
      the repair prompts (v1 template; v2 with each failure-mode hint) for a fixed list of bad replies and the validator errors / failure
      modes they produce, the budget notice, the forced decision, the tool-result message at budget exhaustion, the message for a tool that
      is not offered, and the errors for bad arguments (a non-number, a negative offset, an out-of-range stream), plus the protocol constants
      (6 calls, 8 KiB, 60 s, the class / action / tool lists).

NOT COVERED: a run on a machine that has ffprobe / ffmpeg (the local and remote routes are unchanged code, not digested), argument sets
other than `CALLS`, adapters and the raw requests they build, the record fields (which differ by design: `harness_version`, `evidence_mode`,
`evidence`), and anything live.

The golden was generated from the dev-c1 code itself: `git archive 617e6ad4` extracted to a scratch directory, this file copied into its
`harness/`, and `python3 replay_identity.py <that checkout's suite dir> > testdata/replay-identity-dev-c1.json` run there.  So the comparison
is dev-c1's real output against the current tree's, not a self-comparison.  This file only uses names that exist in both trees.
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


# replies a model could send that the validator rejects (fixed list; the digests cover the errors, the failure modes and the repair prompt)
BAD_REPLIES = (
    '',
    'not json at all',
    '{"type":"decision","class":"corrupt_file","action":"rename+remap","target":null,"confidence":0.5,"evidence_refs":[],"reason":"x"}',
    '{"type":"decision","class":"nonsense","action":"none","target":null,"confidence":0.5,"evidence_refs":[],"reason":"x"}',
    '{"class":"healthy","action":"none"}',
    '{"status":"ok","output":"x","truncated":false,"tool_calls_remaining":5,"id":"t1"}',
    '```json\n{"type":"tool_call","tool":"ffprobe","args":{},"why":"w"}\n```',
    'Sure. {"type":"tool_call","tool":"ffprobe","args":{},"why":"w"}',
    '{"type":"tool_call","tool":"ffprobe","args":{},"why":"w"}<|eot|>',
    '{"type":"decision","class":"healthy","action":"none","target":null,"confidence":0.5,"evidence_refs":[],"reason":"x","audit":{}}',
    '{"type":"decision","class":"corrupt_file","action":"blocklist_and_search","target":"x","confidence":0.5,"evidence_refs":[],"reason":"x"}',
)
BAD_ARGS = (('decode_sample', {'at': 'soon'}), ('decode_sample', {'at': -1}), ('frame_sample', {'at': 10 ** 9}), ('audio_sample', {'stream': 999}),
            ('audio_sample', {'at': True}), ('ocr', {'at': 'x'}))


def digest_protocol():
    tools = ['ffprobe', 'decode_sample']
    out = {'constants': sha(json.dumps([P.MAX_TOOL_CALLS, P.TOOL_OUTPUT_BYTES, P.TOOL_TIMEOUT_S, list(P.CLASSES), list(P.ACTIONS), list(P.WRITE_ACTIONS), list(P.TOOLS)])),
           'prompt_v1': P.get_prompt('v1')['sha256'], 'prompt_v2': P.get_prompt('v2')['sha256'],
           'schemas': {'v1_anyof': sha(canon(P.turn_schema('v1'))), 'v1_flat': sha(canon(P.turn_schema('v1', flat=True))),
                       'v1_constants': sha(canon([P.TURN_SCHEMA, P.FLAT_TURN_SCHEMA, P.DECISION_SCHEMA, P.TOOL_CALL_SCHEMA])),
                       'v2_anyof': sha(canon(P.turn_schema('v2', tools))), 'v2_flat': sha(canon(P.turn_schema('v2', tools, flat=True))),
                       'v2_all_tools': sha(canon(P.turn_schema('v2'))), 'v2_audit': sha(canon(P.AUDIT_SCHEMA))},
           'budget_notice': sha(P.BUDGET_MESSAGE), 'repair_template': sha(P.REPAIR_PROMPT.format(error='E')), 'forced_decision': sha(canon(P.forced_decision('reason'))),
           'replies': {}, 'tool_messages': {}}
    for i, text in enumerate(BAD_REPLIES):
        obj, perr, diag = P.parse_reply(text)
        row = {}
        for version in ('v1', 'v2'):
            kind, errs = (None, [perr]) if perr else P.validate_turn(obj, tools, version)
            errs = [e for e in errs if e]
            modes = P.failure_modes(text, obj, errs, diag) if kind is None else []
            row[version] = {'kind': kind, 'errors': sha(canon(errs)), 'modes': sha(canon(modes)),
                            'repair': sha(P.REPAIR_PROMPT.format(error='; '.join(errs)[:300]) if version == 'v1' else P.repair_prompt('; '.join(errs)[:300], modes))}
        row['diag'] = sha(canon(diag or {}))
        out['replies']['bad%02d' % i] = row
    # the tool-result messages the loop sends outside the normal path
    case = {'id': 'x', 'media_type': 'tv', 'context': {'title': 'T'}, 'fixture': {'kind': 'none'}, 'tools_available': ['arr_lookup', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr'], 'evidence': []}
    ctx = T.Context(case, T.Fixture('none'), tempfile.mkdtemp(), which=lambda name: None)
    msgs = out['tool_messages']
    for name in ('ffprobe', 'shell', 'epub_inspect'):
        msgs['not_offered_' + name] = sha(R.result_message('t1', name if name in P.TOOLS else 'unknown_tool', T.call_tool(ctx, name, {}), 5))
    for i, (name, args) in enumerate(BAD_ARGS):
        msgs['bad_args_%d_%s' % (i, name)] = sha(R.result_message('t1', name, T.call_tool(ctx, name, args), 5))
    msgs['budget_exhausted'] = sha(R.result_message('t6', 'arr_lookup', T.call_tool(ctx, 'arr_lookup', {}), 0) + '\n' + P.BUDGET_MESSAGE)
    return out


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest_all(suite_dir):
    return {'reference': 'dev-c1 (617e6ad4)', 'cases': digest_suite(suite_dir), 'protocol': digest_protocol()}


if __name__ == '__main__':
    print(json.dumps(digest_all(sys.argv[1]), indent=1, sort_keys=True))
