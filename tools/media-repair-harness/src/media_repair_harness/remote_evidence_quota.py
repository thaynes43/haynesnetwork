"""#160's standalone trusted quota and receipt contract for ``mrh-sampler-3``.

This is deliberately separate from ``remote_evidence`` and every existing
sampler behaviour. The caller supplies the source identity, host and root it
already trusts. This module appends that binding plus the one permitted quota
to an otherwise complete argv, then accepts only a successful, fully bound v3
receipt. A receipt is evidence of what ran, never authority to select a larger
limit or a different source.
"""
import json
import math
import os
import re
import subprocess
from pathlib import Path

SAMPLER = Path(__file__).resolve().parent / 'remote_sampler_v3.py'
RECEIPT = 'mrh-sampler-3'
DEFAULT_INPUT_QUOTA_BYTES = 8 * 1024 * 1024
MAX_INPUT_QUOTA_BYTES = 16 * 1024 * 1024
ALLOWED_INPUT_QUOTA_BYTES = (DEFAULT_INPUT_QUOTA_BYTES, MAX_INPUT_QUOTA_BYTES)
STAT_BYTES_MAX = 2 * 1024 * 1024
FILE_MODES = ('stat', 'probe', 'chapters', 'decode', 'frame', 'audio', 'subtitle')
OUTER_DEADLINE_S = 60
SAMPLER_WALL_MAX = 30
I64 = 2 ** 63
IDENTITY_FIELDS = ('size', 'mtime_ns', 'dev', 'ino')
RECEIPT_KEYS = ('receipt', 'mode', 'hostname', 'exit_code', 'error', 'stdout_bytes', 'stderr', 'input_quota_bytes', 'bytes_read',
                'quota_exhausted', 'requests', 'wall_seconds', 'timed_out', 'source_unchanged', 'identity', 'argv', 'confined')
IDENTITY_KEYS = ('expected', 'start', 'end', 'start_ok', 'end_ok', 'same_file')
_HOST_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$')


class InputQuotaError(ValueError):
    """The caller contract is incomplete or selects an unpermitted quota."""


class SamplerOperationError(RuntimeError):
    """The sampler did not produce a receipt that satisfies the caller's contract."""


def _int_in(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def _num_in(value, lower, upper):
    return (_int_in(value, lower, upper) or
            (type(value) is float and math.isfinite(value) and lower <= value <= upper))


def _identity_errors(value, name, expected=None):
    if not isinstance(value, dict) or set(value) != set(IDENTITY_FIELDS):
        return ['identity.%s must be exactly {%s}' % (name, ', '.join(IDENTITY_FIELDS))]
    if not (_int_in(value['size'], 0, I64) and _int_in(value['mtime_ns'], -I64, I64)
            and _int_in(value['dev'], 0, 2 * I64) and _int_in(value['ino'], 0, 2 * I64)):
        return ['identity.%s values must be exact integers in range' % name]
    if expected is not None and value != expected:
        return ['identity.%s does not equal the trusted expected identity' % name]
    return []


def expected_input_quota_bytes(value=DEFAULT_INPUT_QUOTA_BYTES):
    """Validate caller configuration before a sampler can be invoked."""
    if type(value) is not int or value not in ALLOWED_INPUT_QUOTA_BYTES:
        raise InputQuotaError('input quota must be exactly 8388608 or 16777216 bytes')
    return value


def _binding_errors(mode, expected_identity, expected_hostname, allowed_root):
    errors = []
    if mode not in FILE_MODES:
        errors.append('mode must be one of the file modes')
    errors += _identity_errors(expected_identity, 'expected')
    if not (isinstance(expected_hostname, str) and _HOST_RX.fullmatch(expected_hostname)):
        errors.append('expected hostname is missing or malformed')
    if not (isinstance(allowed_root, str) and allowed_root.startswith('/') and allowed_root == os.path.normpath(allowed_root)
            and '\\0' not in allowed_root and '\\n' not in allowed_root):
        errors.append('allowed root is missing or not an absolute normalised path')
    return errors


def sampler_options(expected_quota_bytes=DEFAULT_INPUT_QUOTA_BYTES, expected_identity=None, allowed_root=None):
    """The binding options appended only after the caller contract is validated."""
    expected = expected_input_quota_bytes(expected_quota_bytes)
    identity_errors = _identity_errors(expected_identity, 'expected')
    if identity_errors:
        raise InputQuotaError('; '.join(identity_errors))
    if not (isinstance(allowed_root, str) and allowed_root.startswith('/')):
        raise InputQuotaError('allowed root is missing or malformed')
    return ('--root', allowed_root,
            '--expect-size', expected_identity['size'], '--expect-mtime-ns', expected_identity['mtime_ns'],
            '--expect-dev', expected_identity['dev'], '--expect-ino', expected_identity['ino'],
            '--input-quota-bytes', expected)


def receipt_errors(receipt, mode, stdout_len, expected_quota_bytes=DEFAULT_INPUT_QUOTA_BYTES, *, expected_identity=None,
                   expected_hostname=None, allowed_root=None):
    """Return all terminal-receipt violations of this independently trusted v3 contract."""
    expected_quota = expected_input_quota_bytes(expected_quota_bytes)
    errors = _binding_errors(mode, expected_identity, expected_hostname, allowed_root)
    if errors:
        return errors
    if not isinstance(receipt, dict):
        return ['the receipt is not an object']
    missing = [key for key in RECEIPT_KEYS if key not in receipt]
    if missing:
        return ['receipt fields missing: %s' % missing]
    if receipt['receipt'] != RECEIPT:
        errors.append('the receipt is not an %s receipt' % RECEIPT)
    if receipt['mode'] != mode:
        errors.append('mode %r, expected %r' % (receipt['mode'], mode))
    if receipt['hostname'] != expected_hostname:
        errors.append('hostname %r does not equal the trusted expected hostname' % receipt['hostname'])
    if receipt['exit_code'] != 0:
        errors.append('terminal exit_code must be 0')
    if receipt['error'] is not None:
        errors.append('a successful terminal receipt must not carry an error')
    if not _int_in(receipt['stdout_bytes'], 0, I64) or receipt['stdout_bytes'] != stdout_len:
        errors.append('stdout_bytes does not match the bytes received')
    if not isinstance(receipt['stderr'], str):
        errors.append('stderr is malformed')
    if receipt['input_quota_bytes'] != expected_quota:
        errors.append('input_quota_bytes does not equal the trusted expected quota')
    cap = STAT_BYTES_MAX if mode == 'stat' else expected_quota
    if not _int_in(receipt['bytes_read'], 0, cap):
        errors.append('bytes_read is malformed or exceeds the trusted quota')
    if not _int_in(receipt['requests'], 0, 10 ** 6):
        errors.append('requests is malformed')
    elif receipt['bytes_read'] and mode != 'stat' and receipt['requests'] < 1:
        errors.append('bytes were read without a range-server request')
    if type(receipt['quota_exhausted']) is not bool or receipt['quota_exhausted']:
        errors.append('quota_exhausted must be false for a completed bounded collection')
    if type(receipt['timed_out']) is not bool or receipt['timed_out']:
        errors.append('timed_out must be false for a completed bounded collection')
    if not _num_in(receipt['wall_seconds'], 0, SAMPLER_WALL_MAX):
        errors.append('wall_seconds is malformed or out of range')
    if not (isinstance(receipt['argv'], list) and all(isinstance(item, str) for item in receipt['argv'])):
        errors.append('argv is malformed')
    if receipt['confined'] is not True:
        errors.append('confined must be true under the trusted allowed root')
    if receipt['source_unchanged'] is not True:
        errors.append('source_unchanged must be true')
    identity = receipt['identity']
    if not isinstance(identity, dict) or set(identity) != set(IDENTITY_KEYS):
        return errors + ['identity block missing or malformed']
    for name in ('expected', 'start', 'end'):
        errors += _identity_errors(identity[name], name, expected_identity)
    for name in ('start_ok', 'end_ok', 'same_file'):
        if identity[name] is not True:
            errors.append('identity.%s must be true' % name)
    return errors


def _parse_receipt(stderr):
    lines = [line for line in stderr.decode('utf-8', errors='replace').splitlines() if line.strip()]
    if not lines:
        raise SamplerOperationError('no terminal receipt')
    try:
        return json.loads(lines[-1])
    except ValueError as exc:
        raise SamplerOperationError('the last stderr line is not a JSON receipt') from exc


def run_operation(runner, argv, mode, expected_quota_bytes=DEFAULT_INPUT_QUOTA_BYTES, *, expected_identity=None,
                  expected_hostname=None, allowed_root=None):
    """Run one v3 sampler operation after rejecting incomplete/untrusted bindings."""
    expected = expected_input_quota_bytes(expected_quota_bytes)
    errors = _binding_errors(mode, expected_identity, expected_hostname, allowed_root)
    if errors:
        raise InputQuotaError('; '.join(errors))
    if not isinstance(argv, (list, tuple)) or not all(isinstance(arg, str) for arg in argv):
        raise InputQuotaError('operation argv must be a sequence of strings')
    for index, arg in enumerate(argv):
        # The exec transport's fixed ``-- python3 -`` separator is not a
        # sampler option terminator. Any other ``--`` could consume the
        # trusted suffix as positionals and is refused before invocation.
        transport_separator = arg == '--' and tuple(argv[index:index + 3]) == ('--', 'python3', '-')
        if (arg == '--' and not transport_separator) or arg.startswith('--i'):
            raise InputQuotaError('the operation argv must not select or abbreviate an input quota')
    operation_argv = list(argv) + [str(arg) for arg in sampler_options(expected, expected_identity, allowed_root)]
    try:
        completed = runner(operation_argv, input=SAMPLER.read_bytes(), capture_output=True, timeout=OUTER_DEADLINE_S)
    except subprocess.TimeoutExpired as exc:
        raise SamplerOperationError('the 60 s outer deadline expired') from exc
    except Exception as exc:  # noqa: BLE001 - an exec error has no trustworthy receipt
        raise SamplerOperationError('sampler exec failed: %s' % type(exc).__name__) from exc
    if getattr(completed, 'returncode', None) != 0:
        raise SamplerOperationError('sampler exec exited %r' % getattr(completed, 'returncode', None))
    stdout = completed.stdout if isinstance(getattr(completed, 'stdout', None), bytes) else b''
    stderr = completed.stderr if isinstance(getattr(completed, 'stderr', None), bytes) else b''
    receipt = _parse_receipt(stderr)
    errors = receipt_errors(receipt, mode, len(stdout), expected, expected_identity=expected_identity,
                            expected_hostname=expected_hostname, allowed_root=allowed_root)
    if errors:
        raise SamplerOperationError('; '.join(errors))
    return receipt, stdout
