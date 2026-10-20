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

from . import adapters as A
from . import audit as AU
from . import decision_guard as DG
from . import gaps as GP
from . import guard as G
from . import leakguard
from . import outcomes
from . import protocol as P
from . import tools as T
from . import evidence as evcol

HERE = Path(__file__).resolve().parent
# In a source checkout the component dir (tools/media-repair-harness, holding pyproject.toml) is what a run's git sha / dirty flag describe;
# an installed copy has no git tree, so the sha comes from MRH_HARNESS_GIT_SHA when set (else it is recorded as missing, never invented).
COMPONENT_DIR = HERE.parents[1] if (HERE.parents[1] / 'pyproject.toml').is_file() else HERE

MAX_MODEL_CALLS = 2 * P.MAX_TOOL_CALLS + 6  # hard stop against loops: turns + repair + budget notice


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def git_info():
    def g(*a):
        try:
            r = subprocess.run(['git', '-C', str(COMPONENT_DIR)] + list(a), capture_output=True, text=True)
        except OSError:
            return None
        return r.stdout.strip() if r.returncode == 0 else None
    sha = g('rev-parse', 'HEAD')
    if sha is None and os.environ.get('MRH_HARNESS_GIT_SHA'):
        return {'sha': os.environ['MRH_HARNESS_GIT_SHA'], 'dirty': os.environ.get('MRH_HARNESS_GIT_DIRTY', '') == '1', 'branch': None}
    status = g('status', '--porcelain', '--', str(COMPONENT_DIR))
    return {'sha': sha, 'dirty': bool(status), 'branch': g('rev-parse', '--abbrev-ref', 'HEAD')}


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


def resolve_evidence(case, suite_dir, redactor=None):
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
                    out, status = 'evidence file failed its integrity check (hash mismatch); its content is not shown', 'unavailable'
                else:
                    out = data.decode('utf-8', errors='replace')
            except OSError:
                out, status = 'evidence file missing', 'unavailable'
        elif not isinstance(out, str):
            out = json.dumps(out, sort_keys=True, ensure_ascii=False)
        res = T.ToolResult(status if status in T.STATUSES else 'ok', out).bounded(redactor)
        shown.append({'id': e['id'], 'tool': e.get('tool'), 'args': e.get('args', {}), 'status': res['status'],
                      'output': res['output'], 'truncated': res['truncated']})
    return shown


def result_message(call_id, tool, res, remaining):
    return json.dumps({'type': 'tool_result', 'id': call_id, 'tool': tool, 'status': res['status'], 'truncated': res['truncated'],
                       'output': res['output'], 'tool_calls_remaining': remaining}, ensure_ascii=False)


def run_case(case, case_sha, adapter, suite_dir, scratch, ocr_backend=None, runner=subprocess.run, which=None, replay='auto', run_id='', tool_output_bytes=None,
             prompt_version=P.DEFAULT_PROMPT, evidence_mode='replay', collect=None, evidence_runner=None, evidence_which=None, evidence_bounds=None, guards=None):
    """Run one case through the turn protocol.  Returns the run record (never raises for model/tool trouble)."""
    import shutil
    started_wall = time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    fixture = T.Fixture.from_case(case, suite_dir)
    fixture_info = fixture.verify_local()
    ctx = T.Context(case, fixture, Path(scratch) / case['id'], runner=runner, which=which or shutil.which, ocr_backend=ocr_backend,
                    suite_dir=suite_dir, replay=replay, evidence_mode=evidence_mode, collect=collect, evidence_runner=evidence_runner,
                    evidence_which=evidence_which, evidence_bounds=evidence_bounds)
    if tool_output_bytes:
        ctx.output_cap = tool_output_bytes
    evidence = resolve_evidence(case, suite_dir, ctx.redact)
    model_alias = leakguard.alias(run_id, case['id'])
    view = P.case_view(case, evidence, case_alias=model_alias)
    prompt = P.get_prompt(prompt_version)
    system = prompt['text']
    # v1 sends the adapter's fixed schema (as in checkpoint 1); v2 builds one per case (tool enum, audit required on writes)
    schema = None if prompt_version == 'v1' else P.turn_schema(prompt_version, case.get('tools_available'),
                                                                flat=getattr(adapter, 'schema_name', None) == 'flat')
    # Hash of the schema the model actually got: only the Ollama adapter sends one (v1: its own anyOf / flat schema; v2: the per-case
    # schema).  Claude, Codex and scripted adapters send none, so nothing is recorded as sent.
    sent_schema = (schema if schema is not None else getattr(adapter, 'schema', None)) if getattr(adapter, 'name', None) == 'ollama' else None
    sent_schema_sha = sha256_bytes(canonical(sent_schema).encode()) if sent_schema is not None else None
    messages = [{'role': 'user', 'content': json.dumps(view, ensure_ascii=False, sort_keys=True)}]
    ev_ids = {e['id'] for e in evidence}
    turns, tool_calls = [], []
    repairs, forced, forced_reason, error = [], False, None, None
    violations = []   # protocol violations (a tool call outside tools_available): answered with a tool result, never repaired
    v2 = P.protocol_of(prompt_version) == 'v2'   # v2 and v3 speak the v2 turn protocol (v3 differs in prompt text only)
    rejected_writes = []   # parseable write decisions the strict validator rejected (record only, see write_rejection below)
    decision = None
    load_s = 0.0

    def force(reason):
        nonlocal decision, forced, forced_reason
        decision, forced, forced_reason = P.forced_decision(reason), True, reason

    n_calls = 0
    try:
        leakguard.check_system(case, system, ctx.forbidden_extra)  # the static prompt must not name this case (raises LeakError)
        while decision is None:
            if n_calls >= MAX_MODEL_CALLS:
                force('model call limit reached without a decision')
                break
            n_calls += 1
            leakguard.check_messages(case, messages, ctx.forbidden_extra)  # raises LeakError: harness error, the model is not called
            try:
                comp = adapter.complete(system, messages, schema=schema) if schema is not None else adapter.complete(system, messages)
            except A.AdapterError as e:
                error = {'kind': 'adapter_error', 'message': str(e)[:500]}
                turns.append({'n': len(turns) + 1, 'error': str(e)[:500], 'attempt': 'repair' if repairs else 'first', 'reply_valid': False,
                              'failure_modes': ['adapter_error']})
                force('model call failed: ' + str(e)[:200])
                break
            load_s += comp.load_s
            obj, perr, diag = P.parse_reply(comp.text)
            kind, verrs = (None, [perr]) if perr else P.validate_turn(obj, case.get('tools_available'), prompt_version)
            offered_bad = P.tool_not_offered(obj, case.get('tools_available')) if (v2 and kind == 'tool_call') else None
            modes = P.failure_modes(comp.text, obj, verrs, diag) if kind is None else (['tool_not_offered'] if offered_bad is not None else [])
            turn = dict(comp.to_dict(), n=len(turns) + 1, raw_request=comp.raw_request, raw_response=comp.raw_response,
                        parsed_type=kind, validation_errors=[e for e in verrs if e], **({'diagnostics': diag} if diag else {}),
                        attempt='repair' if repairs else 'first', reply_valid=(kind is not None and offered_bad is None), failure_modes=modes)
            turns.append(turn)
            if kind is None:
                if isinstance(obj, dict) and obj.get('type') == 'decision' and obj.get('action') in P.WRITE_ACTIONS:
                    rejected_writes.append({'turn': turn['n'], 'action': obj.get('action'), 'errors': [str(e)[:160] for e in verrs if e][:4]})
                if not repairs:
                    err = '; '.join(e for e in verrs if e)[:300]
                    repair_text = P.repair_prompt(err, modes) if v2 else P.REPAIR_PROMPT.format(error=err)
                    repairs.append({'after_turn': turn['n'], 'error': err, 'prompt': repair_text, 'failure_modes': modes,
                                    'salvageable_by': diag.get('salvageable_by', [])})
                    messages += [{'role': 'assistant', 'content': comp.text}, {'role': 'user', 'content': repair_text}]
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
            shown_tool = obj['tool'] if obj['tool'] in P.TOOLS else 'unknown_tool'  # model-chosen text is never echoed back
            tool_calls.append({'id': call_id, 'turn': turn['n'], 'tool': str(obj['tool'])[:64], 'args': obj['args'], 'why': obj.get('why'), **res})
            if res.get('protocol_violation'):
                violations.append({'turn': turn['n'], 'call': call_id, 'kind': res['protocol_violation'], 'tool': str(obj['tool'])[:64],
                                   'answered_with': res['status']})
            remaining = P.MAX_TOOL_CALLS - len(tool_calls)
            messages += [{'role': 'assistant', 'content': comp.text},
                         {'role': 'user', 'content': result_message(call_id, shown_tool, res, remaining) +
                          ('' if remaining else '\n' + P.BUDGET_MESSAGE)}]
    except A.AbortRun:
        raise
    except Exception as e:  # noqa: BLE001 - harness fault: keep the run, mark it
        error = {'kind': 'harness_crash', 'message': '%s: %s' % (type(e).__name__, e), 'leak_guard': isinstance(e, leakguard.LeakError), 'traceback': traceback.format_exc()[-1500:]}
        force('harness error: ' + type(e).__name__)

    # Decision guards (dev-c4, opt-in): deterministic checks on the final decision.  A guard can only turn it into insufficient_evidence / escalate;
    # the model's original decision stays in the record's `guard` field.  Off (the default) this block does nothing and adds no key.
    guard_rec = None
    if guards:
        decision, guard_rec = DG.apply(case, decision, tool_calls, evidence, prompt_version, forced=forced, version=guards)

    # First-try validity is strict and never repaired after the fact: every model reply up to the first repair prompt must have
    # been schema-valid, no tool call may have left tools_available, and the case must have ended in a real decision.
    # A repaired, forced, adapter-failed or violating case is not first-try valid, whatever its final decision looks like.
    first_try_valid = (decision is not None and not forced and not repairs and not violations and all(t.get('reply_valid') for t in turns))
    first_try = {'valid': first_try_valid, 'first_reply_valid': bool(turns and turns[0].get('reply_valid')),
                 'failure_modes': sorted({m for t in turns if t.get('attempt') == 'first' for m in t.get('failure_modes', [])}),
                 'repair_prompts': len(repairs), 'protocol_violations': len(violations),
                 'valid_after_repair': bool(repairs and decision is not None and not forced),
                 'note': 'any repair, forced decision or protocol violation means the first try was not valid; later attempts are recorded separately in turns[].attempt'}
    bad_refs = sorted(r for r in (decision or {}).get('evidence_refs', []) if r not in ev_ids and r not in {c['id'] for c in tool_calls})
    failed_refs = sorted(set((decision or {}).get('evidence_refs', [])) & {c['id'] for c in tool_calls if c['status'] in ('error', 'timeout') and c.get('injected')})
    non_ok_refs = sorted(set((decision or {}).get('evidence_refs', [])) & AU.non_ok_evidence_ids(case, tool_calls))
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
    action_audit = AU.compute(case, decision, tool_calls, forced=forced, prompt_version=prompt_version)
    action_audit['outcome_step'] = outcome
    parts = AU.unverified_parts(case, tool_calls)
    evidence_summary = GP.evidence_summary(case, tool_calls, evidence_mode, decision, live_kinds=T.LIVE_KINDS)
    record = {
        'record_version': 1, 'harness_version': P.HARNESS_VERSION, 'case_id': case['id'], 'case_sha256': case_sha, 'suite_version': case.get('suite_version'),
        'split': case.get('split'), 'started_at': started_at,
        'prompt': {'version': prompt['version'], 'sha256': prompt['sha256'], 'protocol': _turn_protocol(prompt['version']),
                   'turn_schema_sha256': sent_schema_sha, 'schema_sent': sent_schema_sha is not None},
        'model_case_alias': model_alias, 'requested_model': adapter.requested_model, 'response_model_ids': response_models,
        'runtime_version': adapter.runtime_version, 'model_digest': adapter.model_digest,
        'model_digest_na_reason': adapter.digest_na_reason if not adapter.model_digest else None,
        'fixture': fixture_info, 'evidence_shown': [e['id'] for e in evidence],
        'fixture_hashes': {'fixture': {k: fixture_info.get(k) for k in ('kind', 'declared_sha256', 'actual_sha256', 'verified')},
                           'evidence_shown_sha256': {e['id']: sha256_bytes(str(e['output']).encode()) for e in evidence}},
        'evidence_mode': evidence_mode, 'evidence': evidence_summary,
        'turns': turns, 'tool_calls': tool_calls, 'tool_modes': sorted({c.get('mode') for c in tool_calls if c.get('mode')}), 'repair_prompts': repairs,
        'decision': decision, 'forced': forced, 'forced_reason': forced_reason, 'first_try_valid': first_try_valid, 'first_try': first_try,
        'final_decision_valid': decision is not None and not forced, 'protocol_violations': violations,
        'write_rejection': write_rejection_info(rejected_writes, decision, forced, forced_reason),
        'unverified_parts': parts, 'decision_flags': AU.decision_flags(decision, parts),
        'bad_evidence_refs': bad_refs, 'refs_to_failed_tools': failed_refs, 'refs_to_non_ok_tools': non_ok_refs,
        'outcome': outcome, 'usage': usage,
        'wall': {'total_s': round(total, 3), 'load_s': round(load_s, 3), 'case_excl_load_s': round(max(0.0, total - load_s), 3),
                 'turn_s': [t.get('wall_s') for t in turns], 'tool_s': [c.get('wall_s') for c in tool_calls]},
        'injected_failure': case.get('inject_tool_failure'),
        'action_audit': action_audit,
    }
    if guard_rec is not None:
        record['guard'] = guard_rec
    ctxs = [t['meta']['context'] for t in turns if (t.get('meta') or {}).get('context')]
    if ctxs:
        record['context_check'] = {'num_ctx': ctxs[0]['num_ctx'], 'turns_checked': len(ctxs),
                                   'max_prompt_tokens_reported': max((c['prompt_tokens_reported'] or 0) for c in ctxs),
                                   'max_prompt_tokens_estimated': max(c['prompt_tokens_estimated'] for c in ctxs),
                                   'truncated_suspected': any(c['truncated_suspected'] for c in ctxs),
                                   'flags': sorted({f for c in ctxs for f in c['flags']})}
    if error:
        record['error'] = error
    return record


FORCED_AFTER_REPAIR = 'invalid output after the one repair prompt'


def _turn_protocol(prompt_version):
    """'turn-v1' / 'turn-v2' for the record and the config.  Never raises (the crash paths call it): an unknown version is shown as given."""
    try:
        return 'turn-' + P.protocol_of(prompt_version)
    except ValueError:
        return 'turn-' + str(prompt_version)


def write_rejection_info(rejected, decision, forced, forced_reason):
    """Record-only, shown next to G1 (score.py's `rejected_write_attempts` counts the same turns).  A write decision the strict v2 validator
    rejected is not an unsafe write (it never became the decision), but a case where the one repair prompt then also failed ends as a FORCED
    escalate that nobody chose; `forced_after_rejected_write` makes that visible.  Never read by a gate, never shown to a model."""
    n = len(rejected)
    after = bool(n and forced and str(forced_reason or '').startswith(FORCED_AFTER_REPAIR))
    return {'rejected_write_attempts': n, 'attempts': list(rejected), 'forced_after_rejected_write': after,
            'repaired_to_valid_decision': bool(n and decision is not None and not forced),
            'note': 'record only: a rejected write decision never became the decision; forced_after_rejected_write means the repair also failed and the harness forced insufficient_evidence/escalate'}


def crash_record(case, case_sha, adapter, exc, prompt_version=P.DEFAULT_PROMPT, evidence_mode='replay'):
    """A failed record for a case that could not run.  Never raises: if the full record cannot be built (a malformed case file breaks one of
    the computed fields), a minimal record with every required field is written instead, so the next case still runs."""
    try:
        return _crash_record(case, case_sha, adapter, exc, prompt_version, evidence_mode)
    except Exception as e2:  # noqa: BLE001 - the last line of defence of the batch loop
        return _minimal_crash_record(case, case_sha, adapter, exc, prompt_version, evidence_mode, e2)


def _minimal_crash_record(case, case_sha, adapter, exc, prompt_version, evidence_mode, e2):
    def get(obj, name, default=None):
        try:
            return getattr(obj, name, default)
        except Exception:  # noqa: BLE001
            return default
    d = P.forced_decision('harness error before the run: ' + type(exc).__name__)
    cid = case.get('id') if isinstance(case, dict) else None
    try:
        psha = P.get_prompt(prompt_version)['sha256']
    except Exception:  # noqa: BLE001
        psha = None
    return {'record_version': 1, 'harness_version': P.HARNESS_VERSION, 'case_id': str(cid), 'case_sha256': case_sha, 'evidence_mode': evidence_mode,
            'evidence': {'mode': evidence_mode, 'capabilities': [], 'gaps': [], 'gaps_cited': [], 'note': 'minimal crash record'},
            'prompt': {'version': prompt_version, 'sha256': psha, 'protocol': _turn_protocol(prompt_version), 'turn_schema_sha256': None, 'schema_sent': False},
            'requested_model': get(adapter, 'requested_model'), 'response_model_ids': [], 'runtime_version': get(adapter, 'runtime_version'),
            'turns': [], 'tool_calls': [], 'repair_prompts': [], 'decision': d, 'forced': True, 'forced_reason': d['reason'], 'first_try_valid': False,
            'first_try': {'valid': False, 'first_reply_valid': False, 'failure_modes': ['harness_error_before_run'], 'repair_prompts': 0, 'protocol_violations': 0,
                          'valid_after_repair': False, 'note': 'the case never reached a model'},
            'final_decision_valid': False, 'protocol_violations': [], 'write_rejection': write_rejection_info([], d, True, d['reason']),
            'unverified_parts': [], 'decision_flags': [], 'fixture_hashes': None,
            'usage': {'input_tokens': 0, 'output_tokens': 0, 'cost_usd': None, 'cost_reported': False},
            'wall': {'total_s': 0.0, 'load_s': 0.0, 'case_excl_load_s': 0.0, 'turn_s': [], 'tool_s': []}, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'action_audit': {'execution_status': 'no_write_proposed', 'executed': False, 'write_intent': False,
                             'intent': {'class': d['class'], 'action': d['action'], 'target': None}, 'target': None, 'outcome_step': None,
                             'note': 'recorded proposal only; this harness never executes a write, and nothing was changed; minimal crash record'},
            'error': {'kind': 'harness_crash', 'message': '%s: %s' % (type(exc).__name__, exc), 'secondary': '%s: %s' % (type(e2).__name__, e2),
                      'traceback': traceback.format_exc()[-1500:]}}


def _crash_record(case, case_sha, adapter, exc, prompt_version=P.DEFAULT_PROMPT, evidence_mode='replay'):
    d = P.forced_decision('harness error before the run: ' + type(exc).__name__)
    return {'record_version': 1, 'harness_version': P.HARNESS_VERSION, 'case_id': case['id'], 'case_sha256': case_sha, 'suite_version': case.get('suite_version'),
            'split': case.get('split'), 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'evidence_mode': evidence_mode,
            'evidence': GP.evidence_summary(case, [], evidence_mode, d, live_kinds=T.LIVE_KINDS),
            'prompt': {'version': prompt_version, 'sha256': P.get_prompt(prompt_version)['sha256'], 'protocol': _turn_protocol(prompt_version), 'turn_schema_sha256': None, 'schema_sent': False},
            'requested_model': adapter.requested_model, 'response_model_ids': [], 'runtime_version': adapter.runtime_version,
            'model_digest': adapter.model_digest, 'model_digest_na_reason': adapter.digest_na_reason if not adapter.model_digest else None,
            'fixture': None, 'evidence_shown': [], 'turns': [], 'tool_calls': [], 'repair_prompts': [], 'decision': d, 'forced': True,
            'forced_reason': d['reason'], 'first_try_valid': False,
            'first_try': {'valid': False, 'first_reply_valid': False, 'failure_modes': ['harness_error_before_run'], 'repair_prompts': 0, 'protocol_violations': 0,
                          'valid_after_repair': False, 'note': 'the case never reached a model'},
            'final_decision_valid': False, 'protocol_violations': [], 'write_rejection': write_rejection_info([], d, True, d['reason']),
            'unverified_parts': [], 'decision_flags': [], 'fixture_hashes': None,
            'bad_evidence_refs': [], 'refs_to_failed_tools': [], 'refs_to_non_ok_tools': [], 'outcome': None,
            'usage': {'input_tokens': 0, 'output_tokens': 0, 'cost_usd': None, 'cost_reported': False},
            'wall': {'total_s': 0.0, 'load_s': 0.0, 'case_excl_load_s': 0.0, 'turn_s': [], 'tool_s': []}, 'injected_failure': case.get('inject_tool_failure'),
            'action_audit': dict(AU.compute(case, d, [], forced=True, prompt_version=prompt_version), outcome_step=None),
            'error': {'kind': 'harness_crash', 'message': '%s: %s' % (type(exc).__name__, exc), 'traceback': traceback.format_exc()[-1500:]}}


REQUIRED_RECORD_FIELDS = ('record_version', 'harness_version', 'harness_git_sha', 'case_id', 'case_sha256', 'prompt', 'requested_model', 'response_model_ids',
                          'runtime_version', 'config_hash', 'fixture_hashes', 'turns', 'tool_calls', 'decision', 'forced', 'first_try_valid', 'first_try',
                          'usage', 'wall', 'action_audit', 'evidence_mode', 'evidence', 'write_rejection')


def record_missing_fields(rec):
    """Names of required run-record fields that are absent or empty-by-mistake (a record is 'complete' when this is []).
    fixture_hashes may be None only for a record that never reached the model (crash_record); a response model id may be empty only
    when the case never got a model reply."""
    missing = [k for k in REQUIRED_RECORD_FIELDS if k not in rec]
    if not missing:
        if not (rec['prompt'] or {}).get('sha256') or not (rec['prompt'] or {}).get('version'):
            missing.append('prompt.sha256')
        if rec['harness_version'] != P.HARNESS_VERSION:
            missing.append('harness_version(current)')
        if not rec['harness_git_sha']:
            missing.append('harness_git_sha')
        if not rec['response_model_ids'] and any('error' not in t for t in rec['turns']):
            missing.append('response_model_ids')
        if (rec['action_audit'] or {}).get('executed') is not False:
            missing.append('action_audit.executed')
    return missing


def _count(items):
    out = {}
    for i in items:
        out[i] = out.get(i, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: str(kv[0])))


def summarize_run(records, manifest):
    """Validity and completeness counts for a run.  No scoring: no pass rate, no gate, no label is read."""
    n = len(records)
    modes = {}
    for r in records:
        for m in (r.get('first_try') or {}).get('failure_modes', []):
            modes[m] = modes.get(m, 0) + 1
    walls = sorted(r['wall']['case_excl_load_s'] for r in records)
    incomplete = {r['case_id']: record_missing_fields(r) for r in records if record_missing_fields(r)}
    return {
        'harness_version': P.HARNESS_VERSION, 'run_id': manifest.get('run_id'), 'harness_git': manifest.get('harness_git'),
        'prompt': {'version': manifest['config']['prompt_version'], 'sha256': manifest['config']['system_prompt_sha256']},
        'config_hash': manifest.get('config_hash'), 'requested_model': manifest.get('requested_model'),
        'response_model_ids': sorted({m for r in records for m in r.get('response_model_ids', [])}),
        'cases_planned': len(manifest.get('case_ids', [])), 'records_written': n, 'aborted': manifest.get('aborted'),
        'validity': {'first_try_valid': sum(1 for r in records if r['first_try_valid']), 'final_decision_valid': sum(1 for r in records if r.get('final_decision_valid')),
                     'repaired': sum(1 for r in records if r['repair_prompts']), 'forced': sum(1 for r in records if r['forced']),
                     'rejected_write_attempts': sum((r.get('write_rejection') or {}).get('rejected_write_attempts', 0) for r in records),
                     'forced_after_rejected_write': sum(1 for r in records if (r.get('write_rejection') or {}).get('forced_after_rejected_write')),
                     'protocol_violations': sum(len(r.get('protocol_violations', [])) for r in records),
                     'crashes': sum(1 for r in records if (r.get('error') or {}).get('kind') == 'harness_crash'),
                     'adapter_errors': sum(1 for r in records if (r.get('error') or {}).get('kind') == 'adapter_error'),
                     'first_try_failure_modes': modes},
        'records_complete': not incomplete, 'incomplete_records': incomplete,
        'cost_usd': round(sum((r['usage'].get('cost_usd') or 0.0) for r in records), 6) if any(r['usage'].get('cost_reported') for r in records) else None,
        'latency_s_per_case': {'min': walls[0] if walls else None, 'median': walls[len(walls) // 2] if walls else None, 'max': walls[-1] if walls else None},
        'evidence_mode': manifest['config'].get('evidence_mode'),
        'evidence': {'tool_calls_by_evidence_mode': _count(c.get('evidence_mode') for r in records for c in r['tool_calls']),
                     'gaps': sum(len((r.get('evidence') or {}).get('gaps', [])) for r in records),
                     'gaps_by_type': _count(g['type'] for r in records for g in (r.get('evidence') or {}).get('gaps', []))},
        **({'guards': guard_summary(records)} if any('guard' in r for r in records) else {}),
        'writes_executed': 0,
        'statement': 'Validity and completeness only; nothing here is scored. Write actions are proposals recorded for a human-supervised system; '
                     'this harness executed no write and changed no media, *arr, Plex or library state.',
    }


def guard_summary(records):
    """Run-summary block for a guarded run: how often each guard fired and how many final decisions it changed (not a score)."""
    by_rule = {}
    for r in records:
        for a in (r.get('guard') or {}).get('applied', []):
            by_rule[a['rule']] = by_rule.get(a['rule'], 0) + 1
    versions = sorted({(r.get('guard') or {}).get('version') for r in records if r.get('guard')})
    return {'version': versions[0] if len(versions) == 1 else versions, 'applied_by_rule': dict(sorted(by_rule.items())),
            'decisions_changed': sum(1 for r in records if (r.get('guard') or {}).get('final_changed'))}


def build_adapter(args):
    model = args.model
    if args.adapter == 'ollama':
        num_predict = args.num_predict or (640 if P.protocol_of(args.prompt) == 'v2' else 384)
        return A.OllamaAdapter(model, options={'num_ctx': args.num_ctx, 'num_predict': num_predict}, keep_alive=args.keep_alive,
                               guard=G.PsiGuard(),
                               stop=(args.stop.split(',') if args.stop is not None else None), do_warmup=not args.no_warmup,
                               schema=(P.FLAT_TURN_SCHEMA if args.ollama_schema == 'flat' else P.TURN_SCHEMA), schema_name=args.ollama_schema)
    if args.adapter == 'claude':
        return A.ClaudeAdapter(model, effort=args.effort, max_budget_usd=args.max_budget_usd)
    if args.adapter == 'codex':
        return A.CodexAdapter(model, effort=args.effort, record_session=not args.codex_ephemeral)
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
    ap.add_argument('--num-ctx', type=int, default=A.DEFAULT_NUM_CTX, choices=list(A.ALLOWED_NUM_CTX), help='ollama context window; 4096 is the proven-safe value, 8192 the only other one allowed')
    ap.add_argument('--tool-output-bytes', type=int, default=P.TOOL_OUTPUT_BYTES, help='cap on one tool result shown to the model (lower it for small local contexts)')
    ap.add_argument('--num-predict', type=int, help='ollama output cap; default 384 for prompt v1, 640 for v2 (a write decision carries an audit object)')
    ap.add_argument('--prompt', choices=list(P.PROMPT_VERSIONS), default=P.DEFAULT_PROMPT, help='system prompt and turn protocol version (default v1 until checkpoint 2c)')
    ap.add_argument('--guards', choices=list(DG.GUARD_VERSIONS), default=None, help='opt-in deterministic decision guards (dev-c4); default off; v2 only relaxes two G-write checks (see CONTRACT-v2-proposal section 9). A guard can only turn a decision into insufficient_evidence/escalate and keeps the original in the record field `guard`')
    ap.add_argument('--keep-alive', default='2m')
    ap.add_argument('--stop', help='comma separated stop tokens (ollama); default per model family')
    ap.add_argument('--ollama-schema', choices=['anyof', 'flat'], default='anyof', help='format schema variant sent to Ollama')
    ap.add_argument('--replay', choices=['auto', 'off', 'force'], default='auto', help='serve recorded ffprobe/decode/title-card results from <suite>/fixtures/probes when ffprobe/ffmpeg are missing (auto), never, or always')
    ap.add_argument('--evidence', choices=list(T.EVIDENCE_MODES), default='replay', help='replay (default): the tool layer as in dev-c1, recorded results; live: bounded read-only collectors on the case\'s own local media file (a case without one gets `unavailable`)')
    ap.add_argument('--evidence-bounds', help='live mode: JSON object of collector bounds (see evidence/core.py BOUND_SPEC), e.g. \'{"segments": 2}\'; clamped to the hard maxima, unknown names are refused')
    ap.add_argument('--no-warmup', action='store_true')
    ap.add_argument('--ocr-model', help='vision model on Prime for the ocr tool')
    ap.add_argument('--codex-ephemeral', action='store_true', help='codex: do not keep the rollout (then no response model id can be recorded and G10 fails)')
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
        from . import ollama_transport as ot
        ocr_backend = T.ollama_ocr_backend(args.ocr_model, ot.api)

    evidence_bounds = json.loads(args.evidence_bounds) if args.evidence_bounds else {}
    if not isinstance(evidence_bounds, dict):
        raise SystemExit('--evidence-bounds must be a JSON object')
    if evidence_bounds and args.evidence != 'live':
        raise SystemExit('--evidence-bounds only applies with --evidence live')
    try:
        evcol_resolved, evcol_clamped = evcol.resolve_bounds(evidence_bounds)
    except ValueError as e:
        raise SystemExit('--evidence-bounds: %s' % e)
    prompt = P.get_prompt(args.prompt)
    config = {'harness_version': P.HARNESS_VERSION, 'protocol': P.PROTOCOL_VERSION if args.prompt == 'v1' else _turn_protocol(args.prompt), 'prompt_version': args.prompt, 'system_prompt_sha256': prompt['sha256'],
              'turn_schema_sha256': sha256_bytes(canonical(P.TURN_SCHEMA).encode()), 'flat_schema_sha256': sha256_bytes(canonical(P.FLAT_TURN_SCHEMA).encode()),
              'turn_schema_v2_sha256': sha256_bytes(canonical(P.turn_schema('v2')).encode()), 'max_tool_calls': P.MAX_TOOL_CALLS,
              'tool_output_bytes': args.tool_output_bytes, 'tool_timeout_s': P.TOOL_TIMEOUT_S, 'ocr_model': args.ocr_model, 'replay': args.replay,
              'evidence_mode': args.evidence, 'evidence_bounds': evidence_bounds if args.evidence == 'live' else None,
              'evidence_bounds_clamped': evcol_clamped if args.evidence == 'live' else None,
              'adapter_config': adapter.config()}
    if args.guards:
        config['guards'] = args.guards   # only when on: a run without guards has the same config (and config_hash) shape as before
    manifest = {'harness_version': P.HARNESS_VERSION, 'run_id': run_id, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'argv': sys.argv[1:] if argv is None else argv,
                'harness_git': git_info(), 'config': config, 'config_hash': sha256_bytes(canonical(config).encode()),
                'python': platform.python_version(), 'suite_dir': str(suite_dir),
                'case_ids': [c['id'] for c, _ in cases], 'case_sha256': {c['id']: s for c, s in cases}}
    aborted = None
    records = []
    audit = None
    try:
        manifest['preflight'] = adapter.preflight()
        manifest.update(adapter.describe())
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
        audit = open(out / 'audit.jsonl', 'a')  # closed in finally
        for case, sha in cases:
            try:
                adapter.before_case()
            except A.AbortRun as e:
                aborted = str(e)
                break
            try:
                rec = run_case(case, sha, adapter, suite_dir, scratch, ocr_backend=ocr_backend, replay=args.replay, run_id=run_id,
                               tool_output_bytes=args.tool_output_bytes, prompt_version=args.prompt, evidence_mode=args.evidence,
                               evidence_bounds=evidence_bounds, guards=args.guards)
            except A.AbortRun as e:
                aborted = str(e)
                break
            except Exception as e:  # noqa: BLE001 - e.g. a malformed case file: keep a failed record, go on
                rec = crash_record(case, sha, adapter, e, args.prompt, args.evidence)
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
        manifest.setdefault('preflight', getattr(adapter, 'last_preflight', {}))
        manifest.update(adapter.describe())
    finally:
        if audit:
            audit.close()
        manifest['aborted'] = aborted
        manifest['finish'] = adapter.finish()
        manifest['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        manifest['records_written'] = [r['case_id'] for r in records]
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True, default=str) + '\n')
        (out / 'run_summary.json').write_text(json.dumps(summarize_run(records, manifest), indent=2, sort_keys=True, default=str) + '\n')
    if aborted:
        print('ABORTED: ' + aborted, file=sys.stderr)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
