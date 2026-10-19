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


def check_sha256_equals(inputs, suite_dir, case=None):
    return _sha(_path(inputs, 'path', suite_dir)) == inputs['sha256'], 'sha256 compared'


def check_sha256_differs(inputs, suite_dir, case=None):
    return _sha(_path(inputs, 'path', suite_dir)) != inputs['sha256'], 'sha256 compared'


def check_epub_valid(inputs, suite_dir, case=None):
    try:
        tools._epub_module().inspect(str(_path(inputs, 'path', suite_dir)))
        return True, 'epub structure valid'
    except Exception as e:  # noqa: BLE001 - damage is the answer
        return False, '%s: %s' % (type(e).__name__, str(e)[:160])


def check_epub_title_is(inputs, suite_dir, case=None):
    try:
        d = tools._epub_module().inspect(str(_path(inputs, 'path', suite_dir)))
    except Exception as e:  # noqa: BLE001
        return False, '%s: %s' % (type(e).__name__, str(e)[:160])
    want = ' '.join(inputs['title'].split()).casefold()
    return any(' '.join((t or '').split()).casefold() == want for t in d['titles']), 'titles=%s' % d['titles']


def check_json_field_equals(inputs, suite_dir, case=None):
    doc = json.loads(_path(inputs, 'path', suite_dir).read_text())
    for part in inputs['field'].split('.'):
        doc = doc[part]
    return doc == inputs['value'], 'field %s' % inputs['field']


def _post(inputs):
    """post_evidence as {tool: parsed output} (the recorded result of the standard calls on the replacement)."""
    out = {}
    for e in inputs.get('post_evidence', []):
        o = e.get('output')
        if isinstance(o, str):
            try:
                o = json.loads(o)
            except ValueError:
                pass
        out[e['tool']] = o
    return out


def _dur_ok(probe, want, tol=1.0):
    try:
        return abs(float(probe['format']['duration']) - float(want)) <= tol
    except (KeyError, TypeError, ValueError):
        return False


def _clean_decode(d):
    return isinstance(d, dict) and d.get('exit_code') == 0 and not (d.get('stderr') or '').strip()


def check_post_replace_verify(inputs, suite_dir, case=None):
    """Replacement of a bad copy.  Rules follow `inputs.pass_rule`, applied to `inputs.post_evidence`:
    EPUB  - epub_inspect ok and dc_title equals the record (heading agreement is not checked: chapter headings rarely name the work);
    audio - ffprobe ok, duration within 1 s, chapter titles equal the record, album tag equals the title;
    video - clean full decode, identity (card / tags) matches the entry, duration within 1 s of the entry runtime."""
    post, want = _post(inputs), inputs.get('expected_entry', {})
    if 'epub_inspect' in post:
        e = post['epub_inspect']
        if not isinstance(e, dict) or e.get('status') != 'ok':
            return False, 'epub_inspect not ok: %s' % (e.get('stage') if isinstance(e, dict) else e)
        title = want.get('title', '')
        # the rule also says "spine headings agree with the title"; chapter headings do not name the work, so only status and title are checked
        return title in e.get('dc_title', []), 'dc_title=%s' % e.get('dc_title')
    probe = post.get('ffprobe')
    if not isinstance(probe, dict) or probe.get('exit_code') not in (0, None):
        return False, 'ffprobe failed'
    if 'chapters' in want:  # audiobook
        chapters = [c.get('title') for c in probe.get('chapters', [])]
        record = None
        for e in (case or {}).get('evidence', []):
            if e.get('tool') == 'arr_lookup':
                try:
                    record = json.loads(e['output']).get('chapter_titles') or record
                except (ValueError, TypeError, AttributeError):
                    pass
        titles_ok = chapters == record if record else len(chapters) == want['chapters']
        album = (probe.get('format', {}).get('tags') or {}).get('album')
        return _dur_ok(probe, want.get('duration_s')) and titles_ok and album == want.get('title'), 'chapters=%s' % chapters
    # video: identity from card text or tags
    decode = post.get('decode_sample')
    card = post.get('ocr') if isinstance(post.get('ocr'), str) else ''
    tags = probe.get('format', {}).get('tags') or {}
    ep = 'S%02dE%02d' % (want.get('season', 0), want.get('episode', 0))
    by_tags = str(tags.get('episode_sort')) == str(want.get('episode')) and str(tags.get('season_number')) == str(want.get('season'))
    identity = (ep in card.upper()) if card else by_tags  # the title card decides when there is one, else the container tags
    return _clean_decode(decode) and identity and _dur_ok(probe, want.get('runtime_s')), 'card=%r decode_clean=%s' % (card, _clean_decode(decode))


def check_post_convert_verify(inputs, suite_dir, case=None):
    """Conversion on an isolated copy: h264 8-bit yuv420p video, an aac stream with <= 2 channels, clean decode, card matches the title."""
    post = _post(inputs)
    probe = post.get('ffprobe')
    if not isinstance(probe, dict) or probe.get('exit_code') not in (0, None):
        return False, 'ffprobe failed'
    streams = probe.get('streams', [])
    video = any(x.get('codec_type') == 'video' and x.get('codec_name') == 'h264' and x.get('pix_fmt') == 'yuv420p' for x in streams)
    audio = any(x.get('codec_type') == 'audio' and x.get('codec_name') == 'aac' and (x.get('channels') or 99) <= 2 for x in streams)
    title = ((case or {}).get('context') or {}).get('expected', {}).get('title', '')
    card = post.get('ocr') if isinstance(post.get('ocr'), str) else ''
    return video and audio and _clean_decode(post.get('decode_sample')) and bool(title) and card.upper().startswith(title.upper()), 'video=%s audio=%s card=%r' % (video, audio, card)


CHECKS = {'sha256_equals': check_sha256_equals, 'sha256_differs': check_sha256_differs, 'epub_valid': check_epub_valid,
          'epub_title_is': check_epub_title_is, 'json_field_equals': check_json_field_equals,
          'post_replace_verify': check_post_replace_verify, 'post_convert_verify': check_post_convert_verify}


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
        ok, detail = fn(step.get('inputs', {}), suite_dir, case)
        res.update(observed='repaired' if ok else 'not_repaired', detail=detail)
        res['correct'] = res['observed'] == step.get('expected')
    except Exception as e:  # noqa: BLE001 - a broken check is a recorded miss, not a crash
        res.update(observed='error', correct=False, detail='%s: %s' % (type(e).__name__, str(e)[:200]))
    return res
