"""Exact-style ASS title cues. Pure text; no process, socket, or model."""

import re

TIME_RE = re.compile(r'[0-9]+:[0-5][0-9]:[0-5][0-9]\.[0-9]{2}')
DASHES = set('-‐‑‒–—―−\u00ad')


class AssError(ValueError):
    """A line claimed to be Dialogue and was not a usable ASS event."""


def strip_overrides(text):
    """Remove ASS override blocks and turn hard line breaks into spaces."""
    stripped = re.sub(r'\{[^}]*\}', '', text)
    stripped = stripped.replace('\\N', ' ').replace('\\n', ' ')
    return stripped.strip()


def parse_ass_dialogue(line):
    """Parse one Dialogue line. Non-dialogue returns None. A bad Dialogue line raises."""
    if not isinstance(line, str) or not line.startswith('Dialogue:'):
        return None
    fields = line.split(':', 1)[1].lstrip().split(',', 9)
    if len(fields) != 10:
        raise AssError('malformed ASS dialogue event')
    start, end, style, raw_text = fields[1], fields[2], fields[3], fields[9]
    if TIME_RE.fullmatch(start) is None or TIME_RE.fullmatch(end) is None:
        raise AssError('invalid ASS cue times')
    return {
        'start': start,
        'end': end,
        'style': style,
        'text': strip_overrides(raw_text),
        'raw': line,
    }


def classify_exact_style(event, expected_style):
    """exact, other-style, or empty. Empty and other-style are unavailable, not wrong content."""
    if event is None:
        return 'absent'
    if event['style'] != expected_style:
        return 'other-style'
    if event['text'] == '':
        return 'empty'
    return 'exact'


def comparison_fold(text):
    """Conservative comparison key. The raw text stays beside the recorded steps."""
    steps = []
    current = text.strip()
    if current != text:
        steps.append('strip')
    collapsed = re.sub(r'\s+', ' ', current)
    if collapsed != current:
        steps.append('collapse-whitespace')
    folded = []
    changed = False
    for char in collapsed:
        if char in DASHES or char in ':;':
            folded.append(' ')
            changed = True
        else:
            folded.append(char)
    punctuated = ''.join(folded)
    if changed:
        steps.append('dash-colon-or-semicolon-to-space')
    collapsed_again = re.sub(r'\s+', ' ', punctuated).strip()
    if collapsed_again != punctuated:
        steps.append('collapse-whitespace-after-punctuation')
    cased = collapsed_again.casefold()
    if cased != collapsed_again:
        steps.append('casefold')
    tailless = re.sub(r'[.!?]+$', '', cased).strip()
    if tailless != cased:
        steps.append('strip-trailing-punctuation')
    final = re.sub(r'\s+', ' ', tailless).strip()
    if final != tailless:
        steps.append('collapse-whitespace-final')
    return final, steps


def title_relation(left, right):
    """same, ambiguous, different, or unknown. Ambiguous is not an automatic mismatch."""
    if not isinstance(left, str) or not isinstance(right, str):
        return 'unknown', [], []
    if left.strip() == '' or right.strip() == '':
        return 'unknown', [], []
    left_key, left_steps = comparison_fold(left)
    right_key, right_steps = comparison_fold(right)
    if left_key == '' or right_key == '':
        return 'unknown', left_steps, right_steps
    left_collapsed = re.sub(r'\s+', ' ', left.strip())
    right_collapsed = re.sub(r'\s+', ' ', right.strip())
    if left_collapsed == right_collapsed:
        return 'same', left_steps, right_steps
    if left_key == right_key:
        return 'ambiguous', left_steps, right_steps
    return 'different', left_steps, right_steps
