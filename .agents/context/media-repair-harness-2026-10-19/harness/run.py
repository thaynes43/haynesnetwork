#!/usr/bin/env python3
"""Unified runner: `run.py --suite <cases dir> --adapter ollama|claude|codex|scripted --model <id> [--cases a,b] --out runs/<run-id>`

Implements the CONTRACT.md turn protocol and writes one run record per case (failed runs included), an
action-audit line per case and a run manifest.  Tools are read-only; write actions in a decision are only
recorded as intents and never executed.
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import adapters as A  # noqa: E402
import outcomes  # noqa: E402
import protocol as P  # noqa: E402
import tools as T  # noqa: E402

MAX_MODEL_CALLS = 2 * P.MAX_TOOL_CALLS + 6  # hard stop against loops: turns + repair + budget notice


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def git_info():
    def g(*a):
        r = subprocess.run(['git', '-C', str(HERE)] + list(a), capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    status = g('status', '--porcelain', '--', str(HERE))
    return {'sha': g('rev-parse', 'HEAD'), 'dirty': bool(status), 'branch': g('rev-parse', '--abbrev-ref', 'HEAD')}


def find_cases_dir(suite):
    suite = Path(suite)
    return suite / 'cases' if (suite / 'cases').is_dir() else suite


def suite_root(suite):
    """Directory that case-relative locators and refs resolve against (the suite dir, not its cases/ subdir)."""
    suite = Path(suite)
    return suite.parent if (suite.name == 'cases' and not (suite / 'cases').is_dir()) else suite


def load_cases(suite, ids=None, split=None):
    cdir = find_cases_dir(suite)
    cases = []
    for f in sorted(cdir.glob('*.json')):
        raw = f.read_bytes()
        case = json.loads(raw)
        if not isinstance(case, dict) or 'id' not in case:
            continue
        if ids and case['id'] not in ids:
            continue
        if split and case.get('split') != split:
            continue
        cases.append((case, sha256_bytes(raw)))
    if ids:
        missing = set(ids) - {c['id'] for c, _ in cases}
        if missing:
            raise SystemExit('unknown case ids: %s' % sorted(missing))
    return cases


def resolve_evidence(case, suite_dir):
    """Pre-collected evidence as shown to the model (outputs bounded; refs verified against their sha256)."""
    shown = []
    for e in case.get('evidence', []):
        out = e.get('output')
        status = e.get('status', 'ok')
        if isinstance(out, dict) and 'ref' in out:
            p = Path(out['ref'])
            p = p if p.is_absolute() else Path(suite_dir) / p
            try:
                data = p.read_bytes()
                if out.get('sha256') and sha256_bytes(data) != out['sha256']:
                    out, status = 'evidence file hash mismatch', 'error'
                else:
                    out = data.decode('utf-8', errors='replace')
            except OSError:
                out, status = 'evidence file missing', 'error'
        elif not isinstance(out, str):
            out = json.dumps(out, sort_keys=True, ensure_ascii=False)
        res = T.ToolResult(status if status in ('ok', 'partial', 'error', 'timeout') else 'ok', out).bounded()
        shown.append({'id': e['id'], 'tool': e.get('tool'), 'args': e.get('args', {}), 'status': res['status'],
                      'output': res['output'], 'truncated': res['truncated']})
    return shown


def result_message(call_id, tool, res, remaining):
    return json.dumps({'type': 'tool_result', 'id': call_id, 'tool': tool, 'status': res['status'], 'truncated': res['truncated'],
                       'output': res['output'], 'tool_calls_remaining': remaining}, ensure_ascii=False)


def run_case(case, case_sha, adapter, suite_dir, scratch, ocr_backend=None, runner=subprocess.run, which=None):
    """Run one case through the turn protocol.  Returns the run record (never raises for model/tool trouble)."""
    import shutil
    started_wall = time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    fixture = T.Fixture.from_case(case, suite_dir)
    fixture_info = fixture.verify_local()
    ctx = T.Context(case, fixture, Path(scratch) / case['id'], runner=runner, which=which or shutil.which, ocr_backend=ocr_backend)
    evidence = resolve_evidence(case, suite_dir)
    view = P.case_view(case, evidence)
    system = P.SYSTEM_PROMPT
    messages = [{'role': 'user', 'content': json.dumps(view, ensure_ascii=False, sort_keys=True)}]
    ev_ids = {e['id'] for e in evidence}
    turns, tool_calls = [], []
    repairs, forced, forced_reason, error = [], False, None, None
    decision = None
    load_s = 0.0

    def force(reason):
        nonlocal decision, forced, forced_reason
        decision, forced, forced_reason = P.forced_decision(reason), True, reason

    n_calls = 0
    try:
        while decision is None:
            if n_calls >= MAX_MODEL_CALLS:
                force('model call limit reached without a decision')
                break
            n_calls += 1
            try:
                comp = adapter.complete(system, messages)
            except A.AdapterError as e:
                error = {'kind': 'adapter_error', 'message': str(e)[:500]}
                turns.append({'n': len(turns) + 1, 'error': str(e)[:500]})
                force('model call failed: ' + str(e)[:200])
                break
            load_s += comp.load_s
            obj, perr, diag = P.parse_reply(comp.text)
            kind, verrs = (None, [perr]) if perr else P.validate_turn(obj, case.get('tools_available'))
            turn = dict(comp.to_dict(), n=len(turns) + 1, raw_request=comp.raw_request, raw_response=comp.raw_response,
                        parsed_type=kind, validation_errors=[e for e in verrs if e], **({'diagnostics': diag} if diag else {}))
            turns.append(turn)
            if kind is None:
                if not repairs:
                    err = '; '.join(e for e in verrs if e)[:300]
                    repairs.append({'after_turn': turn['n'], 'error': err})
                    messages += [{'role': 'assistant', 'content': comp.text}, {'role': 'user', 'content': P.REPAIR_PROMPT.format(error=err)}]
                    continue
                force('invalid output after the one repair prompt: ' + '; '.join(e for e in verrs if e)[:200])
                break
            if kind == 'decision':
                decision = obj
                break
            # tool call
            if len(tool_calls) >= P.MAX_TOOL_CALLS:
                # the 6th result already carried the budget notice: another request is budget exhaustion
                turn['budget_exhausted_request'] = True
                force('tool budget exhausted (6 calls) and the model asked for another tool call')
                break
            call_id = 't%d' % (len(tool_calls) + 1)
            res = T.call_tool(ctx, obj['tool'], obj['args'])
            tool_calls.append({'id': call_id, 'turn': turn['n'], 'tool': obj['tool'], 'args': obj['args'], 'why': obj.get('why'), **res})
            remaining = P.MAX_TOOL_CALLS - len(tool_calls)
            messages += [{'role': 'assistant', 'content': comp.text},
                         {'role': 'user', 'content': result_message(call_id, obj['tool'], res, remaining) +
                          ('' if remaining else '\n' + P.BUDGET_MESSAGE)}]
    except A.AbortRun:
        raise
    except Exception as e:  # noqa: BLE001 - harness fault: keep the run, mark it
        error = {'kind': 'harness_crash', 'message': '%s: %s' % (type(e).__name__, e), 'traceback': traceback.format_exc()[-1500:]}
        force('harness error: ' + type(e).__name__)

    first_try_valid = (decision is not None and not forced and not repairs)
    bad_refs = sorted(r for r in (decision or {}).get('evidence_refs', []) if r not in ev_ids and r not in {c['id'] for c in tool_calls})
    failed_refs = sorted(set((decision or {}).get('evidence_refs', [])) & {c['id'] for c in tool_calls if c['status'] in ('error', 'timeout')})
    outcome = outcomes.run_outcome_step(case, suite_dir)
    total = time.monotonic() - started_wall
    usage = {'input_tokens': 0, 'output_tokens': 0, 'cost_usd': 0.0, 'cost_reported': False}
    for t in turns:
        u = t.get('usage') or {}
        usage['input_tokens'] += u.get('input_tokens') or 0
        usage['output_tokens'] += u.get('output_tokens') or 0
        if u.get('cost_usd') is not None:
            usage['cost_usd'] += u['cost_usd']
            usage['cost_reported'] = True
    if not usage['cost_reported']:
        usage['cost_usd'] = None
    response_models = sorted({str(t.get('response_model')) for t in turns if t.get('response_model')})
    write_intent = decision['action'] in P.WRITE_ACTIONS
    record = {
        'record_version': 1, 'case_id': case['id'], 'case_sha256': case_sha, 'suite_version': case.get('suite_version'),
        'split': case.get('split'), 'started_at': started_at,
        'requested_model': adapter.requested_model, 'response_model_ids': response_models,
        'runtime_version': adapter.runtime_version, 'model_digest': adapter.model_digest,
        'model_digest_na_reason': adapter.digest_na_reason if not adapter.model_digest else None,
        'fixture': fixture_info, 'evidence_shown': [e['id'] for e in evidence],
        'turns': turns, 'tool_calls': tool_calls, 'repair_prompts': repairs,
        'decision': decision, 'forced': forced, 'forced_reason': forced_reason, 'first_try_valid': first_try_valid,
        'bad_evidence_refs': bad_refs, 'refs_to_failed_tools': failed_refs,
        'outcome': outcome, 'usage': usage,
        'wall': {'total_s': round(total, 3), 'load_s': round(load_s, 3), 'case_excl_load_s': round(max(0.0, total - load_s), 3),
                 'turn_s': [t.get('wall_s') for t in turns], 'tool_s': [c.get('wall_s') for c in tool_calls]},
        'injected_failure': case.get('inject_tool_failure'),
        'action_audit': {'intent': {'class': decision['class'], 'action': decision['action'], 'target': decision['target']},
                         'write_intent': write_intent, 'executed': False,
                         'note': 'recorded intent only; this harness never executes writes',
                         'outcome_step': outcome},
    }
    if error:
        record['error'] = error
    return record


def crash_record(case, case_sha, adapter, exc):
    d = P.forced_decision('harness error before the run: ' + type(exc).__name__)
    return {'record_version': 1, 'case_id': case['id'], 'case_sha256': case_sha, 'suite_version': case.get('suite_version'),
            'split': case.get('split'), 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'requested_model': adapter.requested_model, 'response_model_ids': [], 'runtime_version': adapter.runtime_version,
            'model_digest': adapter.model_digest, 'model_digest_na_reason': adapter.digest_na_reason if not adapter.model_digest else None,
            'fixture': None, 'evidence_shown': [], 'turns': [], 'tool_calls': [], 'repair_prompts': [], 'decision': d, 'forced': True,
            'forced_reason': d['reason'], 'first_try_valid': False, 'bad_evidence_refs': [], 'refs_to_failed_tools': [], 'outcome': None,
            'usage': {'input_tokens': 0, 'output_tokens': 0, 'cost_usd': None, 'cost_reported': False},
            'wall': {'total_s': 0.0, 'load_s': 0.0, 'case_excl_load_s': 0.0, 'turn_s': [], 'tool_s': []}, 'injected_failure': case.get('inject_tool_failure'),
            'action_audit': {'intent': {'class': d['class'], 'action': d['action'], 'target': None}, 'write_intent': False, 'executed': False,
                             'note': 'recorded intent only; this harness never executes writes', 'outcome_step': None},
            'error': {'kind': 'harness_crash', 'message': '%s: %s' % (type(exc).__name__, exc), 'traceback': traceback.format_exc()[-1500:]}}


def build_adapter(args):
    model = args.model
    if args.adapter == 'ollama':
        return A.OllamaAdapter(model, options={'num_ctx': args.num_ctx, 'num_predict': args.num_predict}, keep_alive=args.keep_alive,
                               stop=(args.stop.split(',') if args.stop is not None else None), do_warmup=not args.no_warmup)
    if args.adapter == 'claude':
        return A.ClaudeAdapter(model, effort=args.effort, max_budget_usd=args.max_budget_usd)
    if args.adapter == 'codex':
        return A.CodexAdapter(model, effort=args.effort, record_session=args.codex_record_session)
    if args.adapter == 'scripted':
        return A.ScriptedAdapter(model, json.loads(Path(args.script).read_text()))
    raise SystemExit('unknown adapter')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--suite', required=True, help='suite directory (with cases/) or a directory of case JSON files')
    ap.add_argument('--adapter', required=True, choices=['ollama', 'claude', 'codex', 'scripted'])
    ap.add_argument('--model', required=True, help='full model id (no aliases)')
    ap.add_argument('--cases', help='comma separated case ids')
    ap.add_argument('--split', help='only cases with this split (dev|heldout)')
    ap.add_argument('--out', required=True, help='run directory, e.g. runs/<run-id>; must not already hold records')
    ap.add_argument('--scratch', help='scratch dir for frames etc. (never committed); default ~/.cache/media-repair-harness/<run-id>')
    ap.add_argument('--effort', help='claude/codex reasoning effort')
    ap.add_argument('--max-budget-usd', type=float, default=2.0, help='claude: per-call spend cap')
    ap.add_argument('--num-ctx', type=int, default=8192)
    ap.add_argument('--num-predict', type=int, default=384)
    ap.add_argument('--keep-alive', default='2m')
    ap.add_argument('--stop', help='comma separated stop tokens (ollama); default per model family')
    ap.add_argument('--no-warmup', action='store_true')
    ap.add_argument('--ocr-model', help='vision model on Prime for the ocr tool')
    ap.add_argument('--codex-record-session', action='store_true', help='codex: keep the rollout so the model id can be read back')
    ap.add_argument('--script', help='scripted adapter: JSON list of replies')
    args = ap.parse_args(argv)

    out = Path(args.out)
    if out.exists() and any(out.iterdir()):
        raise SystemExit('refusing to reuse a non-empty run directory (failed runs are kept, never overwritten): %s' % out)
    out.mkdir(parents=True, exist_ok=True)
    run_id = out.name
    suite_dir = suite_root(args.suite)
    scratch = Path(args.scratch) if args.scratch else Path.home() / '.cache' / 'media-repair-harness' / run_id
    cases = load_cases(args.suite, ids=args.cases.split(',') if args.cases else None, split=args.split)
    if not cases:
        raise SystemExit('no cases selected')
    adapter = build_adapter(args)
    ocr_backend = None
    if args.ocr_model:
        import ollama_transport as ot
        ocr_backend = T.ollama_ocr_backend(args.ocr_model, ot.api)

    config = {'protocol': P.PROTOCOL_VERSION, 'system_prompt_sha256': sha256_bytes(P.SYSTEM_PROMPT.encode()),
              'turn_schema_sha256': sha256_bytes(canonical(P.TURN_SCHEMA).encode()), 'max_tool_calls': P.MAX_TOOL_CALLS,
              'tool_output_bytes': P.TOOL_OUTPUT_BYTES, 'tool_timeout_s': P.TOOL_TIMEOUT_S, 'ocr_model': args.ocr_model,
              'adapter_config': adapter.config()}
    manifest = {'run_id': run_id, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'argv': sys.argv[1:] if argv is None else argv,
                'harness_git': git_info(), 'config': config, 'config_hash': sha256_bytes(canonical(config).encode()),
                'python': platform.python_version(), 'suite_dir': str(suite_dir),
                'case_ids': [c['id'] for c, _ in cases], 'case_sha256': {c['id']: s for c, s in cases}}
    aborted = None
    records = []
    try:
        manifest['preflight'] = adapter.preflight()
        manifest.update(adapter.describe())
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
        audit = open(out / 'audit.jsonl', 'a')
        for case, sha in cases:
            try:
                adapter.before_case()
            except A.AbortRun as e:
                aborted = str(e)
                break
            try:
                rec = run_case(case, sha, adapter, suite_dir, scratch, ocr_backend=ocr_backend)
            except A.AbortRun as e:
                aborted = str(e)
                break
            except Exception as e:  # noqa: BLE001 - e.g. a malformed case file: keep a failed record, go on
                rec = crash_record(case, sha, adapter, e)
            rec.update(run_id=run_id, harness_git_sha=manifest['harness_git']['sha'], config_hash=manifest['config_hash'])
            (out / (case['id'] + '.json')).write_text(json.dumps(rec, indent=2, ensure_ascii=False, sort_keys=True) + '\n')
            audit.write(canonical({'run_id': run_id, 'case_id': case['id'], 'case_sha256': sha, 'at': rec['started_at'],
                                   'forced': rec['forced'], **rec['action_audit']}) + '\n')
            audit.flush()
            records.append(rec)
            d = rec['decision']
            print('%s -> %s/%s%s %.1fs' % (case['id'], d['class'], d['action'], ' (forced)' if rec['forced'] else '', rec['wall']['total_s']), flush=True)
    except A.AbortRun as e:
        aborted = str(e)
    finally:
        manifest['aborted'] = aborted
        manifest['finish'] = adapter.finish()
        manifest['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        manifest['records_written'] = [r['case_id'] for r in records]
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True, default=str) + '\n')
    if aborted:
        print('ABORTED: ' + aborted, file=sys.stderr)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
