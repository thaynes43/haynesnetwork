"""claude-schema-1 (dev-c8, opt-in `--claude-schema json-schema-1`): the schema-mode Claude call, its stream-json parser and its timeout handling.

adapters.py imports this module only in schema mode (moved out of adapters.py in review round 3 to keep the wiring-smoke Job bundle under its ceiling).
See adapters.ClaudeAdapter and docs/dev-c8.md section 3.

FAIL-CLOSED BY STRUCTURE (review round 5): a DESIGN TARGET, NOT ESTABLISHED (review round 7: AUDIT-ASTRA-61 and the Opus review falsified it again;
the open findings are tracked in OpenProject #164, and --claude-schema is gated as experimental).  The target: in schema mode no input stream can make the run (a) lose the raw stream, (b) lose a budget or registration
stop reason, (c) continue to another case after a stop, (d) exit 0 while a call's cost is unknown, or (e) raise anything but an evidence-carrying
AdapterError or AbortRun.  The pipeline:
  1. decode_lines: every line on its own, behind a cheap pre-scan (size and nesting bounds) and a catch-all; an undecodable line is recorded as
     malformed and never discards another event or the raw stream;
  2. validate every field the parser keys on, adds up or stores: ids (a string or absent), counts and cost (finite, non-negative, bounded, checked
     before any arithmetic), strings (subtype, result text), model ids (normalised to one string);
  3. classify in a fixed order: a registration missing in ANY init event -> AbortRun; a cost that is absent or fails validation -> AbortRun (an
     unmetered call stops the run); malformed lines or fields, no completed response with a CLI error -> AdapterError (a validated budget subtype keeps
     its flag and its reason); else the first completed response;
  4. an outer guard (`complete`, `parse_claude_stream`): anything else raised while calling, parsing or validating becomes an AbortRun carrying the
     reason and the raw stream.  The legacy adapter (schema mode off) is untouched.
Review round 6 adds: the raw call output is kept losslessly as bytes before any parsing (base64 in the record, and a `.raw` file when the run gives a
sink); invalid UTF-8, lone surrogates and duplicate JSON keys are malformed; EVERY result receipt is reconciled (conflicts are malformed, any budget
subtype is a stop, the cost is the largest receipt); a budget stop always stops the run; a stop, once raised, is sticky (no further call starts); and an
unexpected failure keeps the primary classification (registration, budget, receipt) found by an independent defensive scan, the failure being attached
as `secondary_failure`.  The run-level half of the guarantee is in schema_run.py."""
import base64
import hashlib
import json
import math
import subprocess
import time

from .adapters import CLAUDE_SCHEMA_ADAPTER_VERSION, STRUCTURED_OUTPUT_TOOL, AbortRun, AdapterError, Completion, _sha256_text, render_transcript

MAX_LINE_CHARS = 1 << 20          # one stream line
MAX_DEPTH = 64                    # JSON nesting of one line
MAX_COUNT = 10 ** 9               # a token count
MAX_COST_USD = 10.0 ** 4          # one call's reported cost
BUDGET_SUBTYPE = 'error_max_budget_usd'
INVALID = object()


# ---------------------------------------------------------------------------------------------------------------------------- 1. guarded line decoding
def _prescan(line):
    """-> None when the line may be handed to json.loads, else why not: too long, or nested deeper than MAX_DEPTH (strings are skipped)."""
    if len(line) > MAX_LINE_CHARS:
        return 'line of %d characters is over the %d bound' % (len(line), MAX_LINE_CHARS)
    depth, in_str, esc = 0, False, False
    for ch in line:
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in '[{':
            depth += 1
            if depth > MAX_DEPTH:
                return 'nesting deeper than %d' % MAX_DEPTH
        elif ch in ']}':
            depth -= 1
    return None


def _pairs(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise _Duplicate(k)
        out[k] = v
    return out


class _Duplicate(ValueError):
    pass


def decode_lines(raw):
    """-> (events, malformed): the JSON-object lines, and one note per line that is malformed (with its line number).  A line that cannot be decoded is
    dropped; a line with a duplicate key or a lone surrogate (a string that cannot be written as UTF-8) is malformed but its event is KEPT, so a receipt
    or a stop signal on it still counts (round 6)."""
    events, malformed, _dups = decode_lines_ex(raw)
    return events, malformed


def decode_lines_ex(raw):
    """decode_lines plus the ids of the events that had a duplicate key (their receipt values are ambiguous: json keeps only the last one)."""
    events, malformed, dups = [], [], set()
    for n, line in enumerate((raw or '').splitlines()):
        if not line.strip():
            continue
        try:
            why = _prescan(line)
            if why is None:
                try:
                    ev = json.loads(line, object_pairs_hook=_pairs)
                    dup = None
                except _Duplicate as d:
                    ev, dup = json.loads(line), 'duplicate key %r' % (d.args[0] if d.args else '')
                if isinstance(ev, dict):
                    events.append(ev)
                    if dup:
                        dups.add(id(ev))
                    try:
                        json.dumps(ev, ensure_ascii=False).encode('utf-8')
                    except UnicodeEncodeError:
                        dup = (dup + '; ' if dup else '') + 'a string holds a lone surrogate'
                    if dup:
                        malformed.append('line %d: %s' % (n + 1, dup))
                    continue
                why = 'not a JSON object'
        except Exception as e:  # noqa: BLE001 - one bad line never discards the others
            why = 'not JSON (%s)' % type(e).__name__
        malformed.append('line %d: %s' % (n + 1, why))
    return events, malformed, dups


# ---------------------------------------------------------------------------------------------------------------------------- 2. field validation
def _count(x):
    if x is None:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return INVALID
    if isinstance(x, float) and not math.isfinite(x):
        return INVALID
    return x if 0 <= x <= MAX_COUNT else INVALID


def _cost(x):
    if x is None:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return INVALID
    if isinstance(x, int) and abs(x) > MAX_COST_USD:          # an oversized integer is refused before any float conversion
        return INVALID
    x = float(x)
    return x if math.isfinite(x) and 0.0 <= x <= MAX_COST_USD else INVALID


def check_result(ev):
    """-> a validated view of a result event: {'subtype', 'is_error', 'usage', 'cost', 'text', 'models', 'structured_output', 'problems'}.  `cost` is a
    float, None (absent) or INVALID; a wrong-typed field is a problem and is dropped, never stored."""
    problems = []
    subtype = ev.get('subtype', 'success')
    if not isinstance(subtype, str):
        problems.append('subtype is not a string')
        subtype = 'malformed_subtype'
    u = ev.get('usage')
    if u is not None and not isinstance(u, dict):
        problems.append('usage is not an object')
        u = None
    usage = {}
    for k in ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'):
        v = _count((u or {}).get(k))
        if v is INVALID:
            problems.append('usage.%s is not a valid count' % k)
            v = None
        usage[k] = v
    cost = _cost(ev.get('total_cost_usd'))
    if cost is INVALID:
        problems.append('total_cost_usd is not a finite, non-negative, bounded number')
    text = ev.get('result')
    if text is not None and not isinstance(text, str):
        problems.append('result is not a string')
        text = None
    mu = ev.get('modelUsage')
    if mu is not None and not isinstance(mu, dict):
        problems.append('modelUsage is not an object')
        mu = None
    models = sorted(k for k in (mu or {}) if isinstance(k, str))
    return {'subtype': subtype, 'is_error': ev.get('is_error') is True, 'usage': usage, 'cost': cost, 'text': text, 'models': models, 'model_usage': mu,
            'has_structured_output': 'structured_output' in ev, 'structured_output': ev.get('structured_output'), 'problems': problems}


def reconcile(views):
    """Every result receipt of one call, reconciled (round 6): a budget subtype on ANY receipt is a budget stop; receipts that disagree (cost, subtype)
    are malformed; the cost is the largest valid receipt (a result event reports the call's running total, so the largest is the conservative bound;
    summing would double count one call), INVALID if any receipt's cost is invalid; token counts are the largest per field; text and models come from
    the last receipt.  -> one view in check_result's shape plus 'budget', or None without a receipt."""
    if not views:
        return None
    last = dict(views[-1])
    problems = [p for v in views for p in v['problems']]
    costs = [v['cost'] for v in views]
    if len(views) > 1:
        if len({v['subtype'] for v in views}) > 1 or len({repr(c) for c in costs}) > 1:
            problems.append('%d result receipts disagree (cost or subtype)' % len(views))
    valid = [c for c in costs if isinstance(c, float)]
    last['cost'] = INVALID if any(c is INVALID for c in costs) else max(valid, default=None)
    last['cost_known_max'] = max(valid, default=None)        # accounted even when another receipt is invalid (the call still stops as unmetered)
    last['usage'] = {k: max((v['usage'][k] for v in views if v['usage'][k] is not None), default=None) for k in last['usage']}
    last['budget'] = any(v['subtype'] == BUDGET_SUBTYPE for v in views)
    if last['budget']:
        last['subtype'] = BUDGET_SUBTYPE
    last['is_error'] = any(v['is_error'] for v in views)
    last['problems'] = problems
    last['receipts'] = len(views)
    return last


def _requested_model(req):
    argv = (req or {}).get('argv') or []
    return argv[argv.index('--model') + 1] if '--model' in argv and argv.index('--model') + 1 < len(argv) else None


def _response_model(models, req):
    """One string, as every record serializer expects: the requested model when the CLI reports it, the only reported model, or the sorted ids joined."""
    want = _requested_model(req)
    if want in models:
        return want
    if len(models) == 1:
        return models[0]
    return '+'.join(models) if models else None


# ---------------------------------------------------------------------------------------------------------------------------- 3. the parser
def _id_ok(x):
    return x is None or isinstance(x, str)


def _responses(events, problems):
    """Assistant responses by message identity (review rounds 2 and 3), the CLI's corrections and its validation results."""
    responses, checks, corrections, by_id, open_resp = [], [], [], {}, None
    for e in events:
        msg = e.get('message') if isinstance(e.get('message'), dict) else {}
        content = msg.get('content')
        blocks = content if isinstance(content, list) else ([{'type': 'text', 'text': content}] if isinstance(content, str) else [])
        if e.get('type') == 'assistant':
            mid = msg.get('id')
            if not _id_ok(mid):
                problems.append('an assistant event has a message id that is not a string (%s)' % type(mid).__name__)
                continue
            if mid is not None and mid in by_id:
                r = by_id[mid]
            elif mid is None and open_resp is not None:
                r = open_resp
            else:
                r = {'id': mid, 'texts': [], 'structured': [], 'other_tools': [], 'blocks': 0}
                responses.append(r)
                if mid is not None:
                    by_id[mid] = r
            open_resp = r
            r['blocks'] += len(blocks)
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_use' and not _id_ok(b.get('id')):
                    problems.append('a tool_use block has an id that is not a string (%s)' % type(b.get('id')).__name__)
                    continue
                if b.get('type') == 'tool_use' and b.get('name') == STRUCTURED_OUTPUT_TOOL:
                    r['structured'].append({'id': b.get('id'), 'input': b.get('input')})
                elif b.get('type') == 'tool_use':
                    r['other_tools'].append(b.get('name') if isinstance(b.get('name'), str) else None)
                elif b.get('type') == 'text' and isinstance(b.get('text'), str) and b['text'].strip():
                    r['texts'].append(b['text'])
        elif e.get('type') == 'user':
            open_resp = None
            ids = {a['id'] for r in responses for a in r['structured'] if isinstance(a['id'], str)}
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_result' and not _id_ok(b.get('tool_use_id')):
                    problems.append('a tool_result block has a tool_use_id that is not a string (%s)' % type(b.get('tool_use_id')).__name__)
                    continue
                if b.get('type') == 'tool_result' and b.get('tool_use_id') in ids:
                    body = b.get('content')
                    checks.append({'tool_use_id': b.get('tool_use_id'), 'is_error': b.get('is_error') is True,
                                   'text': body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)})
                elif b.get('type') == 'text' and isinstance(b.get('text'), str):
                    corrections.append({'after_response': len(responses), 'text': b['text']})
    return responses, checks, corrections


def _parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode='json-schema-1', utf8_valid=True, raw_meta=None):
    events, malformed, dups = decode_lines_ex(raw)
    problems = list(malformed)
    inits = [e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init']
    tool_lists = [i.get('tools') for i in inits if isinstance(i.get('tools'), list)]
    registered = False if any(STRUCTURED_OUTPUT_TOOL not in t for t in tool_lists) else (True if tool_lists else None)
    cli_version = inits[0].get('claude_code_version') if inits and isinstance(inits[0].get('claude_code_version'), str) else None
    responses, checks, corrections = _responses(events, problems)
    rc = reconcile([dict(check_result(e), **({'cost': INVALID} if id(e) in dups else {})) for e in events if e.get('type') == 'result'])
    #  a receipt with a duplicate key is ambiguous: its cost counts as unvalidated (a budget subtype on it still stops the run)
    if rc is not None:
        problems += rc['problems']
    if not utf8_valid:
        problems.append('the stream is not valid UTF-8 (the original bytes are kept in meta.raw)')
    cost = rc['cost'] if rc is not None else None
    receipt = None if rc is None else {'input_tokens': rc['usage']['input_tokens'], 'output_tokens': rc['usage']['output_tokens'],
                                       'cost_usd': cost if isinstance(cost, float) else rc.get('cost_known_max')}
    subtype = rc['subtype'] if rc is not None else None
    budget = bool(rc and rc['budget'])
    first = responses[0] if responses else None
    if first is not None and first['structured']:
        text, source = json.dumps(first['structured'][0]['input'], ensure_ascii=False), 'first_structured_output_attempt'
    elif first is not None and first['texts']:
        text, source = '\n'.join(first['texts']), 'first_assistant_text'
    elif first is not None:
        text, source = '', 'first_assistant_empty'
    elif rc is not None and rc['text']:
        text, source = rc['text'], 'result_text'
    else:
        text, source = '', 'none'
    attempts = [a for r in responses for a in r['structured']]
    schema_meta = {'mode': schema_mode, 'adapter_version': CLAUDE_SCHEMA_ADAPTER_VERSION, 'flag_sent': True, 'json_schema_sha256': req.get('json_schema_sha256'),
                   'tool_registered': registered, 'init_seen': bool(inits), 'cli_version_reported': cli_version,
                   'responses': len(responses), 'first_response_kind': ('structured' if first['structured'] else 'text' if first['texts'] else
                                                                        'other_tool' if first['other_tools'] else 'empty') if first else None,
                   'attempts': len(attempts), 'attempt_inputs': [a['input'] for a in attempts], 'response_texts': [r['texts'] for r in responses],
                   'cli_corrections': corrections, 'cli_validation': checks, 'cli_internal_retries': max(0, len(responses) - 1),
                   'result_subtype': subtype, 'stream_problems': problems,
                   'structured_output_present': bool(rc and rc['has_structured_output']), 'structured_output': rc['structured_output'] if rc else None,
                   'result_text': rc['text'] if rc else None, 'reply_source': source, 'reported_models': rc['models'] if rc else [],
                   'note': 'the reply is the first completed assistant response; later CLI-internal responses are recorded only and grant no repair'}
    evidence = {'raw_request': req, 'raw_response': raw, 'meta': {'model_usage': rc['model_usage'] if rc else None, 'schema': schema_meta,
                                                                  **({'raw': raw_meta} if raw_meta else {})}}
    schema_meta['receipts'] = rc['receipts'] if rc else 0
    stop_note = ' (the CLI reported %s)' % BUDGET_SUBTYPE if budget else ''
    if registered is False:          # anywhere in the stream, malformed or not: the schema was not delivered
        ab = AbortRun('claude-schema-1: the CLI init event does not list the %s tool, so --json-schema was not delivered with these flags; stopping the run '
                      'instead of recording a schema that was not sent' % STRUCTURED_OUTPUT_TOOL)
        ab.failed_call = dict({'error': 'schema not registered by the CLI' + stop_note, 'usage': receipt,
                               'failure_modes': ['adapter_error', 'schema_not_registered']}, **evidence)
        raise ab
    if budget:     # round 6: a budget stop on any receipt always stops the run, with its receipt (and says so when a cost could not be validated)
        ab = AbortRun('cost cap reached by a call: the Claude CLI stopped it at its per-call budget (%s)%s; stopping the run' % (
            BUDGET_SUBTYPE, '' if isinstance(cost, float) else ' and its reported cost could not be validated'))
        ab.failed_call = dict({'error': 'budget stop (%s)' % BUDGET_SUBTYPE, 'usage': receipt, 'failure_modes': ['adapter_error', 'budget_stop']}, **evidence)
        raise ab
    if cost is INVALID or cost is None:      # (d): a call whose spend cannot be metered stops the run
        why = 'its reported cost failed validation' if cost is INVALID else ('it reported no cost' if rc is not None else 'no result event arrived')
        ab = AbortRun('claude-schema-1: a call whose cost cannot be metered stops the run: %s%s' % (why, stop_note))
        ab.failed_call = dict({'error': 'unmetered call: ' + why + stop_note, 'usage': receipt, 'failure_modes': ['adapter_error', 'cost_unmetered']}, **evidence)
        raise ab
    if problems:
        raise AdapterError('claude CLI stream is malformed%s: %s' % (stop_note, '; '.join(problems)[:300]), usage=receipt, budget_exceeded=budget, evidence=evidence)
    cli_error = rc['is_error'] or subtype != 'success'
    if cli_error and first is None:
        raise AdapterError('claude CLI error: %s' % json.dumps({'subtype': subtype, 'result': rc['text']})[:400], usage=receipt, budget_exceeded=budget,
                           evidence=evidence)
    schema_meta['cli_error_after_first_response'] = cli_error
    usage = dict(rc['usage'], cost_usd=cost)
    return Completion(text, req, raw, response_model=_response_model(rc['models'], req), usage=usage, wall_s=wall,
                      native={'subtype': subtype, 'is_error': rc['is_error']}, meta=evidence['meta'])


def safe_str(x, limit=300):
    """str() that never raises and is always writable (an exception whose __str__ raises, a lone surrogate)."""
    try:
        s = str(x)
    except Exception:  # noqa: BLE001
        try:
            s = repr(x)
        except Exception:  # noqa: BLE001
            s = '<unprintable %s>' % type(x).__name__
    return s[:limit].encode('utf-8', 'backslashreplace').decode('utf-8')


def _safe_scan(raw):
    """An independent, defensive scan (its own decoding, nothing shared with the parser): -> (registration missing, budget seen, the largest valid cost
    or None).  Used only to keep the primary classification when the parser itself failed."""
    missing, budget, cost = False, False, None
    for line in (raw or '').splitlines():
        try:
            if len(line) > MAX_LINE_CHARS:
                continue
            ev = json.loads(line)          # a too-deep line raises RecursionError, caught below
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(ev, dict):
            continue
        if ev.get('type') == 'system' and ev.get('subtype') == 'init' and isinstance(ev.get('tools'), list) and STRUCTURED_OUTPUT_TOOL not in ev['tools']:
            missing = True
        if ev.get('type') == 'result':
            budget = budget or ev.get('subtype') == BUDGET_SUBTYPE
            c = _cost(ev.get('total_cost_usd'))
            if isinstance(c, float):
                cost = c if cost is None else max(cost, c)
    return missing, budget, cost


def _fail_closed(e, req, raw, where, raw_meta=None):
    """The outer guard's stop.  It keeps the primary classification an independent scan finds (registration, budget, the receipt); the failure itself is
    attached as `secondary_failure` and never replaces it."""
    try:
        missing, budget, cost = _safe_scan(raw)
    except Exception:  # noqa: BLE001
        missing, budget, cost = False, False, None
    if missing:
        primary = 'claude-schema-1: the CLI init event does not list the %s tool, so --json-schema was not delivered with these flags' % STRUCTURED_OUTPUT_TOOL
    elif budget:
        primary = 'cost cap reached by a call: the Claude CLI stopped it at its per-call budget (%s)' % BUDGET_SUBTYPE
    else:
        primary = 'claude-schema-1: %s failed; stopping the run (fail closed)' % where
    ab = AbortRun(primary)
    ab.failed_call = {'error': primary, 'usage': {'cost_usd': cost} if cost is not None else None, 'raw_request': req, 'raw_response': raw,
                      'secondary_failure': '%s failed: %s: %s' % (where, type(e).__name__, safe_str(e, 200)), 'failure_modes': ['adapter_error', 'fail_closed'],
                      **({'meta': {'raw': raw_meta}} if raw_meta else {})}
    return ab


def parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode='json-schema-1', utf8_valid=True, raw_meta=None):
    """The parser behind the outer guard: AdapterError and AbortRun pass; anything else becomes a fail-closed AbortRun with the raw stream."""
    try:
        return _parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode, utf8_valid, raw_meta)
    except (AdapterError, AbortRun):
        raise
    except Exception as e:  # noqa: BLE001 - the outer guard
        raise _fail_closed(e, req, raw, 'reading the stream', raw_meta)


# ---------------------------------------------------------------------------------------------------------------------------- 4. the call
def keep_raw(adapter, data):
    """Rule A (round 6): the call's output as bytes, kept before any parsing: -> (text, utf8_valid, raw_meta).  The bytes go to base64 in the record and,
    when the run gives a sink (schema_run sets `adapter.raw_sink`), to a `.raw` file first.  Invalid UTF-8 is decoded with replacement for parsing only
    and marked; the original bytes stay in raw_meta."""
    data = data if isinstance(data, bytes) else (data.encode('utf-8', 'surrogateescape') if isinstance(data, str) else b'')
    meta = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'b64': base64.b64encode(data).decode('ascii'), 'file': None}
    sink = getattr(adapter, 'raw_sink', None)
    if sink is not None:
        adapter.raw_seq = getattr(adapter, 'raw_seq', 0) + 1
        name = '%s-%03d.raw' % (getattr(adapter, 'current_case', None) or 'call', adapter.raw_seq)
        sink.mkdir(parents=True, exist_ok=True)
        (sink / name).write_bytes(data)
        meta['file'] = name
    try:
        return data.decode('utf-8'), True, meta
    except UnicodeDecodeError:
        return data.decode('utf-8', 'replace'), False, meta


def _stop(adapter, ab):
    """A stop, once raised, is sticky: no further call of this adapter starts (Rule B)."""
    if getattr(adapter, 'schema_stop', None) is None:
        adapter.schema_stop = safe_str(ab)
    return ab


def complete(adapter, system, messages, schema):
    """ClaudeAdapter.complete in schema mode, behind the outer guard."""
    if getattr(adapter, 'schema_experimental', False) is not True:       # round 8: refused at the call boundary too, before the CLI runs
        from .adapters import SCHEMA_GATE
        raise ValueError(SCHEMA_GATE)
    raw, req, raw_meta = '', None, None
    if getattr(adapter, 'schema_stop', None):
        raise _stop(adapter, AbortRun('claude-schema-1: a stop was already established (%s); no further call starts' % adapter.schema_stop))
    try:
        prompt = render_transcript(messages)
        cmd = adapter.argv_schema(system, schema)
        req = {'argv': cmd[:cmd.index('--system-prompt')] + ['--system-prompt', '<system>'] + cmd[cmd.index('--system-prompt') + 2:],
               'system_prompt': system, 'prompt': prompt, 'json_schema_sha256': _sha256_text(json.dumps(schema, separators=(',', ':'), sort_keys=True))}
        started = time.monotonic()
        try:
            r = adapter.runner(cmd, input=prompt.encode(), capture_output=True, timeout=adapter.timeout, cwd=adapter.workdir)
        except subprocess.TimeoutExpired as te:
            out = te.output if te.output is not None else getattr(te, 'stdout', None)
            raw, ok, raw_meta = keep_raw(adapter, out)
            raise timeout_error(adapter, raw, req, time.monotonic() - started, ok, raw_meta)
        raw, ok, raw_meta = keep_raw(adapter, r.stdout)
        stderr = r.stderr.decode(errors='replace') if isinstance(r.stderr, bytes) else (r.stderr or '')
        return parse_claude_stream(raw, stderr, r.returncode, req, time.monotonic() - started, adapter.schema_mode, ok, raw_meta)
    except AbortRun as ab:
        raise _stop(adapter, ab)
    except AdapterError:
        raise
    except Exception as e:  # noqa: BLE001 - the outer guard
        raise _stop(adapter, _fail_closed(e, req, raw, 'the schema-mode call', raw_meta))


def timeout_error(adapter, raw, req, wall, utf8_valid=True, raw_meta=None):
    """A timed-out call keeps what its partial stream shows; every classification travels (budget flag, registration abort, unmetered abort)."""
    msg = 'claude CLI timed out after %d s' % adapter.timeout
    try:
        comp = parse_claude_stream(raw, '', None, req, wall, adapter.schema_mode, utf8_valid, raw_meta)
    except AdapterError as e:
        return AdapterError(msg + ' (partial stream: %s)' % str(e)[:200], usage=e.usage, evidence=e.evidence, budget_exceeded=e.budget_exceeded)
    return AdapterError(msg + ' (a result event had arrived)', usage=comp.usage, budget_exceeded=(comp.native or {}).get('subtype') == BUDGET_SUBTYPE,
                        evidence={'raw_request': req, 'raw_response': raw, 'meta': comp.meta})
