"""Uncalled available checks at a decision prefix, counter `uncalled-2` (W25, OpenProject #156; EXPERIMENTAL, offline, record-only).

`uncalled.py` (`uncalled-1`, the dev-c6 logic) is unchanged and keeps producing every earlier count (docs/contract-v3-uncalled.json and the dev-c6 /
dev-c7 tables).  It rebuilds the prefix with tools behaviour v2 and the format-v3 links, so on a format v3.1-format record it drops the excerpt arguments,
reads an excerpt as a package check and never sees the EPUB body capability or an unfetched page.  This counter reads a v3.1-format record as the runner
showed it:

* the prefix is the case evidence resolved as the v3.1-format runner resolves it (tools behaviour v3, recorded EPUB text kept literal) and every non-page
  tool result of the record (`evidence_v3.shown_observations`), with an explicit excerpt typed as a
  reading (`evidence_v31.internal`), analysed by `evidence_v31.analyze` and linked exactly as the v3.1 session links (`links.attach_links` over the
  internal observations and the capabilities the record says were advertised);
* LINK candidates count as in uncalled-1 (available, offered, one per distinct call);
* EXCERPT candidates (the EPUB body capability, which has no link in the presentation): when epub_inspect is offered and advertised as available with
  `excerpts` described, a shown body index gives one candidate per indexed spine item whose body text is not covered by the shown default and explicit
  excerpts (`{"spine": i, "offset": <the first unread code point>}`), and one per spine position beyond the index (`offset` 0); with no body view
  shown, the default call `{}` is the candidate unless a `{}` call was already made (one that failed, timed out or was unavailable is not repeated);
  an explicit excerpt request that failed is not repeated;
* PAGE candidates: every page of a shown message (the first message or a tool result) that was not fetched before the decision; a fetch is a tool call.

A candidate counts only while the remaining budget at the decision is at least one.  The count is a neutral transcript observation, never an error, and
never a claim that calling the check would have changed the decision.  No case id is a key of the summary; rows carry the record's own case alias.
"""
import tempfile

from ... import evidence_v2 as EV2
from ... import evidence_v3 as EV3
from ... import evidence_v31 as EV31
from ... import protocol as P
from ... import run as RUN
from ... import tools as T
from . import links as LK
from . import uncalled as UC1

COUNTER_VERSION = 'uncalled-2'
FORMATS = (EV31.FORMAT_VERSION,)


def prefix(record, case, suite_dir):
    """-> (shown observations, internal observations, analysis, context, media type, offered tools, capabilities, remaining budget)."""
    fixture = T.Fixture.from_case(case, suite_dir)
    ctx = T.Context(case, fixture, tempfile.mkdtemp(prefix='mrh-w25-'), suite_dir=suite_dir, which=lambda _n: None, tools_behavior=EV31.TOOLS_BEHAVIOR, keep_raw=True)
    evidence = RUN.resolve_evidence_raw(case, suite_dir, ctx.redact, literal_epub=True)
    obs = EV3.shown_observations(evidence, record.get('tool_calls') or [])
    inner = [EV31.internal(o) for o in obs]
    view = P.case_view(case, [], case_alias=record.get('model_case_alias') or 'case-00000000')
    an = EV31.analyze(obs, view['context'], view['media_type'])
    caps = (record.get('evidence_format') or {}).get('capabilities') or []
    remaining = P.MAX_TOOL_CALLS - len(record.get('tool_calls') or [])
    return obs, inner, an, view['context'], view['media_type'], list(case.get('tools_available') or []), caps, remaining


def _data(o):
    data, _n = EV2.unwrap(o)
    return data if isinstance(data, dict) else None


def _covered(spans):
    out = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def excerpt_candidates(inner, caps, offered, args_of=None):
    """-> candidates for the EPUB body capability (no result is an input: only which views and ranges were shown).  `args_of` maps a call id to the
    arguments the record states (the observations carry the safe arguments only, which drop the excerpt arguments)."""
    args_of = args_of or {}
    cap = next((c for c in caps if isinstance(c, dict) and c.get('tool') == 'epub_inspect'), None)
    if 'epub_inspect' not in offered or not cap or cap.get('available') is not True or not isinstance(cap.get('excerpts'), dict):
        return []
    bodies = [(o, _data(o)['body']) for o in inner if o['tool'] == 'epub_inspect' and o['status'] == 'ok' and isinstance((_data(o) or {}).get('body'), dict)
              and isinstance(_data(o)['body'].get('index'), list)]
    if not bodies:
        tried = [o for o in inner if o['tool'] == 'epub_inspect' and o.get('source') == 'tool' and not args_of.get(o['id'], o.get('args') or {})]
        if tried:
            return []           # the default call was made (it failed, or it showed no body view): not repeated
        return [{'tool': 'epub_inspect', 'args': {}, 'scope': 'epub_body_index', 'availability': 'available'}]
    _o, body = bodies[-1]
    read = {}
    for ex in body.get('excerpts') or []:
        if isinstance(ex, dict) and isinstance(ex.get('spine'), int) and isinstance(ex.get('offset'), int) and isinstance(ex.get('end'), int):
            read.setdefault(ex['spine'], []).append((ex['offset'], ex['end']))
    failed = set()
    for o in inner:
        d = _data(o)
        if o['tool'] == EV31.EXCERPT_TOOL and isinstance((d or {}).get('excerpt'), dict):
            ex = d['excerpt']
            if isinstance(ex.get('spine'), int) and isinstance(ex.get('offset'), int) and isinstance(ex.get('end'), int):
                read.setdefault(ex['spine'], []).append((ex['offset'], ex['end']))
        elif o['tool'] == 'epub_inspect' and o.get('source') == 'tool' and o['status'] in ('error', 'timeout', 'unavailable') and args_of.get(o['id']):
            failed.add((args_of[o['id']].get('spine'), args_of[o['id']].get('offset', 0)))
    out = []
    index = [it for it in body['index'] if isinstance(it, dict) and isinstance(it.get('spine'), int)]
    for it in index:
        n = it.get('characters') if isinstance(it.get('characters'), int) else 0
        pos = 0
        for a, b in _covered(read.get(it['spine'], [])):
            if a > pos:
                break
            pos = max(pos, b)
        if pos < n and (it['spine'], pos) not in failed:
            out.append({'tool': 'epub_inspect', 'args': {'spine': it['spine'], 'offset': pos}, 'scope': 'epub_body', 'availability': 'available'})
    total = body.get('items_total') if isinstance(body.get('items_total'), int) else len(index)
    for i in range(len(index), total):
        if i not in read and (i, 0) not in failed:
            out.append({'tool': 'epub_inspect', 'args': {'spine': i, 'offset': 0}, 'scope': 'epub_body_unindexed', 'availability': 'available'})
    return out


def page_candidates(record):
    """-> one candidate per page of a shown message that was not fetched (the first page of every message is delivered with it)."""
    calls = record.get('tool_calls') or []
    case_ids = sorted(str(e.get('id') if isinstance(e, dict) else e) for e in record.get('evidence_shown') or [])
    fetched = {}
    for c in calls:
        if c.get('continuation') or c.get('tool') == 'page':
            of = c.get('pages_of') or []
            key = 'evidence' if (sorted(of) == case_ids and of) else (of[0] if len(of) == 1 else None)
            if key is not None:
                fetched[key] = fetched.get(key, 0) + 1
    out = []
    for m in (record.get('evidence_format') or {}).get('messages') or []:
        pages = m.get('pages') if isinstance(m.get('pages'), int) else 1
        rest = pages - 1 - fetched.get(m.get('id'), 0)
        for n in range(pages - rest + 1, pages + 1):
            out.append({'tool': 'page', 'args': {'of': m.get('id'), 'page': n}, 'scope': 'page', 'availability': 'available'})
    return out


def callable_candidates(record, case, suite_dir):
    """-> (open items with links, the candidates that count, remaining budget)."""
    _obs, inner, an, _context, media, offered, caps, remaining = prefix(record, case, suite_dir)
    items = LK.attach_links(LK.open_items(an, media), caps, inner, offered, media)
    counted, seen = [], set()
    if remaining >= 1:
        for it in items:
            for c in it['available_check']:
                key = (c['tool'], EV2.canon(c['args']))
                if c['availability'] == 'available' and c['tool'] in offered and key not in seen:
                    seen.add(key)
                    counted.append(dict(c, family='link', open_item=it['id'], open_scope=it['scope']['type']))
        args_of = {c.get('id'): c.get('args') or {} for c in record.get('tool_calls') or []}
        for c in excerpt_candidates(inner, caps, offered, args_of) + (page_candidates(record) if offered else []):
            key = (c['tool'], EV2.canon(c['args']))
            if key not in seen:
                seen.add(key)
                counted.append(dict(c, family='excerpt' if c['tool'] == 'epub_inspect' else 'page', open_scope=c['scope']))
    return items, counted, remaining


def summarise(records_with_cases, suite_dir):
    """-> per-run summary in the uncalled-1 shape, with the candidate families split out (link, excerpt, page)."""
    out = {'counter': COUNTER_VERSION, 'decisions': 0, 'escalations': 0, 'escalations_with_uncalled_available_check': 0, 'by_tool': {}, 'by_scope': {}, 'by_family': {},
           'budget_exhausted_escalations': 0, 'non_escalations_with_uncalled_available_check': 0, 'rows': []}
    for rec, case in records_with_cases:
        fmt = (rec.get('evidence_format') or {}).get('version')
        if fmt not in FORMATS:
            raise ValueError('uncalled-2 reads format %s records only (got %s); earlier records keep uncalled-1' % (', '.join(FORMATS), fmt))
        dec = UC1.model_decision(rec)
        out['decisions'] += 1
        _items, counted, remaining = callable_candidates(rec, case, suite_dir)
        esc = dec.get('action') == 'escalate'
        if esc:
            out['escalations'] += 1
            if remaining < 1:
                out['budget_exhausted_escalations'] += 1
            if counted:
                out['escalations_with_uncalled_available_check'] += 1
                for c in counted:
                    for key, val in (('by_tool', c['tool']), ('by_scope', c['open_scope']), ('by_family', c['family'])):
                        out[key][val] = out[key].get(val, 0) + 1
        elif counted:
            out['non_escalations_with_uncalled_available_check'] += 1
        out['rows'].append({'alias': rec.get('model_case_alias'), 'action': dec.get('action'), 'calls_made': len(rec.get('tool_calls') or []), 'remaining': remaining,
                            'uncalled_available': len(counted), 'families': sorted({c['family'] for c in counted}), 'tools': sorted({c['tool'] for c in counted})})
    return out
