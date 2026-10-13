// ADR-109 C-02 / DESIGN-055 D-08 rule 4 (PLAN-077 P6) — the Language Replace: a Wrong language Fix on one episode or a
// movie whose file lacks the wanted audio replaces the file with a release in that language, instead of today's blind
// blocklist and search. READ-ONLY here: this is the plan (the preview), computed again just before acting
// (fix-flow.ts runGuardedFix), so a plan that changed since the person confirmed is refused rather than run.
//
// The plan: the file goes (deleted, after the person ticks it), the download it came from is blocked so it is never taken
// again (unless it is a pack that also holds other episodes on disk: the season guard), and the replacement is the first
// release, in the *arr's own decision order, that
//   - the *arr would take once the file is gone (approved, or rejected only for the existing file, T-315),
//   - the *arr parsed as carrying the wanted language (its `languages`),
//   - is mapped onto this episode or movie alone (no pack: a pack would replace other episodes' files too),
//   - passes the Release Pick's hard refusals (a camera copy, an oversized file, another movie's or another episode's
//     name; DESIGN-055 D-06, P5 decision 15), and
//   - is not the Same Release as the file (T-308).
// With no such release nothing is removed (`no_language_release`): deleting would leave the person with nothing in
// their language, the harm P1's "nothing to replace it" refusal guards against. The season scope has no Language
// Replace: each episode whose file lacks the language is fixed on its own (P6 decision 7).
import { mediaItems } from '@hnet/db';
import type { ArrRelease } from '@hnet/arr';
import { eq } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { FixRefusedError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { assertFixAllowed } from './fix-requests';
import { guardArrCall, listMediaChildren } from './media-children';
import { resolveFixTarget } from './action-scope';
import {
  fileIdentity,
  planDigest,
  planFile,
  planRelease,
  readReleaseListCached,
  previewFix,
  type FileRecord,
  type FixPlan,
  type PlanEpisode,
  type PlanFile,
  type PlanFixInput,
  type PlanGrab,
  type PlanRelease,
} from './fix-plan';
import {
  audioLanguageName,
  canonicalLanguageCode,
  latestGrabsByEpisode,
  packCost,
  releaseHasLanguage,
  sameReleaseBasis,
  wouldTakeWithoutFile,
  type CurrentFileIdentity,
} from './fix-guards';
import { languageVerdict, readFileAudio } from './language-check';
import { classifyReleases, readReleasePickTarget, releaseKey, releaseListKey, type ReleasePickTarget } from './release-pick';
import type { RepairGuideRemedies } from './repair-guide-settings';

/** The replacement release as the guide shows it, with the languages the *arr parsed from its name. */
export interface LanguageCandidate extends PlanRelease {
  languages: string[];
}

export interface LanguagePlan {
  kind: 'language';
  scope: 'item' | 'episode';
  targetLabel: string | null;
  wanted: { code: string; name: string };
  /** The file the Fix deletes. */
  file: PlanFile | null;
  /** The download the file came from, blocked so it is not taken again; null when there is none, or it is a kept pack. */
  grab: PlanGrab | null;
  /** The file came in a pack that also holds these on-disk episodes: the pack is not blocked, only this file goes. */
  packKept: PlanEpisode[];
  /** The release that replaces the file, or null (`no_language_release`). */
  candidate: LanguageCandidate | null;
  /** The candidate's opaque key (a hash of its indexer and guid; the guid never leaves the server). */
  candidateKey: string | null;
  verdict: 'ok' | 'no_language_release';
  /** How many releases name the wanted language at all, in any state (the guide says when only staff could pick one). */
  languageReleases: number;
  digest: string;
}

/** The Language Replace applies: a Wrong language Fix with a wanted language and both of its remedies on. */
export function languagePlanApplies(input: {
  reason?: string;
  wantedLanguage?: string;
  remedies: Pick<RepairGuideRemedies, 'language_check' | 'language_search'>;
}): boolean {
  return (
    (input.reason === undefined || input.reason === 'wrong_language') &&
    typeof input.wantedLanguage === 'string' &&
    input.wantedLanguage.trim() !== '' &&
    input.remedies.language_check &&
    input.remedies.language_search
  );
}

/**
 * D-08 rule 4, pure: the replacement in the wanted language, in the *arr's order. `allowed` holds the keys of the
 * Release Pick rows with no hard refusal (a row the classification dropped, or one with a hard reason, is never taken).
 */
export function pickLanguageRelease(input: {
  releases: readonly ArrRelease[];
  allowed: ReadonlySet<string>;
  wanted: string;
  current: CurrentFileIdentity | null;
  /** Sonarr: the release holds exactly this one episode. */
  single?: (release: ArrRelease) => boolean;
}): ArrRelease | null {
  for (const release of input.releases) {
    if (!input.allowed.has(releaseKey(release))) continue;
    if (input.single && !input.single(release)) continue;
    if (!release.downloadAllowed || release.indexerId === null) continue;
    if (!wouldTakeWithoutFile(release)) continue;
    if (!releaseHasLanguage(release, input.wanted)) continue;
    if (input.current && sameReleaseBasis(input.current, release) !== null) continue;
    return release;
  }
  return null;
}

/** The plan and, for the run only, the candidate's own release (with its guid). Never sent to a client. */
export interface LanguagePlanRead {
  plan: LanguagePlan;
  release: ArrRelease | null;
  /** The release cache key the list lives under (forgotten after a grab). */
  listKey: string;
}

export interface PlanLanguageInput extends PlanFixInput {
  wantedLanguage: string;
}

/** Throws the guide's refusals: the language is in the file, or the scope is a season. */
async function refuseByAudio(input: PlanLanguageInput, kind: 'sonarr' | 'radarr', wanted: string): Promise<void> {
  const resolved = resolveFixTarget(kind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });
  const audio = await readFileAudio({
    db: input.db,
    arr: input.arr,
    mediaItemId: input.mediaItemId,
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });
  if (languageVerdict(audio, wanted) === 'present') {
    throw new FixRefusedError(
      'language_present',
      `${audioLanguageName(wanted)} audio is already in this file, so nothing was removed. Pick that track in Plex instead.`,
    );
  }
  if (resolved.scope === 'season') {
    const lacking = audio.files.filter((f) => !f.codes.includes(wanted)).map((f) => f.label ?? 'one episode');
    throw new FixRefusedError(
      'language_by_episode',
      lacking.length > 0
        ? `${lacking.join(', ')} ${lacking.length === 1 ? 'has' : 'have'} no ${audioLanguageName(wanted)} audio. Fix ${lacking.length === 1 ? 'that episode' : 'each of those episodes'} on its own, so each one gets a release in ${audioLanguageName(wanted)}.`
        : `Fix the episodes one at a time, so each one gets a release in ${audioLanguageName(wanted)}.`,
    );
  }
}

/**
 * Read the Language Replace plan for one episode or one movie. Throws like the Fix (NotFound, tombstoned), the guide's
 * refusals (`language_present`, `language_by_episode`), and ArrUpstreamError when a read fails (a plan that cannot be
 * read never deletes).
 */
export async function readLanguagePlan(input: PlanLanguageInput): Promise<LanguagePlanRead> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId, deletedFromArrAt: mediaItems.deletedFromArrAt })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to fix in the *arr`);
  }
  if (item.arrKind !== 'sonarr' && item.arrKind !== 'radarr') {
    throw new FixRefusedError('language_by_episode', 'A language replacement covers shows and movies only.');
  }
  const wanted = canonicalLanguageCode(input.wantedLanguage);
  await refuseByAudio(input, item.arrKind, wanted);

  const resolved = await readReleasePickTarget({
    db: input.db,
    arr: input.arr,
    mediaItemId: item.id,
    scope: input.scope,
    targetChildId: input.targetChildId,
  });
  const target: ReleasePickTarget = resolved.target;

  let file: FileRecord | null = null;
  let grab: PlanGrab | null = null;
  let packKept: PlanEpisode[] = [];
  let current: CurrentFileIdentity | null = null;
  if (target.kind === 'sonarr') {
    const sonarr = input.arr.read.sonarr;
    const [children, history] = await Promise.all([
      listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: item.id }),
      guardArrCall(`sonarr GET /history/series?seriesId=${target.seriesId}`, () => sonarr.getSeriesReleaseHistory(target.seriesId)),
    ]);
    const child = children.find((c) => c.arrChildId === target.episodeId);
    if (child?.episodeFileId) {
      const files = await guardArrCall(`sonarr GET /episodefile?seriesId=${target.seriesId}`, () =>
        sonarr.listEpisodeFileReleases(target.seriesId),
      );
      file = files.find((f) => f.id === child.episodeFileId) ?? null;
    }
    const latest = latestGrabsByEpisode(history);
    const onDisk = children.filter((c) => c.hasFile).map((c) => c.arrChildId);
    const last = latest.get(target.episodeId);
    const cost = packCost(latest, onDisk, target.episodeId);
    if (last && cost.length === 0) {
      grab = { grabId: last.grabId, sourceTitle: last.sourceTitle, releaseSource: last.releaseSource };
    } else if (last) {
      packKept = cost.map((id) => ({ episodeId: id, label: children.find((c) => c.arrChildId === id)?.label ?? `Episode ${id}` }));
    }
    if (file) current = fileIdentity(file, history);
  } else {
    const radarr = input.arr.read.radarr;
    const [grabs, files, history] = await Promise.all([
      guardArrCall(`radarr GET /history/movie?movieId=${target.movieId}&eventType=grabbed`, () => radarr.getMovieGrabHistory(target.movieId)),
      guardArrCall(`radarr GET /moviefile?movieId=${target.movieId}`, () => radarr.listMovieFiles(target.movieId)),
      guardArrCall(`radarr GET /history/movie?movieId=${target.movieId}`, () => radarr.getMovieReleaseHistory(target.movieId)),
    ]);
    const newest = grabs.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
    if (newest) {
      grab = {
        grabId: newest.id,
        sourceTitle: newest.sourceTitle ?? null,
        releaseSource: typeof newest.data?.releaseSource === 'string' ? newest.data.releaseSource : null,
      };
    }
    file = files[0] ?? null;
    if (file) current = fileIdentity(file, history);
  }

  const read =
    target.kind === 'radarr'
      ? () => guardArrCall(`radarr GET /release?movieId=${target.movieId}`, () => input.arr.read.radarr.listMovieReleases(target.movieId))
      : () =>
          guardArrCall(`sonarr GET /release?seriesId=${target.seriesId}&seasonNumber=${target.seasonNumber}`, () =>
            input.arr.read.sonarr.listSeasonReleases(target.seriesId, target.seasonNumber),
          );
  const { releases } = await readReleaseListCached({
    key: releaseListKey(target),
    read,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    now: input.now,
  });
  const classified = classifyReleases(releases, target);
  const allowed = new Set<string>();
  for (const row of classified.rows) {
    if (row.reasons.some((r) => r.class === 'hard')) continue;
    for (const key of row.keys) allowed.add(key);
  }
  const single =
    target.kind === 'sonarr'
      ? (r: ArrRelease) =>
          !r.fullSeason &&
          r.seasonNumber === target.seasonNumber &&
          r.episodeNumbers.length === 1 &&
          r.episodeNumbers[0] === target.episodeNumber
      : undefined;
  const release = pickLanguageRelease({ releases, allowed, wanted, current, single });
  const languageReleases = releases.filter(
    (r) =>
      releaseHasLanguage(r, wanted) &&
      (target.kind === 'radarr' ||
        (r.seasonNumber === target.seasonNumber && (r.fullSeason || r.episodeNumbers.includes(target.episodeNumber)))),
  ).length;

  const candidateKey = release ? releaseKey(release) : null;
  const plan: LanguagePlan = {
    kind: 'language',
    scope: target.kind === 'radarr' ? 'item' : 'episode',
    targetLabel: target.kind === 'radarr' ? null : target.label,
    wanted: { code: wanted, name: audioLanguageName(wanted) },
    file: file ? planFile(file) : null,
    grab,
    packKept,
    candidate: release ? { ...planRelease(release), languages: release.languages } : null,
    candidateKey,
    verdict: release ? 'ok' : 'no_language_release',
    languageReleases,
    digest: planDigest({
      kind: 'language',
      wanted,
      fileId: file?.id ?? null,
      grabId: grab?.grabId ?? null,
      candidateKey,
    }),
  };
  return { plan, release, listKey: releaseListKey(target) };
}

/**
 * DESIGN-055 D-01, D-08, D-09 — the guide's preview (`fix.preview`): the Language Replace for a Wrong language Fix with a
 * wanted language while its remedies are on (after the same early refusals as previewFix: the budget, an open Fix),
 * else the guarded Fix's own plan.
 */
export async function previewRepairPlan(
  input: Omit<PlanFixInput, 'requesterId'> & { requesterId: string; wantedLanguage?: string },
): Promise<FixPlan | null> {
  if (!languagePlanApplies({ wantedLanguage: input.wantedLanguage, remedies: input.remedies })) return previewFix(input);
  const db = resolveDb(input.db);
  const [item] = await db.select({ id: mediaItems.id, arrKind: mediaItems.arrKind }).from(mediaItems).where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.arrKind !== 'sonarr' && item.arrKind !== 'radarr') return previewFix(input);
  const resolved = resolveFixTarget(item.arrKind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });
  await assertFixAllowed({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: item.id,
    scope: resolved.scope,
    targetArrChildId: resolved.targetChildId,
    seasonNumber: resolved.seasonNumber,
  });
  return (await readLanguagePlan({ ...input, wantedLanguage: input.wantedLanguage! })).plan;
}
