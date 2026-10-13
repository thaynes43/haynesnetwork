// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — staff's seerr-bridge.ts arguments: --show, --set (a value left out
// keeps what is stored; never user 1), --run for every issue or one. The bridge itself: seerr-issue-writes.test.ts.
import { describe, expect, it } from 'vitest';
import { parseSeerrBridgeArgs } from '../src/scripts/seerr-bridge';

describe('seerr-bridge arguments', () => {
  it('parses the three commands', () => {
    expect(parseSeerrBridgeArgs(['--show'])).toEqual({ kind: 'show' });
    expect(parseSeerrBridgeArgs(['--run'])).toEqual({ kind: 'run', issueId: null });
    expect(parseSeerrBridgeArgs(['--run', '--issue', '12'])).toEqual({ kind: 'run', issueId: 12 });
    expect(parseSeerrBridgeArgs(['--set', '--user', '19', '--comment', 'on', '--resolve', 'off'])).toEqual({
      kind: 'set',
      user: 19,
      comment: true,
      resolve: false,
    });
    expect(parseSeerrBridgeArgs(['--set', '--comment', 'off'])).toEqual({ kind: 'set', comment: false });
    expect(parseSeerrBridgeArgs(['--set', '--user', 'none'])).toEqual({ kind: 'set', user: null });
    expect(parseSeerrBridgeArgs([])).toBe('help');
    expect(parseSeerrBridgeArgs(['--show', '--help'])).toBe('help');
  });

  it('refuses the owner, bad values and unknown options', () => {
    expect(() => parseSeerrBridgeArgs(['--set', '--user', '1'])).toThrow(/owner/);
    expect(() => parseSeerrBridgeArgs(['--set'])).toThrow(/at least one/);
    expect(() => parseSeerrBridgeArgs(['--set', '--comment', 'yes'])).toThrow(/on or off/);
    expect(() => parseSeerrBridgeArgs(['--set', '--user', 'x'])).toThrow(/positive id/);
    expect(() => parseSeerrBridgeArgs(['--run', '--issue'])).toThrow(/only --issue/);
    expect(() => parseSeerrBridgeArgs(['--run', '--issue', '0'])).toThrow(/positive id/);
    expect(() => parseSeerrBridgeArgs(['--run', '--all'])).toThrow(/only --issue/);
    expect(() => parseSeerrBridgeArgs(['--show', 'x'])).toThrow(/no options/);
    expect(() => parseSeerrBridgeArgs(['--delete'])).toThrow(/unknown command/);
  });
});
