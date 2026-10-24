"""Allowlisted exact-style title-cue plan. Planning only; this module starts nothing."""

RECIPE_VERSION = 'identity-recipe-1'
PINNED_INPUT = '/proc/self/fd/{fd}'


class RecipeError(ValueError):
    pass


def _integer(value, name):
    if type(value) is not int:
        raise RecipeError('%s must be an integer' % name)
    return value


def plan_exact_title_cue(stream_index, style):
    """One child argv for a later explicit collection. The placeholder fd is not opened."""
    index = _integer(stream_index, 'stream_index')
    if index < 0:
        raise RecipeError('stream_index must be >= 0')
    if type(style) is not str or style == '':
        raise RecipeError('style must be a nonempty exact style name')
    argv = [
        'nice', '-n', '19', 'ffmpeg',
        '-nostdin', '-v', 'error', '-threads', '1',
        '-i', PINNED_INPUT,
        '-map', '0:%d' % index,
        '-c:s', 'copy',
        '-flush_packets', '1',
        '-ignore_readorder', '1',
        '-f', 'ass',
        'pipe:1',
    ]
    return {
        'recipe': RECIPE_VERSION,
        'operation': 'exact-style-title-cue',
        'executed': False,
        'argv': argv,
        'streamIndex': index,
        'style': style,
        'styleMatch': 'exact',
        'hostname': None,
        'hostnameReason': 'not hardcoded; a later collection rechecks the current target',
        'sourceBytes': None,
        'oneChild': True,
        'stop': 'process-group SIGTERM after the first nonempty exact-style cue',
        'absentStyle': 'unavailable, not wrong content',
        'input': PINNED_INPUT,
    }


def classify_collection_exit(exit_code, deliberate_stop, stderr):
    """Keep a deliberate post-cue stop distinct from a clean EOF and from an unexpected exit."""
    if type(exit_code) is not int or type(deliberate_stop) is not bool or type(stderr) is not str:
        return {
            'outcome': 'unknown',
            'cleanEof': False,
            'toolFailed': True,
            'note': 'Exit code, deliberate-stop flag, or stderr was missing or not the recorded type.',
        }
    broken = 'Broken pipe' in stderr
    if deliberate_stop and exit_code == 255 and broken:
        return {
            'outcome': 'deliberate-post-cue-stop',
            'cleanEof': False,
            'toolFailed': False,
            'note': 'Exit 255 and Broken pipe are the recorded consequence of stopping after the cue, not a clean EOF.',
        }
    if deliberate_stop:
        return {
            'outcome': 'deliberate-stop-unexpected-status',
            'cleanEof': False,
            'toolFailed': True,
            'note': 'A deliberate stop was claimed, but the exit or stderr does not match the recorded Broken pipe consequence.',
        }
    if exit_code == 0:
        return {
            'outcome': 'clean-exit',
            'cleanEof': True,
            'toolFailed': False,
            'note': 'The process exited 0 without a deliberate post-cue stop.',
        }
    return {
        'outcome': 'unexpected-exit',
        'cleanEof': False,
        'toolFailed': True,
        'note': 'Nonzero exit without a deliberate post-cue stop.',
    }
