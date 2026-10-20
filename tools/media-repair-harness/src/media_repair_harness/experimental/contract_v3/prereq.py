"""Contract v3 prerequisite checker (EXPERIMENTAL): the rubric's diagnosis and action prerequisites, checked against ACTUAL observations.

It applies rubric v3.1 (`rubric.RUBRIC_V31`: the frozen v3.0 rubric plus the amendments A31-1 .. A31-9, made after labels had been read; see
docs/contract-v3.md section 14).  Every check reads values, execution state, scope, statement kind and provenance -- never only the kind of
observation -- and returns a state (`met`, `unmet`, `unknown`) with the fact references that decided it.  Only results that ran to completion
(state ran, status ok) and the case context support a prerequisite, except the two scoped exceptions A31-4 names.  A clean decode is integrity and
never establishes identity; a tag, a reported hash or a reported declaration never becomes observed content; an absent field is not an empty one,
and null is neither.  The output carries prerequisite states only: no `sufficient`, `solvable`, recommended action, truth or label
(rubric.FORBIDDEN_FIELDS), and it takes no case object.
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
YEAR_RX = re.compile(r'(?<!\d)(19\d\d|20\d\d)(?!\d)')
ORDER_KEYS = ('series_order', 'library_episode_order')
EDITION_KEYS = ('wanted_edition', 'monitored_edition')
CONTENT_KINDS = ('content', 'report_content')
DECLARED_KINDS = ('declaration', 'report_declaration', 'report_hash')
IDENTITY_ATTRS = ('title', 'episode_number', 'episode_title', 'author')
TYPED_TITLE_FIELDS = ('dc_title', 'tag_title', 'tag_album', 'reported_title')     # a file name is not a typed title field: it disagrees through markers and years only
# which attributes a statement of each field speaks to (free text, field None, speaks to whatever it positively names)
FIELD_ATTRS = {'file_name': ('title', 'episode_number', 'episode_title', 'year'), 'dc_title': ('title', 'year'), 'tag_title': ('title', 'episode_title', 'year'),
               'tag_album': ('title', 'year'), 'reported_title': ('title', 'episode_number', 'episode_title', 'year'), 'dc_creator': ('author',),
               'tag_artist': ('author',), 'dc_language': ('language',), 'stream_language': ('language',)}


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


def lang(code):
    c = norm(code).split()
    if not c:
        return None
    c = c[0].split('_')[0]
    c = RB.LANGUAGE_CODES.get(c, c)
    return None if c in ('und', 'mul', 'zxx') else c


def _items(value):
    """A declared value as its elements: a string is one; a list is its string elements (list-valued EPUB titles and creators, A31-5)."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [x for x in value if isinstance(x, str)]
    return []


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
        """Only results that ran to completion are eligible support (A31-4)."""
        return [o for o in self.obs if o['tool'] in tools and self.complete(o)]

    def complete(self, o):
        d = self.an['items'][o['id']]
        return d.execution['state'] == 'ran' and d.execution['status'] == 'ok'

    # ------------------------------------------------------------------ catalog identity values
    def catalog(self):
        exp = self.context.get('expected') or {}
        titles, eps, ep_titles, authors = [], [], [], []
        for k in ('title', 'series', 'story'):
            if isinstance(exp.get(k), str) and exp[k]:
                titles.append(exp[k])
        titles += [str(a) for a in exp.get('aliases') or [] if isinstance(a, str) and a]
        if isinstance(exp.get('episode_title'), str) and exp['episode_title']:
            ep_titles.append(exp['episode_title'])
        if isinstance(exp.get('season'), int) and isinstance(exp.get('episode'), int):
            eps.append((exp['season'], exp['episode']))
        if isinstance(exp.get('author'), str) and exp['author']:
            authors.append(exp['author'])
        own_eps, own_titles = set(), set()
        for o in self.of_tool('arr_lookup'):
            f = self.facts.get(o['id']) or {}
            if not isinstance(f, dict):
                continue
            ep = f.get('episode')
            if isinstance(ep, dict) and self.links_this_file(f):      # the record that links THIS file says which item it is (any order)
                if isinstance(ep.get('season'), int) and isinstance(ep.get('episode'), int):
                    own_eps.add((ep['season'], ep['episode']))
                if isinstance(ep.get('title'), str) and ep['title']:
                    own_titles.add(ep['title'])
            for k in ('work', 'series'):
                if isinstance(f.get(k), str) and f[k]:
                    titles.append(f[k])
            if isinstance(f.get('movie'), str) and f['movie']:
                titles.append(f['movie'])
            if isinstance(f.get('movie'), dict) and isinstance(f['movie'].get('title'), str):
                titles.append(f['movie']['title'])
            titles += [a for a in (f.get('aliases') or []) + (f.get('alternate_titles') or []) if isinstance(a, str) and a]
            authors += [a for a in f.get('authors') or [] if isinstance(a, str)]
        if not eps and len(own_eps) == 1:       # with no catalog episode in the context, only an unambiguous record of this file names the item
            eps = sorted(own_eps)
        if not ep_titles and len(own_titles) == 1:
            ep_titles = sorted(own_titles)
        year = exp.get('year') if isinstance(exp.get('year'), int) and not isinstance(exp.get('year'), bool) else None
        return {'titles': titles, 'episodes': eps, 'episode_titles': ep_titles, 'authors': authors, 'year': year, 'language': lang(exp.get('language')) if exp.get('language') else None}

    def links_this_file(self, f):
        fl = f.get('file') if isinstance(f, dict) else None
        if not isinstance(fl, dict):
            return False
        fname = self.context.get('filename')
        ids = (self.context.get('arr') or {}).get('ids') or {}
        rp = fl.get('relativePath') or fl.get('path')
        return bool((isinstance(rp, str) and fname and norm(rp.split('/')[-1]) == norm(fname)) or
                    (fl.get('id') is not None and fl.get('id') in [ids.get(k) for k in ('episodeFileId', 'movieFileId', 'bookId')]))

    # ------------------------------------------------------------------ identity-bearing statements of complete results: (ref, kind, field, text)
    def statements(self):
        out = []
        if isinstance(self.context.get('filename'), str) and self.context['filename']:
            out.append(('context.filename', 'declaration', 'file_name', self.context['filename']))
        for o in self.obs:
            if not self.complete(o):
                continue
            f = self.facts.get(o['id']) or {}
            if not isinstance(f, dict):
                continue
            if o['tool'] == 'ocr' and isinstance(f.get('text'), str):
                out.append((o['id'], 'content', None, f['text']))
            elif o['tool'] == 'epub_inspect':
                for k, field in (('title', 'dc_title'), ('creator', 'dc_creator'), ('language', 'dc_language')):
                    for x in _items(f.get(k)):
                        out.append((o['id'], 'declaration', field, x))
                for h in f.get('spine_heads') or []:
                    out.append((o['id'], 'content', None, h if isinstance(h, str) else EV2.canon(h)))
            elif o['tool'] in ('ffprobe', 'audiobook_inspect'):
                tags = f.get('tags')
                if isinstance(tags, dict):
                    for k in ('title', 'album', 'artist'):
                        for x in _items(tags.get(k)):
                            out.append((o['id'], 'declaration', 'tag_' + k, x))
                for s in f.get('streams') or []:
                    if isinstance(s, dict) and s.get('type') == 'audio' and isinstance(s.get('language'), str):
                        out.append((o['id'], 'declaration', 'stream_language', s['language']))
            elif o['tool'] == 'prior_record' and isinstance(f.get('observed'), dict):
                kind = FX.report_kind(f.get('evidence_method'))
                if kind in CONTENT_KINDS + DECLARED_KINDS:
                    for t in _items(f['observed'].get('content_titles')):
                        out.append((o['id'], kind, 'reported_title', t))
        return out

    def compare(self, kind, field, text):
        """-> {attribute: 'agree' | 'disagree'} for the attributes this statement speaks to (A31-5).  Empty text speaks to nothing."""
        cat = self.catalog()
        if PR.state_of(text) != PR.POPULATED:
            return {}
        speaks = FIELD_ATTRS.get(field, ('title', 'episode_number', 'episode_title', 'author', 'year'))
        out = {}
        if 'language' in speaks:
            got = lang(text)
            if got and cat['language']:
                out['language'] = 'agree' if got == cat['language'] else 'disagree'
            return out
        if 'year' in speaks and cat['year'] is not None:
            years = [int(y) for y in YEAR_RX.findall(str(text))]
            if years:
                out['year'] = 'agree' if cat['year'] in years else 'disagree'
        if 'episode_number' in speaks and cat['episodes']:
            mk = markers(text)
            if mk:
                out['episode_number'] = 'agree' if any(m in cat['episodes'] for m in mk) else 'disagree'
        if 'author' in speaks and cat['authors']:
            hit = any(contains(text, a) for a in cat['authors'])
            if hit or field is not None:
                out['author'] = 'agree' if hit else 'disagree'
        if 'episode_title' in speaks and any(contains(text, t) for t in cat['episode_titles']):
            out['episode_title'] = 'agree'
        if 'title' in speaks and (cat['titles'] or cat['episode_titles']):
            names = cat['titles'] + cat['episode_titles']
            hit = any(contains(text, n) for n in names) or (field is not None and len(norm(text).split()) >= 2 and any(contains(n, text) for n in names))   # A31-6
            if hit:
                out['title'] = 'agree'
            elif field in TYPED_TITLE_FIELDS:
                out['title'] = 'disagree'          # a typed title field naming no catalog value (section 8); a file name or free text naming none is not comparable
        return out

    def identity(self):
        """-> (level, rows, per-attribute status).  Content settles only the attributes it speaks to (A31-5)."""
        rows = []
        for ref, kind, field, text in self.statements():
            rows.append({'ref': ref, 'kind': kind, 'field': field, 'attributes': self.compare(kind, field, text)})
        per = {}
        for a in RB.COMPARED_ATTRIBUTES:
            cs = {r['attributes'][a] for r in rows if r['kind'] in CONTENT_KINDS and a in r['attributes']}
            ds = {r['attributes'][a] for r in rows if r['kind'] in DECLARED_KINDS and a in r['attributes']}
            per[a] = ('contradicted' if 'disagree' in cs else 'verified' if 'agree' in cs else 'contested' if 'disagree' in ds else
                      'declared_agree' if 'agree' in ds else 'none')
        if any(s == 'contradicted' for s in per.values()):
            level = 'contradicted_by_content'
        elif any(s == 'contested' for s in per.values()):
            level = 'contested'
        elif any(per[a] == 'verified' for a in IDENTITY_ATTRS):
            level = 'content_verified'
        else:
            level = 'uncontradicted'
        return level, rows, per

    # ------------------------------------------------------------------ destination records (A31-8)
    def destinations(self):
        """-> (state, marker or None, refs): the other item content names, and every complete catalog record of it (sorted)."""
        cat = self.catalog()
        named, refs = set(), []
        for ref, kind, _field, text in self.statements():
            if kind in CONTENT_KINDS:
                for m in markers(text):
                    if cat['episodes'] and m not in cat['episodes']:
                        named.add(m)
                        refs.append(ref)
        if not named:
            return UNMET, None, []
        if len(named) > 1:
            return UNKNOWN, None, sorted(set(refs))
        m = next(iter(named))
        recs = sorted(o['id'] for o in self.of_tool('arr_lookup') if isinstance((self.facts.get(o['id']) or {}).get('episode'), dict)
                      and ((self.facts.get(o['id']) or {})['episode'].get('season'), (self.facts.get(o['id']) or {})['episode'].get('episode')) == m)
        return (MET if recs else UNKNOWN), m, sorted(set(refs)) + recs


def _r(pid, check, state, refs=(), detail=''):
    return {'id': pid, 'check': check, 'state': state, 'refs': list(refs), 'detail': detail}


def _container_or_package_clean(v):
    """The integrity-kind, container- or package-level, positively clean results (A31-1; M1's frozen wording)."""
    out = []
    for o in v.obs:
        d = v.an['items'][o['id']]
        if not v.complete(o) or o['tool'] not in ('ffprobe', 'audiobook_inspect', 'epub_inspect'):
            continue
        if any(f['known_defect'] for f in d.findings) or d.veto:
            continue
        if d.container == 'clean' or (o['tool'] == 'epub_inspect' and d.integrity == 'clean' and d.package and all(s == 'clean' for s in d.package.values())):
            out.append(o['id'])
    return out


def check_named(v, check):
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
                refs.append(f['id'])     # D-COR-1 and A-BLK-3: the two scoped eligibility exceptions of A31-4
        return (MET, refs, '') if refs else (UNMET, [], 'no located known defect%s' % (' in a support-grade result' if check == 'support_grade_defect' else ''))
    if check == 'positively_clean':
        clean = _container_or_package_clean(v)
        return (MET, clean, '') if clean else (UNMET, [], 'no positively clean integrity result at the container or package level')
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
            return MET, [RB.UNMANAGED_SOURCE_REF], 'unmanaged item: the case item itself'
        fname = v.context.get('filename')
        cat = v.catalog()
        links, other = [], []
        for o in v.of_tool('arr_lookup'):           # complete records only (A31-4); a record of ANOTHER item (a destination) is not about the source
            f = v.facts.get(o['id']) or {}
            ep = f.get('episode') if isinstance(f, dict) else None
            if isinstance(ep, dict) and cat['episodes'] and (ep.get('season'), ep.get('episode')) not in cat['episodes']:
                continue
            fl = f.get('file') if isinstance(f, dict) else None
            if isinstance(fl, dict):
                if v.links_this_file(f):
                    links.append(o['id'])
                elif isinstance(fl.get('relativePath') or fl.get('path'), str) and fname:
                    other.append(o['id'])
        if links:
            return MET, sorted(links), 'the managed record of this item links this file'
        if other:
            return UNMET, sorted(other), 'the managed record of this item links a different file'
        return UNKNOWN, [], 'no complete managed record of this item states which file it links'
    if check == 'identity_disagreement':
        level, rows, _per = v.identity()
        refs = [r['ref'] for r in rows if r['kind'] in CONTENT_KINDS and 'disagree' in r['attributes'].values()]
        if refs:
            return MET, refs, ''
        if any(r['kind'] in CONTENT_KINDS and not r['attributes'] for r in rows):
            return UNKNOWN, [], 'content text mentions no catalog value; the generic comparator cannot tell another work from unrelated text'
        return UNMET, [], 'no complete content observation disagrees with the catalog (declarations, tags and reported hashes are not content)'
    if check == 'naming_surface_defect':
        surface = RB.NAMING_SURFACE.get(v.media_type, ('file_name',))
        refs = []
        for ref, kind, field, text in v.statements():
            if field in surface and kind == 'declaration' and 'disagree' in v.compare(kind, field, text).values():
                refs.append(ref + ':' + field)
        for o in v.of_tool('ffprobe', 'audiobook_inspect', 'epub_inspect'):
            p = v.presence.get(o['id']) or {}
            if 'tag_title' in surface and o['tool'] != 'epub_inspect' and (p.get('format.tags') == PR.EMPTY or p.get('tags') == PR.EMPTY):
                refs.append(o['id'] + ':tags_empty')
            if 'dc_title' in surface and o['tool'] == 'epub_inspect' and p.get('dc_title') == PR.EMPTY:      # explicitly empty; null is not empty
                refs.append(o['id'] + ':dc_title_empty')
        return (MET, sorted(refs), '') if refs else (UNMET, [], 'no naming-surface field is explicitly empty or different (absent and null are not evidence)')
    if check == 'destination_evidenced':
        st, _m, refs = v.destinations()
        det = {MET: 'content names another item that the catalog lists', UNMET: 'no complete content observation names another item',
               UNKNOWN: 'content names another item that no complete record lists, or names more than one'}[st]
        return st, refs, det
    if check == 'free_slot':
        st, m, refs = v.destinations()
        if st != MET:
            return UNKNOWN, refs, 'no single evidenced destination item, so no record is the destination slot'
        recs = [r for r in refs if r.startswith(('e', 't')) and r in v.facts and isinstance((v.facts.get(r) or {}).get('episode'), dict)]
        states = {}
        for r in recs:
            f = v.facts.get(r) or {}
            p = v.presence.get(r) or {}
            ep = f.get('episode') or {}
            if p.get('file') == PR.POPULATED or ep.get('hasFile') is True or f.get('hasFile') is True:
                states[r] = 'occupied'
            elif f.get('hasFile') is False or p.get('file') in (PR.NULL, PR.EMPTY) or ep.get('hasFile') is False:
                states[r] = 'free'
            else:
                states[r] = 'silent'
        vals = set(states.values())
        if 'occupied' in vals and 'free' in vals:
            return UNKNOWN, sorted(states), 'the destination records disagree (free and occupied): the slot is unresolved'
        if 'occupied' in vals:
            return UNMET, sorted(states), 'the destination record shows a linked file (it would be overwritten)'
        if 'free' in vals:
            return MET, sorted(r for r, s in states.items() if s == 'free'), 'every destination record that states it shows no linked file'
        return UNKNOWN, sorted(states), 'no destination record states whether a file is linked (absent is not evidence)'
    if check == 'old_value':
        return (MET, ['context.filename'], '') if PR.state_of(v.context.get('filename')) == PR.POPULATED else (UNMET, [], 'the current name is not shown')
    if check == 'new_value':
        cat = v.catalog()
        if not cat['titles']:
            return UNMET, [], 'no catalog name is shown'
        st, refs, _ = check_named(v, 'naming_surface_defect')
        return (MET, ['context.expected'] + refs, '') if st == MET else (UNMET, [], 'the shown name does not differ from the catalog')
    if check in ('two_candidates', 'no_settling_choice'):
        return _ordering(v, check)
    raise KeyError(check)


def _candidates(f, key):
    c = f.get(key)
    if isinstance(c, dict):
        return list(c.keys()), c
    if isinstance(c, list):
        names = [x if isinstance(x, str) else (x.get('name') if isinstance(x, dict) else None) for x in c]
        return [n for n in names if isinstance(n, str)], {n: x for n, x in zip(names, c) if isinstance(n, str)}
    return [], {}


def _ordering(v, check):
    dur = v.an.get('duration_s')
    exp_edition = (v.context.get('expected') or {}).get('edition')
    for o in v.of_tool('arr_lookup'):
        f = v.facts.get(o['id']) or {}
        if not isinstance(f, dict):
            continue
        for key, choices in (('editions', EDITION_KEYS), ('episode_orders', ORDER_KEYS)):
            names, by = _candidates(f, key)
            if len(names) < 2:
                continue
            fit = []
            for n in names:
                c = by.get(n)
                rt = c.get('runtime_s') if isinstance(c, dict) else None
                # an edition with a runtime fits a shown container duration within the rubric's tolerance; with no runtime or no duration the fit is not contradicted
                if isinstance(rt, (int, float)) and isinstance(dur, (int, float)) and abs(dur - rt) > max(RB.RUNTIME_TOLERANCE_S, RB.RUNTIME_TOLERANCE_FRACTION * rt):
                    continue
                fit.append(n)
            if check == 'two_candidates':
                if len(fit) >= 2:
                    return MET, [o['id']], '%s lists %d candidates the observations fit' % (key, len(fit))
                return UNMET, [o['id']], '%s lists %d candidates; the shown duration fits %d' % (key, len(names), len(fit))
            given = [(k, f.get(k)) for k in choices if isinstance(f.get(k), str) and f[k]]
            if key == 'editions' and isinstance(exp_edition, str) and exp_edition:
                given.append(('context.expected.edition', exp_edition))
            valid = [(k, x) for k, x in given if any(norm(x) == norm(n) for n in names)]        # A31-7: a choice settles only when it names a listed candidate
            if valid:
                return UNMET, [o['id']], 'the case supplies a choice that names a listed candidate (%s)' % ', '.join(k for k, _x in valid)
            if given:
                return MET, [o['id']], 'the supplied choice (%s) names no listed candidate' % ', '.join(k for k, _x in given)
            return MET, [o['id']], 'no case-supplied choice is shown'
    if check == 'two_candidates':
        return UNMET, [], 'no complete case record lists two candidates'
    return MET, [], 'no case-supplied choice is shown'


def material(v):
    """-> [{'id': 'M1'.., 'state', 'refs'}] (state met = the material uncertainty IS present)."""
    an = v.an
    out = []
    clean = _container_or_package_clean(v)
    out.append(_r('M1', 'material', UNMET if clean else MET, clean, '' if clean else 'no positively clean container or package level result'))
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
    level, rows, per = v.identity()
    out.append(_r('M5', 'material', MET if level in ('contested', 'contradicted_by_content') else UNMET,
                  [r['ref'] for r in rows if 'disagree' in r['attributes'].values()], ', '.join('%s %s' % (a, s) for a, s in per.items() if s in ('contested', 'contradicted'))))
    st, refs, _ = check_named(v, 'naming_surface_defect')
    out.append(_r('M6', 'material', MET if st == MET else UNMET, refs))
    st1, r1, _ = check_named(v, 'two_candidates')
    st2, r2, _ = check_named(v, 'no_settling_choice')
    out.append(_r('M7', 'material', MET if (st1 == MET and st2 == MET) else UNMET, sorted(set(r1 + r2))))
    cl = an['client']
    m8 = []
    if cl is not None:
        m8 = ['client_comparison.%s' % r['field'] for r in cl.get('rows') or [] if r.get('verdict') == EV2.UNKNOWN] + (['client_comparison.not_compared'] if cl.get('not_compared') else [])
        m8 += ['client_comparison.selection.%s' % t for t, s in sorted((cl.get('selection') or {}).items()) if isinstance(s, dict) and s.get('how') == 'ambiguous']
    out.append(_r('M8', 'material', MET if m8 else UNMET, m8))
    q = v.context.get('question')
    out.append(_r('M9', 'material', UNKNOWN if q else UNMET, ['context.question'] if q else [], 'a complaint is stated; whether a shown observation reaches it is judged, not computed' if q else ''))
    return out


def _diagnose(v, level, mat):
    diag = {}
    for cls, reqs in RB.RUBRIC_V31['diagnosis'].items():
        if cls == 'healthy':
            continue
        res = []
        for req in reqs:
            c = req['check']
            if c == 'identity_level':
                ok = level in ('uncontradicted', 'content_verified')
                res.append(_r(req['id'], c, MET if ok else UNMET, [], 'identity %s' % level))
            elif c == 'none_established':
                res.append(_r(req['id'], c, UNKNOWN, [], 'follows from the other classes; not computed here'))
            else:
                st, refs, det = check_named(v, c)
                res.append(_r(req['id'], c, st, refs, det))
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
        res.append(_r(req['id'], c, st, refs, det))
    diag['healthy'] = res
    return dict(sorted(diag.items(), key=lambda kv: list(RB.DIAGNOSIS).index(kv[0])))


def check(observations, context=None, media_type=None, capabilities=None):
    """-> {'rubric', 'identity': {level, comparisons, attributes}, 'material', 'diagnosis': {class: [...]}, 'actions': {action: [...]}}.  States only."""
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
                res.append(dict(_r(req['id'], c, MET if ok else UNMET, [r['ref'] for r in rows if r['kind'] in CONTENT_KINDS and 'agree' in r['attributes'].values()],
                                   'identity %s' % level), when_class=req.get('when_class')))
            else:
                st, refs, det = check_named(v, c)
                res.append(dict(_r(req['id'], c, st, refs, det), when_class=req.get('when_class')))
        acts[action] = {'prerequisites': res, 'execution_prerequisites': [{'text': t, 'checked_by': 'executor'} for t in spec['execution']]}
    return {'rubric': RB.RUBRIC_V31_VERSION, 'identity': {'level': level, 'comparisons': rows, 'attributes': per}, 'material': mat, 'diagnosis': diag, 'actions': acts}
