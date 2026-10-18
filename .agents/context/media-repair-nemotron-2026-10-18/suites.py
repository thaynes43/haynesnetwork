"""Read-only offline replay of pinned Media Repair suites; no inference or repair."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONTEXT = ROOT.parent


def read(path):
    return json.loads(path.read_text())


def verify(manifest, context=CONTEXT):
    for name, expected in manifest['sha256'].items():
        path = (context / name).resolve()
        if not path.is_relative_to(context.resolve()):
            raise ValueError('Path outside frozen context')
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Frozen artifact changed: ' + name)


def load(folder, filename):
    path = CONTEXT / folder / filename
    spec = importlib.util.spec_from_file_location('replay_' + folder.replace('-', '_') + filename.replace('.', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def exact_rows(rows, key, expected):
    ids = [row[key] for row in rows]
    if len(ids) != len(set(ids)) or set(ids) != set(expected):
        raise ValueError('Missing, duplicate or unexpected rows: ' + str(ids))
    return rows


def documentary(suite):
    folder = suite['folder']
    bench = load(folder, 'bench.py')
    cases = bench.load_cases()
    exact_rows(cases, 'id', suite['case_ids'])
    results = {}
    for variant, ids in suite['runs'].items():
        path = CONTEXT / folder / 'models' / variant
        rows = [json.loads(line) for line in (path / 'raw.jsonl').read_text().splitlines()]
        exact_rows(rows, 'request_id', ids)
        results[variant] = bench.score([c for c in cases if c['id'] in ids], {r['request_id']: r for r in rows})
    return results


def selection(suite):
    folder = suite['folder']
    assessor = load(folder, 'evaluate.py')
    truth = {r['case_id']: r for r in read(CONTEXT / folder / 'evaluator/truth.json')}
    result = []
    for model in suite['models']:
        paths = sorted((CONTEXT / folder / 'runs' / model).glob('*/trace.json'))
        traces = [read(p) for p in paths]
        exact_rows(traces, 'case_id', suite['case_ids'])
        for t in traces:
            score = assessor.assess(t.get('final'), t['observations'], truth[t['case_id']])
            result.append(dict(model=model, case_id=t['case_id'], proposal=t.get('final'), assessment=score,
                               recorded_execution=t['execution']))
    return result


def parsed_response(row):
    try:
        return json.loads((row.get('response') or {}).get('message', {}).get('content', ''))
    except ValueError:
        return None


def av(suite):
    folder = suite['folder']
    assessor = load(folder, 'score.py')
    truth = {r['case_id']: r for r in read(CONTEXT / folder / 'evaluator/truth.json')}
    result = []
    for variant in suite['variants']:
        cases = {r['case_id']: r for r in read(CONTEXT / folder / ('cases-' + variant + '.json'))}
        for model in suite['models']:
            rows = [read(p) for p in sorted((CONTEXT / folder / 'runs' / variant / model).glob('a*.json'))]
            exact_rows(rows, 'case_id', suite['case_ids'])
            for row in rows:
                result.append(dict(model=model, variant=variant, case_id=row['case_id'],
                                   assessment=assessor.assess(parsed_response(row), truth[row['case_id']], cases[row['case_id']])))
    return result


def schema(suite):
    # Replay actual malformed outputs, not synthetic approximations or truth changes.
    bench = load('media-repair-benchmark-2026-10-18', 'bench.py')
    old = CONTEXT / 'media-repair-benchmark-2026-10-18/models'
    rows = [json.loads(line) for line in (old / 'muse/raw.jsonl').read_text().splitlines()]
    fixed = [json.loads(line) for line in (old / 'muse-serving-full/raw.jsonl').read_text().splitlines()]
    for data in (rows, fixed):
        exact_rows(data, 'request_id', suite['documentary_ids'])
    baseline = bench.score(bench.load_cases(), {r['request_id']: r for r in rows})
    corrected = bench.score(bench.load_cases(), {r['request_id']: r for r in fixed})
    folder = 'media-repair-av-2026-10-18'
    assessor = load(folder, 'score.py')
    cases = {r['case_id']: r for r in read(CONTEXT / folder / 'cases.json')}
    truth = {r['case_id']: r for r in read(CONTEXT / folder / 'evaluator/truth.json')}
    results = []
    for cid in suite['av_ids']:
        for variant in ('runs', 'runs-bounded'):
            row = read(CONTEXT / folder / variant / 'muse-glimmer' / (cid + '.json'))
            results.append(dict(case_id=cid, variant=variant,
                                assessment=assessor.assess(parsed_response(row), truth[cid], cases[cid])))
    return {'documentary_baseline': baseline, 'documentary_serving_corrected': corrected, 'av': results}


REPLAY = {'documentary': documentary, 'epub-selection': selection, 'av-ocr': av, 'schema-regressions': schema}


def replay(manifest, selected=None):
    verify(manifest)
    return {s['id']: REPLAY[s['id']](s) for s in manifest['suites'] if selected is None or s['id'] == selected}


def main():
    manifest = read(ROOT / 'suites.json')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['list', 'replay'])
    parser.add_argument('--suite', choices=list(REPLAY))
    args = parser.parse_args()
    output = manifest['suites'] if args.command == 'list' else replay(manifest, args.suite)
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
