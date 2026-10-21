"""Turn protocol (CONTRACT.md): strict JSON turns, schema validation, prompts, forced decisions."""
import hashlib
import json
from pathlib import Path

HARNESS_VERSION = 'dev-c6'  # recorded in every run record and manifest
PROTOCOL_VERSION = 'v1'  # the v1 turn protocol (prompt v1); prompt v2 has its own, see PROMPT_VERSIONS
PROMPT_VERSIONS = ('v1', 'v2', 'v3', 'v4', 'v5', 'v6')
# Prompt text and turn protocol are versioned apart: v3 (dev-c3) is new prompt text on the unchanged v2 turn protocol (audit object,
# tool_not_offered violations, per-case schema).  Anything that is about the protocol asks `protocol_of(version)`, not the prompt version.
PROMPT_PROTOCOL = {'v1': 'v1', 'v2': 'v2', 'v3': 'v2', 'v4': 'v2', 'v5': 'v2', 'v6': 'v3'}
# v6 (dev-c6) is the one prompt that declares contract v3: it speaks turn protocol v3 (decision schema `decision-v3`: a write carries a source binding and an
# action-specific target object; none and escalate carry neither), valid only with `--evidence-format v3` (run.check_option_combination).
V2_TURN_PROTOCOLS = ('v2', 'v3')   # protocols that share the v2 turn rules (tool_not_offered violations, the repair hints, the per-case schema); v3 changes the decision only
# Prompt versions whose per-case Ollama `format` schema is exact about the tool enum: a case that offers NO tool gets no tool-call branch at all.
# v2 and v3 keep the dev-c2/dev-c3 behaviour (an empty tools_available fell back to the full tool list there, which is how muse-glimmer:30b called
# tools no case offered on 11 dev cases); changing it for them would change what those prompts measure.
STRICT_TOOL_SCHEMA = ('v4', 'v5', 'v6')
DEFAULT_PROMPT = 'v1'  # stays v1 until checkpoint 2c
PROMPT_DIR = Path(__file__).resolve().parent / 'prompts'
MAX_TOOL_CALLS = 6
TOOL_OUTPUT_BYTES = 8192
TOOL_TIMEOUT_S = 60

CLASSES = ('identity_mismatch', 'corrupt_file', 'decoder_incompatible', 'metadata_naming',
           'order_edition_ambiguity', 'insufficient_evidence', 'healthy')
ACTIONS = ('none', 'escalate', 'blocklist_and_search', 'remap', 'rename', 'convert')
WRITE_ACTIONS = ('blocklist_and_search', 'remap', 'rename', 'convert')
TOOLS = ('ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr', 'epub_inspect',
         'audiobook_inspect', 'arr_lookup')

# Schema handed to Ollama `format` (grammar-constrained).  Bounded strings and arrays so the output
# cannot be truncated mid-structure (history: AV run, unbounded evidence array hit num_predict).
DECISION_SCHEMA = {
    'type': 'object',
    'properties': {
        'type': {'enum': ['decision']},
        'class': {'enum': list(CLASSES)},
        'action': {'enum': list(ACTIONS)},
        'target': {'type': ['string', 'null'], 'maxLength': 200},
        'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
        'evidence_refs': {'type': 'array', 'items': {'type': 'string', 'maxLength': 16}, 'maxItems': 12},
        'reason': {'type': 'string', 'maxLength': 400},
    },
    'required': ['type', 'class', 'action', 'target', 'confidence', 'evidence_refs', 'reason'],
    'additionalProperties': False,
}
TOOL_CALL_SCHEMA = {
    'type': 'object',
    'properties': {
        'type': {'enum': ['tool_call']},
        'tool': {'enum': list(TOOLS)},
        'args': {'type': 'object'},
        'why': {'type': 'string', 'maxLength': 200},
    },
    'required': ['type', 'tool', 'args', 'why'],
    'additionalProperties': False,
}
TURN_SCHEMA = {'anyOf': [TOOL_CALL_SCHEMA, DECISION_SCHEMA]}
# Fallback for grammar engines that mishandle anyOf / type arrays: one flat object, only `type` required.
# The strict validator still enforces the exact key sets afterwards.
FLAT_TURN_SCHEMA = {
    'type': 'object',
    'properties': dict({'type': {'enum': ['tool_call', 'decision']}, 'tool': TOOL_CALL_SCHEMA['properties']['tool'],
                        'args': {'type': 'object'}, 'why': TOOL_CALL_SCHEMA['properties']['why']},
                       **{k: v for k, v in DECISION_SCHEMA['properties'].items() if k != 'type'}),
    'required': ['type'], 'additionalProperties': False,
}

SYSTEM_PROMPT = """You are a media repair triage agent. A media item (movie, TV episode, EPUB book or audiobook) was reported or flagged. Decide what is wrong with it, if anything, using ONLY the evidence you are given and the read-only tools you call. You never change anything yourself: the action you choose is recorded as an intent for a human-supervised system.

Every reply of yours is exactly ONE JSON object and nothing else (no prose, no markdown fences).

1. Tool call:
{"type":"tool_call","tool":"ffprobe","args":{},"why":"short reason"}
(the tool name and args vary; args is an object, often {} or {"at":60}; why is at most 200 characters). This is not a native function call: your whole reply is that JSON object, the harness runs the tool and sends the result back in its next message. You may make at most 6 tool calls. Each tool result is bounded to 8 KiB and may come back with status ok, partial, error or timeout. Tools only ever act on this case's file; you cannot choose paths.

2. Final answer:
{"type":"decision","class":"<class>","action":"<action>","target":"<file, release or episode reference, or null>","confidence":0.0,"evidence_refs":["e1","t2"],"reason":"<=400 chars"}

Classes: identity_mismatch (the content is a different work, episode or edition than expected), corrupt_file (damaged, truncated or undecodable data), decoder_incompatible (the file is intact but its codecs or features cannot be played by the stated client), metadata_naming (the content is right but its name, tags, numbering or index metadata is wrong), order_edition_ambiguity (the content is right but episode order, cut or edition differs from the expected numbering and the evidence cannot settle which is correct), insufficient_evidence (the evidence cannot settle what is wrong), healthy (no defect found).

Actions: none (leave the item alone), escalate (hand to a human with your reason), blocklist_and_search (record an intent to blocklist this release and search for a replacement; only for a bad copy), remap and rename (metadata-only changes), convert (decoder work on an isolated copy only).

Output format rules: one object, double-quoted keys and strings, every string closed, no trailing commas, no text before or after it.

Rules:
- Keep reason to one or two sentences (the hard limit is 400 characters).
- Base every claim on evidence. Cite the evidence ids (e1.., from the case; t1.. for your tool results) in evidence_refs.
- If a tool fails, times out or returns partial output, say so in your reason. Never invent or assume what it would have shown. Decide on the remaining evidence, or escalate.
- When the evidence cannot settle the question, choose class insufficient_evidence with action escalate. A wrong repair is worse than an escalation.
- Leave a healthy item alone: class healthy, action none.
- Sample evidence is partial. A clean sample does not prove a whole file is healthy, and a file name alone never proves content."""

REPAIR_PROMPT = ('Your last reply was rejected: {error}. Reply again with exactly one JSON object '
                 'following the protocol, nothing else.')
BUDGET_MESSAGE = ('Tool budget exhausted (6 of 6 used). No more tool calls are possible. '
                  'Reply with your final decision object now.')


def protocol_of(prompt_version):
    """The turn protocol ('v1', 'v2' or 'v3') a prompt version speaks.  Unknown versions raise (never a silent v1)."""
    try:
        return PROMPT_PROTOCOL[prompt_version]
    except KeyError:
        raise ValueError('unknown prompt version %r (known: %s)' % (prompt_version, ', '.join(PROMPT_VERSIONS)))


def get_prompt(version=DEFAULT_PROMPT):
    """-> {'version', 'text', 'sha256'}.  v1 is SYSTEM_PROMPT above (unchanged, so its sha matches the checkpoint 1
    records); v2 is prompts/v2.txt and v3 (dev-c3) is prompts/v3.txt, each sent exactly as its file reads (one trailing newline removed).
    v3 (dev-c3), v4 (dev-c4) and v5 (dev-c5; valid only with `--evidence-format v2`, see run.check_option_combination) are new text on the v2 turn protocol, see protocol_of.
    v6 (dev-c6) declares contract v3 and speaks turn protocol v3; it is valid only with `--evidence-format v3`."""
    if version == 'v1':
        text = SYSTEM_PROMPT
    elif version in ('v2', 'v3', 'v4', 'v5', 'v6'):
        text = (PROMPT_DIR / (version + '.txt')).read_text(encoding='utf-8').rstrip('\n')
    else:
        raise ValueError('unknown prompt version %r (known: %s)' % (version, ', '.join(PROMPT_VERSIONS)))
    return {'version': version, 'text': text, 'sha256': hashlib.sha256(text.encode()).hexdigest()}


# ---- turn protocol v2 (prompt v2): decisions carry an `audit` object when the action is a write ----------------------
AUDIT_KEYS = ('target', 'preconditions', 'readback', 'verify')
AUDIT_SCHEMA = {
    'type': 'object',
    'properties': {
        'target': {'type': 'string', 'minLength': 1, 'maxLength': 200},
        'preconditions': {'type': 'array', 'items': {'type': 'string', 'maxLength': 160}, 'minItems': 1, 'maxItems': 6},
        'readback': {'type': 'string', 'minLength': 1, 'maxLength': 240},
        'verify': {'type': 'string', 'minLength': 1, 'maxLength': 240},
    },
    'required': list(AUDIT_KEYS),
    'additionalProperties': False,
}
_DECISION_V2_PROPS = {
    'type': {'enum': ['decision']},
    'class': {'enum': list(CLASSES)},
    'target': {'type': ['string', 'null'], 'maxLength': 200},
    'reason': {'type': 'string', 'maxLength': 400},
    'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
    'evidence_refs': {'type': 'array', 'items': {'type': 'string', 'maxLength': 16}, 'maxItems': 12},
}
# A write decision must name a target and carry the audit; any other decision may not claim a write.  The last key of
# every example is an array or object, never a string: baseline haiku closed a trailing string with `","}` (G7).
DECISION_NOWRITE_SCHEMA_V2 = {
    'type': 'object',
    'properties': dict(_DECISION_V2_PROPS, action={'enum': ['none', 'escalate']}),
    'required': ['type', 'class', 'action', 'target', 'reason', 'confidence', 'evidence_refs'],
    'additionalProperties': False,
}
DECISION_WRITE_SCHEMA_V2 = {
    'type': 'object',
    'properties': dict(_DECISION_V2_PROPS, action={'enum': list(WRITE_ACTIONS)}, target={'type': 'string', 'minLength': 1, 'maxLength': 200},
                       audit=AUDIT_SCHEMA),
    'required': ['type', 'class', 'action', 'target', 'reason', 'confidence', 'evidence_refs', 'audit'],
    'additionalProperties': False,
}


def tool_call_schema_v2(tools=None):
    """Tool-call schema; the `tool` enum is limited to the case's tools_available when given (baseline muse asked for a tool the
    case did not offer on 11 cases, and haiku on 3)."""
    return {
        'type': 'object',
        'properties': {'type': {'enum': ['tool_call']}, 'tool': {'enum': list(tools if tools else TOOLS)},
                       'why': {'type': 'string', 'maxLength': 200}, 'args': {'type': 'object'}},
        'required': ['type', 'tool', 'why', 'args'],
        'additionalProperties': False,
    }


def turn_schema(prompt_version=DEFAULT_PROMPT, tools=None, flat=False):
    """The `format` schema for grammar-constrained engines.  v1: the module constants, unchanged.  v2 and v3: per-case tool enum and
    an audit that is required exactly when the action is a write; flat=True is the anyOf-free fallback.  For those two an EMPTY
    tools_available falls back to the full tool list (an enum cannot be empty), which let a model call a tool the case does not offer.
    v4 (STRICT_TOOL_SCHEMA): a case that offers no tool (an empty list or no `tools_available` key) gets no tool-call branch, so only a decision is possible."""
    if prompt_version == 'v1':
        return FLAT_TURN_SCHEMA if flat else TURN_SCHEMA
    if protocol_of(prompt_version) == 'v3':
        return turn_schema_v3(tools, flat)
    no_tools = prompt_version in STRICT_TOOL_SCHEMA and not tools   # an empty list or a missing key: no tool is offered
    if no_tools:
        if not flat:
            return {'anyOf': [DECISION_NOWRITE_SCHEMA_V2, DECISION_WRITE_SCHEMA_V2]}
        props = {'type': {'enum': ['decision']}, 'action': {'enum': list(ACTIONS)}, 'audit': AUDIT_SCHEMA}
        props.update({k: v for k, v in _DECISION_V2_PROPS.items() if k != 'type'})
        return {'type': 'object', 'properties': props, 'required': ['type'], 'additionalProperties': False}
    tc = tool_call_schema_v2(tools)
    if not flat:
        return {'anyOf': [tc, DECISION_NOWRITE_SCHEMA_V2, DECISION_WRITE_SCHEMA_V2]}
    props = {'type': {'enum': ['tool_call', 'decision']}, 'tool': tc['properties']['tool'], 'why': tc['properties']['why'],
             'args': {'type': 'object'}, 'action': {'enum': list(ACTIONS)}, 'audit': AUDIT_SCHEMA}
    props.update({k: v for k, v in _DECISION_V2_PROPS.items() if k != 'type'})
    return {'type': 'object', 'properties': props, 'required': ['type'], 'additionalProperties': False}


# ---- turn protocol v3 (prompt v6, contract v3): decision schema `decision-v3` -------------------------------------------------------------------
# A write carries `source` {"ref": <the evidence id that binds the source, or "case_item" for an item with no managing app>} and a `target` object of the
# action's kind; none and escalate carry neither.  The validator is the frozen `experimental/contract_v3/targets.validate_decision_v3` (evidence_v3.validate_decision);
# the schema below is only the grammar handed to a constrained engine (Ollama `format`), written to accept exactly what that validator accepts for each shape.
_STR = lambda lo, hi: {'type': 'string', 'minLength': lo, 'maxLength': hi}   # noqa: E731
_DECISION_V3_COMMON = {
    'reason': _STR(1, 400),
    'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
    'evidence_refs': {'type': 'array', 'items': _STR(1, 16), 'maxItems': 12},
}
TARGET_V3 = {
    'blocklist_and_search': {'kind': {'enum': ['release_of_source']}, 'source_ref': _STR(1, 16)},
    'remap': {'kind': {'enum': ['destination_slot']}, 'slot_ref': _STR(1, 16), 'slot_free_ref': _STR(1, 16)},
    'rename': {'kind': {'enum': ['rename_of_source']}, 'old_value': _STR(1, 200), 'new_value': _STR(1, 200)},
    'convert': {'kind': {'enum': ['isolated_copy']}, 'allocated_by': {'enum': ['executor']}},
}


def _decision_v3_nowrite():
    props = {'type': {'enum': ['decision']}, 'class': {'enum': list(CLASSES)}, 'action': {'enum': ['none', 'escalate']}}
    props.update(_DECISION_V3_COMMON)
    return {'type': 'object', 'properties': props, 'required': list(props), 'additionalProperties': False}


def _decision_v3_write(action):
    tgt = TARGET_V3[action]
    props = {'type': {'enum': ['decision']}, 'class': {'enum': list(CLASSES)}, 'action': {'enum': [action]},
             'source': {'type': 'object', 'properties': {'ref': _STR(1, 16)}, 'required': ['ref'], 'additionalProperties': False},
             'target': {'type': 'object', 'properties': dict(tgt), 'required': list(tgt), 'additionalProperties': False}}
    props.update(_DECISION_V3_COMMON)
    return {'type': 'object', 'properties': props, 'required': list(props), 'additionalProperties': False}


def turn_schema_v3(tools=None, flat=False):
    """The `format` schema of turn protocol v3: a tool call (the case's tool enum; none when no tool is offered), a decision without a write, and one branch per write
    action with its target kind.  flat=True: one object, only `type` required (the strict validator still decides)."""
    branches = ([tool_call_schema_v2(tools)] if tools else []) + [_decision_v3_nowrite()] + [_decision_v3_write(a) for a in WRITE_ACTIONS]
    if not flat:
        return {'anyOf': branches}
    props = {'type': {'enum': (['tool_call'] if tools else []) + ['decision']}}
    if tools:
        props.update(tool=tool_call_schema_v2(tools)['properties']['tool'], why={'type': 'string', 'maxLength': 200}, args={'type': 'object'})
    props.update({'class': {'enum': list(CLASSES)}, 'action': {'enum': list(ACTIONS)}, 'source': {'type': 'object'}, 'target': {'type': 'object'}})
    props.update(_DECISION_V3_COMMON)
    return {'type': 'object', 'properties': props, 'required': ['type'], 'additionalProperties': False}


def validate_turn_v3(obj, tools_available=None):
    """Return (kind, errors) for turn protocol v3.  A tool call is checked exactly as in v2 (a call to a tool the case does not offer is a recorded protocol violation,
    not an invalid reply); a decision by the frozen decision-v3 validator (complete and total: types, ranges, the source binding, the action's target kind; an
    executor-allocated copy for convert; no source or target on none / escalate)."""
    if isinstance(obj, dict) and obj.get('type') == 'decision':
        from . import evidence_v3 as EV3
        errs = EV3.validate_decision(obj)
        return ('decision' if not errs else None), errs
    return validate_turn_v2(obj, tools_available)


def forced_decision_for(prompt_version, reason):
    """The harness-written forced escalate in the decision shape of the prompt's protocol: v1 / v2 as `forced_decision`; v3 carries no target."""
    d = forced_decision(reason)
    if protocol_of(prompt_version) == 'v3':
        d.pop('target')
    return d


def _key_errors(obj, allowed, what, optional=()):
    miss = sorted(set(allowed) - set(obj) - set(optional))
    extra = sorted(set(obj) - set(allowed) - set(optional))
    if not miss and not extra:
        return []
    parts = []
    if miss:
        parts.append('missing %s' % miss)
    if extra:
        parts.append('unexpected %s (only the documented keys are allowed; never copy fields from a tool result)' % extra)
    return ['%s keys wrong: %s' % (what, '; '.join(parts))]


def validate_audit(audit):
    errs = []
    if not isinstance(audit, dict):
        return ['audit must be an object with keys %s' % list(AUDIT_KEYS)]
    errs += _key_errors(audit, AUDIT_KEYS, 'audit')
    for k in ('target', 'readback', 'verify'):
        v = audit.get(k)
        if k in audit and not (isinstance(v, str) and v.strip()):
            errs.append('audit.%s must be a non-empty string' % k)
        elif isinstance(v, str) and len(v) > (200 if k == 'target' else 240):
            errs.append('audit.%s is too long' % k)
    pre = audit.get('preconditions')
    if 'preconditions' in audit and (not isinstance(pre, list) or not pre or len(pre) > 6 or not all(isinstance(x, str) and x.strip() and len(x) <= 160 for x in pre)):
        errs.append('audit.preconditions must be a list of 1 to 6 short strings')
    return errs


def tool_not_offered(obj, tools_available):
    """The tool name of a (valid-shaped) tool call that the case does not offer, else None."""
    if isinstance(obj, dict) and obj.get('type') == 'tool_call' and tools_available is not None \
            and isinstance(obj.get('tool'), str) and obj['tool'] not in tools_available:
        return obj['tool']
    return None


def validate_turn_v2(obj, tools_available=None):
    """Return (kind, errors) for turn protocol v2.  Same shapes as v1, plus: a write action needs a named target and an
    audit object whose target is that same target.  An audit on none/escalate is REJECTED (not tolerated): a decision that
    claims no write may not carry a write's audit, so it is invalid on the first try and goes through the one repair prompt
    (a second miss ends as a forced escalate).  Also what v3 uses: `protocol_of('v3')` is 'v2'."""
    errs = []
    if not isinstance(obj, dict):
        return None, ['reply is not a JSON object']
    kind = obj.get('type')
    if kind == 'tool_call':
        errs += _key_errors(obj, ('type', 'tool', 'why', 'args'), 'tool_call')
        # A well-formed call to a tool the case does not offer is NOT an invalid reply: it is a protocol violation that the runner
        # records and answers with an `unavailable` tool result (see tool_not_offered), so it needs no repair prompt.
        if not (isinstance(obj.get('tool'), str) and obj['tool'].strip()):
            errs.append('tool must be the name of a tool from tools_available')
        if not isinstance(obj.get('args'), dict):
            errs.append('args must be an object')
        if not isinstance(obj.get('why'), str) or len(obj.get('why', '')) > 200:
            errs.append('why must be a string of at most 200 characters')
        return ('tool_call' if not errs else None), errs
    if kind == 'decision':
        errs += _key_errors(obj, ('type', 'class', 'action', 'target', 'reason', 'confidence', 'evidence_refs'), 'decision', optional=('audit',))
        if obj.get('class') not in CLASSES:
            errs.append('class must be one of %s' % list(CLASSES))
        if obj.get('action') not in ACTIONS:
            errs.append('action must be exactly one of %s (one value, never a combination)' % list(ACTIONS))
        if not (obj.get('target') is None or (isinstance(obj.get('target'), str) and len(obj['target']) <= 200)):
            errs.append('target must be a string or null')
        c = obj.get('confidence')
        if not _is_num(c) or not 0 <= c <= 1:
            errs.append('confidence must be a number between 0 and 1')
        refs = obj.get('evidence_refs')
        if not isinstance(refs, list) or not all(isinstance(r, str) for r in refs) or len(refs) > 12:
            errs.append('evidence_refs must be a list of at most 12 strings')
        if not isinstance(obj.get('reason'), str) or len(obj.get('reason', '')) > 400:
            errs.append('reason must be a string of at most 400 characters')
        if obj.get('action') in WRITE_ACTIONS:
            if not (isinstance(obj.get('target'), str) and obj['target'].strip()):
                errs.append('a write action needs a named target (non-null string)')
            if 'audit' not in obj or obj.get('audit') is None:
                errs.append('a write action needs an audit object with keys %s' % list(AUDIT_KEYS))
        if obj.get('action') in ('none', 'escalate') and 'audit' in obj:
            errs.append('audit is only for a write action; do not add it for none or escalate')
        if obj.get('audit') is not None:
            aerrs = validate_audit(obj['audit'])
            errs += aerrs
            if not aerrs and obj.get('action') in WRITE_ACTIONS and isinstance(obj.get('target'), str) \
                    and ' '.join(obj['audit']['target'].split()).lower() != ' '.join(obj['target'].split()).lower():
                errs.append('audit.target must equal target')
        return ('decision' if not errs else None), errs
    return None, ['"type" must be "tool_call" or "decision"']


# ---- first-try failure modes (recorded on every rejected reply, generic) --------------------------------------------------
# Observed on the checkpoint 1 baseline and the v2 drafts: a compound action string ("remap and rename"), a tool outside
# tools_available, a stray `","}` close, a missing `type` key, keys copied from the tool-result envelope.  The modes are
# diagnostics: a reply with any of them is invalid on the first try, and a later repaired reply never changes that.
ENVELOPE_KEYS = ('status', 'output', 'truncated', 'tool_calls_remaining', 'id')
REPAIR_HINTS = {
    'compound_action': 'action must be exactly ONE value; if two different writes could be right, the action is escalate',
    'missing_type': 'the first key must be "type":"tool_call" or "type":"decision"',
    'envelope_keys_copied': 'do not copy fields of a tool result (status, output, truncated, tool_calls_remaining, id) into your reply',
    'echoed_tool_result': 'a tool result is not a reply; reply with a tool_call or a decision',
    'stray_comma_quote_close': 'close the last string with exactly one double-quote character and then the brace; never add a comma and a second quote before the brace',
    'fence_wrapped': 'no markdown fence',
    'prose_around_object': 'nothing before the opening brace or after the closing brace',
    'stop_token': 'nothing after the closing brace',
    'audit_missing': 'a write action needs the audit object as its last key',
}


def failure_modes(text, obj, errors, diag=None):
    """Generic classification of a rejected reply -> sorted list of mode tags."""
    modes = set()
    diag = diag or {}
    for tag in diag.get('salvageable_by') or []:
        modes.add(tag.split(':')[0])
    if diag.get('fence_wrapped'):
        modes.add('fence_wrapped')
    if obj is None:
        if not (isinstance(text, str) and text.strip()):
            modes.add('empty_reply')
        elif not modes:
            modes.add('not_json')
        return sorted(modes)
    if not isinstance(obj, dict):
        modes.add('not_an_object')
        return sorted(modes)
    kind = obj.get('type')
    if 'type' not in obj:
        modes.add('missing_type')
    elif kind == 'tool_result':
        modes.add('echoed_tool_result')
    elif kind not in ('tool_call', 'decision'):
        modes.add('unknown_type')
    if set(obj) & set(ENVELOPE_KEYS):
        modes.add('envelope_keys_copied')
    act = obj.get('action')
    if kind == 'decision' or 'action' in obj:
        if isinstance(act, str) and act not in ACTIONS:
            named = [a for a in ACTIONS if a in act]
            modes.add('compound_action' if len(named) >= 2 else 'unknown_action')
        elif act is not None and not isinstance(act, str):
            modes.add('unknown_action')
        if obj.get('class') not in CLASSES:
            modes.add('unknown_class')
        if act in WRITE_ACTIONS:
            if obj.get('audit') is None:
                modes.add('audit_missing')
            elif validate_audit(obj['audit']):
                modes.add('audit_malformed')
    if any('keys wrong' in e or 'keys must be' in e for e in errors or []):
        modes.add('wrong_keys')
    return sorted(modes)


# turn protocol v3 (prompt v6): a write needs no audit object, so the audit hints are not given; the decision-v3 shape gets its own hint
REPAIR_HINTS['decision_v3_shape'] = ('a write has "source":{"ref":"<evidence id>"} and a "target" object of its action\'s kind, as in the reply format; '
                                     'none and escalate have neither source nor target')


def failure_modes_for(prompt_version, text, obj, errors, diag=None):
    """`failure_modes` for the prompt's protocol: v1 and v2 unchanged; v3 drops the audit modes (decision-v3 has no required audit) and tags a decision-v3 shape error."""
    modes = failure_modes(text, obj, errors, diag)
    if protocol_of(prompt_version) != 'v3':
        return modes
    modes = {m for m in modes if m not in ('audit_missing', 'audit_malformed')}
    if isinstance(obj, dict) and obj.get('type') == 'decision' and any(
            ('source' in e or 'target' in e or 'keys not allowed' in e or 'missing keys' in e) for e in errors or []):
        modes.add('decision_v3_shape')
    return sorted(modes)


def repair_prompt(error, modes=()):
    """The one repair prompt.  Generic text only: the validator error plus a fixed hint per failure mode."""
    text = REPAIR_PROMPT.format(error=error)
    hints = [REPAIR_HINTS[m] for m in modes if m in REPAIR_HINTS]
    return text + (' Hints: ' + '; '.join(hints) + '.' if hints else '')


def forced_decision(reason):
    return {'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'target': None,
            'confidence': 0.0, 'evidence_refs': [], 'reason': ('forced: ' + reason)[:400]}


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def validate_turn(obj, tools_available=None, prompt_version='v1'):
    """Return (kind, errors).  kind is 'tool_call', 'decision' or None; errors is a list of strings."""
    if protocol_of(prompt_version) == 'v2':
        return validate_turn_v2(obj, tools_available)
    if protocol_of(prompt_version) == 'v3':
        return validate_turn_v3(obj, tools_available)
    errs = []
    if not isinstance(obj, dict):
        return None, ['reply is not a JSON object']
    kind = obj.get('type')
    if kind == 'tool_call':
        allowed = {'type', 'tool', 'args', 'why'}
        if set(obj) != allowed:
            errs.append('tool_call keys must be exactly %s' % sorted(allowed))
        if obj.get('tool') not in TOOLS:
            errs.append('unknown tool %r' % (obj.get('tool'),))
        elif tools_available is not None and obj.get('tool') not in tools_available:
            errs.append('tool %r is not available for this case' % (obj.get('tool'),))
        if not isinstance(obj.get('args'), dict):
            errs.append('args must be an object')
        if not isinstance(obj.get('why'), str) or len(obj.get('why', '')) > 200:
            errs.append('why must be a string of at most 200 characters')
        return ('tool_call' if not errs else None), errs
    if kind == 'decision':
        allowed = {'type', 'class', 'action', 'target', 'confidence', 'evidence_refs', 'reason'}
        if set(obj) != allowed:
            errs.append('decision keys must be exactly %s' % sorted(allowed))
        if obj.get('class') not in CLASSES:
            errs.append('class must be one of %s' % list(CLASSES))
        if obj.get('action') not in ACTIONS:
            errs.append('action must be one of %s' % list(ACTIONS))
        if not (obj.get('target') is None or (isinstance(obj.get('target'), str) and len(obj['target']) <= 200)):
            errs.append('target must be a string or null')
        c = obj.get('confidence')
        if not _is_num(c) or not 0 <= c <= 1:
            errs.append('confidence must be a number between 0 and 1')
        refs = obj.get('evidence_refs')
        if not isinstance(refs, list) or not all(isinstance(r, str) for r in refs) or len(refs) > 12:
            errs.append('evidence_refs must be a list of at most 12 strings')
        if not isinstance(obj.get('reason'), str) or len(obj.get('reason', '')) > 400:
            errs.append('reason must be a string of at most 400 characters')
        return ('decision' if not errs else None), errs
    return None, ['"type" must be "tool_call" or "decision"']


# Text a stop-token or a sloppy close can leave after / inside the object.  Diagnostics only: the reply is still a miss.
STOP_ARTIFACTS = ('<|eot|>', '<|im_end|>', '<|endoftext|>', '<|end|>', '</s>')


def salvage_diagnostics(stripped):
    """Which known artifact, if removed, would make a rejected reply parse?  Recorded so a G7 miss can be classified
    (fence, stop token, stray `","}` close, prose around the object); the reply is never accepted on this basis."""
    found = []

    def parses(t):
        try:
            return isinstance(json.loads(t), dict)
        except ValueError:
            return False
    if stripped.startswith('```'):
        inner = stripped.strip('`')
        if inner.startswith('json'):
            inner = inner[4:]
        if parses(inner.strip()):
            found.append('fence_wrapped')
    for tok in STOP_ARTIFACTS:
        if tok in stripped and parses(stripped.replace(tok, '').strip()):
            found.append('stop_token:' + tok)
    if stripped.endswith(',"}') and parses(stripped[:-3] + '}'):
        found.append('stray_comma_quote_close')
    elif stripped.endswith('","}') and parses(stripped[:-4] + '"}'):
        found.append('stray_comma_quote_close')
    a, b = stripped.find('{'), stripped.rfind('}')
    if 0 <= a < b and (a > 0 or b < len(stripped) - 1) and parses(stripped[a:b + 1]):
        found.append('prose_around_object')
    return found


def parse_reply(text):
    """Strict parse: the whole reply (whitespace aside) is one JSON object.
    Returns (obj_or_None, error_or_None, diagnostics)."""
    diag = {}
    if not isinstance(text, str) or not text.strip():
        return None, 'empty reply', diag
    stripped = text.strip()
    try:
        obj = json.loads(stripped)
    except ValueError as error:
        found = salvage_diagnostics(stripped)
        if found:
            diag['salvageable_by'] = found
            if 'fence_wrapped' in found:
                diag['fence_wrapped'] = True  # kept: the scorer counts this key
        return None, 'reply is not strict JSON (%s)' % str(error)[:80], diag
    return obj, None, diag


# context keys shown to the model.  filename, client_profile and question are suite additions (dev-v1) that the
# task needs (a decoder_incompatible verdict is impossible without the client profile); any other key, at the
# top level or inside context, is ignored and never shown.
MODEL_CONTEXT_KEYS = ('title', 'filename', 'expected', 'client_profile', 'question', 'arr', 'notes_for_model')


def case_view(case, evidence_rendered, budget=MAX_TOOL_CALLS, case_alias=None):
    """What the model sees.  Never the real case id, truth, supported_actions, solvable, family, provenance,
    inject_tool_failure, outcome_step, fixture or split."""
    ctx = case.get('context', {})
    return {
        'case_id': case_alias or 'case-unaliased',  # opaque per-run alias (leakguard.alias); the real id never reaches a model
        'media_type': case.get('media_type'),
        'context': {k: ctx.get(k) for k in MODEL_CONTEXT_KEYS if k in ctx},
        'evidence': evidence_rendered,
        'tools_available': list(case.get('tools_available', [])),
        'tool_call_budget': budget,
    }
