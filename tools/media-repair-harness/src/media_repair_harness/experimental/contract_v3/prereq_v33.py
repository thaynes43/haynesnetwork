"""Contract v3 prerequisite checker applying rubric v3.3 (W25, OpenProject #156; EXPERIMENTAL, offline).

`prereq.py` (rubric v3.1) is unchanged and stays the checker of every earlier configuration and record: format v3 and v3.1-format audits, the recorded
dev-c6 and dev-c7 results and the v3.1 tension list all reproduce with it.  This module is a separate, versioned checker.  It reuses every v3.1 check and
changes exactly the three rules rubric v3.3 amends (rubric_v33.AMENDMENTS_V33, written after labels had been read):

* A33-1 (D32-1): a complete live audiobook part whose whole tag map is explicitly `{}` (or `[]`) is an explicitly empty naming surface
  (`<id>:files[<i>]:tags_empty`), as a container-level map already is; no child field is synthesized.
* A33-2 (D32-2): a prior record's kind is report_unknown when its method is negated, missing, names no vocabulary word, or names content words beside
  declaration or hash words (ambiguous about whether content was observed); otherwise the frozen order applies.  The output lists every prior record's
  typing with every class its method matched (`reports`).
* A33-3 (D32-3): the legacy spine heads (`spine_heads`, kind legacy_mixed) are not read as content, so they establish no identity attribute.

The output keeps the v3.1 shape (prerequisite states and the references that decided them, never a verdict, a truth or a label), adds `reports`, and
names its rubric (`contract-v3-rubric-3.3`).  It takes no case object.
"""
import re

from . import facts as FX
from . import prereq as PQ
from . import presence as PR
from . import rubric as RB
from . import rubric_v33 as RB33

MET, UNMET, UNKNOWN = PQ.MET, PQ.UNMET, PQ.UNKNOWN
CHECKER_VERSION = 'prereq-v3.3'
RUBRIC_VERSION = RB33.RUBRIC_V33_VERSION


def report_typing(method):
    """A33-2: -> {'kind', 'matched', 'negated', 'ambiguous'} for a stated evidence_method (None when absent).  Every matched vocabulary class is listed.
    Ambiguous = content words beside declaration or hash words (the method does not say whether content was observed): report_unknown.  Otherwise the
    frozen order of facts.report_kind applies (hash, then declaration, then content; negated or no match: report_unknown)."""
    text = str(method or '')
    negated = bool(re.search(RB.NEGATED_METHOD_RX, text, re.I))
    matched = [k for k, rx in RB.REPORT_METHOD_VOCABULARY if re.search(rx, text, re.I)]
    ambiguous = 'report_content' in matched and len(matched) > 1
    if negated or ambiguous or not matched:
        kind = 'report_unknown'
    else:
        kind = next(k for k in ('report_hash', 'report_declaration', 'report_content') if k in matched)
    return {'kind': kind, 'matched': matched, 'negated': negated, 'ambiguous': ambiguous}


def report_kind(method):
    return report_typing(method)['kind']


class View(PQ.View):
    """The v3.1 view with the A33-2 prior-record kind and without the legacy spine heads (A33-3).  Everything else is PQ.View."""

    def statements(self, incomplete=False):
        tools = {o['id']: o['tool'] for o in self.obs}
        out = []
        for ref, kind, field, text in super().statements(incomplete):
            tool = tools.get(ref)
            if tool == 'epub_inspect' and kind == 'content':
                continue            # A33-3: an epub_inspect content statement is a spine head (legacy_mixed); every EPUB declaration is kept
            if tool == 'prior_record':
                kind = report_kind((self.facts.get(ref) or {}).get('evidence_method'))
                if kind not in PQ.CONTENT_KINDS + PQ.DECLARED_KINDS:
                    continue        # A33-2: an ambiguous or unknown method reports nothing the checker can compare
            out.append((ref, kind, field, text))
        return out

    def reports(self):
        """A33-2: every prior record's typing (complete or not), with the method as stated and every vocabulary class it matched."""
        rows = []
        for o in self.obs:
            if o['tool'] != 'prior_record':
                continue
            f = self.facts.get(o['id']) or {}
            has = isinstance(f, dict) and 'evidence_method' in f
            row = {'ref': o['id'], 'method_presence': PR.state_of(f.get('evidence_method')) if has else PR.ABSENT, 'complete': self.complete(o)}
            if has:
                row['method'] = f.get('evidence_method')
            row.update(report_typing(f.get('evidence_method') if has else None))
            row['v31_kind'] = FX.report_kind(f.get('evidence_method') if has else None)      # what the v3.1 checker derives, shown beside it
            rows.append(row)
        return rows

    def empty_part_maps(self):
        """A33-1: the refs of complete ffprobe / audiobook_inspect results whose part tag map is explicitly {} or []."""
        refs = []
        for o in self.of_tool('ffprobe', 'audiobook_inspect'):
            f = self.facts.get(o['id']) or {}
            for i, el in enumerate(f.get('files') or [] if isinstance(f, dict) else []):
                if isinstance(el, dict) and 'tags' in el and isinstance(el['tags'], (dict, list)) and PR.state_of(el['tags']) == PR.EMPTY:
                    refs.append('%s:files[%d]:tags_empty' % (o['id'], i))
        return refs


def check_named(v, check):
    """-> (state, refs, detail): PQ.check_named, with naming_surface_defect (and new_value, which reads it) under A33-1."""
    if check == 'naming_surface_defect':
        st, refs, det = PQ.check_named(v, check)
        surface = RB.NAMING_SURFACE.get(v.media_type, ('file_name',))
        extra = v.empty_part_maps() if 'tag_title' in surface else []
        refs = sorted(set(refs) | set(extra))
        return (MET, refs, '') if refs else (UNMET, [], det)
    if check == 'new_value':
        cat = v.catalog()
        if not cat['titles']:
            return UNMET, [], 'no catalog name is shown'
        st, refs, _ = check_named(v, 'naming_surface_defect')
        return (MET, ['context.expected'] + refs, '') if st == MET else (UNMET, [], 'the shown name does not differ from the catalog')
    return PQ.check_named(v, check)


def material(v):
    """PQ.material with M6 read by the v3.3 naming check (A33-1); M5 already reads the v3.3 statements through the view."""
    out = PQ.material(v)
    st, refs, _ = check_named(v, 'naming_surface_defect')
    return [PQ._r('M6', 'material', MET if st == MET else UNMET, refs) if m['id'] == 'M6' else m for m in out]


def _diagnose(v, level, mat):
    """PQ._diagnose with every named check read through the v3.3 check_named (the diagnosis table itself is rubric v3.1's, unchanged by v3.3)."""
    diag = {}
    for cls, reqs in RB.RUBRIC_V31['diagnosis'].items():
        if cls == 'healthy':
            continue
        res = []
        for req in reqs:
            c = req['check']
            if c == 'identity_level':
                ok = level in ('uncontradicted', 'content_verified')
                res.append(PQ._r(req['id'], c, MET if ok else UNMET, [], 'identity %s' % level))
            elif c == 'none_established':
                res.append(PQ._r(req['id'], c, UNKNOWN, [], 'follows from the other classes; not computed here'))
            else:
                st, refs, det = check_named(v, c)
                res.append(PQ._r(req['id'], c, st, refs, det))
        diag[cls] = res
    established = [cls for cls, res in diag.items() if cls != 'insufficient_evidence' and res and all(r['state'] == MET for r in res)]
    res = []
    for req in RB.RUBRIC_V31['diagnosis']['healthy']:
        c = req['check']
        if c == 'H1':
            st, refs, det = check_named(v, 'positively_clean')
        elif c == 'H2':
            defects = [f['id'] for o in v.obs for f in v.an['items'][o['id']].findings if f['known_defect']] + [o['id'] + '.veto' for o in v.obs if v.an['items'][o['id']].veto]
            st, refs, det = (UNMET, defects, 'a known defect or veto is shown') if defects else (MET, [], '')
        elif c == 'H3':
            present = [m['id'] for m in mat if m['state'] == MET]
            open_q = [m['id'] for m in mat if m['state'] == UNKNOWN]
            st, refs, det = (UNMET, present, 'material uncertainty present') if present else ((UNKNOWN, open_q, 'judged: ' + ', '.join(open_q)) if open_q else (MET, [], ''))
        elif c == 'H4':
            st, refs, det = (MET, [], 'identity %s' % level) if level in ('uncontradicted', 'content_verified') else (UNMET, [], 'identity %s' % level)
        else:      # H5 (A31-2)
            st, refs, det = (UNMET, established, 'another class is established') if established else (MET, [], '')
        res.append(PQ._r(req['id'], c, st, refs, det))
    diag['healthy'] = res
    return dict(sorted(diag.items(), key=lambda kv: list(RB.DIAGNOSIS).index(kv[0])))


def check(observations, context=None, media_type=None, capabilities=None):
    """-> the v3.1 checker's output shape under rubric v3.3, plus `reports` (A33-2).  States only."""
    return check_view(View(observations, context, media_type, capabilities))


def check_view(v):
    level, rows, per = v.identity()
    mat = material(v)
    diag = _diagnose(v, level, mat)
    acts = {}
    for action, spec in RB.ACTIONS.items():
        res = []
        for req in spec['prerequisites']:
            c = req['check']
            if c == 'identity_level':
                ok = level == req.get('value')
                res.append(dict(PQ._r(req['id'], c, MET if ok else UNMET, [r['ref'] for r in rows if r['kind'] in PQ.CONTENT_KINDS and 'agree' in r['attributes'].values()],
                                      'identity %s' % level), when_class=req.get('when_class')))
            else:
                st, refs, det = check_named(v, c)
                res.append(dict(PQ._r(req['id'], c, st, refs, det), when_class=req.get('when_class')))
        acts[action] = {'prerequisites': res, 'execution_prerequisites': [{'text': t, 'checked_by': 'executor'} for t in spec['execution']]}
    return {'rubric': RUBRIC_VERSION, 'checker': CHECKER_VERSION, 'identity': {'level': level, 'comparisons': rows, 'attributes': per}, 'material': mat,
            'diagnosis': diag, 'actions': acts, 'reports': v.reports()}


def audit(decision, observations, context=None, media_type=None, capabilities=None):
    """The v3 audit (targets.audit_v3's steps: schema first, then the diagnosis, action and role prerequisites of a write) with the v3.3 checker.  Offline
    and record-only: nothing in the runner calls it, and every recorded audit keeps the v3.1 checker it was made with."""
    from . import targets as TG
    errs = TG.validate_decision_v3(decision)
    out = {'audit_version': 'v3-prototype', 'checker': CHECKER_VERSION, 'executed': False, 'schema_errors': errs, 'rubric': RUBRIC_VERSION}
    if errs:
        out['execution_status'] = 'refused_invalid_decision'
        return out
    action = decision['action']
    if action not in TG.P.WRITE_ACTIONS:
        out['execution_status'] = 'no_write_proposed'
        return out
    out['execution_status'] = 'proposed_not_executed'
    v = View(observations, context, media_type, capabilities)
    res = check_view(v)
    known = {o['id'] for o in observations} | {RB.UNMANAGED_SOURCE_REF}
    tgt = decision['target']
    refs = {'source.ref': 'resolved' if decision['source']['ref'] in known else 'unresolved'}
    for k in ('source_ref', 'slot_ref', 'slot_free_ref'):
        if k in tgt:
            refs['target.' + k] = 'resolved' if tgt[k] in known else 'unresolved'
    out['references'] = refs
    cls = decision['class']
    classes = RB.ACTIONS[action]['classes']
    pre = [{'id': 'A-CLASS', 'check': 'class_for_action', 'state': MET if cls in classes else UNMET, 'refs': [], 'detail': 'classes for %s: %s' % (action, ', '.join(classes))}]
    pre += [{k: p[k] for k in ('id', 'check', 'state', 'refs', 'detail')} for p in res['diagnosis'].get(cls, [])]
    for p in res['actions'][action]['prerequisites']:
        if p.get('when_class') and p['when_class'] != cls:
            continue
        pre.append({k: p[k] for k in ('id', 'check', 'state', 'refs', 'detail')})
    for req in RB.ROLE_PREREQUISITES[action]:
        st, rr, det = TG._role(v, req['check'], decision, res)
        pre.append({'id': req['id'], 'check': req['check'], 'state': st, 'refs': [r for r in rr if r is not None], 'detail': det})
    out['prerequisites'] = pre
    out['execution_prerequisites'] = res['actions'][action]['execution_prerequisites']
    return out
