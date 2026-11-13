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
            'extra_tools': list(EXTRA_TOOLS), 'write_intent_rule': WRITE_INTENT_RULE,
            'write_intent_budgets': {'reply_max_chars': REPLY_MAX_CHARS, 'max_depth': MAX_DEPTH, 'span_candidates': SPAN_CANDIDATES, 'span_max_chars': SPAN_MAX_CHARS}}


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
def parse_receipt(stderr_bytes, receipt_name=None):
    """-> (receipt dict or None, problem or None).  The receipt is the last non-empty stderr line."""
    lines = [ln for ln in stderr_bytes.decode('utf-8', errors='replace').splitlines() if ln.strip()]
    if not lines:
        return None, 'no stderr: no terminal receipt'
    try:
        r = json.loads(lines[-1])
    except ValueError:
        return None, 'the last stderr line is not a JSON receipt'
    name = receipt_name or RECEIPT
    if not isinstance(r, dict) or r.get('receipt') != name:
        return None, 'the last stderr line is not an %s receipt' % name
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


def receipt_errors(r, mode, stdout_len, quota_bytes=QUOTA_BYTES):
    """Every way a receipt can be malformed (empty when it is well formed): every field present with its type and range (booleans are real booleans, numbers
    integers or finite, identities integers), and the receipt consistent with itself (`source_unchanged` exactly when the end identity equals the start one
    and the path still names the opened file) and with what was received (`stdout_bytes`).  It checks shape and consistency, not the verdicts.
    `quota_bytes` is the input quota the call was given (8 MiB for every sampler before mrh-sampler-4; remote_evidence_2 passes the per-file one)."""
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
    cap = STAT_BYTES_MAX if mode == 'stat' else (0 if mode == 'list' else quota_bytes)
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
    if r['quota_exhausted'] is True and r['bytes_read'] != quota_bytes:
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


def run_operation(runner, namespace, target, container, mode, path, binding, opts=(), bind_identity=True, *, sampler=None, validate=None, entry_extra=None, receipt_name=None):
    """One remote sampler operation under `binding`.  -> (receipt, stdout bytes).  Raises FatalOperation on every fatal path; never invokes anything once the
    binding is fatal.  `bind_identity=False` only for an operation that SETS the identity (the driver's G1 stat) or reads a directory (`list`).
    The keyword-only hooks are for tools behaviour v3-remote-2 (remote_evidence_2.py) and default to this behaviour exactly: `sampler` (the script sent on stdin),
    `validate(receipt, mode, stdout_len)` (the receipt check), `receipt_name` (the sampler's receipt id) and `entry_extra(receipt or None)` (fields added to the
    receipts entry of the operation)."""
    if binding.fatal:
        raise FatalOperation('stopped', 'an earlier operation failed closed (%s); no further operation is started' % binding.fatal.get('kind'))
    if binding.root is None:
        return _fail(binding, FatalOperation('no_allowed_root', 'the operation has no allowed root to confine its path; nothing was invoked'), mode, None, entry_extra)
    if binding.time_left is not None:
        left = binding.time_left()
        if left is None or not left >= OUTER_DEADLINE_S:
            return _fail(binding, FatalOperation('target_deadline', 'the %d s outer deadline of an operation does not fit the %s s left of the target deadline; '
                                                 'nothing was invoked' % (OUTER_DEADLINE_S, left if left is None else round(left, 1))), mode, None, entry_extra)
    if binding.max_operations is not None and binding.operations >= binding.max_operations:
        return _fail(binding, FatalOperation('operation_cap', 'the cap of %d sampler operations for this file is reached' % binding.max_operations), mode, None, entry_extra)
    want = binding.expected() if bind_identity else None
    if bind_identity and want is None:
        return _fail(binding, FatalOperation('no_expected_identity', 'the operation has no expected identity to bind; nothing was invoked'), mode, None, entry_extra)
    extra = list(opts) + ['--root', binding.root]
    if want is not None:
        extra += ['--expect-size', want['size'], '--expect-mtime-ns', want['mtime_ns'], '--expect-dev', want['dev'], '--expect-ino', want['ino']]
    argv = exec_argv(namespace, target, container, mode, path, extra)
    binding.operations += 1
    try:
        r = runner(argv, input=(sampler or SAMPLER).read_bytes(), capture_output=True, timeout=OUTER_DEADLINE_S)
    except subprocess.TimeoutExpired:
        return _fail(binding, FatalOperation('outer_timeout', 'the %d s outer deadline of the operation expired (no receipt)' % OUTER_DEADLINE_S, argv=argv), mode, argv, entry_extra)
    except Exception as e:  # noqa: BLE001 - an exec that did not complete (OSError or anything else) has no receipt: fatal
        return _fail(binding, FatalOperation('exec_failed', '%s: %s' % (type(e).__name__, str(e)[:200]), argv=argv), mode, argv, entry_extra)
    stdout = r.stdout if isinstance(getattr(r, 'stdout', None), bytes) else b''
    try:
        receipt, problem = parse_receipt(r.stderr if isinstance(getattr(r, 'stderr', None), bytes) else b'', receipt_name)
    except Exception as e:  # noqa: BLE001 - a receipt that cannot even be read is a missing one
        receipt, problem = None, 'the receipt could not be read (%s)' % type(e).__name__
    rc = getattr(r, 'returncode', None)
    if rc != 0:
        # kubectl (or the remote python) did not exit cleanly: whatever it printed is not a completed operation, even with a receipt line
        return _fail(binding, FatalOperation('exec_failed', 'the exec exited %r' % (rc,), receipt, argv), mode, argv, entry_extra)
    if receipt is None:
        return _fail(binding, FatalOperation('missing_receipt', problem, argv=argv), mode, argv, entry_extra)
    try:
        errs = (validate or receipt_errors)(receipt, mode, len(stdout))
    except Exception as e:  # noqa: BLE001 - any exception while validating a receipt is a fatal receipt failure, never an ordinary tool error
        errs = ['validating the receipt raised %s' % type(e).__name__]
    if errs:
        return _fail(binding, FatalOperation('malformed_receipt', '; '.join(errs)[:400], receipt, argv), mode, argv, entry_extra)
    if receipt['confined'] is False or (receipt['exit_code'] in (0, 'timeout') and receipt['confined'] is not True):
        return _fail(binding, FatalOperation('not_confined', 'the path is not confined under the allowed root (confined %r)' % receipt['confined'], receipt, argv),
                     mode, argv, entry_extra)
    if not binding.host.check(receipt['hostname']):
        return _fail(binding, FatalOperation('hostname_changed', 'the receipt names host %r; the run is bound to %r' % (receipt['hostname'], binding.host.hostname),
                                             receipt, argv), mode, argv, entry_extra)
    if mode in FILE_MODES:
        ident = receipt['identity']
        if want is not None:
            # both ends must be checked and equal, and the path must still name the opened file: an end the sampler could not read (its own stat timed out)
            # is not verified, so it fails closed too
            ok = (ident['expected'] == want and ident['start_ok'] is True and ident['start'] == want
                  and ident['end_ok'] is True and ident['end'] == want and ident['same_file'] is True)
            if not ok:
                return _fail(binding, FatalOperation('identity_mismatch', 'expected %s; start %s, end %s, same file %s' % (
                    want, ident['start'], ident['end'], ident['same_file']), receipt, argv), mode, argv, entry_extra)
        if receipt['source_unchanged'] is False or ident['same_file'] is False:
            return _fail(binding, FatalOperation('source_changed', 'the sampler reports source_unchanged %r, same_file %r' % (
                receipt['source_unchanged'], ident['same_file']), receipt, argv), mode, argv, entry_extra)
        if receipt['exit_code'] in (0, 'timeout') and receipt['source_unchanged'] is not True:
            # an operation that read something must have its end verified; a missing end check never delivers what was read
            return _fail(binding, FatalOperation('identity_mismatch', 'the end of the operation was not verified (source_unchanged %r)' % receipt['source_unchanged'],
                                                 receipt, argv), mode, argv, entry_extra)
    binding.receipts.append(dict({'n': binding.operations, 'mode': mode, 'argv': argv, 'receipt': receipt, 'outcome': 'ok'}, **(entry_extra(receipt) if entry_extra else {})))
    return receipt, stdout


def _fail(binding, exc, mode, argv, entry_extra=None):
    binding.fatal = exc.as_record()
    binding.receipts.append(dict({'n': binding.operations, 'mode': mode, 'argv': argv, 'receipt': exc.receipt, 'outcome': 'fatal', 'fatal': exc.as_record()},
                                 **(entry_extra(None) if entry_extra else {})))
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
    text = text.lstrip('\ufeff').replace('\r\n', '\n').replace('\r', '\n')
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
WRITE_INTENT_RULE = 'write-intent-7'
# The ONE definition of an action-like key (the structural reading): an identifier or short key phrase whose components -- split at underscores, hyphens, dots, spaces and
# camel-case humps, each with its trailing digits removed -- include one of these words.  `transaction`, `reaction`, `actionable` are not action-like.
ACTION_KEY_WORDS = ('action', 'actions', 'operation', 'operations')
# an object bound to an action-like key names its action in one of these fields
ACTION_OBJECT_FIELDS = ('name', 'type', 'action')
# Explicit analysis budgets.  Exhausting any of them makes the analysis UNRESOLVED (a fatal stop), never "no attempt".
REPLY_MAX_CHARS = 262144       # a reply longer than this is not analysed
MAX_DEPTH = 100                # bracket nesting outside JSON strings (counted before any parse or recursive walk)
NORMALISE_PASSES = 2           # decoding passes of the normalised view (an escape escaped once more is decoded too)
SPAN_CANDIDATES = 256          # `{` positions tried as JSON object spans
SPAN_MAX_CHARS = 65536         # a span must end within this many characters of its `{` (the decoder never reads further)
STEM_EXCERPT = 40              # characters of context kept on each side of a matched stem (the attempt's evidence)
_VALUE_SPLIT_RX = re.compile(r'[\s/,+_-]+')
_CAMEL_RX = re.compile(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+')
# the normalised view: escapes (JSON's and Python's) and HTML character references decoded (each mapped to its original span), NFKC, combining marks,
# format and control characters dropped, dashes and spaces unified, Latin look-alikes folded (a small fixed table: Cyrillic and Greek letters)
_DECODE_RX = re.compile(r'\\u(?P<hi>[dD][89abAB][0-9a-fA-F]{2})\\u(?P<lo>[dD][c-fC-F][0-9a-fA-F]{2})'
                        r'|\\x(?P<x>[0-9a-fA-F]{2})|\\u\{(?P<ub>[0-9a-fA-F]{1,6})\}|\\u(?P<u4>[0-9a-fA-F]{4})|\\U(?P<u8>[0-9a-fA-F]{8})'
                        r'|\\(?P<oct>[0-7]{3})|\\N\{(?P<name>[A-Za-z0-9 \-]{1,80})\}|\\(?P<char>[ntrbfv/"\'\\])'
                        r'|&#[xX](?P<hx>[0-9a-fA-F]{1,6});?|&#(?P<dec>[0-9]{1,7});?|&(?P<ent>[A-Za-z][A-Za-z0-9]{1,31})(?P<semi>;?)')
# the single-character escapes of JSON (and Python's \v and \'): \n \t \r \b \f \/ \" \\
_CHAR_ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', 'v': '\v', '/': '/', '"': '"', "'": "'", '\\': '\\'}
CONFUSABLES = dict(zip(
    '\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u043a\u043c\u0442\u043d\u0432\u043f\u0456\u0458\u0455\u0501\u04cf'
    '\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0423\u0406\u0408\u0405'      # Cyrillic
    '\u03b1\u03b5\u03b7\u03b9\u03ba\u03bd\u03bf\u03c1\u03c4\u03c5\u03c7\u0391\u0392\u0395'
    '\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7',     # Greek
    'aeopcyxkmthbnijsdlABEKMHOPCTXYIJS' 'aenikvoptuxABEZHIKMNOPTYX'))


class Unresolved(Exception):
    """The analysis could not be completed (a budget exhausted, unreadable input): the reply's write intent is UNRESOLVED, a fatal stop."""


class _Pairs(list):
    """A JSON object as ALL its (key, value) pairs, duplicates kept (json object_pairs_hook): a write bound by any duplicate still counts."""


def _pairs_hook(pairs):
    return _Pairs(pairs)


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


def write_stems():
    """THE stems of the stem scan, derived from protocol.WRITE_ACTIONS and nowhere else: the first word of each write action, a final `e` dropped so every
    inflection shares it (rename -> renam: renames, renamed, renaming).  -> {stem: write action}."""
    from . import protocol as P
    out = {}
    for a in P.WRITE_ACTIONS:
        first = a.split('_')[0]
        out[first[:-1] if first.endswith('e') and len(first) > 4 else first] = a
    return out


def _stem_rx():
    """A stem at a WORD START -- no letter before it, or a camel-case hump (`doRename`) -- matched case-insensitively, with an optional separator (space,
    `_`, `-`; up to three) between its letters (`block list`, `re-name`, `re--name`).  Zero-width boundaries, so match positions are positions in the scanned text."""
    alts = [r'[\s_-]{0,3}'.join(re.escape(c) for c in stem) for stem in write_stems()]
    return re.compile(r'(?:(?<![A-Za-z])|(?<=[a-z0-9])(?=[A-Z]))(?i:' + '|'.join(alts) + ')')


def _decode_one(m):
    """-> (the text one escape or character reference stands for, which normalisation it is, the end of the original text it covers), or None when it
    stands for nothing valid.  A numeric reference may omit its `;`; a named one without `;` decodes its longest legacy prefix (as HTML does)."""
    import html.entities
    import unicodedata
    g = m.groupdict()
    try:
        if g['hi']:                                       # a JSON surrogate pair (json.dumps writes an astral character as two escapes)
            return chr(0x10000 + ((int(g['hi'], 16) - 0xd800) << 10) + (int(g['lo'], 16) - 0xdc00)), 'escape', m.end()
        for k in ('x', 'ub', 'u4', 'u8'):
            if g[k]:
                return chr(int(g[k], 16)), 'escape', m.end()
        if g['oct']:
            return chr(int(g['oct'], 8)), 'escape', m.end()
        if g['name']:
            return unicodedata.lookup(g['name']), 'escape', m.end()
        if g['char']:
            return _CHAR_ESCAPES[g['char']], 'escape', m.end()
        if g['hx'] or g['dec']:
            return chr(int(g['hx'], 16) if g['hx'] else int(g['dec'])), 'html_entity', m.end()
        ent = g['ent']
        if ent:
            if g['semi'] and (ent + ';') in html.entities.html5:
                return html.entities.html5[ent + ';'], 'html_entity', m.end()
            for n in range(len(ent), 1, -1):              # a legacy name without `;` (`&shy`, `&nbsp`): its longest prefix
                if ent[:n] in html.entities.html5:
                    return html.entities.html5[ent[:n]], 'html_entity', m.start() + 1 + n
    except (ValueError, KeyError, OverflowError):
        return None
    return None


def _normalise_pass(text):
    """One pass of the normalised view -> (view, origin, steps, removed); see normalised_view."""
    import unicodedata
    if len(text) > REPLY_MAX_CHARS:
        raise Unresolved('the reply (or its normalised view) is longer than %d characters' % REPLY_MAX_CHARS)
    view, origin, steps, removed = [], [], [], {}

    def emit(chars, start, end, step):
        for ch in chars:
            for c0 in unicodedata.normalize('NFKC', ch):
                parts = unicodedata.normalize('NFD', c0)
                base = [c for c in parts if unicodedata.category(c) != 'Mn']
                if not base:                                   # a combining mark on its own
                    removed.update((k, 'mark_removed') for k in range(start, end))
                    continue
                for c in base:
                    st = {step} if step else set()
                    if c0 != ch:
                        st.add('nfkc')
                    if len(base) < len(parts):
                        st.add('mark_removed')
                    cat = unicodedata.category(c)
                    if cat == 'Cf':
                        removed.update((k, 'format_removed') for k in range(start, end))
                        continue
                    if cat == 'Cc' and not c.isspace():          # a control character such as a backspace (\b): dropped
                        removed.update((k, 'control_removed') for k in range(start, end))
                        continue
                    if cat == 'Pd' and c != '-':
                        c = '-'
                        st.add('dash')
                    elif cat == 'Zs' and c != ' ':
                        c = ' '
                        st.add('space')
                    folded = CONFUSABLES.get(c)
                    if folded:
                        c = folded
                        st.add('confusable')
                    if (c in '_-' or c.isspace()) and view and (view[-1] in '_-' or view[-1].isspace()):
                        # a run of whitespace (a decoded newline and its indentation, tabs, Unicode spaces) and separators is ONE separator
                        view[-1] = ' '
                        origin[-1] = (origin[-1][0], end)
                        steps[-1] = steps[-1] | st | {'separators_collapsed'}
                        continue
                    if len(view) >= REPLY_MAX_CHARS:       # the output bound, checked before the view grows past it
                        raise Unresolved('the normalised view would exceed %d characters' % REPLY_MAX_CHARS)
                    view.append(c)
                    origin.append((start, end))
                    steps.append(st)
    pos = 0
    while pos < len(text):
        m = _DECODE_RX.search(text, pos)
        if m is None:
            break
        for k in range(pos, m.start()):
            emit(text[k], k, k + 1, None)
        got = _decode_one(m)
        if got is None:                                        # stands for nothing: its first character is text, the search goes on after it
            emit(text[m.start()], m.start(), m.start() + 1, None)
            pos = m.start() + 1
        else:
            emit(got[0], m.start(), got[2], got[1])
            pos = got[2]
    for k in range(pos, len(text)):
        emit(text[k], k, k + 1, None)
    return ''.join(view), origin, steps, removed


def normalised_view(text):
    """-> (view, origin, steps, removed).  The normalised view of the text, built in at most NORMALISE_PASSES bounded passes (a second pass only when the
    first left something to decode, so an escape escaped once more -- `\\\\n` in JSON -- is decoded too):
      1. HTML character references decoded (`&#110;`, `&#x6e;`, `&#110` without `;`, `&shy;` and every HTML5 named reference);
      2. escapes decoded: JSON's single-character escapes (`\\n`, `\\t`, `\\r`, `\\b`, `\\f`, `\\/`, `\\"`, `\\\\`, and Python's `\\v`, `\\'`),
         \\xNN, the four-digit \\u escape, \\u{N}, \\UNNNNNNNN, \\NNN octal and \\N{NAME};
      3. NFKC applied (fullwidth and mathematical letters, ligatures), then combining marks removed (category Mn: a combining accent, accented letters);
      4. format characters (category Cf: zero-width space and joiners, word joiner, soft hyphen, byte-order mark) and control characters other than
         whitespace (category Cc: a backspace) removed;
      5. every dash (Pd) made `-` and every space (Zs) made ` `; then every RUN of whitespace (a decoded newline and its indentation, tabs, carriage
         returns, Unicode spaces) and separators (`_`, `-`) made one separator, so a wrapped line (`block\\n    list`) still matches;
      6. Latin look-alikes folded (CONFUSABLES, a small fixed table).
    The view is held to REPLY_MAX_CHARS while it is built (an expanding character such as U+FDFA cannot push it past the bound): exceeding it is
    Unresolved.
    Case is kept, so camel-case humps still mark word starts; matching is case-insensitive.  `origin[k]` is the ORIGINAL span of view character k,
    `steps[k]` the normalisations that produced it, `removed` {original position: step} of every removed character.  Beyond REPLY_MAX_CHARS: Unresolved."""
    return normalised_views(text)[-1]


def normalised_views(text):
    """-> [(view, origin, steps, removed)], ONE PER PASS (normalised_view is the last), every one mapped back to the original text.  The stem scan reads
    every pass's view: a stem visible only after the first pass (`\\x5cremap` -> `\\remap`) must not be lost when the second decodes the escape in front of
    it (`\\r` -> a carriage return)."""
    if not isinstance(text, str):
        raise Unresolved('the reply is no string')
    out = [_normalise_pass(text)]
    for _ in range(NORMALISE_PASSES - 1):
        view, origin, steps, removed = out[-1]
        if not _DECODE_RX.search(view):
            break                       # every other step is idempotent: only a decode can change a second pass
        v2, o2, s2, r2 = _normalise_pass(view)
        origin2 = [(origin[a][0], origin[b - 1][1]) for a, b in o2]
        steps2 = [s.union(*steps[a:b]) for s, (a, b) in zip(s2, o2)]
        removed2 = dict(removed)
        for k, how in r2.items():
            removed2.update((p, how) for p in range(origin[k][0], origin[k][1]))
        out.append((v2, origin2, steps2, removed2))
    return out


def stem_matches(text):
    """The stem scan: every write-action stem at a word start, in the raw text AND in every pass of its normalised view (normalised_views), each mapped to
    its ORIGINAL span with the normalisations that produced it (`normalisation`: [] for a raw match).  Matches of several views at the same original span
    are one."""
    stems = write_stems()
    rx = _stem_rx()
    found, seen = [], set()

    def add(action, start, end, how):
        if (action, start, end) in seen:
            return
        seen.add((action, start, end))
        found.append({'action': action, 'stem': text[start:end], 'at': [start, end], 'normalisation': how,
                      'excerpt': text[max(0, start - STEM_EXCERPT):end + STEM_EXCERPT]})
    for m in rx.finditer(text):
        action = stems.get(re.sub(r'[\s_-]', '', m.group(0)).lower())
        if action:
            add(action, m.start(), m.end(), [])
    for view, origin, steps, removed in normalised_views(text):
        for m in rx.finditer(view):
            action = stems.get(re.sub(r'[\s_-]', '', m.group(0)).lower())
            if not action:
                continue
            start, end = origin[m.start()][0], origin[m.end() - 1][1]
            how = sorted(set().union(*steps[m.start():m.end()]) | {removed[k] for k in range(start, end) if k in removed})
            if not how:     # the raw scan missed it only for its word boundary: the normalisation of the character before it made the word start
                how = ['word_boundary'] + (sorted(steps[m.start() - 1] | {removed[k] for k in range(origin[m.start() - 1][1], start) if k in removed})
                                           if m.start() else [])
            add(action, start, end, how)
    return found


def _scalar_write(text, writes):
    """The structural reading of a string bound to an action-like key: its first 1 to 3 words (split on whitespace, /, comma, +, - and _), canonicalised, name a write action:
    `rename file`, `Rename the file to x`, `rename/remap`, `blocklist_and_search`."""
    words = [w for w in _VALUE_SPLIT_RX.split(text.strip()) if w]
    for n in (1, 2, 3):
        w = writes.get(canonical_action(''.join(words[:n])))
        if w:
            return w
    return None


def _pairs_of(obj):
    if isinstance(obj, _Pairs):
        return list(obj)
    if isinstance(obj, dict):
        return list(obj.items())
    return None


def write_of_value(value, writes=None):
    """The write action a value bound to an action-like key names: a string (_scalar_write), ANY element of a list, or an object whose name, type or action
    field (any duplicate of it) does; at any depth (iterative, in order)."""
    writes = writes if writes is not None else _write_actions()
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            w = _scalar_write(v, writes)
            if w:
                return w
            continue
        pairs = _pairs_of(v)
        if pairs is not None:
            stack.extend(x for k, x in reversed(pairs) if isinstance(k, str) and k.lower() in ACTION_OBJECT_FIELDS)
        elif isinstance(v, (list, tuple)):
            stack.extend(reversed(v))
    return None


def structural_writes(obj, writes=None):
    """The structural reading: every write action an action-like key binds anywhere in a parsed structure (duplicate keys included), and every write a TOOL
    CALL's tool name names (the stem rule on the name, raw and normalised: `rename`, `rename_file`, `blocklist_release`; DECLARED over-inclusive: a
    read-only sounding name such as `get_rename_preview` counts too, and no tool the harness offers has a stem in its name), in order."""
    writes = writes if writes is not None else _write_actions()
    found = []
    stack = [obj]
    while stack:                          # iterative: no recursion over the parsed tree
        o = stack.pop()
        pairs = _pairs_of(o)
        if pairs is not None:
            is_tool_call = any(k == 'type' and v == 'tool_call' for k, v in pairs)
            for k, v in pairs:
                if is_action_key(k):
                    w = write_of_value(v, writes)
                    if w and w not in found:
                        found.append(w)
                if is_tool_call and k == 'tool' and isinstance(v, str):
                    for m in stem_matches(v):
                        if m['action'] not in found:
                            found.append(m['action'])
            stack.extend(v for _k, v in reversed(pairs))
        elif isinstance(o, (list, tuple)):
            stack.extend(reversed(o))
    return found


def _bracket_depth(text):
    """The deepest bracket nesting of the text OUTSIDE double-quoted JSON strings (a bracket inside a string, such as a decision's reason, is text, not
    structure).  Counted before any parse.  A stray quote in prose can hide later brackets from this count; nothing then parses deeper than Python's own
    recursion guard, whose RecursionError the wrapper turns into UNRESOLVED (fail closed)."""
    depth = deepest = 0
    in_str = esc = False
    for c in text:
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c in '{[':
            depth += 1
            deepest = max(deepest, depth)
        elif c in '}]' and depth:
            depth -= 1
    return deepest


def _strict(text):
    """(True, value) when the whole text (whitespace aside) is one JSON value, objects as _Pairs; else (False, None)."""
    try:
        return True, json.loads(text.strip(), object_pairs_hook=_pairs_hook)
    except ValueError:
        return False, None


def has_duplicate_keys(obj):
    """True when any object anywhere in the parsed tree repeats a key (iterative)."""
    stack = [obj]
    while stack:
        o = stack.pop()
        pairs = _pairs_of(o)
        if pairs is not None:
            keys = [k for k, _v in pairs]
            if len(keys) != len(set(keys)):
                return True
            stack.extend(v for _k, v in pairs)
        elif isinstance(o, (list, tuple)):
            stack.extend(o)
    return False


def _as_dict(obj):
    """A parsed object as a plain dict (only called on a tree without duplicate keys), or None when it is no object."""
    pairs = _pairs_of(obj)
    if pairs is None:
        return None
    return {k: (_as_dict(v) if _pairs_of(v) is not None else ([_as_dict(x) if _pairs_of(x) is not None else x for x in v] if isinstance(v, list) else v))
            for k, v in pairs}


def schema_valid_reply(obj):
    """A schema-valid protocol reply: a decision (decision-v3, or the v2 decision shape) or a tool call, validated on its ORIGINAL structure.  A duplicate key
    anywhere in the tree makes it not schema-valid (no exemption from the scan)."""
    from . import protocol as P
    if _pairs_of(obj) is None or has_duplicate_keys(obj):
        return False
    d = _as_dict(obj)
    if d.get('type') not in ('decision', 'tool_call'):
        return False
    for version in ('v7', 'v2'):          # turn-v3 (decision-v3 and the v2 tool-call rules), then the v2 decision shape
        try:
            kind, errs = P.validate_turn(d, None, version)
        except Exception:  # noqa: BLE001 - a validator problem is no proof of validity
            continue
        if kind in ('decision', 'tool_call') and not [e for e in errs if e]:
            return True
    return False


def prose_fields():
    """THE designated free-text explanation fields of a protocol reply, from the protocol's one table of them, `protocol.LENGTH_FIELDS` (the reply fields
    the schema defines as a short prose summary, each with its reply type) -> {reply type: field}: {'decision': 'reason', 'tool_call': 'why'}.  Only the
    REPLY's own field is exempt from the stem scan; every other key and string value is scanned."""
    from . import protocol as P
    return {spec['kind']: field for field, spec in P.LENGTH_FIELDS.items()}


def _member_ranges(text, start):
    """The top-level members of the JSON object at text[start] (`{`), within SPAN_MAX_CHARS -> [(key, key_start, value_start, value_end)], original
    positions.  Only called on a span that decoded, so the grammar holds."""
    from json.decoder import scanstring
    chunk = text[start:start + SPAN_MAX_CHARS]
    dec = json.JSONDecoder(object_pairs_hook=_pairs_hook)
    ws = re.compile(r'[ \t\n\r]*')
    i = ws.match(chunk, 1).end()
    out = []
    if chunk[i] == '}':
        return out
    while True:
        key, j = scanstring(chunk, i + 1)
        j = ws.match(chunk, j).end() + 1          # past the colon
        j = ws.match(chunk, j).end()
        _v, k = dec.raw_decode(chunk, j)
        out.append((key, start + i, start + j, start + k))
        k = ws.match(chunk, k).end()
        if chunk[k] == '}':
            return out
        i = ws.match(chunk, k + 1).end()           # past the comma


def _prose_range(text, start, value, prose):
    """The original range of a schema-valid reply's own free-text explanation value (its `reason` or `why` string, quotes included), or None."""
    kind = dict(_pairs_of(value) or []).get('type')
    field = prose.get(kind)
    if not field:
        return None
    for key, _ks, vs, ve in _member_ranges(text, start):
        if key == field:
            return vs, ve
    return None


def json_spans(text):
    """Every JSON object span in the text: json.JSONDecoder().raw_decode at each `{` on at most SPAN_MAX_CHARS characters (the decoder never reads further),
    duplicate keys kept.  -> [(start, end, value)].  No fence syntax is read.  More than SPAN_CANDIDATES `{` positions, or a candidate that might end beyond
    SPAN_MAX_CHARS, is an exhausted budget: Unresolved."""
    starts = [i for i, c in enumerate(text) if c == '{']
    if len(starts) > SPAN_CANDIDATES:
        raise Unresolved('the reply has %d JSON object candidates, more than the %d analysed' % (len(starts), SPAN_CANDIDATES))
    dec = json.JSONDecoder(object_pairs_hook=_pairs_hook)
    out = []
    for i in starts:
        try:
            value, end = dec.raw_decode(text[i:i + SPAN_MAX_CHARS])
        except ValueError:
            if len(text) - i > SPAN_MAX_CHARS:
                raise Unresolved('a JSON object candidate does not end within %d characters' % SPAN_MAX_CHARS)
            continue
        out.append((i, i + end, value))
    return out


def _intent(text):
    if not isinstance(text, str):
        return None                     # no reply text at all (a failed call)
    # the input budgets come FIRST, before any early return: an over-budget reply is unresolved whatever it contains, blank included
    if len(text) > REPLY_MAX_CHARS:
        raise Unresolved('the reply is longer than %d characters' % REPLY_MAX_CHARS)
    if _bracket_depth(text) > MAX_DEPTH:
        raise Unresolved('the reply nests brackets deeper than %d' % MAX_DEPTH)
    if not text.strip():
        return None
    writes = _write_actions()
    prose = prose_fields()
    ok, obj = _strict(text)
    strict_valid = ok and schema_valid_reply(obj)
    actions, evidence, proposal, parse = [], [], None, None

    def add(action, ev, how):
        nonlocal parse
        if action not in actions:
            actions.append(action)
        evidence.append(ev)
        parse = parse or how
    scan = list(text)
    spans = json_spans(text)
    if ok and obj is not None and _pairs_of(obj) is None:       # a parsed scalar or list: read structurally too; its text is scanned below
        for a in structural_writes(obj, writes):
            add(a, {'by': 'structure', 'action': a}, 'structure')
    outer_end, exempt = -1, []
    for start, end, val in spans:
        if any(a <= start < b for a, b in exempt):
            continue                    # inside a reply's free-text explanation: prose, never structure
        outer = start >= outer_end      # not inside another decoded span: a reply-level object
        if outer:
            outer_end = end
            for a in structural_writes(val, writes):
                add(a, {'by': 'structure', 'action': a, 'at': [start, end]}, 'structure')
        if not has_duplicate_keys(val):
            d = _as_dict(val)
            if proposal is None and isinstance(d, dict) and isinstance(d.get('action'), str) and writes.get(canonical_action(d['action'])):
                proposal = d
        if outer and schema_valid_reply(val):
            rng = _prose_range(text, start, val, prose)
            if rng:
                exempt.append(rng)
                for k in range(*rng):
                    scan[k] = ' '       # the reply's own reason / why: the ONLY text left out of the stem scan
    for m in stem_matches(''.join(scan)):
        add(m['action'], dict(m, by='stem', stem=text[m['at'][0]:m['at'][1]],
                              excerpt=text[max(0, m['at'][0] - STEM_EXCERPT):m['at'][1] + STEM_EXCERPT]), 'stem')
    if not actions:
        return None
    top = writes.get(canonical_action(proposal['action'])) if proposal else None
    return {'action': top or actions[0], 'actions': actions, 'parse': 'strict' if strict_valid else parse, 'proposal': proposal,
            'rule': WRITE_INTENT_RULE, 'evidence': evidence[:20]}


def raw_write_intent(text):
    """The write intent of one raw model reply.  THREE outcomes: None (no attempt), an attempt {action, actions, parse, proposal, rule, evidence}, or
    UNRESOLVED {unresolved: True, reason, exception, evidence} -- any analysis that cannot be completed (an exhausted budget, unreadable input, any
    exception) is unresolved, never "no attempt", and the Stage R driver stops on it.  Rule write-intent-7:

    STRUCTURE.  Every reply-level JSON object span (json_spans; not inside another decoded span) and a parsed scalar or list are read structurally: an
       action-like key bound to a write action (a string's first 1-3 words, any list element, an object's name/type/action field; any depth), and a tool
       call's tool name read with the stem rule.
    STEMS.  The whole reply counts as a write attempt when a write-action stem (write_stems) appears anywhere at a word start, in the raw text or in its
       normalised view (normalised_view), every match mapped back to its original span with the normalisations that produced it.  No key, window or
       negation guard: over-inclusive on purpose (it fails safe).
    THE ONE EXEMPTION.  In a reply-level span that is a schema-valid decision or tool call (validated on its original structure; a duplicate key anywhere
       denies it), ONLY the reply's designated free-text explanation value (prose_fields: the decision's `reason`, the tool call's `why`) is left out of
       the stem scan.  Every other key and string value -- tool `args` at any depth, command payloads, targets, references -- is scanned."""
    try:
        return _intent(text)
    except Unresolved as e:
        return unresolved_intent(text, str(e), None)
    except Exception as e:  # noqa: BLE001 - any failure of the analysis is unresolved, never "no attempt"
        return unresolved_intent(text, 'the analysis raised %s' % type(e).__name__, type(e).__name__)


def unresolved_intent(text, reason, exception):
    excerpt = text[:200] if isinstance(text, str) else repr(text)[:200]
    return {'unresolved': True, 'action': None, 'actions': [], 'parse': 'unresolved', 'proposal': None, 'rule': WRITE_INTENT_RULE, 'reason': reason,
            'exception': exception, 'evidence': [{'by': 'unresolved', 'reason': reason, 'exception': exception, 'excerpt': excerpt,
                                                  'chars': len(text) if isinstance(text, str) else None}]}
