"""Evidence format v3 (dev-c6, opt-in `--evidence-format v3 --prompt v6`): contract v3 wired into the runner as ONE versioned configuration.

Contract v3 (docs/contract-v3.md, rubric v3.0 frozen plus the v3.1 amendment) is one version: evidence format v3 (this module), turn protocol `turn-v3`
and decision schema `decision-v3` (protocol.validate_turn_v3, which uses the frozen `targets.validate_decision_v3`), and audit v3 (`targets.audit_v3`).
They are valid only together and only with prompt v6, the one prompt that declares contract v3 (run.check_option_combination).  Tools behaviour v2 and
the page contract `pages-v1` are reused unchanged, and so is the typed layer of format v2 (`evidence_v2.analyze` and the pagination).

The presentation is the reviewed prototype, reused unchanged from `experimental/contract_v3/` (nothing there is edited):

* the FIRST message is `facts.render` exactly: items without per-item caveats, the explicit empty / null / false / zero values format v2 dropped with a
  `presence` map, one `open` list of deduplicated unresolved statements (every source id kept) with their `available_check` links, the coverage matrix
  and the client comparison once, and the alerts plus `open_total` on every page;
* a TOOL RESULT shows that observation the same way (its execution, findings, conflicts, veto, scope, facts and presence, and `open_ids`, the ids of the
  open items it is a source of), then the open items that are new or changed since they were last shown (`open`) and the ids of those no longer open
  (`open_removed`), and the coverage matrix and the client comparison when they changed, all recomputed from the observations SHOWN so far; `open_total`
  counts every item still open.  An open item keeps its id for as long as its text and scope are unchanged (its sources or links may change);
* a link (`available_check`) is the frozen pure function of the shown observations, the advertised capabilities and the static tool semantics: "this
  offered tool may inspect this scope", never "it will resolve it".  No result, budget, truth or label is an input.

Nothing here classifies or recommends: no output field is a verdict (rubric.FORBIDDEN_FIELDS).
"""
import copy

from . import evidence_v2 as EV2
from .experimental.contract_v3 import facts as FX
from .experimental.contract_v3 import links as LK
from .experimental.contract_v3 import rubric as RB

FORMAT_VERSION = 'v3'
PROTOCOL = 'turn-v3'
DECISION_SCHEMA = 'decision-v3'
AUDIT_VERSION = 'v3'
TOOLS_BEHAVIOR = 'v2'
PAGE_CONTRACT = EV2.PAGE_CONTRACT
WIRE_BYTES = EV2.WIRE_BYTES
MIN_WIRE_BYTES = EV2.MIN_WIRE_BYTES
RUBRIC_VERSION = RB.RUBRIC_V31_VERSION
# the versions one contract-v3 run records (manifest config and every record): the config hash tells the formats apart
CONTRACT = {'contract': 'contract-v3', 'evidence_format': FORMAT_VERSION, 'protocol': PROTOCOL, 'decision_schema': DECISION_SCHEMA, 'audit_version': AUDIT_VERSION,
            'tools_behavior': TOOLS_BEHAVIOR, 'page_contract': PAGE_CONTRACT, 'rubric': RUBRIC_VERSION}


class Session(EV2.Session):
    """Per-case presentation state for format v3.  Inherits from the v2 session what is unchanged: the shown observations, the stored pages, the page fetch
    (`fetch`, `page_origin`), the analysis and the finding index (so references resolve exactly as in format v2)."""

    def __init__(self, alias, context, media_type, tools_offered, capabilities, budget=EV2.WIRE_BYTES):
        super().__init__(alias, context, media_type, tools_offered, budget)
        self.capabilities = list(capabilities or [])
        self.shown_open = {}         # id -> canonical item, as last shown
        self.open_ids = {}           # (text, canonical scope) -> the id it was first shown with

    # ------------------------------------------------------------------ open items with stable ids
    def _key(self, it):
        return (it['text'], EV2.canon(it['scope']))

    def _open_items(self, an):
        items = LK.attach_links(LK.open_items(an, self.media_type), self.capabilities, self.shown, self.tools, self.media_type)
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

    # ------------------------------------------------------------------ the first message
    def initial(self, evidence_obs, frame=None):
        """-> (evidence block dict for the first user message, number of pages): `facts.render` of the case evidence, unchanged."""
        self.shown = list(evidence_obs)
        frame = frame or {}
        r = FX.render(self.shown, self.context, self.media_type, self.tools, self.capabilities, alias=self.alias, budget=self.budget, frame=frame)
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

    # ------------------------------------------------------------------ a tool result
    def result(self, obs, call_id, remaining, suffix=''):
        """-> (wire text of the first page, number of pages)."""
        self.shown.append(obs)
        an = self.analysis()
        d = an['items'][obs['id']]
        items = self._open_items(an)
        mine = [it['id'] for it in items if obs['id'] in it['sources']]
        core = EV2.item_core(d)
        header = {'id': obs['id'], 'tool': obs['tool']}
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
        facts, presence, _added = FX.item_facts_v3(obs, d)
        if facts:
            units += EV2.facts_units(('facts',), facts, details, obs['id'], self.lim)
        if presence:
            units.append((('presence',), 'set', presence))
        now = {it['id']: EV2.canon(it) for it in items}
        for it in items:
            if self.shown_open.get(it['id']) != now[it['id']]:          # new, or its sources / links changed
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
            return EV2.tool_envelope(call_id, obs['tool'], status, truncated, body, remaining, suffix)
        pages = EV2.paginate(header, units, env, self._worst_fetch_envelope(), self.alias, call_id, self.budget)
        for body, cur in pages[1:]:
            self.pages[cur] = (body, obs['tool'])
            self.page_ids[cur] = [obs['id']]
        self.log.append({'id': call_id, 'kind': 'result', 'pages': len(pages), 'bytes': [EV2.nbytes(env(pages[0][0]))] + [EV2.nbytes(self._worst_fetch_envelope()(b)) for b, _ in pages[1:]],
                         'open_total': len(items)})
        return env(pages[0][0]), len(pages)

    def open_now(self):
        """The open items over everything shown so far (for the record's final summary)."""
        return self._open_items(self.analysis())


# ---------------------------------------------------------------------------------------------------------------- decisions and the v3 audit
def validate_decision(obj):
    """decision-v3: the frozen validator (`targets.validate_decision_v3`), complete and total."""
    from .experimental.contract_v3 import targets as TG
    return TG.validate_decision_v3(obj)


def strip_v2_target(decision):
    """A harness-written escalate (a forced decision, a guard escalation) in the decision-v3 shape: none and escalate carry no target."""
    if decision is None:
        return None
    out = dict(decision)
    if out.get('action') in ('none', 'escalate') and out.get('target') is None:
        out.pop('target', None)
    return out


def shown_observations(evidence_shown, tool_calls):
    """The observations the model saw (case evidence, then the run's tool results; a page fetch is not one), as the v3 audit reads them."""
    obs = [EV2.make_observation(e.get('id'), e.get('tool'), e.get('args'), e.get('status', 'ok'), e.get('output'), None, 'case') for e in evidence_shown or []]
    for c in tool_calls or []:
        if c.get('continuation'):
            continue
        obs.append(EV2.make_observation(c.get('id'), c.get('tool'), EV2.safe_args(c.get('args')), c.get('status'), c.get('raw_output', c.get('output')), c.get('mode'), 'tool',
                                        bool(c.get('collector_truncated'))))
    return obs


def action_audit(decision, evidence_shown, tool_calls, context, media_type, capabilities, forced=False):
    """The record's `action_audit` under contract v3: the frozen `targets.audit_v3` (every diagnosis, action and role prerequisite with its state and the
    references that decided it; executed false; the execution prerequisites listed for the executor), plus the intent.  Prerequisite states are a record,
    never a verdict: the audit changes no decision."""
    from .experimental.contract_v3 import targets as TG
    obs = shown_observations(evidence_shown, tool_calls)
    out = TG.audit_v3(decision, obs, context or {}, media_type, capabilities or [])
    proto = out.pop('audit_version', None)
    action = (decision or {}).get('action')
    write = action in RB.ACTIONS and action not in ('none', 'escalate')
    out = dict({'audit_version': AUDIT_VERSION, 'audit_implementation': proto, 'contract': 'contract-v3', 'write_intent': write,
                'intent': {'class': (decision or {}).get('class'), 'action': action, 'source': (decision or {}).get('source'), 'target': (decision or {}).get('target')},
                'note': 'recorded proposal only; this harness never executes a write, and nothing was changed' + ('; forced decision' if forced else '')}, **out)
    if out.get('prerequisites') is not None:
        out['unmet'] = [p['id'] for p in out['prerequisites'] if p['state'] != 'met']
    return out


def format_record(session, caps, version=FORMAT_VERSION):
    """Record field of a format-v3 run: the versions, the capability advertisement, the pages and sizes actually sent, and the final coverage, client comparison
    and open items over everything shown."""
    try:
        an = session.analysis()
        summary = {'coverage': an['coverage'], 'client_comparison': an['client'], 'open': session.open_now()}
    except Exception as e:  # noqa: BLE001 - a summary failure must not lose the run
        summary = {'error': '%s: %s' % (type(e).__name__, e)}
    return dict(CONTRACT, version=version, format_contract=FORMAT_VERSION, wire_bytes=session.budget, capabilities=caps, messages=list(session.log), final_summary=summary,
                note='derived only from the observations shown to the model; no truth, label, provenance or hidden injection field is an input')
