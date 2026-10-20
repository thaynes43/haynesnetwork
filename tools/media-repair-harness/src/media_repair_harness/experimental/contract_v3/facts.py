"""Contract v3 presentation prototype (EXPERIMENTAL, not wired into the runner): canonical atomic facts, deduplicated presentation, explicit
empty values, capability links, pagination through the unchanged v2 page contract, and page reassembly.

Invariants (tests/test_contract_v3_facts.py):
  * canonical_facts(v3) == canonical_facts(v2) + exactly the explicit empty / null / false / zero typed values that v2's filters dropped;
  * every canonical fact keeps its source id, tool, statement kind, provenance, execution state, raw status, scope, field path and presence;
  * the presentation deduplicates only wording: an identical unresolved statement from several observations is ONE open item listing every
    source id, and reassembly gives each source its own fact back;
  * conflicts, findings, execution and raw diagnostics stay with their own item; alerts and the open-item counts repeat on every page;
  * reassembling every page gives the same canonical facts as one unpaginated rendering;
  * no output field is a verdict (rubric.FORBIDDEN_FIELDS), and a link never carries a result.
The typed layer itself (`evidence_v2.analyze`, `derive`, `alerts_for`, `item_core`, `item_facts`, `paginate`) is reused unchanged.
"""
import copy
import hashlib

from ... import evidence_v2 as EV2
from ... import protocol as P
from . import links as LK
from . import presence as PR
from . import rubric as RB

FORMAT_VERSION = 'v3-prototype'
NESTED_PART_RX = __import__('re').compile(r'^output\.files\.(\d+)\.(tags)$')

_DECL_PATHS = ('tags', 'chapters', 'streams', 'container', 'duration_s', 'title', 'creator', 'language', 'identifier', 'opf', 'audio_streams',
               'chapter_count', 'files', 'stages_passed')
_INTEGRITY_PATHS = ('exit_code', 'frames', 'decoded_s', 'error_lines', 'stderr_lines', 'diagnostics', 'quota_exhausted', 'entries', 'bytes', 'spine_items',
                    'spine_characters', 'size_bytes', 'bit_rate_bps', 'segments', 'covered_fraction', 'parts', 'parts_probed', 'valid', 'error', 'message', 'raw',
                    'coverage', 'total_duration_s', 'tag_consistent')


def report_kind(method):
    import re
    t = str(method or '')
    if re.search(RB.NEGATED_METHOD_RX, t, re.I):
        return 'report_unknown'            # rubric v3.1 A31-3: a negated or failed method ("no OCR performed", "OCR unavailable") reports no observation
    hits = [k for k, rx in RB.REPORT_METHOD_VOCABULARY if re.search(rx, t, re.I)]
    if 'report_hash' in hits:
        return 'report_hash'
    if 'report_declaration' in hits:
        return 'report_declaration'        # a method naming declaration words is the weaker kind, even beside content words
    if 'report_content' in hits:
        return 'report_content'
    return 'report_unknown'


def statement_kind(tool, section, path, facts=None):
    """The rubric's statement kind of one fact (static: tool, section, field)."""
    head = str(path).split('.')[0] if path else ''
    if tool == 'arr_lookup':
        return 'catalog'
    if tool == 'prior_record':
        return report_kind((facts or {}).get('evidence_method') if isinstance(facts, dict) else None)
    if tool == 'ocr':
        return 'content' if section == 'facts' else 'integrity_signal'
    if tool == 'frame_sample':
        return 'content_picture'
    if tool == 'audio_sample':
        return 'integrity_signal'
    if section == 'facts':
        if tool == 'epub_inspect' and head == 'spine_heads':
            return 'content'
        if head in _INTEGRITY_PATHS:
            return 'integrity'
        if head in _DECL_PATHS:
            return 'declaration'
    return 'integrity'


def provenance(obs):
    if obs.get('tool') == 'prior_record':
        return 'reported'
    if obs.get('source') == 'case':
        return 'recorded'
    return 'observed' if obs.get('backend') in ('local', 'remote', 'live') else 'recorded'


def _leaves(value, prefix=''):
    """Dict leaves as (dotted path, value); a non-empty list of dicts is descended element by element (`path[i]`), so a value restored inside a nested
    record is an added fact, not a changed one; any other list or a scalar is one leaf (its order is part of the fact)."""
    if isinstance(value, dict) and value:
        out = []
        for k, v in value.items():
            out += _leaves(v, prefix + ('.' if prefix else '') + str(k))
        return out
    if isinstance(value, list) and value and all(isinstance(x, dict) and x for x in value):
        out = []
        for i, x in enumerate(value):
            out += _leaves(x, '%s[%d]' % (prefix, i))
        return out
    return [(prefix, value)]


def _fact(obs, d, section, path, value, presence=None, facts=None):
    return (obs['id'], obs['tool'], statement_kind(obs['tool'], section, path, facts), provenance(obs), d.execution.get('state'), d.execution.get('status'),
            EV2.canon(d.scope.get('completed') or {}), section, path, presence or PR.state_of(value), EV2.canon(value))


def item_facts_v3(obs, d):
    """v2 item_facts plus the explicit empty values v2 dropped (and nothing else).  -> (facts dict, presence dict {path: state}, added rows)"""
    facts = EV2.item_facts(d)
    added = PR.dropped_by_v2(obs, facts)
    out = copy.deepcopy(facts)
    presence = {}
    for row in added:
        key = row['fact_key']
        if '.' in key:                   # a nested record key: keep its raw path (record tools carry their own shape; v2 keeps those already)
            continue
        out[key] = row['value']
        presence[key] = row['presence']
    nested = []
    for row in PR.observation_presence(obs):        # live audiobook parts: an explicitly empty or null part tag object is kept in that part's facts
        m = NESTED_PART_RX.match(row['path'])
        if not m or row['presence'] not in (PR.NULL, PR.EMPTY) or not isinstance(out.get('files'), list):
            continue
        n = int(m.group(1)) + 1
        for i, el in enumerate(out['files']):
            if isinstance(el, dict) and el.get('n') == n and m.group(2) not in el:
                out['files'][i] = dict(el, **{m.group(2): row['value']})
                presence['files[%d].%s' % (i, m.group(2))] = row['presence']
                nested.append(dict(row, fact_key='files[%d].%s' % (i, m.group(2))))
    for row in PR.observation_presence(obs):
        if row['presence'] in (PR.NOT_CHECKED, PR.UNKNOWN):
            presence.setdefault(row['path'], row['presence'])
    return out, presence, [r for r in added if '.' not in r['fact_key']] + nested


def canonical_facts(observations, context=None, media_type=None, version='v3'):
    """The multiset (a sorted list) of canonical atomic facts over the shown observations.  version 'v2' = the facts format v2 shows; 'v3' adds the explicit empties."""
    an = EV2.analyze(observations, context or {}, media_type)
    out = []
    for o in observations:
        d = an['items'][o['id']]
        for k, v in d.execution.items():
            out.append(_fact(o, d, 'execution', k, v))
        for f in d.findings:
            out.append(_fact(o, d, 'findings', f['id'], f))
        for c in d.conflicts:
            out.append(_fact(o, d, 'conflicts', c['id'], c))
        if d.veto:
            out.append(_fact(o, d, 'veto', o['id'] + '.veto', d.veto))
        core = EV2.item_core(d)
        for k, v in (core.get('scope') or {}).items():
            out.append(_fact(o, d, 'scope', k, v))
        for u in d.unresolved:                  # (their order inside one item is presentation; the multiset keeps every repetition)
            out.append(_fact(o, d, 'unresolved', 'unresolved', u))
        if version == 'v3':
            facts, presence, _added = item_facts_v3(o, d)
        else:
            facts, presence = EV2.item_facts(d), {}
        for path, v in _leaves(facts):
            out.append(_fact(o, d, 'facts', path, v, presence.get(path), facts))
    for k, v in _leaves(an['coverage']):
        out.append(('coverage', None, 'integrity', 'derived', None, None, None, 'coverage', k, PR.state_of(v), EV2.canon(v)))
    if an['client'] is not None:
        for k, v in _leaves(an['client']):
            out.append(('client_comparison', None, 'client', 'derived', None, None, None, 'client_comparison', k, PR.state_of(v), EV2.canon(v)))
    for key in alert_keys(EV2.alerts_for([an['items'][i] for i in an['order']])):
        out.append(_alert_fact(key))
    return sorted(out, key=lambda t: EV2.canon(list(t))), an


def _alert_fact(key):
    return ('alerts', None, 'alert', 'derived', None, None, None, 'alerts', key, PR.POPULATED, EV2.canon(key))


def alert_keys(alerts, alert_ids=None):
    """`type:id:kind` for every alert, whichever tier the page shows them in: full objects, short strings, or groups plus the `alert_ids` units."""
    out = []
    for a in alerts or []:
        if isinstance(a, str):
            out.append(a)
        elif isinstance(a, dict) and 'first_ids' in a:
            ids = list(a['first_ids']) + list((alert_ids or {}).get('%s:%s' % (a.get('type'), a.get('kind')), []))
            out += ['%s:%s:%s' % (a.get('type'), i, a.get('kind')) for i in ids]
        elif isinstance(a, dict):
            out.append('%s:%s:%s' % (a.get('type'), a.get('id'), a.get('kind') or a.get('state')))
    return out


def _core_v3(d, open_ids):
    core = EV2.item_core(d)
    core.pop('unresolved', None)
    if d.veto:
        core['veto'] = d.veto              # page-local with its item (the alert names it; this carries it)
    if open_ids:
        core['open'] = open_ids
    return core


def render(observations, context=None, media_type=None, tools_offered=(), capabilities=(), alias='case-00000000', budget=EV2.WIRE_BYTES, frame=None):
    """-> {'pages': [body...], 'cursors': [...], 'reference': whole body (every unit, one page), 'open': open items, 'facts': canonical facts}.
    `frame` is the rest of the first message (context, tools, capabilities); the first page plus the frame is within `budget`."""
    lim = EV2.Limits(budget)
    facts_list, an = canonical_facts(observations, context, media_type, 'v3')
    derived = [an['items'][i] for i in an['order']]
    items = LK.attach_links(LK.open_items(an, media_type), capabilities, observations, tools_offered, media_type)
    by_src = {}
    for it in items:
        for s in it['sources']:
            by_src.setdefault(s, []).append(it['id'])
    header = {'alerts': EV2.alerts_for(derived), 'open_total': len(items), 'page': None}
    units, details = [], {}
    for d in derived:
        core = _core_v3(d, by_src.get(d.obs['id'], []))
        if EV2.nbytes(core) > lim.unit:
            small = {k: core[k] for k in ('id', 'tool', 'args', 'backend', 'execution', 'veto', 'open') if k in core}
            small['sections'] = 'findings, scope and conflicts are in item_sections.' + d.obs['id']
            units.append((('items',), 'append', small))
            for sec in ('findings', 'scope', 'conflicts'):
                if core.get(sec):
                    units += EV2.explode(('item_sections', d.obs['id'], sec), core[sec], 'set', lim)
        else:
            units.append((('items',), 'append', core))
    obs_by_id = {o['id']: o for o in observations}
    for d in derived:
        facts, presence, _added = item_facts_v3(obs_by_id[d.obs['id']], d)
        if facts:
            units += EV2.facts_units(('facts', d.obs['id']), facts, details, d.obs['id'], lim)
        if presence:
            units.append((('presence', d.obs['id']), 'set', presence))
    for it in items:
        units.append((('open',), 'append', EV2.externalize(it, 'open', details, lim)))
    for k, v in an['coverage'].items():
        units += EV2.explode(('coverage', k), v, 'set', lim)
    if an['client'] is not None:
        for k, v in an['client'].items():
            units += EV2.explode(('client_comparison', k), v, 'set', lim)
    units += EV2.detail_units(details, lim)
    frame = frame or {}
    tool = max(list(tools_offered) or ['x'], key=len)

    def env_first(b):
        return EV2.canon(dict(frame, evidence=b))

    def env_rest(b):
        return EV2.tool_envelope('t6', tool, 'ok', False, b, 0, '\n' + P.BUDGET_MESSAGE)     # the same worst-case fetch envelope as evidence_v2.Session
    pages = EV2.paginate(header, units, env_first, env_rest, alias, 'evidence', budget,
                         retrieval=None if tools_offered else 'unavailable: no tool is offered, so the other pages cannot be fetched')
    reference, _placed = EV2.assemble(dict(header, page=None), units)
    reference.pop('page', None)
    return {'pages': [b for b, _c in pages], 'cursors': [c for _b, c in pages], 'reference': reference, 'open': items, 'facts': facts_list,
            'first_bytes': EV2.nbytes(env_first(pages[0][0])), 'page_bytes': [EV2.nbytes(env_first(pages[0][0]))] + [EV2.nbytes(env_rest(b)) for b, _c in pages[1:]]}


# ---------------------------------------------------------------------------------------------------------------- reassembly
def _merge(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = _merge(out[k], v) if k in out else copy.deepcopy(v)
        return out
    if isinstance(a, list) and isinstance(b, list):
        return a + b
    return b


def _normalise(v):
    if isinstance(v, dict):
        return {k: _normalise(x) for k, x in v.items() if not k.endswith('_shown')}
    if isinstance(v, list):
        if any(isinstance(e, dict) and '_i' in e for e in v):
            by, plain = {}, []
            for e in v:
                if isinstance(e, dict) and '_i' in e:
                    tgt = by.setdefault(e['_i'], {})
                    for k, x in e.items():
                        if k == '_i':
                            continue
                        tgt[k] = _merge(tgt[k], x) if k in tgt and isinstance(x, (list, dict)) else x
                else:
                    plain.append(e)
            v = [by[i]['value'] if set(by[i]) == {'value'} else by[i] for i in sorted(by)] + plain
        return [_normalise(e) for e in v]
    return v


def reassemble(pages):
    """Every page merged into one body: dicts merged, list parts concatenated in page order, split elements put back by their `_i`, page objects and
    `_shown` markers dropped.  The header (alerts, open_total) is taken from page one (it is repeated on every page)."""
    body = {}
    for p in pages:
        q = {k: v for k, v in p.items() if k not in ('page', 'alerts', 'open_total')}
        body = _merge(body, q)
    body = _normalise(body)
    if pages:
        body['alerts'] = pages[0].get('alerts')
        body['open_total'] = pages[0].get('open_total')
    return body


def _resolve(value, details):
    import re
    if isinstance(value, str):
        m = re.search(r'\.\.\.\[\+\d+ chars: detail ([^\]]+)\]$', value)
        if m and m.group(1) in details:
            d = details[m.group(1)]
            return ''.join(d) if isinstance(d, list) else d
        return value
    if isinstance(value, list):
        return [_resolve(x, details) for x in value]
    if isinstance(value, dict):
        return {k: _resolve(x, details) for k, x in value.items()}
    return value


def _page_fact(it, section, path, value, presence=None, facts=None):
    ex = it.get('execution') or {}
    prov = 'reported' if it.get('tool') == 'prior_record' else ('observed' if it.get('backend') in ('local', 'remote', 'live') else 'recorded')
    return (it['id'], it.get('tool'), statement_kind(it.get('tool'), section, path, facts), prov, ex.get('state'), ex.get('status'),
            EV2.canon((it.get('scope') or {}).get('completed') or {}), section, path, presence or PR.state_of(value), EV2.canon(value))


def facts_from_body(body):
    """Canonical atomic facts rebuilt from a (reassembled) v3 body ALONE: no observation, no analysis.  The inverse of render() for everything it
    presents: items (execution, findings, conflicts, veto, scope), the open items' unresolved statements per source, facts with presence, coverage,
    client comparison and the alerts, in whichever tier the pages carry them.  A page that drops an alert or a veto reconstructs to different facts."""
    details = body.get('details') or {}
    items = {it['id']: dict(it) for it in body.get('items') or []}
    for oid, secs in (body.get('item_sections') or {}).items():
        items.setdefault(oid, {'id': oid}).update(secs)
    out = []
    unresolved = {}
    for it in body.get('open') or []:
        it = _resolve(it, details)
        if it.get('origin') == 'unresolved':
            for s in it['sources']:
                unresolved.setdefault(s, []).append(it['text'])
    for oid, it in items.items():
        for k, v in (it.get('execution') or {}).items():
            out.append(_page_fact(it, 'execution', k, v))
        for f in it.get('findings') or []:
            out.append(_page_fact(it, 'findings', f['id'], f))
        for c in it.get('conflicts') or []:
            out.append(_page_fact(it, 'conflicts', c['id'], c))
        if it.get('veto'):
            out.append(_page_fact(it, 'veto', oid + '.veto', it['veto']))
        for k, v in (it.get('scope') or {}).items():
            out.append(_page_fact(it, 'scope', k, v))
        for u in unresolved.get(oid, []):
            out.append(_page_fact(it, 'unresolved', 'unresolved', u))
        facts = _resolve((body.get('facts') or {}).get(oid) or {}, details)
        presence = (body.get('presence') or {}).get(oid) or {}
        for path, v in _leaves(facts):
            out.append(_page_fact(it, 'facts', path, v, presence.get(path), facts))
    for k, v in _leaves(body.get('coverage') or {}):
        out.append(('coverage', None, 'integrity', 'derived', None, None, None, 'coverage', k, PR.state_of(v), EV2.canon(v)))
    if body.get('client_comparison') is not None:
        for k, v in _leaves(body['client_comparison']):
            out.append(('client_comparison', None, 'client', 'derived', None, None, None, 'client_comparison', k, PR.state_of(v), EV2.canon(v)))
    for key in alert_keys(body.get('alerts'), body.get('alert_ids')):
        out.append(_alert_fact(key))
    return sorted(out, key=lambda t: EV2.canon(list(t)))


def digest(obj):
    return hashlib.sha256(EV2.canon(obj).encode()).hexdigest()
