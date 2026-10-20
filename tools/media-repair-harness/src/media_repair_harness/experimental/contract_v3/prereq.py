"""Contract v3 prerequisite checker (EXPERIMENTAL): the frozen rubric's diagnosis and action prerequisites, checked against ACTUAL observations.

Every check reads values, execution state, scope, statement kind and provenance -- never only the kind of observation -- and returns a state
(`met`, `unmet`, `unknown`) with the fact references that decided it.  A clean decode is integrity and never establishes identity; a tag, a
reported hash or a reported declaration never becomes observed content; an absent field is not an empty one.  The output carries prerequisite
states only: no `sufficient`, `solvable`, recommended action, truth or label (rubric.FORBIDDEN_FIELDS), and it takes no case object.
"""
import re
import unicodedata

from ... import evidence_v2 as EV2
from . import facts as FX
from . import presence as PR
from . import rubric as RB

MET, UNMET, UNKNOWN = 'met', 'unmet', 'unknown'
ARR_APPS = ('sonarr', 'radarr', 'lidarr', 'readarr', 'bookshelf', 'lazylibrarian')
EPISODE_RX = re.compile(r'\bs(\d{1,3})\s*e(\d{1,4})\b|\bseason\s+(\d{1,3})\s+episode\s+(\d{1,4})\b', re.I)
CHOICE_KEYS = ('series_order', 'library_episode_order', 'wanted_edition', 'monitored_edition')


def norm(text):
    t = unicodedata.normalize('NFKD', str(text))
    t = ''.join(ch for ch in t if not unicodedata.combining(ch)).casefold()
    return ' '.join(re.sub(r'[^0-9a-z]+', ' ', t).split())


def contains(hay, needle):
    h, n = norm(hay).split(), norm(needle).split()
    if not n or not h:
        return False
    return any(h[i:i + len(n)] == n for i in range(len(h) - len(n) + 1))


def markers(text):
    out = []
    for m in EPISODE_RX.finditer(str(text)):
        s, e = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
        out.append((int(s), int(e)))
    return out


class View:
    """What the checker may read: the shown observations, the model-visible context and media type, and the advertised capabilities."""

    def __init__(self, observations, context=None, media_type=None, capabilities=None):
        self.obs = list(observations)
        self.context = context or {}
        self.media_type = media_type
        self.caps = list(capabilities or [])
        self.an = EV2.analyze(self.obs, self.context, media_type)
        self.facts = {o['id']: FX.item_facts_v3(o, self.an['items'][o['id']])[0] for o in self.obs}
        self.presence = {o['id']: {r['path']: r['presence'] for r in PR.observation_presence(o)} for o in self.obs}

    def of_tool(self, *tools):
        return [o for o in self.obs if o['tool'] in tools]

    def ran_ok(self, o):
        d = self.an['items'][o['id']]
        return d.execution['state'] == 'ran' and d.execution['status'] == 'ok'

    # ------------------------------------------------------------------ catalog identity values
    def catalog(self):
        exp = self.context.get('expected') or {}
        titles, eps, ep_titles, authors = [], [], [], []
        for k in ('title', 'series', 'story'):
            if exp.get(k):
                titles.append(str(exp[k]))
        titles += [str(a) for a in exp.get('aliases') or [] if a]
        if exp.get('episode_title'):
            ep_titles.append(str(exp['episode_title']))
        if isinstance(exp.get('season'), int) and isinstance(exp.get('episode'), int):
            eps.append((exp['season'], exp['episode']))
        if exp.get('author'):
            authors.append(str(exp['author']))
        for o in self.of_tool('arr_lookup'):
            f = self.facts.get(o['id']) or {}
            if not self.ran_ok(o) or not isinstance(f, dict):
                continue
            for k in ('work', 'series'):
                if isinstance(f.get(k), str) and f[k]:
                    titles.append(f[k])
            if isinstance(f.get('movie'), dict) and f['movie'].get('title'):
                titles.append(str(f['movie']['title']))
            titles += [str(a) for a in (f.get('aliases') or []) + (f.get('alternate_titles') or []) if isinstance(a, str) and a]
            authors += [str(a) for a in f.get('authors') or [] if isinstance(a, str)]
            ep = f.get('episode')
            if isinstance(ep, dict) and isinstance(ep.get('season'), int) and isinstance(ep.get('episode'), int) and not eps:
                eps.append((ep['season'], ep['episode']))
            if isinstance(ep, dict) and ep.get('title') and not ep_titles:
                ep_titles.append(str(ep['title']))
        return {'titles': titles, 'episodes': eps, 'episode_titles': ep_titles, 'authors': authors}

    # ------------------------------------------------------------------ identity-bearing statements: (ref, kind, typed, text)
    def statements(self):
        out = []
        if self.context.get('filename'):
            out.append(('context.filename', 'declaration', 'file_name', self.context['filename']))
        for o in self.obs:
            d = self.an['items'][o['id']]
            if d.execution['state'] != 'ran':
                continue
            f = self.facts.get(o['id']) or {}
            if o['tool'] == 'ocr' and isinstance(f.get('text'), str):
                out.append((o['id'], 'content', None, f['text']))
            elif o['tool'] == 'epub_inspect':
                for k in ('title', 'creator'):
                    if isinstance(f.get(k), str):
                        out.append((o['id'], 'declaration', 'dc_' + k, f[k]))
                for h in f.get('spine_heads') or []:
                    out.append((o['id'], 'content', None, h if isinstance(h, str) else EV2.canon(h)))
            elif o['tool'] in ('ffprobe', 'audiobook_inspect'):
                tags = f.get('tags')
                if isinstance(tags, dict):
                    for k in ('title', 'album', 'artist'):
                        if isinstance(tags.get(k), str):
                            out.append((o['id'], 'declaration', 'tag_' + k, tags[k]))
            elif o['tool'] == 'prior_record' and isinstance(f.get('observed'), dict):
                kind = FX.report_kind(f.get('evidence_method'))
                for t in f['observed'].get('content_titles') or []:
                    if isinstance(t, str):
                        out.append((o['id'], kind, 'reported_title', t))
        return out

    def compare(self, kind, typed, text):
        """-> 'agree' | 'disagree' | 'not_comparable' | 'empty' against the catalog (aliases and alternate titles included)."""
        cat = self.catalog()
        if PR.state_of(text) != PR.POPULATED:
            return 'empty'
        exp_year = (self.context.get('expected') or {}).get('year')
        years = [int(y) for y in re.findall(r'(?<!\d)(19\d\d|20\d\d)(?!\d)', str(text))]
        if typed is not None and isinstance(exp_year, int) and years and exp_year not in years:
            return 'disagree'                                  # an edition attribute (year) differs
        mk = markers(text)
        if mk and cat['episodes']:
            return 'agree' if any(m in cat['episodes'] for m in mk) else 'disagree'
        names = cat['titles'] + cat['episode_titles'] + (cat['authors'] if typed in ('dc_creator', 'tag_artist') else [])
        if any(contains(text, n) for n in names):
            return 'agree'
        if typed is not None and len(norm(text).split()) >= 2 and any(contains(n, text) for n in names):
            return 'agree'          # a typed field that is a run of two or more tokens of a catalog name ("Lantern Road"); never one word, never free text
        if typed is not None and names:
            return 'disagree'
        return 'not_comparable'

    def identity(self):
        rows = []
        for ref, kind, typed, text in self.statements():
            rows.append({'ref': ref, 'kind': kind, 'field': typed, 'state': self.compare(kind, typed, text)})
        content = [r for r in rows if r['kind'] in ('content', 'report_content')]
        other = [r for r in rows if r['kind'] in ('declaration', 'report_declaration', 'report_hash')]
        if any(r['state'] == 'disagree' for r in content):
            level = 'contradicted_by_content'
        elif any(r['state'] == 'agree' for r in content):
            level = 'content_verified'
        elif any(r['state'] == 'disagree' for r in other):
            level = 'contested'
        else:
            level = 'uncontradicted'
        return level, rows


def _r(pid, check, state, refs=(), detail=''):
    return {'id': pid, 'check': check, 'state': state, 'refs': list(refs), 'detail': detail}


def check_named(v, check, when_support=False):
    """-> (state, refs, detail) for one named check of rubric.CHECKS."""
    an = v.an
    if check in ('located_defect', 'support_grade_defect'):
        refs = []
        for o in v.obs:
            d = an['items'][o['id']]
            for f in d.findings:
                if not (f['known_defect'] and f.get('location')):
                    continue
                if check == 'support_grade_defect' and not ((d.execution['state'] == 'ran' and d.execution['status'] == 'ok') or
                                                            (d.execution['state'] == 'failed' and d.execution.get('cause') != 'tool')):
                    continue
                refs.append(f['id'])
        return (MET, refs, '') if refs else (UNMET, [], 'no located known defect%s' % (' in a support-grade result' if check == 'support_grade_defect' else ''))
    if check == 'positively_clean':
        clean = EV2.integrity_findings(v.obs)['clean']
        return (MET, clean, '') if clean else (UNMET, [], 'no integrity result is positively clean')
    if check == 'stated_client':
        return (MET, ['context.client_profile'], '') if EV2.client_profile(v.context) else (UNMET, [], 'no client is stated')
    if check == 'unsupported_selected_stream':
        cl = an['client']
        if cl is None:
            return UNMET, [], 'no client comparison (no client stated)'
        sel = cl.get('selection') or {}
        hits = []
        for row in cl.get('rows') or []:
            if row.get('verdict') != 'unsupported':
                continue
            typ = 'video' if str(row['field']).startswith('video') else ('audio' if str(row['field']).startswith('audio') else None)
            if typ is None or (sel.get(typ) or {}).get('how') in ('recorded', 'only_stream_of_type'):
                hits.append('client_comparison.%s' % row['field'])
        return (MET, hits, '') if hits else (UNMET, [], 'no unsupported field on a selected stream with a recorded or only-stream selection')
    if check == 'managed_app':
        app = (v.context.get('arr') or {}).get('app')
        return (MET, ['context.arr.app'], '') if app in ARR_APPS else (UNMET, [], 'no managing app')
    if check == 'source_bound':
        app = (v.context.get('arr') or {}).get('app')
        if app not in ARR_APPS:
            return MET, ['case item'], 'unmanaged item: the case item itself'
        fname = v.context.get('filename')
        ids = (v.context.get('arr') or {}).get('ids') or {}
        cat = v.catalog()
        links, other = [], []
        for o in v.of_tool('arr_lookup'):           # every record is read (order independent); a record of ANOTHER item (a destination) is not about the source
            f = v.facts.get(o['id']) or {}
            ep = f.get('episode') if isinstance(f, dict) else None
            if isinstance(ep, dict) and cat['episodes'] and (ep.get('season'), ep.get('episode')) not in cat['episodes']:
                continue
            fl = f.get('file') if isinstance(f, dict) else None
            if isinstance(fl, dict):
                rp = fl.get('relativePath') or fl.get('path')
                fid = fl.get('id')
                if (isinstance(rp, str) and fname and norm(rp.split('/')[-1]) == norm(fname)) or (fid is not None and fid in [ids.get(k) for k in ('episodeFileId', 'movieFileId', 'bookId')]):
                    links.append(o['id'])
                elif isinstance(rp, str) and fname:
                    other.append(o['id'])
        if links:
            return MET, sorted(links), 'the managed record of this item links this file'
        if other:
            return UNMET, sorted(other), 'the managed record of this item links a different file'
        return UNKNOWN, [], 'no shown managed record of this item states which file it links'
    if check == 'identity_disagreement':
        level, rows = v.identity()
        refs = [r['ref'] for r in rows if r['kind'] in ('content', 'report_content') and r['state'] == 'disagree']
        if when_support:
            refs = [r for r in refs if r.startswith('context.') or any(o['id'] == r and v.ran_ok(o) for o in v.obs)]
        if refs:
            return MET, refs, ''
        if any(r['kind'] in ('content', 'report_content') and r['state'] == 'not_comparable' for r in rows):
            return UNKNOWN, [], 'content text mentions no catalog value; the generic comparator cannot tell another work from unrelated text'
        return UNMET, [], 'no content observation disagrees with the catalog (declarations, tags and reported hashes are not content)'
    if check == 'naming_surface_defect':
        surface = RB.NAMING_SURFACE.get(v.media_type, ('file_name',))
        refs = []
        for ref, kind, typed, text in v.statements():
            if typed in surface and v.compare(kind, typed, text) in ('disagree', 'empty'):
                refs.append(ref + ':' + typed)
        if 'tag_title' in surface:
            for o in v.of_tool('ffprobe', 'audiobook_inspect'):
                p = v.presence.get(o['id']) or {}
                if p.get('format.tags') == PR.EMPTY or p.get('tags') == PR.EMPTY:
                    refs.append(o['id'] + ':tags_empty')
        if 'dc_title' in surface:
            for o in v.of_tool('epub_inspect'):
                p = v.presence.get(o['id']) or {}
                if p.get('dc_title') in (PR.EMPTY, PR.NULL):
                    refs.append(o['id'] + ':dc_title_empty')
        return (MET, refs, '') if refs else (UNMET, [], 'no naming-surface field is explicitly empty or different (absent is not evidence)')
    if check == 'destination_evidenced':
        cat = v.catalog()
        for ref, kind, typed, text in v.statements():
            if kind in ('content', 'report_content'):
                for m in markers(text):
                    if cat['episodes'] and m not in cat['episodes']:
                        hits = sorted(o['id'] for o in v.of_tool('arr_lookup') if isinstance((v.facts.get(o['id']) or {}).get('episode'), dict)
                                      and ((v.facts.get(o['id']) or {})['episode'].get('season'), (v.facts.get(o['id']) or {})['episode'].get('episode')) == m)
                        if hits:
                            return MET, [ref, hits[0]], 'content names another item that the catalog lists'
                        return UNKNOWN, [ref], 'content names another item; no shown catalog record lists it'
        return UNMET, [], 'no content observation names another item'
    if check == 'free_slot':
        st, refs, _ = check_named(v, 'destination_evidenced')
        if st != MET:
            return UNKNOWN, [], 'no evidenced destination item, so no record is the destination slot'
        dest = refs[1]
        f = v.facts.get(dest) or {}
        p = v.presence.get(dest) or {}
        ep = f.get('episode') if isinstance(f.get('episode'), dict) else {}
        if p.get('file') == PR.POPULATED or ep.get('hasFile') is True or f.get('hasFile') is True:
            return UNMET, [dest], 'the destination record shows a linked file (it would be overwritten)'
        if f.get('hasFile') is False or p.get('file') in (PR.NULL, PR.EMPTY) or ep.get('hasFile') is False:
            return MET, [dest], 'the destination record shows no linked file'
        return UNKNOWN, [dest], 'the destination record does not state whether a file is linked (absent is not evidence)'
    if check == 'old_value':
        return (MET, ['context.filename'], '') if PR.state_of(v.context.get('filename')) == PR.POPULATED else (UNMET, [], 'the current name is not shown')
    if check == 'new_value':
        cat = v.catalog()
        if not cat['titles']:
            return UNMET, [], 'no catalog name is shown'
        st, refs, _ = check_named(v, 'naming_surface_defect')
        return (MET, ['context.expected'] + refs, '') if st == MET else (UNMET, [], 'the shown name does not differ from the catalog')
    if check == 'two_candidates':
        dur = an.get('duration_s')
        for o in v.of_tool('arr_lookup'):
            f = v.facts.get(o['id']) or {}
            for k in ('editions', 'episode_orders'):
                cands = f.get(k)
                if not isinstance(cands, (list, dict)) or len(cands) < 2:
                    continue
                fit = []
                for name in (cands if isinstance(cands, dict) else range(len(cands))):
                    c = cands[name]
                    rt = c.get('runtime_s') if isinstance(c, dict) else None
                    # M7 / D-ORD-1: a candidate counts only when the observations FIT it; an edition with a runtime fits a shown container duration within the
                    # rubric's tolerance; with no runtime or no duration the fit is not contradicted
                    if isinstance(rt, (int, float)) and isinstance(dur, (int, float)) and abs(dur - rt) > max(RB.RUNTIME_TOLERANCE_S, RB.RUNTIME_TOLERANCE_FRACTION * rt):
                        continue
                    fit.append(name)
                if len(fit) >= 2:
                    return MET, [o['id']], '%s lists %d candidates the observations fit' % (k, len(fit))
                return UNMET, [o['id']], '%s lists %d candidates; the shown duration fits %d' % (k, len(cands), len(fit))
        return UNMET, [], 'no case record lists two candidates'
    if check == 'no_settling_choice':
        for o in v.of_tool('arr_lookup'):
            f = v.facts.get(o['id']) or {}
            hit = [k for k in CHOICE_KEYS if PR.state_of(f.get(k)) == PR.POPULATED] if isinstance(f, dict) else []
            if hit:
                return UNMET, [o['id']], 'the case supplies a choice (%s)' % ', '.join(hit)
        return MET, [], 'no case-supplied choice is shown'
    raise KeyError(check)


def material(v):
    """-> [{'id': 'M1'.., 'state', 'refs'}] (state met = the material uncertainty IS present)."""
    an = v.an
    out = []
    integ = EV2.integrity_findings(v.obs)
    out.append(_r('M1', 'material', MET if not integ['clean'] else UNMET, integ['unknown']))
    uncls = [f['id'] for o in v.obs for f in an['items'][o['id']].findings
             if not f['known_defect'] and (f['kind'].endswith('_unclassified') or f['kind'] in ('probe_messages', 'input_failure'))]
    out.append(_r('M2', 'material', MET if uncls else UNMET, uncls))
    conf = [c['id'] for o in v.obs for c in an['items'][o['id']].conflicts if c['kind'] in RB.MATERIAL_CONFLICTS]
    out.append(_r('M3', 'material', MET if conf else UNMET, conf))
    exp = v.context.get('expected') or {}
    runtime = exp.get('runtime_s') if isinstance(exp.get('runtime_s'), (int, float)) else exp.get('duration_s')
    dur = an.get('duration_s')
    m4 = []
    if isinstance(runtime, (int, float)) and isinstance(dur, (int, float)) and abs(dur - runtime) > max(RB.RUNTIME_TOLERANCE_S, RB.RUNTIME_TOLERANCE_FRACTION * runtime):
        m4.append('coverage.duration_s')
    out.append(_r('M4', 'material', MET if m4 else UNMET, m4))
    level, rows = v.identity()
    out.append(_r('M5', 'material', MET if level in ('contested', 'contradicted_by_content') else UNMET, [r['ref'] for r in rows if r['state'] == 'disagree']))
    st, refs, _ = check_named(v, 'naming_surface_defect')
    out.append(_r('M6', 'material', MET if st == MET else UNMET, refs))
    st1, r1, _ = check_named(v, 'two_candidates')
    st2, r2, _ = check_named(v, 'no_settling_choice')
    out.append(_r('M7', 'material', MET if (st1 == MET and st2 == MET) else UNMET, r1 + r2))
    cl = an['client']
    m8 = []
    if cl is not None:
        m8 = ['client_comparison.%s' % r['field'] for r in cl.get('rows') or [] if r.get('verdict') == EV2.UNKNOWN] + (['client_comparison.not_compared'] if cl.get('not_compared') else [])
    out.append(_r('M8', 'material', MET if m8 else UNMET, m8))
    q = v.context.get('question')
    out.append(_r('M9', 'material', UNKNOWN if q else UNMET, ['context.question'] if q else [], 'a complaint is stated; whether a shown observation reaches it is judged, not computed' if q else ''))
    return out


def check(observations, context=None, media_type=None, capabilities=None):
    """-> {'rubric', 'identity': {level, comparisons}, 'material': [...], 'diagnosis': {class: [...]}, 'actions': {action: [...]}}.  States only."""
    v = View(observations, context, media_type, capabilities)
    level, rows = v.identity()
    mat = material(v)
    diag = {}
    for cls, reqs in RB.DIAGNOSIS.items():
        res = []
        for req in reqs:
            c = req['check']
            if c == 'identity_level':
                ok = level in ('uncontradicted', 'content_verified')
                res.append(_r(req['id'], c, MET if ok else UNMET, [r['ref'] for r in rows], 'identity %s' % level))
            elif c in ('H1', 'H2', 'H3', 'H4'):
                if c == 'H1':
                    st, refs, det = check_named(v, 'positively_clean')
                elif c == 'H2':
                    defects = [f['id'] for o in v.obs for f in v.an['items'][o['id']].findings if f['known_defect']] + [o['id'] + '.veto' for o in v.obs if v.an['items'][o['id']].veto]
                    st, refs, det = (UNMET, defects, 'a known defect or veto is shown') if defects else (MET, [], '')
                elif c == 'H3':
                    present = [m['id'] for m in mat if m['state'] == MET]
                    open_q = [m['id'] for m in mat if m['state'] == UNKNOWN]
                    st, refs, det = (UNMET, present, 'material uncertainty present') if present else ((UNKNOWN, open_q, 'judged: ' + ', '.join(open_q)) if open_q else (MET, [], ''))
                else:
                    st, refs, det = (MET, [], 'identity %s' % level) if level in ('uncontradicted', 'content_verified') else (UNMET, [r['ref'] for r in rows if r['state'] == 'disagree'], 'identity %s' % level)
                res.append(_r(req['id'], c, st, refs, det))
            elif c == 'none_established':
                res.append(_r(req['id'], c, UNKNOWN, [], 'follows from the other classes; not computed here'))
            else:
                st, refs, det = check_named(v, c)
                res.append(_r(req['id'], c, st, refs, det))
        diag[cls] = res
    acts = {}
    for action, spec in RB.ACTIONS.items():
        res = []
        for req in spec['prerequisites']:
            c = req['check']
            if c == 'identity_level':
                ok = level == req.get('value')
                res.append(dict(_r(req['id'], c, MET if ok else UNMET, [r['ref'] for r in rows if r['state'] == 'agree'], 'identity %s' % level), when_class=req.get('when_class')))
            else:
                st, refs, det = check_named(v, c, req.get('support_grade', False))
                res.append(dict(_r(req['id'], c, st, refs, det), when_class=req.get('when_class')))
        acts[action] = {'prerequisites': res, 'execution_prerequisites': [{'text': t, 'checked_by': 'executor'} for t in spec['execution']]}
    return {'rubric': RB.RUBRIC_VERSION, 'identity': {'level': level, 'comparisons': rows}, 'material': mat, 'diagnosis': diag, 'actions': acts}
