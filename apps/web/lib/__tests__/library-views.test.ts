// PLAN-029 (ADR-052 / DESIGN-026 D-06) — the client-side view-resolution MIRROR must agree with
// the @hnet/domain resolver EXACTLY (lib/library-views.ts never imports @hnet/domain in app code —
// the lib/media.ts mirror rule — so this node-context test is the parity contract). Plus the D-09
// jump-bar visibility rule and the defensive URL parsers.
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_WALL_DEFAULTS,
  resolveLibraryView,
  type LibraryViewUrlOverride,
  type LibraryView,
} from '@hnet/domain';
import { LIBRARY_WALLS } from '@hnet/db';
import {
  JUMP_BAR_MIN_ITEMS,
  LIBRARY_WALL_IDS,
  WALL_VIEW_DEFAULTS,
  parseWallSortToken,
  parseWallViewParam,
  resolveWallView,
  showJumpBar,
  type LibraryWallId,
} from '../library-views';

describe('library-views mirror parity (ADR-052 handoff contract)', () => {
  it('mirrors the wall list and the R2/R6 defaults verbatim', () => {
    expect([...LIBRARY_WALL_IDS]).toEqual([...LIBRARY_WALLS]);
    for (const wall of LIBRARY_WALLS) {
      expect(WALL_VIEW_DEFAULTS[wall]).toEqual(LIBRARY_WALL_DEFAULTS[wall]);
    }
  });

  it('resolves exactly like @hnet/domain resolveLibraryView across the precedence matrix', () => {
    const stored: LibraryView = { view: 'flat', groupBy: null, sortField: 'title', sortDir: 'asc' };
    const storedGrouped: LibraryView = {
      view: 'grouped',
      groupBy: 'author',
      sortField: 'author',
      sortDir: 'desc',
    };
    const urls: Array<LibraryViewUrlOverride> = [
      {},
      { view: 'flat' },
      { sortField: 'added_at', sortDir: 'desc' },
      { groupBy: null }, // an explicit URL null is a real value
      { groupBy: 'series' },
      { view: 'grouped', groupBy: 'author', sortField: 'author', sortDir: 'asc' },
    ];
    const storeds: Array<LibraryView | null> = [null, stored, storedGrouped];
    for (const wall of LIBRARY_WALLS) {
      for (const url of urls) {
        for (const s of storeds) {
          expect(resolveWallView({ wall, url, stored: s })).toEqual(
            resolveLibraryView({ wall, url, stored: s }),
          );
        }
      }
    }
  });

  it('never coalesces a stored groupBy:null into the wall default (the handoff footgun)', () => {
    const wall: LibraryWallId = 'books'; // default groupBy 'author'
    const storedFlat: LibraryView = { view: 'flat', groupBy: null, sortField: 'title', sortDir: 'asc' };
    expect(resolveWallView({ wall, stored: storedFlat }).groupBy).toBeNull();
  });

  it('flags any URL-carried dimension as fromUrl (shared-link state — never persisted)', () => {
    expect(resolveWallView({ wall: 'movies', url: {} }).fromUrl).toBe(false);
    expect(resolveWallView({ wall: 'movies', url: { sortDir: 'asc' } }).fromUrl).toBe(true);
    expect(resolveWallView({ wall: 'books', url: { view: 'flat' } }).fromUrl).toBe(true);
  });
});

describe('URL parsers (defensive — a mangled shared link falls back, never errors)', () => {
  it('parseWallSortToken accepts only registry-valid field:dir tokens', () => {
    expect(parseWallSortToken('title:asc', ['title', 'added_at'])).toEqual({
      field: 'title',
      dir: 'asc',
    });
    expect(parseWallSortToken('added_at:desc', ['title', 'added_at'])).toEqual({
      field: 'added_at',
      dir: 'desc',
    });
    expect(parseWallSortToken('runtime:desc', ['title'])).toBeNull(); // not offered at this level
    expect(parseWallSortToken('title:sideways', ['title'])).toBeNull();
    expect(parseWallSortToken(null, ['title'])).toBeNull();
  });

  it('parseWallViewParam accepts only shapes the wall offers', () => {
    expect(parseWallViewParam('flat', ['grouped', 'flat'])).toBe('flat');
    expect(parseWallViewParam('grouped', ['flat'])).toBeUndefined();
    expect(parseWallViewParam('bogus', ['grouped', 'flat'])).toBeUndefined();
    expect(parseWallViewParam(null, ['grouped', 'flat'])).toBeUndefined();
  });
});

describe('A–Z jump-bar visibility (DESIGN-026 D-09)', () => {
  it('shows only on A–Z sorts', () => {
    expect(
      showJumpBar({ isAzSort: false, activeLetter: 'm', itemCount: 500, hasNextPage: true }),
    ).toBe(false);
  });
  it('shows on big walls (full first page / more pages)', () => {
    expect(showJumpBar({ isAzSort: true, activeLetter: null, itemCount: 50, hasNextPage: true })).toBe(
      true,
    );
    expect(
      showJumpBar({
        isAzSort: true,
        activeLetter: null,
        itemCount: JUMP_BAR_MIN_ITEMS,
        hasNextPage: false,
      }),
    ).toBe(true);
    expect(showJumpBar({ isAzSort: true, activeLetter: null, itemCount: 2, hasNextPage: false })).toBe(
      false,
    );
  });
  it('stays visible while a jump is armed (the rail never vanishes mid-use)', () => {
    expect(showJumpBar({ isAzSort: true, activeLetter: 'z', itemCount: 1, hasNextPage: false })).toBe(
      true,
    );
  });
});
