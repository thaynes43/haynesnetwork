"""Contract v3, hypothesis 4: explicit empty values stay distinct from absent fields and from "not checked".

Format v2's fact filters drop `None`, `[]`, `{}` (and, for EPUB, `''`), so an explicitly empty tag object reads the same as a probe that never
reported tags.  This module reads the SAME model-visible observation (through `evidence_v2.unwrap`, unchanged) and states, for each typed
field of each typed source, one of six presence states: absent, null, empty, false, zero, populated.  For a whole source that did not run
(`unavailable`, or a failure with no parsed output) every field is `not_checked`; for one that ran but whose output cannot be read, `unknown`.
Nothing here classifies, diagnoses or reads anything but the observation it is given.
"""
from ... import evidence_v2 as EV2

ABSENT, NULL, EMPTY, FALSE, ZERO, POPULATED = 'absent', 'null', 'empty', 'false', 'zero', 'populated'
NOT_CHECKED, UNKNOWN = 'not_checked', 'unknown'
NON_POPULATED = (ABSENT, NULL, EMPTY, FALSE, ZERO)

# typed fields per source (path tuples inside the parsed output; '*' = every element of a list)
REPLAY_FIELDS = {
    'ffprobe': (('format', 'tags'), ('format', 'duration'), ('format', 'format_name'), ('streams',), ('chapters',), ('stderr',), ('exit_code',)),
    'audiobook_inspect': (('format',), ('duration_s',), ('tags',), ('chapters',), ('chapter_count',), ('audio_streams',)),
    'epub_inspect': (('dc_title',), ('dc_creator',), ('dc_language',), ('dc_identifier',), ('spine_items',), ('spine_heads',), ('entries',)),
    'decode_sample': (('exit_code',), ('frames',), ('out_time',), ('stderr',)),
    'audio_sample': (('rms_dbfs',), ('peak_dbfs',), ('silent_fraction',)),
    'ocr': (('text',),),
}
LIVE_FIELDS = {
    'probe': (('output', 'format'), ('output', 'duration_s'), ('output', 'tags'), ('output', 'streams'), ('output', 'chapters')),
    'epub': (('output', 'dc_title'), ('output', 'dc_creator'), ('output', 'dc_language'), ('output', 'dc_identifier'), ('output', 'stages_passed'), ('output', 'valid')),
    'audiobook': (('output', 'files', '*', 'tags'), ('output', 'files', '*', 'chapters'), ('output', 'files', '*', 'audio_streams'), ('output', 'tag_consistency')),
    'decode': (('output', 'segments'), ('output', 'duration_s')),
    'audio': (('output', 'streams'),),
}
RECORD_TOOLS = ('arr_lookup', 'prior_record')      # catalog / report records: every key to depth 3 is a typed field, plus the keys the contract checks
RECORD_FIELDS = {'arr_lookup': (('file',), ('hasFile',), ('episode',), ('editions',), ('episode_orders',), ('aliases',), ('alternate_titles',)),
                 'prior_record': (('evidence_method',), ('observed',))}


def state_of(value):
    """The presence state of a value that IS present (the key exists)."""
    if value is None:
        return NULL
    if value is False:
        return FALSE
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0:
        return ZERO
    if isinstance(value, (str, list, dict)) and len(value) == 0:
        return EMPTY
    if isinstance(value, str) and not value.strip():
        return EMPTY
    return POPULATED


def lookup(data, path):
    """-> [(concrete path, state, value)] for `path` in `data` ('*' expands over a list).  A missing key anywhere is `absent`."""
    out = []

    def go(cur, rest, done):
        if not rest:
            out.append((done, state_of(cur), cur))
            return
        k = rest[0]
        if k == '*':
            if isinstance(cur, list):
                for i, el in enumerate(cur):
                    go(el, rest[1:], done + (i,))
            else:
                out.append((done + ('*',) + tuple(rest[1:]), ABSENT, None))
            return
        if isinstance(cur, dict) and k in cur:
            go(cur[k], rest[1:], done + (k,))
        else:
            out.append((done + tuple(rest), ABSENT, None))
    go(data, tuple(path), ())
    return out


def _record_paths(data, prefix=(), depth=0):
    out = []
    if isinstance(data, dict):
        for k, v in data.items():
            out.append(prefix + (k,))
            if depth < 2 and isinstance(v, dict):
                out += _record_paths(v, prefix + (k,), depth + 1)
    return out


def observation_presence(obs):
    """-> [{'src', 'tool', 'path', 'presence', 'value'}] for one observation.  `path` is a dotted string relative to the parsed output."""
    data, _notes = EV2.unwrap(obs)
    tool = obs['tool']
    status = obs.get('status')
    rows = []

    def emit(path, st, val):
        rows.append({'src': obs['id'], 'tool': tool, 'path': '.'.join(str(p) for p in path), 'presence': st, 'value': val})

    live = EV2.is_live_record(data)
    if live:
        fields = LIVE_FIELDS.get(data.get('tool') or '', ())
    elif tool in RECORD_TOOLS:
        present = tuple(_record_paths(data)) if isinstance(data, dict) else ()
        fields = present + tuple(f for f in RECORD_FIELDS.get(tool, ()) if f not in present)
    else:
        fields = REPLAY_FIELDS.get(tool, ())
    if status == 'unavailable' or (status in ('error', 'timeout') and not isinstance(data, (dict, list))):
        for p in fields or (('*',),):
            emit(p, NOT_CHECKED, None)
        return rows
    if not isinstance(data, (dict, list)):
        if tool == 'ocr' and isinstance(obs.get('output'), str):      # a plain-text reading
            emit(('text',), state_of(obs['output']), obs['output'])
            return rows
        for p in fields or (('*',),):
            emit(p, UNKNOWN, None)
        return rows
    for p in fields:
        for concrete, st, val in lookup(data, p):
            emit(concrete, st, val)
    return rows


def dropped_by_v2(obs, v2_facts):
    """The explicit empty / null / false / zero typed values that the v2 facts of this observation do not carry (`v2_facts` = `item_facts(d)`).
    These, and only these, are what v3 adds back.  -> [{'path', 'presence', 'value', 'fact_key'}]"""
    out = []
    shown = _flat_keys(v2_facts)
    for row in observation_presence(obs):
        if row['presence'] not in (NULL, EMPTY, FALSE, ZERO):
            continue
        key = v2_fact_key(obs['tool'], row['path'])
        if key is None or key in shown:
            continue
        val = row['value']
        if key in LINE_KEYS and isinstance(val, str):          # v2 shows these as a list of lines: an explicitly blank text is an empty list
            val = []
        out.append(dict(row, fact_key=key, value=val))
    return out


# the fields format v2 shows as a list of lines (blank text dropped); v3 keeps a blank one as [] with presence empty
LINE_KEYS = ('stderr_lines', 'error_lines')


# where a typed field lands in the v2 facts object: ONLY the fields v2 shows when they are populated (a field v2 never carries, such as a probe's exit
# code, is not added back: v3 restores what the empty filters dropped, nothing else)
_FACT_KEY = {
    ('ffprobe', 'format.tags'): 'tags', ('ffprobe', 'format.duration'): 'duration_s', ('ffprobe', 'format.format_name'): 'container',
    ('ffprobe', 'streams'): 'streams', ('ffprobe', 'chapters'): 'chapters', ('ffprobe', 'stderr'): 'stderr_lines',
    ('audiobook_inspect', 'tags'): 'tags', ('audiobook_inspect', 'chapters'): 'chapters', ('audiobook_inspect', 'chapter_count'): 'chapter_count',
    ('audiobook_inspect', 'audio_streams'): 'audio_streams', ('audiobook_inspect', 'format'): 'container', ('audiobook_inspect', 'duration_s'): 'duration_s',
    ('epub_inspect', 'dc_title'): 'title', ('epub_inspect', 'dc_creator'): 'creator', ('epub_inspect', 'dc_language'): 'language',
    ('epub_inspect', 'dc_identifier'): 'identifier', ('epub_inspect', 'spine_items'): 'spine_items', ('epub_inspect', 'spine_heads'): 'spine_heads',
    ('epub_inspect', 'entries'): 'entries',
    ('decode_sample', 'exit_code'): 'exit_code', ('decode_sample', 'frames'): 'frames', ('decode_sample', 'stderr'): 'error_lines',
    ('ocr', 'text'): 'text',
}


def v2_fact_key(tool, path):
    if path.startswith('output.'):                       # live records: the v2 live derivers use the collector's own key names
        rest = path[len('output.'):]
        if rest.startswith('files.'):
            return None
        return {'format': 'container', 'tags': 'tags', 'streams': 'streams', 'chapters': 'chapters', 'duration_s': 'duration_s', 'dc_title': 'title',
                'dc_creator': 'creator', 'dc_language': 'language', 'dc_identifier': 'identifier', 'stages_passed': 'stages_passed', 'valid': 'valid'}.get(rest)
    if tool in RECORD_TOOLS:
        return path
    return _FACT_KEY.get((tool, path))


def _flat_keys(facts, prefix=''):
    keys = set()
    if isinstance(facts, dict):
        for k, v in facts.items():
            key = prefix + str(k)
            keys.add(key)
            if isinstance(v, dict):
                keys |= _flat_keys(v, key + '.')
    return keys
