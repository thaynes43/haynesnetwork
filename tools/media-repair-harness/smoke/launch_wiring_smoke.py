"""Run wiring_smoke.py once as a CPU-limited batch Job in namespace dev, store its output, delete the Job.

    python3 launch_wiring_smoke.py --out <dir> [--image ghcr.io/home-operations/bazarr:1.6.2] [--cpu 1]

Same Job shape and limits as evidence/launch_smoke.py (cpu <= 2, memory 1Gi, no service account token, restricted pod security, 10 minute
deadline); the harness modules it needs travel in the Job spec as a base64 tarball (kept under the 128 KiB single-argument limit).
"""
import argparse
import base64
import io
import json
import subprocess
import sys
import tarfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import launch_smoke as L  # noqa: E402

BEGIN, END = '===MRH-WIRING-SMOKE-BEGIN===', '===MRH-WIRING-SMOKE-END==='
PACKAGE = HERE.parent / 'src' / 'media_repair_harness'
FILES = ['__init__.py', 'adapters.py', 'audit.py', 'decision_guard.py', 'gaps.py', 'guard.py', 'leakguard.py', 'outcomes.py', 'protocol.py', 'remote_sampler.py', 'ollama_transport.py', 'run.py',
         'tools.py', 'vendored_epub.py', 'evidence_v2.py', 'prompts/v2.txt', 'evidence/__init__.py', 'evidence/core.py', 'evidence/avtools.py', 'evidence/epubtool.py']
SMOKE_FILES = ['live_smoke.py', 'wiring_smoke.py']


# Linux refuses a single environment string above MAX_ARG_STRLEN (131072 bytes); keep a margin for the variable name and the rest of the environment.
MAX_ARG_STRLEN = 131072
ENV_LIMIT = MAX_ARG_STRLEN - 4096
TOTAL_LIMIT = 240000   # kubectl apply stores the manifest in an annotation (262144 bytes max); the rest of the spec needs a margin


_COOKIE_RX = None


def _is_cookie_or_shebang(row, line):
    """A PEP 263 encoding cookie (a comment on line 1 or 2 naming a coding) or a line-1 shebang: comments with meaning, always kept."""
    import re
    global _COOKIE_RX
    _COOKIE_RX = _COOKIE_RX or re.compile(r'^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+')
    return (row == 1 and line.startswith('#!')) or (row <= 2 and bool(_COOKIE_RX.match(line)))


def strip_comments(source):
    """The source with every `#` comment removed except an encoding cookie or a shebang.  The physical lines are the tokenizer's own
    (io.StringIO(...).readlines(), never str.splitlines(), which also splits at U+2028 and other separators the tokenizer does not), so a token's row always
    addresses the line it is on; strings, docstrings and code are untouched and every line is kept (line numbers in a traceback stay right).  #161: the
    package outgrew the 240000-byte ceiling of the apply annotation once dev-c8 and the remote evidence code joined it."""
    import tokenize
    lines = io.StringIO(source).readlines()
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type != tokenize.COMMENT:
            continue
        row, col = tok.start
        line = lines[row - 1]
        if _is_cookie_or_shebang(row, line):
            continue
        body = line.rstrip('\r\n')
        lines[row - 1] = line[:col].rstrip() + line[len(body):]
    return ''.join(lines)


def _strings(source):
    import tokenize
    return [t.string for t in tokenize.generate_tokens(io.StringIO(source).readline) if t.type == tokenize.STRING]


def check_stripped(name, source, stripped):
    """The bundler's self-check: the stripped module parses to the identical AST, has the identical string tokens and the same encoding declaration and line
    count.  Any difference aborts the bundle build (RuntimeError) instead of shipping changed code."""
    import ast
    import tokenize
    problems = []
    if ast.dump(ast.parse(source)) != ast.dump(ast.parse(stripped)):
        problems.append('the AST differs')
    if _strings(source) != _strings(stripped):
        problems.append('a string token differs')
    if tokenize.detect_encoding(io.BytesIO(source.encode('utf-8')).readline)[0] != tokenize.detect_encoding(io.BytesIO(stripped.encode('utf-8')).readline)[0]:
        problems.append('the encoding declaration differs')
    if len(io.StringIO(source).readlines()) != len(io.StringIO(stripped).readlines()):
        problems.append('the line count differs')
    if problems:
        raise RuntimeError('comment stripping changed %s (%s): the bundle is not built' % (name, '; '.join(problems)))


def bundle():
    """The whole tarball as one base64 string (gzip: always present in the Job image, unlike lzma); `bundle_parts` splits it for the Job spec.  Python files
    travel without their comments (strip_comments)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        norm = lambda ti: (setattr(ti, 'uid', 0), setattr(ti, 'gid', 0), setattr(ti, 'mtime', 0), ti)[3]
        for name in FILES:
            if name.endswith('.py'):
                source = (PACKAGE / name).read_text(encoding='utf-8')
                stripped = strip_comments(source)
                check_stripped(name, source, stripped)
                data = stripped.encode('utf-8')
                ti = norm(tarfile.TarInfo('media_repair_harness/' + name))
                ti.size, ti.mode = len(data), 0o644
                t.addfile(ti, io.BytesIO(data))
                continue
            t.add(PACKAGE / name, arcname='media_repair_harness/' + name, filter=norm)
        for name in SMOKE_FILES:
            t.add(HERE / name, arcname='smoke/' + name, filter=norm)
    return base64.b64encode(buf.getvalue()).decode()


def bundle_parts(data=None):
    """The bundle as environment strings MRH_BUNDLE0, MRH_BUNDLE1, ... each under the single-string limit (the package outgrew one string with evidence_v2); the total is capped at TOTAL_LIMIT."""
    data = bundle() if data is None else data
    parts = [data[i:i + ENV_LIMIT - 64] for i in range(0, len(data), ENV_LIMIT - 64)]
    # client-side `kubectl apply` keeps the whole manifest in one annotation, limited to 262144 bytes: the bundle stays well under that
    assert len(data) <= TOTAL_LIMIT, 'bundle is %d bytes, over the %d byte ceiling (the apply annotation limit is 262144); trim FILES' % (len(data), TOTAL_LIMIT)
    assert len(parts) <= 4, 'bundle needs %d environment strings; trim FILES' % len(parts)
    return parts


BOOT = ("import base64,io,os,tarfile;"
        "d=''.join(os.environ['MRH_BUNDLE%d'%i] for i in range(4) if 'MRH_BUNDLE%d'%i in os.environ);"
        "tarfile.open(fileobj=io.BytesIO(base64.b64decode(d)),mode='r:*').extractall('/work');"
        "os.execvp('python3',['python3','/work/smoke/wiring_smoke.py'])")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--image', default='ghcr.io/home-operations/bazarr:1.6.2')
    ap.add_argument('--cpu', type=float, default=1)
    a = ap.parse_args()
    if a.cpu > 2:
        raise SystemExit('cpu limit above 2 refused')
    name = 'mrh-wiring-smoke-%d' % int(time.time())
    m = L.manifest(name, a.image, a.cpu)
    c = m['spec']['template']['spec']['containers'][0]
    c['command'] = ['python3', '-c', BOOT]
    c['env'] = [{'name': 'MRH_BUNDLE%d' % i, 'value': part} for i, part in enumerate(bundle_parts())] + [{'name': 'TMPDIR', 'value': '/work'}]
    m['metadata']['labels']['app'] = m['spec']['template']['metadata']['labels']['app'] = 'mrh-wiring-smoke'
    L.kubectl('apply', '-f', '-', input=json.dumps(m))
    print('applied', name, file=sys.stderr)
    try:
        deadline = time.time() + 660
        status = None
        while time.time() < deadline:
            r = L.kubectl('get', 'job', name, '-o', 'jsonpath={.status.succeeded}/{.status.failed}', check=False)
            if r.stdout.startswith('1/') or r.stdout.endswith('/1'):
                status = r.stdout
                break
            time.sleep(5)
        print('job status (succeeded/failed):', status, file=sys.stderr)
        logs = L.kubectl('logs', 'job/' + name, '--tail=-1', check=False).stdout
        pod = L.kubectl('get', 'pods', '-l', 'job-name=' + name, '-o', 'jsonpath={.items[0].metadata.name}', check=False).stdout
        image_id = L.kubectl('get', 'pod', pod, '-o', 'jsonpath={.status.containerStatuses[0].imageID}', check=False).stdout if pod else ''
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        if BEGIN not in logs or END not in logs:
            (out / 'wiring-smoke-failed.log').write_text(logs[-4000:])
            raise SystemExit('no records in the Job log (tail saved to wiring-smoke-failed.log)')
        doc = json.loads(logs.split(BEGIN, 1)[1].split(END, 1)[0])
        doc['job'] = {'name': name, 'image': a.image, 'image_id': image_id, 'cpu_limit': a.cpu, 'memory_limit': '1Gi', 'namespace': L.NS}
        (out / 'wiring-smoke.json').write_text(json.dumps(doc, indent=1, sort_keys=True) + '\n')
        print('wrote', out / 'wiring-smoke.json', file=sys.stderr)
    finally:
        L.kubectl('delete', 'job', name, '--ignore-not-found', '--wait=false', check=False)
        print('deleted', name, file=sys.stderr)


if __name__ == '__main__':
    main()
