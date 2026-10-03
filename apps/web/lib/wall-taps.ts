// ADR-096 / DESIGN-011 D-07 amendment 2026-10-03 — the trash walls show a save only after the
// server confirms it.
//
// Owner report (2026-10-03, 00:02 EDT): a phone screenshot of the Leaving Soon wall showed two
// green "saved" tiles and "Rescued 2", but only one save existed. The second tap's request waited
// on Maintainerr (busy with its scheduled rule run), timed out after 30 s and came back 502. The
// wall had flipped the tile to the green shield the moment it was tapped and counted it as
// rescued, so for those 30 s it claimed a save the server never made, with nothing on the tile
// to say a request was still out.
//
// This module is the per-tile tap bookkeeping both walls share (the batch wall's PosterWall and
// the pending walls' usePendingSaves). It is pure so the rules are unit-tested here, and the
// components only store the value and render from it. The rules:
//
//  - A tap starts a request and marks the tile IN FLIGHT. In-flight is never a state: the tile
//    keeps drawing its last confirmed glyph, and the header keeps counting it there.
//  - A success records the state the SERVER returned (`confirmed`). Only then does the glyph flip.
//  - A failure records nothing as confirmed. It marks the tile FAILED (shown on the tile itself,
//    so a tile far down the wall says so where the viewer is looking) and writes the wall's error
//    line, naming the title. The next tap on that tile clears its mark.

/** What a tap asks the server to do. */
export type WallTapAction = 'save' | 'unsave' | 'unprotect';

export interface WallTaps<S extends string> {
  /** Per tile, the state the server returned for this session's last successful tap on it. A tile
   *  renders this over the read model's state; nothing else may change what a tile shows. */
  readonly confirmed: ReadonlyMap<string, S>;
  /** Tiles with a request out, and what was asked. Drives the busy look and label only. */
  readonly inFlight: ReadonlyMap<string, WallTapAction>;
  /** Tiles whose last tap failed, and what failed. Cleared by the next tap on that tile. */
  readonly failed: ReadonlyMap<string, WallTapAction>;
  /** The wall's fixed-height error line (null = empty). */
  readonly error: string | null;
}

export function emptyWallTaps<S extends string>(): WallTaps<S> {
  return { confirmed: new Map(), inFlight: new Map(), failed: new Map(), error: null };
}

/** The state a tile shows: the server's answer to this session's tap, else the read model's. An
 *  in-flight request never changes it. */
export function shownState<S extends string>(taps: WallTaps<S>, id: string, serverState: S): S {
  return taps.confirmed.get(id) ?? serverState;
}

/** True while a request for this tile is out. A second tap is ignored until it settles. */
export function tapInFlight<S extends string>(taps: WallTaps<S>, id: string): boolean {
  return taps.inFlight.has(id);
}

/** A tap leaves for the server: the tile goes busy (its glyph does not change), its old failure
 *  mark and the wall's error line clear. Returns the same object when the tile is already busy, so
 *  a caller can tell the tap was ignored. */
export function beginWallTap<S extends string>(
  taps: WallTaps<S>,
  id: string,
  action: WallTapAction,
): WallTaps<S> {
  if (taps.inFlight.has(id)) return taps;
  const inFlight = new Map(taps.inFlight).set(id, action);
  const failed = new Map(taps.failed);
  failed.delete(id);
  return { ...taps, inFlight, failed, error: null };
}

/** The server answered: record ITS state for the tile (on an inert `changed:false` answer that is
 *  the item's real state, which may differ from what was asked) and end the busy look. */
export function confirmWallTap<S extends string>(
  taps: WallTaps<S>,
  id: string,
  serverState: S,
): WallTaps<S> {
  const inFlight = new Map(taps.inFlight);
  inFlight.delete(id);
  return { ...taps, confirmed: new Map(taps.confirmed).set(id, serverState), inFlight };
}

/** The request failed: nothing is recorded as confirmed, so the tile keeps its last confirmed
 *  glyph. It gains the failure mark and the error line names it. */
export function failWallTap<S extends string>(
  taps: WallTaps<S>,
  id: string,
  titleYear: string,
  message: string,
): WallTaps<S> {
  const action = taps.inFlight.get(id) ?? 'save';
  const inFlight = new Map(taps.inFlight);
  inFlight.delete(id);
  return {
    ...taps,
    inFlight,
    failed: new Map(taps.failed).set(id, action),
    error: wallTapErrorText(action, titleYear, message),
  };
}

const FAILED_VERB: Record<WallTapAction, string> = {
  save: 'was not saved',
  unsave: 'is still saved',
  unprotect: 'is still protected',
};

/** The wall's error line for a failed tap: which title, what that means, then the reason. */
export function wallTapErrorText(
  action: WallTapAction,
  titleYear: string,
  message: string,
): string {
  return `${titleYear} ${FAILED_VERB[action]}. ${message}`;
}

const BUSY_LABEL: Record<WallTapAction, string> = {
  save: 'Saving',
  unsave: 'Un-saving',
  unprotect: 'Un-protecting',
};

/** The tile's accessible name and tooltip while its request is out. */
export function wallTapBusyLabel(action: WallTapAction, title: string): string {
  return `${BUSY_LABEL[action]} ${title}…`;
}

const FAILED_NOTE: Record<WallTapAction, string> = {
  save: 'Not saved',
  unsave: 'Still saved',
  unprotect: 'Still protected',
};

/** The short note that replaces the tile's meta text after a failed tap (fits a 3-up phone tile). */
export function wallTapFailedNote(action: WallTapAction): string {
  return FAILED_NOTE[action];
}

/** The tile's accessible name after a failed tap: what failed, then what a tap does now. */
export function wallTapFailedLabel(action: WallTapAction, restingLabel: string): string {
  return `${FAILED_NOTE[action]}, the last try failed. ${restingLabel}`;
}
