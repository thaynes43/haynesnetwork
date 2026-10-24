"""Exact-style ASS title cues. Pure text; no process, socket, or model."""

import re
import unicodedata

TIME_RE = re.compile(r'[0-9]+:[0-5][0-9]:[0-5][0-9]\.[0-9]{2}')
DRAWING_RE = re.compile(r'\\p(\d+)')


class AssError(ValueError):
    """A line claimed to be Dialogue and was not a usable ASS event."""


def _drawing_mode(block):
    """The last \\pN in an override block. None when the block does not change mode."""
    found = DRAWING_RE.findall(block)
    if not found:
        return None
    return int(found[-1]) != 0


def strip_overrides(text):
    """Decode ASS text. Drawing commands are not title text. \\h is a space."""
    if not isinstance(text, str):
        return ''
    drawing = False
    out = []
    index = 0
    while index < len(text):
        if text[index] == '{':
            end = text.find('}', index)
            if end == -1:
                if not drawing:
                    out.append(text[index:])
                break
            mode = _drawing_mode(text[index + 1:end])
            if mode is not None:
                drawing = mode
            index = end + 1
            continue
        if text.startswith('\\N', index) or text.startswith('\\n', index) or text.startswith('\\h', index):
            if not drawing:
                out.append(' ')
            index += 2
            continue
        if not drawing:
            out.append(text[index])
        index += 1
    return ''.join(out).strip()


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
    """Conservative comparison key. The raw text stays beside the recorded steps.

    A key match after any of these steps is ambiguous. It is not proof that the
    titles or the episodes are the same, and it is not an automatic mismatch.
    """
    if not isinstance(text, str):
        return '', []
    steps = []
    current = text.strip()
    if current != text:
        steps.append('strip')
    collapsed = re.sub(r'\s+', ' ', current)
    if collapsed != current:
        steps.append('collapse-whitespace')
    normalized = unicodedata.normalize('NFKC', collapsed)
    if normalized != collapsed:
        steps.append('nfkc')
    folded = []
    punctuation = False
    controls = False
    for char in normalized:
        category = unicodedata.category(char)
        if category.startswith('P') or category.startswith('S'):
            folded.append(' ')
            punctuation = True
        elif category in ('Cf', 'Cc'):
            controls = True
        else:
            folded.append(char)
    if punctuation:
        steps.append('punctuation-and-symbols-to-space')
    if controls:
        steps.append('drop-format-controls')
    joined = ''.join(folded)
    collapsed_again = re.sub(r'\s+', ' ', joined).strip()
    if collapsed_again != joined.strip():
        steps.append('collapse-whitespace-after-punctuation')
    cased = collapsed_again.casefold()
    if cased != collapsed_again:
        steps.append('casefold')
    final = re.sub(r'\s+', ' ', cased).strip()
    if final != cased:
        steps.append('collapse-whitespace-final')
    return final, steps


def title_relation(left, right):
    """same, ambiguous, different, or unknown.

    same means the strings already agree apart from outer whitespace.
    ambiguous means a recorded fold erased the difference. That is not proof of
    the same title or episode, and it is not an automatic mismatch.
    different means the folded alphanumeric keys still differ.
    """
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
    left_alnum, left_dropped = _alphanumeric_key(left_key)
    right_alnum, right_dropped = _alphanumeric_key(right_key)
    if left_dropped:
        left_steps = list(left_steps) + ['drop-non-alphanumeric']
    if right_dropped:
        right_steps = list(right_steps) + ['drop-non-alphanumeric']
    if left_alnum and left_alnum == right_alnum:
        return 'ambiguous', left_steps, right_steps
    return 'different', left_steps, right_steps


def _alphanumeric_key(text):
    """Letters and digits only. A match is ambiguous, not proof of the same title."""
    kept = []
    dropped = False
    for char in text:
        if char.isalnum():
            kept.append(char)
        else:
            dropped = True
    return ''.join(kept), dropped
