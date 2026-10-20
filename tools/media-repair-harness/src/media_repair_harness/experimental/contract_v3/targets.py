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


def check_contract_combination(prompt_version, evidence_format=None, protocol=None, audit=None, target_semantics=None, guards=None, declared=PROMPTS_DECLARING_V3):
    """Raise ValueError for a combination that mixes contract v3 with anything else.  `declared` lists the prompts that declare contract v3."""
    parts = {'evidence_format': evidence_format, 'protocol': protocol, 'audit': audit, 'target_semantics': target_semantics}
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


def validate_decision_v3(obj):
    """-> list of errors (empty = valid).  Strict: exact keys, one action, source and target only on writes, target of the action's kind."""
    errs = []
    if not isinstance(obj, dict) or obj.get('type') != 'decision':
        return ['not a decision object']
    base = ('type', 'class', 'action', 'reason', 'confidence', 'evidence_refs')
    action = obj.get('action')
    if obj.get('class') not in P.CLASSES:
        errs.append('unknown class')
    if action not in P.ACTIONS:
        errs.append('unknown action')
        return errs
    write = action in P.WRITE_ACTIONS
    allowed = set(base) | ({'source', 'target', 'audit'} if write else set())
    extra = sorted(set(obj) - allowed)
    if extra:
        errs.append('keys not allowed for %s: %s' % (action, ', '.join(extra)))
    missing = [k for k in base if k not in obj]
    if missing:
        errs.append('missing keys: %s' % ', '.join(missing))
    if not write:
        return errs
    src = obj.get('source')
    if not (isinstance(src, dict) and set(src) == {'ref'} and isinstance(src['ref'], str) and src['ref']):
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
        if f != 'allocated_by' and not (isinstance(tgt.get(f), str) and tgt[f]):
            errs.append('target.%s must be a non-empty string' % f)
    if action == 'rename' and isinstance(tgt.get('old_value'), str) and tgt.get('old_value') == tgt.get('new_value'):
        errs.append('rename needs different old and new values')
    return errs


def audit_v3(decision, observations, context=None, media_type=None, capabilities=None):
    """-> the v3 audit of a decision: schema errors, the bound source and target references resolved against the shown ids, and every proposal
    prerequisite's state from prereq.check.  Never a verdict field; executed is false; execution prerequisites are listed for the executor."""
    known = {o['id'] for o in observations}
    errs = validate_decision_v3(decision)
    res = PQ.check(observations, context, media_type, capabilities)
    out = {'audit_version': 'v3-prototype', 'executed': False, 'schema_errors': errs, 'rubric': RB.RUBRIC_VERSION}
    action = decision.get('action') if isinstance(decision, dict) else None
    if action not in P.WRITE_ACTIONS:
        out['execution_status'] = 'no_write_proposed'
        return out
    out['execution_status'] = 'proposed_not_executed'
    refs = {}
    src = (decision.get('source') or {}).get('ref') if isinstance(decision.get('source'), dict) else None
    refs['source.ref'] = 'resolved' if src in known else ('unresolved' if src else 'absent')
    tgt = decision.get('target') if isinstance(decision.get('target'), dict) else {}
    for k in ('source_ref', 'slot_ref', 'slot_free_ref'):
        if k in tgt:
            refs['target.' + k] = 'resolved' if tgt[k] in known else 'unresolved'
    out['references'] = refs
    cls = decision.get('class')
    pre = []
    for p in res['actions'][action]['prerequisites']:
        if p.get('when_class') and p['when_class'] != cls:
            continue
        pre.append({k: p[k] for k in ('id', 'check', 'state', 'refs', 'detail')})
    if action == 'remap':           # the destination's free-slot evidence must be the record the proposal cites
        fs = next((p for p in pre if p['check'] == 'free_slot'), None)
        if fs and fs['state'] == PQ.MET and tgt.get('slot_free_ref') not in fs['refs']:
            fs.update(state=PQ.UNKNOWN, detail='the cited slot_free_ref is not the record that shows the slot free')
    classes = RB.ACTIONS[action]['classes']
    pre.insert(0, {'id': 'A-CLASS', 'check': 'class_for_action', 'state': PQ.MET if cls in classes else PQ.UNMET, 'refs': [], 'detail': 'classes for %s: %s' % (action, ', '.join(classes))})
    out['prerequisites'] = pre
    out['execution_prerequisites'] = res['actions'][action]['execution_prerequisites']
    return out
