"""Capabilities and gaps (dev-c2): what a run could and could not verify, as structured data an escalate decision can cite.

Record only.  Nothing here is shown to the model (the model sees the tool results and nothing else), nothing is scored, and no decision is
rewritten.  `evidence_summary` is called once per case and lands in the run record as `evidence`:

  mode          'replay' | 'live': the evidence mode the run selected
  capabilities  one entry per harness tool: offered for the case or not, how often it was called, the statuses it came back with, and (live)
                which collector kind backs it.  A tool that is not offered is a capability the case does not have.
  gaps          one entry per thing that was NOT verified, each with the call that showed it (`call`, citeable like any t-id), the tool,
                the status, the `type`, the area left unverified, the reason, and the harness tool that would be needed to verify it
                (`needed_tool`, null when no harness tool can; `needed_note` says why or how).
  gaps_cited    ids of the gaps whose call the decision cited in evidence_refs

gap `type`:
  not_run     the tool did not run or did not finish (unavailable, timeout, an error of the tool itself); everything it covers is unverified
  incomplete  the tool ran and answered only in part (partial); the rest of what it covers is unverified
  standing    the tool ran and answered, and its own record says what it did not cover (a sample is not the whole file)
A damage finding (an `error` that is a finding about the file: the tool ran and reported damage) is not a gap; it is evidence.
"""
import json
import re

# what each harness tool covers, in plain words (the area a non-ok result leaves unverified)
AREA = {
    'ffprobe': 'container, stream and chapter metadata',
    'decode_sample': 'decodability of the sampled windows',
    'frame_sample': 'picture content at the sampled offsets',
    'audio_sample': 'audio levels and silence in the sampled windows',
    'ocr': 'on-screen text at the sampled offsets',
    'epub_inspect': 'EPUB archive, package and spine structure',
    'audiobook_inspect': 'audiobook parts, chapters and tags',
    'arr_lookup': 'the *arr record for the item',
}
MEDIA_TOOLS = ('ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr', 'epub_inspect', 'audiobook_inspect', 'arr_lookup')
# standing limits that a different harness tool addresses (matched on the collector's own wording; a hint for the reader, not a rule)
STANDING_NEEDS = (
    (re.compile(r'whole.file|full decode|not sampled|between the sampled|clean sample', re.I), 'decode_sample', 'a full decode (decode_sample with full), capped by the tool'),
    (re.compile(r'on-screen text|ocr|tesseract', re.I), 'ocr', 'an OCR reading of the frames'),
    (re.compile(r'speech|spoken|said|transcri|language.*(checked|verified)|(checked|verified).*language', re.I), None, 'no harness tool checks speech'),
)


def _text(call):
    out = call.get('output')
    return out if isinstance(out, str) else json.dumps(out, sort_keys=True, ensure_ascii=False)


def is_damage_finding(call):
    """An `error` that is a finding about the file: the tool ran and reported damage (live: cause `input`; replay: the tool's own exit code or stage)."""
    if call.get('status') != 'error' or call.get('injected'):
        return False
    ev = call.get('evidence') or {}
    if ev.get('cause') == 'input':
        return True
    try:
        d = json.loads(_text(call))
    except ValueError:
        return False
    return isinstance(d, dict) and ('exit_code' in d or 'stage' in d)


def _reason(call):
    ev = call.get('evidence') or {}
    if ev.get('reason'):
        return str(ev['reason'])[:240]
    text = _text(call).strip()
    return text[:240] if text and not text.startswith(('{', '[')) else None


def _needed(tool, kind, offered):
    if kind == 'standing':
        return None, None
    note = 'not offered for this case' if not offered else 'rerun where the capability is present; nothing was learned from this call'
    return tool, note


def call_gaps(call, offered=True):
    """Gaps shown by one tool call (a dict of run.py's tool_calls)."""
    tool, status = call.get('tool'), call.get('status')
    if tool not in AREA:
        return []
    base = {'call': call.get('id'), 'tool': tool, 'status': status, 'evidence_mode': call.get('evidence_mode')}
    ev = call.get('evidence') or {}
    gaps = []
    if status == 'ok':
        for item in (ev.get('coverage') or {}).get('not_verified', []):
            gaps.append(dict(base, type='standing', area=str(item)[:240], reason=None, **_standing_need(item)))
        if not ev and tool in ('decode_sample', 'frame_sample', 'audio_sample') and call.get('evidence_mode') == 'replay' and not (call.get('args') or {}).get('full'):
            gaps.append(dict(base, type='standing', area='the rest of the file: this was a sample of one window', reason=None,
                             needed_tool='decode_sample', needed_note='a full decode (decode_sample with full), capped by the tool'))
        return gaps
    if status == 'error' and is_damage_finding(call):
        for item in (ev.get('coverage') or {}).get('not_verified', []):
            gaps.append(dict(base, type='standing', area=str(item)[:240], reason=None, **_standing_need(item)))
        return gaps
    kind = 'incomplete' if status == 'partial' else 'not_run'
    needed, note = _needed(tool, kind, offered)
    areas = (ev.get('coverage') or {}).get('not_verified') or ['%s: %s' % (AREA[tool], 'not verified')]
    for item in areas:
        gaps.append(dict(base, type=kind, area=str(item)[:240], reason=_reason(call), needed_tool=needed, needed_note=note))
    return gaps


def _standing_need(item):
    for rx, tool, note in STANDING_NEEDS:
        if rx.search(str(item)):
            return {'needed_tool': tool, 'needed_note': note}
    return {'needed_tool': None, 'needed_note': 'no further harness tool covers this'}


def evidence_summary(case, tool_calls, evidence_mode, decision=None, live_kinds=None):
    offered = set(case.get('tools_available', []))
    caps = []
    for tool in MEDIA_TOOLS:
        calls = [c for c in tool_calls if c.get('tool') == tool]
        statuses = {}
        for c in calls:
            statuses[c['status']] = statuses.get(c['status'], 0) + 1
        caps.append({'tool': tool, 'offered': tool in offered, 'calls': len(calls), 'statuses': statuses,
                     'live_kind': (live_kinds or {}).get(tool) if evidence_mode == 'live' else None})
    gaps = []
    for c in tool_calls:
        for g in call_gaps(c, offered=c.get('tool') in offered):
            gaps.append(dict(g, id='g%d' % (len(gaps) + 1)))
    refs = set((decision or {}).get('evidence_refs') or [])
    return {'mode': evidence_mode, 'capabilities': caps, 'gaps': gaps, 'gaps_cited': [g['id'] for g in gaps if g['call'] in refs],
            'note': 'record only: not shown to the model, not scored. A gap is something the run did not verify; a damage finding is evidence, not a gap.'}
