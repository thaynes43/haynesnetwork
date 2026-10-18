"""Verify only the authorized installed package's exact manifest/config/layer bytes."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'media-repair-benchmark-2026-10-18'))
import ollama_matrix as runtime


def main():
    assert json.loads((ROOT / 'pull-exit.json').read_text())['exit_code'] == 0
    proof = json.loads((ROOT / 'registry-proof.json').read_text())
    expected = [proof['manifest']['config']] + proof['manifest']['layers']
    paths = []
    for layer in expected:
        algorithm, digest = layer['digest'].split(':')
        assert algorithm == 'sha256' and len(digest) == 64 and all(c in '0123456789abcdef' for c in digest)
        paths.append('/models/blobs/sha256-' + digest)
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    run = subprocess.run(runtime.PREFIX + ['timeout','240','nice','-n','19','sha256sum'] + paths,
                         capture_output=True, text=True, timeout=245)
    result = {'started':started,'finished':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'exit_code':run.returncode,'stdout':run.stdout,'stderr':run.stderr}
    assert run.returncode == 0, result
    hashes = {line.split()[1]:line.split()[0] for line in run.stdout.splitlines()}
    assert all(hashes.get(path) == layer['digest'].split(':')[1] for path,layer in zip(paths,expected))
    tags, _ = runtime.api('/api/tags')
    installed = next(m for m in tags['models'] if m['name'] == 'nemotron-3.5-bolt:74b-a9b')
    assert installed['digest'] == proof['manifest_sha256']
    manifest_dir = ROOT / 'installed-nemotron'
    manifest_dir.mkdir(exist_ok=False)
    result['manifest'] = runtime.verify_manifest(installed, manifest_dir)
    result['verified_all_layers_and_config'] = True
    result['installed'] = installed
    (ROOT / 'checksums.json').write_text(json.dumps(result, indent=2)+'\n')
    print('Exact installed manifest, config and all layers verified; no inference yet', flush=True)


if __name__ == '__main__':
    main()
