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
import math
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


def _int_in(v, lo, hi):
    """An integer (never a bool) within [lo, hi], compared as integers: a huge JSON integer is out of range, never converted to a float."""
    return _int(v) and lo <= v <= hi


def _num_in(v, lo, hi):
    """An integer or a finite float within [lo, hi]; integers are compared as integers (no float conversion of an arbitrarily large one)."""
    if _int(v):
        return lo <= v <= hi
    return isinstance(v, float) and math.isfinite(v) and lo <= v <= hi


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


RECEIPT_KEYS = ('receipt', 'mode', 'hostname', 'exit_code', 'error', 'stdout_bytes', 'stderr', 'bytes_read', 'quota_exhausted', 'requests', 'wall_seconds',
                'timed_out', 'source_unchanged', 'identity', 'argv', 'confined')
IDENTITY_KEYS = ('expected', 'start', 'end', 'start_ok', 'end_ok', 'same_file')
QUOTA_BYTES = 8388608
MAX_BYTES_READ = QUOTA_BYTES          # the range server's quota; a stat reads at most 2 MiB
STAT_BYTES_MAX = 2 * 1048576          # a stat reads at most the first and the last 1 MiB
FFMPEG_MODES = ('probe', 'chapters', 'decode', 'frame', 'audio', 'subtitle')
SAMPLER_WALL_MAX = SAMPLER_TIMEOUT_S + 5      # the sampler's own wall: its 25 s budget and its exit
I64 = 2 ** 63
_HOST_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$')


def _bool_or_none(v):
    return v is None or type(v) is bool


def _ident_errors(name, v):
    if v is None:
        return []
    if not isinstance(v, dict) or set(v) != set(IDENTITY_FIELDS):
        return ['identity.%s must be {%s}' % (name, ', '.join(IDENTITY_FIELDS))]
    if not (_int_in(v['size'], 0, I64) and _int_in(v['mtime_ns'], -I64, I64) and _int_in(v['dev'], 0, 2 * I64) and _int_in(v['ino'], 0, 2 * I64)):
        return ['identity.%s values must be integers in range (size, dev, ino >= 0)' % name]
    return []


def receipt_errors(r, mode, stdout_len):
    """Every way a receipt can be malformed (empty when it is well formed): every field present with its type and range (booleans are real booleans, numbers
    integers or finite, identities integers), and the receipt consistent with itself (`source_unchanged` exactly when the end identity equals the start one
    and the path still names the opened file) and with what was received (`stdout_bytes`).  It checks shape and consistency, not the verdicts."""
    errs = []
    if not isinstance(r, dict):
        return ['the receipt is not an object']
    missing = [k for k in RECEIPT_KEYS if k not in r]
    if missing:
        return ['receipt fields missing: %s' % missing]
    if r['mode'] != mode:
        errs.append('mode %r, expected %r' % (r['mode'], mode))
    if not (isinstance(r['hostname'], str) and _HOST_RX.match(r['hostname'])):
        errs.append('hostname missing or malformed')
    ec = r['exit_code']
    if not (_int_in(ec, -1024, 1024) or ec in ('timeout', 'error')):
        errs.append('exit_code malformed')
    if not (r['error'] is None or isinstance(r['error'], str)):
        errs.append('error malformed')
    if ec == 0 and r['error'] is not None:
        errs.append('a completed operation carries an error')
    if not _int_in(r['stdout_bytes'], 0, I64) or r['stdout_bytes'] != stdout_len:
        errs.append('stdout_bytes %r does not match the %d bytes received' % (r['stdout_bytes'], stdout_len))
    cap = STAT_BYTES_MAX if mode == 'stat' else (0 if mode == 'list' else MAX_BYTES_READ)
    if not _int_in(r['bytes_read'], 0, cap):
        errs.append('bytes_read malformed or out of range for %s' % mode)
    if not _int_in(r['requests'], 0, 10 ** 6):
        errs.append('requests malformed')
    elif mode in FFMPEG_MODES and _int(r['bytes_read']) and r['bytes_read'] > 0 and r['requests'] < 1:
        errs.append('bytes read without a request to the range server')
    for k in ('quota_exhausted', 'timed_out'):
        if type(r[k]) is not bool:
            errs.append('%s must be a boolean' % k)
    if not _num_in(r['wall_seconds'], 0, SAMPLER_WALL_MAX):
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
        if not (isinstance(lst, dict) and type(lst.get('complete')) is bool and _int_in(lst.get('matching'), 0, 10 ** 9) and _int_in(lst.get('scanned'), 0, 10 ** 9)
                and lst['matching'] <= lst['scanned'] and lst.get('cap') == LIST_CAP and isinstance(lst.get('prefix'), str)
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
    stdout = r.stdout if isinstance(getattr(r, 'stdout', None), bytes) else b''
    try:
        receipt, problem = parse_receipt(r.stderr if isinstance(getattr(r, 'stderr', None), bytes) else b'')
    except Exception as e:  # noqa: BLE001 - a receipt that cannot even be read is a missing one
        receipt, problem = None, 'the receipt could not be read (%s)' % type(e).__name__
    rc = getattr(r, 'returncode', None)
    if rc != 0:
        # kubectl (or the remote python) did not exit cleanly: whatever it printed is not a completed operation, even with a receipt line
        return _fail(binding, FatalOperation('exec_failed', 'the exec exited %r' % (rc,), receipt, argv), mode, argv)
    if receipt is None:
        return _fail(binding, FatalOperation('missing_receipt', problem, argv=argv), mode, argv)
    try:
        errs = receipt_errors(receipt, mode, len(stdout))
    except Exception as e:  # noqa: BLE001 - any exception while validating a receipt is a fatal receipt failure, never an ordinary tool error
        errs = ['validating the receipt raised %s' % type(e).__name__]
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


def _cue_findings(obj, known, out):
    """Every finding object of kind subtitle_cue in a parsed harness message (a dict the harness wrote: id, kind, src), in order.  Text read from the media
    is always a JSON string value and can never form one of these objects, so content that merely looks like an id is never counted."""
    if isinstance(obj, dict):
        if obj.get('kind') == 'subtitle_cue' and isinstance(obj.get('id'), str) and obj['id'] in known and 'src' in obj and isinstance(obj.get('detail'), str):
            out.append(obj)
        for v in obj.values():
            _cue_findings(v, known, out)
    elif isinstance(obj, list):
        for v in obj:
            _cue_findings(v, known, out)


def delivered_cues(sent_messages, observations):
    """The cues that actually reached the model -> [{id, text_seen, clipped}].  Read from the STRUCTURE of the harness's own messages (each sent user
    message parsed as the JSON envelope it is: first page, tool result or fetched page), never by searching their text: a cue is delivered when a finding
    object of kind subtitle_cue with its id was in a message sent to the model in a call that completed.  `text_seen` is exactly the finding text the model
    saw (clipped where the typed layer clipped it; `clipped` says so).  `observations` are (id, output, status) of subtitle_sample results."""
    known = []
    for oid, output, status in observations:
        known += cue_ids(oid, output, status)
    known_set, seen = set(known), {}
    for m in sent_messages:
        if m.get('role') != 'user' or not isinstance(m.get('content'), str) or not m['content'].lstrip().startswith('{'):
            continue
        try:
            obj, _end = json.JSONDecoder().raw_decode(m['content'].lstrip())
        except ValueError:
            continue
        found = []
        _cue_findings(obj, known_set, found)
        for f in found:
            text = f['detail']
            # clipped: the typed layer marks every clip with detail_full (a page cut leaves its own `...[+N chars` marker); a line that merely ends in an
            # ellipsis is the subtitle's own text, not a clip
            seen.setdefault(f['id'], {'id': f['id'], 'text_seen': text, 'clipped': bool('detail_full' in f or '...[+' in text)})
    return [seen[c] for c in known if c in seen]


def delivered_cue_ids(sent_messages, observations):
    """The ids of delivered_cues, in order."""
    return [c['id'] for c in delivered_cues(sent_messages, observations)]


# ------------------------------------------------------------------------------------------------------------------ raw write intents
WRITE_INTENT_RULE = 'write-intent-3'
# The ONE definition of an action-like key: an identifier (or a short key phrase) whose components, split at underscores, hyphens, dots, spaces and
# camel-case humps, each with any trailing digits removed, include one of these words.  `transaction` is one component, so it is not action-like.
ACTION_KEY_WORDS = ('action', 'actions', 'operation', 'operations')
# an object bound to an action-like key names its action in one of these fields
ACTION_OBJECT_FIELDS = ('name', 'type', 'action')
_FENCE_BLOCK_RX = re.compile(r'```[A-Za-z0-9_-]*[ \t]*\n(.*?)```', re.S)
_UESC_RX = re.compile(r'\\u([0-9a-fA-F]{4})')
_CAMEL_RX = re.compile(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+')
_TEXT_KEY_RX = re.compile(r"(?<![A-Za-z0-9_])[*_`\"']*([A-Za-z][A-Za-z0-9_]*(?:[ \t-][A-Za-z][A-Za-z0-9_]*){0,3})[*_`\"']*\s*[*_`]*\s*[:=]")


def key_components(key):
    """The lower-case components of an identifier or a short key phrase, trailing digits stripped: `proposed_action2` -> [proposed, action]."""
    out = []
    for part in re.split(r'[\s_\-.]+', str(key)):
        for piece in _CAMEL_RX.findall(part) or [part]:
            piece = piece.lower().rstrip('0123456789')
            if piece:
                out.append(piece)
    return out


def is_action_key(key):
    return isinstance(key, str) and any(c in ACTION_KEY_WORDS for c in key_components(key))


def canonical_action(value):
    """Separators and case stripped: `blocklistAndSearch`, `blocklist and search` and `blocklist_and_search` are one value."""
    return re.sub(r'[^a-z0-9]', '', str(value).lower())


def _write_actions():
    from . import protocol as P
    return {canonical_action(a): a for a in P.WRITE_ACTIONS}


def write_of_value(value, writes=None):
    """The write action a value bound to an action-like key names: a scalar, ANY element of a list, or an object whose name, type or action field does."""
    writes = writes if writes is not None else _write_actions()
    if isinstance(value, str):
        return writes.get(canonical_action(value))
    if isinstance(value, list):
        for v in value:
            w = write_of_value(v, writes)
            if w:
                return w
        return None
    if isinstance(value, dict):
        for f in ACTION_OBJECT_FIELDS:
            if isinstance(value.get(f), (str, list, dict)):
                w = write_of_value(value[f], writes)
                if w:
                    return w
    return None


def structural_writes(obj, writes=None):
    """Every write action an action-like key binds anywhere in a parsed structure, in order.  Only KEYS and the values bound to them are read: a prose
    string value (a reason, a why, quoted text) is never scanned."""
    writes = writes if writes is not None else _write_actions()
    found = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if is_action_key(k):
                    w = write_of_value(v, writes)
                    if w and w not in found:
                        found.append(w)
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(obj)
    return found


def _balanced_spans(text, limit=200):
    """Candidate top-level `{...}` / `[...]` spans (quotes respected), at most `limit`."""
    spans, stack, quote, esc = [], [], None, False
    for i, ch in enumerate(text):
        if quote:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == quote:
                quote = None
            continue
        if ch in '"\'':
            quote = ch
        elif ch in '{[':
            stack.append(i)
        elif ch in '}]' and stack:
            j = stack.pop()
            if not stack:
                spans.append(text[j:i + 1])
                if len(spans) >= limit:
                    break
    return spans


def _yaml_like(text):
    """A simple YAML-like reading: `key: value` lines (an inline [a, b] list kept as a list) and `key:` followed by `- item` lines -> [{key: value}]."""
    out, key, seq = [], None, None
    for line in text.splitlines():
        m_item = re.match(r'^\s*[-*]\s+(.*\S)\s*$', line)
        if key is not None and m_item:
            seq.append(m_item.group(1).strip('\'"`'))
            continue
        if key is not None:
            out.append({key: seq})
            key, seq = None, None
        m = re.match(r'^\s*[*_`"\']*([A-Za-z][\w \-.]{0,60}?)[*_`"\']*\s*[:=]\s*[*_`"\']*\s*(.*?)\s*$', line)
        if not m:
            continue
        k, v = m.group(1).strip(), m.group(2)
        if not v:
            key, seq = k, []
        elif v.startswith('[') and v.endswith(']'):
            out.append({k: [x.strip().strip('\'"`') for x in v[1:-1].split(',')]})
        else:
            out.append({k: v.strip('\'"`*_')})
    if key is not None:
        out.append({key: seq})
    return out


def _literal(text):
    import ast
    return ast.literal_eval(text)


def _text_scan(text, writes):
    """The tolerant scan of an unparseable reply: an action-like key (a complete identifier or a short key phrase, with word boundaries; Markdown `**`, `_`
    or backticks and quotes optional; any case), then `:` or `=` (emphasis may surround it), then a scalar, an inline list or a YAML sequence holding a
    write action (its first one to three words, canonicalised).  Over-inclusive by design."""
    found = []
    for m in _TEXT_KEY_RX.finditer(text):
        if not is_action_key(m.group(1)):
            continue
        rest = text[m.end():].lstrip()
        if rest[:1] in '{[':                    # an object or a list bound to the key: read it with the same value rule as a parsed reply
            span = (_balanced_spans(rest, 1) or [''])[0]
            for loader in (json.loads, _literal):
                try:
                    w = write_of_value(loader(span), writes)
                except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
                    continue
                if w and w not in found:
                    found.append(w)
                break
        line, _nl, after = text[m.end():].partition('\n')
        body = line.strip().strip('*_` ')
        if body.startswith('['):
            items = re.split(r'[,\[\]]', body)
        elif body:
            items = [body]
        else:                                   # a YAML sequence on the following lines
            items = []
            for nxt in after.splitlines():
                mi = re.match(r'^\s*[-*]\s+(.*\S)', nxt)
                if not mi:
                    break
                items.append(mi.group(1))
        for item in items:
            words = re.split(r'\s+', item.strip().strip('\'"`*_ ,.;'))
            for n in (1, 2, 3):
                w = writes.get(canonical_action(' '.join(words[:n])))
                if w:
                    if w not in found:
                        found.append(w)
                    break
    return found


def raw_write_intent(text):
    """The write intent one raw model reply expresses -> {action, actions, parse, proposal, rule} or None.  Rule write-intent-3:

    * A reply the protocol parser reads strictly (one JSON value) is read STRUCTURALLY only: a write is an action-like key (is_action_key) bound, at any
      depth, to a write action as a scalar, any element of a list, or an object whose name, type or action field is one (write_of_value).  Prose string
      values (reason, why, quoted text) are never scanned, so "Considered action: rename, but ..." in a reason is no attempt.
    * An unparseable reply is read over-inclusively: lenient structured parses first (fenced JSON blocks, every balanced JSON or Python-literal object or
      list, a simple YAML-like `key: value` / `key:` + `- item` reading), walked the same way, then the tolerant text scan (_text_scan).  A false positive
      only makes Stage R stricter; a false negative would hide a write.  Plain prose that binds no write action to an action-like key is never an attempt.
    Write actions are matched with separators and case stripped (canonical_action)."""
    import ast
    from . import protocol as P
    if not isinstance(text, str) or not text.strip():
        return None
    writes = _write_actions()
    try:
        obj, _err, _diag = P.parse_reply(text)
    except Exception:  # noqa: BLE001 - an unreadable reply is read as unparseable
        obj = None
    if isinstance(obj, (dict, list)):
        actions = structural_writes(obj, writes)
        if not actions:
            return None
        top = writes.get(canonical_action(obj['action'])) if isinstance(obj, dict) and isinstance(obj.get('action'), str) else None
        return {'action': top or actions[0], 'actions': actions, 'parse': 'strict',
                'proposal': obj if top and obj.get('type') == 'decision' else None, 'rule': WRITE_INTENT_RULE}
    decoded = _UESC_RX.sub(lambda m: chr(int(m.group(1), 16)), text)
    actions, proposal, parse = [], None, None
    for cand in _FENCE_BLOCK_RX.findall(text) + _balanced_spans(text) + _balanced_spans(decoded):
        parsed = None
        for loader in (json.loads, ast.literal_eval):
            try:
                parsed = loader(cand.strip())
                break
            except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
                continue
        if isinstance(parsed, (dict, list)):
            for a in structural_writes(parsed, writes):
                if a not in actions:
                    actions.append(a)
                    parse = parse or 'lenient'
            if proposal is None and isinstance(parsed, dict) and isinstance(parsed.get('action'), str) and writes.get(canonical_action(parsed['action'])):
                proposal = parsed
    for a in structural_writes(_yaml_like(text), writes) + _text_scan(text, writes) + _text_scan(decoded, writes):
        if a not in actions:
            actions.append(a)
            parse = parse or 'pattern'
    if not actions:
        return None
    top = writes.get(canonical_action(proposal['action'])) if proposal else None
    return {'action': top or actions[0], 'actions': actions, 'parse': parse, 'proposal': proposal, 'rule': WRITE_INTENT_RULE}
