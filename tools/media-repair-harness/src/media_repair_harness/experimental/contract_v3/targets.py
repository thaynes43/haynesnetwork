"""Contract v3, hypothesis 2 and A16 item 2 (EXPERIMENTAL): source binding versus action-specific targets, the `decision-v3` schema, the
version-combination rule and an audit v3 prototype.

Source binding (`source.ref`) ties a write proposal to the item under triage; it is not proof of content identity or health.  The target is
action specific: blocklist_and_search the release of the bound source, remap a destination slot (with the evidence that it is free), rename
the source with its old and new values, convert an isolated copy that the EXECUTOR allocates and names (a model-written path or name there is
refused; a missing one is not a missing prerequisite).  Allocation, creation, collision and no-overwrite checks are execution prerequisites.

Protocol turn-v3, schema decision-v3, audit v3 and evidence format v3 form ONE contract version: valid only together and only with a prompt
that declares contract v3.  No shipped prompt does, so every v3 element is refused with v1 to v5 (in particular v5).  With no v3 element the
existing rule (`run.check_option_combination`, unchanged) decides.
"""
from ... import protocol as P
from ... import run as RUN
from . import prereq as PQ
from . import rubric as RB

CONTRACT = {'protocol': 'turn-v3', 'schema': 'decision-v3', 'audit': 'v3', 'evidence_format': 'v3', 'target_semantics': 'v3'}
PROMPTS_DECLARING_V3 = ()          # none shipped; a future prompt joins this list together with its own tests
TARGET_KINDS = {'blocklist_and_search': ('release_of_source', ('source_ref',)), 'remap': ('destination_slot', ('slot_ref', 'slot_free_ref')),
                'rename': ('rename_of_source', ('old_value', 'new_value')), 'convert': ('isolated_copy', ('allocated_by',))}


def check_contract_combination(prompt_version, evidence_format=None, protocol=None, audit=None, target_semantics=None, guards=None, declared=PROMPTS_DECLARING_V3,
                               schema=None):
    """Raise ValueError for a combination that mixes contract v3 with anything else.  `declared` lists the prompts that declare contract v3."""
    parts = {'evidence_format': evidence_format, 'protocol': protocol, 'audit': audit, 'target_semantics': target_semantics, 'schema': schema}
    v3 = {k for k, val in parts.items() if val == CONTRACT[k]}
    if not v3:
        RUN.check_option_combination(prompt_version, evidence_format, guards)       # the existing rule, unchanged
        return
    missing = sorted(k for k in parts if k not in v3)
    if missing:
        raise ValueError('contract v3 is one version: %s set to v3 but %s not (protocol turn-v3, schema decision-v3, audit v3 and evidence format v3 go together)' % (
            ', '.join(sorted(v3)), ', '.join(missing)))
    if prompt_version not in declared:
        raise ValueError('prompt %s does not declare contract v3 (its targets and fields are the v2 contract%s); no shipped prompt does' % (
            prompt_version, ': v5 explains evidence format v2 and the v2 target semantics' if prompt_version == 'v5' else ''))
    if guards is not None:
        raise ValueError('guards %s read the decision-v2 target; contract v3 has no guard version yet' % guards)


REASON_MAX, REF_MAX, REFS_MAX, VALUE_MAX = 400, 16, 12, 200


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def validate_decision_v3(obj):
    """-> list of errors (empty = valid).  Complete and total: every type and range is checked, nothing raises, whatever the input's shape."""
    errs = []
    if not isinstance(obj, dict) or obj.get('type') != 'decision':
        return ['not a decision object']
    base = ('type', 'class', 'action', 'reason', 'confidence', 'evidence_refs')
    cls, action = obj.get('class'), obj.get('action')
    if not (isinstance(cls, str) and cls in P.CLASSES):
        errs.append('class must be one of the classes')
    if not (isinstance(action, str) and action in P.ACTIONS):
        errs.append('action must be one of the actions')
        return errs
    write = action in P.WRITE_ACTIONS
    allowed = set(base) | ({'source', 'target', 'audit'} if write else set())
    extra = sorted(str(k) for k in set(obj) - allowed)
    if extra:
        errs.append('keys not allowed for %s: %s' % (action, ', '.join(extra)))
    missing = [k for k in base if k not in obj]
    if missing:
        errs.append('missing keys: %s' % ', '.join(missing))
    if 'reason' in obj and not (isinstance(obj['reason'], str) and 0 < len(obj['reason']) <= REASON_MAX):
        errs.append('reason must be a non-empty string of at most %d characters' % REASON_MAX)
    if 'confidence' in obj and not (_is_num(obj['confidence']) and 0.0 <= obj['confidence'] <= 1.0):
        errs.append('confidence must be a number from 0 to 1')
    if 'evidence_refs' in obj:
        refs = obj['evidence_refs']
        if not (isinstance(refs, list) and len(refs) <= REFS_MAX and all(isinstance(r, str) and 0 < len(r) <= REF_MAX for r in refs)):
            errs.append('evidence_refs must be a list of at most %d id strings of at most %d characters' % (REFS_MAX, REF_MAX))
    if not write:
        return errs
    src = obj.get('source')
    if not (isinstance(src, dict) and set(src) == {'ref'} and isinstance(src.get('ref'), str) and 0 < len(src['ref']) <= REF_MAX):
        errs.append('a write needs source {"ref": "<evidence id that binds the source>"}')
    kind, fields = TARGET_KINDS[action]
    tgt = obj.get('target')
    if not isinstance(tgt, dict) or tgt.get('kind') != kind:
        errs.append('%s needs target {"kind": "%s", ...}' % (action, kind))
        return errs
    if set(tgt) != {'kind'} | set(fields):
        errs.append('target of kind %s has exactly the keys kind, %s' % (kind, ', '.join(fields)))
    if action == 'convert' and tgt.get('allocated_by') != 'executor':
        errs.append('the isolated copy is allocated and named by the executor (allocated_by "executor"); a model-written destination is refused')
    for f in fields:
        if f != 'allocated_by' and not (isinstance(tgt.get(f), str) and 0 < len(tgt[f]) <= (REF_MAX if f.endswith('_ref') else VALUE_MAX)):
            errs.append('target.%s must be a non-empty string' % f)
    if action == 'rename' and isinstance(tgt.get('old_value'), str) and tgt.get('old_value') == tgt.get('new_value'):
        errs.append('rename needs different old and new values')
    if 'audit' in obj:
        au = obj['audit']
        ok = isinstance(au, dict) and set(au) <= {'preconditions', 'readback', 'verify'}
        ok = ok and all(isinstance(au.get(k), str) and len(au[k]) <= 240 for k in ('readback', 'verify') if k in au)
        ok = ok and ('preconditions' not in au or (isinstance(au['preconditions'], list) and len(au['preconditions']) <= 6 and
                                                    all(isinstance(x, str) and len(x) <= 160 for x in au['preconditions'])))
        if not ok:
            errs.append('audit must be {"preconditions": [<=6 strings of <=160>], "readback": <=240, "verify": <=240}')
    return errs


def _role(v, check, decision, res):
    """The A31-9 role checks: a cited reference qualifies for the role it fills; rename values are visible / agree with the catalog."""
    src = decision['source']['ref']
    tgt = decision['target']
    if check == 'source_ref_qualifies':
        st, refs, det = PQ.check_named(v, 'source_bound')
        if st == PQ.MET and src in refs:
            return PQ.MET, [src], 'the cited source record binds the source'
        if st == PQ.MET:
            return PQ.UNMET, [src], 'the cited source reference is not a record that binds the source (those are: %s)' % ', '.join(refs)
        return st, [src], det
    if check == 'release_ref_is_source':
        ok = tgt.get('source_ref') == src
        return (PQ.MET if ok else PQ.UNMET), [tgt.get('source_ref')], 'the release target is the bound source' if ok else 'the release target is not the cited source record'
    if check == 'slot_refs_are_destination':
        st, refs, _ = PQ.check_named(v, 'free_slot')
        _dst, _m, _content, recs = v.destinations()          # destination RECORDS only: a content observation never fills a slot role
        ok = tgt.get('slot_ref') in recs and tgt.get('slot_free_ref') in recs and (st != PQ.MET or tgt.get('slot_free_ref') in refs)
        return (PQ.MET if ok else PQ.UNMET), [tgt.get('slot_ref'), tgt.get('slot_free_ref')], 'the cited slot records are destination records' if ok else 'a cited slot reference is not a destination record'
    if check == 'old_value_visible':
        old = tgt.get('old_value')
        visible = []
        fname = v.context.get('filename')
        if isinstance(fname, str):
            visible.append(('context.filename', fname))
        surface = RB.NAMING_SURFACE.get(v.media_type, ('file_name',))
        visible += [(ref, text) for ref, kind, field, text in v.statements() if kind == 'declaration' and field in surface]
        hit = [ref for ref, text in visible if PQ.norm(text) == PQ.norm(old)]
        return (PQ.MET if hit else PQ.UNMET), hit, 'the old value is a visible current naming-surface value' if hit else 'the old value matches no visible current name'
    if check == 'new_value_agrees':
        attrs = v.compare('declaration', 'file_name', tgt.get('new_value'))
        ok = attrs.get('title') == 'agree' and 'disagree' not in attrs.values()
        return (PQ.MET if ok else PQ.UNMET), ['context.expected'], 'the new value agrees with the catalog on every attribute it names' if ok else 'the new value does not agree with the catalog (%s)' % attrs
    raise KeyError(check)


def audit_v3(decision, observations, context=None, media_type=None, capabilities=None):
    """-> the v3 audit of a decision.  A schema error stops it BEFORE any reference is resolved.  For a write: the class's diagnosis prerequisites, the
    action prerequisites and the role checks (A31-9), each with its state; executed is false; execution prerequisites are listed for the executor."""
    errs = validate_decision_v3(decision)
    out = {'audit_version': 'v3-prototype', 'executed': False, 'schema_errors': errs, 'rubric': RB.RUBRIC_V31_VERSION}
    if errs:
        out['execution_status'] = 'refused_invalid_decision'
        return out
    action = decision['action']
    if action not in P.WRITE_ACTIONS:
        out['execution_status'] = 'no_write_proposed'
        return out
    out['execution_status'] = 'proposed_not_executed'
    v = PQ.View(observations, context, media_type, capabilities)
    res = PQ.check_view(v)
    known = {o['id'] for o in observations} | {RB.UNMANAGED_SOURCE_REF}
    tgt = decision['target']
    refs = {'source.ref': 'resolved' if decision['source']['ref'] in known else 'unresolved'}
    for k in ('source_ref', 'slot_ref', 'slot_free_ref'):
        if k in tgt:
            refs['target.' + k] = 'resolved' if tgt[k] in known else 'unresolved'
    out['references'] = refs
    cls = decision['class']
    classes = RB.ACTIONS[action]['classes']
    pre = [{'id': 'A-CLASS', 'check': 'class_for_action', 'state': PQ.MET if cls in classes else PQ.UNMET, 'refs': [], 'detail': 'classes for %s: %s' % (action, ', '.join(classes))}]
    pre += [{k: p[k] for k in ('id', 'check', 'state', 'refs', 'detail')} for p in res['diagnosis'].get(cls, [])]          # A31-9: the diagnosis too
    for p in res['actions'][action]['prerequisites']:
        if p.get('when_class') and p['when_class'] != cls:
            continue
        pre.append({k: p[k] for k in ('id', 'check', 'state', 'refs', 'detail')})
    for req in RB.ROLE_PREREQUISITES[action]:
        st, rr, det = _role(v, req['check'], decision, res)
        pre.append({'id': req['id'], 'check': req['check'], 'state': st, 'refs': [r for r in rr if r is not None], 'detail': det})
    out['prerequisites'] = pre
    out['execution_prerequisites'] = res['actions'][action]['execution_prerequisites']
    return out
