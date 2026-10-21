"""Evidence format v3.1-format (dev-c7, opt-in `--evidence-format v3.1-format --prompt v7`): contract v3 with three low-risk presentation fixes.

The name is `v3.1-format` so it cannot be confused with rubric v3.1 (AUDIT-ASTRA-26 item 6).  It is ONE versioned configuration: evidence format
v3.1-format (this module), turn protocol `turn-v3` / decision schema `decision-v3` and audit v3 (all unchanged from dev-c6), tools behaviour v3
(tools behaviour v2 plus EPUB body excerpts, `epub_text.py`), the page contract `pages-v1`, the rubric v3.2 clarification (`rubric_v32.py`; the
checker still applies rubric v3.1, unchanged), and prompt v7.  Valid only together (run.check_option_combination).  Format v3, prompt v6 and every
earlier configuration are byte-identical.

What changes against format v3 (and nothing else):

* EPUB body text (tools v3).  A `{}` epub_inspect result carries `body` (the body index with observed headings and the fixed default excerpts)
  and `declared_toc` (the package's declared table of contents); an explicit excerpt result carries one `excerpt`.  Both are shown as facts.
  The v2 statement "no body text beyond the shown spine heads was read" (no longer true once excerpts are shown) is replaced, for a tools-v3
  result only, by the neutral "body text outside the shown excerpts was not read by this result".  An explicit excerpt is typed as a reading,
  not an integrity check (internally the observation is `epub_text`; the model sees the tool it called, `epub_inspect`).
* Statement kinds.  Every epub_inspect, excerpt and prior-record item carries `kinds`: its provenance and the statement kind of each
  declaration, content or report field (OPF metadata and the declared table of contents are declarations; body excerpts and observed headings are
  content; the legacy spine heads are `legacy_mixed`; a prior record's `observed` is the kind its stated method names).
* Prior-record provenance.  Every prior record carries `report`: the method as stated (or its presence state), the frozen vocabulary classes it
  matches, whether it is negated, and the kind derived from it by the frozen rule (`facts.report_kind`, the checker's own).  The original
  values and method stay in its facts unchanged.  A report never becomes an observation of this run.

Links (`available_check`), open items, coverage, the client comparison, pagination, alerts, the audit and the checker are the dev-c6 code,
unchanged.  Nothing here classifies or recommends.
"""
import copy
import json
import re

from . import epub_text_v3 as ET        # extraction rule xhtml-body-text-3 (-1 and -2 stay frozen in epub_text.py / epub_text_v2.py)
from . import evidence_v2 as EV2
from . import evidence_v3 as EV3
from . import protocol as P
from .experimental.contract_v3 import facts as FX
from .experimental.contract_v3 import links as LK
from .experimental.contract_v3 import presence as PR
from .experimental.contract_v3 import rubric as RB
from .experimental.contract_v3 import rubric_v32 as RB32

FORMAT_VERSION = 'v3.1-format'
TOOLS_BEHAVIOR = 'v3'
PROMPTS = ('v7',)
RUBRIC_VERSION = RB32.RUBRIC_V32_VERSION              # the clarification the prompt states
CHECKER_RUBRIC = RB.RUBRIC_V31_VERSION                # what the unchanged checker applies (v3.2 changes no check)
CONTRACT = dict(EV3.CONTRACT, evidence_format=FORMAT_VERSION, tools_behavior=TOOLS_BEHAVIOR, rubric=RUBRIC_VERSION, checker_rubric=CHECKER_RUBRIC,
                excerpt_rule=ET.RULE_ID)
EXCERPT_TOOL = 'epub_text'        # the typed layer's name for an explicit excerpt result (a reading); never shown to the model
SUBTITLE_TOOL = 'subtitle_sample'  # tools behaviour v3-remote-1 (#161) only: its cue text is media text (shadowed and checked like EPUB text)
BODY_UNREAD = 'body text outside the shown excerpts was not read by this result'
_V2_BODY_RX = (re.compile(r'^no body text beyond the shown spine heads was read$'), re.compile(r'^only the first \d+ of \d+ spine items are shown as text'))
# `spine_heads` are the vendored inspector's first six words of ALL character data of a spine document (its head title, styles and navigation together with
# the body).  Under v3.1-format they are labelled `legacy_mixed` (their real provenance) and withheld from the checker (AUDIT-ASTRA-27 item 3, D32-3).
LEGACY_HEADS = 'legacy_mixed'
EPUB_KINDS = {'title': 'declaration', 'creator': 'declaration', 'language': 'declaration', 'identifier': 'declaration', 'opf': 'declaration',
              'declared_toc': 'declaration', 'spine_heads': LEGACY_HEADS, 'body': 'content'}


# ---------------------------------------------------------------------------------------------------------------- observations
def is_excerpt(obs):
    """An ok epub_inspect result that is one explicit excerpt (tools v3): no package-check field, an `excerpt` object."""
    if obs.get('tool') != 'epub_inspect' or obs.get('status') != 'ok':
        return False
    data, _n = EV2.unwrap(obs)
    return isinstance(data, dict) and isinstance(data.get('excerpt'), dict) and 'status' not in data and 'spine_items' not in data


def internal(obs):
    """The observation the typed layer reads: an explicit excerpt becomes a reading (`epub_text`), everything else is unchanged."""
    return dict(obs, tool=EXCERPT_TOOL) if is_excerpt(obs) else obs


def blank_media(obs):
    """The harness-only shadow of an epub_inspect observation: every literal media string blanked at its known field (tools.epub_v3_blank); others as is."""
    from . import tools as T
    if obs.get('tool') == SUBTITLE_TOOL:
        from . import remote_evidence as RE
        blanked = RE.blank(obs.get('output'))
        return obs if blanked is obs.get('output') else dict(obs, output=json.dumps(blanked, ensure_ascii=False))
    if obs.get('tool') not in ('epub_inspect', EXCERPT_TOOL):
        return obs
    out = obs.get('output')
    try:
        data = json.loads(out) if isinstance(out, str) else out
    except ValueError:
        return obs
    if not isinstance(data, dict):
        return obs
    return dict(obs, output=json.dumps(T.epub_v3_blank(data), ensure_ascii=False))


def carries_media(observations):
    return any(o.get('tool') in ('epub_inspect', EXCERPT_TOOL, SUBTITLE_TOOL) for o in observations)


def display_tool(obs):
    return 'epub_inspect' if obs.get('tool') == EXCERPT_TOOL else obs.get('tool')


def _data(obs):
    data, _n = EV2.unwrap(obs)
    return data if isinstance(data, dict) else None


def analyze(observations, context=None, media_type=None):
    """`evidence_v2.analyze` over the internal observations, then the one wording change for tools-v3 EPUB results (BODY_UNREAD)."""
    an = EV2.analyze([internal(o) for o in observations], context or {}, media_type)
    for o in observations:
        d = an['items'][o['id']]
        data = _data(o)
        if o.get('tool') == 'epub_inspect' and data is not None and 'body' in data:
            kept = [u for u in d.unresolved if not any(rx.search(u) for rx in _V2_BODY_RX)]
            if len(kept) != len(d.unresolved):
                d.unresolved[:] = kept + [BODY_UNREAD]
        if d.obs['tool'] == EXCERPT_TOOL:
            ex = data.get('excerpt') or {}
            d.scope['requested'] = {'what': 'body text excerpt', 'spine': ex.get('spine'), 'offset': ex.get('offset')}
            d.scope['completed'].update(spine=ex.get('spine'), member=ex.get('member'), offset=ex.get('offset'), end=ex.get('end'))
    return an


def report_typing(obs):
    """A prior record's `report`: the stated method kept as stated, the vocabulary classes it matches, negation, and the kind the frozen rule derives."""
    data = _data(obs) or {}
    has = 'evidence_method' in data
    method = data.get('evidence_method')
    text = str(method or '')
    matched = [k for k, rx in RB.REPORT_METHOD_VOCABULARY if re.search(rx, text, re.I)]
    out = {'kind': FX.report_kind(method), 'derived_from': 'evidence_method', 'method_presence': PR.state_of(method) if has else PR.ABSENT,
           'matched': matched, 'negated': bool(re.search(RB.NEGATED_METHOD_RX, text, re.I))}
    if has:
        out['method'] = method
    obs_inner = data.get('observed')
    if isinstance(obs_inner, dict) and 'evidence_method' in obs_inner and obs_inner.get('evidence_method') != method:
        out['observed_method_differs'] = True        # shown, not resolved: the kind is derived from the top-level method, as the checker derives it
    return out


def kinds_of(obs, facts):
    """`kinds` of one item: its provenance and the statement kind of each declaration / content / report field it shows (None when it has none)."""
    tool = obs.get('tool')
    fields = {}
    if tool == 'epub_inspect':
        fields = {k: EPUB_KINDS[k] for k in facts if k in EPUB_KINDS}
    elif tool == EXCERPT_TOOL:
        fields = {'excerpt': 'content'} if 'excerpt' in facts else {}
    elif tool == SUBTITLE_TOOL:
        fields = {'cues': 'content'} if 'cues' in facts else {}       # tools behaviour v3-remote-1: subtitle cues are content read by this run
    elif tool == 'prior_record':
        kind = FX.report_kind((_data(obs) or {}).get('evidence_method'))
        fields = {k: kind for k in facts if k == 'observed'}
    if not fields:
        return None
    return {'provenance': FX.provenance(obs), 'fields': fields}


def item_facts_v31(obs, d):
    """Format v3's facts (explicit empties kept) plus the tools-v3 body view an epub_inspect result carries -> (facts, presence, kinds, report)."""
    facts, presence, _added = FX.item_facts_v3(obs, d)
    data = _data(obs)
    if obs.get('tool') == 'epub_inspect' and data is not None and d.execution['state'] == 'ran':
        for k in ('body', 'declared_toc'):
            if k in data:
                facts[k] = copy.deepcopy(data[k])
                if PR.state_of(data[k]) != PR.POPULATED:
                    presence[k] = PR.state_of(data[k])
    report = report_typing(obs) if obs.get('tool') == 'prior_record' else None
    return facts, presence, kinds_of(obs, facts), report


# ---------------------------------------------------------------------------------------------------------------- the first message
def render(observations, context=None, media_type=None, tools_offered=(), capabilities=(), alias='case-00000000', budget=EV2.WIRE_BYTES, frame=None, shadow=True):
    """`facts.render` (format v3) with the v3.1 facts, `kinds` and `report`; same units, same pagination, same open items and links."""
    lim = EV2.Limits(budget)
    inner = [internal(o) for o in observations]
    an = analyze(observations, context, media_type)
    derived = [an['items'][i] for i in an['order']]
    items = LK.attach_links(LK.open_items(an, media_type), capabilities, inner, tools_offered, media_type)
    by_src = {}
    for it in items:
        for s in it['sources']:
            by_src.setdefault(s, []).append(it['id'])
    header = {'alerts': EV2.alerts_for(derived), 'open_total': len(items), 'page': None}
    units, details = [], {}
    for d in derived:
        core = FX._core_v3(d, by_src.get(d.obs['id'], []))
        core['tool'] = display_tool(d.obs)
        if EV2.nbytes(core) > lim.unit:
            small = {k: core[k] for k in ('id', 'tool', 'args', 'backend', 'execution', 'veto', 'open') if k in core}
            small['sections'] = 'findings, scope and conflicts are in item_sections.' + d.obs['id']
            units.append((('items',), 'append', small))
            for sec in ('findings', 'scope', 'conflicts'):
                if core.get(sec):
                    units += EV2.explode(('item_sections', d.obs['id'], sec), core[sec], 'set', lim)
        else:
            units.append((('items',), 'append', core))
    by_id = {o['id']: o for o in inner}
    for d in derived:
        facts, presence, kinds, report = item_facts_v31(by_id[d.obs['id']], d)
        if facts:
            units += EV2.facts_units(('facts', d.obs['id']), facts, details, d.obs['id'], lim)
        if presence:
            units.append((('presence', d.obs['id']), 'set', presence))
        if kinds:
            units.append((('kinds', d.obs['id']), 'set', kinds))
        if report:
            units.append((('report', d.obs['id']), 'set', report))
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
        return EV2.tool_envelope('t6', tool, 'ok', False, b, 0, '\n' + P.BUDGET_MESSAGE)
    pages = EV2.paginate(header, units, env_first, env_rest, alias, 'evidence', budget,
                         retrieval=None if tools_offered else 'unavailable: no tool is offered, so the other pages cannot be fetched')
    reference, _placed = EV2.assemble(dict(header, page=None), units)
    reference.pop('page', None)
    out = {'pages': [b for b, _c in pages], 'cursors': [c for _b, c in pages], 'reference': reference, 'open': items,
           'first_bytes': EV2.nbytes(env_first(pages[0][0])), 'page_bytes': [EV2.nbytes(env_first(pages[0][0]))] + [EV2.nbytes(env_rest(b)) for b, _c in pages[1:]]}
    if shadow:
        # leakguard-media-2: the whole first message (every page, one body) rendered from the blanked observations: all harness-written text, no media text
        if carries_media(observations):
            blank = render([blank_media(o) for o in observations], context, media_type, tools_offered, capabilities, alias, budget, frame, shadow=False)['reference']
            out['shadow'] = env_first(blank)
        else:
            out['shadow'] = None        # no media text: the legacy check reads the delivered message itself, as in every other format
    return out


class Session(EV3.Session):
    """Per-case state for format v3.1-format.  Everything the dev-c6 session does, with the v3.1 analysis and facts."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.page_shadow = {}     # cursor -> the harness-only shadow of the result that page belongs to
        self.last_shadow = None

    def analysis(self):
        return analyze(self.shown, self.context, self.media_type)

    def _open_items(self, an):
        items = LK.attach_links(LK.open_items(an, self.media_type), self.capabilities, [internal(o) for o in self.shown], self.tools, self.media_type)
        used = set(self.open_ids.values())
        n = len(used)
        for it in items:
            k = self._key(it)
            if k not in self.open_ids:
                n += 1
                while 'u%d' % n in used:
                    n += 1
                self.open_ids[k] = 'u%d' % n
                used.add(self.open_ids[k])
            it['id'] = self.open_ids[k]
        return items

    def initial(self, evidence_obs, frame=None):
        self.shown = list(evidence_obs)
        frame = frame or {}
        r = render(self.shown, self.context, self.media_type, self.tools, self.capabilities, alias=self.alias, budget=self.budget, frame=frame)
        self.shadows = {'evidence': r['shadow']}     # harness-only text of each delivered result, for the leak guard (leakguard-media-2)
        self.last_shadow = r['shadow']
        for cur in r['cursors'][1:]:
            self.page_shadow[cur] = r['shadow']
        for it in r['open']:
            self.open_ids.setdefault(self._key(it), it['id'])
        self.shown_open = {it['id']: EV2.canon(it) for it in r['open']}
        an = self.analysis()
        self.last_cov = EV2.canon(an['coverage'])
        self.last_client = EV2.canon(an['client']) if an['client'] is not None else None
        for body, cur in zip(r['pages'][1:], r['cursors'][1:]):
            self.pages[cur] = (body, 'evidence')
            self.page_ids[cur] = [o['id'] for o in evidence_obs]
        self.log.append({'id': 'evidence', 'kind': 'initial', 'pages': len(r['pages']), 'bytes': list(r['page_bytes']), 'open_total': len(r['open'])})
        return r['pages'][0], len(r['pages'])

    def _shadow(self, obs, header, env):
        """The harness-only shadow of one EPUB result (leakguard-media-2): the same header and sections, its facts from the blanked observation, every open
        item over the blanked observations, and the summaries, in ONE body (all pages).  It reads no state it changes."""
        blank = [blank_media(o) for o in self.shown]
        an = analyze(blank, self.context, self.media_type)
        d = an['items'][obs['id']]
        items = LK.attach_links(LK.open_items(an, self.media_type), self.capabilities, [internal(o) for o in blank], self.tools, self.media_type)
        core = EV2.item_core(d)
        units, details = [], {}
        for sec in ('conflicts', 'findings'):
            for v in core.get(sec) or []:
                units += EV2.explode((sec,), v, 'append', self.lim)
        for k, v in (core.get('scope') or {}).items():
            units += EV2.explode(('scope', k), v, 'set', self.lim)
        facts, presence, kinds, report = item_facts_v31(internal(blank[-1]), d)
        if facts:
            units += EV2.facts_units(('facts',), facts, details, obs['id'], self.lim)
        for key, val in (('presence', presence), ('kinds', kinds), ('report', report)):
            if val:
                units.append(((key,), 'set', val))
        for it in items:
            units.append((('open',), 'append', EV2.externalize(copy.deepcopy(it), 'open', details, self.lim)))
        for k, v in an['coverage'].items():
            units += EV2.explode(('coverage', k), v, 'set', self.lim)
        if an['client'] is not None:
            for k, v in an['client'].items():
                units += EV2.explode(('client_comparison', k), v, 'set', self.lim)
        units += EV2.detail_units(details, self.lim)
        return env(EV2.assemble(dict(header, alerts=EV2.alerts_for([d])), units)[0])

    def result(self, obs, call_id, remaining, suffix=''):
        """-> (wire text of the first page, number of pages).  Format v3's tool result with the v3.1 facts, `kinds` and `report`."""
        self.shown.append(obs)
        an = self.analysis()
        d = an['items'][obs['id']]
        items = self._open_items(an)
        mine = [it['id'] for it in items if obs['id'] in it['sources']]
        core = EV2.item_core(d)
        shown_tool = display_tool(d.obs)
        header = {'id': obs['id'], 'tool': shown_tool}
        if core.get('args'):
            header['args'] = core['args']
        if core.get('backend'):
            header['backend'] = core['backend']
        header['alerts'] = EV2.alerts_for([d])
        header['open_total'] = len(items)
        header['page'] = None
        header['execution'] = d.execution
        units, details = [], {}
        for sec in ('conflicts', 'findings'):
            for v in core.get(sec) or []:
                units += EV2.explode((sec,), v, 'append', self.lim)
        if d.veto:
            units.append((('veto',), 'set', d.veto))
        for k, v in (core.get('scope') or {}).items():
            units += EV2.explode(('scope', k), v, 'set', self.lim)
        if mine:
            units.append((('open_ids',), 'set', mine))
        facts, presence, kinds, report = item_facts_v31(internal(obs), d)
        if facts:
            units += EV2.facts_units(('facts',), facts, details, obs['id'], self.lim)
        if presence:
            units.append((('presence',), 'set', presence))
        if kinds:
            units.append((('kinds',), 'set', kinds))
        if report:
            units.append((('report',), 'set', report))
        now = {it['id']: EV2.canon(it) for it in items}
        for it in items:
            if self.shown_open.get(it['id']) != now[it['id']]:
                units.append((('open',), 'append', EV2.externalize(copy.deepcopy(it), 'open', details, self.lim)))
        removed = [i for i in self.shown_open if i not in now]
        if removed:
            units.append((('open_removed',), 'set', removed))
        self.shown_open = now
        units += self._summary_units(an, False)
        units += EV2.detail_units(details, self.lim)
        truncated = d.execution['output_truncated']
        status = obs['status']

        def env(body):
            return EV2.tool_envelope(call_id, shown_tool, status, truncated, body, remaining, suffix)
        pages = EV2.paginate(header, units, env, self._worst_fetch_envelope(), self.alias, call_id, self.budget)
        self.last_shadow = self._shadow(obs, header, env) if carries_media([obs]) else None      # None: the delivered text is what the legacy check reads
        for body, cur in pages[1:]:
            self.pages[cur] = (body, shown_tool)
            self.page_ids[cur] = [obs['id']]
            self.page_shadow[cur] = self.last_shadow
        self.log.append({'id': call_id, 'kind': 'result', 'pages': len(pages), 'bytes': [EV2.nbytes(env(pages[0][0]))] + [EV2.nbytes(self._worst_fetch_envelope()(b)) for b, _ in pages[1:]],
                         'open_total': len(items)})
        return env(pages[0][0]), len(pages)


# ---------------------------------------------------------------------------------------------------------------- the audit and the record
def without_legacy_heads(obs):
    """The observation the checker reads under v3.1-format: an epub_inspect result without its `spine_heads` (legacy_mixed: they mix the head title, styles and
    navigation with body text, so they never establish content identity here).  Every other observation, and every other field, is unchanged."""
    if obs.get('tool') != 'epub_inspect':
        return obs
    out = obs.get('output')
    try:
        data = json.loads(out) if isinstance(out, str) else (copy.deepcopy(out) if isinstance(out, dict) else None)
    except ValueError:
        return obs
    if not isinstance(data, dict):
        return obs
    inner = data.get('observation') if isinstance(data.get('observation'), dict) and 'recorded_as' in data else data
    if 'spine_heads' not in inner:
        return obs
    inner.pop('spine_heads')
    return dict(obs, output=json.dumps(data, ensure_ascii=False))


def shown_observations(evidence_shown, tool_calls):
    """The observations the model saw, as the unchanged v3 audit reads them: an explicit excerpt typed as a reading (never a package check), and the legacy
    spine heads withheld from the checker (they are not body text)."""
    return [without_legacy_heads(internal(o)) for o in EV3.shown_observations(evidence_shown, tool_calls)]


def action_audit(decision, evidence_shown, tool_calls, context, media_type, capabilities, forced=False):
    """Audit v3 (`evidence_v3.action_audit`'s frozen `targets.audit_v3`, the rubric v3.1 checker) over the v3.1 observations; a record, never a verdict."""
    from .experimental.contract_v3 import targets as TG
    obs = shown_observations(evidence_shown, tool_calls)
    out = TG.audit_v3(decision, obs, context or {}, media_type, capabilities or [])
    proto = out.pop('audit_version', None)
    action = (decision or {}).get('action')
    write = action in RB.ACTIONS and action not in ('none', 'escalate')
    out = dict({'audit_version': EV3.AUDIT_VERSION, 'audit_implementation': proto, 'contract': 'contract-v3', 'checker_rubric': CHECKER_RUBRIC, 'write_intent': write,
                'intent': {'class': (decision or {}).get('class'), 'action': action, 'source': (decision or {}).get('source'), 'target': (decision or {}).get('target')},
                'note': 'recorded proposal only; this harness never executes a write, and nothing was changed' + ('; forced decision' if forced else '')}, **out)
    if out.get('prerequisites') is not None:
        out['unmet'] = [p['id'] for p in out['prerequisites'] if p['state'] != 'met']
    return out


def format_record(session, caps, version=FORMAT_VERSION):
    try:
        an = session.analysis()
        summary = {'coverage': an['coverage'], 'client_comparison': an['client'], 'open': session.open_now()}
    except Exception as e:  # noqa: BLE001 - a summary failure must not lose the run
        summary = {'error': '%s: %s' % (type(e).__name__, e)}
    return dict(CONTRACT, version=version, format_contract=FORMAT_VERSION, wire_bytes=session.budget, capabilities=caps, messages=list(session.log), final_summary=summary,
                excerpt_rules_sha256=ET.rules_digest(),
                note='derived only from the observations shown to the model; no truth, label, provenance or hidden injection field is an input')


validate_decision = EV3.validate_decision
strip_v2_target = EV3.strip_v2_target
