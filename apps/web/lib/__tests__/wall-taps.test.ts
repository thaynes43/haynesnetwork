import { describe, expect, it } from 'vitest';
import { wallCounts, wallGlyph, type BatchItemStateName } from '../trash-batches';
import {
  beginWallTap,
  confirmWallTap,
  emptyWallTaps,
  failWallTap,
  shownState,
  tapInFlight,
  wallTapBusyLabel,
  wallTapErrorText,
  wallTapFailedLabel,
  wallTapFailedNote,
  type WallTaps,
} from '../wall-taps';

// ADR-096 — the wall shows a save only after the server confirms it. These tests replay the
// 2026-10-03 incident: two tiles tapped 12 s apart on the Leaving Soon wall; the first save
// answered in 5.7 s, the second waited on a busy Maintainerr and came back 502 after 30 s. The
// screenshot taken in between read "Rescued 2" with both tiles green.

const MAINTAINERR_COPY = 'Maintainerr didn’t respond. Nothing changed — try again in a bit.';

interface Tile {
  id: string;
  state: BatchItemStateName;
  sizeBytes: number;
}

/** What PosterWall renders and counts: the shown state per tile, through the same glyph mapping. */
function header(tiles: Tile[], taps: WallTaps<BatchItemStateName>) {
  return wallCounts(
    tiles.map((t) => ({
      state: shownState(taps, t.id, t.state),
      inLivePool: taps.confirmed.has(t.id) ? null : true,
      sizeBytes: t.sizeBytes,
    })),
  );
}

const glyphOf = (tile: Tile, taps: WallTaps<BatchItemStateName>) =>
  wallGlyph(shownState(taps, tile.id, tile.state), null);

describe('wall taps (ADR-096 — confirmed-only)', () => {
  const dalmatians: Tile = { id: 'dalmatians', state: 'pending', sizeBytes: 10 };
  const stella: Tile = { id: 'stella', state: 'pending', sizeBytes: 20 };
  const other: Tile = { id: 'other', state: 'pending', sizeBytes: 30 };
  const tiles = [dalmatians, stella, other];

  it('an in-flight save keeps the slated glyph and is NOT counted as rescued', () => {
    let taps = emptyWallTaps<BatchItemStateName>();
    taps = beginWallTap(taps, stella.id, 'save');
    expect(tapInFlight(taps, stella.id)).toBe(true);
    expect(glyphOf(stella, taps)).toBe('trash');
    expect(header(tiles, taps)).toMatchObject({ slated: 3, rescued: 0, slatedBytes: 60 });
  });

  it('replays the incident: one confirmed save, one 502 — the header reads Rescued 1, never 2', () => {
    let taps = emptyWallTaps<BatchItemStateName>();
    // 00:02:12 tap 101 Dalmatians; 00:02:18 the server answers `saved`.
    taps = beginWallTap(taps, dalmatians.id, 'save');
    expect(header(tiles, taps).rescued).toBe(0);
    taps = confirmWallTap(taps, dalmatians.id, 'saved');
    expect(glyphOf(dalmatians, taps)).toBe('shield');
    expect(header(tiles, taps)).toMatchObject({ slated: 2, rescued: 1 });

    // 00:02:24 tap Stella; for the next 30 s the request is out (the screenshot moment).
    taps = beginWallTap(taps, stella.id, 'save');
    expect(glyphOf(stella, taps)).toBe('trash');
    expect(header(tiles, taps)).toMatchObject({ slated: 2, rescued: 1, slatedBytes: 50 });

    // 00:02:54 the 502 lands: still slated, still counted under Deleting, and the failure shows.
    taps = failWallTap(taps, stella.id, 'How Stella Got Her Groove Back (1998)', MAINTAINERR_COPY);
    expect(tapInFlight(taps, stella.id)).toBe(false);
    expect(glyphOf(stella, taps)).toBe('trash');
    expect(header(tiles, taps)).toMatchObject({ slated: 2, rescued: 1 });
    expect(taps.failed.get(stella.id)).toBe('save');
    expect(taps.error).toBe(
      `How Stella Got Her Groove Back (1998) was not saved. ${MAINTAINERR_COPY}`,
    );
    // The confirmed save is untouched by its neighbour's failure.
    expect(glyphOf(dalmatians, taps)).toBe('shield');
  });

  it('the server answer wins over what was asked (an inert changed:false tap)', () => {
    let taps = emptyWallTaps<BatchItemStateName>();
    taps = beginWallTap(taps, other.id, 'save');
    taps = confirmWallTap(taps, other.id, 'protected');
    expect(glyphOf(other, taps)).toBe('check');
  });

  it('an in-flight un-save keeps the shield; a failed un-save says it is still saved', () => {
    const saved: Tile = { id: 'saved', state: 'saved', sizeBytes: 5 };
    let taps = emptyWallTaps<BatchItemStateName>();
    taps = beginWallTap(taps, saved.id, 'unsave');
    expect(glyphOf(saved, taps)).toBe('shield');
    expect(header([saved], taps)).toMatchObject({ rescued: 1, slated: 0 });
    taps = failWallTap(taps, saved.id, 'Kept Title (2001)', 'Plex didn’t respond.');
    expect(glyphOf(saved, taps)).toBe('shield');
    expect(taps.error).toBe('Kept Title (2001) is still saved. Plex didn’t respond.');
    expect(wallTapFailedNote(taps.failed.get(saved.id)!)).toBe('Still saved');
  });

  it('a second tap while one is out is ignored; the next tap clears the failure mark and the error line', () => {
    let taps = emptyWallTaps<BatchItemStateName>();
    taps = beginWallTap(taps, stella.id, 'save');
    expect(beginWallTap(taps, stella.id, 'unsave')).toBe(taps);
    taps = failWallTap(taps, stella.id, 'Stella', 'nope');
    expect(taps.failed.has(stella.id)).toBe(true);
    taps = beginWallTap(taps, stella.id, 'save');
    expect(taps.failed.has(stella.id)).toBe(false);
    expect(taps.error).toBeNull();
    taps = confirmWallTap(taps, stella.id, 'saved');
    expect(glyphOf(stella, taps)).toBe('shield');
    expect(tapInFlight(taps, stella.id)).toBe(false);
  });

  it('a failure on one tile leaves another tile’s in-flight request alone', () => {
    let taps = emptyWallTaps<BatchItemStateName>();
    taps = beginWallTap(taps, dalmatians.id, 'save');
    taps = beginWallTap(taps, stella.id, 'save');
    taps = failWallTap(taps, stella.id, 'Stella', 'nope');
    expect(tapInFlight(taps, dalmatians.id)).toBe(true);
    expect(header(tiles, taps).rescued).toBe(0);
  });

  it('copy: busy label, failed note and label, error text per action', () => {
    expect(wallTapBusyLabel('save', 'Heist')).toBe('Saving Heist…');
    expect(wallTapBusyLabel('unsave', 'Heist')).toBe('Un-saving Heist…');
    expect(wallTapBusyLabel('unprotect', 'Heist')).toBe('Un-protecting Heist…');
    expect(wallTapFailedNote('save')).toBe('Not saved');
    expect(wallTapFailedNote('unprotect')).toBe('Still protected');
    expect(wallTapFailedLabel('save', 'Heist is slated to delete — tap to save it')).toBe(
      'Not saved, the last try failed. Heist is slated to delete — tap to save it',
    );
    expect(wallTapErrorText('unprotect', 'Heist (2020)', 'Try again.')).toBe(
      'Heist (2020) is still protected. Try again.',
    );
  });
});
