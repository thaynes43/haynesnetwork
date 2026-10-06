// Issue #735 — the one-off Orphan LazyLibrarian Want repair: its argument contract (the repair itself is tested in
// @hnet/domain's ll-release.test.ts).
import { describe, expect, it } from 'vitest';
import { F10_HAND_REWANTS, parseLlOrphanUnqueueArgs } from '../src/scripts/ll-orphan-unqueue';

describe('ll-orphan-unqueue arguments', () => {
  it('requires exactly one of --dry-run / --apply, and keeps the F10 hand re-wants by default', () => {
    expect(parseLlOrphanUnqueueArgs(['--dry-run'])).toEqual({ apply: false, keep: [...F10_HAND_REWANTS] });
    expect(parseLlOrphanUnqueueArgs(['--apply'])).toEqual({ apply: true, keep: [...F10_HAND_REWANTS] });
    expect(() => parseLlOrphanUnqueueArgs([])).toThrow(/required/);
    expect(() => parseLlOrphanUnqueueArgs(['--dry-run', '--apply'])).toThrow(/exclusive/);
    expect(() => parseLlOrphanUnqueueArgs(['--force'])).toThrow(/unknown argument/);
    expect(parseLlOrphanUnqueueArgs(['--help'])).toBe('help');
  });

  it('adds --keep entries to the default keep list; only --no-default-keep drops the defaults', () => {
    // Protecting one more book never drops the F10 hand re-wants (PR #751 review).
    expect(parseLlOrphanUnqueueArgs(['--apply', '--keep=a:ebook,b:audiobook'])).toEqual({
      apply: true,
      keep: [...F10_HAND_REWANTS, 'a:ebook', 'b:audiobook'],
    });
    expect(parseLlOrphanUnqueueArgs(['--dry-run', '--keep='])).toEqual({ apply: false, keep: [...F10_HAND_REWANTS] });
    expect(parseLlOrphanUnqueueArgs(['--apply', '--no-default-keep', '--keep=a:ebook'])).toEqual({
      apply: true,
      keep: ['a:ebook'],
    });
    expect(parseLlOrphanUnqueueArgs(['--apply', '--no-default-keep'])).toEqual({ apply: true, keep: [] });
    expect(() => parseLlOrphanUnqueueArgs(['--apply', '--keep=a'])).toThrow(/not <id>:<ebook\|audiobook>/);
  });

  it('keeps the English records the 2026-10-05 F10 sweep re-wanted by hand, and nothing else', () => {
    expect(F10_HAND_REWANTS).toContain('-2R-EAAAQBAJ:ebook'); // Solitaire
    expect(F10_HAND_REWANTS).toContain('mPGNzQEACAAJ:ebook'); // Israel Potter
    expect(F10_HAND_REWANTS).toContain('FOqzEAAAQBAJ:audiobook'); // Murtagh
    expect(F10_HAND_REWANTS.every((k) => /^[^:\s]+:(ebook|audiobook)$/.test(k))).toBe(true);
    expect(new Set(F10_HAND_REWANTS).size).toBe(F10_HAND_REWANTS.length);
  });
});
