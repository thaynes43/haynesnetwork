"""Load the evaluator-owned `score.py` by explicit path.

The scorer is an assessment artifact: it stays where the evaluator keeps it (`.agents/context/media-repair-harness-2026-10-19/harness/score.py`,
next to CONTRACT.md and `runs/`) and is never copied or edited here.  It was written against the flat layout of that folder
(`import protocol`, `import run`), so this loader maps those two names to this package's modules for the duration of the import.

    mrh-score runs/<run-id> --suite <suite dir>      # same arguments as score.py
    MRH_SCORE_PY=/path/to/score.py mrh-score ...      # when the checkout layout is not the default

A source checkout finds it repo-relative; an installed copy outside a checkout needs MRH_SCORE_PY.
"""
import importlib.util
import os
import sys
from pathlib import Path

from . import protocol, run

DEFAULT_RELATIVE = Path('.agents/context/media-repair-harness-2026-10-19/harness/score.py')


def score_path():
    if os.environ.get('MRH_SCORE_PY'):
        return Path(os.environ['MRH_SCORE_PY'])
    here = Path(__file__).resolve()
    for root in here.parents:
        if (root / DEFAULT_RELATIVE).is_file():
            return root / DEFAULT_RELATIVE
    raise FileNotFoundError('score.py not found from %s; set MRH_SCORE_PY' % here)


def load_score(path=None):
    path = Path(path) if path else score_path()
    aliases = {'protocol': protocol, 'run': run}
    saved = {k: sys.modules.get(k) for k in aliases}
    sys.modules.update(aliases)
    try:
        spec = importlib.util.spec_from_file_location('mrh_evaluator_score', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
        # score.py also put its own folder first on sys.path; drop that entry so it cannot shadow anything later
        try:
            sys.path.remove(str(path.resolve().parent))
        except ValueError:
            pass
    return mod


def main(argv=None):
    return load_score().main(argv)


if __name__ == '__main__':
    sys.exit(main())
