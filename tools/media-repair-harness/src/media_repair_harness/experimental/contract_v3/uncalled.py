"""Uncalled available checks at a decision prefix (EXPERIMENTAL, offline, record-only): A16 item 4.

For one recorded decision, the prefix is everything the model was shown before it: the case evidence and every tool result (a page fetch is
not an observation, it only uses a call).  The open items and their links are computed from that prefix exactly as links.py does (shown
observations, the capabilities the record says were advertised, static tool semantics).  A candidate COUNTS only when it is available, its
tool is offered, its arguments are valid for the advertisement, it repeats no call already made (or one that failed, timed out or was
unavailable) and the remaining budget at the decision is at least one.  The count is a neutral observation, never a recoverable error.
"""
import tempfile

from ... import evidence_v2 as EV2
from ... import protocol as P
from ... import run as RUN
from ... import tools as T
from . import links as LK


def model_decision(record):
    """The model's own decision (before any guard), as the record keeps it."""
    g = record.get('guard') or {}
    if g.get('applied'):
        return g['applied'][0]['original']
    return record.get('decision') or {}


def prefix_observations(record, case, suite_dir):
    """-> (observations shown before the decision, tools offered, remaining budget).  Case evidence is resolved and redacted as the runner did."""
    fixture = T.Fixture.from_case(case, suite_dir)
    ctx = T.Context(case, fixture, tempfile.mkdtemp(prefix='mrh-w20-'), suite_dir=suite_dir, which=lambda _n: None, tools_behavior='v2', keep_raw=True)
    obs = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in RUN.resolve_evidence_raw(case, suite_dir, ctx.redact)]
    for c in record.get('tool_calls') or []:
        if c.get('continuation') or c.get('tool') == 'page':
            continue
        tool = c['tool'] if c['tool'] in P.TOOLS else 'unknown_tool'
        obs.append(EV2.make_observation(c['id'], tool, EV2.safe_args(c.get('args')), c['status'], c.get('raw_output', c.get('output')), c.get('mode'), 'tool',
                                        c.get('collector_truncated')))
    remaining = P.MAX_TOOL_CALLS - len(record.get('tool_calls') or [])
    return obs, list(case.get('tools_available') or []), remaining


def callable_candidates(record, case, suite_dir):
    """-> (open items with links, the candidates that count, remaining budget)."""
    obs, offered, remaining = prefix_observations(record, case, suite_dir)
    caps = (record.get('evidence_format') or {}).get('capabilities') or []
    view = P.case_view(case, [], case_alias=record.get('model_case_alias') or 'case-00000000')      # the context exactly as the model saw it
    an = EV2.analyze(obs, view['context'], view['media_type'])
    items = LK.attach_links(LK.open_items(an, view['media_type']), caps, obs, offered, view['media_type'])
    counted, seen = [], set()
    if remaining >= 1:
        for it in items:
            for c in it['available_check']:
                key = (c['tool'], EV2.canon(c['args']))
                if c['availability'] == 'available' and c['tool'] in offered and key not in seen:     # one candidate per distinct call
                    seen.add(key)
                    counted.append(dict(c, open_item=it['id'], open_scope=it['scope']['type']))
    return items, counted, remaining


def summarise(records_with_cases, suite_dir):
    """-> per-run summary: escalations, escalations with >= 1 uncalled available check, candidate counts by tool and scope.  No case id is a key of
    the summary; per-decision rows carry the record's own case alias (model_case_alias), never a label."""
    out = {'decisions': 0, 'escalations': 0, 'escalations_with_uncalled_available_check': 0, 'by_tool': {}, 'by_scope': {}, 'budget_exhausted_escalations': 0,
           'non_escalations_with_uncalled_available_check': 0, 'rows': []}
    for rec, case in records_with_cases:
        dec = model_decision(rec)
        out['decisions'] += 1
        items, counted, remaining = callable_candidates(rec, case, suite_dir)
        esc = dec.get('action') == 'escalate'
        if esc:
            out['escalations'] += 1
            if remaining < 1:
                out['budget_exhausted_escalations'] += 1
            if counted:
                out['escalations_with_uncalled_available_check'] += 1
                for c in counted:
                    out['by_tool'][c['tool']] = out['by_tool'].get(c['tool'], 0) + 1
                    out['by_scope'][c['open_scope']] = out['by_scope'].get(c['open_scope'], 0) + 1
        elif counted:
            out['non_escalations_with_uncalled_available_check'] += 1
        out['rows'].append({'alias': rec.get('model_case_alias'), 'action': dec.get('action'), 'calls_made': len(rec.get('tool_calls') or []), 'remaining': remaining,
                            'uncalled_available': len(counted), 'tools': sorted({c['tool'] for c in counted})})
    return out
