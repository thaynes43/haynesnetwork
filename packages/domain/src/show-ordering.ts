// ADR-114 C-08 / DESIGN-055 P4 decision 31 — staff's PLEX ORDERING SWITCH inside a Watch Carry. Plex titles a show's
// episodes from its own agent in the show's chosen ordering (TMDB on these servers, unless switched). When that
// ordering numbers a season differently from TheTVDB (Sonarr's numbering), a file Sonarr has on the right episode shows
// another episode's title in Plex, and no Season Re-map can fix it (P4 decision 21). Switching the show to TheTVDB
// (Aired) fixes the titles, but re-matches the items: a file's item takes another episode's guid, and with it that
// episode's watch state. So the switch runs only inside a carry: snapshot the whole show for every account, clear the
// items expected to re-match, switch and refresh on every server that carries the show (read back), wait until Plex is
// done, then carry every account's state onto the item that plays each file, and verify.
//
// The writes: `setShowOrdering` and `refreshMetadata` (owner token) and the carry's per-account writes, all through
// `@hnet/plex/write` from this package (hard rule 4). Staff only, from `repair-guide.ts ordering-plan | ordering-run`.
import { createHash } from 'node:crypto';
import type { DbClient } from '@hnet/db';
import { isShowOrdering, type PlexLeafFile } from '@hnet/plex/read';
import type { ArrClientBundle } from './arr-clients';
import { FixPlanChangedError, FixRefusedError } from './errors';
import { readRemapSeasonState } from './remap-flow';
import { sameEpisodeTitle } from './season-remap-flow';
import {
  carryServersFor,
  carryWatchState,
  markWatchCarryWaiting,
  noteWatchCarry,
  preClearWatchCarry,
  takeWatchCarrySnapshot,
  type CarryWaitResult,
  type WatchCarryPlex,
  type WatchCarryResult,
} from './watch-carry';

export interface ShowOrderingRequest {
  db?: DbClient;
  arr: ArrClientBundle;
  plex: WatchCarryPlex;
  mediaItemId: string;
  /** Plex's value: `tvdbAiring` (TheTVDB, Aired), `tmdbAiring`, `tvdbDvd`, `tvdbAbsolute`, or `''` (library default). */
  ordering: string;
}

export interface ShowOrderingServerView {
  server: string;
  showRatingKey: string;
  /** The show's ordering now (`''` = the library default; null = Plex offers none). */
  current: string | null;
  /** Episode items (specials included). */
  items: number;
  /** Items whose Plex title is Sonarr's (TVDB) title for the same number. */
  followsSonarr: number;
  /** Items Plex titles otherwise: these re-match after a switch to TVDB, and are cleared first. */
  differs: number;
  /** Items Plex titles only by number, or that Sonarr has no title for. */
  unknown: number;
  /** The rating keys of the `differs` items. */
  rematchKeys: string[];
  /** The files those items play (byte sizes): the wait checks that they end on items titled as TVDB. */
  rematchSizes: number[];
}

export type ShowOrderingRefusal = 'bad_ordering' | 'no_server' | 'already';

export interface ShowOrderingPlan {
  seriesId: number;
  seriesTitle: string;
  ordering: string;
  servers: ShowOrderingServerView[];
  refusal: ShowOrderingRefusal | null;
  refusalText: string | null;
  digest: string;
}

const PLACEHOLDER = /^(episode\s*\d+|tba|tbd)$/i;

const REFUSALS: Record<ShowOrderingRefusal, string> = {
  bad_ordering: 'That is not one of Plex’s episode orderings (tvdbAiring, tmdbAiring, tvdbDvd, tvdbAbsolute, or empty).',
  no_server: 'No Plex server carries this series.',
  already: 'Every server already uses that ordering.',
};

/** Count how a server's items title against Sonarr's (TVDB) titles. Pure. */
export function orderingTitleCheck(
  leaves: readonly Pick<PlexLeafFile, 'ratingKey' | 'season' | 'episode' | 'title' | 'parts'>[],
  sonarrTitles: ReadonlyMap<string, string | null>,
): Pick<ShowOrderingServerView, 'items' | 'followsSonarr' | 'differs' | 'unknown' | 'rematchKeys' | 'rematchSizes'> {
  let followsSonarr = 0;
  let unknown = 0;
  const rematchKeys: string[] = [];
  const rematchSizes: number[] = [];
  for (const l of leaves) {
    const tv = sonarrTitles.get(`${l.season}/${l.episode}`) ?? null;
    if (!tv || PLACEHOLDER.test(l.title.trim()) || PLACEHOLDER.test(tv.trim())) unknown += 1;
    else if (sameEpisodeTitle(l.title, tv)) followsSonarr += 1;
    else {
      rematchKeys.push(l.ratingKey);
      rematchSizes.push(...l.parts.map((p) => p.size));
    }
  }
  return { items: leaves.length, followsSonarr, differs: rematchKeys.length, unknown, rematchKeys, rematchSizes };
}

/** How many of `sizes` now sit on an item whose Plex title is Sonarr's title for its number. Pure. */
export function rematchedFiles(
  leaves: readonly Pick<PlexLeafFile, 'season' | 'episode' | 'title' | 'parts'>[],
  sonarrTitles: ReadonlyMap<string, string | null>,
  sizes: readonly number[],
): number {
  let fixed = 0;
  for (const size of sizes) {
    const item = leaves.find((l) => l.parts.some((p) => p.size === size));
    const tv = item ? sonarrTitles.get(`${item.season}/${item.episode}`) ?? null : null;
    if (item && tv && sameEpisodeTitle(item.title, tv)) fixed += 1;
  }
  return fixed;
}

async function sonarrTitlesOf(input: ShowOrderingRequest) {
  const state = await readRemapSeasonState({ db: input.db, arr: input.arr, mediaItemId: input.mediaItemId, seasonNumber: 1 });
  return { state, titles: new Map(state.episodes.map((e) => [`${e.seasonNumber}/${e.episodeNumber}`, e.title] as const)) };
}

/** ADR-114 C-08 — the read-only plan: each server's ordering now and how its titles agree with TVDB. */
export async function planShowOrdering(input: ShowOrderingRequest): Promise<ShowOrderingPlan> {
  const { state, titles } = await sonarrTitlesOf(input);
  const servers: ShowOrderingServerView[] = [];
  for (const { slug, showRatingKey } of await carryServersFor({ db: input.db, mediaItemId: input.mediaItemId })) {
    const client = input.plex.server(slug);
    if (!client) continue;
    const [current, leaves] = await Promise.all([client.read.getShowOrdering(showRatingKey), client.read.listLeafFiles(showRatingKey)]);
    servers.push({ server: slug, showRatingKey, current, ...orderingTitleCheck(leaves, titles) });
  }
  let refusal: ShowOrderingRefusal | null = null;
  if (!isShowOrdering(input.ordering)) refusal = 'bad_ordering';
  else if (servers.length === 0) refusal = 'no_server';
  else if (servers.every((s) => s.current === input.ordering)) refusal = 'already';
  const digest = createHash('sha256')
    .update(JSON.stringify([input.ordering, servers.map((s) => [s.server, s.showRatingKey, s.current, s.items, s.rematchKeys])]))
    .digest('hex')
    .slice(0, 32);
  return {
    seriesId: state.seriesId,
    seriesTitle: state.seriesTitle,
    ordering: input.ordering,
    servers,
    refusal,
    refusalText: refusal ? REFUSALS[refusal] : null,
    digest,
  };
}

export interface ShowOrderingRunInput extends ShowOrderingRequest {
  planDigest: string;
  /** The wait for Plex to finish re-matching (tests shorten it). */
  wait?: { timeoutMs: number; intervalMs: number };
  pauseMs?: number;
}

export interface ShowOrderingRunResult {
  carryId: string;
  /** Per server: the ordering read back after the switch. */
  switched: Array<{ server: string; before: string | null; after: string | null; ok: boolean; error: string | null }>;
  wait: { ready: boolean; polls: number; followsSonarr: Record<string, string> };
  carry: WatchCarryResult | null;
  status: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * ADR-114 C-08 — switch the show's ordering on every server that carries it, inside a Watch Carry. Refuses a changed
 * plan or a refusal (writing nothing), and a snapshot that cannot be read (nothing switched).
 */
export async function runShowOrdering(input: ShowOrderingRunInput): Promise<ShowOrderingRunResult> {
  const plan = await planShowOrdering(input);
  if (plan.digest !== input.planDigest) throw new FixPlanChangedError('The show changed in Plex since the plan was checked. Plan it again.');
  if (plan.refusal) throw new FixRefusedError('remap_refused', plan.refusalText ?? 'The ordering cannot be switched.');
  const pauseMs = input.pauseMs;
  let carryId: string;
  try {
    const snapshot = await takeWatchCarrySnapshot({
      db: input.db,
      plex: input.plex,
      kind: 'show_ordering',
      mediaItemId: input.mediaItemId,
      seriesId: plan.seriesId,
      seasons: null,
      scope: { moved: 'all', preClear: Object.fromEntries(plan.servers.map((s) => [s.server, s.rematchKeys])) },
      detail: { ordering: input.ordering, before: Object.fromEntries(plan.servers.map((s) => [s.server, s.current])), planDigest: plan.digest },
      pauseMs,
    });
    carryId = snapshot.carryId;
    await preClearWatchCarry({ db: input.db, plex: input.plex, snapshot, pauseMs });
  } catch (err) {
    throw new FixRefusedError('remap_refused', `The watch state could not be carried (${errText(err)}). Nothing was switched.`);
  }

  const switched: ShowOrderingRunResult['switched'] = [];
  for (const s of plan.servers) {
    const client = input.plex.server(s.server)!;
    let after: string | null = null;
    let error: string | null = null;
    try {
      if (s.current !== input.ordering) await client.write.setShowOrdering(s.showRatingKey, input.ordering);
      after = await client.read.getShowOrdering(s.showRatingKey);
      if (after !== input.ordering) error = 'the ordering did not read back';
      else await client.write.refreshMetadata(s.showRatingKey);
    } catch (err) {
      error = errText(err);
    }
    switched.push({ server: s.server, before: s.current, after, ok: error === null, error });
  }
  await noteWatchCarry({ db: input.db, carryId, detail: { switched } });

  // Wait until Plex has re-matched: on every server the files that sat on wrongly titled items now sit on items titled
  // as TVDB (90%), with the listing unchanged across two reads; or, when Plex's own TVDB data differs from Sonarr's,
  // the listing unchanged across five reads after at least five polls (the carry follows what Plex shows).
  const { titles } = await sonarrTitlesOf(input);
  const timeoutMs = input.wait?.timeoutMs ?? 20 * 60_000;
  const intervalMs = input.wait?.intervalMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const lastSig = new Map<string, string>();
  const stableFor = new Map<string, number>();
  const follows: Record<string, string> = {};
  let polls = 0;
  let ready = false;
  for (;;) {
    polls += 1;
    if (polls > 1 || intervalMs === 0) await sleep(intervalMs);
    let allReady = true;
    for (const s of plan.servers) {
      const client = input.plex.server(s.server)!;
      let leaves: PlexLeafFile[];
      try {
        leaves = await client.read.listLeafFiles(s.showRatingKey);
      } catch {
        allReady = false;
        continue;
      }
      const sig = JSON.stringify(leaves.map((l) => [l.ratingKey, l.guid, l.season, l.episode, l.parts.map((p) => p.size)]).sort());
      stableFor.set(s.server, lastSig.get(s.server) === sig ? (stableFor.get(s.server) ?? 0) + 1 : 0);
      lastSig.set(s.server, sig);
      const fixed = rematchedFiles(leaves, titles, s.rematchSizes);
      const share = s.rematchSizes.length > 0 ? fixed / s.rematchSizes.length : 1;
      const check = orderingTitleCheck(leaves, titles);
      follows[s.server] = `${check.followsSonarr} of ${check.followsSonarr + check.differs} titled as TVDB; ${fixed} of ${s.rematchSizes.length} re-matched files`;
      const stable = stableFor.get(s.server) ?? 0;
      if (!((stable >= 1 && share >= 0.9) || (stable >= 4 && polls >= 5))) allReady = false;
    }
    if (allReady) {
      ready = true;
      break;
    }
    if (Date.now() + intervalMs > deadline) break;
  }
  const waitResult: CarryWaitResult = { ready, missing: [], polls };
  if (!ready) {
    await markWatchCarryWaiting({ db: input.db, carryId, wait: waitResult, detail: { follows } });
    return { carryId, switched, wait: { ready, polls, followsSonarr: follows }, carry: null, status: 'waiting' };
  }
  await noteWatchCarry({ db: input.db, carryId, detail: { follows } });
  const carry = await carryWatchState({ db: input.db, plex: input.plex, carryId, pauseMs });
  return { carryId, switched, wait: { ready, polls, followsSonarr: follows }, carry, status: carry.status };
}
