#!/usr/bin/env python3
"""Unified runner: `run.py --suite <cases dir> --adapter ollama|claude|codex|scripted --model <id> [--cases a,b] --out runs/<run-id>`

Implements the CONTRACT.md turn protocol and writes one run record per case (failed runs included), an
action-audit line per case and a run manifest.  Tools are read-only; write actions in a decision are only
recorded as intents and never executed.
"""
import argparse
import copy
import datetime
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

from . import adapters as A
from . import audit as AU
from . import decision_guard as DG
from . import evidence_v2 as EV2
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


def resolve_evidence_raw(case, suite_dir, redactor=None, literal_epub=False):
    """Pre-collected evidence for evidence format v2: the same resolution (refs verified against their sha256, fixture names redacted) WITHOUT the
    legacy 8 KiB cut, because the typed layer cuts nothing by itself (it paginates).  Output is always text."""
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
        status = status if status in T.STATUSES else 'ok'
        parsed = None
        if literal_epub and e.get('tool') == 'epub_inspect':
            try:
                parsed = json.loads(out)
            except ValueError:
                parsed = None
        if redactor and isinstance(parsed, dict):
            # format v3.1-format (AUDIT-ASTRA-28 item 1): recorded EPUB evidence gets the tools-v3 handling: locators aliased, text read from the media kept as
            # recorded (never rewritten into the display name); the leak guard (leakguard-media-2) decides whether it may be sent.  Provenance stays recorded.
            inner, put = T._unwrap_recorded(parsed)
            out = json.dumps(put(T.epub_v3_redact(inner, redactor)), sort_keys=True, ensure_ascii=False)
        elif redactor:
            out = redactor(out)
        shown.append({'id': e['id'], 'tool': e.get('tool'), 'args': e.get('args', {}), 'status': status, 'output': out, 'truncated': False})
    return shown


# Option versions added by W18.  `--evidence-format v2` (typed evidence, tools behaviour v2, audit v2) goes with prompt v4 and v5 (v5 requires it) and with
# guards off or v3; `--guards v3` goes with any prompt.  Every other combination of a new option is refused up front, never silently reinterpreted.
EVIDENCE_FORMATS = ('v2', 'v3', 'v3.1-format')
EVIDENCE_V2_PROMPTS = ('v4', 'v5')
EVIDENCE_V2_ONLY_PROMPTS = ('v5',)   # dev-c5: v5 explains the format v2 fields, so it is refused with the legacy format (v1 to v4 are unchanged)
EVIDENCE_V2_GUARDS = (None, 'v3')
# dev-c6: contract v3 is ONE version -- evidence format v3, turn protocol turn-v3, decision schema decision-v3 and audit v3 -- selected together by
# `--evidence-format v3` and valid only with a prompt that declares it (v6).  Guards v3 (or none) apply unchanged: G-healthy reads the class, the action and
# the shown observations, G-write the class, the action, evidence_refs and the context; neither reads the target, so contract v3 needs no new guard version.
CONTRACT_V3_PROMPTS = ('v6',)
CONTRACT_V3_GUARDS = (None, 'v3')
# dev-c7: evidence format v3.1-format (named so it cannot be confused with rubric v3.1) is contract v3 with tools behaviour v3 (EPUB body excerpts), the v3.1
# presentation (statement kinds, prior-record typing) and the rubric v3.2 clarification, selected together and valid only with prompt v7 (and guards off or v3).
CONTRACT_V31_FORMAT = 'v3.1-format'
CONTRACT_V31_PROMPTS = ('v7',)


def _ev3():
    """evidence_v3 (contract v3), imported only by a run that selects it: every other configuration never imports the contract-v3 modules."""
    from . import evidence_v3
    return evidence_v3


def _ev31():
    """evidence_v31 (format v3.1-format), imported only by a run that selects it."""
    from . import evidence_v31
    return evidence_v31


def check_option_combination(prompt_version, evidence_format=None, guards=None, tool_output_bytes=None):
    """Raise ValueError (main turns it into a SystemExit) for an unsupported combination of the W18 options."""
    if evidence_format is not None and evidence_format not in EVIDENCE_FORMATS:
        raise ValueError('unknown evidence format %r (known: %s; unset keeps the legacy format)' % (evidence_format, ', '.join(EVIDENCE_FORMATS)))
    if prompt_version in CONTRACT_V31_PROMPTS and evidence_format != CONTRACT_V31_FORMAT:
        raise ValueError('--prompt %s states the v3.1-format presentation (EPUB body excerpts, statement kinds, rubric v3.2) and is valid only with --evidence-format %s (got %s)' % (
            prompt_version, CONTRACT_V31_FORMAT, evidence_format or 'the legacy format'))
    if evidence_format == CONTRACT_V31_FORMAT:
        if prompt_version not in CONTRACT_V31_PROMPTS:
            raise ValueError('--evidence-format %s (tools behaviour v3, the v3.1 presentation, turn-v3, decision-v3 and audit v3 are one version) is accepted with prompt %s only (got %s)' % (
                CONTRACT_V31_FORMAT, ' or '.join(CONTRACT_V31_PROMPTS), prompt_version))
        if guards not in CONTRACT_V3_GUARDS:
            raise ValueError('--evidence-format %s is accepted with guards off or --guards v3 only (got --guards %s)' % (CONTRACT_V31_FORMAT, guards))
        if tool_output_bytes is not None and not EV2.MIN_WIRE_BYTES <= tool_output_bytes <= EV2.WIRE_BYTES:     # the same page contract (pages-v1)
            raise ValueError('--evidence-format %s uses --tool-output-bytes as the page budget (a message is paginated to fit it): it must be between %d and %d, got %s' % (
                CONTRACT_V31_FORMAT, EV2.MIN_WIRE_BYTES, EV2.WIRE_BYTES, tool_output_bytes))
        return
    if prompt_version in CONTRACT_V3_PROMPTS and evidence_format != 'v3':
        raise ValueError('--prompt %s declares contract v3 (decision-v3 targets, the v3 presentation) and is valid only with --evidence-format v3 (got %s)' % (
            prompt_version, evidence_format or 'the legacy format'))
    if evidence_format == 'v3':
        if prompt_version not in CONTRACT_V3_PROMPTS:
            raise ValueError('--evidence-format v3 is contract v3 (format v3, turn-v3, decision-v3 and audit v3 are one version) and is accepted with prompt %s only (got %s): '
                             'the earlier prompts describe the v2 contract%s' % (' or '.join(CONTRACT_V3_PROMPTS), prompt_version,
                                                                                ', and v5 explains evidence format v2 with the v2 target semantics' if prompt_version == 'v5' else ''))
        if guards not in CONTRACT_V3_GUARDS:
            raise ValueError('--evidence-format v3 is accepted with guards off or --guards v3 only (got --guards %s)' % guards)
        if tool_output_bytes is not None and not EV2.MIN_WIRE_BYTES <= tool_output_bytes <= EV2.WIRE_BYTES:     # the same page contract (pages-v1)
            raise ValueError('--evidence-format v3 uses --tool-output-bytes as the page budget (a message is paginated to fit it): it must be between %d and %d, got %s' % (
                EV2.MIN_WIRE_BYTES, EV2.WIRE_BYTES, tool_output_bytes))
        return
    if prompt_version in EVIDENCE_V2_ONLY_PROMPTS and evidence_format != 'v2':
        raise ValueError('--prompt %s is valid only with --evidence-format v2 (it describes the typed evidence of format v2, which the legacy tool-result shape does not have)' % prompt_version)
    if evidence_format == 'v2':
        if prompt_version not in EVIDENCE_V2_PROMPTS:
            raise ValueError('--evidence-format v2 is accepted with prompt %s only (got %s): the earlier prompts describe the legacy tool-result shape' % (' or '.join(EVIDENCE_V2_PROMPTS), prompt_version))
        if guards not in EVIDENCE_V2_GUARDS:
            raise ValueError('--evidence-format v2 is accepted with guards off or --guards v3 only (got --guards %s)' % guards)
        if tool_output_bytes is not None and not EV2.MIN_WIRE_BYTES <= tool_output_bytes <= EV2.WIRE_BYTES:
            raise ValueError('--evidence-format v2 uses --tool-output-bytes as the page budget (a message is paginated to fit it): it must be between %d and %d, got %s' % (EV2.MIN_WIRE_BYTES, EV2.WIRE_BYTES, tool_output_bytes))


safe_args = EV2.safe_args


def is_cursor_call(args):
    return isinstance(args, dict) and set(args) == {'cursor'} and isinstance(args['cursor'], str)


def make_resolver(case, tool_calls, session):
    """The runner's use of the one resolver (`evidence_v2.reference_resolver`); the legacy format never rewrites a reference."""
    if session is None:
        return lambda refs: list(refs or [])
    known = {e['id'] for e in case.get('evidence', [])} | {c['id'] for c in tool_calls}
    return EV2.reference_resolver(known, session.finding_index(), EV2.page_origin_map(tool_calls))


def result_message(call_id, tool, res, remaining):
    return json.dumps({'type': 'tool_result', 'id': call_id, 'tool': tool, 'status': res['status'], 'truncated': res['truncated'],
                       'output': res['output'], 'tool_calls_remaining': remaining}, ensure_ascii=False)


def run_case(case, case_sha, adapter, suite_dir, scratch, ocr_backend=None, runner=subprocess.run, which=None, replay='auto', run_id='', tool_output_bytes=None,
             prompt_version=P.DEFAULT_PROMPT, evidence_mode='replay', collect=None, evidence_runner=None, evidence_which=None, evidence_bounds=None, guards=None,
             evidence_format=None):
    """Run one case through the turn protocol.  Returns the run record (never raises for model/tool trouble)."""
    import shutil
    check_option_combination(prompt_version, evidence_format, guards, tool_output_bytes)
    v31fmt = evidence_format == CONTRACT_V31_FORMAT
    v3fmt = evidence_format == 'v3' or v31fmt     # contract v3: turn-v3, decision-v3, audit v3 (format v3 or v3.1-format)
    v2fmt = evidence_format == 'v2' or v3fmt   # the typed formats share tools behaviour v2, raw outputs, pagination and the reference resolver
    EV3 = (_ev31() if v31fmt else _ev3()) if v3fmt else None
    started_wall = time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    fixture = T.Fixture.from_case(case, suite_dir)
    fixture_info = fixture.verify_local()
    ctx = T.Context(case, fixture, Path(scratch) / case['id'], runner=runner, which=which or shutil.which, ocr_backend=ocr_backend,
                    suite_dir=suite_dir, replay=replay, evidence_mode=evidence_mode, collect=collect, evidence_runner=evidence_runner,
                    evidence_which=evidence_which, evidence_bounds=evidence_bounds, tools_behavior=('v3' if v31fmt else 'v2') if v2fmt else 'v1',
                    keep_raw=v2fmt)
    if tool_output_bytes:
        ctx.output_cap = tool_output_bytes
    model_alias = leakguard.alias(run_id, case['id'])
    session = None
    wire_budget = min(EV2.WIRE_BYTES, tool_output_bytes) if tool_output_bytes else EV2.WIRE_BYTES   # --tool-output-bytes is the page budget under format v2
    if v2fmt:
        evidence = resolve_evidence_raw(case, suite_dir, ctx.redact, literal_epub=v31fmt)
        view = P.case_view(case, [], case_alias=model_alias)
        caps = T.capabilities(ctx)
        if v3fmt:
            session = EV3.Session(model_alias, view['context'], view['media_type'], view['tools_available'], caps, budget=wire_budget)
        else:
            session = EV2.Session(model_alias, view['context'], view['media_type'], view['tools_available'], budget=wire_budget)
        frame = {'case_id': view['case_id'], 'media_type': view['media_type'], 'context': view['context'], 'tools_available': view['tools_available'],
                 'tool_call_budget': view['tool_call_budget'], 'capabilities': caps, 'evidence_format': EV3.FORMAT_VERSION if v3fmt else EV2.FORMAT_VERSION}
        block, _npages = session.initial([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence], frame)
        view = dict(frame, evidence=block)   # the first message as a whole is what the 8192-byte budget was applied to
    else:
        evidence = resolve_evidence(case, suite_dir, ctx.redact)
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
    messages = [{'role': 'user', 'content': (json.dumps(view, ensure_ascii=False, separators=(',', ':')) if v2fmt else json.dumps(view, ensure_ascii=False, sort_keys=True))}]
    # format v3.1-format: the leak guard is leakguard-media-2: the legacy check on each message's harness-only shadow, the media check on the media strings delivered
    # so far (with their fields and ranges); every other configuration keeps the legacy check on the delivered messages
    media_sources, guard_alt, visible_context = [], {}, json.dumps(view.get('context') or {}, ensure_ascii=False)
    if v31fmt:
        for e in evidence:
            if e.get('tool') == 'epub_inspect':
                try:
                    media_sources += T.epub_v3_sources(json.loads(e['output']), e['id'])
                except ValueError:
                    pass
        if session.last_shadow is not None:
            guard_alt[0] = session.last_shadow
    ev_ids = {e['id'] for e in evidence}
    turns, tool_calls = [], []
    repairs, forced, forced_reason, error = [], False, None, None
    violations = []   # protocol violations (a tool call outside tools_available): answered with a tool result, never repaired
    v2 = P.protocol_of(prompt_version) in P.V2_TURN_PROTOCOLS   # prompts v2 to v5 speak the v2 turn protocol; v6 speaks turn-v3, which keeps the v2 turn rules and changes the decision
    rejected_writes = []   # parseable write decisions the strict validator rejected (record only, see write_rejection below)
    decision = None
    load_s = 0.0

    def force(reason):
        nonlocal decision, forced, forced_reason
        decision, forced, forced_reason = P.forced_decision_for(prompt_version, reason), True, reason

    n_calls = 0
    try:
        leakguard.check_system(case, system, ctx.forbidden_extra)  # the static prompt must not name this case (raises LeakError)
        while decision is None:
            if n_calls >= MAX_MODEL_CALLS:
                force('model call limit reached without a decision')
                break
            n_calls += 1
            if v31fmt:
                guarded = [dict(m, content=guard_alt[i]) if i in guard_alt else m for i, m in enumerate(messages)]
                leakguard.check_messages_media2(case, guarded, media_sources, visible_context, ctx.forbidden_extra)   # raises LeakError, as below
            else:
                leakguard.check_messages(case, messages, ctx.forbidden_extra)  # raises LeakError: harness error, the model is not called
            try:
                comp = adapter.complete(system, messages, schema=schema) if schema is not None else adapter.complete(system, messages)
            except A.AdapterError as e:
                error = {'kind': 'adapter_error', 'message': str(e)[:500]}
                turns.append({'n': len(turns) + 1, 'error': str(e)[:500], 'attempt': 'repair' if repairs else 'first', 'reply_valid': False,
                              'failure_modes': ['adapter_error'],
                              **({'usage': e.usage or {'cost_usd': e.cost_usd}} if (getattr(e, 'usage', None) or getattr(e, 'cost_usd', None) is not None) else {})})   # the failed call's own receipt (tokens, cost) is kept
                force('model call failed: ' + str(e)[:200])
                break
            load_s += comp.load_s
            obj, perr, diag = P.parse_reply(comp.text)
            kind, verrs = (None, [perr]) if perr else P.validate_turn(obj, case.get('tools_available'), prompt_version)
            offered_bad = P.tool_not_offered(obj, case.get('tools_available')) if (v2 and kind == 'tool_call') else None
            modes = P.failure_modes_for(prompt_version, comp.text, obj, verrs, diag) if kind is None else (['tool_not_offered'] if offered_bad is not None else [])
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
            remaining = P.MAX_TOOL_CALLS - len(tool_calls) - 1
            suffix = '' if remaining else '\n' + P.BUDGET_MESSAGE
            if v2fmt and is_cursor_call(obj['args']) and obj['tool'] in (case.get('tools_available') or []) and obj['tool'] in P.TOOLS:
                # a page fetch: not a tool run, but one of the 6 calls (stated in the page object); served from the pages this case's own session holds
                status, text = session.fetch(obj['args']['cursor'], call_id, obj['tool'], remaining, suffix)
                origins, origin_status = session.page_origin(obj['args']['cursor'])
                page_call = {'id': call_id, 'turn': turn['n'], 'tool': 'page', 'args': safe_args(obj['args']), 'why': obj.get('why'), 'status': origin_status if origins else status,
                             'output': text, 'truncated': False, 'mode': 'pages', 'continuation': True, 'continuation_via': obj['tool'],
                             'evidence_mode': ctx.evidence_mode, 'wall_s': 0.0}
                if origins:       # a page is the result it pages: it carries that result's id and status, it is never an ok result of its own
                    page_call['pages_of'] = origins
                tool_calls.append(page_call)
                messages += [{'role': 'assistant', 'content': comp.text}, {'role': 'user', 'content': text}]
                if v31fmt and session.page_shadow.get(obj['args']['cursor']) is not None:
                    guard_alt[len(messages) - 1] = session.page_shadow[obj['args']['cursor']]     # a page of a media result: its harness-only shadow
                continue
            res = T.call_tool(ctx, obj['tool'], obj['args'])
            if v31fmt and obj['tool'] == 'epub_inspect':
                try:
                    parsed = json.loads(res.get('raw_output', res['output']))
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict):
                    media_sources += T.epub_v3_sources(parsed, call_id)
            shown_tool = obj['tool'] if obj['tool'] in P.TOOLS else 'unknown_tool'  # model-chosen text is never echoed back
            tool_calls.append({'id': call_id, 'turn': turn['n'], 'tool': str(obj['tool'])[:64], 'args': obj['args'], 'why': obj.get('why'), **res})
            if res.get('protocol_violation'):
                violations.append({'turn': turn['n'], 'call': call_id, 'kind': res['protocol_violation'], 'tool': str(obj['tool'])[:64],
                                   'answered_with': res['status']})
            remaining = P.MAX_TOOL_CALLS - len(tool_calls)
            if v2fmt:
                o2 = EV2.make_observation(call_id, shown_tool, safe_args(obj['args']), res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool',
                                          res.get('collector_truncated'))
                text, _np = session.result(o2, call_id, remaining, '' if remaining else '\n' + P.BUDGET_MESSAGE)
                messages += [{'role': 'assistant', 'content': comp.text}, {'role': 'user', 'content': text}]
                if v31fmt and session.last_shadow is not None:
                    guard_alt[len(messages) - 1] = session.last_shadow
            else:
                messages += [{'role': 'assistant', 'content': comp.text},
                             {'role': 'user', 'content': result_message(call_id, shown_tool, res, remaining) +
                              ('' if remaining else '\n' + P.BUDGET_MESSAGE)}]
    except A.AbortRun as e:
        fc = getattr(e, 'failed_call', None)    # the call that triggered the abort (a CLI stopped at its lowered budget) keeps its receipt
        if fc:
            turns.append({'n': len(turns) + 1, 'error': fc['error'], 'attempt': 'repair' if repairs else 'first', 'reply_valid': False,
                          'failure_modes': ['adapter_error', 'cost_cap_budget_exceeded'], **({'usage': fc['usage']} if fc.get('usage') else {})})
        # a STARTED case that the run's abort cut short is never lost: turns, tool calls, usage and the reason travel with the exception (main writes them to started-aborted/)
        e.partial = started_aborted_record(case, case_sha, adapter, prompt, run_id, started_at, time.monotonic() - started_wall, turns, tool_calls, repairs, str(e),
                                           evidence_mode, evidence_format)
        raise
    except Exception as e:  # noqa: BLE001 - harness fault: keep the run, mark it
        error = {'kind': 'harness_crash', 'message': '%s: %s' % (type(e).__name__, e), 'leak_guard': isinstance(e, leakguard.LeakError), 'traceback': traceback.format_exc()[-1500:]}
        force('harness error: ' + type(e).__name__)

    # Decision guards (dev-c4, opt-in): deterministic checks on the final decision.  A guard can only turn it into insufficient_evidence / escalate;
    # the model's original decision stays in the record's `guard` field.  Off (the default) this block does nothing and adds no key.
    guard_rec = None
    resolve = make_resolver(case, tool_calls, session)
    if guards:
        # the guards read references through the same resolver as the record: they see the decision with its references normalised, the record keeps the original
        final, guard_rec = DG.apply(case, decision, tool_calls, evidence, prompt_version, forced=forced, version=guards, resolve=resolve if v2fmt else None)
        decision = final

    # First-try validity is strict and never repaired after the fact: every model reply up to the first repair prompt must have
    # been schema-valid, no tool call may have left tools_available, and the case must have ended in a real decision.
    # A repaired, forced, adapter-failed or violating case is not first-try valid, whatever its final decision looks like.
    first_try_valid = (decision is not None and not forced and not repairs and not violations and all(t.get('reply_valid') for t in turns))
    first_try = {'valid': first_try_valid, 'first_reply_valid': bool(turns and turns[0].get('reply_valid')),
                 'failure_modes': sorted({m for t in turns if t.get('attempt') == 'first' for m in t.get('failure_modes', [])}),
                 'repair_prompts': len(repairs), 'protocol_violations': len(violations),
                 'valid_after_repair': bool(repairs and decision is not None and not forced),
                 'note': 'any repair, forced decision or protocol violation means the first try was not valid; later attempts are recorded separately in turns[].attempt'}
    call_ids = {c['id'] for c in tool_calls}
    refs_checked = resolve((decision or {}).get('evidence_refs', []))
    bad_refs = sorted(r for r in refs_checked if r not in ev_ids and r not in call_ids)
    failed_refs = sorted(set(refs_checked) & {c['id'] for c in tool_calls if c['status'] in ('error', 'timeout') and c.get('injected')})
    non_ok_refs = sorted(set(refs_checked) & AU.non_ok_evidence_ids(case, tool_calls))
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
    if v3fmt:
        # audit v3 (contract v3): every diagnosis, action and role prerequisite with its state; a record, never a verdict (it changes no decision)
        action_audit = EV3.action_audit(dict(decision, evidence_refs=refs_checked), evidence, tool_calls, view['context'], view['media_type'], caps, forced=forced)
    elif v2fmt:
        audited = dict(decision, evidence_refs=refs_checked)   # a finding id (t2.f1) cites its observation (t2); the decision itself is recorded as the model wrote it
        action_audit = AU.compute(case, audited, tool_calls, forced=forced, prompt_version=prompt_version, audit_version='v2', shown=evidence)
    else:
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
    if v3fmt:
        record['evidence_format'] = EV3.format_record(session, caps, evidence_format)
    elif v2fmt:
        record['evidence_format'] = evidence_format_record(session, caps, evidence_format)
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


def evidence_format_record(session, caps, version):
    """Record field of a format-v2 run (absent in a legacy run): the versions, the capability advertisement, the pages and sizes actually sent, and the
    final coverage matrix and client comparison over everything shown.  The typed objects themselves are in turns[].raw_request (what was sent) and the
    raw tool text in tool_calls[].raw_output (what was derived from)."""
    try:
        an = session.analysis()
        summary = {'coverage': an['coverage'], 'client_comparison': an['client']}
    except Exception as e:  # noqa: BLE001 - a summary failure must not lose the run
        summary = {'error': '%s: %s' % (type(e).__name__, e)}
    return {'version': version, 'format_contract': EV2.FORMAT_VERSION, 'page_contract': EV2.PAGE_CONTRACT, 'wire_bytes': session.budget, 'tools_behavior': 'v2',
            'audit_version': 'v2', 'capabilities': caps, 'messages': list(session.log), 'final_summary': summary,
            'note': 'derived only from the observations shown to the model; no truth, label, provenance or hidden injection field is an input'}


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


def started_aborted_record(case, case_sha, adapter, prompt, run_id, started_at, wall_s, turns, tool_calls, repairs, reason, evidence_mode, evidence_format):
    """What a case that STARTED (the model was shown it, at least one call may have been made) leaves behind when the run is aborted under it: everything observed so far.
    It has no decision and is not a run record: it is written under `started-aborted/` where the scorer does not read it, so the case is listed as unscored (see PREREGISTRATION)."""
    usage = {'model_calls': sum(1 for t in turns if 'usage' in t or 'error' in t), 'input_tokens': 0, 'output_tokens': 0, 'cost_usd': 0.0, 'cost_reported_calls': 0}
    for t in turns:
        u = t.get('usage') or {}
        usage['input_tokens'] += u.get('input_tokens') or 0
        usage['output_tokens'] += u.get('output_tokens') or 0
        c = u.get('cost_usd') if u.get('cost_usd') is not None else t.get('cost_usd')
        if c is not None:
            usage['cost_usd'] += c
            usage['cost_reported_calls'] += 1
    usage['cost_usd'] = round(usage['cost_usd'], 6)
    return {'record_version': 1, 'status': 'started_aborted', 'scored': False, 'abort_reason': reason, 'case_id': case['id'], 'case_sha256': case_sha,
            'harness_version': P.HARNESS_VERSION, 'run_id': run_id, 'started_at': started_at, 'wall_s': round(wall_s, 3), 'evidence_mode': evidence_mode,
            'evidence_format': evidence_format, 'prompt': {'version': prompt['version'], 'sha256': prompt['sha256']},
            'requested_model': getattr(adapter, 'requested_model', None),
            'response_model_ids': sorted({t.get('response_model') for t in turns if t.get('response_model')}),
            'usage': usage, 'turns': turns, 'tool_calls': tool_calls, 'repair_prompts': repairs}


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
    try:
        d = P.forced_decision_for(prompt_version, 'harness error before the run: ' + type(exc).__name__)
    except Exception:  # noqa: BLE001 - an unknown prompt version: the v1/v2 shape
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
    d = P.forced_decision_for(prompt_version, 'harness error before the run: ' + type(exc).__name__)
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


def summarize_run(records, manifest, partials=()):
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
        'started_aborted': [p['case_id'] for p in partials], 'never_started': manifest.get('never_started', []),
        'validity': {'first_try_valid': sum(1 for r in records if r['first_try_valid']), 'final_decision_valid': sum(1 for r in records if r.get('final_decision_valid')),
                     'repaired': sum(1 for r in records if r['repair_prompts']), 'forced': sum(1 for r in records if r['forced']),
                     'rejected_write_attempts': sum((r.get('write_rejection') or {}).get('rejected_write_attempts', 0) for r in records),
                     'forced_after_rejected_write': sum(1 for r in records if (r.get('write_rejection') or {}).get('forced_after_rejected_write')),
                     'protocol_violations': sum(len(r.get('protocol_violations', [])) for r in records),
                     'crashes': sum(1 for r in records if (r.get('error') or {}).get('kind') == 'harness_crash'),
                     'adapter_errors': sum(1 for r in records if (r.get('error') or {}).get('kind') == 'adapter_error'),
                     'first_try_failure_modes': modes},
        'records_complete': not incomplete, 'incomplete_records': incomplete,
        'cost_usd': (round(sum((r['usage'].get('cost_usd') or 0.0) for r in records) + sum(p['usage']['cost_usd'] for p in partials), 6)
                     if any(r['usage'].get('cost_reported') for r in records) or any(p['usage']['cost_reported_calls'] for p in partials) else None),
        'latency_s_per_case': {'min': walls[0] if walls else None, 'median': walls[len(walls) // 2] if walls else None, 'max': walls[-1] if walls else None},
        'evidence_mode': manifest['config'].get('evidence_mode'),
        'evidence': {'tool_calls_by_evidence_mode': _count(c.get('evidence_mode') for r in records for c in r['tool_calls']),
                     'gaps': sum(len((r.get('evidence') or {}).get('gaps', [])) for r in records),
                     'gaps_by_type': _count(g['type'] for r in records for g in (r.get('evidence') or {}).get('gaps', []))},
        **({'guards': guard_summary(records)} if any('guard' in r for r in records) else {}),
        **({'limit_violations': manifest['limit_violations']} if manifest.get('limit_violations') else {}),
        **({'evidence_format': manifest['config']['evidence_format']} if manifest['config'].get('evidence_format') else {}),
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


class RunLimits:
    """Opt-in ENFORCED caps on a whole run (dev-c5, W19): `--max-total-cost-usd` and `--max-wall-s`.  Both stop the run cleanly with an AbortRun (exit 3, `aborted` in the
    manifest); a case that was started is kept as a started-aborted record, a case that was not is listed as never started; the adapter's `finish()` still runs.

    COST.  Enforced against the REMAINING budget before every model call: the call is not made when nothing remains or when the dearest call so far would not fit, and a
    Claude call's own `--max-budget-usd` is lowered to the remainder.  The cost of a failed call counts when its payload reports one.  When a cap is set and a call reports NO
    cost (a timeout, a non-JSON failure, a missing field) the run stops at the next check and says so: an unmetered spend cannot be kept under a cap.  A single call can still
    overshoot the cap by what that one call costs (bounded by its clamped CLI budget); that is the registered worst case.
    WALL.  One absolute deadline, counted from just before the adapter's preflight (the model load and warm-up are inside it).  A model call is not started unless its whole
    timeout (the adapter's `call_timeout` / `timeout`) fits before the deadline, so no call runs past it; the only work after the deadline is the cleanup (`finish()`, an unload
    request of at most 60 s) and replayed tool work, which is milliseconds.  `limits_state.elapsed_after_cleanup_s` records the true end.
    With neither cap set the runner is unchanged."""

    def __init__(self, max_cost_usd=None, max_wall_s=None, clock=time.monotonic):
        self.max_cost_usd, self.max_wall_s, self.clock = max_cost_usd, max_wall_s, clock
        self.started = None
        self.cost = 0.0
        self.max_call_cost = 0.0
        self.calls = 0
        self.unreported = None
        self.stopped = None

    @property
    def enabled(self):
        return self.max_cost_usd is not None or self.max_wall_s is not None

    def config(self):
        return {'max_total_cost_usd': self.max_cost_usd, 'max_wall_s': self.max_wall_s}

    def start(self):
        self.started = self.clock()

    def elapsed(self):
        return 0.0 if self.started is None else self.clock() - self.started

    def _stop(self, why):
        self.stopped = why
        raise A.AbortRun(why)

    def check(self, where, call_timeout=0.0):
        if self.unreported:
            self._stop('cost cap set and %s: the spend cannot be metered, stopping %s' % (self.unreported, where))
        if self.max_cost_usd is not None:
            remaining = self.max_cost_usd - self.cost
            if remaining <= 0 or self.max_call_cost > remaining:
                self._stop('cost cap reached %s: cumulative reported cost $%.4f of $%.2f (the dearest call so far $%.4f)' % (where, self.cost, self.max_cost_usd, self.max_call_cost))
        if self.max_wall_s is not None and self.elapsed() + call_timeout >= self.max_wall_s:
            self._stop('wall-time cap reached %s: %.0f s elapsed of %.0f s%s' % (where, self.elapsed(), self.max_wall_s,
                                                                                   ' (the call timeout of %.0f s no longer fits)' % call_timeout if call_timeout else ''))

    @staticmethod
    def call_bound(adapter):
        """The longest a call can take plus the cleanup that must still fit after it (`cleanup_reserve_s`: the Ollama unload, status and snapshot)."""
        return (getattr(adapter, 'call_timeout', None) or getattr(adapter, 'timeout', None) or 0.0) + (getattr(adapter, 'cleanup_reserve_s', 0) or 0)

    def before_case(self, adapter=None):
        self.check('before a case', self.call_bound(adapter) if adapter is not None else 0.0)   # a case whose first call could not finish in time is never started

    def before_call(self, adapter):
        self.check('before a model call', self.call_bound(adapter))
        if self.max_cost_usd is not None and hasattr(adapter, 'max_budget_usd'):
            adapter.max_budget_usd = min(self._base_budget, self.max_cost_usd - self.cost)

    def account(self, cost):
        self.calls += 1
        if cost is None:
            if self.max_cost_usd is not None:
                self.unreported = 'a call reported no cost'
            return
        self.cost += cost
        self.max_call_cost = max(self.max_call_cost, cost)

    def wrap(self, adapter):
        """Hook the caps into the adapter instance (its class is untouched)."""
        orig_before, orig_complete = adapter.before_case, adapter.complete
        self._base_budget = getattr(adapter, 'max_budget_usd', None)

        def before_case():
            self.before_case(adapter)
            return orig_before()

        def complete(system, messages, schema=None):
            self.before_call(adapter)
            try:
                comp = orig_complete(system, messages, schema=schema) if schema is not None else orig_complete(system, messages)
            except A.AdapterError as e:
                self.account(getattr(e, 'cost_usd', None))
                if self.max_cost_usd is not None and getattr(e, 'budget_exceeded', False):
                    # the CLI stopped the call at its own lowered budget: that is the cost cap, not a model failure, and not a scored forced escalate
                    ab = A.AbortRun('cost cap reached by a call: the Claude CLI stopped it at its per-call budget (cumulative reported cost $%.4f of $%.2f)' % (self.cost, self.max_cost_usd))
                    ab.failed_call = {'error': str(e)[:500], 'usage': e.usage or ({'cost_usd': e.cost_usd} if e.cost_usd is not None else None)}
                    self.stopped = str(ab)
                    raise ab
                raise
            self.account((getattr(comp, 'usage', None) or {}).get('cost_usd'))
            return comp
        adapter.before_case, adapter.complete = before_case, complete
        return adapter

    def violations(self):
        """Limit violations, judged at the very end (after the cleanup): a final call can overshoot a cap or report no cost with no later check to stop it.
        A violation is recorded and makes the exit status non-zero; it is never reported as success."""
        out = []
        if self.unreported:
            out.append({'kind': 'cost_unreported', 'detail': self.unreported})
        if self.max_cost_usd is not None and self.cost > self.max_cost_usd:
            out.append({'kind': 'cost_cap_exceeded', 'detail': 'cumulative reported cost $%.4f over the $%.2f cap' % (self.cost, self.max_cost_usd)})
        if self.max_wall_s is not None and self.elapsed() > self.max_wall_s:
            out.append({'kind': 'wall_cap_exceeded', 'detail': '%.0f s elapsed after the cleanup, over the %.0f s cap' % (self.elapsed(), self.max_wall_s)})
        return out

    def state(self):
        return {'cost_usd': round(self.cost, 6), 'elapsed_s': round(self.elapsed(), 1), 'model_calls': self.calls, 'max_call_cost_usd': round(self.max_call_cost, 6),
                'cost_unreported': self.unreported, 'stopped': self.stopped, **self.config()}


def build_adapter(args):
    model = args.model
    if args.adapter == 'ollama':
        num_predict = args.num_predict or (640 if P.protocol_of(args.prompt) in P.V2_TURN_PROTOCOLS else 384)
        return A.OllamaAdapter(model, options={'num_ctx': args.num_ctx, 'num_predict': num_predict}, keep_alive=args.keep_alive,
                               guard=G.PsiGuard(), required_digest=getattr(args, 'require_digest', None),
                               stop=(args.stop.split(',') if args.stop is not None else None), do_warmup=not args.no_warmup,
                               schema=(P.FLAT_TURN_SCHEMA if args.ollama_schema == 'flat' else P.TURN_SCHEMA), schema_name=args.ollama_schema)
    if args.adapter == 'claude':
        budget = None if getattr(args, 'no_spend_limit', False) else (args.max_budget_usd if args.max_budget_usd is not None else 2.0)
        return A.ClaudeAdapter(model, effort=args.effort, max_budget_usd=budget)
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
    ap.add_argument('--max-budget-usd', type=float, default=None, help='claude: per-call spend cap (default 2.0)')
    ap.add_argument('--no-spend-limit', action='store_true', help='dev-c6: an explicitly uncapped run: no spend-limit flag of any kind (no claude --max-budget-usd); '
                                                                     'refused with --max-budget-usd or --max-total-cost-usd; usage accounting and timeouts stay')
    ap.add_argument('--num-ctx', type=int, default=A.DEFAULT_NUM_CTX, choices=list(A.ALLOWED_NUM_CTX), help='ollama context window; 4096 is the proven-safe value, 8192 the only other one allowed')
    ap.add_argument('--tool-output-bytes', type=int, default=P.TOOL_OUTPUT_BYTES, help='cap on one tool result shown to the model (lower it for small local contexts)')
    ap.add_argument('--num-predict', type=int, help='ollama output cap; default 384 for prompt v1, 640 for v2 (a write decision carries an audit object)')
    ap.add_argument('--prompt', choices=list(P.PROMPT_VERSIONS), default=P.DEFAULT_PROMPT, help='system prompt and turn protocol version (default v1 until checkpoint 2c); v5 (dev-c5) is valid only with --evidence-format v2; v6 (dev-c6, contract v3) only with --evidence-format v3; v7 (dev-c7) only with --evidence-format v3.1-format')
    ap.add_argument('--guards', choices=list(DG.GUARD_VERSIONS), default=None, help='opt-in deterministic decision guards (dev-c4); default off; v2 only relaxes two G-write checks (see CONTRACT-v2-proposal section 9); v3 (W18) also lets a known integrity defect in the shown evidence contradict a healthy decision (any prompt). A guard can only turn a decision into insufficient_evidence/escalate and keeps the original in the record field `guard`')
    ap.add_argument('--evidence-format', choices=list(EVIDENCE_FORMATS), default=None, help='W18, opt-in: v2 shows the model typed evidence (execution, findings, scope, unresolved per result, a coverage matrix, a client comparison, tool capabilities, compact paginated structure) derived from the same results; also selects tools behaviour v2 and audit v2. Accepted with --prompt v4 or v5 (v5 requires it) and --guards off or v3. v3 (dev-c6) is contract v3 as one version: the v3 presentation (explicit empty values with a presence map, one deduplicated open list with available_check links), turn protocol turn-v3, decision schema decision-v3 and audit v3; only with --prompt v6 and --guards off or v3. v3.1-format (dev-c7) is contract v3 with tools behaviour v3 (bounded, offset-addressed EPUB body excerpts), statement kinds and prior-record typing, and the rubric v3.2 clarification; only with --prompt v7 and --guards off or v3. Unset keeps the legacy format byte for byte')
    ap.add_argument('--max-total-cost-usd', type=float, default=None, help='dev-c5: stop the run cleanly before the cumulative REPORTED cost would reach this cap (cases not run stay listed in the manifest); unset = no cap')
    ap.add_argument('--max-wall-s', type=float, default=None, help='dev-c5: stop the run cleanly before this many wall-clock seconds (counted from just before the adapter preflight, a model load included) are used; unset = no cap')
    ap.add_argument('--require-digest', help='dev-c5, ollama: abort before anything is loaded unless the installed model digest equals this value (recorded in the adapter config and so in the config hash)')
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

    try:
        check_option_combination(args.prompt, args.evidence_format, args.guards, args.tool_output_bytes)
    except ValueError as e:
        raise SystemExit(str(e))
    if args.no_spend_limit and (args.max_budget_usd is not None or args.max_total_cost_usd is not None):
        raise SystemExit('--no-spend-limit is an explicitly uncapped run: it cannot be combined with --max-budget-usd or --max-total-cost-usd')
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
    if args.no_spend_limit:
        config['spend_limit'] = 'uncapped'     # only when set (dev-c6): an explicitly uncapped run; the claude adapter config also shows max_budget_usd None
    limits = RunLimits(args.max_total_cost_usd, args.max_wall_s)
    if limits.enabled:   # likewise only when set: a run without caps keeps its earlier config shape
        config['limits'] = limits.config()
    if args.evidence_format == CONTRACT_V31_FORMAT:   # dev-c7: every version it selects is recorded (tools v3, rubric v3.2, the excerpt rule), so the config hash tells it apart
        config.update(_ev31().CONTRACT, wire_bytes=min(EV2.WIRE_BYTES, args.tool_output_bytes), decision_schema_sha256=sha256_bytes(canonical(P.turn_schema_v3(['ffprobe'])).encode()),
                      excerpt_rules_sha256=_ev31().ET.rules_digest())
    elif args.evidence_format == 'v3':   # contract v3: every version it selects is recorded, so the config hash tells it apart from format v2
        config.update(_ev3().CONTRACT, wire_bytes=min(EV2.WIRE_BYTES, args.tool_output_bytes), decision_schema_sha256=sha256_bytes(canonical(P.turn_schema_v3(['ffprobe'])).encode()))
    elif args.evidence_format:   # likewise only when on; the three versions it selects are recorded so the config hash tells the formats apart
        config.update(evidence_format=args.evidence_format, tools_behavior='v2', audit_version='v2', page_contract=EV2.PAGE_CONTRACT, wire_bytes=min(EV2.WIRE_BYTES, args.tool_output_bytes))
    manifest = {'harness_version': P.HARNESS_VERSION, 'run_id': run_id, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'argv': sys.argv[1:] if argv is None else argv,
                'harness_git': git_info(), 'config': config, 'config_hash': sha256_bytes(canonical(config).encode()),
                'python': platform.python_version(), 'suite_dir': str(suite_dir),
                'case_ids': [c['id'] for c, _ in cases], 'case_sha256': {c['id']: s for c, s in cases}}
    aborted = None
    records = []
    partials = []   # started-aborted cases (kept under started-aborted/, never scored); never-started = planned minus records minus these
    audit = None
    if limits.enabled:
        limits.wrap(adapter)
        limits.start()
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
                               evidence_bounds=evidence_bounds, guards=args.guards, evidence_format=args.evidence_format)
            except A.AbortRun as e:
                aborted = str(e)
                partial = getattr(e, 'partial', None)
                if partial:
                    (out / 'started-aborted').mkdir(exist_ok=True)
                    (out / 'started-aborted' / (case['id'] + '.json')).write_text(json.dumps(partial, indent=2, ensure_ascii=False, sort_keys=True, default=str) + '\n')
                    partials.append(partial)
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
        if limits.enabled:
            manifest['limits_state'] = limits.state()
        manifest['finish'] = adapter.finish()
        if limits.enabled:
            manifest['limits_state']['elapsed_after_cleanup_s'] = round(limits.elapsed(), 1)
            manifest['limits_state']['cost_usd'] = round(limits.cost, 6)
            manifest['limit_violations'] = limits.violations()
            if manifest['limit_violations']:
                text = '; '.join('%s: %s' % (v['kind'], v['detail']) for v in manifest['limit_violations'])
                aborted = text if not aborted else '%s [limit violation] %s' % (aborted, text)
                manifest['aborted'] = aborted
        manifest['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        manifest['records_written'] = [r['case_id'] for r in records]
        manifest['started_aborted'] = [p['case_id'] for p in partials]
        manifest['never_started'] = [i for i in manifest['case_ids'] if i not in manifest['records_written'] and i not in manifest['started_aborted']]
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True, default=str) + '\n')
        (out / 'run_summary.json').write_text(json.dumps(summarize_run(records, manifest, partials), indent=2, sort_keys=True, default=str) + '\n')
    if aborted:
        print('ABORTED: ' + aborted, file=sys.stderr)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
