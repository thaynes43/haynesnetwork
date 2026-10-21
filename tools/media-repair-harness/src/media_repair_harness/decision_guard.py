"""Deterministic decision guards (dev-c4, opt-in `--guards v1`, default off).

Post-decision checks that look at the model's FINAL decision and at what the model could see (the case's own evidence and the run's tool
results), never at the model's wording and never at a case id, title or label.  They are conservative: a guard can only turn a decision into
`insufficient_evidence` / `escalate`, it never creates a write or a diagnosis.  The model does not see them (they run after the last turn).
The model's original decision is kept in the run record's `guard` field:

  guard = {version, applied: [{rule, original: <the model's full decision>, reason}], final_changed}

`guard` is present only when guards are on (`applied` is empty when none fired); with guards off the record has no such key and is byte-identical
to a dev-c3-shaped record.  The record's `decision`, `action_audit`, `decision_flags`, `bad_evidence_refs`, `refs_to_*` and `evidence.gaps_cited`
describe the FINAL decision; `forced` keeps its meaning (the harness forced the decision after a failed repair) and is not set by a guard.

Rules
  G-healthy  A `healthy` / `none` decision when the model-visible evidence holds no integrity check that ran with status `ok`.  Integrity checks
             are by evidence type: a probe (ffprobe), a decode or sampled decode (decode_sample, audio_sample), a package or archive check
             (epub_inspect) and an audiobook stream check (audiobook_inspect).  Identity and title records (arr_lookup, ocr, prior_record, a
             frame handle) are not integrity checks.  A result that failed, timed out, was partial or unavailable, or was an injected failure, does not
             count as ok.  It never fires when at least one ok integrity check exists, whatever else is missing: that is a healthy control with
             partial but representative checks (evaluator ruling C2).  It covers both case-provided evidence and the run's tool results.
  G-write    A write action (blocklist_and_search, remap, rename, convert) when (a) a precondition the audit COMPUTES from the case data is unmet
             (`action_audit.preconditions` with basis `computed`, except the text-matching `target_in_context`; a precondition that only rests on the
             model's claim text is never acted on), or
             (b) no evidence_refs entry points to a result usable as support for a defect: an `ok` result of a tool or of case-provided evidence, or
             damage a tool that ran reported about the file itself.  (b) is the audit's `cited_evidence_supports` check; whether the cited text really
             shows a defect is not decided here, only that the model cited something that ran.

Both rules are small on purpose.  The `reason` of the final decision names the guard.

Guards v3 (W18, `--guards v3`, any prompt; v1 and v2 are unchanged)
  G-healthy v3  Examines ALL shown evidence (the case's own and the run's tool results) with the typed layer of `evidence_v2`: a KNOWN integrity defect
                (decoder errors, damaged container or package, a collector's input failure) contradicts `healthy` / `none` even next to clean results, in any
                order; an `ok` result that reports a defect is not clean; an unknown field is neither clean nor damaged, and without at least one clean
                integrity result there is nothing to support healthy.  It never infers whole-file health from a clean sample and it can only abstain.  The reason
                names the finding kind, its location and the observation id; the model's decision stays in `guard.applied[].original`.
  G-write v3    Exactly the v2 relaxations.

Contract v3 (dev-c6, `--evidence-format v3 --prompt v6`): guards v3 apply UNCHANGED to a decision-v3 decision.  G-healthy v3 reads the class, the action and
the shown observations; G-write reads the class, the action, evidence_refs and the context (its `target_named` check is met by the decision-v3 target object
the validator requires, and the audit-object checks belong to turn protocol v2 only), so contract v3 needs no new guard version.  The only difference is the
shape of the escalate a guard writes: under turn protocol v3 it carries no target (none and escalate have neither source nor target in decision-v3).  A v3
record's derived fields use audit v3 (evidence_v3.action_audit).

Guards v4 (dev-c8, `--guards v4`, evidence format v3.1-format only; offline on contract-v3 records through apply_to_record, driven by
  scripts/guards_v4_whatif.py: `mrh-guard` is a pinned input of the dev-c7 qwen-r2 registration and stays unchanged, so it refuses v4)
  Guards v3 run first and UNCHANGED.  When neither fires, G-role checks the role prerequisites of a decision-v3 write on audit v3 (the same
  `targets.audit_v3` as the record's audit), recomputed over the observations delivered to the model, with source.ref resolved through page origins.
  The prerequisite ids, the failure predicates and the unknown/unmet mapping are FROZEN in V4_SPEC below (fixed before any outcome count was looked at,
  AUDIT-ASTRA-36 item 1).  Only an audit state `unmet` can fire, and only when its predicate is enforceable: `unknown` never fires (the exemption is for these
  v4 checks only), and an `unmet` that rests on content the comparator could not recognise, or on a result whose pages were not all delivered, is recorded as
  `unrecognized` / `undelivered` and does not fire.  Declarations and prior-record claims are never promoted to content (the checker's statement kinds decide).
  Every role check is recorded in `guard.role_checks`, fired or not.
"""
import copy
import json
import re

from . import audit as AU
from . import evidence_v2 as EV2
from . import gaps as GP
from . import protocol as P
from . import tools as T

GUARD_VERSION = 'v1'          # the version a bare `--guards v1` means and the one measured in runs/dev-c4; v1 behaviour never changes
GUARD_VERSIONS = ('v1', 'v2', 'v3')          # what `mrh-guard` (a pinned registration input) offers: unchanged, so it never offers v4
ALL_GUARD_VERSIONS = GUARD_VERSIONS + ('v4',)  # dev-c8: what the runner (`--guards`, contract-v3 formats only for v4) and `apply` accept
RULE_HEALTHY = 'G-healthy'
RULE_WRITE = 'G-write'
RULE_ROLE = 'G-role'

# ---- guards v4 (dev-c8): FROZEN specification -------------------------------------------------------------------------------------------------------
V4_SPEC = {
    'version': 'v4',
    'frozen': '2026-10-21, before any dev-c7 outcome count was computed (AUDIT-ASTRA-36 item 1)',
    'inherits': 'guards v3 (G-healthy v3, G-write v3) unchanged and evaluated first',
    'scope': 'a write decision of decision-v3 (it carries source and target) on a contract-v3 record (evidence format v3 or v3.1-format)',
    'audit': 'targets.audit_v3 (the rubric v3.1 checker of the record audit) over the shown observations; source.ref resolved through page origins first',
    'prerequisites': {
        'A-REN-1': 'identity_level == content_verified (rename)',
        'A-REN-0': 'source_bound (rename)', 'A-BLK-2': 'source_bound (blocklist_and_search)', 'A-MAP-2': 'source_bound (remap)', 'A-CNV-0': 'source_bound (convert)',
        'A-BLK-1': 'managed_app (blocklist_and_search)', 'A-MAP-1': 'managed_app (remap)',
        'R-SRC': 'source_ref_qualifies (every write)',
    },
    'states': {
        'met': 'pass',
        'unknown': 'unknown: never fires',
        'unmet': 'fires (enforced) unless one of the non-enforcement predicates below holds',
    },
    'predicates': {
        'managed_app unmet': 'enforced: context.arr.app is not a managing app (the context is part of the first message, always delivered)',
        'source_bound unmet': 'enforced: a complete managed record of this item links a different file; undelivered if any such record was not fully delivered',
        'source_ref_qualifies unmet, unmanaged item': 'enforced: with context.arr.app null the source is case_item and the cited source is not',
        'source_ref_qualifies unmet, managed item': 'enforced: the cited source (after page-origin resolution) is not a shown record that binds the source; '
                                                    'undelivered if a deciding record was not fully delivered',
        'identity_level unmet, contradicted_by_content': 'enforced: a recognised content observation disagrees with the catalog on an identity attribute',
        'identity_level unmet, any content row the comparator did not recognise': 'unrecognized: a content observation that matched no catalog value at all may '
                                                                                  'carry the identity the comparator cannot read; not enforced',
        'identity_level unmet, contested': 'enforced: a declaration disagrees on an identity or edition attribute and no recognised content settles it',
        'identity_level unmet, uncontradicted': 'enforced (missing): no content observation agrees with the catalog on an identity attribute',
        'any role check, a result with undelivered pages': 'undelivered: not enforced (only delivered evidence is evaluated)',
    },
    'not_enforced': ('unknown', 'unrecognized', 'undelivered'),
}
V4_PREREQUISITES = tuple(V4_SPEC['prerequisites'])
# computed audit checks the guard does not act on: `target_in_context` matches the model's free-text target against the case's identifiers and calls a
# target "broad" when it also names a series or an id of a wider scope, so a correct, specific target written in another form fails it (seen in the
# offline what-if).  It stays in the record's action_audit; it just is not a reason to overrule a decision.
TEXT_MATCH_CHECKS = ('target_in_context',)
# evidence types that are integrity checks.  frame_sample (a handle to a recorded frame), ocr (on-screen text), arr_lookup and prior_record
# (catalog / identity records) are not.
INTEGRITY_TOOLS = ('ffprobe', 'decode_sample', 'audio_sample', 'epub_inspect', 'audiobook_inspect')


def sources(evidence_shown, tool_calls):
    """[{id, tool, status, source}] for every result the model could see: case-provided evidence as shown, then the run's tool calls.  Only the status the
    model saw is read (an injected failure comes back as error, timeout or partial, so it never counts as ok); the harness-side `injected` flag is not."""
    out = [{'id': e.get('id'), 'tool': e.get('tool'), 'status': e.get('status', 'ok'), 'source': 'evidence'} for e in evidence_shown or []]
    out += [{'id': c.get('id'), 'tool': c.get('tool'), 'status': c.get('status'), 'source': 'tool_call'} for c in tool_calls or []]
    return out


def ok_integrity_checks(evidence_shown, tool_calls):
    return [s for s in sources(evidence_shown, tool_calls) if s['tool'] in INTEGRITY_TOOLS and s['status'] == 'ok']


def guard_escalation(rule, detail):
    d = P.forced_decision('')   # same shape as every escalate decision the harness writes
    d['reason'] = ('guard %s (not the model): %s' % (rule, detail))[:400]
    return d


def check_healthy(decision, evidence_shown, tool_calls):
    """-> reason string when G-healthy fires, else None."""
    if decision.get('class') != 'healthy' or decision.get('action') != 'none':
        return None
    if ok_integrity_checks(evidence_shown, tool_calls):
        return None
    seen = sorted({'%s:%s' % (s['tool'], s['status']) for s in sources(evidence_shown, tool_calls) if s['tool'] in INTEGRITY_TOOLS})
    return 'healthy/none with no integrity check (probe, decode, package or audiobook check) that ran with status ok in the evidence%s' % (
        '; integrity results seen: ' + ', '.join(seen) if seen else '; none was offered or run')


def shown_observations(evidence_shown, tool_calls):
    """Observations (evidence_v2 narrow interface) for every result the model could see: case evidence as shown, then the run's tool calls.  Only the
    status, the text and the actual backend are read (an injected failure comes back as the error, timeout or partial result the model saw)."""
    obs = [EV2.make_observation(e.get('id'), e.get('tool'), e.get('args'), e.get('status', 'ok'), e.get('output'), None, 'case') for e in evidence_shown or []]
    for c in tool_calls or []:
        if c.get('continuation'):    # a page fetch is not an observation
            continue
        obs.append(EV2.make_observation(c.get('id'), c.get('tool'), EV2.safe_args(c.get('args')), c.get('status'), c.get('raw_output', c.get('output')), c.get('mode'), 'tool',
                                        bool(c.get('collector_truncated'))))
    return obs


def check_healthy_v3(decision, evidence_shown, tool_calls):
    """Guards v3 G-healthy: examines ALL shown initial evidence and tool findings.  A known integrity defect contradicts healthy even next to clean
    observations (it is not outvoted); an `ok` result that reports a defect does not count as clean; unknown fields are neither clean nor damaged; and
    without at least one clean integrity result nothing supports healthy.  Whole-file health is never inferred from a clean sample: this guard only
    abstains.  -> reason string when it fires, else None."""
    if decision.get('class') != 'healthy' or decision.get('action') != 'none':
        return None
    state = EV2.integrity_findings(shown_observations(evidence_shown, tool_calls))
    if state['damaged']:
        oid, f = state['damaged'][0]
        where = f.get('location') or {}
        loc = ', '.join('%s %s' % (k, v) for k, v in where.items() if v is not None)
        return 'healthy/none while an integrity result reports a defect (%s in %s%s); a clean observation does not outvote it' % (f['kind'], oid, (' at ' + loc) if loc else '')
    if state['clean']:
        return None
    seen = sorted({'%s:%s' % (s['tool'], s['status']) for s in sources(evidence_shown, tool_calls) if s['tool'] in INTEGRITY_TOOLS})
    return 'healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence%s' % (
        '; integrity results seen: ' + ', '.join(seen) if seen else '; none was offered or run')


# guards v2 (offline-measured relaxations of G-write; v1 stays exactly as measured):
#   full_decode_ok     convert works on an isolated copy and the contract does not require a clean full decode, so it is not a reason to overrule;
#   no_failed_tool_cited  citing a failed tool next to valid support (cited_evidence_supports is met) is not a reason to overrule.
V2_IGNORED = ('full_decode_ok',)


def check_write(case, decision, tool_calls, prompt_version, forced=False, version='v1', shown=None):
    """-> reason string when G-write fires, else None.  Only checks the audit computes from the case data count (basis `computed`).  Guards v3 reads the audit-v2 support
    (an error result supports a write only through a typed positive damage finding, never an execution failure); v1 and v2 keep the shape-based support."""
    if decision.get('action') not in P.WRITE_ACTIONS:
        return None
    audit = AU.compute(case, decision, tool_calls, forced=forced, prompt_version=prompt_version, v4_tables=True,        # the guard reads the dev-c4 tables whatever prompt ran
                       audit_version='v2' if version == 'v3' else 'v1', shown=shown if version == 'v3' else None)
    unmet = [c['id'] for c in audit['preconditions'] if c.get('basis') == 'computed' and not c.get('met') and c['id'] not in TEXT_MATCH_CHECKS]
    if version != 'v1':   # v3 keeps the v2 G-write relaxations (the contract has no clean-full-decode prerequisite for an isolated copy)
        unmet = [i for i in unmet if i not in V2_IGNORED and not (i == 'no_failed_tool_cited' and 'cited_evidence_supports' not in unmet)]
    if not unmet:
        return None
    return '%s proposed with unmet computed precondition(s): %s' % (decision.get('action'), ', '.join(unmet))


def record_resolver(record, evidence_shown):
    """The resolver for a run record: a format-v2 record cites finding ids (`t1.f1`) that this run emitted, recomputed here from the same observations by the same
    typed layer; any other record resolves nothing (references are never rewritten)."""
    if not (record or {}).get('evidence_format'):
        return lambda refs: list(refs or [])
    obs = shown_observations(evidence_shown, (record or {}).get('tool_calls'))
    known = [o['id'] for o in obs]
    return EV2.reference_resolver(known, EV2.emitted_ids(EV2.analyze(obs, {})), EV2.page_origin_map((record or {}).get('tool_calls')))


def v4_context(context, media_type, capabilities, messages, tool_calls, evidence_format, evidence_ids=None, wire_texts=None):
    """What G-role needs beyond the decision: the model-visible context, media type and capability advertisement (audit v3's inputs), the evidence format (which
    typed layer built the observations) and the ids whose pages were not all delivered: from the page log AND from the page objects of the messages
    actually sent (`wire_texts`; post-freeze correction 2, docs/dev-c8.md section 4: the log counts the pages a message was cut into for retrieval, and a
    message whose other pages cannot be fetched says "n of N" only on the wire)."""
    gone = set(undelivered_ids(messages, tool_calls, evidence_ids))
    if wire_texts is not None:
        gone |= wire_undelivered(wire_texts, evidence_ids)
    return {'context': context or {}, 'media_type': media_type, 'capabilities': list(capabilities or []), 'format': evidence_format,
            'undelivered': sorted(gone)}


PAGE_KEY_RX = re.compile(r'"page"\s*:\s*\{')


def wire_pages(texts):
    """{message id: {'of': N, 'seen': {page numbers}}} from the page objects (`page.source`, `page.n`, `page.of`) in the texts sent to the model."""
    dec = json.JSONDecoder()
    out = {}
    for text in texts or []:
        if not isinstance(text, str):
            continue
        for m in PAGE_KEY_RX.finditer(text):
            try:
                obj, _end = dec.raw_decode(text, m.end() - 1)
            except ValueError:
                continue
            src, n, of = obj.get('source'), obj.get('n'), obj.get('of')
            if isinstance(src, str) and isinstance(n, int) and isinstance(of, int) and not isinstance(n, bool) and of >= 1:
                rec = out.setdefault(src, {'of': of, 'seen': set()})
                rec['of'] = max(rec['of'], of)
                rec['seen'].add(n)
    return out


def wire_undelivered(texts, evidence_ids=None):
    """Ids whose message reached the model in fewer pages than it has (unfetched, or not fetchable at all): `evidence` stands for every case evidence id."""
    out = set()
    for src, rec in wire_pages(texts).items():
        if len(rec['seen']) < rec['of']:
            out |= set(evidence_ids or ['evidence']) if src == 'evidence' else {src}
    return out


TRANSCRIPT_SPLIT_RX = re.compile(r'\n\n(?=\[(?:CASE|HARNESS|YOUR PREVIOUS REPLY)\]\n)')


def record_wire_texts(record):
    """The texts the harness sent, read back from the last recorded request (it carries the whole conversation for every adapter): the user messages of a
    message list, or the CASE / HARNESS blocks of a rendered transcript (the model's own earlier replies are left out)."""
    for turn in reversed((record or {}).get('turns') or []):
        req = turn.get('raw_request')
        if isinstance(req, dict) and isinstance(req.get('messages'), list):
            return [m.get('content') for m in req['messages'] if isinstance(m, dict) and m.get('role') == 'user']
        if isinstance(req, dict) and isinstance(req.get('prompt'), str):
            return [b for b in TRANSCRIPT_SPLIT_RX.split(req['prompt']) if not b.startswith('[YOUR PREVIOUS REPLY]')]
    return None


def _page_key(pages_of, evidence_ids):
    """The message a page fetch belongs to.  The runner records `pages_of` as a LIST of origin ids (session.page_origin): a page of a tool result names that one
    result; a page of the first message names case evidence ids only.  (A bare string, an older shape, names one result.)"""
    if isinstance(pages_of, str):
        return pages_of
    ids = [x for x in pages_of or [] if isinstance(x, str)]
    if not ids:
        return None
    if evidence_ids is not None and set(ids) <= set(evidence_ids):
        return 'evidence'
    if evidence_ids is None and all(x.startswith('e') for x in ids):
        return 'evidence'
    return ids[0] if len(ids) == 1 else None


def undelivered_ids(messages, tool_calls, evidence_ids=None):
    """Ids of results the model did not receive in full: a message of n pages of which fewer than n were delivered (the first page plus one per distinct page
    cursor fetched).  The first message (`evidence`) stands for every case evidence id; when they are not given, the marker `evidence` is returned."""
    fetched = {}
    for c in tool_calls or []:
        po = c.get('pages_of')
        if not (c.get('continuation') and po):
            continue
        key = _page_key(po, evidence_ids)
        if key is None:
            continue
        fetched.setdefault(key, set()).add(str((c.get('args') or {}).get('cursor') or c.get('id')))
    out = set()
    for m in messages or []:
        if m.get('kind') not in ('initial', 'result'):
            continue
        pages = m.get('pages') or 1
        key = 'evidence' if m.get('kind') == 'initial' else m.get('id')
        if pages > 1 + len(fetched.get(key, ())):
            out |= set(evidence_ids or ['evidence']) if key == 'evidence' else {key}
    return out


def _v4_obs(ctx, evidence_shown, tool_calls):
    if ctx.get('format') == 'v3.1-format':
        from . import evidence_v31 as EVX
    else:
        from . import evidence_v3 as EVX
    return EVX.shown_observations(evidence_shown, tool_calls)


def _ref_obs(ref):
    """The observation id a checker reference names (`e1:files[0]` -> e1, `t2:tags_empty` -> t2, `context.filename` -> None)."""
    if not isinstance(ref, str) or ref.startswith(('context.', 'client_comparison', 'coverage')) or ref == 'case_item':
        return None
    return ref.split(':')[0].split('.')[0]


def _deciding(check, v, rows, source_ref):
    """The observation ids a role check reads: identity reads every identity-bearing statement; the source checks read every catalog record and the cited
    source; a managing app reads the context only."""
    if check == 'identity_level':
        return {_ref_obs(r['ref']) for r in rows} - {None}
    if check in ('source_bound', 'source_ref_qualifies'):
        return ({o['id'] for o in v.of_tool('arr_lookup')} | {_ref_obs(source_ref)}) - {None}
    return set()


def check_role_v4(decision, ctx, evidence_shown, tool_calls):
    """Guards v4 G-role (V4_SPEC, frozen).  -> (reason or None, role_checks).  Never fires on a non-write, on a decision without a source (not decision-v3) or
    on a decision the decision-v3 validator refuses."""
    if not isinstance(decision, dict) or decision.get('action') not in P.WRITE_ACTIONS or not isinstance(decision.get('source'), dict):
        return None, []
    from .experimental.contract_v3 import prereq as PQ
    from .experimental.contract_v3 import targets as TG
    obs = _v4_obs(ctx, evidence_shown, tool_calls)
    origins = EV2.page_origin_map(tool_calls)
    src = decision['source'].get('ref')
    resolved = origins[src][0] if (src in origins and len(origins[src]) == 1) else src
    dec = dict(decision, source=dict(decision['source'], ref=resolved))
    audit = TG.audit_v3(dec, obs, ctx.get('context') or {}, ctx.get('media_type'), ctx.get('capabilities') or [])
    if audit.get('schema_errors'):
        return None, []
    v = PQ.View(obs, ctx.get('context') or {}, ctx.get('media_type'), ctx.get('capabilities') or [])
    level, rows, _per = v.identity()
    shown_ids = {o['id'] for o in obs}
    undelivered = set(ctx.get('undelivered') or [])
    if 'evidence' in undelivered:
        undelivered |= {e.get('id') for e in evidence_shown or []}
    managed = ((ctx.get('context') or {}).get('arr') or {}).get('app') in PQ.ARR_APPS
    checks = []
    for pre in audit.get('prerequisites') or []:
        if pre['id'] not in V4_PREREQUISITES:
            continue
        state, check, refs = pre['state'], pre['check'], list(pre.get('refs') or [])
        status, why = None, ''
        deciding = _deciding(check, v, rows, resolved)
        if deciding & undelivered:     # post-freeze correction 2: unread content decides nothing, and the state computed from it is not recorded either
            state, refs = None, sorted(deciding & undelivered)
            status, why = 'undelivered', 'a deciding result was not fully delivered: %s' % ', '.join(refs)
        elif state == PQ.MET:
            status = 'met'
        elif state != PQ.UNMET:
            status, why = 'unknown', pre.get('detail') or ''
        elif check == 'managed_app':
            status, why = 'enforced', 'no managing app in the context'
        elif check == 'source_bound':
            deciding = {_ref_obs(r) for r in refs} - {None}
            status, why = ('undelivered', 'a deciding record was not fully delivered') if deciding & undelivered else ('enforced', pre.get('detail') or '')
        elif check == 'source_ref_qualifies':
            if not managed:
                status, why = 'enforced', 'an item without a managing app has the source case_item; the cited source is %s' % resolved
            else:
                _st, brefs, _d = PQ.check_named(v, 'source_bound')
                deciding = ({_ref_obs(r) for r in brefs} | {_ref_obs(resolved)}) - {None}
                status, why = (('undelivered', 'a deciding record was not fully delivered') if deciding & undelivered else
                               ('enforced', 'the cited source %s is not a shown record that binds this file%s' % (
                                   resolved, '' if resolved in shown_ids or resolved == 'case_item' else ' (no result with that id was shown)')))
        elif check == 'identity_level':
            content = [r for r in rows if r['kind'] in PQ.CONTENT_KINDS]
            unrecognized = [r['ref'] for r in content if not r['attributes']]
            row_obs = {_ref_obs(r['ref']) for r in rows} - {None}
            if row_obs & undelivered:
                status, why = 'undelivered', 'an identity-bearing result was not fully delivered'
            elif level == 'contradicted_by_content':
                refs = [r['ref'] for r in content if 'disagree' in r['attributes'].values()]
                status, why = 'enforced', 'content disagrees with the catalog on an identity attribute'
            elif unrecognized:
                status, why = 'unrecognized', 'content the comparator could not match to any catalog value: %s' % ', '.join(unrecognized[:4])
            elif level == 'contested':
                refs = [r['ref'] for r in rows if 'disagree' in r['attributes'].values()]
                status, why = 'enforced', 'a declaration disagrees on an identity or edition attribute and no content settles it'
            else:
                status, why = 'enforced', 'missing: no content observation agrees with the catalog on an identity attribute (identity %s)' % level
        else:
            status, why = 'unknown', 'no v4 predicate for check %s' % check
        checks.append({'id': pre['id'], 'check': check, 'audit_state': state, 'v4_status': status, 'refs': refs, 'detail': why})
    fired = [c for c in checks if c['v4_status'] == 'enforced']
    if not fired:
        return None, checks
    return ('%s with unmet role prerequisite(s): %s' % (decision.get('action'), '; '.join('%s (%s)' % (c['id'], c['detail']) for c in fired)))[:360], checks


def apply(case, decision, tool_calls, evidence_shown, prompt_version, forced=False, version=GUARD_VERSION, resolve=None, v4ctx=None):
    """-> (final_decision, guard_record).  The input decision is never modified.  `resolve` (the one reference resolver) normalises the references the checks read;
    the original decision, with its references as written, is what the record keeps.  v4: the v3 checks first, unchanged; then G-role when `v4ctx` (a
    contract-v3 run's context, see v4_context) is given."""
    if version not in ALL_GUARD_VERSIONS:
        raise ValueError('unknown guard version %r (known: %s)' % (version, ', '.join(ALL_GUARD_VERSIONS)))
    original = decision
    if resolve is not None and decision:
        decision = dict(decision, evidence_refs=resolve(decision.get('evidence_refs')))
    applied = []
    base = 'v3' if version == 'v4' else version          # v4 inherits v3 exactly
    reason = check_healthy_v3(decision, evidence_shown, tool_calls) if base == 'v3' else check_healthy(decision, evidence_shown, tool_calls)
    rule = RULE_HEALTHY
    if reason is None:
        reason = check_write(case, decision, tool_calls, prompt_version, forced, base, evidence_shown)
        rule = RULE_WRITE
    role_checks = None
    if version == 'v4':
        role_checks = []
        if reason is None and v4ctx is not None and decision:
            reason, role_checks = check_role_v4(decision, v4ctx, evidence_shown, tool_calls)
            rule = RULE_ROLE
    if reason is not None:
        applied.append({'rule': rule, 'original': copy.deepcopy(original), 'reason': reason})
        final = guard_escalation(rule, reason)
        if _protocol(prompt_version) == 'v3':
            final.pop('target', None)        # decision-v3: an escalate has no target
    else:
        final = original
    rec = {'version': version, 'applied': applied, 'final_changed': bool(applied)}
    if role_checks is not None:          # v4 only: every role check, fired or not (a v1 to v3 guard record keeps its shape)
        rec['role_checks'] = role_checks
        if v4ctx is None:
            rec['role_note'] = 'G-role not evaluated: not a contract-v3 run'
    return final, rec


def _protocol(prompt_version):
    try:
        return P.protocol_of(prompt_version)
    except ValueError:
        return None


def derived_fields(case, decision, tool_calls, evidence_shown, evidence_mode, prompt_version, forced, outcome_step, resolve=None, v2=False, v3=None, v3fmt='v3'):
    """Record fields that are computed from the decision (run_case computes the same ones); used when a guard replaced it.  For a format-v2 record the references go
    through the same resolver and the audit is audit v2, as in the run; for a format-v3 record (`v3` = its recorded capabilities) the audit is audit v3."""
    ev_ids = {e['id'] for e in evidence_shown}
    call_ids = {c['id'] for c in tool_calls}
    refs = resolve(decision.get('evidence_refs', [])) if resolve else decision.get('evidence_refs', [])
    if v3 is not None:
        # format v3 (dev-c6) and v3.1-format (dev-c7) share audit v3; v3.1 types an explicit EPUB excerpt as a reading, exactly as its run did
        if v3fmt == 'v3.1-format':
            from . import evidence_v31 as EV3
        else:
            from . import evidence_v3 as EV3
        view = P.case_view(case, [])
        action_audit = EV3.action_audit(dict(decision, evidence_refs=refs), evidence_shown, tool_calls, view['context'], view['media_type'], v3, forced=forced)
    elif v2:
        action_audit = AU.compute(case, dict(decision, evidence_refs=refs), tool_calls, forced=forced, prompt_version=prompt_version, audit_version='v2', shown=evidence_shown)
    else:
        action_audit = AU.compute(case, decision, tool_calls, forced=forced, prompt_version=prompt_version)
    action_audit['outcome_step'] = outcome_step
    return {
        'decision_flags': AU.decision_flags(decision, AU.unverified_parts(case, tool_calls)),
        'bad_evidence_refs': sorted(r for r in refs if r not in ev_ids and r not in call_ids),
        'refs_to_failed_tools': sorted(set(refs) & {c['id'] for c in tool_calls if c['status'] in ('error', 'timeout') and c.get('injected')}),
        'refs_to_non_ok_tools': sorted(set(refs) & AU.non_ok_evidence_ids(case, tool_calls)),
        'action_audit': action_audit,
        'evidence': GP.evidence_summary(case, tool_calls, evidence_mode, decision, live_kinds=T.LIVE_KINDS),
    }


def _v3_caps(record):
    """The recorded capability advertisement of a format-v3 record (what its audit v3 reads), else None."""
    ef = (record or {}).get('evidence_format')
    return list(ef.get('capabilities') or []) if isinstance(ef, dict) and ef.get('version') in V3_FORMATS else None


V3_FORMATS = ('v3', 'v3.1-format')     # the evidence formats whose records carry audit v3


def _v3_format(record):
    return ((record or {}).get('evidence_format') or {}).get('version') if isinstance((record or {}).get('evidence_format'), dict) else None


def apply_to_record(record, case, evidence_shown, version=GUARD_VERSION):
    """Offline: a COPY of a run record with the guards applied.  Always carries `guard`; when a guard fires, the decision and the fields
    derived from it are replaced and the model's original stays in `guard.applied[].original`.  A record that was already guarded is first
    returned to the model's own decision, so guarding never stacks and another guard version can be applied to a guarded run."""
    if version == 'v4' and _v3_format(record) not in V3_FORMATS:
        raise ValueError('guards v4 checks decision-v3 roles and applies to contract-v3 records only (record %s)' % (record or {}).get('case_id'))
    rec = copy.deepcopy(record)
    if rec.get('guard'):
        rec = restore_original(rec, case, evidence_shown)
        rec.pop('guard')
    pv = (rec.get('prompt') or {}).get('version') or P.DEFAULT_PROMPT
    resolve = record_resolver(rec, evidence_shown)
    v4ctx = record_v4_context(rec, case, evidence_shown) if version == 'v4' else None
    final, guard = apply(case, rec['decision'], rec.get('tool_calls') or [], evidence_shown, pv, bool(rec.get('forced')), version, resolve=resolve, v4ctx=v4ctx)
    rec['guard'] = guard
    if guard['final_changed']:
        rec['decision'] = final
        outcome_step = (rec.get('action_audit') or {}).get('outcome_step')
        rec.update(derived_fields(case, final, rec.get('tool_calls') or [], evidence_shown, rec.get('evidence_mode', 'replay'), pv,
                                  bool(rec.get('forced')), outcome_step, resolve, bool(rec.get('evidence_format')), _v3_caps(rec), _v3_format(rec)))
    return rec


def record_v4_context(record, case, evidence_shown):
    """G-role's inputs for an existing contract-v3 record (None for any other record): the context and media type as the model saw them, the recorded capability
    advertisement and the recorded messages (pages sent)."""
    fmt = _v3_format(record)
    if fmt not in V3_FORMATS:
        return None
    view = P.case_view(case, [])
    ctx = v4_context(view['context'], view['media_type'], _v3_caps(record), (record.get('evidence_format') or {}).get('messages'), record.get('tool_calls'), fmt)
    ev_ids = [e.get('id') for e in evidence_shown or []]
    gone = undelivered_ids((record.get('evidence_format') or {}).get('messages'), record.get('tool_calls'), ev_ids)
    texts = record_wire_texts(record)
    if texts is not None:
        gone |= wire_undelivered(texts, ev_ids)
    ctx['undelivered'] = sorted(gone)
    return ctx


def restore_original(record, case, evidence_shown):
    """Offline, the inverse view: a COPY of a guarded record with the model's original decision back (and the fields derived from it), so a guarded
    run can also be scored as if guards had been off.  The `guard` field stays, marked `restored`."""
    rec = copy.deepcopy(record)
    guard = rec.get('guard')
    if not guard:
        raise ValueError('record %s has no guard field' % rec.get('case_id'))
    if guard['final_changed']:
        orig = guard['applied'][0]['original']
        pv = (rec.get('prompt') or {}).get('version') or P.DEFAULT_PROMPT
        rec['decision'] = copy.deepcopy(orig)
        rec.update(derived_fields(case, orig, rec.get('tool_calls') or [], evidence_shown, rec.get('evidence_mode', 'replay'), pv,
                                  bool(rec.get('forced')), (rec.get('action_audit') or {}).get('outcome_step'), record_resolver(rec, evidence_shown), bool(rec.get('evidence_format')),
                                  _v3_caps(rec), _v3_format(rec)))
    rec['guard'] = dict(guard, restored=True)
    return rec
