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
import contextlib
import contextvars
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
               'no_expected_identity', 'operation_cap', 'stopped', 'no_allowed_root', 'not_confined', 'target_deadline')
IDENTITY_FIELDS = ('size', 'mtime_ns', 'dev', 'ino')       # the opened file: size and mtime, and the device and inode it lives at


# The typed layer reads a `subtitle_sample` observation as cue findings (and the leak guard treats its cue text as media text) ONLY inside a run of this tools
# behaviour.  Every other configuration keeps the earlier reading (an unknown record), so a case file whose evidence names `subtitle_sample` is unchanged there.
_ACTIVE = contextvars.ContextVar('mrh_remote_evidence_v3_remote_1', default=False)


def active():
    return _ACTIVE.get()


@contextlib.contextmanager
def enabled():
    token = _ACTIVE.set(True)
    try:
        yield
    finally:
        _ACTIVE.reset(token)


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

    def __init__(self, identity=None, host=None, max_operations=None, root=None, time_left=None):
        self.identity = dict(identity) if identity else None
        self.host = host or HostState()
        self.max_operations = max_operations
        self.root = root                # the allowed root every path must stay under (`--root`): required for every operation
        self.time_left = time_left      # seconds left of the target deadline (a callable), or None: an operation starts only if its outer deadline fits
        self.operations = 0
        self.receipts = []       # one entry per operation: {n, mode, argv, receipt, outcome, fatal?}
        self.fatal = None

    def expected(self):
        return None if self.identity is None else {k: self.identity[k] for k in IDENTITY_FIELDS}

    def record(self):
        return {'tools_behavior': VERSION, 'sampler': RECEIPT, 'expected_identity': self.identity, 'allowed_root': self.root, 'hostname': self.host.hostname,
                'hostname_source': self.host.source, 'operations': self.operations, 'max_operations': self.max_operations,
                'receipts': list(self.receipts), 'fatal': self.fatal}


def binding_for_case(case, host, max_operations=None, time_left=None):
    """The binding of a case whose fixture is remote: `fixture.expected_identity` (from the G1 fingerprint), `fixture.expected_hostname` (bound into the run's
    host state, or checked against it), `fixture.max_operations`.  A remote fixture without an expected identity gets a binding that refuses every operation."""
    fx = case.get('fixture') or {}
    ident = fx.get('expected_identity')
    want_host = fx.get('expected_hostname')
    root = fx.get('allowed_root')
    b = Binding(ident if isinstance(ident, dict) and _identity_ok(ident) else None, host, fx.get('max_operations', max_operations),
                root if isinstance(root, str) and root.startswith('/') else None, time_left)
    if want_host and host.hostname is None:
        host.hostname, host.source = want_host, 'expected'
    elif want_host and host.hostname != want_host:
        b.fatal = {'kind': 'hostname_changed', 'detail': 'the case expects host %r; this run is bound to %r' % (want_host, host.hostname), 'cause': 'tool'}
    return b


def _identity_ok(ident):
    return all(isinstance(ident.get(k), int) and not isinstance(ident.get(k), bool) for k in IDENTITY_FIELDS)


def exec_argv(namespace, target, container, mode, path, opts=()):
    """`kubectl -n <ns> exec -i <target> -c <container> -- python3 - <mode> <path> [opts]` (target like deploy/<name> or pod/<name>)."""
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


RECEIPT_KEYS = ('receipt', 'mode', 'hostname', 'exit_code', 'error', 'stdout_bytes', 'stderr', 'bytes_read', 'quota_exhausted', 'requests', 'wall_seconds',
                'timed_out', 'source_unchanged', 'identity', 'argv', 'confined')
IDENTITY_KEYS = ('expected', 'start', 'end', 'start_ok', 'end_ok', 'same_file')
QUOTA_BYTES = 8388608
MAX_BYTES_READ = QUOTA_BYTES          # the range server's quota; a stat reads at most 2 MiB
_HOST_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$')


def _bool_or_none(v):
    return v is None or type(v) is bool


def _ident_errors(name, v):
    if v is None:
        return []
    if not isinstance(v, dict) or set(v) != set(IDENTITY_FIELDS):
        return ['identity.%s must be {%s}' % (name, ', '.join(IDENTITY_FIELDS))]
    if not (all(_int(v[k]) for k in IDENTITY_FIELDS) and v['size'] >= 0 and v['dev'] >= 0 and v['ino'] >= 0):
        return ['identity.%s values must be integers (size, dev, ino >= 0)' % name]
    return []


def receipt_errors(r, mode, stdout_len):
    """Every way a receipt can be malformed (empty when it is well formed): every field present with its type and range (booleans are real booleans, numbers
    integers or finite, identities integers), and the receipt consistent with itself (`source_unchanged` exactly when the end identity equals the start one
    and the path still names the opened file) and with what was received (`stdout_bytes`).  It checks shape and consistency, not the verdicts."""
    import math
    errs = []
    missing = [k for k in RECEIPT_KEYS if k not in r]
    if missing:
        return ['receipt fields missing: %s' % missing]
    if r['mode'] != mode:
        errs.append('mode %r, expected %r' % (r['mode'], mode))
    if not (isinstance(r['hostname'], str) and _HOST_RX.match(r['hostname'])):
        errs.append('hostname missing or malformed')
    ec = r['exit_code']
    if not (_int(ec) or ec in ('timeout', 'error')):
        errs.append('exit_code malformed')
    if not (r['error'] is None or isinstance(r['error'], str)):
        errs.append('error malformed')
    if not _int(r['stdout_bytes']) or r['stdout_bytes'] != stdout_len:
        errs.append('stdout_bytes %r does not match the %d bytes received' % (r['stdout_bytes'], stdout_len))
    if not (_int(r['bytes_read']) and 0 <= r['bytes_read'] <= MAX_BYTES_READ):
        errs.append('bytes_read malformed or out of range')
    if not (_int(r['requests']) and r['requests'] >= 0):
        errs.append('requests malformed')
    for k in ('quota_exhausted', 'timed_out'):
        if type(r[k]) is not bool:
            errs.append('%s must be a boolean' % k)
    if not (_num(r['wall_seconds']) and math.isfinite(r['wall_seconds']) and 0 <= r['wall_seconds'] <= OUTER_DEADLINE_S):
        errs.append('wall_seconds malformed or out of range')
    if not isinstance(r['stderr'], str):
        errs.append('stderr malformed')
    if not (r['argv'] is None or (isinstance(r['argv'], list) and all(isinstance(x, str) for x in r['argv']))):
        errs.append('argv malformed')
    if not _bool_or_none(r['source_unchanged']):
        errs.append('source_unchanged must be a boolean or null')
    if not _bool_or_none(r['confined']):
        errs.append('confined must be a boolean or null')
    if r['quota_exhausted'] is True and r['bytes_read'] != QUOTA_BYTES:
        errs.append('quota_exhausted without the quota read')
    if ec == 'timeout' and r['timed_out'] is not True:
        errs.append('exit_code timeout without timed_out')
    ident = r['identity']
    if not isinstance(ident, dict) or set(ident) != set(IDENTITY_KEYS):
        return errs + ['identity block missing or malformed']
    for k in ('expected', 'start', 'end'):
        errs += _ident_errors(k, ident[k])
    for k in ('start_ok', 'end_ok', 'same_file'):
        if not _bool_or_none(ident[k]):
            errs.append('identity.%s must be a boolean or null' % k)
    if errs:
        return errs
    su, start, end, same = r['source_unchanged'], ident['start'], ident['end'], ident['same_file']
    if mode in FILE_MODES:
        if ec == 0 and (su is None or start is None or end is None or same is None):
            errs.append('a completed operation must report its start and end identity, same_file and source_unchanged')
        if su is not None and (start is None or end is None or same is None):
            errs.append('source_unchanged without both identities and same_file')
        if su is not None and start is not None and end is not None and same is not None and su != (start == end and same):
            errs.append('source_unchanged %r contradicts the start %s, the end %s and same_file %r' % (su, start, end, same))
        if end is not None and su is None:
            errs.append('an end identity without source_unchanged')
        exp = ident['expected']
        if ident['start_ok'] is not None and (exp is None or start is None or ident['start_ok'] != (start == exp)):
            errs.append('identity.start_ok contradicts the expected and start identities')
        if ident['end_ok'] is not None and (exp is None or end is None or same is None or ident['end_ok'] != (end == exp and same)):
            errs.append('identity.end_ok contradicts the expected and end identities')
    if mode == 'list':
        lst = r.get('listing')
        if not (isinstance(lst, dict) and type(lst.get('complete')) is bool and _int(lst.get('matching')) and _int(lst.get('scanned'))
                and 0 <= lst['matching'] <= lst['scanned'] and lst.get('cap') == LIST_CAP and isinstance(lst.get('prefix'), str)
                and (not lst['complete'] or lst['matching'] < LIST_CAP)):
            errs.append('listing block missing or inconsistent')
        if su is not None or any(ident[k] is not None for k in IDENTITY_KEYS):
            errs.append('a listing carries no file identity')
    return errs


def run_operation(runner, namespace, target, container, mode, path, binding, opts=(), bind_identity=True):
    """One remote sampler operation under `binding`.  -> (receipt, stdout bytes).  Raises FatalOperation on every fatal path; never invokes anything once the
    binding is fatal.  `bind_identity=False` only for an operation that SETS the identity (the driver's G1 stat) or reads a directory (`list`)."""
    if binding.fatal:
        raise FatalOperation('stopped', 'an earlier operation failed closed (%s); no further operation is started' % binding.fatal.get('kind'))
    if binding.root is None:
        return _fail(binding, FatalOperation('no_allowed_root', 'the operation has no allowed root to confine its path; nothing was invoked'), mode, None)
    if binding.time_left is not None:
        left = binding.time_left()
        if left is None or not left >= OUTER_DEADLINE_S:
            return _fail(binding, FatalOperation('target_deadline', 'the %d s outer deadline of an operation does not fit the %s s left of the target deadline; '
                                                 'nothing was invoked' % (OUTER_DEADLINE_S, left if left is None else round(left, 1))), mode, None)
    if binding.max_operations is not None and binding.operations >= binding.max_operations:
        return _fail(binding, FatalOperation('operation_cap', 'the cap of %d sampler operations for this file is reached' % binding.max_operations), mode, None)
    want = binding.expected() if bind_identity else None
    if bind_identity and want is None:
        return _fail(binding, FatalOperation('no_expected_identity', 'the operation has no expected identity to bind; nothing was invoked'), mode, None)
    extra = list(opts) + ['--root', binding.root]
    if want is not None:
        extra += ['--expect-size', want['size'], '--expect-mtime-ns', want['mtime_ns'], '--expect-dev', want['dev'], '--expect-ino', want['ino']]
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
    rc = getattr(r, 'returncode', None)
    if rc != 0:
        # kubectl (or the remote python) did not exit cleanly: whatever it printed is not a completed operation, even with a receipt line
        return _fail(binding, FatalOperation('exec_failed', 'the exec exited %r' % (rc,), receipt, argv), mode, argv)
    if receipt is None:
        return _fail(binding, FatalOperation('missing_receipt', problem, argv=argv), mode, argv)
    errs = receipt_errors(receipt, mode, len(stdout))
    if errs:
        return _fail(binding, FatalOperation('malformed_receipt', '; '.join(errs)[:400], receipt, argv), mode, argv)
    if receipt['confined'] is False or (receipt['exit_code'] in (0, 'timeout') and receipt['confined'] is not True):
        return _fail(binding, FatalOperation('not_confined', 'the path is not confined under the allowed root (confined %r)' % receipt['confined'], receipt, argv),
                     mode, argv)
    if not binding.host.check(receipt['hostname']):
        return _fail(binding, FatalOperation('hostname_changed', 'the receipt names host %r; the run is bound to %r' % (receipt['hostname'], binding.host.hostname),
                                             receipt, argv), mode, argv)
    if mode in FILE_MODES:
        ident = receipt['identity']
        if want is not None:
            # both ends must be checked and equal, and the path must still name the opened file: an end the sampler could not read (its own stat timed out)
            # is not verified, so it fails closed too
            ok = (ident['expected'] == want and ident['start_ok'] is True and ident['start'] == want
                  and ident['end_ok'] is True and ident['end'] == want and ident['same_file'] is True)
            if not ok:
                return _fail(binding, FatalOperation('identity_mismatch', 'expected %s; start %s, end %s, same file %s' % (
                    want, ident['start'], ident['end'], ident['same_file']), receipt, argv), mode, argv)
        if receipt['source_unchanged'] is False or ident['same_file'] is False:
            return _fail(binding, FatalOperation('source_changed', 'the sampler reports source_unchanged %r, same_file %r' % (
                receipt['source_unchanged'], ident['same_file']), receipt, argv), mode, argv)
        if receipt['exit_code'] in (0, 'timeout') and receipt['source_unchanged'] is not True:
            # an operation that read something must have its end verified; a missing end check never delivers what was read
            return _fail(binding, FatalOperation('identity_mismatch', 'the end of the operation was not verified (source_unchanged %r)' % receipt['source_unchanged'],
                                                 receipt, argv), mode, argv)
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
    """Seconds from validated components (minutes and seconds below 60, milliseconds 1 to 3 digits); None when a component is out of range."""
    if int(m) >= 60 or int(s) >= 60:
        return None
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
        if start is None or end is None or start > end:
            return [], 'block %d has an invalid timing line (a component out of range, or the end before the start)' % (i + 1)
        body = ' '.join(' '.join(_TAG_RX.sub('', ln).split()) for ln in lines[2:])
        body = ' '.join(body.split())
        if body:
            cues.append({'start': start, 'end': end, 'text': body})
    if cut and cues and not text.endswith('\n\n'):
        cues[-1]['truncated'] = True        # the cut may have ended this cue's text: it is marked, never presented as a complete cue
    return cues, None


def cue_output(stream, at, window, cues, scope=None):
    shown = cues[:MAX_CUES]
    out = {'stream': {'index': stream['index'], 'codec': stream['codec'], 'language': stream.get('language')},
           'window': {'at_s': at, 'window_s': window, 'end_s': round(at + window, 3)},
           'cue_count': len(cues),
           'cues': [dict({'cue': i + 1, 'start_s': round(at + c['start'], 3), 'end_s': round(at + c['end'], 3), 'text': c['text'][:CUE_TEXT_MAX]},
                         **({'text_cut': True} if len(c['text']) > CUE_TEXT_MAX else {}), **({'truncated': True} if c.get('truncated') else {}))
                    for i, c in enumerate(shown)],
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
    """The ids of the cues a subtitle_sample result carries, in order (the same ids the typed layer emits).  Carried is not delivered: see delivered_cue_ids."""
    from . import evidence_v2 as EV2
    with enabled():
        d = EV2.derive(EV2.make_observation(observation_id, 'subtitle_sample', {}, status, output if isinstance(output, str) else json.dumps(output), 'remote', 'tool'))
    return [f['id'] for f in d.findings if f['kind'] == 'subtitle_cue']


def delivered_cue_ids(sent_messages, observations):
    """The cue ids that actually reached the model: the ids of the cues the subtitle observations carry that appear in a user message that was SENT (after the
    leak guard passed it), first pages and fetched pages alike.  `observations` are (id, output, status) of subtitle_sample results."""
    sent = [m.get('content') or '' for m in sent_messages if m.get('role') == 'user']
    out = []
    for oid, output, status in observations:
        for cid in cue_ids(oid, output, status):
            if any('"%s"' % cid in text for text in sent):
                out.append(cid)
    return out


# ------------------------------------------------------------------------------------------------------------------ raw write intents
_WRITE_RX = re.compile(r'"action"\s*:\s*"(blocklist_and_search|remap|rename|convert)"')
_FENCE_RX = re.compile(r'```[A-Za-z0-9_-]*')


def raw_write_intent(text):
    """The write intent one raw model reply expresses, whatever its protocol validity: {action, parse} or None.  `strict` = the protocol parser reads a
    decision; `lenient` = a JSON object inside fences or prose; `pattern` = an "action": "<write>" pair in text no parser reads.  A strict reply that is
    not a write decision (a tool call, a no-write decision) expresses none."""
    from . import protocol as P
    if not isinstance(text, str) or not text.strip():
        return None
    obj, _err, _diag = P.parse_reply(text)
    if isinstance(obj, dict):
        if obj.get('type') == 'decision' and obj.get('action') in P.WRITE_ACTIONS:
            return {'action': obj['action'], 'parse': 'strict', 'proposal': obj}
        return None
    body = _FENCE_RX.sub('', text)
    i, j = body.find('{'), body.rfind('}')
    if 0 <= i < j:
        try:
            cand = json.loads(body[i:j + 1])
        except ValueError:
            cand = None
        if isinstance(cand, dict) and cand.get('action') in P.WRITE_ACTIONS:
            return {'action': cand['action'], 'parse': 'lenient', 'proposal': cand}
    m = _WRITE_RX.search(text)
    if m:
        return {'action': m.group(1), 'parse': 'pattern', 'proposal': None}
    return None
