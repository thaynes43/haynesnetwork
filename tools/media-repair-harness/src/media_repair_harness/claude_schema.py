"""claude-schema-1 (dev-c8, opt-in `--claude-schema json-schema-1`): the schema-mode Claude call, its stream-json parser and its timeout handling.

adapters.py imports this module only in schema mode (moved out of adapters.py in review round 3 to keep the wiring-smoke Job bundle under its ceiling).
See adapters.ClaudeAdapter and docs/dev-c8.md section 3.

FAIL-CLOSED BY STRUCTURE (review round 5).  In schema mode no input stream can make the run (a) lose the raw stream, (b) lose a budget or registration
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
     reason and the raw stream.  The legacy adapter (schema mode off) is untouched."""
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


def decode_lines(raw):
    """-> (events, malformed): the JSON-object lines, and one note per line that could not be decoded (with its line number)."""
    events, malformed = [], []
    for n, line in enumerate((raw or '').splitlines()):
        if not line.strip():
            continue
        try:
            why = _prescan(line)
            if why is None:
                ev = json.loads(line)
                if isinstance(ev, dict):
                    events.append(ev)
                    continue
                why = 'not a JSON object'
        except Exception as e:  # noqa: BLE001 - one bad line never discards the others
            why = 'not JSON (%s)' % type(e).__name__
        malformed.append('line %d: %s' % (n + 1, why))
    return events, malformed


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


def _parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode='json-schema-1'):
    events, malformed = decode_lines(raw)
    problems = list(malformed)
    inits = [e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init']
    tool_lists = [i.get('tools') for i in inits if isinstance(i.get('tools'), list)]
    registered = False if any(STRUCTURED_OUTPUT_TOOL not in t for t in tool_lists) else (True if tool_lists else None)
    cli_version = inits[0].get('claude_code_version') if inits and isinstance(inits[0].get('claude_code_version'), str) else None
    responses, checks, corrections = _responses(events, problems)
    results = [e for e in events if e.get('type') == 'result']
    rc = check_result(results[-1]) if results else None
    if rc is not None:
        problems += rc['problems']
    cost = rc['cost'] if rc is not None else None
    receipt = None if rc is None else {'input_tokens': rc['usage']['input_tokens'], 'output_tokens': rc['usage']['output_tokens'],
                                       'cost_usd': cost if isinstance(cost, float) else None}
    subtype = rc['subtype'] if rc is not None else None
    budget = subtype == BUDGET_SUBTYPE
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
    evidence = {'raw_request': req, 'raw_response': raw, 'meta': {'model_usage': rc['model_usage'] if rc else None, 'schema': schema_meta}}
    stop_note = ' (the CLI reported %s)' % BUDGET_SUBTYPE if budget else ''
    if registered is False:          # anywhere in the stream, malformed or not: the schema was not delivered
        ab = AbortRun('claude-schema-1: the CLI init event does not list the %s tool, so --json-schema was not delivered with these flags; stopping the run '
                      'instead of recording a schema that was not sent' % STRUCTURED_OUTPUT_TOOL)
        ab.failed_call = dict({'error': 'schema not registered by the CLI' + stop_note, 'usage': receipt,
                               'failure_modes': ['adapter_error', 'schema_not_registered']}, **evidence)
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


def _fail_closed(e, req, raw, where):
    ab = AbortRun('claude-schema-1: %s failed (%s); stopping the run (fail closed)' % (where, type(e).__name__))
    ab.failed_call = {'error': '%s failed: %s: %s' % (where, type(e).__name__, str(e)[:200]), 'usage': None, 'raw_request': req, 'raw_response': raw,
                      'failure_modes': ['adapter_error', 'fail_closed']}
    return ab


def parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode='json-schema-1'):
    """The parser behind the outer guard: AdapterError and AbortRun pass; anything else becomes a fail-closed AbortRun with the raw stream."""
    try:
        return _parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode)
    except (AdapterError, AbortRun):
        raise
    except Exception as e:  # noqa: BLE001 - the outer guard
        raise _fail_closed(e, req, raw, 'reading the stream')


# ---------------------------------------------------------------------------------------------------------------------------- 4. the call
def complete(adapter, system, messages, schema):
    """ClaudeAdapter.complete in schema mode, behind the outer guard."""
    raw, req = '', None
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
            raw = out.decode(errors='replace') if isinstance(out, bytes) else (out if isinstance(out, str) else '')
            raise timeout_error(adapter, raw, req, time.monotonic() - started)
        raw = r.stdout.decode(errors='replace') if isinstance(r.stdout, bytes) else (r.stdout or '')
        stderr = r.stderr.decode(errors='replace') if isinstance(r.stderr, bytes) else (r.stderr or '')
        return parse_claude_stream(raw, stderr, r.returncode, req, time.monotonic() - started, adapter.schema_mode)
    except (AdapterError, AbortRun):
        raise
    except Exception as e:  # noqa: BLE001 - the outer guard
        raise _fail_closed(e, req, raw, 'the schema-mode call')


def timeout_error(adapter, raw, req, wall):
    """A timed-out call keeps what its partial stream shows; every classification travels (budget flag, registration abort, unmetered abort)."""
    msg = 'claude CLI timed out after %d s' % adapter.timeout
    try:
        comp = parse_claude_stream(raw, '', None, req, wall, adapter.schema_mode)
    except AdapterError as e:
        return AdapterError(msg + ' (partial stream: %s)' % str(e)[:200], usage=e.usage, evidence=e.evidence, budget_exceeded=e.budget_exceeded)
    return AdapterError(msg + ' (a result event had arrived)', usage=comp.usage, budget_exceeded=(comp.native or {}).get('subtype') == BUDGET_SUBTYPE,
                        evidence={'raw_request': req, 'raw_response': raw, 'meta': comp.meta})
