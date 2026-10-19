"""Turn protocol (CONTRACT.md): strict JSON turns, schema validation, prompts, forced decisions."""
import json

PROTOCOL_VERSION = 'v1'
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


def forced_decision(reason):
    return {'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'target': None,
            'confidence': 0.0, 'evidence_refs': [], 'reason': ('forced: ' + reason)[:400]}


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def validate_turn(obj, tools_available=None):
    """Return (kind, errors).  kind is 'tool_call', 'decision' or None; errors is a list of strings."""
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


def parse_reply(text):
    """Strict parse: the whole reply (whitespace aside) is one JSON object.
    Returns (obj_or_None, error_or_None, diagnostics)."""
    diag = {}
    if not isinstance(text, str) or not text.strip():
        return None, 'empty reply', diag
    stripped = text.strip()
    try:
        return json.loads(stripped), None, diag
    except ValueError as error:
        # diagnostics only: would a fence-stripped reply have parsed?  It is still a miss.
        inner = stripped
        if inner.startswith('```'):
            inner = inner.strip('`')
            if inner.startswith('json'):
                inner = inner[4:]
            try:
                json.loads(inner.strip())
                diag['fence_wrapped'] = True
            except ValueError:
                pass
        return None, 'reply is not strict JSON (%s)' % str(error)[:80], diag


def case_view(case, evidence_rendered, budget=MAX_TOOL_CALLS):
    """What the model sees.  Never truth, supported_actions, solvable, family, provenance,
    inject_tool_failure, outcome_step, fixture or split."""
    ctx = case.get('context', {})
    return {
        'case_id': case['id'],
        'media_type': case.get('media_type'),
        'context': {k: ctx.get(k) for k in ('title', 'expected', 'arr', 'notes_for_model') if k in ctx},
        'evidence': evidence_rendered,
        'tools_available': list(case.get('tools_available', [])),
        'tool_call_budget': budget,
    }
