"""Evidence format v2 (W18, opt-in `--evidence-format v2`): a deterministic typed layer over the SAME recorded and live results.

What it is.  The legacy format shows the model the raw tool text (JSON serialised inside a JSON string) with one status word.  Format v2
derives, from what the model could already see, four separate things per result:

  execution   ran / failed (with its cause) / timed out / unavailable, the raw status, whether the answer is complete, and whether
              the *presentation* was cut (output_truncated); collection success, media sampling and presentation are three different facts;
  findings    defects the result itself reports, each with its location and the id of the observation it came from;
  scope       what was requested against what was completed: streams, time intervals, package stages;
  unresolved  what this result could not settle.

plus, across the whole item, a coverage matrix (which parts were checked clean, found damaged, or not checked), a client comparison
(each selected stream field against the client the case STATES, supported / unsupported / unknown) and a capability advertisement
(what replay can actually return, before the tool is called).  A status of `ok` never implies healthy; a failure to collect never implies
a defect; incompatibility with a client is not corruption.

Inputs (the narrow interface).  Everything is derived from `Observation` dicts (id, tool, args, status, output, backend, collector_truncated)
and the model-visible case fields (context, media type, tools offered).  The case object is never passed in: no truth, accepted
classes, supported actions, solvability, family, corrections, provenance, outcome step, injection flag or fixture path can reach the
output, because no function here can see them.  A backend of `injected` (the harness-side marker of an injected failure) is dropped (no backend is shown) before anything is derived.

Honest unknowns.  A field the recorded data lacks is `unknown` (never clean, never damaged); an unrecognised error text stays raw with
`known_defect: false`; a non-zero exit alone is not a defect; coverage describes checks performed and never a diagnosis or a
"representative enough" verdict.  Intervals are unions per stream selection, clipped to the known duration; an unknown duration stays unknown.

Presentation.  Compact nested structure (no JSON inside JSON strings), units in the key names, conflicts and errors first, omissions
marked, an 8192-byte UTF-8 wire envelope per message with a versioned pagination contract (see `paginate`).
"""
import hashlib
import json
import re

from . import protocol as P

FORMAT_VERSION = 'v2'
PAGE_CONTRACT = 'pages-v1'
WIRE_BYTES = 8192
# tools whose result speaks to the file's integrity (the guards' notion, unchanged); the others are identity / catalog / picture records
INTEGRITY_TOOLS = ('ffprobe', 'decode_sample', 'audio_sample', 'epub_inspect', 'audiobook_inspect')
# the package stages the EPUB inspector reports, in the order it checks them (a failure at one stage leaves the later ones unchecked)
EPUB_STAGES = ('zip_open', 'zip_crc', 'opf_parse', 'manifest', 'spine')
# ffmpeg / libav wording that names damage to a file's structure or data.  General libav vocabulary, not case-specific; anything else stays unclassified.
DAMAGE_RX = re.compile(r'moov atom not found|invalid data found when processing input|could not find codec parameters|consecutive mpeg audio frames|'
                       r'partial file|file ended prematurely|ended prematurely|unexpected (?:end of file|eof)|truncated (?:file|archive|central directory|data)|'
                       r'(?:file|archive|stream|data|input|header) (?:is |are )?(?:corrupt(?:ed)?|damaged)|corrupt(?:ed)? (?:decoded )?(?:packet|frame|data|file|input|header|bitstream)|packet corrupt|'
                       r'header parsing failed|error reading header|checksum mismatch|crc mismatch|bad crc|not well-formed|bad zip|not a zip file|error while decoding|cabac decode|'
                       r'concealing|invalid nal|missing picture|reference picture missing|non-existing p[ps]s|error splitting the input into nal|invalid bitstream', re.I)
# a diagnostic that says the opposite ("no corrupt frames found"), and the file names / paths that may sit inside a diagnostic ("Permission denied: corrupt.mkv")
NEGATION_RX = re.compile(r"\b(?:no|not|without|never|zero|none|0|didn't|did not|cannot|can't|isn't|is not|free of)\b[^.;\n]{0,24}$", re.I)
FILENAME_RX = re.compile(r"[^\s/]{0,80}(?:/[^\s/]{0,80})+|\b[\w.-]{1,80}\.(?:mkv|mp4|m4v|m4b|m4a|mp3|flac|ogg|opus|avi|webm|mov|epub|zip|wav|aac|ts)\b", re.I)
EXECUTION_ERROR_RX = re.compile(r'permission denied|no such file or directory|operation not permitted|input/output error|cannot allocate memory|read-only file system|too many open files|'
                                r'connection (?:refused|reset)|resource temporarily unavailable', re.I)


def damage_wording(text):
    """True when `text` (a DIAGNOSTIC: decoder / probe stderr, an inspector's error message, a collector's error line) affirmatively names damage.  File names and
    paths inside it are removed first, and a negated mention ("no corrupt frames found") is not damage.  It is never applied to metadata, titles, tags, chapter names
    or the harness's own notes -- callers pass only diagnostic fields."""
    for raw in str(text or '').splitlines() or ['']:
        for i in range(0, max(len(raw), 1), 1800):          # a very long line is read in overlapping windows (the patterns are short)
            line = FILENAME_RX.sub(' ', HARNESS_MARKER_RX.sub(' ', raw[i:i + 2000]))
            for m in DAMAGE_RX.finditer(line):
                if not NEGATION_RX.search(line[:m.start()][-40:]):
                    return True
    return False


# the harness's own cut markers contain words ("truncated") that are also damage wording; they are not part of what a tool reported
HARNESS_MARKER_RX = re.compile(r'\.\.\.\[(?:output )?(?:truncated|cut off|\+\d+ chars[^\]]*)\]|\.\.\.\[excerpt cut[^\]]*\]|\.\.\.\[output truncated\]', re.I)
HARNESS_FAILURE_RX = re.compile(r'^(bad arguments|tool crashed|unknown frame|OCR backend failed|.{0,40} failed: could not run|.{0,40} exceeded the \d+ s tool timeout)', re.I)
UNKNOWN = 'unknown'
UNRECORDED = 'unrecorded'   # the stream selection of a decode window that its record does not state
COLLECTOR_STREAMS = ['0:v:0', '0:a:0']   # what the live decode collector maps: the first video and the first audio stream
EOF_TOLERANCE_S = 1.0     # container duration vs the decoded span: container rounding and unequal stream lengths, one constant for every case
VIDEO_CODECS = ('h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg2video', 'mpeg4', 'vc1')
AUDIO_CODECS = ('aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac', 'dts', 'truehd', 'vorbis', 'alac')
CODEC_ALIAS = {'h265': 'hevc', 'avc': 'h264', 'x264': 'h264', 'x265': 'hevc'}


# ------------------------------------------------------------------------------------------------------------------ helpers
def canon(obj):
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False)


def nbytes(obj):
    return len((obj if isinstance(obj, str) else canon(obj)).encode('utf-8'))


def num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def fnum(x, nd=3):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v != v or v in (float('inf'), float('-inf')) else round(v, nd)


def fint(x):
    """An integer-valued number as int (90286.0 -> 90286); other numbers rounded to 3 places; non-numbers None."""
    v = fnum(x)
    return None if v is None else (int(v) if float(v).is_integer() else v)


def hms(v):
    """'HH:MM:SS.ffffff' or a number of seconds -> float, else None."""
    if num(v) is not None:
        return float(v)
    if isinstance(v, str):
        m = re.fullmatch(r'\s*(\d+):(\d+):(\d+(?:\.\d+)?)\s*', v)
        if m:
            return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
        return fnum(v)
    return None


def clip(text, n=160):
    text = ' '.join(str(text).split())
    return text if len(text) <= n else text[:n - 3] + '...'


def lines_of(text):
    return [l for l in str(text or '').splitlines() if l.strip()]


def parse_json(value):
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.lstrip()[:1] in ('{', '['):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return None


SAFE_ARG_KEYS = ('at', 'ss', 't', 'full', 'stream', 'frame', 'cursor')
FRAME_NAME_RX = re.compile(r'^frame@[0-9]+(\.[0-9]+)?$')


def safe_args(args):
    """The part of a model-chosen args object that is echoed back in the typed result: known numeric / boolean options and a frame handle only.
    Model-chosen text is never echoed (a legacy rule), so any other key or value is dropped."""
    out = {}
    for k in SAFE_ARG_KEYS:
        v = (args or {}).get(k) if isinstance(args, dict) else None
        if k in ('at', 'ss', 't') and (v == 'full' or (isinstance(v, (int, float)) and not isinstance(v, bool))):
            out[k] = v
        elif k == 'full' and isinstance(v, bool):
            out[k] = v
        elif k == 'stream' and isinstance(v, int) and not isinstance(v, bool):
            out[k] = v
        elif k == 'frame' and isinstance(v, str) and FRAME_NAME_RX.match(v):
            out[k] = v
        elif k == 'cursor' and isinstance(v, str) and CURSOR_RX.match(v):
            out[k] = v
    return out


def reference_resolver(known_ids, emitted):
    """THE reference resolver (online runner, offline `mrh-guard` and `--restore` all use it): an observation id stands for itself; a finding / conflict id that was
    actually emitted (`t1.f1`) stands for its observation; anything else (`t1.nonexistent`) is left as written, so it is a bad reference everywhere."""
    known = set(known_ids)
    return lambda refs: [r if r in known else emitted.get(r, r) for r in (refs or [])]


def emitted_ids(analysis_result):
    out = {}
    for d in analysis_result['items'].values():
        for f in d.findings + d.conflicts:
            out[f['id']] = d.obs['id']
        if d.veto:
            out[d.obs['id'] + '.veto'] = d.obs['id']
    return out


def make_observation(id, tool, args, status, output, backend=None, source='tool', collector_truncated=False):
    """The only way case data reaches this module.  `backend` is the actual backend (local, remote, replay, pinned_replay, live, stub) or None;
    the harness-side `injected` marker is dropped to unknown."""
    if backend in ('injected', ''):
        backend = None
    return {'id': id, 'tool': tool, 'args': dict(args or {}), 'status': status, 'output': output, 'backend': backend,
            'source': source, 'collector_truncated': bool(collector_truncated)}


# ------------------------------------------------------------------------------------------------------------------ intervals
def norm_intervals(ivs):
    """Union of [a, b] intervals: dropped when empty, merged when overlapping, adjacent or duplicate."""
    spans = sorted((float(a), float(b)) for a, b in ivs if a is not None and b is not None and float(b) > float(a))
    out = []
    for a, b in spans:
        if out and a <= out[-1][1] + 1e-9:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(round(a, 3), round(b, 3)) for a, b in out]


def subtract(ivs, cut):
    out = []
    for a, b in ivs:
        parts = [(a, b)]
        for c, d in cut:
            nxt = []
            for x, y in parts:
                if d <= x or c >= y:
                    nxt.append((x, y))
                else:
                    if c > x:
                        nxt.append((x, c))
                    if d < y:
                        nxt.append((d, y))
            parts = nxt
        out += parts
    return [(round(a, 3), round(b, 3)) for a, b in out if b - a > 1e-9]


def clip_to(ivs, lo, hi):
    if hi is None:
        return norm_intervals([(max(a, lo), b) for a, b in ivs])
    return norm_intervals([(max(a, lo), min(b, hi)) for a, b in ivs])


def length(ivs):
    return round(sum(b - a for a, b in ivs), 3)


def listed(ivs):
    return [[a, b] for a, b in ivs]


# ------------------------------------------------------------------------------------------------------------------ per-tool derivation
def unwrap(obs):
    """-> (data, wrappers).  data is the parsed result (dict/list/None); wrappers names what the harness or collector put around it."""
    data = parse_json(obs.get('output'))
    notes = {}
    if isinstance(data, dict) and isinstance(data.get('observation'), (dict, list)) and 'recorded_as' in data:
        notes['recorded_as'] = data.get('recorded_as')
        data = data['observation']
        if isinstance(data, str):
            data = parse_json(data)
    elif isinstance(data, dict) and isinstance(data.get('observation'), str) and 'recorded_as' in data:
        notes['recorded_as'] = data.get('recorded_as')
        data = parse_json(data['observation']) or data['observation']
    return data, notes


def is_live_record(data):
    return isinstance(data, dict) and isinstance(data.get('coverage'), dict) and 'output' in data and 'verified' in data['coverage']


def execution_of(obs, data):
    st = obs['status']
    state = {'ok': 'ran', 'partial': 'ran', 'error': 'failed', 'timeout': 'timed_out', 'unavailable': 'unavailable'}.get(st, UNKNOWN)
    cause = None
    reason = None
    text = obs['output'] if isinstance(obs['output'], str) else ''
    if st == 'error':
        if is_live_record(data) and data.get('cause') in ('input', 'tool'):
            cause = data['cause']
            reason = data.get('reason')
        elif isinstance(data, dict) and ('stage' in data or 'exit_code' in data):
            blob = ' '.join(str(data.get(k) or '') for k in ('stderr', 'error'))
            cause = 'input' if (data.get('stage') in EPUB_STAGES or damage_wording(blob)) else ('tool' if EXECUTION_ERROR_RX.search(blob) else UNKNOWN)
        elif HARNESS_FAILURE_RX.search(text.strip()) or EXECUTION_ERROR_RX.search(text):
            cause = 'tool'
        else:
            cause = UNKNOWN
        if reason is None and not isinstance(data, (dict, list)):
            reason = text
    elif st in ('timeout', 'unavailable'):
        reason = (data.get('reason') if is_live_record(data) else None) or (text if not isinstance(data, (dict, list)) else None)
    if is_live_record(data) and data.get('reason') and reason is None:
        reason = data['reason']
    out = {'state': state, 'status': st}
    if cause:
        out['cause'] = cause
    out['completion'] = 'complete' if st == 'ok' else ('partial' if st == 'partial' else 'none')
    out['output_truncated'] = bool(obs.get('collector_truncated')) or '...[truncated]' in text[-40:] or '[output truncated]' in text[-60:]
    if reason:
        out['reason'] = ' '.join(str(reason).split())
    return out


class Derived:
    """The typed fields of one observation (mutable while a deriver fills it in)."""

    def __init__(self, obs, execution):
        self.obs, self.execution = obs, execution
        self.findings, self.conflicts, self.unresolved = [], [], []
        self.scope = {'requested': {}, 'completed': {}}
        self.facts = None
        self.collector_coverage = None   # a live collector's own coverage vocabulary (verified / not_verified), shown as facts.coverage
        self.known_duration = None
        self.diagnostics = []       # every raw diagnostic text a collector reported, classified or not: [{'where', 'state', 'text'}]
        self.veto = None           # a collector's own negative verdict (EPUB valid:false) that vetoes healthy without being typed as a located defect
        self.parts = []            # audiobook parts: [{'n', 'probe', 'intervals', 'duration_s'}] (decode windows are per part, not on one timeline)
        self.intervals = []        # [{'streams': [...], 'start_s', 'end_s', 'state', 'basis'}]  (decode-type windows)
        self.integrity = UNKNOWN    # clean | damaged | unknown | not_integrity
        self.container = None       # clean | damaged | unknown (probe-type results)
        self.package = None         # {stage: state}
        self.duration_s = None
        self.probe = None           # normalised stream facts for the client comparison
        self.completed_to_eof = None
        self.counter = {'f': 0, 'c': 0}

    def finding(self, kind, detail, location=None, known_defect=False):
        self.counter['f'] += 1
        f = {'id': '%s.f%d' % (self.obs['id'], self.counter['f']), 'kind': kind, 'known_defect': bool(known_defect)}
        if location:
            f['location'] = location
        f['detail'] = clip(detail)
        if len(' '.join(str(detail).split())) > 160:
            f['detail_full'] = 'the whole text is in facts (error_lines, stderr_lines, error or message)'
        f['src'] = self.obs['id']
        self.findings.append(f)
        return f

    def conflict(self, kind, detail, refs=()):
        self.counter['c'] += 1
        c = {'id': '%s.c%d' % (self.obs['id'], self.counter['c']), 'kind': kind, 'detail': clip(detail), 'src': self.obs['id']}
        if refs:
            c['refs'] = list(refs)
        self.conflicts.append(c)
        return c


def derive(obs, known_duration=None):
    """The typed fields of one observation.  Total: a result whose shape this layer cannot read yields no typed fact (integrity unknown, the raw text kept in
    `facts.raw`, a stated unresolved item), never an exception and never a guess."""
    try:
        return _derive(obs, known_duration)
    except Exception as e:  # noqa: BLE001 - malformed recorded data must not stop a run; it is reported, not interpreted
        d = Derived(obs, execution_of(obs, None))
        text = obs['output'] if isinstance(obs['output'], str) else canon(obs['output'])
        d.facts = {'raw': text}
        d.unresolved.append('the output has a shape this layer does not read (%s); no typed fact was derived from it' % type(e).__name__)
        _finish(d, None)
        return d


def _derive(obs, known_duration=None):
    data, notes = unwrap(obs)
    d = Derived(obs, execution_of(obs, data))
    if notes.get('recorded_as'):
        d.scope['completed']['recorded_as'] = notes['recorded_as']
    tool = obs['tool']
    if tool not in INTEGRITY_TOOLS:
        d.integrity = 'not_integrity'
    if is_live_record(data):
        _derive_live(d, data, known_duration)
    elif tool == 'ffprobe':
        _derive_probe(d, data)
    elif tool == 'decode_sample':
        _derive_decode(d, data, known_duration)
    elif tool == 'epub_inspect':
        _derive_epub(d, data)
    elif tool == 'audiobook_inspect':
        _derive_audiobook(d, data)
    elif tool == 'audio_sample':
        _derive_audio(d, data)
    elif tool in ('ocr', 'frame_sample', 'arr_lookup', 'prior_record'):
        _derive_record(d, data)
    else:
        _derive_record(d, data)
    _plain_text_fallback(d, data)
    _finish(d, data)
    return d


_PLAIN_KIND = {'ffprobe': ('container_damage', 'container'), 'audiobook_inspect': ('container_damage', 'container'), 'decode_sample': ('decoder_errors', 'decode'),
               'audio_sample': ('audio_decode_errors', 'audio'), 'epub_inspect': ('package_damage', 'package')}


DIAG_FIELD_RX = re.compile(r'"(?:stderr|error|errors|problems|probe_stderr|probe_reason)"\s*:\s*(\[[^\]]*\]?|"(?:[^"\\]|\\.)*"?)', re.S)


def diagnostic_fragments(text):
    """The diagnostic parts of an integrity output that could not be parsed.  Plain text (no leading brace) is the tool's own message and is one fragment; text that
    looks like cut JSON contributes only the values of its diagnostic keys (stderr, error ...), so a title, a tag, a chapter name or a harness note inside it is never read."""
    t = HARNESS_MARKER_RX.sub(' ', text).strip()
    if t[:1] not in ('{', '['):
        return [t]
    return [m.group(1).replace('\\n', '\n').replace('\\"', '"') for m in DIAG_FIELD_RX.finditer(t)]


def _plain_text_fallback(d, data):
    """An integrity result whose output is not JSON (a plain message, or text cut by an injected failure) keeps its text as `facts.raw`; only affirmative damage
    wording in a DIAGNOSTIC fragment of it is a defect (never a title, tag, chapter name, path or note), and anything else stays unclassified and unknown."""
    obs = d.obs
    if isinstance(data, (dict, list)) or d.facts is not None:
        return
    text = obs['output'] if isinstance(obs['output'], str) else ''
    if not text.strip():
        return
    if obs['tool'] in INTEGRITY_TOOLS and obs['status'] in ('ok', 'partial', 'error') and not HARNESS_FAILURE_RX.search(text.strip()):
        d.facts = {'raw': text}
        kind, part = _PLAIN_KIND[obs['tool']]
        frags = [] if EXECUTION_ERROR_RX.search(text) else [f for f in diagnostic_fragments(text) if damage_wording(f)]
        if frags:
            d.finding(kind, frags[0], {'part': part}, True)
            d.integrity = 'damaged'
            if part == 'container':
                d.container = 'damaged'
        else:
            d.unresolved.append('the output is plain text this layer does not parse; it is kept as facts.raw and settles nothing')
    elif obs['status'] in ('ok', 'partial') and d.execution['state'] == 'ran':
        d.facts = {'raw': text}


def _finish(d, data):
    ex = d.execution
    if len(ex.get('reason') or '') > 200:     # the header stays small; the whole text is a fact
        d.facts = dict(d.facts if isinstance(d.facts, dict) else {}, message=ex['reason'])
        ex['reason'] = ex['reason'][:200] + '...[whole text in facts.message]'
    if ex['state'] != 'ran':      # a run that failed, timed out or never ran cannot certify anything clean, whatever its output text says
        if d.integrity == 'clean':
            d.integrity = UNKNOWN
        if d.container == 'clean':
            d.container = UNKNOWN
        if ex['state'] != 'timed_out':        # a timeout keeps the windows its output positively shows (partial coverage); it just certifies nothing as a whole
            d.intervals = [iv for iv in d.intervals if iv['state'] != 'clean']      # (the stages a package inspector reports as passed before its failure stay: they are its own findings)
    if ex['state'] == 'ran' and ex['status'] == 'ok' and any(f['known_defect'] for f in d.findings):
        d.conflict('status_ok_with_defect', 'the tool reported status ok and also reported a defect: ok means the tool ran, not that the file has no defect',
                   [f['id'] for f in d.findings if f['known_defect']])
    if ex['state'] == 'ran' and ex['status'] == 'partial':
        d.unresolved.append('the answer is incomplete (status partial); the missing part is unverified')
    if ex['state'] in ('timed_out', 'unavailable') or (ex['state'] == 'failed' and not any(f['known_defect'] for f in d.findings)):
        d.unresolved.append('this call settled nothing about %s' % AREA.get(d.obs['tool'], 'its subject'))
    if ex['output_truncated']:
        d.unresolved.append('the tool output was cut before it reached the model; the cut part is unseen')
    if d.integrity == UNKNOWN and d.obs['tool'] in INTEGRITY_TOOLS and ex['state'] == 'ran' and not any(f['known_defect'] for f in d.findings):
        d.unresolved.append('the recorded fields do not say whether this check was clean')


AREA = {'ffprobe': 'the container, stream and chapter metadata', 'decode_sample': 'decodability of the requested window', 'frame_sample': 'the picture at the requested offset',
        'audio_sample': 'audio levels in the requested window', 'ocr': 'on-screen text at the requested offset', 'epub_inspect': 'the EPUB archive and package',
        'audiobook_inspect': 'audiobook parts, chapters and tags', 'arr_lookup': 'the *arr record', 'prior_record': 'the prior record'}


# ---- ffprobe
def _norm_stream(s):
    pix = s.get('pix_fmt')
    return {k: v for k, v in (
        ('index', s.get('index')), ('type', s.get('codec_type') or s.get('type')), ('codec', s.get('codec_name') or s.get('codec')), ('profile', s.get('profile')),
        ('pix_fmt', pix), ('bit_depth', bit_depth(pix)), ('width', s.get('width')), ('height', s.get('height')), ('channels', s.get('channels')),
        ('channel_layout', s.get('channel_layout')), ('sample_rate_hz', fint(s.get('sample_rate'))),
        ('language', (s.get('tags') or {}).get('language') if isinstance(s.get('tags'), dict) else s.get('language'))) if v is not None}


def bit_depth(pix_fmt):
    if not isinstance(pix_fmt, str):
        return None
    m = re.search(r'p(\d{2})(?:le|be)?$', pix_fmt)
    if m:
        return int(m[1])
    return 8 if re.fullmatch(r'(yuvj?\d{3}p|nv12|nv21|rgb24|bgr24|gray|yuva\d{3}p)', pix_fmt) else None


def _derive_probe(d, data):
    ex = d.execution
    d.scope['requested'] = {'what': 'container, stream and chapter metadata'}
    if ex['status'] in ('ok', 'partial') and isinstance(data, dict):
        fmt = data.get('format') if isinstance(data.get('format'), dict) else {}
        streams = data.get('streams')
        selection = None
        if isinstance(streams, dict):   # a recorded observation of real media: {container, video, selected_audio}
            sl, selection = [], 'recorded'
            for role in ('video', 'selected_video', 'selected_audio'):
                s = streams.get(role)
                if isinstance(s, dict):
                    ns = _norm_stream(s)
                    ns['role'] = role
                    sl.append(ns)
            container = streams.get('container')
        else:
            sl = [_norm_stream(s) for s in (streams if isinstance(streams, list) else []) if isinstance(s, dict)]
            container = fmt.get('format_name') or data.get('container')
        dur = fnum(fmt.get('duration')) if fmt else fnum(data.get('duration_s'))
        chapters = []
        for c in data.get('chapters') or []:
            if isinstance(c, dict):
                chapters.append({'start_s': fnum(c.get('start', c.get('start_s', c.get('start_time')))), 'end_s': fnum(c.get('end', c.get('end_s', c.get('end_time')))),
                                 'title': c.get('title')})
        stderr = data.get('stderr')
        facts = {'container': container, 'duration_s': dur, 'size_bytes': fint(fmt.get('size')) if fmt else None,
                 'bit_rate_bps': fint(fmt.get('bit_rate')) if fmt else None, 'tags': fmt.get('tags') if fmt else None, 'streams': sl, 'chapters': chapters}
        if isinstance(stderr, str) and stderr.strip():
            facts['stderr_lines'] = lines_of(stderr)
        d.facts = {k: v for k, v in facts.items() if v not in (None, [], {})}
        d.duration_s = dur
        d.probe = {'container': container, 'streams': sl, 'selection': selection}
        d.scope['completed'].update(streams=len(sl), chapters=len(chapters))
        if isinstance(stderr, str) and stderr.strip():
            known = damage_wording(stderr)
            d.finding('probe_messages' if not known else 'container_damage', stderr, {'part': 'container'}, known)
            d.container = 'damaged' if known else UNKNOWN
        elif d.obs['status'] == 'ok' and container and sl and data.get('exit_code') in (0, None):
            d.container = 'clean'     # a positive observation: a parsed container and its streams, exit 0 (or no exit code), no messages
        else:
            d.container = UNKNOWN     # an empty or partial answer says nothing about the container
        d.integrity = d.container or UNKNOWN
        if not sl:
            d.unresolved.append('the result lists no streams')
        if dur is None:
            d.unresolved.append('the container duration is not stated')
        d.unresolved.append('nothing was decoded: stream contents are unchecked by this result')
        return
    if isinstance(data, dict) and ('exit_code' in data or 'stderr' in data):
        _failed_exit(d, data, 'container')


def _failed_exit(d, data, part):
    code, stderr = data.get('exit_code'), str(data.get('stderr') or '')
    known = damage_wording(stderr)
    if known:
        d.finding('container_damage' if part == 'container' else 'decoder_errors', stderr, {'part': part, 'exit_code': code}, True)
        d.integrity = 'damaged'
        if part == 'container':
            d.container = 'damaged'
    else:
        d.finding('exit_nonzero_unclassified', 'exit code %s%s' % (code, ('; ' + stderr) if stderr.strip() else ' with no message'), {'part': part, 'exit_code': code}, False)
        d.container = UNKNOWN if part == 'container' else None


# ---- decode
def _offset_of(args):
    """The requested start, with the harness' own aliases (`at`, else `ss`, else `t`)."""
    return _first_num(args, ('at', 'ss', 't'))


def _derive_decode(d, data, known_duration):
    obs = d.obs
    args = obs['args']
    full_req = args.get('full') is True or args.get('t') == 'full'
    req_at = None if full_req else _offset_of(args)
    d.scope['requested'] = {'window': 'full'} if full_req else {'at_s': req_at if req_at is not None else 0.0}
    if not isinstance(data, dict) or not ('exit_code' in data or 'stderr' in data):
        return
    code = data.get('exit_code')
    stderr = data.get('stderr') if 'stderr' in data else None
    blank = stderr is None or not str(stderr).strip()
    frames = data.get('frames')
    decoded = hms(data.get('out_time')) if data.get('out_time') is not None else hms(data.get('decoded_s'))
    window_field = data.get('window_s')
    wnum = next((num(data[k]) for k in ('window_s', 't', 'duration_limit_seconds') if num(data.get(k)) is not None), None)
    served = _first_num(data, ('at_s', 'ss'))
    # a result is a full decode only when it SAYS so (window `full`, or a recorded `t: full`); a request for one, or the absence of a limit, proves nothing
    result_is_full = window_field == 'full' or data.get('t') == 'full'
    window_stated = wnum is not None or served is not None
    quota = data.get('quota_exhausted') is True
    bytes_read = num(data.get('bytes_read'))
    dur = known_duration
    sel = data.get('streams_selected')
    streams = list(sel) if isinstance(sel, list) and sel else [UNRECORDED]
    d.scope['completed']['streams'] = list(sel) if isinstance(sel, list) and sel else UNKNOWN
    # requested versus completed
    if full_req and not result_is_full:
        if window_stated:
            d.conflict('request_not_honored', 'a full decode was requested; the result is a %s window starting at %g s, not the whole file' % (
                ('%g s' % wnum) if wnum is not None else 'bounded', served if served is not None else 0.0))
            d.unresolved.append('the whole file was not decoded: a full decode was requested and only a window completed')
        else:
            d.unresolved.append('a full decode was requested; the result does not say whether it covers the whole file')
    start = 0.0 if (result_is_full or (full_req and not window_stated)) else (served if served is not None else (req_at if req_at is not None else 0.0))
    if not full_req and req_at is not None and served is not None:
        reach = wnum if wnum is not None else (decoded or 0.0)
        if not (served <= req_at < served + max(reach, 1e-9)) and not (served == req_at):
            d.conflict('request_not_honored', 'a window at %g s was requested; the result covers the window starting at %g s' % (req_at, served))
    # span
    if decoded is not None and decoded > 0:
        end, basis = start + decoded, ('full_decode' if result_is_full else 'observed')
    elif wnum is not None and not result_is_full and frames != 0 and (frames or bytes_read):
        end, basis = start + wnum, 'requested_window'
    else:
        end, basis = None, 'unknown'
    if end is not None and dur is not None:
        end = min(end, dur)
    nothing = frames == 0 or (dur is not None and start >= dur)
    positive = (num(frames) is not None and frames > 0) or (decoded is not None and decoded > 0) or (bytes_read is not None and bytes_read > 0)
    # state: only a positive, recognised observation is clean or damaged; anything else stays unknown
    state = None
    if code == 'timeout':
        d.unresolved.append('the decode was stopped at its time limit; only the span it reports was covered')
    if quota:
        state = 'not_checked'
        d.unresolved.append('the sampler stopped at its input quota: a quota-limited sample does not prove corruption')
    elif not blank:
        loc = {'part': 'decode', 'start_s': round(start, 3)}
        if end is not None:
            loc['end_s'] = round(end, 3)
        if damage_wording(stderr):
            f = d.finding('decoder_errors', str(stderr), loc, True)
            state = 'damaged'
            if code == 0:
                d.conflict('exit_zero_with_decoder_errors', 'the decoder exited 0 but printed errors: an exit code of zero does not mean the data decoded cleanly', [f['id']])
        else:
            d.finding('decoder_messages_unclassified', str(stderr), loc, False)
            state = 'unclassified'
            d.unresolved.append('the decoder printed text this layer does not recognise as damage; it is neither a defect nor a clean result')
    elif num(code) is not None and code != 0:
        d.finding('exit_nonzero_unclassified', 'decoder exit code %s with no message' % code, {'part': 'decode'}, False)
    elif nothing:
        state = 'not_checked'
        d.unresolved.append('the window decoded no frames (it starts at or beyond the end of the media, or the stream is empty)')
    elif code in (0, 'timeout') and stderr is not None and positive:
        state = 'clean'
    elif code == 0 and stderr is not None:
        d.unresolved.append('the result states no frames, decoded span or bytes read: nothing positive shows that data was decoded')
    if state is None and code is None:
        d.unresolved.append('the recorded result states no exit code')
    if state in ('clean', 'damaged', 'unclassified'):
        if end is None or end <= start:
            d.unresolved.append('the covered span is not recorded (no decoded duration); it is not counted as coverage')
        else:
            d.intervals.append({'streams': streams, 'start_s': round(start, 3), 'end_s': round(end, 3), 'state': state, 'basis': basis})
            d.scope['completed'].update(start_s=round(start, 3), end_s=round(end, 3))
    d.integrity = {'clean': 'clean', 'damaged': 'damaged'}.get(state, UNKNOWN)
    if full_req and not result_is_full and window_stated:
        d.completed_to_eof = False                    # a window answered a whole-file request: the whole file was not decoded
        d.scope['completed']['to_end_of_file'] = False
    if result_is_full:
        # Completion needs affirmative evidence: an exit-0 decode whose decoded span reaches the KNOWN container duration.  A tool's own `completed_to_eof: true`
        # is a claim and is checked against the span; an unknown duration or span leaves completion unknown; a stated False (or a failed exit) is kept.
        claimed = data.get('completed_to_eof') if isinstance(data.get('completed_to_eof'), bool) else None
        if claimed is False or (code not in (0, None) and code is not None) or quota:
            eof = False if (claimed is False or code is not None) else None
        elif code == 0 and decoded is not None and decoded > 0 and dur is not None:
            if decoded + EOF_TOLERANCE_S < dur:
                eof = False
                d.conflict('decoded_span_shorter_than_duration', 'the full decode ended at %.3f s but the container states %.3f s' % (decoded, dur))
            else:
                eof = True
        else:
            eof = None
            if claimed is True:
                d.unresolved.append('the tool says the decode reached the end, but the decoded span or the container duration is not shown to check it')
        d.completed_to_eof = eof
        d.scope['completed']['to_end_of_file'] = eof if eof is not None else UNKNOWN
        if eof is not True:
            d.unresolved.append('the full decode did not run to the end of the file' if eof is False else 'whether the full decode ran to the end of the file is not shown')
    d.facts = {k: v for k, v in (('exit_code', code), ('frames', frames), ('decoded_s', fnum(decoded) if decoded is not None else None),
                                 ('error_lines', lines_of(stderr) or None), ('quota_exhausted', True if quota else None)) if v is not None}
    unmet = data.get('request_unmet')
    if isinstance(unmet, dict):
        d.conflict('request_not_honored', 'requested %s; completed %s (%s)' % (unmet.get('requested'), unmet.get('completed'), unmet.get('reason')))
        d.unresolved.append('the whole file was not decoded: %s' % (unmet.get('reason') or 'the request was not completed'))
    if d.scope['completed']['streams'] == UNKNOWN:
        d.unresolved.append('which streams were decoded is not recorded')


def _first_num(mapping, keys):
    for k in keys:
        v = mapping.get(k) if isinstance(mapping, dict) else None
        if num(v) is not None:
            return float(v)
    return None


# ---- epub
def _derive_epub(d, data):
    ex = d.execution
    d.scope['requested'] = {'what': 'archive, package and spine structure'}
    if not isinstance(data, dict):
        return
    stage, err = data.get('stage'), data.get('error')
    if data.get('status') == 'error' or stage:
        if stage in EPUB_STAGES:
            i = EPUB_STAGES.index(stage)
            d.package = {s: ('clean' if k < i else ('damaged' if k == i else 'not_checked')) for k, s in enumerate(EPUB_STAGES)}
            d.finding('package_damage', '%s at stage %s' % (err or 'the package inspector reported a failure', stage), {'part': 'package', 'stage': stage}, True)
            d.integrity = 'damaged'
        else:
            d.package = {s: UNKNOWN for s in EPUB_STAGES}
            d.finding('package_error_unclassified', str(err or data), {'part': 'package'}, False)
        d.scope['completed'].update(entries=data.get('entries'), bytes=data.get('bytes'), failed_stage=stage)
        d.facts = {k: v for k, v in (('bytes', data.get('bytes')), ('entries', data.get('entries')), ('error', err)) if v is not None}
        return
    if data.get('status') == 'ok' or 'spine_items' in data:
        d.package = {s: 'clean' for s in EPUB_STAGES}
        d.integrity = 'clean' if d.obs['status'] == 'ok' else UNKNOWN
        d.facts = {k: v for k, v in (
            ('title', data.get('dc_title')), ('creator', data.get('dc_creator')), ('language', data.get('dc_language')), ('identifier', data.get('dc_identifier')),
            ('entries', data.get('entries')), ('bytes', data.get('bytes')), ('spine_items', data.get('spine_items')), ('spine_characters', data.get('spine_characters')),
            ('spine_heads', data.get('spine_heads')), ('opf', data.get('opf'))) if v not in (None, [], '')}
        d.scope['completed'].update(entries=data.get('entries'), spine_items=data.get('spine_items'), stages_checked=list(EPUB_STAGES))
        heads = data.get('spine_heads')
        if isinstance(heads, list) and data.get('spine_items') and len(heads) < data['spine_items']:
            d.unresolved.append('only the first %d of %d spine items are shown as text; the rest is checked for structure only' % (len(heads), data['spine_items']))
        d.unresolved.append('no body text beyond the shown spine heads was read')


# ---- audiobook
def _derive_audiobook(d, data):
    d.scope['requested'] = {'what': 'audiobook parts, chapters and tags'}
    if not isinstance(data, dict):
        return
    d.integrity = 'clean' if (d.obs['status'] == 'ok' and data.get('format') and isinstance(data.get('audio_streams'), list) and data['audio_streams']) else UNKNOWN
    d.container = d.integrity if d.integrity == 'clean' else None
    chapters = [{'start_s': c.get('start_s'), 'end_s': c.get('end_s'), 'title': c.get('title')} for c in data.get('chapters') or [] if isinstance(c, dict)]
    d.facts = {k: v for k, v in (('container', data.get('format')), ('duration_s', data.get('duration_s')), ('tags', data.get('tags') or None),
                                 ('audio_streams', data.get('audio_streams')), ('chapter_count', data.get('chapter_count')), ('chapters', chapters or None)) if v is not None}
    d.duration_s = fnum(data.get('duration_s'))
    d.scope['completed'].update(chapters_listed=len(chapters), chapter_count=data.get('chapter_count'))
    d.probe = {'container': data.get('format'), 'streams': [_norm_stream(dict(s, codec_type='audio')) for s in data.get('audio_streams') or [] if isinstance(s, dict)], 'selection': None}
    if data.get('chapters_omitted'):
        d.scope['completed']['chapters_omitted'] = data['chapters_omitted']
        d.unresolved.append('%s chapters are not listed in this result' % data['chapters_omitted'])
    d.unresolved.append('nothing was decoded: chapter and part structure is as declared by the container')


# ---- audio levels
def _derive_audio(d, data):
    at = _first_num(d.obs['args'], ('at', 'ss', 't'))
    d.scope['requested'] = {'at_s': at if at is not None else 0.0, 'stream': d.obs['args'].get('stream', 0)}
    if not isinstance(data, dict):
        return
    served = _first_num(data, ('at_s',))
    d.facts = {k: v for k, v in data.items() if k in ('rms_dbfs', 'peak_dbfs', 'silent_fraction', 'samples', 'duration_s', 'sample_rate', 'stream') and v is not None}
    if served is not None:
        d.scope['completed'].update(at_s=served)
        if at is not None and served != at:
            d.conflict('request_not_honored', 'audio at %g s was requested; the recorded window served starts at %g s' % (at, served))
    d.integrity = 'clean' if d.obs['status'] == 'ok' and num(data.get('rms_dbfs')) is not None else UNKNOWN
    d.unresolved.append('signal statistics only; no speech recognition was run')


# ---- identity / catalog / picture records
def _derive_record(d, data):
    if data is None:
        text = d.obs['output'] if isinstance(d.obs['output'], str) else None
        if text and d.execution['state'] == 'ran':
            d.facts = {'text': text}
        return
    d.facts = data if isinstance(data, (dict, list)) else None
    if isinstance(data, dict) and d.obs['tool'] == 'ocr' and 't_s' in data:
        d.scope['completed']['at_s'] = data.get('t_s')
        d.facts = {k: data[k] for k in ('t_s', 'text', 'consensus') if k in data}
        req = _first_num(d.obs['args'], ('at', 'ss', 't'))
        if req is not None and num(data.get('t_s')) is not None and req != data['t_s']:
            d.conflict('request_not_honored', 'text at %g s was requested; the result is for %g s' % (req, data['t_s']))
    if d.obs['tool'] in ('ocr', 'arr_lookup', 'prior_record'):
        d.unresolved.append('this result is a record or reading, not an integrity check')


# ---- live collector records (shared vocabulary: coverage.verified / not_verified, cause input|tool)
def _recognised(text):
    return damage_wording(text)


def _segment(d, seg, streams, label=None, part=None):
    """One sampled decode window of a live collector (video decode, or an audiobook part).  Returns the interval it contributes, or None.  Only recognised
    damage wording makes a window damaged; other collector `errors` stay unclassified (not clean, not damaged); short, timed-out and capped windows cover nothing."""
    a = fnum(seg.get('at_s')) or 0.0
    dec = fnum(seg.get('decoded_s'))
    st = seg.get('state')
    end = round(a + (dec if dec is not None else (fnum(seg.get('window_s')) or 0.0)), 3)
    tag = (label + ': ') if label else ''
    loc = {'part': 'decode', 'start_s': a, 'end_s': end}
    if label:
        loc['file'] = label
    for line in seg.get('errors') or []:        # every raw diagnostic is kept as a fact, whatever it turns out to mean
        d.diagnostics.append({k: v for k, v in (('file', label), ('at_s', a), ('state', st), ('text', str(line))) if v is not None})
    if st == 'clean' and end > a:
        return {'streams': streams, 'start_s': a, 'end_s': end, 'state': 'clean', 'basis': 'observed'}
    if st == 'errors':
        text = '; '.join(str(x) for x in (seg.get('errors') or [])) or ('exit code %s' % seg.get('exit_code') if seg.get('exit_code') not in (None, 0) else 'decoder errors, text not recorded')
        if _recognised(text):
            d.finding('decoder_errors', text, loc, True)
            state = 'damaged'
        else:
            d.finding('decoder_messages_unclassified', text, loc, False)
            state = 'unclassified'
        return {'streams': streams, 'start_s': a, 'end_s': end, 'state': state, 'basis': 'observed'} if end > a else None
    d.unresolved.append('%swindow at %g s: %s' % (tag, a, st))
    return None


def _derive_live(d, data, known_duration):
    d.known_duration = known_duration
    out = data.get('output') if isinstance(data.get('output'), dict) else {}
    kind = data.get('tool') or d.obs['tool']
    cov = data.get('coverage') or {}
    d.collector_coverage = {'verified': [str(x) for x in (cov.get('verified') or [])], 'not_verified': [str(x) for x in (cov.get('not_verified') or [])]}
    d.unresolved += list(d.collector_coverage['not_verified'])
    d.scope['requested'] = {'what': 'live collector %s' % kind}
    for s in out.get('findings') or []:
        if kind not in ('epub',):    # the EPUB collector's findings are typed below (severity damage / warning)
            d.finding('collector_finding', s if isinstance(s, str) else canon(s), {'part': kind}, False)
    handler = {'decode': _live_decode, 'probe': _live_probe, 'epub': _live_epub, 'audiobook': _live_audiobook, 'audio': _live_audio}.get(kind)
    if handler:
        handler(d, out)
    else:
        d.integrity = 'not_integrity' if kind == 'frames' else UNKNOWN
        d.facts = {k: v for k, v in out.items() if isinstance(v, (str, int, float, bool)) and v is not None} or None
    if d.execution.get('cause') == 'input' and d.execution['state'] == 'failed' and not any(f['known_defect'] for f in d.findings):
        d.finding('input_failure', d.execution.get('reason') or 'the collector reports the input is damaged or unreadable', {'part': kind}, True)
        d.integrity = 'damaged'


def _live_decode(d, out):
    dur = fnum(out.get('duration_s'))
    d.duration_s = dur
    segs = out.get('segments') if isinstance(out.get('segments'), list) else []
    sel = list(COLLECTOR_STREAMS)
    for seg in segs:
        if isinstance(seg, dict):
            iv = _segment(d, seg, sel)
            if iv:
                d.intervals.append(iv)
    full = out.get('full')
    d.scope['completed']['streams'] = sel
    if isinstance(full, dict) and full.get('performed'):
        fdec = fnum(full.get('decoded_s'))
        fst = full.get('state')
        fdur = dur if dur is not None else d.known_duration
        # the collector's `clean` / `errors` says the decode PROCESS finished; whether it reached the end of the file is the same affirmative check as for every backend:
        # a decoded span that reaches the known duration (unknown span or duration leaves it unknown)
        if fst in ('timeout', 'spawn_error', 'output_cap'):
            eof = False
        elif fst in ('clean', 'errors') and fdec and fdur:
            if fdec + EOF_TOLERANCE_S < fdur:
                eof = False
                d.conflict('decoded_span_shorter_than_duration', 'the full decode ended at %.3f s but the container states %.3f s' % (fdec, fdur))
            else:
                eof = True
        else:
            eof = None
        d.completed_to_eof = eof
        d.scope['completed']['to_end_of_file'] = eof if eof is not None else UNKNOWN
        if eof is not True:
            d.unresolved.append('the full decode did not run to the end of the file' if eof is False else 'whether the full decode ran to the end of the file is not shown')
        if fst in ('clean', 'errors') and fdec:
            seg = {'at_s': 0.0, 'decoded_s': fdec, 'state': fst, 'errors': full.get('errors') or []}
            iv = _segment(d, seg, sel)
            if iv:
                iv['basis'] = 'full_decode'
                d.intervals.append(iv)
    states = {i['state'] for i in d.intervals}
    d.integrity = 'damaged' if 'damaged' in states else ('clean' if 'clean' in states and 'unclassified' not in states else UNKNOWN)
    d.facts = {k: v for k, v in (('duration_s', dur), ('segments', len(segs)), ('decoded_s', out.get('decoded_s')), ('covered_fraction', out.get('sampled_fraction'))) if v is not None}


def _live_probe(d, out):
    sl = [_norm_stream(dict(x, codec_type=x.get('type'), codec_name=x.get('codec'))) for x in out.get('streams') or [] if isinstance(x, dict)]
    d.probe = {'container': out.get('format'), 'streams': sl, 'selection': None}
    d.duration_s = fnum(out.get('duration_s'))
    d.container = 'clean' if d.obs['status'] == 'ok' and out.get('format') and sl else UNKNOWN
    d.integrity = d.container
    d.facts = {k: v for k, v in (('container', out.get('format')), ('duration_s', out.get('duration_s')), ('size_bytes', out.get('bytes')), ('tags', out.get('tags') or None),
                                 ('streams', sl or None), ('chapters', out.get('chapters') or None)) if v is not None}


def _live_epub(d, out):
    """The live EPUB collector's own schema: valid, stages_passed, stage / error on a failure, dc_* metadata, findings[{severity, what}]."""
    passed = [x for x in (out.get('stages_passed') or []) if x in EPUB_STAGES]
    failed_stage = out.get('stage') if out.get('stage') in EPUB_STAGES else None
    pk = {}
    for i, st in enumerate(EPUB_STAGES):
        if st in passed:
            pk[st] = 'clean'
        elif st == failed_stage:
            pk[st] = 'damaged' if d.execution.get('cause') == 'input' else UNKNOWN
        else:
            pk[st] = 'not_checked' if (failed_stage or d.obs['status'] != 'ok') else UNKNOWN
    d.package = pk
    damage = False
    if failed_stage:
        known = d.execution.get('cause') == 'input'
        d.finding('package_damage' if known else 'package_error_unclassified', '%s at stage %s' % (out.get('error') or 'the collector reported a failure', failed_stage),
                  {'part': 'package', 'stage': failed_stage}, known)
        damage = damage or known
    for f in out.get('findings') or []:
        if isinstance(f, dict):
            sev = f.get('severity')
            d.finding('package_damage' if sev == 'damage' else 'package_warning', f.get('what') or canon(f), {'part': 'package'}, sev == 'damage')
            damage = damage or sev == 'damage'
    if out.get('valid') is False:
        d.finding('package_invalid', 'the EPUB collector reports valid:false', {'part': 'package'}, False)
        d.veto = {'kind': 'package_invalid', 'location': {'part': 'package'}, 'detail': 'the EPUB collector reports valid:false', 'known_defect': False}
        damage = damage or d.execution.get('cause') == 'input' or any(f['known_defect'] for f in d.findings)
    d.integrity = 'damaged' if damage else ('clean' if out.get('valid') is True and d.obs['status'] == 'ok' and passed else UNKNOWN)
    d.facts = {k: v for k, v in (
        ('title', out.get('dc_title')), ('creator', out.get('dc_creator')), ('language', out.get('dc_language')), ('identifier', out.get('dc_identifier')),
        ('epub_version', out.get('epub_version')), ('entries', out.get('entries')), ('opf', out.get('opf')), ('manifest_items', out.get('manifest_items')),
        ('spine_items', out.get('spine_items')), ('spine_characters', out.get('spine_characters')), ('stages_passed', passed or None),
        ('valid', out.get('valid'))) if v not in (None, [], '')}
    d.scope['completed'].update(entries=out.get('entries'), stages_checked=passed, failed_stage=failed_stage)


def _live_audiobook(d, out):
    """The live audiobook collector's schema: files[{format, duration_s, audio_streams, tags, chapters, chapter_findings, decode{segments}, probe...}],
    tag_consistency, findings.  Facts and explicit damage are kept per part; decode windows are scoped to their part."""
    files = [f for f in out.get('files') or [] if isinstance(f, dict)]
    d.duration_s = None
    damaged = unclassified = False
    parts = []
    facts_files, chapters_all = [], []
    for n, f in enumerate(files, 1):
        label = 'part-%d' % n
        row = {'n': n, 'probe': f.get('probe', 'ok' if f.get('format') else UNKNOWN), 'intervals': []}
        if f.get('probe') not in (None, 'ok'):
            cause = f.get('probe_cause')
            known = cause == 'input'
            d.finding('part_unreadable' if known else 'part_probe_failed', '%s: ffprobe %s%s' % (label, f.get('probe'), (' (%s)' % f['probe_reason']) if f.get('probe_reason') else ''),
                      {'part': 'container', 'file': label}, known)
            damaged = damaged or known
            parts.append(row)
            continue
        facts_files.append({k: v for k, v in (('n', n), ('format', f.get('format')), ('duration_s', f.get('duration_s')), ('bytes', f.get('bytes')),
                                              ('audio_streams', f.get('audio_streams')), ('tags', f.get('tags') or None), ('chapter_count', f.get('chapter_count'))) if v is not None})
        for c in f.get('chapters') or []:
            if isinstance(c, dict):
                chapters_all.append({'part': n, 'start_s': c.get('start_s'), 'end_s': c.get('end_s'), 'title': c.get('title')})
        for cf in f.get('chapter_findings') or []:
            d.finding('chapter_observation', '%s: %s' % (label, cf), {'part': 'chapters', 'file': label}, False)
        dec = f.get('decode')
        if isinstance(dec, dict):
            for seg in dec.get('segments') or []:
                if isinstance(seg, dict):
                    iv = _segment(d, seg, ['%s:0:a:0' % label], label)
                    if iv:
                        row['intervals'].append(iv)
                        damaged = damaged or iv['state'] == 'damaged'
                        unclassified = unclassified or iv['state'] == 'unclassified'
        row['duration_s'] = f.get('duration_s')
        parts.append(row)
    d.parts = parts
    tc = out.get('tag_consistency')
    if isinstance(tc, dict):
        if tc.get('consistent') is False:
            d.finding('tags_differ_across_parts', canon({k: tc.get(k) for k in ('inconsistent', 'missing_in', 'track_issue') if tc.get(k)}), {'part': 'tags'}, False)
    all_probed = bool(files) and out.get('parts_probed') == out.get('parts') == len(files)
    d.integrity = 'damaged' if damaged else ('clean' if (d.obs['status'] == 'ok' and all_probed and not unclassified) else UNKNOWN)
    d.container = d.integrity if d.integrity in ('clean', 'damaged') else None
    d.facts = {k: v for k, v in (('parts', out.get('parts')), ('parts_probed', out.get('parts_probed')), ('total_duration_s', out.get('total_duration_s')),
                                 ('files', facts_files or None), ('chapters', chapters_all or None),
                                 ('tag_consistent', (tc or {}).get('consistent') if isinstance(tc, dict) else None)) if v is not None}
    d.scope['completed'].update(parts=out.get('parts'), parts_probed=out.get('parts_probed'))


def _live_audio(d, out):
    streams = [x for x in out.get('streams') or [] if isinstance(x, dict)]
    bad = False
    good = False
    for st in streams:
        for seg in st.get('segments') or []:
            if not isinstance(seg, dict):
                continue
            if seg.get('state') == 'errors':
                for line in seg.get('problems') or []:
                    d.diagnostics.append({'at_s': seg.get('at_s'), 'state': 'errors', 'text': str(line)})
                text = '; '.join(str(x) for x in (seg.get('problems') or [])) or 'audio decode errors'
                known = _recognised(text)
                d.finding('audio_decode_errors' if known else 'audio_messages_unclassified', text, {'part': 'audio', 'start_s': seg.get('at_s')}, known)
                bad = bad or known
            elif seg.get('state') in ('ok', 'near_silent'):
                good = True
    d.integrity = 'damaged' if bad else ('clean' if good and d.obs['status'] == 'ok' and not any(f['kind'] == 'audio_messages_unclassified' for f in d.findings) else UNKNOWN)
    d.facts = {'duration_s': out.get('duration_s'), 'streams': len(streams)} if out.get('duration_s') is not None else None


# ------------------------------------------------------------------------------------------------------------------ analysis (the item)
def analyze(observations, context=None, media_type=None):
    """-> {'items': {id: Derived}, 'order': [ids], 'coverage': dict, 'client': dict|None, 'alerts': [...]}.  Observations are processed
    probe-first only to learn a duration; every result is then derived once."""
    dur = None
    for o in observations:
        if o['tool'] in ('ffprobe', 'audiobook_inspect') and o['status'] == 'ok':
            dd = derive(o)
            if dd.duration_s:
                dur = dd.duration_s
                break
    items = {}
    order = []
    for o in observations:
        items[o['id']] = derive(o, dur)
        order.append(o['id'])
    first = None
    for i in order:   # two results that state different container durations contradict each other: said, not averaged
        dd = items[i]
        if dd.duration_s and dd.execution['status'] == 'ok':
            if first is None:
                first = dd
            elif abs(dd.duration_s - first.duration_s) > EOF_TOLERANCE_S:
                dd.conflict('duration_mismatch', 'this result states a duration of %g s; %s states %g s' % (dd.duration_s, first.obs['id'], first.duration_s), [first.obs['id']])
    try:
        cov = build_coverage([items[i] for i in order])
    except Exception as e:  # noqa: BLE001 - reported, never guessed
        cov = {'error': 'the coverage matrix could not be built (%s)' % type(e).__name__}
    try:
        client = compare_client(context or {}, [items[i] for i in order])
    except Exception as e:  # noqa: BLE001
        client = {'stated_by_case': True, 'rows': [], 'summary': {'complete': False, 'why': 'the comparison could not be built (%s)' % type(e).__name__}}
    return {'items': items, 'order': order, 'coverage': cov, 'client': client, 'duration_s': dur}


def build_coverage(derived):
    """Coverage matrix over every shown observation.  Order independent: damaged overrides clean in an overlap, so adding a clean observation
    never erases a damaged one.  Streams are keyed by the selection the result states; an unrecorded selection is its own key."""
    dur = next((d.duration_s for d in derived if d.duration_s), None)
    probes = [d for d in derived if d.probe is not None]
    cov = {'duration_s': dur if dur is not None else UNKNOWN}
    # container
    cstates = [d.container for d in derived if d.container]
    if any(s == 'damaged' for s in cstates):
        cov['container'] = {'state': 'damaged', 'by': [d.obs['id'] for d in derived if d.container == 'damaged']}
    elif any(s == 'clean' for s in cstates):
        cov['container'] = {'state': 'clean', 'by': [d.obs['id'] for d in derived if d.container == 'clean']}
    elif any(d.obs['tool'] in ('ffprobe', 'audiobook_inspect') for d in derived):
        cov['container'] = {'state': UNKNOWN, 'by': [d.obs['id'] for d in derived if d.obs['tool'] in ('ffprobe', 'audiobook_inspect')]}
    else:
        cov['container'] = {'state': 'not_checked'}
    # time intervals, one row per stream the results name (a window that names its streams counts for each of them; an unnamed selection is its own row)
    per = {}
    for d in derived:
        for iv in d.intervals:
            for key in iv['streams']:
                slot = per.setdefault(key, {'clean': [], 'damaged': [], 'unclassified': [], 'by': set()})
                slot[iv['state']].append((iv['start_s'], iv['end_s']))
                slot['by'].add(d.obs['id'])
    streams_cov = {}
    resolved = {}
    for key in sorted(per):
        slot = per[key]
        damaged = clip_to(norm_intervals(slot['damaged']), 0.0, dur)
        unclassified = subtract(clip_to(norm_intervals(slot['unclassified']), 0.0, dur), damaged)
        clean = subtract(subtract(clip_to(norm_intervals(slot['clean']), 0.0, dur), damaged), unclassified)   # damaged and unclassified both override clean
        resolved[key] = (clean, damaged, unclassified)
        row = {'clean': listed(clean), 'damaged': listed(damaged)}
        if unclassified:
            row['unclassified'] = listed(unclassified)     # a decoder printed text this layer does not recognise: neither clean nor damaged
        row['by'] = sorted(slot['by'])
        seen_iv = norm_intervals(clean + damaged + unclassified)
        if dur is not None:
            row['not_checked'] = listed(subtract([(0.0, dur)], seen_iv))
            row['checked_fraction'] = round(length(seen_iv) / dur, 3) if dur else UNKNOWN
        else:
            row['not_checked'] = UNKNOWN
        row['selection'] = 'recorded' if key != UNRECORDED else UNKNOWN
        streams_cov[key] = row
    cov['time'] = streams_cov if streams_cov else {'state': 'not_checked'}
    # stream list (from the container's declaration) with a decode state per stream
    sl = None
    for d in probes:
        if d.probe['streams']:
            sl = d.probe['streams']
            break
    if sl is not None:
        rows = []
        seen = {}
        for s in sl:
            row = {k: v for k, v in (('index', s.get('index')), ('role', s.get('role')), ('type', s.get('type')), ('codec', s.get('codec'))) if v is not None}
            typ = s.get('type')
            k = seen.get(typ, 0)
            seen[typ] = k + 1
            name = '0:%s:%d' % ({'video': 'v', 'audio': 'a', 'subtitle': 's'}.get(typ, 'x'), k)
            slot = per.get(name)
            if not per:
                row['decode'] = 'not_checked'
            elif slot is not None:
                row['decode'] = 'damaged' if slot['damaged'] else 'checked_in_windows'
            elif UNRECORDED in per:
                row['decode'] = UNKNOWN
                row['why'] = 'which streams the decode windows covered is not recorded'
            else:
                row['decode'] = 'not_checked'
            rows.append(row)
        cov['streams'] = rows[:32]
        if len(rows) > 32:
            cov['streams_omitted'] = len(rows) - 32
    # chapters, per stream: a chapter is judged separately for every stream the decode windows or the container name; there is no combined label
    chapters = None
    for d in derived:
        ch = (d.facts or {}).get('chapters') if isinstance(d.facts, dict) else None
        if isinstance(ch, list) and ch and isinstance(ch[0], dict) and 'part' not in ch[0]:
            chapters = ch
            break
    if chapters:
        names = set(per)
        if sl is not None:
            seen2 = {}
            for st in sl:
                typ = st.get('type')
                k2 = seen2.get(typ, 0)
                seen2[typ] = k2 + 1
                names.add('0:%s:%d' % ({'video': 'v', 'audio': 'a', 'subtitle': 's'}.get(typ, 'x'), k2))
        rows = []
        for i, c in enumerate(chapters[:60]):
            a, b = c.get('start_s'), c.get('end_s')
            row = {'n': i + 1, 'title': c.get('title'), 'start_s': a, 'end_s': b}
            by = {}
            for name in sorted(names):
                if a is None or b is None or b <= a:
                    by[name] = UNKNOWN
                elif name not in resolved:
                    by[name] = UNKNOWN if UNRECORDED in per and name != UNRECORDED else 'not_checked'
                else:
                    clean, damaged, unclassified = resolved[name]
                    dmg = length(clip_to(damaged, a, b))
                    unc = length(clip_to(unclassified, a, b))
                    chk = length(clip_to(clean, a, b)) + dmg + unc
                    by[name] = ('damaged' if dmg > 0 else 'unclassified' if unc > 0 else 'clean' if chk >= (b - a) - 1e-6 else 'partly_checked' if chk > 0 else 'not_checked')
            row['by_stream'] = by
            rows.append({k: v for k, v in row.items() if v is not None})
        cov['chapters'] = rows
        if len(chapters) > 60:
            cov['chapters_omitted'] = len(chapters) - 60
    # audiobook parts (decode windows are per part)
    prow = []
    for d in derived:
        for p_ in d.parts:
            ivs = p_['intervals']
            row = {'src': d.obs['id'], 'n': p_['n'], 'probe': p_['probe']}
            for st in ('clean', 'damaged', 'unclassified'):
                got = norm_intervals([(i['start_s'], i['end_s']) for i in ivs if i['state'] == st])
                if st == 'clean':
                    got = subtract(got, norm_intervals([(i['start_s'], i['end_s']) for i in ivs if i['state'] in ('damaged', 'unclassified')]))
                if got or st == 'clean':
                    row[st] = listed(got)
            prow.append(row)
    if prow:
        cov['parts'] = prow[:60]
        if len(prow) > 60:
            cov['parts_omitted'] = len(prow) - 60
    # package
    pk = [d for d in derived if d.package]
    if pk:
        merged = {}
        for d in pk:
            for stage, st in d.package.items():
                prev = merged.get(stage)
                merged[stage] = st if prev is None else ('damaged' if 'damaged' in (prev, st) else ('clean' if 'clean' in (prev, st) else prev))
        cov['package'] = {'stages': merged, 'by': [d.obs['id'] for d in pk]}
    return cov


# ------------------------------------------------------------------------------------------------------------------ client comparison
def client_profile(context):
    if not isinstance(context, dict):
        return None
    return context.get('client_profile') or ((context.get('expected') or {}).get('client_profile') if isinstance(context.get('expected'), dict) else None)


def _canon_codec(c):
    c = str(c).lower().strip()
    return CODEC_ALIAS.get(c, c)


def parse_client(profile):
    """The stated client as comparable fields.  Structured keys are read directly; the prose forms ("h264, 8-bit yuv420p, up to 1080p",
    "aac, ac3 or eac3, up to 6 channels") are read by a small fixed grammar.  Anything not stated stays absent (never inferred)."""
    spec = {'containers': None, 'video_codecs': None, 'bit_depths': None, 'pix_fmts': None, 'max_width': None, 'max_height': None,
            'audio_codecs': None, 'max_channels': None, 'layouts': None, 'video_profiles': None, 'audio_profiles': None, 'pix_by_codec': None, 'not_compared': []}
    if not isinstance(profile, dict):
        return spec
    c = profile.get('containers')
    if isinstance(c, str):
        c = [c]
    if isinstance(c, list):
        spec['containers'] = [str(x).lower() for x in c]
    if profile.get('video_codec'):
        spec['video_codecs'] = {_canon_codec(profile['video_codec']): None}
    if profile.get('video_pix_fmt'):
        spec['pix_fmts'] = {str(profile['video_pix_fmt']).lower()}
    if num(profile.get('max_width')) is not None:
        spec['max_width'] = profile['max_width']
    if num(profile.get('max_height')) is not None:
        spec['max_height'] = profile['max_height']
    if isinstance(profile.get('audio_codecs'), list):
        spec['audio_codecs'] = {_canon_codec(x) for x in profile['audio_codecs']}
    if num(profile.get('max_audio_channels')) is not None:
        spec['max_channels'] = profile['max_audio_channels']
    if isinstance(profile.get('audio_layouts'), list):
        spec['layouts'] = {str(x).lower() for x in profile['audio_layouts']}
    if isinstance(profile.get('video_profiles'), list):
        spec['video_profiles'] = {str(x).lower() for x in profile['video_profiles']}
    if isinstance(profile.get('audio_profiles'), list):
        spec['audio_profiles'] = {str(x).lower() for x in profile['audio_profiles']}
    vp = profile.get('video')
    if isinstance(vp, str):
        _parse_video_prose(vp, spec)
    ap = profile.get('audio')
    if isinstance(ap, str):
        _parse_audio_prose(ap, spec)
    known = {'definition', 'containers', 'video_codec', 'video_pix_fmt', 'max_width', 'max_height', 'audio_codecs', 'max_audio_channels', 'audio_layouts',
             'video_profiles', 'audio_profiles', 'video', 'audio', 'subtitles'}
    spec['not_compared'] = sorted(k for k in profile if k not in known) + spec['not_compared']
    if (isinstance(vp, str) and spec['video_codecs'] is None and not any('video:' in x for x in spec['not_compared'])) or \
            (isinstance(ap, str) and spec['audio_codecs'] is None and not any('audio:' in x for x in spec['not_compared'])):
        spec['not_compared'].append('prose not fully read')
    return spec


def _residual(text, patterns):
    """Words left after the recognised phrases (and the connectors `or`, `and`, punctuation) are removed.  Anything left is a statement this grammar does
    not read -- 'only', 'no', 'not', 'except', 'support' -- and makes the whole clause unread: a restriction must never be turned into support."""
    t = text.lower()
    for rx in patterns:
        t = rx.sub(' ', t)
    t = re.sub(r'[(),;.:]|\bor\b|\band\b', ' ', t)
    return t.split()


_VCODEC = r'\b(?:%s)\b' % '|'.join(list(VIDEO_CODECS) + list(CODEC_ALIAS))
_ACODEC = r'\b(?:%s)\b' % '|'.join(AUDIO_CODECS)
_PIX = r'\b(?:yuvj?\d{3}p\d*(?:le|be)?|nv12)\b'


def _parse_video_prose(text, spec):
    """Structure: `<codec> [<N>-bit ...] [<pixfmt> ...]` repeated, joined by `or` / `and` / commas, with at most one `up to <N>p`.  A depth or pixel format belongs to the
    codec it FOLLOWS and is applied to that codec in the comparison; one that precedes every codec ("8-bit hevc"), a second `up to`, or any word the grammar does not know
    makes the whole clause unread.  Every recognised token is therefore used in a comparison or the clause is not read at all."""
    t = text.lower()
    left = _residual(t, [re.compile(_VCODEC), re.compile(r'\d+-bit'), re.compile(_PIX), re.compile(r'up to \d{3,4}p')])
    if left:
        spec['not_compared'].append('video: statement not read (%s)' % ' '.join(left[:6]))
        return
    hits = [(m.start(), m.end(), _canon_codec(m.group(0))) for m in re.finditer(_VCODEC, t)]
    heights = re.findall(r'up to (\d{3,4})p', t)
    lead = t[:hits[0][0]] if hits else t
    if len(heights) > 1 or (hits and (re.search(r'\d+-bit', lead) or re.search(_PIX, lead))) or (not hits and (re.search(r'\d+-bit', t) or re.search(_PIX, t))):
        spec['not_compared'].append('video: statement not read (a bit depth, pixel format or limit with no codec it belongs to, or two limits)')
        return
    if hits:
        codecs, pix = {}, {}
        for i, (st, e, name) in enumerate(hits):
            nxt = hits[i + 1][0] if i + 1 < len(hits) else len(t)
            seg = t[e:nxt].split('up to')[0]
            depths = {int(x) for x in re.findall(r'(\d+)-bit', seg)}
            if depths:
                codecs[name] = (codecs.get(name) or set()) | depths
            else:
                codecs.setdefault(name, None)
            ps = set(re.findall(_PIX, seg))
            if ps:
                pix[name] = pix.get(name, set()) | ps
        spec['video_codecs'] = codecs
        spec['pix_by_codec'] = pix or None
    if heights:
        spec['max_height'] = int(heights[0])


def _parse_audio_prose(text, spec):
    t = text.lower()
    left = _residual(t, [re.compile(_ACODEC), re.compile(r'up to \d+ channels?')])
    if left or len(re.findall(r'up to \d+ channels?', t)) > 1:
        spec['not_compared'].append('audio: statement not read (%s)' % (' '.join(left[:6]) or 'two channel limits'))
        return
    found = {_canon_codec(m.group(0)) for m in re.finditer(_ACODEC, t)}
    if found:
        spec['audio_codecs'] = found
    m = re.search(r'up to (\d+) channels?', t)
    if m:
        spec['max_channels'] = int(m[1])


def _verdict(field, stream_ref, value, client, ok, why=None):
    row = {'field': field, 'stream': stream_ref, 'file': value, 'client': client, 'verdict': UNKNOWN if ok is None else ('supported' if ok else 'unsupported')}
    if why:
        row['why'] = why
    return row


def compare_client(context, derived):
    """Each selected stream field against the capability the case STATES.  None when the case states no client.  No client is inferred, a
    stream selection that is not recorded cannot support an overall claim, and incompatibility is never reported as damage."""
    prof = client_profile(context)
    if not prof:
        return None
    spec = parse_client(prof)
    probe = next((d.probe for d in derived if d.probe and d.probe['streams']), None)
    out = {'stated_by_case': True, 'rows': [], 'not_stated': [], 'not_compared': spec['not_compared']}
    if probe is None:
        out['summary'] = {'supported': 0, 'unsupported': 0, 'unknown': 0, 'selection': UNKNOWN, 'complete': False,
                          'why': 'no stream facts are shown yet (no ffprobe-type result), so nothing can be compared'}
        return out
    rows = out['rows']
    sel_state = 'recorded' if probe['selection'] == 'recorded' else 'derived_from_stream_list'
    streams = probe['streams']
    by_type = {}
    for s in streams:
        by_type.setdefault(s.get('type'), []).append(s)
    selection = {}
    complete = True
    for typ in ('video', 'audio'):
        cands = by_type.get(typ, [])
        if probe['selection'] == 'recorded':
            selection[typ] = ('recorded', cands[:1] if typ == 'video' else cands)
        elif len(cands) == 1:
            selection[typ] = ('only_stream_of_type', cands)
        elif len(cands) > 1:
            selection[typ] = ('ambiguous', cands)
            complete = False
        else:
            selection[typ] = ('absent', [])
    out['selection'] = {t: {'how': v[0], 'streams': [s.get('index', s.get('role')) for s in v[1]]} for t, v in selection.items()}
    if probe.get('container') is not None and spec['containers'] is not None:
        ftoks = {x.strip().lower() for x in str(probe['container']).split(',')}
        okc = any((set(x.strip().lower() for x in c.split(',')) <= ftoks) or (ftoks <= set(x.strip().lower() for x in c.split(','))) for c in spec['containers'])
        rows.append(_verdict('container', 'file', probe['container'], spec['containers'], okc))
    elif spec['containers'] is None:
        out['not_stated'].append('container')
    else:
        rows.append(_verdict('container', 'file', None, spec['containers'], None, 'the file container is not shown'))
    for typ in ('video', 'audio'):
        how, cands = selection[typ]
        for s in cands:
            ref = s.get('index', s.get('role'))
            if typ == 'video':
                codec = _canon_codec(s['codec']) if s.get('codec') else None
                if spec['video_codecs'] is not None:
                    rows.append(_verdict('video_codec', ref, codec, sorted(spec['video_codecs']), None if codec is None else codec in spec['video_codecs']))
                else:
                    out['not_stated'].append('video_codec')
                if spec['video_profiles'] is not None:
                    pr = s.get('profile')
                    rows.append(_verdict('video_profile', ref, pr, sorted(spec['video_profiles']), None if pr is None else str(pr).lower() in spec['video_profiles']))
                depth = s.get('bit_depth')
                allowed = spec['video_codecs'].get(codec) if (spec['video_codecs'] and codec) else None
                if allowed:
                    rows.append(_verdict('video_bit_depth', ref, depth, sorted(allowed), None if depth is None else depth in allowed,
                                         None if depth is not None else 'bit depth is not derivable from the stated pixel format'))
                pixset = (spec['pix_by_codec'] or {}).get(codec) if spec['pix_by_codec'] else None
                pixset = pixset or spec['pix_fmts']
                if pixset:
                    rows.append(_verdict('video_pix_fmt', ref, s.get('pix_fmt'), sorted(pixset), None if s.get('pix_fmt') is None else str(s['pix_fmt']).lower() in pixset))
                if spec['max_height'] is not None:
                    rows.append(_verdict('video_height_px', ref, s.get('height'), '<=%s' % spec['max_height'], None if s.get('height') is None else s['height'] <= spec['max_height']))
                if spec['max_width'] is not None:
                    rows.append(_verdict('video_width_px', ref, s.get('width'), '<=%s' % spec['max_width'], None if s.get('width') is None else s['width'] <= spec['max_width']))
            else:
                codec = _canon_codec(s['codec']) if s.get('codec') else None
                if spec['audio_codecs'] is not None:
                    rows.append(_verdict('audio_codec', ref, codec, sorted(spec['audio_codecs']), None if codec is None else codec in spec['audio_codecs']))
                else:
                    out['not_stated'].append('audio_codec')
                if spec['audio_profiles'] is not None:
                    pr = s.get('profile')
                    rows.append(_verdict('audio_profile', ref, pr, sorted(spec['audio_profiles']), None if pr is None else str(pr).lower() in spec['audio_profiles']))
                if spec['max_channels'] is not None:
                    ch = s.get('channels')
                    rows.append(_verdict('audio_channels', ref, ch, '<=%s' % spec['max_channels'], None if ch is None else ch <= spec['max_channels']))
                if spec['layouts'] is not None:
                    lay = s.get('channel_layout')
                    rows.append(_verdict('audio_layout', ref, lay, sorted(spec['layouts']), None if lay is None else str(lay).lower() in spec['layouts']))
    for typ, (how, cands) in selection.items():
        if how == 'absent':
            rows.append(_verdict('%s_stream' % typ, 'file', None, 'present', None, 'the file lists no %s stream' % typ))
    counts = {v: sum(1 for r in rows if r['verdict'] == v) for v in ('supported', 'unsupported', UNKNOWN)}
    # `complete` is narrow: every stated field was compared with a known verdict, the selection is unambiguous, the container was compared, and no profile
    # statement went unread.  It is NOT a statement that the file plays on the client's device -- the counts are not a diagnosis.
    compared_container = any(r['field'] == 'container' and r['verdict'] != UNKNOWN for r in rows)
    out['summary'] = dict(counts, selection=sel_state if complete else 'ambiguous',
                          complete=bool(complete and rows and counts[UNKNOWN] == 0 and not spec['not_compared'] and compared_container),
                          note='complete means: every stated, readable field was compared with a known verdict; incompatibility is not damage; counts are not a diagnosis')
    out['not_stated'] = sorted(set(out['not_stated']))
    return out


# ------------------------------------------------------------------------------------------------------------------ guards (integrity state)
def integrity_findings(observations):
    """-> {'clean': [ids], 'damaged': [(id, finding)], 'unknown': [ids]} over INTEGRITY_TOOLS results, from what was SHOWN.  A known defect
    contradicts clean in the same item; unknown fields are neither."""
    clean, damaged, unknown = [], [], []
    dur = None
    for o in observations:
        if o['tool'] in ('ffprobe', 'audiobook_inspect') and o['status'] == 'ok':
            dd = derive(o)
            if dd.duration_s:
                dur = dd.duration_s
                break
    for o in observations:
        if o['tool'] not in INTEGRITY_TOOLS:
            continue
        dd = derive(o, dur)
        defects = [f for f in dd.findings if f['known_defect']] or ([dd.veto] if dd.veto else [])
        if defects:
            damaged.append((o['id'], defects[0]))
        elif dd.integrity == 'clean' and o['status'] == 'ok':
            clean.append(o['id'])
        else:
            unknown.append(o['id'])
    return {'clean': clean, 'damaged': damaged, 'unknown': unknown}


def full_decode_proof(observation, observations):
    """-> (met, detail) for the audit's full_decode_ok: observed completion to end of file, nothing unmet, a clean result.  Absent proof is not met."""
    if observation['status'] != 'ok':
        return False, 'the full decode did not return status ok'
    dur = None
    for o in observations:
        if o['tool'] in ('ffprobe', 'audiobook_inspect') and o['status'] == 'ok':
            dd = derive(o)
            if dd.duration_s:
                dur = dd.duration_s
                break
    d = derive(observation, dur)
    if d.completed_to_eof is not True:
        return False, 'completion to the end of the file was not observed (%s)' % ('window only' if d.completed_to_eof is False else 'not recorded')
    if d.integrity != 'clean':
        return False, 'the decode was not clean (%s)' % d.integrity
    if any(c['kind'] in ('request_not_honored', 'decoded_span_shorter_than_duration') for c in d.conflicts):
        return False, 'the request was not honored in full'
    streams = d.scope['completed'].get('streams')
    if not isinstance(streams, list) or not streams:
        return False, 'observed to the end of the file and clean, but which streams were decoded is not recorded, so the scope is not verified'
    return True, 'observed to the end of the file, clean, streams %s' % ', '.join(streams)


# ------------------------------------------------------------------------------------------------------------------ presentation
class PageBudgetError(ValueError):
    """The wire budget cannot be met: even the identity, alerts and execution header of a message (with the context around it) do not fit.  Raised, never papered over."""


class Limits:
    """Unit, chunk and string limits scaled to the page budget, so a unit always fits a page by itself (8192 bytes: units of 2400, chunks of 1800, strings of 400 chars)."""

    def __init__(self, budget=WIRE_BYTES):
        self.budget = budget
        self.unit = max(300, budget * 2400 // WIRE_BYTES)     # a unit larger than this (UTF-8 bytes) is split into smaller units
        self.chunk = self.unit * 3 // 4                       # the size of one chunk of a split string
        self.cap = max(40, min(400, self.unit // 5))          # a longer string is shown as its first `cap` characters plus a pointer; the whole string is a retrievable detail


STRING_CAP, UNIT_MAX, CHUNK_BYTES = 400, 2400, 1800     # the 8192-byte values (kept for readers of the contract)


def externalize(obj, prefix, details, lim=None):
    """Long strings keep their first `cap` characters inline plus `...[+N chars: detail <id>]`; the whole string is stored in `details[<id>]` (a retrievable unit of
    the pages), so nothing is clipped irreversibly."""
    cap = (lim or Limits()).cap
    if isinstance(obj, str):
        if len(obj) <= cap:
            return obj
        key = '%s.d%d' % (prefix, len(details) + 1)
        details[key] = obj
        return obj[:cap] + '...[+%d chars: detail %s]' % (len(obj) - cap, key)
    if isinstance(obj, list):
        return [externalize(x, prefix, details, lim) for x in obj]
    if isinstance(obj, dict):
        return {k: externalize(v, prefix, details, lim) for k, v in obj.items()}
    return obj


def _chunks(text, nbytes_max=CHUNK_BYTES):
    out, cur, size = [], [], 0
    for ch in text:
        b = len(ch.encode('utf-8'))
        if size + b > nbytes_max and cur:
            out.append(''.join(cur))
            cur, size = [], 0
        cur.append(ch)
        size += b
    if cur:
        out.append(''.join(cur))
    return out


def explode(path, value, mode='set', lim=None):
    """Units for `value` at `path`: one unit when it is small; otherwise a list is split per element, a dict per key and a string into chunks, recursively, so no
    unit exceeds the limit and nothing is dropped.  A list with an element too large to be one unit keeps every element's INDEX: its pieces travel under
    `(path, ('#', i), key)` and are put back into the element with `_i == i`, so two records are never merged into one."""
    lim = lim or Limits()
    if nbytes(value) <= lim.unit:
        return [(path, mode, value)]
    if isinstance(value, list):
        out = []
        if any(nbytes(e) > lim.unit for e in value):
            for i, e in enumerate(value):
                ip = path + (('#', i),)
                if nbytes(e) <= lim.unit:
                    out.append((ip, 'set', e if isinstance(e, dict) else {'value': e}))
                elif isinstance(e, dict):
                    for k, v in e.items():
                        out += explode(ip + (k,), v, 'set', lim)
                else:
                    out += explode(ip + ('value',), e, 'set', lim)
        else:
            for e in value:
                out.append((path, 'split', e))
        return out
    if isinstance(value, dict):
        out = []
        for k, v in value.items():
            out += explode(path + (k,), v, 'set', lim)
        return out
    if isinstance(value, str):
        return [(path, 'split', c) for c in _chunks(value, lim.chunk)]
    return [(path, mode, value)]


def item_core(d):
    """The typed object of one observation without its facts: id, tool, args, backend, then the four typed keys (execution, findings, scope, unresolved)."""
    ex = d.execution
    item = {'id': d.obs['id'], 'tool': d.obs['tool']}
    if d.obs['args']:
        item['args'] = d.obs['args']
    if d.obs.get('backend'):
        item['backend'] = d.obs['backend']
    item['execution'] = ex
    item['findings'] = d.findings
    scope = {k: v for k, v in d.scope.items() if v}
    if d.intervals:
        scope['intervals'] = [dict(iv) for iv in d.intervals]
    item['scope'] = scope
    item['unresolved'] = d.unresolved
    if d.conflicts:
        item['conflicts'] = d.conflicts
    return item


def item_facts(d):
    """Facts of an observation, with the audiobook parts' decode windows included (they are per part, not on one timeline)."""
    facts = dict(d.facts) if isinstance(d.facts, dict) else ({'value': d.facts} if d.facts is not None else {})
    if d.collector_coverage:
        facts['coverage'] = d.collector_coverage
    if d.diagnostics:
        facts['diagnostics'] = d.diagnostics
    if d.parts:
        facts['parts'] = [{k: v for k, v in dict(p, intervals=[{kk: vv for kk, vv in iv.items() if kk != 'streams'} for iv in p['intervals']]).items() if v not in (None, [])} for p in d.parts]
    return facts


def alerts_for(derived):
    """Conflicts, then known defects, then execution failures, each as one short entry that names the id of its detail.  Never dropped to fit a size."""
    out = []
    for d in derived:
        for c in d.conflicts:
            out.append({'type': 'conflict', 'id': c['id'], 'kind': c['kind'], 'src': d.obs['id']})
    for d in derived:
        for f in d.findings:
            if f['known_defect']:
                out.append({'type': 'defect', 'id': f['id'], 'kind': f['kind'], 'src': d.obs['id']})
        if d.veto:
            out.append({'type': 'collector_verdict', 'id': d.obs['id'] + '.veto', 'kind': d.veto['kind'], 'src': d.obs['id'], 'vetoes': 'healthy', 'known_defect': False})
    for d in derived:
        ex = d.execution
        if ex['state'] in ('failed', 'timed_out', 'unavailable'):
            a = {'type': 'execution', 'id': d.obs['id'], 'state': ex['state']}
            if ex.get('cause'):
                a['cause'] = ex['cause']
            out.append(a)
        elif ex['state'] == 'ran' and ex['status'] == 'partial':
            out.append({'type': 'execution', 'id': d.obs['id'], 'state': 'partial'})
    return out


def cursor_for(alias, source, page, digest):
    """Opaque, stable cursor: same inputs and page give the same text; it embeds the case alias, so one case's cursor never resolves in another."""
    return 'c' + hashlib.sha256(('%s|%s|%s|%d|%s' % (PAGE_CONTRACT, alias, source, page, digest)).encode()).hexdigest()[:15]


CURSOR_RX = re.compile(r'^c[0-9a-f]{15}$')


def _pname(path):
    return '.'.join(('[%d]' % p[1]) if isinstance(p, tuple) else str(p) for p in path)


def _sname(path):
    """A short, bounded name for a path in the page object's `elsewhere` (its first two keys; list indices left out), so the object stays small however many units there are."""
    return '.'.join([str(p) for p in path if not isinstance(p, tuple)][:2])


def _descend(body, path):
    """The container that `path` (without its last component) leads to: dicts by key, list elements by their `_i` index (created when absent)."""
    cur = body
    for idx, p in enumerate(path[:-1]):
        nxt = path[idx + 1]
        if isinstance(p, tuple):
            el = next((e for e in cur if e.get('_i') == p[1]), None)
            if el is None:
                el = {'_i': p[1]}
                cur.append(el)
            cur = el
        else:
            cur = cur.setdefault(p, [] if isinstance(nxt, tuple) else {})
    return cur


def _put(body, path, mode, value):
    cur = _descend(body, path)
    last = path[-1]
    if isinstance(last, tuple):                      # a whole (small) element, or the remaining pieces of one, goes into the list element with that index
        el = next((e for e in cur if e.get('_i') == last[1]), None)
        if el is None:
            el = {'_i': last[1]}
            cur.append(el)
        el.update(value)
    elif mode in ('append', 'split'):
        cur.setdefault(last, []).append(value)
    else:
        cur[last] = value


def facts_units(path, facts, details=None, prefix='x', lim=None):
    """Units for a facts value (long strings externalised into `details`, large structures exploded)."""
    details = {} if details is None else details
    facts = externalize(facts, prefix, details, lim)
    units = []
    if isinstance(facts, dict):
        for k, v in facts.items():
            units += explode(path + (k,), v, 'set', lim)
    elif facts is not None:
        units += explode(path, facts, 'set', lim)
    return units


def detail_units(details, lim=None):
    lim = lim or Limits()
    out = []
    for key, text in details.items():
        out += [(('details', key), 'split', c) for c in _chunks(text, lim.chunk)] if nbytes(text) > lim.unit else [(('details', key), 'set', text)]
    return out


def assemble(header, units):
    body = {k: (dict(v) if isinstance(v, dict) else (list(v) if isinstance(v, list) else v)) for k, v in header.items()}
    placed = {}
    for path, mode, value in units:
        _put(body, path, mode, value)
        if mode == 'split':
            placed[path] = placed.get(path, 0) + 1
    return body, placed


def _totals(units):
    tot = {}
    for path, mode, _ in units:
        key = (path, 'split' if mode == 'split' else 'plain')
        tot[key] = tot.get(key, 0) + 1
    return tot


def _finish_page(header, units, all_units, page_obj, totals):
    body, placed = assemble(header, units)
    for path, n in placed.items():
        if n >= totals[(path, 'split')]:
            continue   # the whole list is on this page: nothing to mark
        if isinstance(path[-1], tuple):
            continue
        _descend(body, path)[path[-1] + '_shown'] = '%d of %d' % (n, totals[(path, 'split')])
    if page_obj is not None:
        body['page'] = page_obj
    else:
        body.pop('page', None)
    return body


def paginate(header, units, env_first, env_rest, alias, source, budget=WIRE_BYTES):
    """Split `units` into pages whose full wire text stays within `budget` UTF-8 bytes: the first page against `env_first(body)`, every later page against
    `env_rest(body)` -- the WORST-CASE envelope a fetch can add (longest offered tool name, the sixth call's id, the budget notice).

    Contract (pages-v1): a page is `header` (identity, alerts, execution: always repeated) plus whole units in priority order, never a structure cut in the
    middle.  Nothing is dropped: a long string is stored whole as a `details` unit (its inline prefix names it), a large structure is split into smaller units,
    and a split list says `<field>_shown: "n of N"`.  Every page carries `page{contract,source,n,of,next,next_costs_tool_call,elsewhere,alerts_total,conflicts_total}`:
    `elsewhere` counts what is on other pages; the alerts (conflicts first, with the ids of their details) are repeated on every page.  `next` is an opaque stable
    cursor; fetching it is one tool call.  A single page carries no `page` object.  A unit (or the header with the context around it) that cannot fit raises
    PageBudgetError: the message is refused, never sent over the limit.
    -> list of (body dict, cursor of this page or None)."""
    totals = _totals(units)
    if nbytes(env_first(_finish_page(header, [], units, None, totals))) > budget and header.get('alerts'):
        header = dict(header, alerts=['%s:%s:%s' % (a.get('type'), a.get('id'), a.get('kind') or a.get('state')) for a in header['alerts']])   # shortest form; none is dropped
    worst = {}
    for (p, k), n in totals.items():
        worst[_sname(p)] = worst.get(_sname(p), 0) + n
    probe = {'contract': PAGE_CONTRACT, 'source': source, 'n': 99, 'of': 99, 'next': 'c' + '0' * 15, 'next_costs_tool_call': True,
             'elsewhere': worst, 'alerts_total': 99, 'conflicts_total': 99}

    def fits(us, first):
        body = _finish_page(header, us, units, probe, totals)
        return nbytes((env_first if first else env_rest)(body)) <= budget

    if not fits([], True):
        raise PageBudgetError('the message cannot be made to fit %d bytes: its header (identity, alerts, execution) and the context around it are already too large' % budget)
    groups, cur = [], []
    for u in units:
        first = not groups
        if fits(cur + [u], first):
            cur = cur + [u]
            continue
        if cur:
            groups.append(cur)
            cur = [u]
            if not fits(cur, False):
                raise PageBudgetError('a unit of %s (%d bytes) does not fit a %d byte page by itself' % (_pname(u[0]), nbytes(u[2]), budget))
        else:
            raise PageBudgetError('a unit of %s (%d bytes) does not fit the first %d byte page by itself' % (_pname(u[0]), nbytes(u[2]), budget))
    if cur or not groups:
        groups.append(cur)
    of = len(groups)
    if of == 1:
        return [(_finish_page(header, groups[0], units, None, totals), None)]
    alerts_total = len(header.get('alerts') or [])
    conflicts_total = sum(1 for a in (header.get('alerts') or []) if (a.get('type') == 'conflict' if isinstance(a, dict) else str(a).startswith('conflict:')))
    pages = []
    next_cursor = None
    for i in range(of - 1, -1, -1):
        us = groups[i]
        placed_here = _totals(us)
        elsewhere = {}
        for (p, k), n in totals.items():
            rest = n - placed_here.get((p, k), 0)
            if rest:
                elsewhere[_sname(p)] = elsewhere.get(_sname(p), 0) + rest
        pobj = {'contract': PAGE_CONTRACT, 'source': source, 'n': i + 1, 'of': of}
        if next_cursor:
            pobj['next'] = next_cursor
            pobj['next_costs_tool_call'] = True
        if elsewhere:
            pobj['elsewhere'] = elsewhere
        pobj['alerts_total'] = alerts_total
        pobj['conflicts_total'] = conflicts_total
        body = _finish_page(header, us, units, pobj, totals)
        cur_cursor = cursor_for(alias, source, i + 1, hashlib.sha256(canon(body).encode()).hexdigest()[:16]) if i > 0 else None
        pages.append((body, cur_cursor))
        next_cursor = cur_cursor
    pages.reverse()
    return pages


def tool_envelope(call_id, tool, status, truncated, body, remaining, suffix=''):
    return json.dumps({'type': 'tool_result', 'id': call_id, 'tool': tool, 'status': status, 'truncated': bool(truncated), 'output': body,
                       'tool_calls_remaining': remaining}, ensure_ascii=False, separators=(',', ':')) + suffix


class Session:
    """Per-case presentation state: the observations actually SHOWN so far, the pages not yet fetched, and what the summaries last showed.
    Summaries (coverage, client comparison) are recomputed from shown observations only, so nothing from an uncalled operation can appear."""

    def __init__(self, alias, context, media_type, tools_offered, budget=WIRE_BYTES):
        self.alias, self.context, self.media_type, self.tools = alias, context, media_type, list(tools_offered or [])
        self.shown = []
        self.pages = {}            # cursor -> (page body, tool name for the echo)
        self.last_cov = None
        self.last_client = None
        self.log = []              # auditable: [{'id', 'kind', 'pages', 'bytes'}]
        self.budget = budget
        self.lim = Limits(budget)

    def finding_index(self):
        """{finding / conflict id: observation id} for everything actually emitted so far (the only ids a decision may cite besides observation ids)."""
        return emitted_ids(self.analysis())

    def analysis(self):
        return analyze(self.shown, self.context, self.media_type)

    def _worst_fetch_envelope(self):
        """The largest envelope a stored page can be fetched in: the longest offered tool name, the sixth call's id, nothing left of the budget (so the notice is appended)."""
        tool = max(self.tools or ['x'], key=len)
        return lambda body: tool_envelope('t6', tool, 'ok', False, body, 0, '\n' + P.BUDGET_MESSAGE)

    def _summary_units(self, an, force):
        units = []
        cov_text = canon(an['coverage'])
        if force or cov_text != self.last_cov:
            for k, v in an['coverage'].items():
                units += explode(('coverage', k), v, 'set', self.lim)
            self.last_cov = cov_text
        cl = an['client']
        if cl is not None:
            cl_text = canon(cl)
            if force or cl_text != self.last_client:
                for k, v in cl.items():
                    units += explode(('client_comparison', k), v, 'set', self.lim)
                self.last_client = cl_text
        return units

    def initial(self, evidence_obs, frame=None):
        """-> (evidence block dict for the first user message, number of pages).  `frame` is the rest of the first message (context, tools, capabilities...): the
        first message as a whole -- frame plus this block -- is within the 8192-byte envelope, not just the block."""
        self.shown = list(evidence_obs)
        an = self.analysis()
        derived = [an['items'][i] for i in an['order']]
        header = {'alerts': alerts_for(derived), 'page': None}
        units, details = [], {}
        for d in derived:
            core = item_core(d)
            if nbytes(core) > self.lim.unit:   # a large item travels as its identity and execution plus retrievable sections
                small = {k: core[k] for k in ('id', 'tool', 'args', 'backend', 'execution') if k in core}
                small['sections'] = 'findings, scope, unresolved and conflicts are in item_sections.' + d.obs['id']
                units.append((('items',), 'append', small))
                for sec in ('findings', 'scope', 'unresolved', 'conflicts'):
                    if core.get(sec):
                        units += explode(('item_sections', d.obs['id'], sec), core[sec], 'set', self.lim)
            else:
                units.append((('items',), 'append', core))
        for d in derived:
            f = item_facts(d)
            if f:
                units += facts_units(('facts', d.obs['id']), f, details, d.obs['id'], self.lim)
        units += self._summary_units(an, True)
        units += detail_units(details, self.lim)
        frame = frame or {}
        pages = paginate(header, units, lambda b: canon(dict(frame, evidence=b)), self._worst_fetch_envelope(), self.alias, 'evidence', self.budget)
        first = pages[0][0]
        if not self.tools and len(pages) > 1:
            # nothing can be fetched when no tool is offered: say so instead of promising a page, keep the aggregate counts and the alerts
            first['page'].pop('next', None)
            first['page'].pop('next_costs_tool_call', None)
            first['page']['retrieval'] = 'unavailable: no tool is offered, so the other pages cannot be fetched'
            pages = pages[:1]
        for body, cur in pages[1:]:
            self.pages[cur] = (body, 'evidence')
        self.log.append({'id': 'evidence', 'kind': 'initial', 'pages': len(pages), 'bytes': [nbytes(dict(frame, evidence=b)) for b, _ in pages[:1]] + [nbytes(self._worst_fetch_envelope()(b)) for b, _ in pages[1:]]})
        return first, len(pages)

    def result(self, obs, call_id, remaining, suffix=''):
        """-> (wire text of the first page, number of pages)."""
        self.shown.append(obs)
        an = self.analysis()
        d = an['items'][obs['id']]
        item = item_core(d)
        header = {'id': obs['id'], 'tool': obs['tool']}
        if item.get('args'):
            header['args'] = item['args']
        if item.get('backend'):
            header['backend'] = item['backend']
        header['alerts'] = alerts_for([d])
        header['page'] = None
        header['execution'] = d.execution
        units, details = [], {}
        for sec in ('conflicts', 'findings', 'unresolved'):
            for v in item.get(sec) or []:
                units += explode((sec,), v, 'append', self.lim)
        for k, v in (item.get('scope') or {}).items():
            units += explode(('scope', k), v, 'set', self.lim)
        f = item_facts(d)
        if f:
            units += facts_units(('facts',), f, details, obs['id'], self.lim)
        units += self._summary_units(an, False)
        units += detail_units(details, self.lim)
        truncated = d.execution['output_truncated']
        status = obs['status']

        def env(body):
            return tool_envelope(call_id, obs['tool'], status, truncated, body, remaining, suffix)
        pages = paginate(header, units, env, self._worst_fetch_envelope(), self.alias, call_id, self.budget)
        for body, cur in pages[1:]:
            self.pages[cur] = (body, obs['tool'])
        self.log.append({'id': call_id, 'kind': 'result', 'pages': len(pages), 'bytes': [nbytes(env(pages[0][0]))] + [nbytes(self._worst_fetch_envelope()(b)) for b, _ in pages[1:]]})
        return env(pages[0][0]), len(pages)

    def fetch(self, cursor, call_id, tool, remaining, suffix=''):
        """-> (status, wire text).  An unknown cursor (other case, other run, mangled) is an error that names no page content."""
        hit = self.pages.get(cursor) if isinstance(cursor, str) and CURSOR_RX.match(cursor) else None
        if hit is None:
            body = {'execution': {'state': 'failed', 'status': 'error', 'cause': 'tool', 'completion': 'none', 'output_truncated': False,
                                  'reason': 'unknown or expired cursor; a cursor is valid only for this case and only as shown'}}
            return 'error', tool_envelope(call_id, tool, 'error', False, body, remaining, suffix)
        body = hit[0]

        def env(b):
            return tool_envelope(call_id, tool, 'ok', False, b, remaining, suffix)
        self.log.append({'id': call_id, 'kind': 'page', 'cursor': cursor, 'bytes': nbytes(env(body))})
        return 'ok', env(body)
