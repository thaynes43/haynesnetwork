// ADR-109 C-02, C-04, C-06 / DESIGN-055 D-06 (PLAN-077 P5) — the RELEASE PICK (T-307): every release for one missing
// episode or movie, the *arr's reasons in plain words, a grab of an approved one, and the guarded override of a rejected
// one under the owner's Q-01 ruling (anyone who can use Fix, a missing episode or movie only, within the hourly budget,
// and only when every reason is on the overridable list; the hard-refusal list applies to everyone, admins included).
//
// Three parts:
// 1. Pure: `describeRejection` (the plain-words mapping, versioned) and `classifyReleases` (the rows the person sees,
//    each with its state, reasons, Title Evidence and the recommended pick). Unit-tested on the live Lost Tapes reads.
// 2. `openReleaseList`: reads the target and its queue, searches (the release cache and the member throttle of P1), and
//    writes the Release List (T-319) with its `release_list_requested` ledger event, the budget unit, in one transaction.
// 3. `grabFromReleaseList`: re-reads the target, opens a `release_pick` Repair Request (the budget unit and the one open
//    repair per grain), then `POST /release` through @hnet/arr/write (hard rule 4) with the body the *arr's own UI sends.
//    The import follows through P2's Import Check: Force Search on the target imports a finished download whose name
//    the *arr could not file, and the janitor's `importable` cell does the same where it is enforced.
import { createHash } from 'node:crypto';
import {
  ledgerEvents,
  mediaItems,
  releasePickLists,
  repairRequests,
  users,
  type DbClient,
} from '@hnet/db';
import {
  ArrError,
  ArrHttpError,
  type ArrRelease,
  type ArrReleaseLanguageModel,
  type ArrReleaseQualityModel,
  type RadarrQueueRecord,
  type SonarrQueueRecord,
} from '@hnet/arr';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { ArrClientBundle } from './arr-clients';
import { inTransaction, resolveDb } from './db-client';
import {
  ArrUpstreamError,
  FixRateLimitError,
  FixRefusedError,
  LedgerItemTombstonedError,
  NotFoundError,
} from './errors';
import { resolveSearchTarget, type SearchScope } from './action-scope';
import { episodeLabel } from './media-children';
import { effectiveMediaActionBudget, mediaActionBudgetReachedMessage } from './media-action-budgets';
import { countRecentFixBudget } from './fix-requests';
import { forgetReleaseLists, readReleaseListCached, RELEASE_LIST_TTL_MS } from './fix-plan';
import { isExistingFileRejection } from './fix-guards';
import { getRepairGuideRemedies } from './repair-guide-settings';
import { createRepairRequest, recordRepairTransition } from './repair-requests';
import { consoleDomainLogger } from './domain-logger';
import { queueRecordState } from './queue-aware-search';
import {
  episodeTitleEvidence,
  movieTitleEvidence,
  seriesYearConflict,
  type TitleEvidenceEpisode,
  type TitleVerdict,
} from './title-evidence';

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

/** Bump when a reason's class or words change, so a stored list can be told apart from one the current rules give. */
export const RELEASE_REASONS_VERSION = 2;

/**
 * DESIGN-055 D-06 — how long after the *arr's search a row can still be grabbed. The *arr keeps the rows it listed in
 * its own release cache for 30 minutes (ReleaseController `_remoteEpisodeCache`, `TimeSpan.FromMinutes(30)`); a grab
 * after that answers 404, so the app refuses a little before and asks for a fresh list.
 */
export const RELEASE_PICK_GRAB_WINDOW_MS = 25 * 60_000;

/** DESIGN-055 D-06 — the hard size limit for an episode or a movie when the profile's own limit cannot be relied on. */
export const RELEASE_PICK_EPISODE_SIZE_CAP = 15 * 1024 ** 3;
export const RELEASE_PICK_MOVIE_SIZE_CAP = 100 * 1024 ** 3;

/** The qualities that are never the real release: theatre recordings, screeners and work prints (hard refusal). */
const EARLY_COPY_QUALITIES = new Set(['cam', 'telesync', 'telecine', 'workprint', 'dvdscr', 'regional']);

/** Whole disc images (P5 decision 15): not a file Plex can play, so not a person's pick. */
const DISC_IMAGE_QUALITIES = new Set(['br-disk', 'raw-hd']);

// ---------------------------------------------------------------------------------------------------------------------
// Reasons in plain words
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What a reason allows (Q-01 ruling, D-06): `overridable` reasons a person may override; any `hard` reason refuses the
 * row for everyone; an `other` reason is on neither list, so the row is not allowed either (staff can still grab it in
 * the *arr).
 */
export type ReleaseReasonClass = 'overridable' | 'hard' | 'other';

export type ReleaseReasonCode =
  // overridable (D-06)
  | 'quality_not_wanted'
  | 'score_below_minimum'
  | 'language_not_wanted'
  | 'numbered_other_episode'
  // hard (D-06)
  | 'blocklisted'
  | 'blocked_term'
  | 'early_copy'
  | 'unknown_quality'
  | 'sample'
  | 'too_big'
  | 'in_queue'
  | 'title_names_other_episode'
  | 'other_show'
  | 'other_movie'
  // neither
  | 'not_this_episode'
  | 'existing_file'
  | 'not_monitored'
  | 'too_small'
  | 'too_old'
  | 'few_seeders'
  | 'protocol_off'
  | 'pack'
  | 'not_matched'
  | 'raw_disc'
  | 'already_downloaded'
  | 'required_term_missing'
  | 'history'
  | 'site_unavailable'
  | 'too_new'
  | 'delayed'
  | 'burned_in_subs'
  | 'unknown_runtime'
  | 'disk_space'
  | 'site_rules'
  | 'revision_rules'
  | 'not_available_yet'
  | 'unknown';

export interface ReleaseReason {
  code: ReleaseReasonCode;
  class: ReleaseReasonClass;
  /** The reason in plain words, for anyone in the household. */
  text: string;
  /** The *arr's own words, shown under "What Sonarr says"; null for a reason the app worked out itself. */
  arrText: string | null;
}

/** What the plain words need to know about the row and its target. */
export interface DescribeContext {
  kind: 'sonarr' | 'radarr';
  /** The row is numbered for another episode and its title names the target (D-06's overridable episode reason). */
  mislabeled?: boolean;
}

const noun = (ctx: DescribeContext) => (ctx.kind === 'radarr' ? 'movie' : 'episode');
const showOrMovie = (ctx: DescribeContext) => (ctx.kind === 'radarr' ? 'movie' : 'show');

/** "WEBDL-720p" reads "720p", "Bluray-1080p Remux" reads "1080p"; a name with no resolution is shown as it is. */
export function plainQuality(name: string | null | undefined): string {
  if (!name) return 'an unknown quality';
  const res = /(\d{3,4}p)/i.exec(name);
  if (res) return res[1]!.toLowerCase();
  if (/^sdtv|^dvd/i.test(name)) return 'standard definition';
  return name;
}

const reason = (code: ReleaseReasonCode, cls: ReleaseReasonClass, text: string, arrText: string | null): ReleaseReason => ({
  code,
  class: cls,
  text,
  arrText,
});

/**
 * DESIGN-055 D-06 — one *arr rejection in plain words (RELEASE_REASONS_VERSION 1), from the rejection texts of Sonarr
 * 4.0.20.3012's and Radarr 6.4.4.10685's decision engine (`DownloadSpecDecision.Reject` in DecisionEngine/
 * Specifications, read at those tags). null means the rejection does not apply to a pick for this one target:
 * - a season search's own rules ("season pack required", "Full season release rejected"), which a one-episode grab never
 *   meets;
 * - "Episode wasn't requested" and an Existing-File Rejection on a row numbered for another episode whose title names
 *   the target (the rejection is about that other episode).
 * An unknown rejection is shown in the *arr's own words and allows nothing.
 */
export function describeRejection(text: string, ctx: DescribeContext): ReleaseReason | null {
  const t = text.trim();
  let m: RegExpExecArray | null;
  // Not applicable to a pick for one target.
  if (/season pack required/i.test(t) || /^Full season release rejected/i.test(t)) return null;
  if (ctx.mislabeled && (/^Episode wasn't requested/i.test(t) || /^Wrong episode$/i.test(t))) return null;
  if (ctx.mislabeled && isExistingFileRejection(t)) return null;

  // Hard refusals (D-06), for everyone.
  if (/^Release is blocklisted$/i.test(t)) {
    return reason('blocklisted', 'hard', 'Blocked after an earlier download of it failed or was removed', t);
  }
  if (/^Contains these ignored terms:/i.test(t)) {
    return reason('blocked_term', 'hard', `Blocked by one of the library's rules for this ${showOrMovie(ctx)}`, t);
  }
  if (/^Sample$/i.test(t)) return reason('sample', 'hard', `Only a short sample, not the whole ${noun(ctx)}`, t);
  if (/is larger than maximum allowed|is too big, maximum size is/i.test(t)) {
    return reason('too_big', 'hard', 'Bigger than the library allows for this quality', t);
  }
  if (/^(Quality for )?release in queue/i.test(t)) {
    return reason('in_queue', 'hard', `Something for this ${noun(ctx)} is already downloading`, t);
  }

  // Overridable (Q-01 ruling).
  if ((m = /^(.+?) is not wanted in profile$/i.exec(t))) {
    return reason(
      'quality_not_wanted',
      'overridable',
      `Not a quality the library usually keeps (${plainQuality(m[1])})`,
      t,
    );
  }
  if (/^Custom Formats? .* have score -?\d+ below .*profile minimum -?\d+$/i.test(t)) {
    return reason('score_below_minimum', 'overridable', 'Lower quality than the library usually keeps', t);
  }
  if ((m = /^(?:Original Language \((?:.+?)\)|.+?) is wanted, but found (.+)$/i.exec(t))) {
    return reason(
      'language_not_wanted',
      'overridable',
      `In a language the library doesn't usually keep (${m[1]!.trim()})`,
      t,
    );
  }

  // Neither list: not allowed, in plain words.
  if (/^Episode wasn't requested/i.test(t) || /^Wrong episode$/i.test(t)) {
    return reason('not_this_episode', 'other', 'Listed as a different episode', t);
  }
  if (isExistingFileRejection(t)) return reason('existing_file', 'other', 'Not better than the file already there', t);
  if (/not monitored/i.test(t)) {
    return reason('not_monitored', 'other', `This ${noun(ctx)} is turned off for downloads`, t);
  }
  if (/is smaller than minimum allowed/i.test(t)) {
    return reason('too_small', 'other', 'Smaller than a real copy should be', t);
  }
  if (/^Older than configured retention$/i.test(t)) return reason('too_old', 'other', 'Too old to download', t);
  if (/^Not enough seeders/i.test(t)) return reason('few_seeders', 'other', 'Not enough people are sharing it', t);
  if (/is not enabled for this (series|movie)$/i.test(t)) {
    return reason('protocol_off', 'other', `The library doesn't download this kind of release for this ${showOrMovie(ctx)}`, t);
  }
  if (/^Full season pack$|^Multi-season releases|^Split episode/i.test(t)) {
    return reason('pack', 'other', 'Holds more than this one episode', t);
  }
  if (
    /^(Unknown Series|Wrong series|Wrong season|Unable to parse|Unable to identify|Unknown Movie|Wrong movie)/i.test(t) ||
    /matches an alias for series|ambiguous numbering/i.test(t)
  ) {
    return reason('not_matched', 'other', `Couldn't be matched to this ${showOrMovie(ctx)}`, t);
  }
  if (/^Raw (Bluray|DVD)/i.test(t)) return reason('raw_disc', 'other', "A raw disc copy the library can't use", t);
  if (/^Has same (torrent hash|release name) as a grabbed and imported release$/i.test(t)) {
    return reason('already_downloaded', 'other', 'Downloaded once before', t);
  }
  if (/^Does not contain one of the required terms/i.test(t)) {
    return reason('required_term_missing', 'other', "Missing something the library's rules require", t);
  }
  if (/grab event in history|^Recent grab event/i.test(t)) {
    return reason('history', 'other', 'Something as good was already downloaded once', t);
  }
  if (/^Indexer .* is blocked till/i.test(t)) {
    return reason('site_unavailable', 'other', "The site it comes from isn't available", t);
  }
  if (/^Only -?\d+ minutes old/i.test(t)) {
    return reason('too_new', 'other', 'Too new: the library waits a short while before taking a release', t);
  }
  if (/^Waiting for better quality release$/i.test(t) || /already pending, delaying pushed release/i.test(t)) {
    return reason('delayed', 'other', 'The library is waiting in case a better copy turns up', t);
  }
  if (/^Hardcode subs found/i.test(t)) {
    return reason('burned_in_subs', 'other', 'Has subtitles burned into the picture', t);
  }
  if (/runtime .*is 0|Runtime of all episodes is 0/i.test(t)) {
    return reason('unknown_runtime', 'other', `The ${noun(ctx)}'s length isn't known yet, so its size can't be checked`, t);
  }
  if (/free space/i.test(t)) return reason('disk_space', 'other', 'Not enough free space for it', t);
  if (/indexer flags|tags do not match/i.test(t)) {
    return reason('site_rules', 'other', "The library's rules for that site don't allow it", t);
  }
  if (/proper|repack|release group/i.test(t)) {
    return reason('revision_rules', 'other', "A fix-up release the library doesn't take here", t);
  }
  if (/will only be considered available/i.test(t)) {
    return reason('not_available_yet', 'other', "The movie isn't considered out yet", t);
  }
  return reason('unknown', 'other', t, t);
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------------------------------------------------

export type ReleasePickState = 'grab' | 'override' | 'not_allowed';

/** The Title Evidence badge of a row (D-05 against the target). `none` for a movie row the evidence cannot judge. */
export interface ReleasePickTitle {
  verdict: TitleVerdict | 'none';
  /** The episode the name's title names, when it names another one, or the target when a mislabeled row names it. */
  namedLabel: string | null;
}

/** One row of the list, as the person sees it (no guid, no URL). Rows of one release on several sites are one row. */
export interface ReleasePickRow {
  /** Opaque: the first source's key. The grab sends it back. */
  key: string;
  /** Every source of this release in the *arr's order (the first is `key`): a grab the site refuses tries the next. */
  keys: string[];
  title: string;
  sizeBytes: number | null;
  qualityName: string | null;
  /** "1080p", "720p", "standard definition". */
  qualityPlain: string;
  languages: string[];
  customFormatScore: number | null;
  ageHours: number | null;
  indexer: string | null;
  protocol: string | null;
  releaseGroup: string | null;
  state: ReleasePickState;
  reasons: ReleaseReason[];
  /** The Title Evidence badge (D-05 against the target); null for a pack. */
  evidence: ReleasePickTitle | null;
  /** Numbered for another episode (that episode's label) but its title names the target. */
  numberedAs: string | null;
  recommended: boolean;
}

/** What a grab needs for a row the person may pick. Kept server-side (`release_pick_lists.offers`). */
export interface ReleasePickOffer {
  key: string;
  guid: string;
  indexerId: number;
  title: string;
  state: 'grab' | 'override';
  /** The plain body (`{guid, indexerId}`) only for a row the *arr approved and mapped onto the target itself. */
  overrideBody: boolean;
  quality: ArrReleaseQualityModel | null;
  languages: ArrReleaseLanguageModel[];
  reasonCodes: ReleaseReasonCode[];
  titleVerdict: TitleVerdict | 'none' | null;
  numberedAs: string | null;
}

export type ReleasePickTarget =
  | {
      kind: 'sonarr';
      seriesId: number;
      seriesYear: number | null;
      episodeId: number;
      seasonNumber: number;
      episodeNumber: number;
      label: string;
      /** Every episode of the target's season (Title Evidence judges against all of them). */
      seasonEpisodes: TitleEvidenceEpisode[];
    }
  | {
      kind: 'radarr';
      movieId: number;
      label: string;
      titles: string[];
      year: number | null;
    };

export interface ClassifiedReleases {
  rows: ReleasePickRow[];
  offers: ReleasePickOffer[];
  recommendedKey: string | null;
  counts: { grab: number; override: number; notAllowed: number; sources: number; dropped: number };
}

/** A stable opaque key for one source of a release (the guid itself never leaves the server). */
export function releaseKey(release: Pick<ArrRelease, 'guid' | 'indexerId'>): string {
  return createHash('sha256').update(`${release.indexerId ?? 'x'}:${release.guid}`).digest('hex').slice(0, 16);
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const episodeCode = (season: number, episode: number) =>
  `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

interface RowDraft {
  release: ArrRelease;
  reasons: ReleaseReason[];
  state: ReleasePickState;
  title: ReleasePickTitle | null;
  numberedAs: string | null;
  overrideBody: boolean;
  /** 0: the title names the target and the number matches; 1: the title names it, numbered for another; 2: the rest. */
  evidenceRank: number;
}

function stateOf(reasons: readonly ReleaseReason[]): ReleasePickState {
  if (reasons.some((r) => r.class === 'hard')) return 'not_allowed';
  if (reasons.length === 0) return 'grab';
  return reasons.every((r) => r.class === 'overridable') ? 'override' : 'not_allowed';
}

function dedupeReasons(reasons: ReleaseReason[]): ReleaseReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const k = `${r.code}|${r.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The reasons the app works out itself, beside the *arr's (D-06 hard refusals that a rejection may not carry). */
function appReasons(release: ArrRelease, target: ReleasePickTarget, ctx: DescribeContext, have: ReleaseReason[]): ReleaseReason[] {
  const out: ReleaseReason[] = [];
  const q = (release.qualityName ?? '').toLowerCase();
  if (EARLY_COPY_QUALITIES.has(q)) {
    out.push(reason('early_copy', 'hard', 'A camera recording or early copy, not the real release', null));
  } else if (q === '' || q === 'unknown') {
    out.push(reason('unknown_quality', 'hard', "Its quality can't be told from its name", null));
  } else if (DISC_IMAGE_QUALITIES.has(q) && !have.some((r) => r.code === 'raw_disc')) {
    // P5 decision 15: a whole disc image (BR-DISK, Raw-HD) is not a file Plex can play; never a person's pick.
    out.push(reason('raw_disc', 'other', "A raw disc copy the library can't use", null));
  }
  const cap = target.kind === 'radarr' ? RELEASE_PICK_MOVIE_SIZE_CAP : RELEASE_PICK_EPISODE_SIZE_CAP;
  if (release.size !== null && release.size > cap && !have.some((r) => r.code === 'too_big')) {
    out.push(reason('too_big', 'hard', `Much bigger than ${target.kind === 'radarr' ? 'a movie' : 'an episode'} should be`, null));
  }
  return out;
}

/**
 * DESIGN-055 D-06 — the rows a person sees for one target, in the *arr's own decision order within each state (Grab,
 * then Override, then Not allowed), with the recommended pick marked. Hard refusals win over everything (an approved row
 * whose name says it is another episode is Not allowed). A Sonarr season list is narrowed to the target: rows numbered
 * for it (a pack or a multi-episode file that holds it is shown, Not allowed), and rows numbered for another episode of
 * the season whose own title names the target (D-06's overridable episode reason, Case A's `S01E10.Spice.It.Up`). Rows
 * the *arr could not match to the title are dropped.
 */
export function classifyReleases(releases: readonly ArrRelease[], target: ReleasePickTarget): ClassifiedReleases {
  const ctxBase: DescribeContext = { kind: target.kind };
  const drafts: RowDraft[] = [];
  let dropped = 0;
  for (const release of releases) {
    let mislabeledAs: string | null = null;
    let pack = false;
    let title: ReleasePickTitle | null = null;
    let evidenceRank = 2;
    const extra: ReleaseReason[] = [];

    if (target.kind === 'sonarr') {
      if (release.seasonNumber !== target.seasonNumber) {
        dropped += 1;
        continue;
      }
      const eps = release.episodeNumbers;
      const covers = release.fullSeason || eps.includes(target.episodeNumber);
      if (covers) {
        pack = release.fullSeason || eps.length > 1;
      } else if (eps.length === 1) {
        const te = episodeTitleEvidence({
          name: release.title,
          episodes: target.seasonEpisodes,
          againstEpisodeIds: [target.episodeId],
        });
        if (te.verdict !== 'agrees') {
          dropped += 1;
          continue;
        }
        const numbered = target.seasonEpisodes.find(
          (e) => e.seasonNumber === target.seasonNumber && e.episodeNumber === eps[0],
        );
        mislabeledAs = numbered
          ? episodeLabel(numbered.seasonNumber, numbered.episodeNumber, numbered.title ?? '')
          : episodeCode(target.seasonNumber, eps[0]!);
      } else {
        dropped += 1;
        continue;
      }

      if (pack) {
        extra.push(reason('pack', 'other', 'Holds more than this one episode', null));
      } else {
        const te = episodeTitleEvidence({
          name: release.title,
          episodes: target.seasonEpisodes,
          againstEpisodeIds: [target.episodeId],
        });
        const named =
          te.bestEpisodeId !== null ? target.seasonEpisodes.find((e) => e.id === te.bestEpisodeId) ?? null : null;
        const namedLabel = named ? episodeLabel(named.seasonNumber, named.episodeNumber, named.title ?? '') : null;
        title = { verdict: te.verdict, namedLabel: te.verdict === 'disagrees' || mislabeledAs ? namedLabel : null };
        if (te.verdict === 'disagrees') {
          extra.push(
            reason(
              'title_names_other_episode',
              'hard',
              `Its name says it's a different episode${namedLabel ? ` (${namedLabel})` : ''}`,
              null,
            ),
          );
        }
        const year = seriesYearConflict({ name: release.title, seriesYear: target.seriesYear });
        if (year !== null) {
          extra.push(reason('other_show', 'hard', `Its name is for a different show (${year})`, null));
        }
        if (mislabeledAs) {
          extra.push(
            reason(
              'numbered_other_episode',
              'overridable',
              `Numbered as ${mislabeledAs.split(' · ')[0]}, but its title is this episode's`,
              null,
            ),
          );
          evidenceRank = 1;
        } else if (te.verdict === 'agrees') {
          evidenceRank = 0;
        }
      }
    } else {
      const te = movieTitleEvidence({ name: release.title, titles: target.titles, year: target.year });
      title = { verdict: te.verdict, namedLabel: null };
      if (te.verdict === 'agrees') evidenceRank = 0;
      // P5 decision 15: a movie's Title Evidence has no `disagrees`; `ambiguous` is its mismatch (the name does not
      // carry any of the movie's titles, or names another year), as for the Import Check (P2 decision 8). An indexer can
      // tag another movie's release with this movie's id, and Radarr approves it (Zom 100's list, 2026-10-13, carried
      // "The Convert 2023" and "The List 2023" as approved): it is never a pick, approved or not.
      if (te.verdict === 'ambiguous') {
        extra.push(reason('other_movie', 'hard', 'Its name is for a different movie', null));
      }
    }

    const ctx: DescribeContext = { ...ctxBase, mislabeled: mislabeledAs !== null };
    const fromArr = release.rejections
      .map((r) => describeRejection(r, ctx))
      .filter((r): r is ReleaseReason => r !== null);
    if (fromArr.some((r) => r.code === 'not_matched')) {
      dropped += 1;
      continue;
    }
    const all = dedupeReasons([...fromArr, ...extra, ...appReasons(release, target, ctx, fromArr)]);
    // Hard first, then the rest, so the first line a person reads is the one that decides.
    const order: Record<ReleaseReasonClass, number> = { hard: 0, other: 1, overridable: 2 };
    all.sort((a, b) => order[a.class] - order[b.class]);
    const state = stateOf(all);
    drafts.push({
      release,
      reasons: all,
      state,
      title,
      numberedAs: mislabeledAs,
      overrideBody: !release.approved || !release.downloadAllowed || mislabeledAs !== null,
      evidenceRank,
    });
  }

  // One row per release (the same title, protocol, state and reasons on several sites), first source first.
  const groups = new Map<string, RowDraft[]>();
  for (const d of drafts) {
    const k = [
      normTitle(d.release.title),
      d.release.protocol ?? '',
      d.state,
      d.reasons.map((r) => r.code).sort().join(','),
    ].join('|');
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const stateRank: Record<ReleasePickState, number> = { grab: 0, override: 1, not_allowed: 2 };
  const grouped = [...groups.values()];
  const firstIndex = new Map(grouped.map((g) => [g, drafts.indexOf(g[0]!)] as const));
  grouped.sort((a, b) => stateRank[a[0]!.state] - stateRank[b[0]!.state] || firstIndex.get(a)! - firstIndex.get(b)!);

  // The recommended pick: the first Grab; else the Override whose title names the target, then the one the library's
  // custom formats score highest (P5 decision 16: a large negative score is a format the owner refuses, such as x265 at
  // -9925, so a quality the profile merely does not list ranks above it), then the *arr's order.
  let recommended: RowDraft[] | null = grouped.find((g) => g[0]!.state === 'grab') ?? null;
  if (!recommended) {
    const overrides = grouped.filter((g) => g[0]!.state === 'override');
    const score = (g: RowDraft[]) => g[0]!.release.customFormatScore ?? 0;
    overrides.sort(
      (a, b) =>
        a[0]!.evidenceRank - b[0]!.evidenceRank || score(b) - score(a) || firstIndex.get(a)! - firstIndex.get(b)!,
    );
    recommended = overrides[0] ?? null;
  }

  const rows: ReleasePickRow[] = grouped.map((g) => {
    const d = g[0]!;
    const r = d.release;
    const keys = g.map((x) => releaseKey(x.release));
    return {
      key: keys[0]!,
      keys,
      title: r.title,
      sizeBytes: r.size,
      qualityName: r.qualityName,
      qualityPlain: plainQuality(r.qualityName),
      languages: [...new Set(g.flatMap((x) => x.release.languages))],
      customFormatScore: r.customFormatScore,
      ageHours: r.ageHours,
      indexer: r.indexer,
      protocol: r.protocol,
      releaseGroup: r.releaseGroup,
      state: d.state,
      reasons: d.reasons,
      evidence: d.title,
      numberedAs: d.numberedAs,
      recommended: g === recommended,
    };
  });
  const offers: ReleasePickOffer[] = drafts
    .filter((d) => d.state !== 'not_allowed' && d.release.indexerId !== null)
    .map((d) => ({
      key: releaseKey(d.release),
      guid: d.release.guid,
      indexerId: d.release.indexerId as number,
      title: d.release.title,
      state: d.state as 'grab' | 'override',
      overrideBody: d.overrideBody,
      quality: d.release.qualityModel,
      languages: d.release.languageModels,
      reasonCodes: d.reasons.map((x) => x.code),
      titleVerdict: d.title?.verdict ?? null,
      numberedAs: d.numberedAs,
    }));
  return {
    rows,
    offers,
    recommendedKey: recommended ? releaseKey(recommended[0]!.release) : null,
    counts: {
      grab: rows.filter((r) => r.state === 'grab').length,
      override: rows.filter((r) => r.state === 'override').length,
      notAllowed: rows.filter((r) => r.state === 'not_allowed').length,
      sources: drafts.length,
      dropped,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The target and its queue (I/O)
// ---------------------------------------------------------------------------------------------------------------------

export interface ReleasePickTargetInput {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  mediaItemId: string;
  scope?: SearchScope;
  targetChildId?: number;
}

/** What the list says when it shows no rows. */
export type ReleasePickStatus =
  /** The rows. */
  | 'list'
  /** The target has a file now: the Release Pick is for missing items only (Q-01). */
  | 'has_file'
  /** A download for the target is on its way: nothing to pick. */
  | 'on_its_way'
  /** A download for the target is stuck or failed in the queue: Force Search shows it (the Import Check). */
  | 'queue_stuck';

interface ResolvedTarget {
  mediaItemId: string;
  target: ReleasePickTarget;
  hasFile: boolean;
  monitored: boolean;
  queueState: 'none' | 'on_its_way' | 'queue_stuck';
  download: { title: string | null; progress: number | null; status: string | null } | null;
}

async function guardedRead<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArrError) {
      throw new ArrUpstreamError(`${what}: ${err instanceof Error ? err.message : 'failed'}`, { cause: err });
    }
    throw err;
  }
}

function queueStateOf(records: readonly (SonarrQueueRecord | RadarrQueueRecord)[]): ResolvedTarget['queueState'] {
  if (records.length === 0) return 'none';
  const states = records.map(queueRecordState);
  return states.includes('on_its_way') ? 'on_its_way' : 'queue_stuck';
}

function downloadOf(records: readonly (SonarrQueueRecord | RadarrQueueRecord)[]): ResolvedTarget['download'] {
  const r = records[0];
  if (!r) return null;
  const size = r.size ?? null;
  const left = r.sizeleft ?? null;
  return {
    title: r.title ?? null,
    status: r.status ?? null,
    progress: size !== null && size > 0 && left !== null ? Math.max(0, Math.min(1, (size - left) / size)) : null,
  };
}

/**
 * The target, live: one Sonarr episode (with its season's episodes and the series year, for Title Evidence) or one
 * Radarr movie, whether it has a file, and what the queue holds for it.
 */
export async function readReleasePickTarget(input: ReleasePickTargetInput): Promise<ResolvedTarget> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      title: mediaItems.title,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to search in the *arr`);
  }
  const { scope, targetChildId } = resolveSearchTarget(item.arrKind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
  });
  if (item.arrKind === 'radarr') {
    const [movie, queue] = await guardedRead('movie read', () =>
      Promise.all([input.arr.read.radarr.getMovieById(item.arrItemId), input.arr.read.radarr.getQueue(item.arrItemId)]),
    );
    const records = queue.filter((r) => r.movieId === item.arrItemId);
    return {
      mediaItemId: item.id,
      target: {
        kind: 'radarr',
        movieId: movie.id,
        label: item.title,
        titles: [movie.title, movie.originalTitle ?? '', ...(movie.alternateTitles ?? []).map((a) => a.title)].filter(
          (t) => t.trim() !== '',
        ),
        year: movie.year ?? null,
      },
      hasFile: movie.hasFile,
      monitored: movie.monitored,
      queueState: queueStateOf(records),
      download: downloadOf(records),
    };
  }
  if (item.arrKind !== 'sonarr' || scope !== 'episode' || targetChildId === null) {
    throw new FixRefusedError('needs_guide', 'Every release can be listed for one episode or one movie at a time.');
  }
  const seriesId = item.arrItemId;
  const [episodes, series, queue] = await guardedRead('episode read', () =>
    Promise.all([
      input.arr.read.sonarr.listEpisodes(seriesId),
      input.arr.read.sonarr.getSeriesById(seriesId),
      input.arr.read.sonarr.getQueue(seriesId),
    ]),
  );
  const episode = episodes.find((e) => e.id === targetChildId);
  if (!episode) throw new NotFoundError(`sonarr episode ${targetChildId} not found on live item ${seriesId}`);
  const records = queue.filter((r) => r.episodeId === episode.id);
  return {
    mediaItemId: item.id,
    target: {
      kind: 'sonarr',
      seriesId,
      seriesYear: series.year ?? null,
      episodeId: episode.id,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      label: episodeLabel(episode.seasonNumber, episode.episodeNumber, episode.title),
      seasonEpisodes: episodes
        .filter((e) => e.seasonNumber === episode.seasonNumber)
        .map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title })),
    },
    hasFile: episode.hasFile,
    monitored: episode.monitored,
    queueState: queueStateOf(records),
    download: downloadOf(records),
  };
}

/** The release cache key a target's list lives under (shared with the Fix plan's season and movie previews). */
export function releaseListKey(target: ReleasePickTarget): string {
  return target.kind === 'radarr'
    ? `radarr:movie:${target.movieId}`
    : `sonarr:season:${target.seriesId}:${target.seasonNumber}`;
}

/** Every cache key a grab for the target makes stale (the season list, and the episode list P1's preview reads). */
function staleKeysAfterGrab(target: ReleasePickTarget): string[] {
  return target.kind === 'radarr'
    ? [`radarr:movie:${target.movieId}`]
    : [`sonarr:season:${target.seriesId}:${target.seasonNumber}`, `sonarr:episode:${target.episodeId}`];
}

/**
 * DESIGN-055 D-06 — the target's releases: Sonarr's season list (one search covers every missing episode of the season,
 * and finds a release numbered for another episode whose title is this one's, which an episode search never returns),
 * or Radarr's movie list.
 */
async function readReleases(
  target: ReleasePickTarget,
  arr: Pick<ArrClientBundle, 'read'>,
  who: { requesterId?: string; requesterIsAdmin?: boolean; now?: () => number },
): Promise<{ releases: ArrRelease[]; searchedAt: number }> {
  const read =
    target.kind === 'radarr'
      ? () => guardedRead('release search', () => arr.read.radarr.listMovieReleases(target.movieId))
      : () => guardedRead('release search', () => arr.read.sonarr.listSeasonReleases(target.seriesId, target.seasonNumber));
  const { releases, searchedAt } = await readReleaseListCached({
    key: releaseListKey(target),
    read,
    requesterId: who.requesterId,
    requesterIsAdmin: who.requesterIsAdmin,
    now: who.now,
    throttleMessage: 'You have searched for releases many times in a short while. Give it a little while and try again.',
  });
  return { releases, searchedAt };
}

// ---------------------------------------------------------------------------------------------------------------------
// Opening the list
// ---------------------------------------------------------------------------------------------------------------------

export interface ReleasePickBudget {
  /** null: no limit (an admin). */
  limit: number | null;
  used: number;
  left: number | null;
}

export interface ReleasePickList {
  status: ReleasePickStatus;
  kind: 'sonarr' | 'radarr';
  targetLabel: string;
  /** The Release List's id (the grab sends it back); null when no list was written. */
  listId: string | null;
  searchedAt: string | null;
  rows: ReleasePickRow[];
  recommendedKey: string | null;
  counts: ClassifiedReleases['counts'] | null;
  /** The person's hourly budget after opening the list. A pick needs one more unit (Q-01: "has budget left"). */
  budget: ReleasePickBudget;
  /** Whether a grab or an override can be pressed now (budget left). */
  canPick: boolean;
  /** `on_its_way` / `queue_stuck`: the download in the queue. */
  download: ResolvedTarget['download'];
  reasonsVersion: number;
}

export interface OpenReleaseListInput extends ReleasePickTargetInput {
  arr: ArrClientBundle;
  /**
   * The person opening the list. null is staff working from the in-cluster tool (`repair-guide.ts release-grab`, P5
   * decision 14, the P4 decision 17 pattern): no person, no budget, the same refusals.
   */
  requesterId: string | null;
  requesterIsAdmin?: boolean;
  now?: () => number;
}

async function readBudget(
  db: DbClient | undefined,
  requesterId: string | null,
  requesterIsAdmin: boolean | undefined,
): Promise<ReleasePickBudget> {
  if (requesterIsAdmin || requesterId === null) return { limit: null, used: 0, left: null };
  return inTransaction(db, async (tx) => {
    const [user] = await tx.select({ roleId: users.roleId }).from(users).where(eq(users.id, requesterId));
    if (!user) throw new NotFoundError(`User ${requesterId} not found`);
    const limit = await effectiveMediaActionBudget({ db: tx, roleId: user.roleId });
    const used = await countRecentFixBudget(tx, requesterId);
    return { limit, used, left: limit === null ? null : Math.max(0, limit - used) };
  });
}

const canPickWith = (b: ReleasePickBudget) => b.left === null || b.left > 0;

function emptyList(status: ReleasePickStatus, resolved: ResolvedTarget, budget: ReleasePickBudget): ReleasePickList {
  return {
    status,
    kind: resolved.target.kind,
    targetLabel: resolved.target.label,
    listId: null,
    searchedAt: null,
    rows: [],
    recommendedKey: null,
    counts: null,
    budget,
    canPick: canPickWith(budget),
    download: resolved.download,
    reasonsVersion: RELEASE_REASONS_VERSION,
  };
}

/**
 * DESIGN-055 D-06 — open the Release Pick's list for one missing episode or movie. Behind the `release_pick` remedy.
 * A target with a file, or with a download in the queue, gets no list and costs nothing. Otherwise the list is one unit
 * of the hourly budget: the Release List row and its `release_list_requested` event commit together, under the
 * requester's lock, after the budget check. The same person reopening the same target's list within 5 minutes gets that
 * list again, free. Failed picks on the title are settled first, so a person whose download failed can pick again.
 */
export async function openReleaseList(input: OpenReleaseListInput): Promise<ReleasePickList> {
  const remedies = await getRepairGuideRemedies(input.db);
  if (!remedies.release_pick) {
    throw new FixRefusedError('needs_guide', "Seeing every release is turned off.");
  }
  const resolved = await readReleasePickTarget(input);
  await settleReleasePicks({ db: input.db, mediaItemId: resolved.mediaItemId });
  const budgetBefore = await readBudget(input.db, input.requesterId, input.requesterIsAdmin);
  if (resolved.hasFile) return emptyList('has_file', resolved, budgetBefore);
  if (resolved.queueState !== 'none') return emptyList(resolved.queueState, resolved, budgetBefore);
  // A pick still open on this target (its download just finished and is being added, or failed in a way the *arr has
  // not recorded yet) holds the target: a new list could not be grabbed from, so it is not opened and costs nothing.
  if (await settleTargetLive({ db: input.db, arr: input.arr, resolved })) {
    return emptyList('on_its_way', { ...resolved, download: null }, budgetBefore);
  }

  const db = resolveDb(input.db);
  const now = input.now ? input.now() : Date.now();
  const childId = resolved.target.kind === 'sonarr' ? resolved.target.episodeId : null;
  const [recent] = await db
    .select()
    .from(releasePickLists)
    .where(
      and(
        input.requesterId === null
          ? isNull(releasePickLists.requesterId)
          : eq(releasePickLists.requesterId, input.requesterId),
        eq(releasePickLists.mediaItemId, resolved.mediaItemId),
        childId === null ? isNull(releasePickLists.targetChildId) : eq(releasePickLists.targetChildId, childId),
        gte(releasePickLists.searchedAt, new Date(now - RELEASE_LIST_TTL_MS)),
      ),
    )
    .orderBy(desc(releasePickLists.createdAt))
    .limit(1);
  if (recent && recent.reasonsVersion === RELEASE_REASONS_VERSION && !(await listWasGrabbed(input.db, recent.id))) {
    const rows = recent.rows as unknown as ReleasePickRow[];
    return {
      status: 'list',
      kind: resolved.target.kind,
      targetLabel: resolved.target.label,
      listId: recent.id,
      searchedAt: recent.searchedAt.toISOString(),
      rows,
      recommendedKey: rows.find((r) => r.recommended)?.key ?? null,
      counts: recent.counts as unknown as ClassifiedReleases['counts'],
      budget: budgetBefore,
      canPick: canPickWith(budgetBefore),
      download: null,
      reasonsVersion: RELEASE_REASONS_VERSION,
    };
  }

  // Refuse over the budget BEFORE searching: a search queries every indexer.
  if (budgetBefore.limit !== null && budgetBefore.used >= budgetBefore.limit) {
    throw new FixRateLimitError(mediaActionBudgetReachedMessage(budgetBefore.limit));
  }
  const { releases, searchedAt } = await readReleases(resolved.target, input.arr, {
    requesterId: input.requesterId ?? undefined,
    requesterIsAdmin: input.requesterIsAdmin,
    now: input.now,
  });
  const classified = classifyReleases(releases, resolved.target);

  const listId = await inTransaction(input.db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('fix_requests'), hashtext(${input.requesterId ?? 'staff-tool'}))`,
    );
    if (input.requesterId !== null && !input.requesterIsAdmin) {
      const [user] = await tx.select({ roleId: users.roleId }).from(users).where(eq(users.id, input.requesterId));
      if (!user) throw new NotFoundError(`User ${input.requesterId} not found`);
      const limit = await effectiveMediaActionBudget({ db: tx, roleId: user.roleId });
      if (limit !== null && (await countRecentFixBudget(tx, input.requesterId)) >= limit) {
        throw new FixRateLimitError(mediaActionBudgetReachedMessage(limit));
      }
    }
    const [row] = await tx
      .insert(releasePickLists)
      .values({
        requesterId: input.requesterId,
        mediaItemId: resolved.mediaItemId,
        arrKind: resolved.target.kind,
        targetChildId: childId,
        seasonNumber: resolved.target.kind === 'sonarr' ? resolved.target.seasonNumber : null,
        targetLabel: resolved.target.label,
        searchedAt: new Date(searchedAt),
        reasonsVersion: RELEASE_REASONS_VERSION,
        rows: classified.rows as unknown as Record<string, unknown>[],
        offers: classified.offers as unknown as Record<string, unknown>[],
        counts: classified.counts,
      })
      .returning({ id: releasePickLists.id });
    if (!row) throw new Error('release_pick_lists insert returned no row');
    await tx.insert(ledgerEvents).values({
      mediaItemId: resolved.mediaItemId,
      eventType: 'release_list_requested',
      source: 'app',
      occurredAt: new Date(),
      requestedByUserId: input.requesterId,
      payload: {
        releaseListId: row.id,
        scope: resolved.target.kind === 'radarr' ? 'item' : 'episode',
        targetArrChildId: childId,
        seasonNumber: resolved.target.kind === 'sonarr' ? resolved.target.seasonNumber : null,
        targetLabel: resolved.target.label,
        counts: classified.counts,
      },
    });
    return row.id;
  });
  const budget = await readBudget(input.db, input.requesterId, input.requesterIsAdmin);
  return {
    status: 'list',
    kind: resolved.target.kind,
    targetLabel: resolved.target.label,
    listId,
    searchedAt: new Date(searchedAt).toISOString(),
    rows: classified.rows,
    recommendedKey: classified.recommendedKey,
    counts: classified.counts,
    budget,
    canPick: canPickWith(budget),
    download: null,
    reasonsVersion: RELEASE_REASONS_VERSION,
  };
}

/**
 * The in-cluster tool's read-only preview (`repair-guide.ts release-list`): the same list, never recorded, never
 * charged, never throttled. The live check reads it against the *arr's own interactive search.
 */
export async function previewReleaseList(
  input: ReleasePickTargetInput,
): Promise<Omit<ReleasePickList, 'budget' | 'canPick'> & { offers: number }> {
  const resolved = await readReleasePickTarget(input);
  const base = {
    kind: resolved.target.kind,
    targetLabel: resolved.target.label,
    listId: null,
    download: resolved.download,
    reasonsVersion: RELEASE_REASONS_VERSION,
  };
  if (resolved.hasFile || resolved.queueState !== 'none') {
    const status: ReleasePickStatus = resolved.hasFile
      ? 'has_file'
      : resolved.queueState === 'on_its_way'
        ? 'on_its_way'
        : 'queue_stuck';
    return {
      ...base,
      status,
      searchedAt: null,
      rows: [],
      recommendedKey: null,
      counts: null,
      offers: 0,
    };
  }
  const { releases, searchedAt } = await readReleases(resolved.target, input.arr, {});
  const classified = classifyReleases(releases, resolved.target);
  return {
    ...base,
    status: 'list',
    searchedAt: new Date(searchedAt).toISOString(),
    rows: classified.rows,
    recommendedKey: classified.recommendedKey,
    counts: classified.counts,
    offers: classified.offers.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The grab
// ---------------------------------------------------------------------------------------------------------------------

export type ReleaseGrabOutcome =
  /** The *arr took the grab; the live chip follows it. */
  | 'grabbed'
  /** The list is older than the *arr's release cache allows: open it again. Nothing was sent. */
  | 'list_stale'
  /** The site would not hand the release over (or the *arr refused it): the person can pick another. */
  | 'grab_failed'
  /**
   * The grab got no clear answer (a timeout, a dropped connection, a 5xx): it may have reached the download client. The
   * pick stays open, the live chip shows what happened, and the *arr's history settles it.
   */
  | 'unsure'
  /** The target got a file since the list was read. Nothing was sent. */
  | 'has_file'
  /** A download for the target appeared in the queue since. Nothing was sent. */
  | 'on_its_way'
  /** The row is not one the person may pick (or no longer exists). Nothing was sent. */
  | 'not_allowed';

export interface ReleaseGrabResult {
  outcome: ReleaseGrabOutcome;
  /** Plain words for the guide. */
  message: string;
  repairRequestId: string | null;
  targetLabel: string;
  /** Whether the grab was an override (a release the profile rejected). */
  override: boolean;
}

export interface GrabFromReleaseListInput {
  db?: DbClient;
  arr: ArrClientBundle;
  listId: string;
  key: string;
  /** The person who opened the list (null: staff's in-cluster tool, whose list has no requester either). */
  requesterId: string | null;
  requesterIsAdmin?: boolean;
  now?: () => number;
}

const GRAB_COPY: Record<Exclude<ReleaseGrabOutcome, 'grabbed' | 'unsure'>, string> = {
  list_stale: 'This list is out of date. Search again to see what is there now.',
  grab_failed: "That release couldn't be fetched from the site it was found on. Pick another one.",
  has_file: 'This one has a file now, so nothing was grabbed.',
  on_its_way: 'Something for this is already downloading, so nothing was grabbed.',
  not_allowed: "That release can't be picked. Choose another one, or ask staff.",
};

/**
 * DESIGN-055 D-06 — grab the row the person chose from their own Release List. Refuses (nothing sent) a list past the
 * grab window, a row that is not a Grab or an Override, a target that has a file now or a download in the queue. Then
 * one `release_pick` Repair Request (its budget unit, the one open repair per episode or movie) BEFORE the write, then
 * `POST /release` with the body the *arr's own UI sends: the plain body for a row the *arr approved and mapped onto the
 * target, the override body (this series and episode, or this movie, at the row's own quality and languages) for every
 * other row. A grab the *arr or the site refuses closes the Repair Request as failed and leaves the list open.
 */
export async function grabFromReleaseList(input: GrabFromReleaseListInput): Promise<ReleaseGrabResult> {
  const db = resolveDb(input.db);
  const [list] = await db.select().from(releasePickLists).where(eq(releasePickLists.id, input.listId));
  if (!list || list.requesterId !== input.requesterId) throw new NotFoundError(`Release list ${input.listId} not found`);
  const remedies = await getRepairGuideRemedies(input.db);
  if (!remedies.release_pick) {
    throw new FixRefusedError('needs_guide', "Seeing every release is turned off.");
  }
  const refuse = (outcome: Exclude<ReleaseGrabOutcome, 'grabbed' | 'unsure'>): ReleaseGrabResult => ({
    outcome,
    message: GRAB_COPY[outcome],
    repairRequestId: null,
    targetLabel: list.targetLabel,
    override: false,
  });
  const now = input.now ? input.now() : Date.now();
  if (now - list.searchedAt.getTime() > RELEASE_PICK_GRAB_WINDOW_MS) return refuse('list_stale');
  // A list written under older rules is neither shown again nor grabbed from (P5 decision 15).
  if (list.reasonsVersion !== RELEASE_REASONS_VERSION) return refuse('list_stale');
  // A list a grab already went out from is spent: what it offered may since have failed and been blocklisted. A grab
  // the site refused (nothing sent to the download client) leaves it usable, so another site can be tried.
  if (await listWasGrabbed(input.db, list.id)) return refuse('list_stale');
  const offers = list.offers as unknown as ReleasePickOffer[];
  const offer = offers.find((o) => o.key === input.key);
  if (!offer) return refuse('not_allowed');

  const resolved = await readReleasePickTarget({
    db: input.db,
    arr: input.arr,
    mediaItemId: list.mediaItemId,
    scope: list.arrKind === 'radarr' ? 'item' : 'episode',
    targetChildId: list.targetChildId ?? undefined,
  });
  if (resolved.hasFile) return refuse('has_file');
  if (resolved.queueState !== 'none') return refuse('on_its_way');
  await settleReleasePicks({ db: input.db, mediaItemId: resolved.mediaItemId });
  if (await settleTargetLive({ db: input.db, arr: input.arr, resolved })) return refuse('on_its_way');

  const target = resolved.target;
  const override = offer.state === 'override';
  const { repairRequestId } = await createRepairRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: resolved.mediaItemId,
    kind: 'release_pick',
    scope: target.kind === 'radarr' ? 'item' : 'episode',
    seasonNumber: target.kind === 'radarr' ? null : target.seasonNumber,
    targetChildIds: target.kind === 'radarr' ? [] : [target.episodeId],
    targetLabel: target.label,
    reason: null,
    preview: {
      releaseListId: list.id,
      key: offer.key,
      title: offer.title,
      state: offer.state,
      reasons: offer.reasonCodes,
      titleVerdict: offer.titleVerdict,
      numberedAs: offer.numberedAs,
      overrideBody: offer.overrideBody,
      searchedAt: list.searchedAt.toISOString(),
      reasonsVersion: list.reasonsVersion,
    },
  });

  const at = () => new Date().toISOString();
  try {
    if (target.kind === 'radarr') {
      await input.arr.write.radarr.grabRelease(
        offer.overrideBody
          ? {
              indexerId: offer.indexerId,
              guid: offer.guid,
              movieId: target.movieId,
              quality: offer.quality ?? {},
              languages: offer.languages,
              downloadClientId: null,
              shouldOverride: true,
            }
          : { guid: offer.guid, indexerId: offer.indexerId },
      );
    } else {
      await input.arr.write.sonarr.grabRelease(
        offer.overrideBody
          ? {
              guid: offer.guid,
              indexerId: offer.indexerId,
              seriesId: target.seriesId,
              episodeIds: [target.episodeId],
              quality: offer.quality ?? {},
              languages: offer.languages,
              downloadClientId: null,
              shouldOverride: true,
            }
          : { guid: offer.guid, indexerId: offer.indexerId },
      );
    }
  } catch (err) {
    const status = err instanceof ArrHttpError ? err.status : null;
    forgetReleaseLists(staleKeysAfterGrab(target));
    // A 4xx answer means the *arr refused the grab and sent nothing on: 404 its own cache dropped the row, 409 the site
    // would not hand the file over, any other 4xx the *arr refused the request.
    if (err instanceof ArrHttpError && status !== null && status >= 400 && status < 500) {
      await recordRepairTransition({
        db: input.db,
        repairRequestId,
        transition: 'failed',
        actions: [{ step: 'grab', at: at(), ok: false, title: offer.title, status, error: errText(err) }],
      });
      return { ...refuse(status === 404 ? 'list_stale' : 'grab_failed'), repairRequestId };
    }
    if (err instanceof ArrError) {
      // A timeout, a dropped connection or a 5xx may come after the *arr already handed the release to the download
      // client. The pick stays open and the list spent, so nothing is grabbed twice; the *arr's history settles it
      // (settleTargetLive): a grab it records follows as usual, and none recorded within UNSURE_GRAB_SETTLE_MS closes it.
      consoleDomainLogger.warn('release pick: the grab got no clear answer; the pick stays open until the history settles it', {
        repairRequestId,
        mediaItemId: resolved.mediaItemId,
        status,
        error: errText(err),
      });
      await recordRepairTransition({
        db: input.db,
        repairRequestId,
        transition: 'actioned',
        actions: [{ step: 'grab', at: at(), ok: false, uncertain: true, title: offer.title, status, error: errText(err) }],
      });
      return {
        outcome: 'unsure',
        message: "It isn't certain the grab went through: the answer got lost on the way.",
        repairRequestId,
        targetLabel: target.label,
        override,
      };
    }
    await recordRepairTransition({
      db: input.db,
      repairRequestId,
      transition: 'failed',
      actions: [{ step: 'grab', at: at(), ok: false, title: offer.title, status, error: errText(err) }],
    });
    throw err;
  }
  await recordRepairTransition({
    db: input.db,
    repairRequestId,
    transition: 'actioned',
    actions: [
      {
        step: 'grab',
        at: at(),
        ok: true,
        title: offer.title,
        override: offer.overrideBody,
        state: offer.state,
      },
    ],
  });
  forgetReleaseLists(staleKeysAfterGrab(target));
  return {
    outcome: 'grabbed',
    message: override ? "Grabbed it, past the library's usual rules." : 'Grabbed it.',
    repairRequestId,
    targetLabel: target.label,
    override,
  };
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A grab's record in the *arr's history counts from a little before its Repair Request (clocks drift). */
const HISTORY_SLACK_MS = 2 * 60_000;

/** A grab with no clear answer that the *arr's history still does not record after this long never reached it. */
export const UNSURE_GRAB_SETTLE_MS = 10 * 60_000;

/**
 * DESIGN-055 D-06 (P5 decision 11) — settle the open picks on one target from the *arr's own history, without waiting
 * for the sync to ingest it: with nothing in the queue for the target, a pick whose grab (its release title, after the
 * pick) has a `downloadFailed` or `downloadIgnored` record for the same download closes as `failed`, so the person can
 * pick another at once. Returns whether a pick (or an import) is still open on the target afterwards. One history read,
 * only when a pick is open.
 */
async function settleTargetLive(input: {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  resolved: ResolvedTarget;
}): Promise<boolean> {
  const db = resolveDb(input.db);
  const { target } = input.resolved;
  const childId = target.kind === 'sonarr' ? target.episodeId : null;
  const open = await db
    .select({
      id: repairRequests.id,
      kind: repairRequests.kind,
      createdAt: repairRequests.createdAt,
      targetChildIds: repairRequests.targetChildIds,
      preview: repairRequests.preview,
      actionsTaken: repairRequests.actionsTaken,
    })
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.mediaItemId, input.resolved.mediaItemId),
        inArray(repairRequests.kind, ['release_pick', 'import_download']),
        inArray(repairRequests.status, ['pending', 'actioned']),
      ),
    );
  const mine = open.filter((r) => childId === null || r.targetChildIds.includes(childId));
  if (mine.length === 0) return false;
  const picks = mine.filter((r) => r.kind === 'release_pick');
  let stillOpen = mine.length - picks.length;
  if (picks.length === 0) return stillOpen > 0;
  let history: Array<{ eventType: string; date: string | null; sourceTitle: string | null; downloadId: string | null; episodeId: number | null }>;
  try {
    history =
      target.kind === 'radarr'
        ? await input.arr.read.radarr.getMovieReleaseHistory(target.movieId)
        : await input.arr.read.sonarr.getSeriesReleaseHistory(target.seriesId);
  } catch (err) {
    consoleDomainLogger.warn('release pick: the *arr history could not be read; the open pick holds the target', {
      mediaItemId: input.resolved.mediaItemId,
      error: errText(err),
    });
    return true; // the pick stays open, as the sync would leave it
  }
  for (const pick of picks) {
    const title = typeof pick.preview.title === 'string' ? pick.preview.title : null;
    const since = pick.createdAt.getTime() - HISTORY_SLACK_MS;
    const forTarget = history.filter(
      (h) => (childId === null || h.episodeId === childId) && h.date !== null && Date.parse(h.date) >= since,
    );
    const downloads = new Set(
      forTarget
        .filter((h) => /^grabbed$/i.test(h.eventType) && h.sourceTitle === title && h.downloadId)
        .map((h) => h.downloadId as string),
    );
    const unsure = pick.actionsTaken.some((a) => a.step === 'grab' && a.uncertain === true);
    const neverArrived =
      unsure && downloads.size === 0 && Date.now() - pick.createdAt.getTime() > UNSURE_GRAB_SETTLE_MS;
    const failed =
      neverArrived ||
      forTarget.some(
        (h) => /^download(failed|ignored)$/i.test(h.eventType) && h.downloadId !== null && downloads.has(h.downloadId),
      );
    if (!failed) {
      stillOpen += 1;
      continue;
    }
    try {
      await recordRepairTransition({
        db: input.db,
        repairRequestId: pick.id,
        transition: 'failed',
        actions: [
          neverArrived
            ? { step: 'grab_not_recorded', at: new Date().toISOString(), ok: false, note: "the *arr's history records no grab" }
            : { step: 'download_failed', at: new Date().toISOString(), ok: false, note: "the download failed (the *arr's history)" },
        ],
      });
    } catch (err) {
      // Closed by another writer meanwhile (an import completed it, or a timeout).
      consoleDomainLogger.warn('release pick: settling a failed pick found it already closed', { repairRequestId: pick.id, error: errText(err) });
    }
  }
  return stillOpen > 0;
}

/** Whether a grab from this Release List may have reached the *arr (a `grab` step that succeeded, or had no clear answer). */
async function listWasGrabbed(db: DbClient | undefined, listId: string): Promise<boolean> {
  const [hit] = await resolveDb(db)
    .select({ id: repairRequests.id })
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.kind, 'release_pick'),
        sql`${repairRequests.preview}->>'releaseListId' = ${listId}`,
        sql`(${repairRequests.actionsTaken} @> ${JSON.stringify([{ step: 'grab', ok: true }])}::jsonb OR ${repairRequests.actionsTaken} @> ${JSON.stringify([{ step: 'grab', uncertain: true }])}::jsonb)`,
      ),
    )
    .limit(1);
  return hit !== undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Settling a pick whose download failed
// ---------------------------------------------------------------------------------------------------------------------

/**
 * DESIGN-055 D-02, D-06 — completion is read: an open `release_pick` whose target recorded a `download_failed` since the
 * pick, and no import, closes as `failed` (with its `repair_failed` event), which frees the episode or movie for another
 * pick. Imports complete it through completeRepairRequests. Runs in the sync post-steps and before every list and grab.
 */
export async function settleReleasePicks(input: { db?: DbClient; mediaItemId?: string } = {}): Promise<{ failed: string[] }> {
  const db = resolveDb(input.db);
  const open = await db
    .select({
      id: repairRequests.id,
      mediaItemId: repairRequests.mediaItemId,
      targetChildIds: repairRequests.targetChildIds,
      createdAt: repairRequests.createdAt,
    })
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.kind, 'release_pick'),
        inArray(repairRequests.status, ['pending', 'actioned']),
        ...(input.mediaItemId ? [eq(repairRequests.mediaItemId, input.mediaItemId)] : []),
      ),
    );
  const failed: string[] = [];
  for (const r of open) {
    const child = r.targetChildIds[0] ?? null;
    const childMatch = child === null ? sql`true` : sql`${ledgerEvents.payload}->>'episodeId' = ${String(child)}`;
    const events = await db
      .select({ eventType: ledgerEvents.eventType })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.mediaItemId, r.mediaItemId),
          inArray(ledgerEvents.eventType, ['download_failed', 'imported']),
          sql`${ledgerEvents.occurredAt} >= ${r.createdAt.toISOString()}::timestamptz`,
          childMatch,
        ),
      );
    const types = new Set(events.map((e) => e.eventType));
    if (!types.has('download_failed') || types.has('imported')) continue;
    try {
      await recordRepairTransition({
        db: input.db,
        repairRequestId: r.id,
        transition: 'failed',
        actions: [{ step: 'download_failed', at: new Date().toISOString(), ok: false, note: 'the download failed' }],
      });
      failed.push(r.id);
    } catch {
      // Closed by another writer meanwhile (an import completed it, or a timeout): nothing to settle.
    }
  }
  return { failed };
}

/** DESIGN-055 D-06 — the Release Lists are kept a week (what each person was offered), then pruned by the sync. */
export const RELEASE_LIST_KEEP_MS = 7 * 24 * 3_600_000;

/** Prune Release Lists older than RELEASE_LIST_KEEP_MS (the single writer's housekeeping). */
export async function pruneReleaseLists(input: { db?: DbClient; asOf?: Date } = {}): Promise<{ pruned: number }> {
  const db = resolveDb(input.db);
  const before = new Date((input.asOf ?? new Date()).getTime() - RELEASE_LIST_KEEP_MS);
  const deleted = await db
    .delete(releasePickLists)
    .where(sql`${releasePickLists.createdAt} < ${before.toISOString()}::timestamptz`)
    .returning({ id: releasePickLists.id });
  return { pruned: deleted.length };
}
