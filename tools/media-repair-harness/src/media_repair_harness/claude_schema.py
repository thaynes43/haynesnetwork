"""claude-schema-1 (dev-c8, opt-in `--claude-schema json-schema-1`): the stream-json parser and the timeout handling of the schema-mode Claude adapter.

Moved verbatim out of adapters.py in review round 3 (only so the wiring-smoke Job bundle, which carries adapters.py, stays under its ceiling after
main grew); adapters.py imports it only in schema mode.  See adapters.ClaudeAdapter and docs/dev-c8.md section 3."""
import json

from .adapters import CLAUDE_SCHEMA_ADAPTER_VERSION, STRUCTURED_OUTPUT_TOOL, AbortRun, AdapterError, Completion, _sha256_text


def _id_ok(x):
    return x is None or isinstance(x, str)


def _num(x):
    return x is None or (isinstance(x, (int, float)) and not isinstance(x, bool))


def _checked_result(result):
    """-> (result with every field the parser keys on or adds up made safe, problems).  A wrong-typed field is a malformed stream; what can be kept is kept
    (a numeric cost next to a wrong-typed token count still counts)."""
    if result is None:
        return None, []
    out, problems = dict(result), []
    if not isinstance(out.get('subtype', 'success'), str):
        problems.append('subtype is not a string')
        out['subtype'] = 'malformed_subtype'
    u = out.get('usage')
    if u is not None and not isinstance(u, dict):
        problems.append('usage is not an object')
        out['usage'] = {}
    u = out.get('usage') or {}
    for k in ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'):
        if not _num(u.get(k)):
            problems.append('usage.%s is not a number' % k)
            out['usage'] = dict(out.get('usage') or {}, **{k: None})
    if not _num(out.get('total_cost_usd')):
        problems.append('total_cost_usd is not a number')
        out['total_cost_usd'] = None
    if out.get('modelUsage') is not None and not isinstance(out.get('modelUsage'), dict):
        problems.append('modelUsage is not an object')
        out['modelUsage'] = None
    return out, problems


def _safe_receipt(raw):
    """The last result event's receipt and budget classification, read defensively (any field of any type); used only when the stream cannot be parsed at all."""
    for line in reversed((raw or '').splitlines()):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if isinstance(ev, dict) and ev.get('type') == 'result':
            r, _p = _checked_result(ev)
            u = r.get('usage') or {}
            return {'input_tokens': u.get('input_tokens'), 'output_tokens': u.get('output_tokens'), 'cost_usd': r.get('total_cost_usd')}, r.get('subtype') == 'error_max_budget_usd'
    return None, False


def parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode='json-schema-1'):
    """The parser below, with a safety net (review round 4): any other wrong-typed field it meets ends in an evidence-carrying AdapterError that keeps the
    receipt and the budget classification, never in a harness crash."""
    try:
        return _parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode)
    except (AdapterError, AbortRun):
        raise
    except Exception as e:  # noqa: BLE001 - a malformed stream must not lose its evidence
        receipt, budget = _safe_receipt(raw)
        raise AdapterError('claude CLI stream could not be read (%s: %s)' % (type(e).__name__, str(e)[:120]), usage=receipt, budget_exceeded=budget,
                           evidence={'raw_request': req, 'raw_response': raw})


def _parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode='json-schema-1'):
    """claude-schema-1: parse the `stream-json` event stream of one `claude -p --json-schema` call.

    The reply is the model's FIRST completed assistant response, whatever its form: its StructuredOutput input when that response called the tool,
    else its text (a text-only answer the CLI then corrected is still the first try).  Assistant events are grouped by message id into responses; the
    CLI's own corrections (user text it injects, such as a request to call the tool) and its validation results are recorded, and every later response
    counts as a CLI-internal retry: recorded in meta.schema, never used.  Every event stays in raw_response, untruncated.
    Order of checks: a non-JSON line rejects the stream (AdapterError, keeping the receipt of a valid result event if one is there); an init event that does
    not list StructuredOutput stops the run (AbortRun), even when the call also ended in an error; a call that ended in a CLI error still yields its first
    completed response when there is one (the error is recorded); otherwise an AdapterError.  Every failure carries the call's evidence (`evidence`)."""
    events, bad = [], None
    for n, line in enumerate(raw.splitlines()):
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            bad = bad or 'claude CLI stream line %d is not JSON (exit %s): %s' % (n + 1, returncode, line[:200])
            continue
        if not isinstance(ev, dict):
            bad = bad or 'claude CLI stream line %d is not a JSON object (exit %s)' % (n + 1, returncode)
            continue
        events.append(ev)
    init = next((e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init'), None)
    tools = (init or {}).get('tools')
    registered = (STRUCTURED_OUTPUT_TOOL in tools) if isinstance(tools, list) else None
    # Response identity (review round 2): assistant events with the same message id are ONE response wherever they appear (a rate-limit or other system
    # event between them does not split it); an event without an id joins the open response unless a user event (a CLI correction or a tool result)
    # came after it.  Every response counts, an explicitly completed empty, whitespace-only or thinking-only one included: it is a first try that
    # carries no answer, never skipped.
    responses, checks, corrections, by_id, open_resp = [], [], [], {}, None
    for e in events:
        msg = e.get('message') if isinstance(e.get('message'), dict) else {}
        content = msg.get('content')
        blocks = content if isinstance(content, list) else ([{'type': 'text', 'text': content}] if isinstance(content, str) else [])
        if e.get('type') == 'assistant':
            mid = msg.get('id')
            if mid is not None and not isinstance(mid, str):      # review round 3: a non-string id is a malformed event, rejected with the call's evidence
                bad = bad or 'claude CLI stream has an assistant event whose message id is not a string (%s)' % type(mid).__name__
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
                if b.get('type') == 'tool_use' and not _id_ok(b.get('id')):      # review round 4: every id the parser keys on is checked
                    bad = bad or 'claude CLI stream has a tool_use block whose id is not a string (%s)' % type(b.get('id')).__name__
                    continue
                if b.get('type') == 'tool_use' and b.get('name') == STRUCTURED_OUTPUT_TOOL:
                    r['structured'].append({'id': b.get('id'), 'input': b.get('input')})
                elif b.get('type') == 'tool_use':
                    r['other_tools'].append(b.get('name'))
                elif b.get('type') == 'text' and isinstance(b.get('text'), str) and b['text'].strip():
                    r['texts'].append(b['text'])
        elif e.get('type') == 'user':
            open_resp = None
            ids = {a['id'] for r in responses for a in r['structured'] if isinstance(a['id'], str)}
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_result' and not _id_ok(b.get('tool_use_id')):
                    bad = bad or 'claude CLI stream has a tool_result block whose tool_use_id is not a string (%s)' % type(b.get('tool_use_id')).__name__
                    continue
                if b.get('type') == 'tool_result' and b.get('tool_use_id') in ids:
                    body = b.get('content')
                    checks.append({'tool_use_id': b.get('tool_use_id'), 'is_error': bool(b.get('is_error')),
                                   'text': body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)})
                elif b.get('type') == 'text' and isinstance(b.get('text'), str):
                    corrections.append({'after_response': len(responses), 'text': b['text']})
    result = next((e for e in reversed(events) if e.get('type') == 'result'), None)
    result, problems = _checked_result(result)
    if problems:
        bad = bad or 'claude CLI result event is malformed: %s' % ', '.join(problems)
    u = (result or {}).get('usage') or {}
    receipt = {'input_tokens': u.get('input_tokens'), 'output_tokens': u.get('output_tokens'), 'cost_usd': (result or {}).get('total_cost_usd')} if result else None
    subtype = (result or {}).get('subtype', 'success') if result else None
    first = responses[0] if responses else None
    if first is not None and first['structured']:
        text, source = json.dumps(first['structured'][0]['input'], ensure_ascii=False), 'first_structured_output_attempt'
    elif first is not None and first['texts']:
        text, source = '\n'.join(first['texts']), 'first_assistant_text'
    elif first is not None:
        text, source = '', 'first_assistant_empty'          # a completed response with no text and no tool call: an empty first try
    elif result is not None and not responses:
        text = result.get('result') or ''
        source = 'result_text' if text else 'none'
    else:
        text, source = '', 'none'
    attempts = [a for r in responses for a in r['structured']]
    schema_meta = {'mode': schema_mode, 'adapter_version': CLAUDE_SCHEMA_ADAPTER_VERSION, 'flag_sent': True, 'json_schema_sha256': req.get('json_schema_sha256'),
                   'tool_registered': registered, 'init_seen': init is not None, 'cli_version_reported': (init or {}).get('claude_code_version'),
                   'responses': len(responses), 'first_response_kind': ('structured' if first['structured'] else 'text' if first['texts'] else
                                                                        'other_tool' if first['other_tools'] else 'empty') if first else None,
                   'attempts': len(attempts), 'attempt_inputs': [a['input'] for a in attempts], 'response_texts': [r['texts'] for r in responses],
                   'cli_corrections': corrections, 'cli_validation': checks, 'cli_internal_retries': max(0, len(responses) - 1),
                   'result_subtype': subtype, 'stream_error': bad,
                   'structured_output_present': bool(result) and 'structured_output' in result, 'structured_output': (result or {}).get('structured_output'),
                   'result_text': (result or {}).get('result'), 'reply_source': source,
                   'note': 'the reply is the first completed assistant response; later CLI-internal responses are recorded only and grant no repair'}
    evidence = {'raw_request': req, 'raw_response': raw, 'meta': {'model_usage': (result or {}).get('modelUsage'), 'schema': schema_meta}}
    if registered is False:      # checked first: a stream that shows the tool was not registered stops the run, malformed or not (review round 2)
        ab = AbortRun('claude-schema-1: the CLI init event does not list the %s tool, so --json-schema was not delivered with these flags; stopping the run '
                      'instead of recording a schema that was not sent' % STRUCTURED_OUTPUT_TOOL)
        ab.failed_call = dict({'error': 'schema not registered by the CLI', 'usage': receipt, 'failure_modes': ['adapter_error', 'schema_not_registered']}, **evidence)
        raise ab
    if bad is not None:
        raise AdapterError(bad, usage=receipt, budget_exceeded=subtype == 'error_max_budget_usd', evidence=evidence)
    if not events:
        raise AdapterError('claude CLI returned no stream events (exit %s): %s' % (returncode, (stderr or '')[:300]), evidence=evidence)
    if result is None:
        raise AdapterError('claude CLI stream has no result event (exit %s)' % returncode, evidence=evidence)
    cli_error = bool(result.get('is_error')) or subtype != 'success'
    if cli_error and first is None:
        raise AdapterError('claude CLI error: %s' % json.dumps({k: result.get(k) for k in ('subtype', 'api_error_status', 'result', 'terminal_reason')})[:400],
                           usage=receipt, budget_exceeded=subtype == 'error_max_budget_usd', evidence=evidence)
    schema_meta['cli_error_after_first_response'] = cli_error
    models = list((result.get('modelUsage') or {}).keys())
    usage = {'input_tokens': u.get('input_tokens'), 'output_tokens': u.get('output_tokens'),
             'cache_creation_input_tokens': u.get('cache_creation_input_tokens'), 'cache_read_input_tokens': u.get('cache_read_input_tokens'),
             'cost_usd': result.get('total_cost_usd')}
    return Completion(text, req, raw, response_model=models[0] if len(models) == 1 else (models or None),
                      usage=usage, wall_s=wall, native={'duration_ms': result.get('duration_ms'), 'duration_api_ms': result.get('duration_api_ms'),
                                                        'num_turns': result.get('num_turns'), 'stop_reason': result.get('stop_reason'),
                                                        'permission_denials': result.get('permission_denials'), 'subtype': subtype},
                      meta=evidence['meta'])


def timeout_error(self, te, cmd, system, prompt, schema, wall):
    """claude-schema-1: a timed-out call keeps what its partial stream shows (raw output, attempts, delivery record, a receipt if one arrived); a
    missing-tool init still stops the run.  The legacy adapter keeps its plain timeout error."""
    out = te.output if te.output is not None else te.stdout if hasattr(te, 'stdout') else None
    raw = out.decode(errors='replace') if isinstance(out, bytes) else (out or '')
    req = {'argv': cmd[:cmd.index('--system-prompt')] + ['--system-prompt', '<system>'] + cmd[cmd.index('--system-prompt') + 2:],
           'system_prompt': system, 'prompt': prompt, 'json_schema_sha256': _sha256_text(json.dumps(schema, separators=(',', ':'), sort_keys=True))}
    msg = 'claude CLI timed out after %d s' % self.timeout
    try:
        comp = parse_claude_stream(raw, '', None, req, wall, self.schema_mode)
    except AdapterError as e:
        ev = dict(e.evidence or {'raw_request': req, 'raw_response': raw})
        return AdapterError(msg + ' (partial stream: %s)' % str(e)[:200], usage=e.usage, evidence=ev, budget_exceeded=e.budget_exceeded)   # every classification travels
    return AdapterError(msg + ' (a result event had arrived)', usage=comp.usage, budget_exceeded=(comp.native or {}).get('subtype') == 'error_max_budget_usd',
                        evidence={'raw_request': req, 'raw_response': raw, 'meta': comp.meta})
