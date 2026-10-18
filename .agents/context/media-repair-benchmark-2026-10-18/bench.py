"""Offline documentary benchmark. No network, subprocess, or media-library access."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import resource
import shutil
import time
import unicodedata

ROOT = Path(__file__).resolve().parent


def load_cases():
    return [json.loads(line) for line in (ROOT / 'corpus.jsonl').read_text().splitlines()]


def norm(title):
    title = re.sub(r'^\[[^]]+\]\s*', '', title)
    return ''.join(c for c in unicodedata.normalize('NFKD', title).casefold() if c.isalnum())


def detector_payload(case):
    # Explicit allowlist: labels, splits, sources and repair catalogs are not sent.
    evidence = {'kind':case['input']['kind'], 'expected':case['input']['expected'],
                'observed':{k:v for k,v in case['input']['observed'].items()
                            if k != 'evidence_method'}}
    return {'request_id': case['id'], 'evidence': evidence}


def detect(evidence, version):
    expected, observed = evidence['expected'], evidence['observed']
    if version == 'v0':
        title = observed.get('catalog_title')
        return 'abstain' if not title else ('match' if title == expected['title'] else 'mismatch')
    titles = observed.get('content_titles', [])
    if not titles:
        return 'abstain'
    if evidence['kind'] == 'tv':
        reference = expected.get('segment_titles', [])
        if not reference:
            return 'abstain'
        return 'match' if {norm(t) for t in titles} == {norm(t) for t in reference} else 'mismatch'
    accepted = {norm(expected['title']), *(norm(t) for t in expected.get('aliases', []))}
    return 'match' if all(norm(t) in accepted for t in titles) else 'mismatch'


def metrics(cases, responses):
    counts = dict(tp=0, tn=0, fp=0, fn=0, abstentions=0, errors=0,
                  positive_abstentions=0, negative_abstentions=0,
                  positive_errors=0, negative_errors=0)
    for case in cases:
        decision = responses.get(case['id'], {}).get('decision', 'error')
        positive = case['label'] == 'mismatch'
        if decision in ('match', 'mismatch'):
            key = ('tp' if positive else 'fp') if decision == 'mismatch' else ('fn' if positive else 'tn')
            counts[key] += 1
        else:
            key = 'abstentions' if decision == 'abstain' else 'errors'
            counts[key] += 1
            counts[('positive_' if positive else 'negative_') + key] += 1
    n = len(cases)
    p = sum(c['label'] == 'mismatch' for c in cases)
    divide = lambda a, b: a / b if b else None
    return dict(n=n, positives=p, negatives=n-p, confusion=counts,
                accuracy=divide(counts['tp']+counts['tn'], n),
                precision=divide(counts['tp'], counts['tp']+counts['fp']),
                recall=divide(counts['tp'], p),
                false_positive_rate=divide(counts['fp'], n-p),
                coverage=divide(n-counts['abstentions']-counts['errors'], n))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture_repair(case, decision, directory):
    """Copy only reconstructed observations; choose independently of evaluator truth."""
    directory.mkdir()
    original = directory / 'original-observation.json'
    original.write_text(json.dumps(case['input']['observed'], sort_keys=True)+'\n')
    before = sha(original)
    active = directory / 'active-copy.json'
    shutil.copyfile(original, active)
    record = {'pointer': 'active-copy.json'}
    trace = {'operation': 'noop', 'selected': None}
    if decision == 'mismatch':
        eligible = []
        for candidate in case['candidates']:
            evidence = dict(case['input'], observed=candidate['observed'])
            if detect(evidence, 'v1') == 'match':
                eligible.append(candidate)
        if len(eligible) == 1:
            selected = eligible[0]
            # Keys are never used as paths. Local filenames are fixed by the harness.
            replacement = directory / 'candidate-copy.json'
            replacement.write_text(json.dumps(selected['observed'], sort_keys=True)+'\n')
            record['pointer'] = replacement.name
            trace = {'operation': 'repoint', 'selected': selected['key']}
        else:
            trace['operation'] = 'abstain'
    elif decision != 'match':
        trace['operation'] = 'abstain'
    (directory / 'result-record.json').write_text(json.dumps(record, sort_keys=True)+'\n')
    trace.update(original_sha256=before, original_preserved=sha(original) == before,
                 active_copy_preserved=sha(active) == before)
    # Evaluator-only oracle, never passed to detect or used to select a candidate.
    if case['label'] == 'mismatch':
        correct = trace['operation'] == 'repoint' and trace['selected'] == case['expected_candidate']
    else:
        correct = trace['operation'] == 'noop' and record['pointer'] == 'active-copy.json'
    saved = json.loads((directory / 'result-record.json').read_text())
    if case['label'] == 'mismatch':
        golden = next((a for a in case['candidates'] if a['key'] == case['expected_candidate']), None)
        readback = (golden is not None and saved['pointer'] == 'candidate-copy.json'
                    and json.loads((directory / saved['pointer']).read_text()) == golden['observed'])
    else:
        readback = saved['pointer'] == 'active-copy.json' and sha(directory / saved['pointer']) == before
    trace['readback_correct'] = readback
    trace['correct'] = correct and readback and trace['original_preserved'] and trace['active_copy_preserved']
    return trace


def score(cases, responses):
    return {split: metrics([c for c in cases if split == 'all' or c['split'] == split], responses)
            for split in ('all', 'development', 'held_out')}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'offline', 'score'])
    parser.add_argument('--out', type=Path, required=True, help='New directory; refuses overwrite')
    parser.add_argument('--responses', type=Path, help='For score: JSONL request_id/decision')
    args = parser.parse_args()
    cases = load_cases()
    args.out.mkdir(parents=True, exist_ok=False)
    corpus_hash = sha(ROOT / 'corpus.jsonl')
    if args.command == 'prepare':
        (args.out / 'requests.jsonl').write_text(''.join(json.dumps(detector_payload(c), sort_keys=True)+'\n' for c in cases))
        write_json(args.out / 'receipt.json', {'corpus_sha256': corpus_hash, 'requests': len(cases), 'network_calls': 0})
    elif args.command == 'score':
        if not args.responses:
            parser.error('score requires --responses')
        rows = [json.loads(x) for x in args.responses.read_text().splitlines()]
        known = {c['id'] for c in cases}
        ids = [r['request_id'] for r in rows]
        if len(set(ids)) != len(ids) or not set(ids) <= known:
            raise ValueError('Duplicate or unknown request_id')
        parsed = {}
        for row in rows:
            if 'raw_response' in row:
                try:
                    answer = json.loads(row['raw_response'])
                    decision = answer.get('decision') if isinstance(answer, dict) else 'error'
                except (TypeError, ValueError):
                    decision = 'error'
            else:
                decision = row.get('decision', 'error')
            parsed[row['request_id']] = {'decision':decision}
        write_json(args.out / 'scores.json', score(cases, parsed))
        write_json(args.out / 'receipt.json', {'corpus_sha256':corpus_hash,
                   'responses_sha256':sha(args.responses), 'model_identity':'not_attested_by_offline_scorer'})
    else:
        start, cpu_start = time.monotonic(), time.process_time()
        summary = {'kind': 'deterministic_offline_rules_not_model_inference',
                   'corpus_sha256': corpus_hash, 'requested_models': {'status': 'not_run_unavailable', 'scores': None}}
        for version in ('v0', 'v1'):
            rows, repairs = [], []
            for case in cases:
                began = time.perf_counter_ns()
                decision = detect(detector_payload(case)['evidence'], version)
                rows.append({'request_id':case['id'], 'decision':decision,
                             'latency_ns':time.perf_counter_ns()-began, 'method':version})
                if version == 'v1':
                    repairs.append({'request_id':case['id'], **fixture_repair(case, decision, args.out / case['id'])})
            (args.out / (version+'-raw.jsonl')).write_text(''.join(json.dumps(r, sort_keys=True)+'\n' for r in rows))
            summary[version] = score(cases, {r['request_id']:r for r in rows})
            if repairs:
                write_json(args.out / 'fixture-repairs.json', repairs)
                summary['fixture_reference_repair'] = {
                    'all_correct':sum(r['correct'] for r in repairs), 'n':len(repairs),
                    'positive_correct':sum(r['correct'] for r,c in zip(repairs,cases) if c['label']=='mismatch'),
                    'positive_n':sum(c['label']=='mismatch' for c in cases),
                    'all_originals_preserved':all(r['original_preserved'] and r['active_copy_preserved'] for r in repairs),
                    'actual_media_repair': 'not_run_no_media_fixtures'}
        proc_memory = {line.split(':')[0]:line.split(':')[1].strip()
                       for line in Path('/proc/self/status').read_text().splitlines()
                       if line.startswith(('VmRSS:', 'VmHWM:'))}
        summary['resources'] = {'proc_self_memory':proc_memory, 'wall_seconds':time.monotonic()-start,
                                'cpu_seconds':time.process_time()-cpu_start,
                                'max_rss_kib_linux':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                                'network_calls':0, 'gpu_calls':0,
                                'subscription_tokens':None, 'inference_tokens':0}
        write_json(args.out / 'summary.json', summary)
        print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
