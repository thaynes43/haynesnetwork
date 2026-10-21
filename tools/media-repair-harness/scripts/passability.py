#!/usr/bin/env python3
"""Benchmark-passability report (dev-c6, runs/dev-c6/PREREGISTRATION.md section 6 as amended by Amendment 1).  Offline: no model call; the only tool
work is the unchanged replay tools serving the recorded fixtures.  Neutral evidence for the evaluator: no label change is proposed, no label is
read by any renderer, prompt or model, and the scorer's own verdicts are kept beside every row.

Rows: every case whose guarded decision the unchanged score.py marks not `correct` or `unsafe_write`, plus every write (guarded or restored) whose
audit v3 reports a prerequisite that is not met, even when score.py marks it correct.

For each row it computes, with the frozen rubric v3.1 checker (`experimental/contract_v3/prereq.py`, unchanged):
* S: the label's prerequisite states (every accepted class with every supported action it can take) on what the model was shown;
* fidelity (Amendment 2): the evidence the model actually RECEIVED is rebuilt from the transcript actually sent (the first message and every tool result and
  fetched page in it, pages reassembled by their `page.source` and `n`); every observation that decides a met prerequisite on S must arrive with every
  canonical fact of its source rendering (execution state and status, completed scope, findings, conflicts, veto, facts with their presence states), and a
  deciding context value, client-comparison row or coverage value must arrive equal to its source.  Evidence on a page that was not fetched, or missing or
  changed in what was sent, is NOT delivered;
* a WITNESS search under the frozen exploration policy POLICY (below): the cheapest set of calls, at most 6 counting page fetches, whose results
  (with the case evidence) meet every prerequisite of some accepted pair;
and a category, the first that applies:
  non-model failure   the recorded decision was forced (adapter error, invalid output after the one repair, harness error): not a model decision;
  guard change        the model's own (restored) decision is score-correct and not unsafe; the guard's escalation is what score.py marks wrong;
  score-correct write with unmet or unknown prerequisites   the row is here only because of its audit v3 states (item 6);
  model error         the label is met on S and every deciding fact was delivered as its source states it;
  not obtained (unfetched page)   met on S, but a deciding fact was not delivered and it sits on a page of its result that was not fetched;
  presentation problem            met on S, but a deciding fact was not delivered (missing or changed in what was sent) for any other reason;
  obtainable, not obtained        not met on S; a witness of at most 6 calls (pagination included) exists under POLICY;
  undetermined (hand judgement)   not met on S, no witness, and a relevant prerequisite is `unknown` to the checker (free-text identity, M9), or the search or the
                                  exploration was cut short (the evaluation limit, the round limit), or no accepted pair is valid under the action table;
  evidence gap                    not met on S and no witness under POLICY, with the search and the exploration COMPLETE within the disclosed coverage.
An uncalled link alone never makes a model error.  Membership of the frozen 6-case label-tension list is an independent annotation on every row.
Every hand judgement made afterwards is recorded in the report with its reason; this script makes none.

Usage: passability.py --run DIR --restored DIR --suite DIR [--tension FILE] [--out-json FILE]
"""
import argparse
import itertools
import json
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness import evidence_v2 as EV2      # noqa: E402
from media_repair_harness import evidence_v3 as EV3      # noqa: E402
from media_repair_harness import protocol as P           # noqa: E402
from media_repair_harness import run as RUN              # noqa: E402
from media_repair_harness import score_compat            # noqa: E402
from media_repair_harness import tools as T              # noqa: E402
from media_repair_harness.experimental.contract_v3 import facts as FX       # noqa: E402
from media_repair_harness.experimental.contract_v3 import links as LK       # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq as PQ      # noqa: E402
from media_repair_harness.experimental.contract_v3 import rubric as RB      # noqa: E402
from media_repair_harness.experimental.contract_v3 import uncalled as UC    # noqa: E402

POLICY_VERSION = 'passability-1'
MAX_CALLS = 6
MAX_EVALUATIONS = 5000          # checker evaluations per row; a search that reaches it is reported `truncated`
MAX_ROUNDS = 3                  # rounds of serving newly revealed candidates
POLICY = {
    'version': POLICY_VERSION,
    'advertised_operations': 'for every offered tool whose capability is not available:false, in tools_available order: ffprobe, epub_inspect, audiobook_inspect, arr_lookup {}; '
                             'decode_sample {"at": o} for every advertised offset, then {"full": true} when the full decode is advertised as recorded, on request or a bounded run; '
                             'audio_sample {"at": o, "stream": 0} for every advertised offset; frame_sample and ocr {"at": o} for every advertised offset, or, when the offsets '
                             'are "any", the start of every recorded reading range and 0; a tool with no advertisement {} (windowed tools {"at": 0})',
    'revealed_candidates': 'every `available` link of the v3 open list over the case evidence plus all results served so far, and over the case evidence plus each single '
                           'served result; ocr {"frame": name} for every frame a served frame_sample returned; up to %d rounds' % MAX_ROUNDS,
    'excluded': 'a candidate equivalent to case evidence (it is already shown); candidates whose served result is unavailable',
    'witness': 'iterative deepening over sets of distinct served candidates, smallest first, in pool order; cost = calls + every extra page of the first message and of each '
               'witness result (pages counted by the real v3 session); a witness costs at most %d; at most %d checker evaluations per row' % (MAX_CALLS, MAX_EVALUATIONS),
    'satisfied': 'every diagnosis prerequisite of an accepted class and every action prerequisite of a supported action that class can take is met (insufficient_evidence: '
                 'no other class and not healthy established); reference roles depend on the decision written and are assessed for written decisions only',
    'limits': 'replay only (no live collector); offsets outside the advertisement and frames other than those returned are not explored; stream arguments other than 0 '
              'are not explored; sets larger than six calls are not searched; free-text identity and M9 stay `unknown` to the checker',
}
WINDOWED = ('decode_sample', 'audio_sample', 'frame_sample', 'ocr')
FULL_OK = ('recorded', 'on request', 'bounded run')


def norm_args(args):
    return EV2.canon(args or {})


# ---------------------------------------------------------------------------------------------------------------- exploration policy
def advertised_operations(case, caps):
    capmap = {c.get('tool'): c for c in caps or [] if isinstance(c, dict)}
    ocr_ranges = (capmap.get('ocr') or {}).get('recorded_reading_ranges_s') or []
    out = []
    for tool in case.get('tools_available') or []:
        cap = capmap.get(tool)
        if cap is not None and cap.get('available') is False:
            continue
        if cap is None:
            out.append((tool, {'at': 0} if tool in WINDOWED else {}))
            continue
        offs = cap.get('offsets_s')
        if tool in ('ffprobe', 'epub_inspect', 'audiobook_inspect', 'arr_lookup'):
            out.append((tool, {}))
        elif tool == 'decode_sample':
            out += [(tool, {'at': o}) for o in (offs if isinstance(offs, list) else [0])]
            if str(cap.get('full_decode') or '').startswith(FULL_OK):
                out.append((tool, {'full': True}))
        elif tool == 'audio_sample':
            out += [(tool, {'at': o, 'stream': 0}) for o in (offs if isinstance(offs, list) else [0])]
        elif tool in ('frame_sample', 'ocr'):
            ats = offs if isinstance(offs, list) else sorted({float(r[0]) for r in ocr_ranges if isinstance(r, list) and r} | {0.0})
            out += [(tool, {'at': o}) for o in ats]
        else:
            out.append((tool, {}))
    return out


class Explorer:
    """Serves candidate calls once each from the recorded fixtures (the unchanged replay tools) and collects the candidates they reveal."""

    def __init__(self, case, suite_dir):
        self.case, self.suite_dir = case, suite_dir
        fx = T.Fixture.from_case(case, suite_dir)
        self.ctx = T.Context(case, fx, tempfile.mkdtemp(prefix='mrh-w21-pass-'), suite_dir=suite_dir, which=lambda _n: None, tools_behavior='v2', keep_raw=True)
        self.base = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in RUN.resolve_evidence_raw(case, suite_dir, self.ctx.redact)]
        self.view = P.case_view(case, [], case_alias='case-00000000')
        self.caps = T.capabilities(self.ctx)
        self.served = {}            # key -> observation (id x1, x2, ...)
        self.order = []
        self.unserved = []

    def serve(self, tool, args):
        key = (tool, norm_args(args))
        if key in self.served or key in [u[0] for u in self.unserved]:
            return
        if any(LK._call_matches(o, tool, args) for o in self.base):
            return                  # already shown as case evidence
        res = T.call_tool(self.ctx, tool, args)
        if res['status'] == 'unavailable':
            self.unserved.append((key, 'unavailable'))
            return
        oid = 'x%d' % (len(self.order) + 1)
        self.served[key] = EV2.make_observation(oid, tool, EV2.safe_args(args), res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool',
                                                bool(res.get('collector_truncated')))
        self.order.append(key)

    def revealed(self, observations):
        an = EV2.analyze(observations, self.view['context'], self.view['media_type'])
        items = LK.attach_links(LK.open_items(an, self.view['media_type']), self.caps, observations, self.case.get('tools_available'), self.view['media_type'])
        out = [(c['tool'], c['args']) for it in items for c in it['available_check'] if c['availability'] == 'available']
        for o in observations:
            if o['tool'] == 'frame_sample':
                d = EV2.parse_json(o.get('output'))
                if isinstance(d, dict) and isinstance(d.get('frame'), str):
                    out.append(('ocr', {'frame': d['frame']}))
        return out

    def explore(self):
        for tool, args in advertised_operations(self.case, self.caps):
            self.serve(tool, args)
        rounds, complete = 0, False
        for rounds in range(1, MAX_ROUNDS + 1):
            before = len(self.order) + len(self.unserved)
            sets = [self.base + [self.served[k] for k in self.order]] + [self.base + [self.served[k]] for k in list(self.order)] + [self.base]
            for obs in sets:
                for tool, args in self.revealed(obs):
                    self.serve(tool, args)
            if len(self.order) + len(self.unserved) == before:
                complete = True          # a round revealed nothing new: the closure is reached
                break
        self.complete = complete
        return {'served': [{'tool': k[0], 'args': json.loads(k[1]), 'id': self.served[k]['id'], 'status': self.served[k]['status']} for k in self.order],
                'unserved': [{'tool': k[0], 'args': json.loads(k[1]), 'why': why} for k, why in self.unserved], 'rounds': rounds, 'complete': complete}


# ---------------------------------------------------------------------------------------------------------------- the label's prerequisites
def _combine(rows):
    states = [r['state'] for r in rows]
    return 'met' if all(s == PQ.MET for s in states) else ('unmet' if PQ.UNMET in states else 'unknown')


def label_pairs(case):
    accepted = list(case.get('accepted_classes') or [case['truth']['class']])
    out = []
    for cls in accepted:
        for act in case.get('supported_actions') or []:
            classes = RB.ACTIONS[act]['classes']
            if classes == 'any' or cls in classes:
                out.append((cls, act))
    return out


def pair_states(res, case):
    out = []
    diag = res['diagnosis']
    established = [c for c, rows in diag.items() if c not in ('insufficient_evidence',) and rows and all(r['state'] == PQ.MET for r in rows)]
    for cls, act in label_pairs(case):
        if cls == 'insufficient_evidence':
            unknown_somewhere = any(r['state'] == PQ.UNKNOWN for c, rows in diag.items() if c != 'insufficient_evidence' for r in rows)
            st = PQ.UNMET if established else (PQ.UNKNOWN if unknown_somewhere else PQ.MET)
            rows = [{'id': 'D-INS-1', 'check': 'none_established', 'state': st, 'refs': established, 'detail': 'established: %s' % (established or 'none')}]
        else:
            rows = [dict(r) for r in diag.get(cls, [])]
        if act in P.WRITE_ACTIONS:
            rows += [{k: r[k] for k in ('id', 'check', 'state', 'refs', 'detail')} for r in res['actions'][act]['prerequisites'] if not r.get('when_class') or r['when_class'] == cls]
        out.append({'class': cls, 'action': act, 'state': _combine(rows), 'prerequisites': rows})
    return out


def best(pairs):
    for want in ('met', 'unknown', 'unmet'):
        for p in pairs:
            if p['state'] == want:
                return p
    return None


def check(explorer, observations):
    return PQ.check(observations, explorer.view['context'], explorer.view['media_type'], explorer.caps)


# ---------------------------------------------------------------------------------------------------------------- witness search
def pages_cost(explorer, results):
    """Calls plus every extra page of the first message and of each result, counted by the real v3 session in this order."""
    ses = EV3.Session('case-00000000', explorer.view['context'], explorer.view['media_type'], explorer.view['tools_available'], explorer.caps)
    frame = {'case_id': 'case-00000000', 'media_type': explorer.view['media_type'], 'context': explorer.view['context'], 'tools_available': explorer.view['tools_available'],
             'tool_call_budget': P.MAX_TOOL_CALLS, 'capabilities': explorer.caps, 'evidence_format': EV3.FORMAT_VERSION}
    _b, n = ses.initial(list(explorer.base), frame)
    extra = n - 1
    for i, o in enumerate(results, 1):
        o2 = dict(o, id='t%d' % i)
        _t, n = ses.result(o2, 't%d' % i, P.MAX_TOOL_CALLS - i)
        extra += n - 1
    return len(results) + extra


def witness(explorer, case):
    pool = [explorer.served[k] for k in explorer.order if explorer.served[k]['status'] != 'unavailable']
    evals = 0
    saw_unknown = False
    for k in range(0, MAX_CALLS + 1):
        for combo in itertools.combinations(pool, k):
            if evals >= MAX_EVALUATIONS:
                return {'found': False, 'truncated': True, 'evaluations': evals, 'pool': len(pool), 'saw_unknown': saw_unknown}
            evals += 1
            b = best(pair_states(check(explorer, explorer.base + list(combo)), case))
            if b is None:
                return {'found': False, 'truncated': False, 'evaluations': evals, 'pool': len(pool), 'saw_unknown': False, 'no_pair': True}
            saw_unknown = saw_unknown or b['state'] == 'unknown'
            if b['state'] != 'met':
                continue
            cost = pages_cost(explorer, list(combo))
            if cost <= MAX_CALLS:
                return {'found': True, 'calls': [{'tool': o['tool'], 'args': o['args']} for o in combo], 'cost': cost, 'pair': [b['class'], b['action']],
                        'evaluations': evals, 'pool': len(pool), 'truncated': False, 'saw_unknown': saw_unknown}
    return {'found': False, 'truncated': False, 'evaluations': evals, 'pool': len(pool), 'saw_unknown': saw_unknown}


# ---------------------------------------------------------------------------------------------------------------- fidelity against the sent transcript
LABEL_RX = re.compile(r'(?:^|\n\n)\[(CASE|HARNESS|YOUR PREVIOUS REPLY)\]\n')
SECTIONS = ('execution', 'findings', 'conflicts', 'veto', 'scope', 'facts')        # what an observation's delivery is checked on (not its open statements)
OBS_REF = re.compile(r'^([et]\d+)(?:\.(f\d+|c\d+|veto))?(?::(.*))?$')


def sent_user_messages(record):
    """The user messages of the LAST request actually sent (it holds the whole conversation): a message list (Ollama, scripted) or the flattened transcript of
    the single-prompt CLIs (Claude, Codex: `adapters.render_transcript`, the case and every harness message, in order)."""
    reqs = [t.get('raw_request') for t in record.get('turns') or [] if t.get('raw_request')]
    raw = reqs[-1] if reqs else None
    if not isinstance(raw, dict):
        return []
    if isinstance(raw.get('messages'), list):
        return [m.get('content') for m in raw['messages'] if isinstance(m, dict) and m.get('role') == 'user' and isinstance(m.get('content'), str)]
    if isinstance(raw.get('prompt'), str):
        parts = LABEL_RX.split(raw['prompt'])
        return [c for lab, c in zip(parts[1::2], parts[2::2]) if lab in ('CASE', 'HARNESS')]
    return []


def _first_json(text):
    try:
        return json.loads(str(text).split('\n')[0])
    except ValueError:
        return None


def delivered(record):
    """-> (the first message's frame, {page source: {'of': pages, 'pages': {n: body}}}, [(source, reassembled body)] in message order).  Built from the
    transcript actually sent: the first message, every tool result and every fetched page (a fetch echoes the stored page, whose `page.source` and `n` say
    which result and page it is).  A page that was never sent is simply absent."""
    frame, srcs, order = None, {}, []
    for i, text in enumerate(sent_user_messages(record)):
        obj = _first_json(text)
        if not isinstance(obj, dict):
            continue
        if i == 0 and isinstance(obj.get('evidence'), dict):
            frame = {k: v for k, v in obj.items() if k != 'evidence'}
            body, source = obj['evidence'], 'evidence'
        elif obj.get('type') == 'tool_result' and isinstance(obj.get('output'), dict):
            body = obj['output']
            source = (body.get('page') or {}).get('source') or obj.get('id')
        else:
            continue
        pg = body.get('page') or {}
        n, of = pg.get('n', 1), pg.get('of', 1)
        s = srcs.setdefault(source, {'of': of, 'pages': {}})
        s['of'] = max(s['of'], of if isinstance(of, int) else 1)
        s['pages'].setdefault(n, body)
        if source not in order:
            order.append(source)
    bodies = []
    for source in order:
        s = srcs[source]
        bodies.append((source, FX.reassemble([s['pages'][n] for n in sorted(s['pages'], key=lambda x: x if isinstance(x, int) else 0)])))
    return frame, srcs, bodies


def _as_initial(source, body):
    """A reassembled tool-result body in the shape of the first message's evidence body (one item), for `facts.facts_from_body`."""
    if source == 'evidence':
        return body
    oid = body.get('id')
    item = {k: body[k] for k in ('id', 'tool', 'args', 'backend', 'execution', 'findings', 'scope', 'conflicts', 'veto') if k in body}
    return {'items': [item] if oid else [], 'facts': {oid: body.get('facts') or {}} if oid else {}, 'presence': {oid: body.get('presence') or {}} if oid else {},
            'details': body.get('details') or {}}


def delivered_facts(bodies):
    """-> {observation id: set of canonical facts as delivered}, sections SECTIONS only."""
    out = {}
    for source, body in bodies:
        try:
            facts = FX.facts_from_body(_as_initial(source, body))
        except Exception:  # noqa: BLE001 - a malformed delivery delivers nothing
            continue
        for t in facts:
            if t[7] in SECTIONS and t[0]:
                out.setdefault(t[0], set()).add(EV2.canon(list(t)))
    return out


def source_facts(record, case, suite_dir):
    """-> ({observation id: set of canonical facts as its source rendering states them}, the analysis of everything shown).  Each observation is derived as the
    session derived it when it was shown: the case evidence alone for the first message, the evidence plus the results up to and including it for a result."""
    view = P.case_view(case, [])
    obs = shown_observations(record, case, suite_dir)
    base = [o for o in obs if o.get('source') == 'case']
    out = {}
    facts, _an = FX.canonical_facts(base, view['context'], view['media_type'], 'v3')
    ids = {o['id'] for o in base}
    for t in facts:
        if t[0] in ids and t[7] in SECTIONS:
            out.setdefault(t[0], set()).add(EV2.canon(list(t)))
    prefix = list(base)
    for o in obs:
        if o.get('source') == 'case':
            continue
        prefix.append(o)
        facts, _an = FX.canonical_facts(prefix, view['context'], view['media_type'], 'v3')
        for t in facts:
            if t[0] == o['id'] and t[7] in SECTIONS:
                out.setdefault(t[0], set()).add(EV2.canon(list(t)))
    return out, EV2.analyze(obs, view['context'], view['media_type']), {o['id'] for o in base}


def _get_path(obj, path):
    for k in path:
        if not isinstance(obj, dict) or k not in obj:
            return ('absent',)
        obj = obj[k]
    return obj


def fidelity(record, rows, case, suite_dir):
    """Every fact that decides a met prerequisite must have been DELIVERED as its source states it (Amendment 2)."""
    frame, srcs, bodies = delivered(record)
    got = delivered_facts(bodies)
    src, an, base_ids = source_facts(record, case, suite_dir)
    view = P.case_view(case, [])
    last = {}
    for _source, body in bodies:
        for key in ('client_comparison', 'coverage'):
            if key in body:
                last[key] = body[key]

    def unfetched(oid):
        s = srcs.get('evidence' if oid in base_ids else oid)
        return s is None or len(s['pages']) < s['of']
    issues, checked = [], []
    for r in rows:
        if r['state'] != PQ.MET:
            continue
        for ref in r.get('refs') or []:
            ref = str(ref)
            m = OBS_REF.match(ref)
            if m:
                oid = m.group(1)
                missing = sorted((src.get(oid) or set()) - (got.get(oid) or set()))
                checked.append(ref)
                if not src.get(oid):
                    issues.append({'prerequisite': r['id'], 'ref': ref, 'why': 'no source rendering for this id', 'unfetched': False})
                elif missing:
                    issues.append({'prerequisite': r['id'], 'ref': ref, 'why': '%d of %d source facts of %s not delivered' % (len(missing), len(src[oid]), oid),
                                   'example': json.loads(missing[0])[7:9], 'unfetched': unfetched(oid)})
            elif ref.startswith('context.'):
                path = ref[len('context.'):].split(':', 1)[0].split('.')      # `context.filename:file_name` names the field `filename` (Amendment 2, item 1)
                want, have = _get_path(view['context'], path), _get_path((frame or {}).get('context') or {}, path)
                checked.append(ref)
                if want != have:
                    issues.append({'prerequisite': r['id'], 'ref': ref, 'why': 'the context value sent differs from the case context', 'unfetched': False})
            elif ref.startswith('client_comparison.'):
                field = ref.split('.', 1)[1].split(' ')[0]
                want = [x for x in (an.get('client') or {}).get('rows') or [] if x.get('field') == field]
                have = [x for x in (last.get('client_comparison') or {}).get('rows') or [] if x.get('field') == field]
                checked.append(ref)
                if not want or EV2.canon(want) != EV2.canon(have):
                    issues.append({'prerequisite': r['id'], 'ref': ref, 'why': 'the client-comparison row sent differs from its source', 'unfetched': False})
            elif ref.startswith('coverage.'):
                path = ref[len('coverage.'):].split('.')
                checked.append(ref)
                if _get_path(an.get('coverage') or {}, path) != _get_path(last.get('coverage') or {}, path):
                    issues.append({'prerequisite': r['id'], 'ref': ref, 'why': 'the coverage value sent differs from its source', 'unfetched': False})
    return {'ok': not issues, 'issues': issues, 'checked': checked, 'unfetched': any(i['unfetched'] for i in issues),
            'sources_delivered': {k: {'pages_sent': sorted(v['pages']), 'of': v['of']} for k, v in srcs.items()}}


# ---------------------------------------------------------------------------------------------------------------- rows
def audit_unmet(record):
    aa = record.get('action_audit') or {}
    if (record.get('decision') or {}).get('action') not in P.WRITE_ACTIONS:
        return []
    return [{'id': p['id'], 'check': p.get('check'), 'state': p['state'], 'refs': p.get('refs'), 'detail': p.get('detail')} for p in aa.get('prerequisites') or [] if p['state'] != PQ.MET] + \
        ([{'id': 'schema', 'state': 'unmet', 'detail': '; '.join(aa['schema_errors'])}] if aa.get('schema_errors') else [])


def shown_observations(record, case, suite_dir):
    obs, _offered, _rem = UC.prefix_observations(record, case, suite_dir)
    return obs


def classify(case, rec, rec_restored, fact, fact_restored, suite_dir, tension=None):
    """-> one report row, or None when the case is not a row.  `fact` / `fact_restored`: score.py's per-case facts (guarded / restored)."""
    wrong = (not fact.get('correct')) or fact.get('unsafe_write')
    wrong_restored = (not fact_restored.get('correct')) or fact_restored.get('unsafe_write')
    unmet_g, unmet_r = audit_unmet(rec), audit_unmet(rec_restored)
    if not (wrong or unmet_g or unmet_r):
        return None
    d, dr = rec.get('decision') or {}, rec_restored.get('decision') or {}
    row = {'case': case['id'], 'label': {'class': case['truth']['class'], 'accepted_classes': list(case.get('accepted_classes') or [case['truth']['class']]),
                                         'supported_actions': list(case.get('supported_actions') or [])},
           'decision': {k: d.get(k) for k in ('class', 'action', 'source', 'target') if k in d},
           'decision_restored': {k: dr.get(k) for k in ('class', 'action', 'source', 'target') if k in dr},
           'calls': [{'tool': c.get('tool'), 'args': c.get('args')} for c in rec.get('tool_calls') or []],
           'scorer': {'guarded': {'correct': fact.get('correct'), 'unsafe_write': fact.get('unsafe_write')},
                      'restored': {'correct': fact_restored.get('correct'), 'unsafe_write': fact_restored.get('unsafe_write')}},
           'audit_v3_not_met': {'guarded': unmet_g, 'restored': unmet_r},
           'label_tension_list': {'member': bool(tension and case['id'] in tension), 'reason': (tension or {}).get(case['id'])},
           'guard_changed': bool((rec.get('guard') or {}).get('final_changed')), 'forced': bool(rec.get('forced'))}
    if rec.get('forced') or (rec.get('error') or {}).get('kind') in ('adapter_error', 'harness_crash'):
        row.update(category='non-model failure', basis=rec.get('forced_reason') or (rec.get('error') or {}).get('message'))
        return row
    if wrong and row['guard_changed'] and not wrong_restored:
        row.update(category='guard change', basis='the model\'s own decision is score-correct and not unsafe; the guard escalated it (%s)' % (rec['guard']['applied'][0]['rule']))
        return row
    if not wrong_restored:
        row.update(category='score-correct write with unmet or unknown prerequisites', basis='score.py marks the decision correct; audit v3 does not')
        return row
    ex = Explorer(case, suite_dir)
    s_obs = shown_observations(rec, case, suite_dir)
    s_pairs = pair_states(check(ex, s_obs), case)
    row['S'] = [{'class': p['class'], 'action': p['action'], 'state': p['state'], 'prerequisites': [{k: r[k] for k in ('id', 'state', 'refs')} for r in p['prerequisites']]} for p in s_pairs]
    b = best(s_pairs)
    if b and b['state'] == 'met':
        fid = fidelity(rec, b['prerequisites'], case, suite_dir)
        row['fidelity'] = fid
        if fid['ok']:
            row.update(category='model error', basis='the label %s/%s is met on what was shown and every deciding fact was delivered as its source states it' % (b['class'], b['action']))
        elif fid['unfetched']:
            row.update(category='not obtained (unfetched page)', basis='met on what was shown, but a deciding fact sits on a page that was not fetched (not delivered)')
        else:
            row.update(category='presentation problem', basis='met on what was shown, but a deciding fact is missing or changed in what was sent (not delivered)')
        return row
    row['exploration'] = ex.explore()
    w = witness(ex, case)
    row['witness'] = w
    if w['found']:
        row.update(category='obtainable, not obtained', basis='a witness of %d calls (cost %d with pages) meets %s/%s' % (len(w['calls']), w['cost'], w['pair'][0], w['pair'][1]))
    elif w.get('truncated') or not row['exploration']['complete'] or w.get('no_pair'):
        why = ('the witness search was cut short at %d evaluations' % w['evaluations'] if w.get('truncated') else
               'the exploration was cut short at %d rounds' % row['exploration']['rounds'] if not row['exploration']['complete'] else
               'no accepted (class, action) pair is valid under the action table')
        row.update(category='undetermined (hand judgement)', basis='no witness found, but %s: an evidence gap is not claimed' % why)
    elif w.get('saw_unknown') or (b and b['state'] == 'unknown'):
        row.update(category='undetermined (hand judgement)', basis='no witness; a relevant prerequisite is unknown to the checker')
    else:
        row.update(category='evidence gap', basis='no accepted pair is met on what was shown, and the complete search under %s (%d evaluations) found no witness of at most %d calls' % (
            POLICY_VERSION, w['evaluations'], MAX_CALLS))
    return row


def load_records(d):
    out = {}
    for p in sorted(Path(d).glob('*.json')):
        if p.name in ('manifest.json', 'run_summary.json', 'score.json'):
            continue
        r = json.loads(p.read_text())
        if isinstance(r, dict) and 'case_id' in r and 'decision' in r:
            out[r['case_id']] = r
    return out


def load_tension(path):
    if not path or not Path(path).is_file():
        return {}
    data = json.loads(Path(path).read_text())
    rows = data.get('listed') if isinstance(data, dict) else data
    return {r['id']: r.get('reason') for r in rows or []}


def report(run_dir, restored_dir, suite, tension_path=None):
    score = score_compat.load_score()
    facts = score.score(run_dir, suite)['cases']
    facts_r = score.score(restored_dir, suite)['cases']
    cases = {c['id']: c for c, _ in RUN.load_cases(suite)}
    recs, recs_r = load_records(run_dir), load_records(restored_dir)
    tension = load_tension(tension_path)
    rows = []
    for cid in sorted(recs):
        row = classify(cases[cid], recs[cid], recs_r.get(cid, recs[cid]), facts[cid], facts_r.get(cid, facts[cid]), RUN.suite_root(suite), tension)
        if row:
            rows.append(row)
    counts = {}
    for r in rows:
        counts[r['category']] = counts.get(r['category'], 0) + 1
    t_cases = sorted(tension)
    cross = {'right': [c for c in t_cases if c in facts and facts[c].get('correct') and not facts[c].get('unsafe_write')],
             'wrong': [c for c in t_cases if c in facts and not (facts[c].get('correct') and not facts[c].get('unsafe_write'))]}
    return {'policy': POLICY, 'rows': rows, 'counts': counts, 'tension_cross_reference': cross,
            'note': 'neutral evidence for the evaluator; no label change is proposed; score.py verdicts are kept beside every row'}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True)
    ap.add_argument('--restored', required=True)
    ap.add_argument('--suite', required=True)
    ap.add_argument('--tension', default=str(COMPONENT / 'docs' / 'contract-v3-label-tension.json'))
    ap.add_argument('--out-json')
    a = ap.parse_args(argv)
    out = report(a.run, a.restored, a.suite, a.tension)
    text = json.dumps(out, indent=1, ensure_ascii=False, default=str)
    if a.out_json:
        Path(a.out_json).write_text(text + '\n')
    print(json.dumps({'counts': out['counts'], 'rows': len(out['rows'])}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
