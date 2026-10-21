"""Guards v4 (dev-c8, opt-in `--guards v4`, evidence format v3.1-format only): G-role, the role checks on a decision-v3 write.

Moved verbatim out of decision_guard.py in review round 3 (only so the wiring-smoke Job bundle, which carries decision_guard.py, stays under its
ceiling after main grew); `decision_guard.apply` imports this module only when v4 runs.  The frozen specification `V4_SPEC` is unchanged (its sha256 is
pinned in tests/test_devc8.py and in the what-if summary).

Details (as written in decision_guard.py at the freeze; offline on contract-v3 records through apply_to_record, driven by
  scripts/guards_v4_whatif.py: `mrh-guard` is a pinned input of the dev-c7 qwen-r2 registration and stays unchanged, so it refuses v4)
  Guards v3 run first and UNCHANGED.  When neither fires, G-role checks the role prerequisites of a decision-v3 write on audit v3 (the same
  `targets.audit_v3` as the record's audit), recomputed over the observations delivered to the model, with source.ref resolved through page origins.
  The prerequisite ids, the failure predicates and the unknown/unmet mapping are FROZEN in V4_SPEC below (fixed before any outcome count was looked at,
  AUDIT-ASTRA-36 item 1).  Only an audit state `unmet` can fire, and only when its predicate is enforceable: `unknown` never fires (the exemption is for these
  v4 checks only), and an `unmet` that rests on content the comparator could not recognise, or on a result whose pages were not all delivered, is recorded as
  `unrecognized` / `undelivered` and does not fire.  Declarations and prior-record claims are never promoted to content (the checker's statement kinds decide).
  Every role check is recorded in `guard.role_checks`, fired or not.
"""
import json
import re

from . import decision_guard as DG
from . import evidence_v2 as EV2
from . import protocol as P

# ---- guards v4 (dev-c8): FROZEN specification -------------------------------------------------------------------------------------------------------
V4_SPEC = {
    'version': 'v4',
    'frozen': '2026-10-21, before any dev-c7 outcome count was computed (AUDIT-ASTRA-36 item 1)',
    'inherits': 'guards v3 (G-healthy v3, G-write v3) unchanged and evaluated first',
    'scope': 'a write decision of decision-v3 (it carries source and target) on a contract-v3 record (evidence format v3 or v3.1-format)',
    'audit': 'targets.audit_v3 (the rubric v3.1 checker of the record audit) over the shown observations; source.ref resolved through page origins first',
    'prerequisites': {
        'A-REN-1': 'identity_level == content_verified (rename)',
        'A-REN-0': 'source_bound (rename)', 'A-BLK-2': 'source_bound (blocklist_and_search)', 'A-MAP-2': 'source_bound (remap)', 'A-CNV-0': 'source_bound (convert)',
        'A-BLK-1': 'managed_app (blocklist_and_search)', 'A-MAP-1': 'managed_app (remap)',
        'R-SRC': 'source_ref_qualifies (every write)',
    },
    'states': {
        'met': 'pass',
        'unknown': 'unknown: never fires',
        'unmet': 'fires (enforced) unless one of the non-enforcement predicates below holds',
    },
    'predicates': {
        'managed_app unmet': 'enforced: context.arr.app is not a managing app (the context is part of the first message, always delivered)',
        'source_bound unmet': 'enforced: a complete managed record of this item links a different file; undelivered if any such record was not fully delivered',
        'source_ref_qualifies unmet, unmanaged item': 'enforced: with context.arr.app null the source is case_item and the cited source is not',
        'source_ref_qualifies unmet, managed item': 'enforced: the cited source (after page-origin resolution) is not a shown record that binds the source; '
                                                    'undelivered if a deciding record was not fully delivered',
        'identity_level unmet, contradicted_by_content': 'enforced: a recognised content observation disagrees with the catalog on an identity attribute',
        'identity_level unmet, any content row the comparator did not recognise': 'unrecognized: a content observation that matched no catalog value at all may '
                                                                                  'carry the identity the comparator cannot read; not enforced',
        'identity_level unmet, contested': 'enforced: a declaration disagrees on an identity or edition attribute and no recognised content settles it',
        'identity_level unmet, uncontradicted': 'enforced (missing): no content observation agrees with the catalog on an identity attribute',
        'any role check, a result with undelivered pages': 'undelivered: not enforced (only delivered evidence is evaluated)',
    },
    'not_enforced': ('unknown', 'unrecognized', 'undelivered'),
}
V4_PREREQUISITES = tuple(V4_SPEC['prerequisites'])


def v4_context(context, media_type, capabilities, messages, tool_calls, evidence_format, evidence_ids=None, wire_texts=None, known_calls=None):
    """What G-role needs beyond the decision: the model-visible context, media type and capability advertisement (audit v3's inputs), the evidence format (which
    typed layer built the observations) and the ids whose pages were not all delivered: from the page log AND from the page objects of the messages
    actually sent (`wire_texts`; post-freeze correction 2, docs/dev-c8.md section 4: the log counts the pages a message was cut into for retrieval, and a
    message whose other pages cannot be fetched says "n of N" only on the wire)."""
    gone = set(undelivered_ids(messages, tool_calls, evidence_ids))
    if wire_texts is not None:
        gone |= wire_undelivered(wire_texts, evidence_ids, known_calls)
    return {'context': context or {}, 'media_type': media_type, 'capabilities': list(capabilities or []), 'format': evidence_format,
            'undelivered': sorted(gone)}


LABEL_RX = re.compile(r'^\[(?:CASE|HARNESS)\]\n')


def _envelope(text):
    """The harness envelope a sent text starts with (a rendered transcript block's label line removed), else None.  Only the envelope's own keys are read:
    nothing nested inside evidence content is ever taken for page metadata (post-freeze correction 3)."""
    if not isinstance(text, str):
        return None
    body = LABEL_RX.sub('', text, count=1).lstrip()
    if not body.startswith('{'):
        return None
    try:
        obj, _end = json.JSONDecoder().raw_decode(body)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _valid_page(page, allowed):
    if not isinstance(page, dict) or page.get('contract') != 'pages-v1' or page.get('source') not in allowed:
        return None
    n, of = page.get('n'), page.get('of')
    if not (isinstance(n, int) and isinstance(of, int)) or isinstance(n, bool) or isinstance(of, bool) or not 1 <= n <= of:
        return None
    return page['source'], n, of


def wire_pages(texts, known_calls=None):
    """{message id: {'of': N, 'seen': {page numbers}}} from the pagination of the texts sent to the model, read ONLY from trusted envelope locations: the
    first message's `evidence.page` (source `evidence`) and a tool result's `output.page` (source: its own id, or for a page fetch the id of an earlier
    message).  Source ids and page bounds are validated; a page object anywhere else (inside a catalog record, a tag, a body text) is content and ignored."""
    out, known = {}, set()
    for text in texts or []:
        obj = _envelope(text)
        if obj is None:
            continue
        if 'case_id' in obj and isinstance(obj.get('evidence'), dict) and obj.get('type') is None:
            got, own = _valid_page(obj['evidence'].get('page'), {'evidence'}), 'evidence'
        elif obj.get('type') == 'tool_result' and isinstance(obj.get('output'), dict) and isinstance(obj.get('id'), str):
            own = obj['id']
            if known_calls is not None and own not in known_calls:      # correction 4: a result envelope must belong to a recorded tool call
                continue
            got = _valid_page(obj['output'].get('page'), known | {own})
        else:
            continue
        known.add(own)
        if got is None:
            continue
        src, n, of = got
        rec = out.setdefault(src, {'of': of, 'seen': set()})
        rec['of'] = max(rec['of'], of)
        rec['seen'].add(n)
    return out


def wire_undelivered(texts, evidence_ids=None, known_calls=None):
    """Ids whose message reached the model in fewer pages than it has (unfetched, or not fetchable at all): `evidence` stands for every case evidence id."""
    out = set()
    for src, rec in wire_pages(texts, known_calls).items():
        if len(rec['seen']) < rec['of']:
            out |= set(evidence_ids or ['evidence']) if src == 'evidence' else {src}
    return out


CASE_LABEL, REPLY_SEP, HARNESS_SEP = '[CASE]\n', '\n\n[YOUR PREVIOUS REPLY]\n', '\n\n[HARNESS]\n'
TRANSCRIPT_TAIL = '\n\n[HARNESS]\nGive your next reply now: exactly one JSON object, nothing else.'


def transcript_harness_blocks(prompt, replies, expected=None, preamble=''):
    """The harness-authored messages of a rendered transcript (adapters.render_transcript) as an EXACT decomposition (post-freeze corrections 4 and 5):
    the transcript must be, in order and with nothing left over, the case message (one JSON envelope), then for each recorded reply its label, the reply
    text exactly as recorded (turns[].text) and the harness message that answered it, then the closing request.  `expected` names that harness message
    per reply from the record: ('repair', <the recorded repair prompt text>) or ('result', <the recorded tool call id>, a tool_result envelope with that id,
    optionally followed by the budget notice).  -> the list of harness texts, or None when anything does not match (the caller then treats every result
    as unread)."""
    if not isinstance(prompt, str) or not isinstance(preamble, str) or not prompt.startswith(preamble + CASE_LABEL):
        return None                     # correction 6: only the recorded adapter's own preamble may precede the case message
    i = len(preamble)
    if not prompt.endswith(TRANSCRIPT_TAIL):
        return None
    body, pos = prompt[:len(prompt) - len(TRANSCRIPT_TAIL)], i + len(CASE_LABEL)
    dec = json.JSONDecoder()
    try:
        first, end = dec.raw_decode(body, pos)
    except ValueError:
        return None
    if not (isinstance(first, dict) and 'case_id' in first):
        return None
    blocks, pos = [body[pos:end]], end
    if expected is not None and len(expected) != len(replies):
        return None
    notice = '\n' + P.BUDGET_MESSAGE
    for k, reply in enumerate(replies):
        if not isinstance(reply, str):
            return None
        marker = REPLY_SEP + reply + HARNESS_SEP
        if not body.startswith(marker, pos):
            return None
        pos += len(marker)
        want = expected[k] if expected is not None else None
        if want is None:
            return None
        if want[0] == 'repair':
            if not (isinstance(want[1], str) and body.startswith(want[1], pos)):
                return None
            blocks.append(want[1])
            pos += len(want[1])
        else:
            try:
                obj, end = dec.raw_decode(body, pos)
            except ValueError:
                return None
            if not (isinstance(obj, dict) and obj.get('type') == 'tool_result' and obj.get('id') == want[1]):
                return None
            if body.startswith(notice, end):
                end += len(notice)
            blocks.append(body[pos:end])
            pos = end
    return blocks if pos == len(body) else None


def expected_harness_messages(record, turns):
    """Per earlier reply (turns, in order): the harness message the record says answered it -- its repair prompt, else the tool call made at that turn."""
    repairs = {r.get('after_turn'): r.get('prompt') for r in (record or {}).get('repair_prompts') or [] if isinstance(r, dict)}
    calls = {}
    for c in (record or {}).get('tool_calls') or []:
        if isinstance(c, dict):
            calls.setdefault(c.get('turn'), []).append(c.get('id'))
    out = []
    for turn in turns:
        n = turn.get('n')
        if n in repairs:
            out.append(('repair', repairs[n]))
        elif len(calls.get(n, [])) == 1:
            out.append(('result', calls[n][0]))
        else:
            out.append(None)
    return out


def adapter_preamble(record, req):
    """The text the recorded adapter puts before the case message (correction 6): none for Claude (its system prompt is a separate argument); for Codex
    exactly the recorded system prompt and a rule (`<system>\n\n---\n\n`), the prompt text being the one whose sha256 the record carries.  -> the
    preamble, or None for any other request shape (then the transcript is unreadable)."""
    argv = (req or {}).get('argv') or []
    tool = argv[0] if argv and isinstance(argv[0], str) else None
    if tool == 'claude':
        return ''
    if tool == 'codex':
        pv = ((record or {}).get('prompt') or {})
        try:
            pr = P.get_prompt(pv.get('version'))
        except (ValueError, TypeError):
            return None
        return pr['text'] + '\n\n---\n\n' if pr['sha256'] == pv.get('sha256') else None
    return None


def record_wire(record):
    """{'status': 'ok' | 'no_request' | 'unreadable', 'texts': [...]}: the harness-authored texts of the last recorded request, by actual message
    boundaries: a message list by role and index; a rendered transcript by its exact decomposition (transcript_harness_blocks)."""
    turns = (record or {}).get('turns') or []
    for idx in range(len(turns) - 1, -1, -1):
        req = turns[idx].get('raw_request')
        if isinstance(req, dict) and isinstance(req.get('messages'), list):
            return {'status': 'ok', 'texts': [m.get('content') for m in req['messages'] if isinstance(m, dict) and m.get('role') == 'user']}
        if isinstance(req, dict) and isinstance(req.get('prompt'), str):
            earlier = turns[:idx]
            pre = adapter_preamble(record, req)
            blocks = None if pre is None else transcript_harness_blocks(req['prompt'], [t.get('text') for t in earlier], expected_harness_messages(record, earlier), pre)
            return {'status': 'ok', 'texts': blocks} if blocks is not None else {'status': 'unreadable', 'texts': None}
    return {'status': 'no_request', 'texts': None}


def record_wire_texts(record):
    """The harness-authored texts of the last recorded request (record_wire), or None when there is none or it cannot be read by its boundaries."""
    return record_wire(record)['texts']


def _page_key(pages_of, evidence_ids):
    """The message a page fetch belongs to.  The runner records `pages_of` as a LIST of origin ids (session.page_origin): a page of a tool result names that one
    result; a page of the first message names case evidence ids only.  (A bare string, an older shape, names one result.)"""
    if isinstance(pages_of, str):
        return pages_of
    ids = [x for x in pages_of or [] if isinstance(x, str)]
    if not ids:
        return None
    if evidence_ids is not None and set(ids) <= set(evidence_ids):
        return 'evidence'
    if evidence_ids is None and all(x.startswith('e') for x in ids):
        return 'evidence'
    return ids[0] if len(ids) == 1 else None


def undelivered_ids(messages, tool_calls, evidence_ids=None):
    """Ids of results the model did not receive in full: a message of n pages of which fewer than n were delivered (the first page plus one per distinct page
    cursor fetched).  The first message (`evidence`) stands for every case evidence id; when they are not given, the marker `evidence` is returned."""
    fetched = {}
    for c in tool_calls or []:
        po = c.get('pages_of')
        if not (c.get('continuation') and po):
            continue
        key = _page_key(po, evidence_ids)
        if key is None:
            continue
        fetched.setdefault(key, set()).add(str((c.get('args') or {}).get('cursor') or c.get('id')))
    out = set()
    for m in messages or []:
        if m.get('kind') not in ('initial', 'result'):
            continue
        pages = m.get('pages') or 1
        key = 'evidence' if m.get('kind') == 'initial' else m.get('id')
        if pages > 1 + len(fetched.get(key, ())):
            out |= set(evidence_ids or ['evidence']) if key == 'evidence' else {key}
    return out


def _v4_obs(ctx, evidence_shown, tool_calls):
    if ctx.get('format') == 'v3.1-format':
        from . import evidence_v31 as EVX
    else:
        from . import evidence_v3 as EVX
    return EVX.shown_observations(evidence_shown, tool_calls)


def _ref_obs(ref):
    """The observation id a checker reference names (`e1:files[0]` -> e1, `t2:tags_empty` -> t2, `context.filename` -> None)."""
    if not isinstance(ref, str) or ref.startswith(('context.', 'client_comparison', 'coverage')) or ref == 'case_item':
        return None
    return ref.split(':')[0].split('.')[0]


# Tools whose results never carry an identity, naming or catalog statement (the checker reads statements only from the others).  Decided by the tool KIND of
# a shown result, never by what its (possibly unread) values contain (post-freeze correction 3).
NO_IDENTITY_TOOLS = ('decode_sample', 'audio_sample', 'frame_sample')


def _deciding(check, obs, source_ref):
    """The observation ids a role check may read, from the ids and tool kinds of the shown results only (never from their values): identity reads every result
    that can carry an identity, naming or catalog statement, the catalog records included; the source checks read every catalog record and the cited source;
    a managing app reads the context only."""
    if check == 'identity_level':
        return {o['id'] for o in obs if o.get('tool') not in NO_IDENTITY_TOOLS}
    if check in ('source_bound', 'source_ref_qualifies'):
        return ({o['id'] for o in obs if o.get('tool') == 'arr_lookup'} | {_ref_obs(source_ref)}) - {None}
    return set()


def check_role_v4(decision, ctx, evidence_shown, tool_calls):
    """Guards v4 G-role (V4_SPEC, frozen).  -> (reason or None, role_checks).  Never fires on a non-write, on a decision without a source (not decision-v3) or
    on a decision the decision-v3 validator refuses."""
    if not isinstance(decision, dict) or decision.get('action') not in P.WRITE_ACTIONS or not isinstance(decision.get('source'), dict):
        return None, []
    from .experimental.contract_v3 import prereq as PQ
    from .experimental.contract_v3 import targets as TG
    obs = _v4_obs(ctx, evidence_shown, tool_calls)
    origins = EV2.page_origin_map(tool_calls)
    src = decision['source'].get('ref')
    resolved = origins[src][0] if (src in origins and len(origins[src]) == 1) else src
    dec = dict(decision, source=dict(decision['source'], ref=resolved))
    audit = TG.audit_v3(dec, obs, ctx.get('context') or {}, ctx.get('media_type'), ctx.get('capabilities') or [])
    if audit.get('schema_errors'):
        return None, []
    v = PQ.View(obs, ctx.get('context') or {}, ctx.get('media_type'), ctx.get('capabilities') or [])
    level, rows, _per = v.identity()
    shown_ids = {o['id'] for o in obs}
    undelivered = set(ctx.get('undelivered') or [])
    if 'evidence' in undelivered:
        undelivered |= {e.get('id') for e in evidence_shown or []}
    managed = ((ctx.get('context') or {}).get('arr') or {}).get('app') in PQ.ARR_APPS
    checks = []
    for pre in audit.get('prerequisites') or []:
        if pre['id'] not in V4_PREREQUISITES:
            continue
        state, check, refs = pre['state'], pre['check'], list(pre.get('refs') or [])
        status, why = None, ''
        deciding = _deciding(check, obs, resolved)
        if deciding & undelivered:     # post-freeze correction 2: unread content decides nothing, and the state computed from it is not recorded either
            state, refs = None, sorted(deciding & undelivered)
            status, why = 'undelivered', 'a deciding result was not fully delivered: %s' % ', '.join(refs)
        elif state == PQ.MET:
            status = 'met'
        elif state != PQ.UNMET:
            status, why = 'unknown', pre.get('detail') or ''
        elif check == 'managed_app':
            status, why = 'enforced', 'no managing app in the context'
        elif check == 'source_bound':
            deciding = {_ref_obs(r) for r in refs} - {None}
            status, why = ('undelivered', 'a deciding record was not fully delivered') if deciding & undelivered else ('enforced', pre.get('detail') or '')
        elif check == 'source_ref_qualifies':
            if not managed:
                status, why = 'enforced', 'an item without a managing app has the source case_item; the cited source is %s' % resolved
            else:
                _st, brefs, _d = PQ.check_named(v, 'source_bound')
                deciding = ({_ref_obs(r) for r in brefs} | {_ref_obs(resolved)}) - {None}
                status, why = (('undelivered', 'a deciding record was not fully delivered') if deciding & undelivered else
                               ('enforced', 'the cited source %s is not a shown record that binds this file%s' % (
                                   resolved, '' if resolved in shown_ids or resolved == 'case_item' else ' (no result with that id was shown)')))
        elif check == 'identity_level':
            content = [r for r in rows if r['kind'] in PQ.CONTENT_KINDS]
            unrecognized = [r['ref'] for r in content if not r['attributes']]
            row_obs = {_ref_obs(r['ref']) for r in rows} - {None}
            if row_obs & undelivered:
                status, why = 'undelivered', 'an identity-bearing result was not fully delivered'
            elif level == 'contradicted_by_content':
                refs = [r['ref'] for r in content if 'disagree' in r['attributes'].values()]
                status, why = 'enforced', 'content disagrees with the catalog on an identity attribute'
            elif unrecognized:
                status, why = 'unrecognized', 'content the comparator could not match to any catalog value: %s' % ', '.join(unrecognized[:4])
            elif level == 'contested':
                refs = [r['ref'] for r in rows if 'disagree' in r['attributes'].values()]
                status, why = 'enforced', 'a declaration disagrees on an identity or edition attribute and no content settles it'
            else:
                status, why = 'enforced', 'missing: no content observation agrees with the catalog on an identity attribute (identity %s)' % level
        else:
            status, why = 'unknown', 'no v4 predicate for check %s' % check
        checks.append({'id': pre['id'], 'check': check, 'audit_state': state, 'v4_status': status, 'refs': refs, 'detail': why})
    fired = [c for c in checks if c['v4_status'] == 'enforced']
    if not fired:
        return None, checks
    return ('%s with unmet role prerequisite(s): %s' % (decision.get('action'), '; '.join('%s (%s)' % (c['id'], c['detail']) for c in fired)))[:360], checks


def record_v4_context(record, case, evidence_shown):
    """G-role's inputs for an existing contract-v3 record (None for any other record): the context and media type as the model saw them, the recorded capability
    advertisement and the recorded messages (pages sent)."""
    fmt = DG._v3_format(record)
    if fmt not in DG.V3_FORMATS:
        return None
    view = P.case_view(case, [])
    ctx = v4_context(view['context'], view['media_type'], DG._v3_caps(record), (record.get('evidence_format') or {}).get('messages'), record.get('tool_calls'), fmt)
    ev_ids = [e.get('id') for e in evidence_shown or []]
    calls = [c.get('id') for c in record.get('tool_calls') or []]
    gone = undelivered_ids((record.get('evidence_format') or {}).get('messages'), record.get('tool_calls'), ev_ids)
    wire = record_wire(record)
    if wire['status'] == 'ok':
        gone |= wire_undelivered(wire['texts'], ev_ids, calls)
    elif wire['status'] == 'unreadable':          # correction 4: no boundary can be trusted, so nothing counts as read
        gone |= set(ev_ids) | set(calls)
    ctx['undelivered'] = sorted(gone)
    return ctx
