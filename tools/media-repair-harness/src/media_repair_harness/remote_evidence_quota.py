"""#160's standalone trusted quota contract for ``mrh-sampler-3``.

This deliberately does not amend ``remote_evidence`` or an existing tools
behaviour.  A future bounded caller supplies the expected quota before an
operation begins, adds :func:`sampler_options` to that operation's argv, and
validates its terminal receipt with :func:`receipt_errors`.  The receipt is
evidence of what ran, never authority to select a larger limit.
"""
import json
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


class InputQuotaError(ValueError):
    """The trusted caller did not supply the one permitted quota value."""


class SamplerOperationError(RuntimeError):
    """The sampler did not produce a receipt that satisfies the caller's contract."""


def expected_input_quota_bytes(value=DEFAULT_INPUT_QUOTA_BYTES):
    """Validate caller configuration before a sampler can be invoked.

    Only the legacy 8 MiB default and the explicit 16 MiB opt-in are valid.
    In particular, a value returned by a receipt must not be passed here as
    the expected value: it is checked *against* this caller-owned value.
    """
    if type(value) is not int or value not in ALLOWED_INPUT_QUOTA_BYTES:
        raise InputQuotaError('input quota must be exactly 8388608 or 16777216 bytes')
    return value


def sampler_options(expected_quota_bytes=DEFAULT_INPUT_QUOTA_BYTES):
    """The only quota option a trusted caller may append to one operation."""
    return ('--input-quota-bytes', expected_input_quota_bytes(expected_quota_bytes))


def receipt_errors(receipt, mode, stdout_len, expected_quota_bytes=DEFAULT_INPUT_QUOTA_BYTES):
    """Return receipt errors for the independently declared input quota.

    This quota-specific validator intentionally validates the independently
    trusted bound, aggregate byte count and terminal marker.  Callers retain
    their existing identity/confinement receipt validation alongside it; this
    module never weakens or changes that v2 contract.
    """
    expected = expected_input_quota_bytes(expected_quota_bytes)
    if not isinstance(receipt, dict):
        return ['the receipt is not an object']
    errors = []
    if receipt.get('receipt') != RECEIPT:
        errors.append('the receipt is not an %s receipt' % RECEIPT)
    if receipt.get('mode') != mode:
        errors.append('mode %r, expected %r' % (receipt.get('mode'), mode))
    if receipt.get('input_quota_bytes') != expected:
        errors.append('input_quota_bytes %r does not equal the trusted expected quota %d' %
                      (receipt.get('input_quota_bytes'), expected))
    if type(receipt.get('stdout_bytes')) is not int or receipt['stdout_bytes'] != stdout_len:
        errors.append('stdout_bytes does not match the bytes received')
    bytes_read = receipt.get('bytes_read')
    cap = STAT_BYTES_MAX if mode == 'stat' else (0 if mode == 'list' else expected)
    if type(bytes_read) is not int or not 0 <= bytes_read <= cap:
        errors.append('bytes_read is malformed or exceeds the trusted quota for %s' % mode)
    exhausted = receipt.get('quota_exhausted')
    if type(exhausted) is not bool:
        errors.append('quota_exhausted must be a boolean')
    elif exhausted and bytes_read != expected:
        errors.append('quota_exhausted without exactly the trusted quota read')
    return errors


def _parse_receipt(stderr):
    lines = [line for line in stderr.decode('utf-8', errors='replace').splitlines() if line.strip()]
    if not lines:
        raise SamplerOperationError('no terminal receipt')
    try:
        return json.loads(lines[-1])
    except ValueError as exc:
        raise SamplerOperationError('the last stderr line is not a JSON receipt') from exc


def run_operation(runner, argv, mode, expected_quota_bytes=DEFAULT_INPUT_QUOTA_BYTES):
    """Run exactly one v3 sampler operation with caller-owned quota configuration.

    ``argv`` is a complete trusted exec argv ending in sampler arguments, but
    may not select its own quota. The expected value is validated before
    ``runner`` is called, then appended to the argv and checked against the
    terminal receipt. Thus neither an argv supplied by an untrusted layer nor
    the receipt can increase the source-read budget.
    """
    expected = expected_input_quota_bytes(expected_quota_bytes)
    if '--input-quota-bytes' in argv:
        raise InputQuotaError('the operation argv must not select its own input quota')
    operation_argv = [str(arg) for arg in argv] + [str(arg) for arg in sampler_options(expected)]
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
    errors = receipt_errors(receipt, mode, len(stdout), expected)
    if errors:
        raise SamplerOperationError('; '.join(errors))
    return receipt, stdout
