// ADR-114 — an in-memory Plex server for the Watch Carry tests, behaving as the live servers did on 2026-10-13:
//   - each file is ONE item, at its season and FIRST episode (a two-episode file is one item);
//   - an item's rating key and watch state belong to the episode it is matched to (its guid), not to the file, so a
//     file that moves takes another item's state, and a guid's state outlives its item (an orphaned mark comes back
//     when a file lands there again);
//   - every account (the owner and each friend) has its own state; scrobble adds one play and dates it now, unscrobble
//     clears plays and the resume point, and a resume point of 60 s or less on an unwatched item is not kept.
// The files come from a callback, so a test can wire the server to its stub Sonarr and see every move at once.
import type { WatchCarryAccount, WatchCarryPlex, WatchCarryServer } from '../src/watch-carry';

export interface FakeFile {
  size: number;
  name: string;
  season: number;
  episodes: number[];
}

export interface FakeState {
  viewCount: number;
  viewOffset: number;
  lastViewedAt: number | null;
}

export interface FakePlexOptions {
  slug?: string;
  showRatingKey?: string;
  section?: string;
  files: () => FakeFile[];
  /** Account ids; the first is the owner. */
  accounts: string[];
  /** The episode (guid) Plex matches a number to, in the show's ordering. */
  guidOf?: (season: number, episode: number, ordering: string) => string;
}

export function fakePlex(opts: FakePlexOptions) {
  const slug = opts.slug ?? 'haynestower';
  const showRatingKey = opts.showRatingKey ?? 'show-1';
  const section = opts.section ?? '4';
  let clock = 4_000_000_000;
  let ordering = '';
  const guidOf = opts.guidOf ?? ((s: number, e: number) => `g-${s}-${e}`);
  const state = new Map<string, Map<string, FakeState>>();
  const calls: Array<{ account: string; call: string; ratingKey: string; arg?: number }> = [];
  const failRead = new Set<string>();
  /** Account → the write number (1-based) that throws. */
  const failWriteAt = new Map<string, number>();
  const writesBy = new Map<string, number>();

  const items = () =>
    opts.files().map((f) => {
      const episode = Math.min(...f.episodes);
      const guid = guidOf(f.season, episode, ordering);
      return { ratingKey: `rk-${guid}`, guid, title: `Title ${guid}`, season: f.season, episode, parts: [{ name: f.name, size: f.size }] };
    });
  const st = (account: string, guid: string) => {
    if (!state.has(account)) state.set(account, new Map());
    const byGuid = state.get(account)!;
    if (!byGuid.has(guid)) byGuid.set(guid, { viewCount: 0, viewOffset: 0, lastViewedAt: null });
    return byGuid.get(guid)!;
  };
  const leavesFor = (account: string) =>
    items().map((i) => {
      const s = state.get(account)?.get(i.guid) ?? { viewCount: 0, viewOffset: 0, lastViewedAt: null };
      return { ...i, viewCount: s.viewCount, viewOffset: s.viewOffset, lastViewedAt: s.lastViewedAt };
    });
  const itemGuid = (ratingKey: string) => {
    const hit = items().find((i) => i.ratingKey === ratingKey);
    if (!hit) throw new Error(`GET /:/x → HTTP 404 (no item ${ratingKey})`);
    return hit.guid;
  };
  const write = (account: string, call: string, ratingKey: string, arg?: number) => {
    const n = (writesBy.get(account) ?? 0) + 1;
    writesBy.set(account, n);
    if (failWriteAt.get(account) === n) throw new Error(`GET /:/${call} → HTTP 500`);
    calls.push({ account, call, ratingKey, ...(arg !== undefined ? { arg } : {}) });
  };

  const accountClient = (accountId: string, owner: boolean): WatchCarryAccount => ({
    accountId,
    owner,
    read: {
      async listLeafFiles() {
        if (failRead.has(accountId)) throw new Error('GET /library/metadata/show-1/allLeaves → HTTP 500');
        return leavesFor(accountId);
      },
    },
    write: {
      async scrobble(ratingKey: string) {
        write(accountId, 'scrobble', ratingKey);
        const s = st(accountId, itemGuid(ratingKey));
        s.viewCount += 1;
        s.viewOffset = 0;
        s.lastViewedAt = ++clock;
      },
      async unscrobble(ratingKey: string) {
        write(accountId, 'unscrobble', ratingKey);
        state.get(accountId)?.delete(itemGuid(ratingKey));
      },
      async setProgress(ratingKey: string, offsetMs: number) {
        write(accountId, 'progress', ratingKey, offsetMs);
        const s = st(accountId, itemGuid(ratingKey));
        if (s.viewCount === 0 && offsetMs <= 60_000) return;
        s.viewOffset = offsetMs;
        s.lastViewedAt = ++clock;
      },
    },
  });

  const server: WatchCarryServer = {
    slug,
    read: {
      async listLeafFiles() {
        return leavesFor(opts.accounts[0]!);
      },
      async getMetadataItem() {
        return { item: { ratingKey: showRatingKey, type: 'show', title: 'Show', Guid: [], Label: [] }, librarySectionId: section };
      },
      async getShowOrdering() {
        return ordering;
      },
    },
    write: {
      async setShowOrdering(_key: string, value: string) {
        ordering = value;
      },
      async refreshMetadata() {
        // The fake re-matches at once (the ordering is read on every listing).
      },
    },
    async accounts() {
      return opts.accounts.map((id, i) => accountClient(id, i === 0));
    },
  };
  const plex: WatchCarryPlex = { server: (s) => (s === slug ? server : null) };

  return {
    plex,
    server,
    calls,
    failRead,
    failWriteAt,
    /** Seed an account's state on the episode with this guid. */
    seed(account: string, guid: string, s: Partial<FakeState>) {
      Object.assign(st(account, guid), { viewCount: 0, viewOffset: 0, lastViewedAt: 1_700_000_000, ...s });
    },
    /** An account's state on a guid (empty when none). */
    view(account: string, guid: string): FakeState {
      const s = state.get(account)?.get(guid);
      return s ? { ...s } : { viewCount: 0, viewOffset: 0, lastViewedAt: null };
    },
    /** A real view now (after the snapshot). */
    watchNow(account: string, guid: string) {
      const s = st(account, guid);
      s.viewCount += 1;
      s.lastViewedAt = ++clock;
    },
    get ordering() {
      return ordering;
    },
  };
}
