"""Tools behaviour `v3-remote-1` (#161, pilot plan v3.2 section 3): remote content evidence with fail-closed receipts and expected-identity binding.

Opt-in only (`--tools-behavior v3-remote-1`, valid with `--evidence-format v3.1-format`).  It is tools behaviour v3 (every v3 rule unchanged) plus:

1. `subtitle_sample {"at": s}`: one bounded window of the FIRST text subtitle stream (subrip, ass, ssa or mov_text) that the case's existing probe result
   lists.  No sampler call chooses the stream; the model chooses only the offset.  Each cue is a content observation (provenance observed) with its stream,
   window and a citable id (the cue is a finding `tN.fK` of kind `subtitle_cue`).  No stream, an empty window, malformed SRT or a failed run gives
   `unavailable` or an execution failure, never content.  Cue text is media text: it is never rewritten by redaction, and the leak guard checks it
   (leakguard-media-2, through the same sources and shadow as EPUB text).
2. Every remote operation goes through the sampler `mrh-sampler-2` (remote_sampler_v2.py) and its terminal receipt is validated and recorded with the pod
   hostname.  Each operation carries the expected identity (size and mtime_ns) and the sampler checks it at the start and the end.  A missing or malformed
   receipt, an identity mismatch, `source_unchanged: false`, a changed hostname, an outer timeout or a failed exec is FATAL: the result is an execution
   failure (cause tool), the output of that operation is never used, and the binding refuses every later operation without invoking anything.  With the
   runner's `--stop-on-receipt-failure` the run stops at once (the case is kept as started_aborted with every receipt; later cases never start).
   Not fatal: `quota_exhausted`, or a sampler-internal timeout that ends with a valid terminal receipt; they limit that operation's completed scope.
3. Deadlines: 25 s inside the sampler, 60 s outer per operation (it covers `kubectl exec` itself), 600 s harness wall per target and 2 h for Stage R (driver),
   $10 in total (driver).  The exec target is configurable (`exec_target` in the case fixture or the driver registration; default `deploy/<deployment>`).

Nothing here reads a label, a truth field or a suite name; every value comes from the case fixture, the case evidence or the receipt.
"""
import hashlib
import json
import re
import subprocess
from pathlib import Path

VERSION = 'v3-remote-1'
BASE_TOOLS_BEHAVIOR = 'v3'
HERE = Path(__file__).resolve().parent
SAMPLER = HERE / 'remote_sampler_v2.py'
RECEIPT = 'mrh-sampler-2'
SAMPLER_TIMEOUT_S = 25
OUTER_DEADLINE_S = 60
TARGET_WALL_S = 600
STAGE_WALL_S = 7200
TOTAL_COST_USD = 10.0
LIST_CAP = 500
SUBTITLE_WINDOW_S = 8
TEXT_SUBTITLE_CODECS = ('subrip', 'ass', 'ssa', 'mov_text')
MAX_CUES = 40
CUE_TEXT_MAX = 300
CUE_RULE = 'srt-cues-1'
EXTRA_TOOLS = ('subtitle_sample',)
FILE_MODES = ('stat', 'probe', 'chapters', 'decode', 'frame', 'audio', 'subtitle')
FATAL_KINDS = ('missing_receipt', 'malformed_receipt', 'identity_mismatch', 'source_changed', 'hostname_changed', 'outer_timeout', 'exec_failed',
               'no_expected_identity', 'operation_cap', 'stopped')


def sampler_sha256():
    return hashlib.sha256(SAMPLER.read_bytes()).hexdigest()


def config():
    """What a run with this tools behaviour records in its config (and so in its config hash)."""
    return {'version': VERSION, 'base_tools_behavior': BASE_TOOLS_BEHAVIOR, 'sampler': RECEIPT, 'sampler_sha256': sampler_sha256(),
            'sampler_timeout_s': SAMPLER_TIMEOUT_S, 'outer_deadline_s': OUTER_DEADLINE_S, 'list_cap': LIST_CAP, 'subtitle_window_s': SUBTITLE_WINDOW_S,
            'text_subtitle_codecs': list(TEXT_SUBTITLE_CODECS), 'max_cues': MAX_CUES, 'cue_text_max': CUE_TEXT_MAX, 'cue_rule': CUE_RULE,
            'extra_tools': list(EXTRA_TOOLS)}


class FatalOperation(Exception):
    """A remote operation that failed closed.  Its output is never used; the binding refuses every later operation."""

    def __init__(self, kind, detail, receipt=None, argv=None):
        assert kind in FATAL_KINDS, kind
        super().__init__('%s: %s' % (kind, detail))
        self.kind, self.detail, self.receipt, self.argv = kind, detail, receipt, argv

    def as_record(self):
        return {'kind': self.kind, 'detail': self.detail, 'cause': 'tool'}


class HostState:
    """The pod hostname every operation of a run (or of a Stage R driver run) must report: given (`expected`), or bound by the first valid receipt."""

    def __init__(self, hostname=None):
        self.hostname = hostname
        self.source = 'expected' if hostname else None

    def check(self, reported):
        if self.hostname is None:
            self.hostname, self.source = reported, 'first_receipt'
            return True
        return reported == self.hostname


class Binding:
    """One file's operations: the expected identity (size, mtime_ns; head and tail hashes when known), the host, an operation cap, every receipt, and the
    fatal state.  Once fatal, every later operation is refused WITHOUT invoking anything."""

    def __init__(self, identity=None, host=None, max_operations=None):
        self.identity = dict(identity) if identity else None
        self.host = host or HostState()
        self.max_operations = max_operations
        self.operations = 0
        self.receipts = []       # one entry per operation: {n, mode, argv, receipt, outcome, fatal?}
        self.fatal = None

    def expected(self):
        return None if self.identity is None else {'size': self.identity['size'], 'mtime_ns': self.identity['mtime_ns']}

    def record(self):
        return {'tools_behavior': VERSION, 'sampler': RECEIPT, 'expected_identity': self.identity, 'hostname': self.host.hostname,
                'hostname_source': self.host.source, 'operations': self.operations, 'max_operations': self.max_operations,
                'receipts': list(self.receipts), 'fatal': self.fatal}


def binding_for_case(case, host, max_operations=None):
    """The binding of a case whose fixture is remote: `fixture.expected_identity` (from the G1 fingerprint), `fixture.expected_hostname` (bound into the run's
    host state, or checked against it), `fixture.max_operations`.  A remote fixture without an expected identity gets a binding that refuses every operation."""
    fx = case.get('fixture') or {}
    ident = fx.get('expected_identity')
    want_host = fx.get('expected_hostname')
    b = Binding(ident if isinstance(ident, dict) and _identity_ok(ident) else None, host, fx.get('max_operations', max_operations))
    if want_host and host.hostname is None:
        host.hostname, host.source = want_host, 'expected'
    elif want_host and host.hostname != want_host:
        b.fatal = {'kind': 'hostname_changed', 'detail': 'the case expects host %r; this run is bound to %r' % (want_host, host.hostname), 'cause': 'tool'}
    return b


def _identity_ok(ident):
    return all(isinstance(ident.get(k), int) and not isinstance(ident.get(k), bool) for k in ('size', 'mtime_ns'))


def exec_argv(namespace, target, container, mode, path, opts=()):
    """`kubectl -n <ns> exec -i <target> -c <container> -- python3 - <mode> <path> [opts]` (target like deploy/bazarr or pod/<name>)."""
    return ['kubectl', '-n', namespace, 'exec', '-i', target, '-c', container, '--', 'python3', '-', mode, path] + [str(x) for x in opts]


# ------------------------------------------------------------------------------------------------------------------ receipts
def parse_receipt(stderr_bytes):
    """-> (receipt dict or None, problem or None).  The receipt is the last non-empty stderr line."""
    lines = [ln for ln in stderr_bytes.decode('utf-8', errors='replace').splitlines() if ln.strip()]
    if not lines:
        return None, 'no stderr: no terminal receipt'
    try:
        r = json.loads(lines[-1])
    except ValueError:
        return None, 'the last stderr line is not a JSON receipt'
    if not isinstance(r, dict) or r.get('receipt') != RECEIPT:
        return None, 'the last stderr line is not an %s receipt' % RECEIPT
    return r, None


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def receipt_errors(r, mode, stdout_len):
    """Every way a receipt can be malformed (empty when it is well formed).  It checks shape and internal consistency, not the verdicts."""
    errs = []
    if r.get('mode') != mode:
        errs.append('mode %r, expected %r' % (r.get('mode'), mode))
    if not (isinstance(r.get('hostname'), str) and r['hostname'].strip()):
        errs.append('hostname missing')
    ec = r.get('exit_code')
    if not (_int(ec) or ec in ('timeout', 'error')):
        errs.append('exit_code malformed')
    if not _int(r.get('stdout_bytes')) or r.get('stdout_bytes') != stdout_len:
        errs.append('stdout_bytes %r does not match the %d bytes received' % (r.get('stdout_bytes'), stdout_len))
    if not _int(r.get('bytes_read')) or r['bytes_read'] < 0:
        errs.append('bytes_read malformed')
    for k in ('quota_exhausted', 'timed_out'):
        if not isinstance(r.get(k), bool):
            errs.append('%s malformed' % k)
    if not _num(r.get('wall_seconds')) or r['wall_seconds'] < 0:
        errs.append('wall_seconds malformed')
    if not isinstance(r.get('stderr', ''), str):
        errs.append('stderr malformed')
    ident = r.get('identity')
    if mode in FILE_MODES:
        if not isinstance(ident, dict) or not {'expected', 'start', 'end', 'start_ok', 'end_ok'} <= set(ident):
            errs.append('identity block missing')
        if r.get('source_unchanged') not in (True, False, None):
            errs.append('source_unchanged malformed')
        if ec == 0 and r.get('source_unchanged') is None:
            errs.append('a completed operation must report source_unchanged')
    if mode == 'list':
        lst = r.get('listing')
        if not isinstance(lst, dict) or not isinstance(lst.get('complete'), bool) or not _int(lst.get('matching')) or not _int(lst.get('scanned')):
            errs.append('listing block missing')
    if ec == 'timeout' and r.get('timed_out') is not True:
        errs.append('exit_code timeout without timed_out')
    return errs


def run_operation(runner, namespace, target, container, mode, path, binding, opts=(), bind_identity=True):
    """One remote sampler operation under `binding`.  -> (receipt, stdout bytes).  Raises FatalOperation on every fatal path; never invokes anything once the
    binding is fatal.  `bind_identity=False` only for an operation that SETS the identity (the driver's G1 stat) or reads a directory (`list`)."""
    if binding.fatal:
        raise FatalOperation('stopped', 'an earlier operation failed closed (%s); no further operation is started' % binding.fatal.get('kind'))
    if binding.max_operations is not None and binding.operations >= binding.max_operations:
        return _fail(binding, FatalOperation('operation_cap', 'the cap of %d sampler operations for this file is reached' % binding.max_operations), mode, None)
    want = binding.expected() if bind_identity else None
    if bind_identity and want is None:
        return _fail(binding, FatalOperation('no_expected_identity', 'the operation has no expected identity to bind; nothing was invoked'), mode, None)
    extra = list(opts)
    if want is not None:
        extra += ['--expect-size', want['size'], '--expect-mtime-ns', want['mtime_ns']]
    argv = exec_argv(namespace, target, container, mode, path, extra)
    binding.operations += 1
    try:
        r = runner(argv, input=SAMPLER.read_bytes(), capture_output=True, timeout=OUTER_DEADLINE_S)
    except subprocess.TimeoutExpired:
        return _fail(binding, FatalOperation('outer_timeout', 'the %d s outer deadline of the operation expired (no receipt)' % OUTER_DEADLINE_S, argv=argv), mode, argv)
    except Exception as e:  # noqa: BLE001 - an exec that did not complete (OSError or anything else) has no receipt: fatal
        return _fail(binding, FatalOperation('exec_failed', '%s: %s' % (type(e).__name__, str(e)[:200]), argv=argv), mode, argv)
    stdout = r.stdout or b''
    receipt, problem = parse_receipt(r.stderr or b'')
    if receipt is None:
        return _fail(binding, FatalOperation('missing_receipt', problem, argv=argv), mode, argv)
    errs = receipt_errors(receipt, mode, len(stdout))
    if errs:
        return _fail(binding, FatalOperation('malformed_receipt', '; '.join(errs)[:400], receipt, argv), mode, argv)
    if not binding.host.check(receipt['hostname']):
        return _fail(binding, FatalOperation('hostname_changed', 'the receipt names host %r; the run is bound to %r' % (receipt['hostname'], binding.host.hostname),
                                             receipt, argv), mode, argv)
    if mode in FILE_MODES:
        ident = receipt['identity']
        if want is not None:
            # both ends must be checked and equal: an end the sampler could not read (its own stat timed out) is not verified, so it fails closed too
            ok = (ident.get('expected') == want and ident.get('start_ok') is True and ident.get('start') == want
                  and ident.get('end_ok') is True and ident.get('end') == want)
            if not ok:
                return _fail(binding, FatalOperation('identity_mismatch', 'expected %s; start %s, end %s' % (want, ident.get('start'), ident.get('end')), receipt, argv),
                             mode, argv)
        if receipt.get('source_unchanged') is False:
            return _fail(binding, FatalOperation('source_changed', 'the sampler reports source_unchanged: false', receipt, argv), mode, argv)
    binding.receipts.append({'n': binding.operations, 'mode': mode, 'argv': argv, 'receipt': receipt, 'outcome': 'ok'})
    return receipt, stdout


def _fail(binding, exc, mode, argv):
    binding.fatal = exc.as_record()
    binding.receipts.append({'n': binding.operations, 'mode': mode, 'argv': argv, 'receipt': exc.receipt, 'outcome': 'fatal', 'fatal': exc.as_record()})
    raise exc


def fatal_text(tool):
    """The model-visible text of a fatal operation: an execution failure, cause tool (the typed layer reads `<tool> failed: could not run` as one)."""
    return '%s failed: could not run; the read could not be verified, so no output of it is used' % tool


# ------------------------------------------------------------------------------------------------------------------ the subtitle stream
def select_subtitle_stream(evidence):
    """The first text subtitle stream (TEXT_SUBTITLE_CODECS) listed by the FIRST ok ffprobe result in the case evidence -> {index, codec, language, source}
    or None.  Nothing is invoked."""
    for e in evidence or []:
        if e.get('tool') != 'ffprobe' or e.get('status') != 'ok':
            continue
        data = e.get('output')
        try:
            data = json.loads(data) if isinstance(data, str) else data
        except ValueError:
            return None
        if isinstance(data, dict) and isinstance(data.get('observation'), dict) and 'recorded_as' in data:
            data = data['observation']
        streams = data.get('streams') if isinstance(data, dict) else None
        if not isinstance(streams, list):
            return None
        for s in streams:
            if not isinstance(s, dict) or s.get('codec_type') != 'subtitle' or s.get('codec_name') not in TEXT_SUBTITLE_CODECS:
                continue
            idx = s.get('index')
            if not _int(idx) or not 0 <= idx < 128:
                continue
            lang = (s.get('tags') or {}).get('language') if isinstance(s.get('tags'), dict) else s.get('language')
            return {'index': idx, 'codec': s['codec_name'], 'language': lang, 'source': e.get('id')}
        return None
    return None


# ------------------------------------------------------------------------------------------------------------------ SRT
_TIME = r'(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})'
_TIMING_RX = re.compile(r'^\s*' + _TIME + r'\s*-->\s*' + _TIME + r'(?:\s.*)?$')
_TAG_RX = re.compile(r'<[^<>]{1,80}>|\{\\[^{}]{0,200}\}')


def _secs(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, '0')) / 1000.0


def parse_srt(data, cut=False):
    """SRT bytes -> (cues, problem).  A cue is {start, end, text} with times in seconds inside the window.  Rule srt-cues-1: blocks separated by blank lines,
    an index line, a timing line, then the text lines; formatting tags (`<i>`, `{\\an8}` ...) are removed, lines joined by one space, whitespace collapsed;
    a cue whose text is then empty is dropped.  Anything else is malformed (problem set), except, when the run was cut (quota or internal timeout), a broken
    LAST block, which is the cut.  Undecodable UTF-8 is malformed."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return [], 'the subtitle output is not valid UTF-8'
    text = text.lstrip('﻿').replace('\r\n', '\n').replace('\r', '\n')
    blocks = [b for b in re.split(r'\n\s*\n', text.strip('\n')) if b.strip()]
    cues = []
    for i, b in enumerate(blocks):
        lines = b.split('\n')
        ok = len(lines) >= 2 and lines[0].strip().isdigit() and _TIMING_RX.match(lines[1])
        if not ok:
            if cut and i == len(blocks) - 1:
                break
            return [], 'block %d is not an SRT cue (index line, timing line, text)' % (i + 1)
        m = _TIMING_RX.match(lines[1])
        start, end = _secs(*m.groups()[:4]), _secs(*m.groups()[4:])
        body = ' '.join(' '.join(_TAG_RX.sub('', ln).split()) for ln in lines[2:])
        body = ' '.join(body.split())
        if body:
            cues.append({'start': start, 'end': end, 'text': body})
    return cues, None


def cue_output(stream, at, window, cues, scope=None):
    shown = cues[:MAX_CUES]
    out = {'stream': {'index': stream['index'], 'codec': stream['codec'], 'language': stream.get('language')},
           'window': {'at_s': at, 'window_s': window, 'end_s': round(at + window, 3)},
           'cue_count': len(cues),
           'cues': [dict({'cue': i + 1, 'start_s': round(at + c['start'], 3), 'end_s': round(at + c['end'], 3), 'text': c['text'][:CUE_TEXT_MAX]},
                         **({'text_cut': True} if len(c['text']) > CUE_TEXT_MAX else {})) for i, c in enumerate(shown)],
           'note': 'subtitle text as read from the file in this window; a cue time is the window start plus its time inside the window'}
    if len(cues) > MAX_CUES:
        out['cues_omitted'] = len(cues) - MAX_CUES
    if scope:
        out['scope_limit'] = scope
    return out


def tool_subtitle_sample(args, ctx):
    """`subtitle_sample {"at": s}` (tools behaviour v3-remote-1).  The stream comes from the case's probe result; nothing else is a model argument."""
    from . import tools as T
    extra = sorted(set(args or {}) - {'at', 'ss', 't'})
    if extra:
        raise ValueError('subtitle_sample takes {"at": seconds} only; the stream comes from the probe result (unexpected %s)' % extra)
    at = T._at(args or {})
    stream = getattr(ctx, 'subtitle_stream', None)
    if stream is None:
        return T.ToolResult('unavailable', 'no text subtitle stream (%s) is listed in the probe result of this case; nothing was run and no subtitle text was observed'
                            % ', '.join(TEXT_SUBTITLE_CODECS))
    bad = T._need_media(ctx)
    if bad:
        return bad
    window = SUBTITLE_WINDOW_S
    if ctx.fixture.kind == 'remote':
        receipt, data = run_for_ctx(ctx, 'subtitle', ['--at', at, '--stream', stream['index'], '--window', window])
        mode, ec, timed_out = 'remote', receipt['exit_code'], receipt['timed_out']
        quota, stderr = receipt['quota_exhausted'], receipt.get('stderr') or ''
        error = receipt.get('error')
    elif ctx.fixture.kind == 'local' and ctx.which('ffmpeg'):
        info, data = T._run_local(ctx, [ctx.which('ffmpeg'), '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(at), '-i', ctx.fixture.path,
                                        '-t', '%g' % window, '-map', '0:%d' % stream['index'], '-vn', '-an', '-f', 'srt', 'pipe:1'])
        mode, ec, timed_out, quota, stderr, error = 'local', info['exit_code'], info['exit_code'] == 'timeout', False, info.get('stderr') or '', None
    else:
        return T.ToolResult('unavailable', 'no subtitle sampler is available for this item (no remote sampler and no local ffmpeg); nothing was run')
    if error or (ec not in (0, 'timeout')):
        return T.ToolResult('error', {'exit_code': ec, 'stderr': (stderr or error or '')[:1500], 'note': 'the subtitle extraction failed; no cue was delivered'}, mode=mode)
    cut = timed_out or quota
    cues, problem = parse_srt(data or b'', cut=cut)
    if problem:
        return T.ToolResult('error', 'subtitle_sample failed: could not run (the subtitle output could not be read as SRT: %s); no cue was delivered' % problem, mode=mode)
    scope = None
    if timed_out:
        scope = 'the sampler stopped at its %d s limit: only the cues before that point were read' % SAMPLER_TIMEOUT_S
    elif quota:
        scope = 'the sampler reached its 8 MiB input quota: only the cues before that point were read'
    if not cues:
        what = 'the sampled window %g-%g s of stream %d (%s) held no subtitle cue' % (at, at + window, stream['index'], stream['codec'])
        if timed_out:
            return T.ToolResult('timeout', '%s before the sampler stopped at its %d s limit; no subtitle text was observed' % (what, SAMPLER_TIMEOUT_S), mode=mode)
        return T.ToolResult('unavailable', '%s%s; no subtitle text was observed' % (what, ' before the 8 MiB input quota was reached' if quota else ''), mode=mode,
                            ran=True)
    status = 'timeout' if timed_out else ('partial' if quota or len(cues) > MAX_CUES else 'ok')
    return T.ToolResult(status, cue_output(stream, at, window, cues, scope), mode=mode)


def run_for_ctx(ctx, mode, opts):
    fx = ctx.fixture
    target = getattr(fx, 'exec_target', None) or 'deploy/' + fx.deploy
    return run_operation(ctx.runner, fx.namespace, target, fx.container, mode, fx.path, ctx.remote_binding, opts)


def run_remote(ctx, mode, at=0.0, stream=0):
    """tools._run_remote for tools behaviour v3-remote-1 -> (info, stdout, err) in the shape the existing tools read.  The info is the receipt.  A
    sampler-internal timeout is err 'timeout' (a scope limit: the tools report status timeout); every fatal path raises FatalOperation."""
    receipt, out = run_for_ctx(ctx, mode, ['--at', at, '--stream', int(stream)])
    if receipt['exit_code'] == 'timeout':
        return receipt, out, 'timeout'
    if receipt['exit_code'] == 'error':
        return receipt, out, 'error: %s' % (receipt.get('error') or 'the sampler could not run the operation')
    return receipt, out, None


# ------------------------------------------------------------------------------------------------------------------ media text (leakguard-media-2)
def _parsed(output):
    if isinstance(output, dict):
        return output
    try:
        d = json.loads(output) if isinstance(output, str) else None
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def redact_output(output, redact):
    """A subtitle_sample output with every harness string redacted and every cue text kept exactly as read (media text is never rewritten)."""
    d = _parsed(output)
    if d is None or not isinstance(d.get('cues'), list):
        return redact(output) if isinstance(output, str) else output
    out = {}
    for k, v in d.items():
        if k == 'cues':
            out[k] = [dict({kk: (vv if kk == 'text' else (redact(vv) if isinstance(vv, str) else vv)) for kk, vv in c.items()}) if isinstance(c, dict) else c for c in v]
        elif isinstance(v, str):
            out[k] = redact(v)
        elif isinstance(v, dict):
            out[k] = {kk: (redact(vv) if isinstance(vv, str) else vv) for kk, vv in v.items()}
        else:
            out[k] = v
    return out


def sources(output, source_id):
    """leakguard-media-2 sources: each cue text with where it came from; adjoining cues form one group, so text split across cues is checked joined."""
    d = _parsed(output)
    if d is None or not isinstance(d.get('cues'), list):
        return []
    return [{'source': source_id, 'field': 'cues[%d].text' % i, 'text': c['text'], 'group': 'cues[].text'}
            for i, c in enumerate(d['cues']) if isinstance(c, dict) and isinstance(c.get('text'), str) and c['text']]


def blank(output):
    """The harness-only shadow of a subtitle_sample output: every cue text replaced by ''."""
    d = _parsed(output)
    if d is None or not isinstance(d.get('cues'), list):
        return output
    return dict(d, cues=[dict(c, text='') if isinstance(c, dict) else c for c in d['cues']])


# ------------------------------------------------------------------------------------------------------------------ the typed layer
def derive_subtitle(d, data):
    """evidence_v2's deriver for a subtitle_sample observation: one finding of kind `subtitle_cue` per cue (its id is the cue's citable id), the stream and the
    window as scope, the cues as facts.  A reading, never an integrity check."""
    d.scope['requested'] = {'what': 'text subtitle cues', 'at_s': (d.obs.get('args') or {}).get('at')}
    if isinstance(data, dict) and isinstance(data.get('cues'), list) and d.execution['state'] in ('ran', 'timed_out'):
        st, win = data.get('stream') or {}, data.get('window') or {}
        d.scope['completed'].update({'stream': st.get('index'), 'codec': st.get('codec'), 'at_s': win.get('at_s'), 'window_s': win.get('window_s')})
        for c in data['cues']:
            if isinstance(c, dict) and isinstance(c.get('text'), str):
                d.finding('subtitle_cue', c['text'], {'stream': st.get('index'), 'start_s': c.get('start_s'), 'end_s': c.get('end_s'), 'cue': c.get('cue')}, False)
        d.facts = data
    elif data is not None:
        d.facts = data if isinstance(data, (dict, list)) else None
    d.unresolved.append('this result is a reading of subtitle text in one window, not an integrity check; text outside the window was not read')


def cue_ids(observation_id, output, status):
    """The citable ids of the cues a subtitle_sample result delivered, in order (the same ids the typed layer emits)."""
    from . import evidence_v2 as EV2
    d = EV2.derive(EV2.make_observation(observation_id, 'subtitle_sample', {}, status, output if isinstance(output, str) else json.dumps(output), 'remote', 'tool'))
    return [f['id'] for f in d.findings if f['kind'] == 'subtitle_cue']
