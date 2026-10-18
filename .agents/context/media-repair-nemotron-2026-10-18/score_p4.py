"""Offline scoring only; no inference or source/media access."""
import importlib.util
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'media-repair-benchmark-2026-10-18'))
import bench
spec = importlib.util.spec_from_file_location('av_frozen', ROOT.parent / 'media-repair-av-identity-2026-10-18/score.py')
av = importlib.util.module_from_spec(spec)
spec.loader.exec_module(av)


def read(path):
    return json.loads(path.read_text())


def parse(row):
    try:
        message = (row.get('response') or {}).get('message')
        return json.loads(message.get('content', '')) if isinstance(message, dict) else None
    except ValueError:
        return None


def main():
    output = []
    cases = bench.load_cases()
    avcases = {c['case_id']: c for c in read(ROOT / 'text-cases.json')}
    truth = {c['case_id']: c for c in read(ROOT.parent / 'media-repair-av-identity-2026-10-18/evaluator/truth.json')}
    for model in read(ROOT / 'p4-protocol.json')['models']:
        folder = ROOT / 'p4-runs' / model.split(':')[0]
        rows = [read(p) for p in sorted(folder.glob('[ac]*[0-9].json'))] if folder.exists() else []
        status = 'complete' if len(rows) == 13 else 'partial_or_not_run'
        docrows = [r for r in rows if r['kind'] == 'documentary']
        responses = {}
        for row in docrows:
            parsed = parse(row)
            valid = isinstance(parsed, dict) and set(parsed) == {'decision'} and parsed['decision'] in ('match', 'mismatch', 'abstain')
            responses[row['case_id']] = {'decision':parsed['decision'] if valid else 'error'}
        avrows = []
        for row in rows:
            if row['kind'] != 'av':
                continue
            cid = row['case_id']
            assessment = av.assess(parse(row), truth[cid], avcases[cid])
            # A frame citation cannot resolve in this text-only condition.
            if isinstance(parse(row), dict) and isinstance(parse(row).get('evidence'), list) and 'frame' in parse(row)['evidence']:
                assessment['error'] = True
                assessment['references_resolve'] = False
            avrows.append(dict(case_id=cid, assessment=assessment, proposal=parse(row)))
        valid_runtime = [r for r in rows if r.get('response') and r['receipt'].get('http_status') == 200 and not r['response'].get('error')]
        def cpu(row, endpoint):
            return next(int(x.split()[1]) for x in row[endpoint]['snapshot']['stdout'].splitlines() if x.startswith('usage_usec '))
        output.append(dict(model=model, status=status, planned=13, attempted=len(rows), completed_runtime=len(valid_runtime),
                           documentary=bench.score([c for c in cases if c['id'] in responses], responses) if valid_runtime and docrows else None,
                           av=avrows, semantic_interpretation='Partial/runtime failures are not model semantic zero; all attempts retained.',
                           wall_seconds=[r['receipt']['wall_seconds'] for r in rows],
                           prompt_tokens=sum((r.get('response') or {}).get('prompt_eval_count', 0) for r in rows),
                           generated_tokens=sum((r.get('response') or {}).get('eval_count', 0) for r in rows),
                           cpu_cgroup_seconds=sum(cpu(r, 'after')-cpu(r, 'before') for r in rows)/1e6,
                           max_sampled_gpu_mib=max((r['observed']['gpu_used_mib'] for r in rows), default=None),
                           max_sampled_cgroup_bytes=max((r['observed']['cgroup_current'] for r in rows), default=None),
                           resource_caveat='Endpoint samples, not peaks; CPU counters include probes. Partial48-layeroffload and first-load cache differ.'))
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
