#!/usr/bin/env python3
"""Offline reachability table for the must-ask arm (OpenProject #209): `--evidence-handover none` on suite dev-v1.1.

For every case: which pre-collected evidence entries the mode withholds, whether an offered tool call returns each of them in replay (byte for byte, with its
recorded status), the least number of calls that obtains them all against the 6-call budget, and the cases that become partly or wholly unreachable.

It runs the real runner (`run.run_case`) per case with a scripted adapter that makes exactly the calls needed (no model, no GPU, no network, no subprocess,
no ffmpeg: every tool answers from the committed recordings), in the configuration of the registered local-model runs: evidence format v3.1-format, prompt
v7, guards v3, tool output bytes 8192.  Pages come from that run's own record: a result longer than one page needs one more call per extra page.

    python3 tools/media-repair-harness/scripts/must_ask_reachability.py            # writes docs/must-ask-reachability.{md,json}
    python3 tools/media-repair-harness/scripts/must_ask_reachability.py --check    # regenerates in memory and compares with the committed files

Stdlib only.  Deterministic: no clock, no path, no random value reaches the output.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))

from media_repair_harness import adapters as A      # noqa: E402
from media_repair_harness import handover as HO     # noqa: E402
from media_repair_harness import protocol as P      # noqa: E402
from media_repair_harness import run as R           # noqa: E402
from media_repair_harness import tools as T         # noqa: E402

VERSION = 'must-ask-reachability-1'
DEFAULT_SUITE = COMPONENT.parents[1] / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
OUT_MD = COMPONENT / 'docs' / 'must-ask-reachability.md'
OUT_JSON = COMPONENT / 'docs' / 'must-ask-reachability.json'
# the configuration the table is computed in (the registered local-model runs of dev-c7)
CONFIG = {'evidence_format': 'v3.1-format', 'prompt': 'v7', 'guards': 'v3', 'tool_output_bytes': P.TOOL_OUTPUT_BYTES, 'evidence': 'replay', 'evidence_handover': 'none'}
SUITE_REL = '.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1'


def call_for(entry):
    """The call that returns a recorded entry: the argument form the capability advertisement describes (`at` seconds, or `full`)."""
    tool, args = entry['tool'], entry.get('args') or {}
    if tool == 'decode_sample':
        return {'full': True} if T._is_full(args) else {'at': T._entry_time(entry)}
    if tool == 'ocr':
        return {'at': T._entry_time(entry)}
    return {}


def shown_text(case, suite_dir, entry):
    """What the first message would carry for this entry in the table's configuration."""
    fixture = T.Fixture.from_case(case, suite_dir)
    ctx = T.Context(case, fixture, tempfile.mkdtemp(), suite_dir=suite_dir, which=lambda n: None, tools_behavior='v3', keep_raw=True)
    s = R.resolve_evidence_raw({'evidence': [entry]}, suite_dir, ctx.redact, literal_epub=True)[0]
    return s['output'], s['status']


def analyse(case, sha, suite_dir):
    offered = case.get('tools_available') or []
    items, planned = [], []
    for e in case.get('evidence', []):
        item = {'id': e['id'], 'tool': e['tool'], 'recorded_status': e.get('status', 'ok'), 'askable': HO.askable(case, e)}
        if e['tool'] not in P.TOOLS or e['tool'] not in HO.SERVED_TOOLS:
            item.update(reachable=False, reason='no_tool', detail='no harness tool produces %s (a note carried over from an earlier report)' % e['tool'])
        elif e['tool'] not in offered:
            item.update(reachable=False, reason='tool_not_offered', detail='%s is not in tools_available' % e['tool'])
        else:
            item['call'] = {'tool': e['tool'], 'args': call_for(e)}
            item['bare_call_returns_it'] = HO.match(case, e['tool'], {}, {}) is e      # a call with no arguments (a time defaults to 0 s) already returns it
            planned.append((e, item))
        items.append(item)
    calls = planned[:P.MAX_TOOL_CALLS]
    for _e, item in planned[P.MAX_TOOL_CALLS:]:
        item.update(reachable=False, reason='over_budget', detail='more than %d calls would be needed' % P.MAX_TOOL_CALLS)
    replies = [json.dumps({'type': 'tool_call', 'tool': it['call']['tool'], 'args': it['call']['args'], 'why': 'reachability'}) for _e, it in calls]
    replies.append(json.dumps(P.forced_decision_for(CONFIG['prompt'], 'reachability probe')))
    adapter = A.ScriptedAdapter('reachability', replies)
    rec = R.run_case(case, sha, adapter, suite_dir, tempfile.mkdtemp(), which=lambda n: None, run_id='reachability', tool_output_bytes=CONFIG['tool_output_bytes'],
                     prompt_version=CONFIG['prompt'], guards=CONFIG['guards'], evidence_format=CONFIG['evidence_format'], evidence_handover='none')
    messages = {m['id']: m for m in rec['evidence_format']['messages']}
    for (e, item), call in zip(calls, rec['tool_calls']):
        want, want_status = shown_text(case, suite_dir, e)
        got = call.get('raw_output', call.get('output'))
        item['call_id'] = call['id']
        item['returned_status'] = call['status']
        item['pages'] = messages.get(call['id'], {}).get('pages', 1)
        if call.get('served_from_record') == e['id'] and got == want and call['status'] == want_status:
            item.update(reachable=True, returns='identical')
        elif HO.injected_shadow(case, e['tool']):
            item.update(reachable=False, reason='injected_failure', detail='the case injects a %s into every %s call; the recorded output cannot be returned' % (case['inject_tool_failure'].get('mode', 'error'), e['tool']))
        else:
            item.update(reachable=False, reason='differs', detail='the call returned something other than the recorded entry')
    withheld = items
    reach = [i for i in withheld if i.get('reachable')]
    first = len(reach)
    all_pages = sum(i['pages'] for i in reach)
    flags = []
    if not offered:
        flags.append('no_tools_offered')
    for r in ('no_tool', 'tool_not_offered', 'injected_failure', 'differs', 'over_budget'):
        if any(i.get('reason') == r for i in withheld):
            flags.append(r)
    if all_pages > P.MAX_TOOL_CALLS:
        flags.append('over_budget_with_pages')
    if any(i.get('pages', 1) > 1 for i in reach):
        flags.append('multi_page')
    if not reach:
        status = 'unreachable'
    elif len(reach) == len(withheld) and all_pages <= P.MAX_TOOL_CALLS:
        status = 'fully_reachable'
    else:
        status = 'partially_reachable'
    return {'case': case['id'], 'media_type': case.get('media_type'), 'truth_class': (case.get('truth') or {}).get('class'), 'solvable': case.get('solvable'),
            'fixture_kind': (case.get('fixture') or {}).get('kind'), 'tools_offered': list(offered), 'withheld': withheld, 'withheld_count': len(withheld),
            'reachable_count': first, 'min_calls': first, 'min_calls_with_all_pages': all_pages, 'call_budget': P.MAX_TOOL_CALLS,
            'status': status, 'flags': flags,
            'askable_withheld': [i['id'] for i in withheld if i['askable']], 'askable_kept': [i['id'] for i in withheld if not i['askable']],
            'rerun_ok': rec.get('forced') is False and not rec.get('error')}


def build(suite):
    suite_dir = R.suite_root(suite)
    cases = [analyse(c, s, suite_dir) for c, s in R.load_cases(suite)]
    counts = {}
    for c in cases:
        counts[c['status']] = counts.get(c['status'], 0) + 1
    flag_counts = {}
    for c in cases:
        for f in c['flags']:
            flag_counts[f] = flag_counts.get(f, 0) + 1
    items = [i for c in cases for i in c['withheld']]
    summary = {'cases': len(cases), 'by_status': dict(sorted(counts.items())), 'flags': dict(sorted(flag_counts.items())),
               'withheld_entries': len(items), 'reachable_entries': sum(1 for i in items if i.get('reachable')),
               'unreachable_entries_by_reason': dict(sorted(_count(i['reason'] for i in items if not i.get('reachable')).items())),
               'max_min_calls': max((c['min_calls'] for c in cases), default=0), 'max_min_calls_with_all_pages': max((c['min_calls_with_all_pages'] for c in cases), default=0),
               'cases_over_budget': [c['case'] for c in cases if 'over_budget_with_pages' in c['flags'] or 'over_budget' in c['flags']],
               'entries_needing_arguments': sorted(_count('%s %s' % (i['tool'], json.dumps(i['call']['args'], sort_keys=True, separators=(',', ':'))) for i in items
                                                         if i.get('reachable') and not i['bare_call_returns_it']).items()),
               'askable_kept_entries': sum(len(c['askable_kept']) for c in cases),
               'cases_unchanged_by_askable': sum(1 for c in cases if not c['askable_withheld'])}
    return {'version': VERSION, 'harness_version': P.HARNESS_VERSION, 'handover_version': HO.VERSION, 'suite': SUITE_REL,
            'suite_version': (R.load_cases(suite)[0][0].get('suite_version') if cases else None), 'configuration': CONFIG, 'summary': summary, 'cases': cases}


def _count(it):
    out = {}
    for x in it:
        out[x] = out.get(x, 0) + 1
    return out


def render_md(doc):
    s = doc['summary']
    L = ['# Must-ask reachability (OpenProject #209)', '',
         'Reproduce (from the repository root; stdlib only, no model, no GPU, no network):', '',
         '```', 'python3 tools/media-repair-harness/scripts/must_ask_reachability.py', '```', '',
         'Check against the committed files: `... must_ask_reachability.py --check`. Suite `%s` (%s), harness `%s`, handover `%s`.' % (
             doc['suite'], doc['suite_version'], doc['harness_version'], doc['handover_version']), '',
         'Computed in the configuration of the registered local-model runs: `--evidence-format v3.1-format --prompt v7 --guards v3 --evidence replay --evidence-handover none`, '
         'tool output 8192 bytes. For each case the real runner ran with a scripted adapter making exactly the calls below; a "pages" count is the run\'s own, and a result of more '
         'than one page costs one more call per extra page.', '',
         '## Summary', '']
    st = s['by_status']
    L += ['- %d cases. **Fully reachable within the %d-call budget: %d.** Partially reachable: %d. Unreachable: %d.' % (
        s['cases'], P.MAX_TOOL_CALLS, st.get('fully_reachable', 0), st.get('partially_reachable', 0), st.get('unreachable', 0)),
        '- %d of %d withheld entries come back byte for byte, with their recorded status, from one call each. The rest, by reason: %s.' % (
            s['reachable_entries'], s['withheld_entries'], ', '.join('%s %d' % (k, v) for k, v in s['unreachable_entries_by_reason'].items()) or 'none'),
        '- A call with no arguments (a time then means 0 s) already returns %d of those entries; the other %d need an argument the prompt describes (`at` seconds or `full`): %s.' % (
            s['reachable_entries'] - sum(n for _k, n in s['entries_needing_arguments']), sum(n for _k, n in s['entries_needing_arguments']),
            ', '.join('%s x%d' % (k, n) for k, n in s['entries_needing_arguments']) or 'none'),
        '- Most calls any case needs: %d (%d counting every extra page). Cases over the budget: %s.' % (
            s['max_min_calls'], s['max_min_calls_with_all_pages'], ', '.join(s['cases_over_budget']) or 'none'),
        '- `--evidence-handover askable` keeps the %d entries no offered call can return in the first message; it changes nothing for %d cases.' % (
            s['askable_kept_entries'], s['cases_unchanged_by_askable']),
        '- Flags: ' + (', '.join('%s %d' % (k, v) for k, v in s['flags'].items()) or 'none') + '.', '',
         'Reasons: `no_tool` = no harness tool produces the entry (`prior_record`); `tool_not_offered` = its tool is not in the case\'s `tools_available`; `injected_failure` = the case '
         'injects an error or timeout into every call of that tool, so the recorded output cannot be returned; `differs` = the call returned something else (none expected); '
         '`over_budget` = more than 6 calls. Status: fully = every withheld entry reachable and all pages within 6 calls; partially = some; unreachable = none.', '',
         '## Per case', '',
         '| case | class | fixture | tools | withheld | reachable | calls (pages) | status | flags | unreachable entries |',
         '|---|---|---|---|---|---|---|---|---|---|']
    for c in doc['cases']:
        miss = '; '.join('%s %s (%s)' % (i['id'], i['tool'], i['reason']) for i in c['withheld'] if not i.get('reachable')) or ''
        withheld = ', '.join('%s %s' % (i['id'], i['tool']) for i in c['withheld'])
        reach = ', '.join('%s via %s %s' % (i['id'], i['call']['tool'], json.dumps(i['call']['args'], sort_keys=True, separators=(',', ':'))) for i in c['withheld'] if i.get('reachable'))
        L.append('| %s | %s | %s | %d | %s | %s | %d (%d) | %s | %s | %s |' % (c['case'], c['truth_class'], c['fixture_kind'], len(c['tools_offered']), withheld, reach or '-',
                                                                               c['min_calls'], c['min_calls_with_all_pages'], c['status'], ' '.join(c['flags']) or '-', miss or '-'))
    L += ['', 'The full per-entry table (call arguments, returned status, pages, askable) is in `must-ask-reachability.json`.', '']
    return '\n'.join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--suite', default=str(DEFAULT_SUITE))
    ap.add_argument('--out-md', default=str(OUT_MD))
    ap.add_argument('--out-json', default=str(OUT_JSON))
    ap.add_argument('--check', action='store_true', help='compare with the committed files instead of writing them')
    args = ap.parse_args(argv)
    doc = build(args.suite)
    js = json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + '\n'
    md = render_md(doc) + '\n'
    if args.check:
        bad = [p for p, text in ((args.out_json, js), (args.out_md, md)) if not Path(p).is_file() or Path(p).read_text() != text]
        if bad:
            print('stale: %s (regenerate with this script)' % ', '.join(bad), file=sys.stderr)
            return 1
        print('ok: %d cases' % len(doc['cases']))
        return 0
    Path(args.out_json).write_text(js)
    Path(args.out_md).write_text(md)
    print('wrote %s and %s: %s' % (args.out_md, args.out_json, json.dumps(doc['summary']['by_status'], sort_keys=True)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
