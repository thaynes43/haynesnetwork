"""Outcome-step checks (CONTRACT: `outcome_step: {check, inputs, expected: repaired|not_repaired}`).

The harness never executes a write, so the step does not watch a real repair.  It runs a deterministic,
read-only verification over the post-action state that the case supplies in `inputs` (for example the
replacement file a repair would have produced) and classifies it `repaired` or `not_repaired`.  Gate G6
therefore measures the verification step.  Real read-backs belong to the monitored pilot (checkpoint 4).
Paths in `inputs` come from the case file (trusted, never from the model) and resolve against the suite
directory; a check never writes.
"""
import hashlib
import json
from pathlib import Path

import tools


def _path(inputs, key, suite_dir):
    p = Path(inputs[key])
    return p if p.is_absolute() else Path(suite_dir) / p


def _sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


def check_sha256_equals(inputs, suite_dir):
    return _sha(_path(inputs, 'path', suite_dir)) == inputs['sha256'], 'sha256 compared'


def check_sha256_differs(inputs, suite_dir):
    return _sha(_path(inputs, 'path', suite_dir)) != inputs['sha256'], 'sha256 compared'


def check_epub_valid(inputs, suite_dir):
    try:
        tools._epub_module().inspect(str(_path(inputs, 'path', suite_dir)))
        return True, 'epub structure valid'
    except Exception as e:  # noqa: BLE001 - damage is the answer
        return False, '%s: %s' % (type(e).__name__, str(e)[:160])


def check_epub_title_is(inputs, suite_dir):
    try:
        d = tools._epub_module().inspect(str(_path(inputs, 'path', suite_dir)))
    except Exception as e:  # noqa: BLE001
        return False, '%s: %s' % (type(e).__name__, str(e)[:160])
    want = ' '.join(inputs['title'].split()).casefold()
    return any(' '.join((t or '').split()).casefold() == want for t in d['titles']), 'titles=%s' % d['titles']


def check_json_field_equals(inputs, suite_dir):
    doc = json.loads(_path(inputs, 'path', suite_dir).read_text())
    for part in inputs['field'].split('.'):
        doc = doc[part]
    return doc == inputs['value'], 'field %s' % inputs['field']


CHECKS = {'sha256_equals': check_sha256_equals, 'sha256_differs': check_sha256_differs, 'epub_valid': check_epub_valid,
          'epub_title_is': check_epub_title_is, 'json_field_equals': check_json_field_equals}


def run_outcome_step(case, suite_dir):
    step = case.get('outcome_step')
    if not step:
        return None
    res = {'check': step.get('check'), 'expected': step.get('expected')}
    fn = CHECKS.get(step.get('check'))
    if fn is None:
        res.update(observed='error', correct=False, detail='unknown check %r' % step.get('check'))
        return res
    try:
        ok, detail = fn(step.get('inputs', {}), suite_dir)
        res.update(observed='repaired' if ok else 'not_repaired', detail=detail)
        res['correct'] = res['observed'] == step.get('expected')
    except Exception as e:  # noqa: BLE001 - a broken check is a recorded miss, not a crash
        res.update(observed='error', correct=False, detail='%s: %s' % (type(e).__name__, str(e)[:200]))
    return res
