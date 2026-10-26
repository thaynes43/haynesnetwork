"""Evidence handover (#209, opt-in `--evidence-handover none|askable`): the "must-ask" arm of a handed versus must-ask comparison.

Default (`full`, the flag absent): nothing here runs.  The first message carries the case's pre-collected evidence exactly as before; the config, the
config hash, the records and the replay-identity digests are those of every earlier run.

What is EVIDENCE and what is CONTEXT (the boundary this module fixes, `handover-1`):

* EVIDENCE is a case's `evidence` list: every entry is the recorded output of one tool call (`ffprobe`, `decode_sample`, `ocr`, `epub_inspect`,
  `arr_lookup`) or a `prior_record` (a note carried over from an earlier report, which no tool produces).  It is what `run.resolve_evidence*` renders into
  the first message.
* CONTEXT is `case.context` as `protocol.case_view` exposes it (`MODEL_CONTEXT_KEYS`: title, filename, expected, client_profile, question, arr,
  notes_for_model), `media_type`, `tools_available` and `tool_call_budget`.  Title, expected, the arr ids and the notes say WHAT the item is and what was
  asked; they are never withheld.  `context.arr` (the managing app and its ids) is context; the `arr_lookup` evidence (what the app's record says about the
  work) is a tool output and is evidence.

Modes (`full` is the default and means "no handover change"):

* `none`: every evidence entry is withheld.  An entry no offered tool can produce (`prior_record`, or the output of a tool the case does not offer) is
  therefore gone for good; the reachability table (`docs/must-ask-reachability.md`) lists those cases.
* `askable`: only the entries a call can return are withheld: the entry's tool is offered for the case, is a harness tool, and is not shadowed by the case's
  injected failure.  What no call can produce stays in the first message, so a case that carries only a `prior_record` is the same in both arms.

RETURN OF A WITHHELD ENTRY.  The tool layer serves a call from the recorded entry when it matches (the same rule the pinned-media replay uses: a time
argument equals the entry's, `full` equals `full`; a tool that takes no time matches any call; an `epub_inspect` call with excerpt arguments is a different
request and goes to the normal tool).  The returned text is the text the first message would have carried, byte for byte (the same resolution, redaction and
EPUB handling as `run.resolve_evidence_raw`), with its recorded status.  A call that matches no entry goes to the normal replay tool, unchanged.  Plain replay
alone would not return the recorded output: it answers from the probe recordings in the shape of the live tool (a `decode_sample` verdict, an `ocr` object, an
`arr_lookup` stub wrapper), or says `unavailable` for a fixture file that is not in the checkout, so the two arms would differ in more than who asked.
`served_from_record` in a tool call's record names the entry it returned.  Nothing is invented: a call no entry matches is never answered from one.
"""
from . import protocol as P

VERSION = 'handover-1'
MODES = ('full', 'none', 'askable')
ACTIVE_MODES = ('none', 'askable')
# the tools whose recorded output a call can return; every other evidence tool (`prior_record`) has no producer
NO_TIME = ('ffprobe', 'epub_inspect', 'audiobook_inspect', 'arr_lookup')
TIMED = ('decode_sample', 'ocr')
SERVED_TOOLS = NO_TIME + TIMED


def config(mode):
    """The config entry of an active mode (a `full` run has none, so its config hash is unchanged)."""
    return {'mode': mode, 'version': VERSION, 'serve': 'recorded-first'}


def injected_shadow(case, tool):
    """True when the case's injected failure answers a call to `tool` with an error or a timeout (the recorded output can then never be returned by a call)."""
    inj = case.get('inject_tool_failure') or {}
    return bool(inj) and inj.get('tool') == tool and inj.get('mode', 'error') in ('error', 'timeout')


def askable(case, entry):
    """An entry a call can return: its tool is offered, is a harness tool the recorded-first layer serves, and is not shadowed by the injected failure."""
    tool = entry.get('tool')
    return tool in (case.get('tools_available') or []) and tool in P.TOOLS and tool in SERVED_TOOLS and not injected_shadow(case, tool)


def is_withheld(case, entry, mode):
    if mode == 'none':
        return True
    if mode == 'askable':
        return askable(case, entry)
    return False


def split(case, entries, mode):
    """-> (shown, withheld): `entries` (resolved evidence dicts with an `id` and a `tool`) divided by the mode."""
    shown, withheld = [], []
    for e in entries:
        (withheld if is_withheld(case, e, mode) else shown).append(e)
    return shown, withheld


def case_without(case, withheld_ids):
    """The case as the audit, the guards and the reference resolver read it: the pre-collected evidence the model was shown (nothing withheld is "available")."""
    out = dict(case)
    out['evidence'] = [e for e in case.get('evidence', []) if e.get('id') not in withheld_ids]
    return out


def check_options(mode, evidence_mode='replay', tools_behavior=None, claude_schema=False):
    """Raise ValueError for an unsupported combination of the handover option."""
    if mode not in MODES:
        raise ValueError('unknown --evidence-handover %r (known: %s; unset or full keeps the evidence in the first message)' % (mode, ', '.join(MODES)))
    if mode == 'full':
        return
    if evidence_mode != 'replay':
        raise ValueError('--evidence-handover %s serves a call from the case\'s recorded evidence and is accepted with --evidence replay only (got %s)' % (mode, evidence_mode))
    if tools_behavior:
        raise ValueError('--evidence-handover %s is refused with --tools-behavior %s (the remote subtitle stream is chosen from the case\'s recorded probe result)' % (mode, tools_behavior))
    if claude_schema:
        raise ValueError('--evidence-handover %s is refused with --claude-schema (experimental; its guard re-runs a case without the handover)' % mode)


def match(case, name, args, frame_t):
    """-> the recorded evidence entry a call to `name` with `args` returns, or None (the call then goes to the normal tool)."""
    from . import tools as T
    entries = [e for e in case.get('evidence', []) if e.get('tool') == name]
    if not entries or name not in SERVED_TOOLS or not isinstance(args, dict):
        return None
    if name in NO_TIME:
        if name == 'epub_inspect' and args:
            return None        # excerpt arguments ask for body text, which no recorded entry carries
        return entries[0]
    full = T._is_full(args)
    if name == 'ocr' and 'frame' in args:
        at = frame_t.get(args['frame'])
        if at is None:
            return None        # an unknown frame: the normal tool says so
    else:
        try:
            at = T._at(args)
        except ValueError:
            return None        # bad arguments: the normal tool says so
    for e in entries:
        ea = e.get('args') or {}
        if T._is_full(ea) if full else (not T._is_full(ea) and T._entry_time(e) == at):
            return e
    return None


def serve(name, args, ctx):
    """The recorded-first answer of a call (a ToolResult), or None.  The text is the one the first message would have carried."""
    from . import run as R
    from . import tools as T
    e = match(ctx.case, name, args, ctx.frame_t)
    if e is None:
        return None
    shown = R.resolve_evidence_raw({'evidence': [e]}, ctx.suite_dir or '.', ctx.redact, literal_epub=T._v3plus(ctx))[0]
    return T.ToolResult(shown['status'], shown['output'], served_from_record=e['id'])


def record(mode, case, shown, withheld, tool_calls):
    """Record field of a run with an active mode (absent in a `full` run): what was withheld, what a call returned, what was never asked for."""
    served = {c['served_from_record']: c['id'] for c in tool_calls if c.get('served_from_record')}
    ids = [e['id'] for e in withheld]
    return {'version': VERSION, 'mode': mode, 'serve': 'recorded-first', 'shown': [e['id'] for e in shown], 'withheld': ids,
            'withheld_tools': {e['id']: e.get('tool') for e in withheld},
            'obtained_by_call': {i: served[i] for i in ids if i in served}, 'never_asked_for': [i for i in ids if i not in served],
            'note': 'record only; the first message carried no entry listed under withheld; a call returned a recorded entry byte for byte (served_from_record)'}
