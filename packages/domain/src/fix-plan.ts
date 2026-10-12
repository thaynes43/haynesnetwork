// ADR-109 C-03 / DESIGN-055 D-09 (PLAN-077 P1) — the Fix plan: what a guarded Fix will do, read from the live *arr and
// decided by the pure guards (fix-guards.ts). READ-ONLY: it never writes. The Repair Guide shows it as the preview
// (`fix.preview`), and runFixRequest computes it again just before acting, so the guards hold even for a caller that
// skipped the preview, and a plan that changed since the preview is refused rather than run (the digest).
//
// The plan covers Sonarr and Radarr only (ADR-109 C-11: Lidarr keeps today's Fix). It applies the remedies that are on:
// `replacement_preview` reads the release list before any delete; `season_guard` holds back packs and shows an
// episode Fix's pack cost. With both off there is no plan, and Fix runs exactly as before.
import { createHash } from 'node:crypto';
import { mediaItems, type DbClient } from '@hnet/db';
import { eq } from 'drizzle-orm';
import type { ArrRelease, ArrReleaseHistoryRecord } from '@hnet/arr';
import { FixRateLimitError, FixTargetRequiredError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { assertFixAllowed } from './fix-requests';
import { resolveDb } from './db-client';
import type { ArrClientBundle } from './arr-clients';
import { guardArrCall, listMediaChildren, type MediaChildTarget } from './media-children';
import { resolveFixTarget, type SearchScope } from './action-scope';
import {
  checkReplacement,
  latestGrabsByEpisode,
  packCost,
  releaseCoversEpisode,
  splitSeasonByDownload,
  type CurrentFileIdentity,
  type EpisodeGrab,
  type ReplacementVerdict,
  type SameReleaseBasis,
} from './fix-guards';
import type { RepairGuideRemedies } from './repair-guide-settings';

/** One episode, as the guide names it. */
export interface PlanEpisode {
  episodeId: number;
  label: string;
}

/** The file on disk, as the preview shows it. */
export interface PlanFile {
  fileId: number;
  name: string | null;
  releaseGroup: string | null;
  qualityName: string | null;
  size: number | null;
}

/** The release the *arr would take next, as the preview shows it (no URL, no guid). */
export interface PlanRelease {
  title: string;
  releaseGroup: string | null;
  qualityName: string | null;
  size: number | null;
  protocol: string | null;
  indexer: string | null;
  customFormatScore: number | null;
  fullSeason: boolean;
}

/** The Replacement Preview for one file. `unchecked` when the remedy is off, or when there is no file to delete. */
export interface PlanReplacement {
  verdict: ReplacementVerdict | 'unchecked';
  candidate: PlanRelease | null;
  basis: SameReleaseBasis | null;
}

/** The grab a blocklist path marks failed. */
export interface PlanGrab {
  grabId: number;
  sourceTitle: string | null;
  releaseSource: string | null;
}

export interface BlocklistPlan {
  kind: 'blocklist';
  scope: 'item' | 'episode';
  targetLabel: string | null;
  grab: PlanGrab;
  /** Season guard: the other on-disk episodes this download also backs; blocking it costs them too. */
  packCost: PlanEpisode[];
  digest: string;
}

export interface DeletePlan {
  kind: 'delete';
  scope: 'item' | 'episode';
  targetLabel: string | null;
  /** The file the Fix deletes; null when nothing is on disk (the Fix only searches). */
  file: PlanFile | null;
  replacement: PlanReplacement;
  /** The person chose to replace just this episode instead of blocking its pack (season guard). */
  insteadOfPack: boolean;
  /** Season guard: the other on-disk episodes the episode's pack backs (what blocking it instead would cost). */
  packCost: PlanEpisode[];
  digest: string;
}

export interface SeasonMark extends PlanGrab {
  downloadKey: string;
  /** The on-disk episodes this download backs (all chosen). */
  episodes: PlanEpisode[];
  /**
   * Every episode with a grab record of this download, on disk or not: what the *arr's own Redownload Failed searches
   * after the mark (DESIGN-005 D-25), so the Fix does not search them a second time.
   */
  grabbedEpisodeIds: number[];
}

export interface SeasonDelete {
  episode: PlanEpisode;
  file: PlanFile;
  replacement: PlanReplacement;
}

export interface SeasonPlan {
  kind: 'season';
  seasonNumber: number;
  targetLabel: string;
  /** `blocklist` when any chosen episode has a download record; otherwise the guarded delete path. */
  mode: 'blocklist' | 'delete';
  /** The chosen episodes (every on-disk episode when the season guard is off or none were named). */
  chosen: PlanEpisode[];
  /** Downloads to mark failed: every on-disk episode they back was chosen. */
  marks: SeasonMark[];
  /** Packs left alone: they also back on-disk episodes the person marked fine. */
  heldBack: Array<{ sourceTitle: string | null; chosen: PlanEpisode[]; others: PlanEpisode[] }>;
  /** Chosen episodes with no download record while others have one: left for an episode Fix. */
  noRecord: PlanEpisode[];
  /** Delete mode: the files the Fix deletes (each passed its Replacement Preview). */
  deletes: SeasonDelete[];
  /** Delete mode: the files left alone, with the preview that refused them. */
  refused: SeasonDelete[];
  /** The episodes the Fix searches after acting (before the D-25 Redownload Failed check). */
  searchEpisodeIds: number[];
  /** Every on-disk episode of the season was chosen: the search is today's SeasonSearch. */
  wholeSeason: boolean;
  /** Whether the plan does anything at all. */
  actionable: boolean;
  digest: string;
}

export type FixPlan = BlocklistPlan | DeletePlan | SeasonPlan;

export interface PlanFixInput {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  mediaItemId: string;
  scope?: SearchScope;
  targetChildId?: number;
  seasonNumber?: number;
  /** Season guard: the episodes the person marked wrong (absent ⇒ every on-disk episode). */
  episodeIds?: number[];
  /** Season guard: replace just this episode's file instead of blocking the pack that holds it. */
  replaceFile?: boolean;
  remedies: RepairGuideRemedies;
  /**
   * Who asked, for the release-search throttle (RELEASE_SEARCHES_PER_HOUR). Absent (the in-cluster tool) or an admin:
   * not throttled.
   */
  requesterId?: string;
  requesterIsAdmin?: boolean;
  /** Test clock for the release cache and throttle. */
  now?: () => number;
}

/**
 * DESIGN-055 D-09 — a release list is reused for this long, so a preview and the confirm's re-plan (and a person going
 * back and forth in the guide) cost one search of the indexers, not several.
 */
export const RELEASE_LIST_TTL_MS = 5 * 60_000;

/**
 * DESIGN-055 D-09 — a member's live release searches per hour (each one queries every indexer, whose API hits are
 * capped). A cached list costs nothing; admins and the in-cluster tool are not throttled. Kept per web pod, in memory.
 */
export const RELEASE_SEARCHES_PER_HOUR = 12;

const RELEASE_CACHE_MAX = 200;
const releaseCache = new Map<string, { at: number; releases: ArrRelease[] }>();
const searchesByRequester = new Map<string, number[]>();

/** Tests: forget every cached release list and every counted search. */
export function resetReleaseSearchState(): void {
  releaseCache.clear();
  searchesByRequester.clear();
}

/** One release list, from the cache when fresh, else a live search (throttled per member). */
async function releasesFor(
  input: PlanFixInput,
  key: string,
  read: () => Promise<ArrRelease[]>,
): Promise<ArrRelease[]> {
  const now = input.now ? input.now() : Date.now();
  const hit = releaseCache.get(key);
  if (hit && now - hit.at < RELEASE_LIST_TTL_MS) return hit.releases;
  if (input.requesterId && !input.requesterIsAdmin) {
    const recent = (searchesByRequester.get(input.requesterId) ?? []).filter((at) => now - at < 3_600_000);
    if (recent.length >= RELEASE_SEARCHES_PER_HOUR) {
      throw new FixRateLimitError(
        'You have checked for replacements many times in a short while. Give it a little while and try again.',
      );
    }
    recent.push(now);
    searchesByRequester.set(input.requesterId, recent);
  }
  const releases = await read();
  releaseCache.set(key, { at: now, releases });
  if (releaseCache.size > RELEASE_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of releaseCache) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) releaseCache.delete(oldestKey);
  }
  return releases;
}

/** Whether a guarded plan applies at all: a Sonarr or Radarr Fix with a remedy that plans on. */
export function planApplies(kind: string, remedies: RepairGuideRemedies): boolean {
  return (kind === 'sonarr' || kind === 'radarr') && (remedies.replacement_preview || remedies.season_guard);
}

/** A stable digest of what a plan will DO (marks, deletes, searches), so a changed plan is refused, not run. */
export function planDigest(actions: unknown): string {
  return createHash('sha256').update(JSON.stringify(actions)).digest('hex').slice(0, 24);
}

const baseName = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || null;
};

interface FileRecord {
  id: number;
  relativePath?: string | null;
  sceneName?: string | null;
  releaseGroup?: string | null;
  quality?: {
    quality?: { name?: string | null; resolution?: number | null } | null;
    revision?: { version?: number | null } | null;
  } | null;
  size?: number | null;
  customFormatScore?: number | null;
  edition?: string | null;
}

function planFile(file: FileRecord): PlanFile {
  return {
    fileId: file.id,
    name: baseName(file.relativePath),
    releaseGroup: file.releaseGroup ?? null,
    qualityName: file.quality?.quality?.name ?? null,
    size: file.size ?? null,
  };
}

/** The release name the file's last import (or, failing that, its grab) recorded. */
function recordedReleaseName(history: readonly ArrReleaseHistoryRecord[], fileId: number): string | null {
  const imports = history
    .filter((h) => h.fileId === fileId && /imported/i.test(h.eventType) && h.sourceTitle)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return imports[0]?.sourceTitle ?? null;
}

function fileIdentity(file: FileRecord, history: readonly ArrReleaseHistoryRecord[]): CurrentFileIdentity {
  return {
    fileName: baseName(file.relativePath),
    sceneName: file.sceneName ?? null,
    releaseName: recordedReleaseName(history, file.id),
    releaseGroup: file.releaseGroup ?? null,
    qualityName: file.quality?.quality?.name ?? null,
    resolution: file.quality?.quality?.resolution ?? null,
    revision: file.quality?.revision?.version ?? null,
    edition: file.edition ?? null,
    size: file.size ?? null,
    customFormatScore: file.customFormatScore ?? null,
  };
}

function planRelease(release: ArrRelease): PlanRelease {
  return {
    title: release.title,
    releaseGroup: release.releaseGroup,
    qualityName: release.qualityName,
    size: release.size,
    protocol: release.protocol,
    indexer: release.indexer,
    customFormatScore: release.customFormatScore,
    fullSeason: release.fullSeason,
  };
}

const UNCHECKED: PlanReplacement = { verdict: 'unchecked', candidate: null, basis: null };

/**
 * Build the plan for one guarded Fix. Throws NotFoundError / LedgerItemTombstonedError / FixTargetRequiredError like the
 * Fix itself, and ArrUpstreamError when a read fails (a Replacement Preview that cannot be read refuses the delete:
 * the caller never deletes on an unread preview).
 */
export async function planFix(input: PlanFixInput): Promise<FixPlan> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to fix in the *arr`);
  }
  if (item.arrKind !== 'sonarr' && item.arrKind !== 'radarr') {
    throw new FixTargetRequiredError(`A guarded Fix plan covers Sonarr and Radarr only (not ${item.arrKind})`);
  }
  const resolved = resolveFixTarget(item.arrKind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });

  if (item.arrKind === 'radarr') return planMovie(input, item.arrItemId);

  const children = await listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: item.id });
  const history = await guardArrCall(`sonarr GET /history/series?seriesId=${item.arrItemId}`, () =>
    input.arr.read.sonarr.getSeriesReleaseHistory(item.arrItemId),
  );
  const latest = latestGrabsByEpisode(history);
  if (resolved.scope === 'season') {
    return planSeason(input, item.arrItemId, resolved.seasonNumber!, children, history, latest);
  }
  return planEpisode(input, item.arrItemId, resolved.targetChildId!, children, history, latest);
}

async function planMovie(input: PlanFixInput, movieId: number): Promise<FixPlan> {
  const radarr = input.arr.read.radarr;
  const grabs = await guardArrCall(`radarr GET /history/movie?movieId=${movieId}&eventType=grabbed`, () =>
    radarr.getMovieGrabHistory(movieId),
  );
  const newest = grabs.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  if (newest) {
    const grab: PlanGrab = {
      grabId: newest.id,
      sourceTitle: newest.sourceTitle ?? null,
      releaseSource: typeof newest.data?.releaseSource === 'string' ? newest.data.releaseSource : null,
    };
    return {
      kind: 'blocklist',
      scope: 'item',
      targetLabel: null,
      grab,
      packCost: [],
      digest: planDigest({ kind: 'blocklist', grabId: grab.grabId }),
    };
  }
  const files = await guardArrCall(`radarr GET /moviefile?movieId=${movieId}`, () => radarr.listMovieFiles(movieId));
  const file = files[0] ?? null;
  let replacement = UNCHECKED;
  if (file && input.remedies.replacement_preview) {
    const [history, releases] = await Promise.all([
      guardArrCall(`radarr GET /history/movie?movieId=${movieId}`, () => radarr.getMovieReleaseHistory(movieId)),
      releasesFor(input, `radarr:movie:${movieId}`, () =>
        guardArrCall(`radarr GET /release?movieId=${movieId}`, () => radarr.listMovieReleases(movieId)),
      ),
    ]);
    const check = checkReplacement(fileIdentity(file, history), releases);
    replacement = {
      verdict: check.verdict,
      candidate: check.candidate ? planRelease(check.candidate) : null,
      basis: check.basis,
    };
  }
  return {
    kind: 'delete',
    scope: 'item',
    targetLabel: null,
    file: file ? planFile(file) : null,
    replacement,
    insteadOfPack: false,
    packCost: [],
    digest: planDigest({ kind: 'delete', fileId: file?.id ?? null, verdict: replacement.verdict }),
  };
}

function episodeRef(children: readonly MediaChildTarget[], episodeId: number): PlanEpisode {
  const child = children.find((c) => c.arrChildId === episodeId);
  return { episodeId, label: child?.label ?? `Episode ${episodeId}` };
}

async function planEpisode(
  input: PlanFixInput,
  seriesId: number,
  episodeId: number,
  children: readonly MediaChildTarget[],
  history: readonly ArrReleaseHistoryRecord[],
  latest: ReadonlyMap<number, EpisodeGrab>,
): Promise<FixPlan> {
  const target = children.find((c) => c.arrChildId === episodeId);
  if (!target) throw new NotFoundError(`sonarr episode ${episodeId} not found on live series ${seriesId}`);
  const onDisk = children.filter((c) => c.hasFile).map((c) => c.arrChildId);
  const grab = latest.get(episodeId);
  const cost = input.remedies.season_guard ? packCost(latest, onDisk, episodeId) : [];
  const insteadOfPack = grab !== undefined && cost.length > 0 && input.replaceFile === true;

  if (grab && !insteadOfPack) {
    const planGrab: PlanGrab = {
      grabId: grab.grabId,
      sourceTitle: grab.sourceTitle,
      releaseSource: grab.releaseSource,
    };
    return {
      kind: 'blocklist',
      scope: 'episode',
      targetLabel: target.label,
      grab: planGrab,
      packCost: cost.map((id) => episodeRef(children, id)),
      digest: planDigest({ kind: 'blocklist', grabId: grab.grabId, packCost: cost }),
    };
  }

  // The delete path: no grab history, or the person chose to replace just this episode instead of blocking its pack.
  let file: FileRecord | null = null;
  if (target.episodeFileId !== null && target.episodeFileId > 0) {
    const files = await guardArrCall(`sonarr GET /episodefile?seriesId=${seriesId}`, () =>
      input.arr.read.sonarr.listEpisodeFileReleases(seriesId),
    );
    file = files.find((f) => f.id === target.episodeFileId) ?? null;
  }
  let replacement = UNCHECKED;
  if (file && input.remedies.replacement_preview) {
    const releases = await releasesFor(input, `sonarr:episode:${episodeId}`, () =>
      guardArrCall(`sonarr GET /release?episodeId=${episodeId}`, () =>
        input.arr.read.sonarr.listEpisodeReleases(episodeId),
      ),
    );
    const check = checkReplacement(fileIdentity(file, history), releases, {
      covers: (r) =>
        target.seasonNumber === null || target.episodeNumber === null
          ? true
          : releaseCoversEpisode(r, { seasonNumber: target.seasonNumber, episodeNumber: target.episodeNumber }),
      episodeOfPack: true,
    });
    replacement = {
      verdict: check.verdict,
      candidate: check.candidate ? planRelease(check.candidate) : null,
      basis: check.basis,
    };
  }
  return {
    kind: 'delete',
    scope: 'episode',
    targetLabel: target.label,
    file: file ? planFile(file) : null,
    replacement,
    insteadOfPack,
    packCost: insteadOfPack ? cost.map((id) => episodeRef(children, id)) : [],
    digest: planDigest({ kind: 'delete', fileId: file?.id ?? null, verdict: replacement.verdict, insteadOfPack }),
  };
}

async function planSeason(
  input: PlanFixInput,
  seriesId: number,
  seasonNumber: number,
  children: readonly MediaChildTarget[],
  history: readonly ArrReleaseHistoryRecord[],
  latest: ReadonlyMap<number, EpisodeGrab>,
): Promise<SeasonPlan> {
  const seasonEpisodes = children.filter((c) => c.seasonNumber === seasonNumber);
  if (seasonEpisodes.length === 0) {
    throw new NotFoundError(`Season ${seasonNumber} has no episodes on live series ${seriesId}`);
  }
  const onDisk = seasonEpisodes.filter((c) => c.hasFile).map((c) => c.arrChildId);
  // Without the season guard (or with no choice named) the Fix covers every on-disk episode, as today.
  const named = input.remedies.season_guard && input.episodeIds !== undefined;
  const chosenIds = named ? onDisk.filter((id) => input.episodeIds!.includes(id)) : onDisk;
  const wholeSeason = chosenIds.length === onDisk.length && onDisk.length > 0;
  // Guard off: every backing download is marked and episodes without a record are simply searched (today's Fix).
  const split = input.remedies.season_guard
    ? splitSeasonByDownload(latest, onDisk, chosenIds)
    : { ...splitSeasonByDownload(latest, onDisk, onDisk), noRecord: [] };
  const ref = (id: number) => episodeRef(children, id);
  const anyRecord = chosenIds.some((id) => latest.has(id));

  const marks: SeasonMark[] = [];
  const heldBack: SeasonPlan['heldBack'] = [];
  const noRecord: PlanEpisode[] = [];
  const deletes: SeasonDelete[] = [];
  const refused: SeasonDelete[] = [];
  let searchEpisodeIds: number[] = [];
  let mode: SeasonPlan['mode'];

  if (anyRecord) {
    mode = 'blocklist';
    for (const d of split.markable) {
      const grabbed = new Set<number>(d.episodeIds);
      if (d.downloadId) {
        for (const h of history) {
          if (h.eventType === 'grabbed' && h.downloadId === d.downloadId && h.episodeId !== null) grabbed.add(h.episodeId);
        }
      }
      marks.push({
        grabId: d.grabId,
        downloadKey: d.downloadKey,
        sourceTitle: d.sourceTitle,
        releaseSource: d.releaseSource,
        episodes: d.episodeIds.map(ref),
        grabbedEpisodeIds: [...grabbed].sort((a, b) => a - b),
      });
    }
    for (const h of split.heldBack) {
      heldBack.push({ sourceTitle: h.sourceTitle, chosen: h.chosen.map(ref), others: h.others.map(ref) });
    }
    for (const id of split.noRecord) noRecord.push(ref(id));
    searchEpisodeIds = marks.flatMap((m) => m.episodes.map((e) => e.episodeId));
  } else {
    mode = 'delete';
    const files = chosenIds.length
      ? await guardArrCall(`sonarr GET /episodefile?seriesId=${seriesId}`, () =>
          input.arr.read.sonarr.listEpisodeFileReleases(seriesId),
        )
      : [];
    const releases =
      input.remedies.replacement_preview && chosenIds.length
        ? await releasesFor(input, `sonarr:season:${seriesId}:${seasonNumber}`, () =>
            guardArrCall(`sonarr GET /release?seriesId=${seriesId}&seasonNumber=${seasonNumber}`, () =>
              input.arr.read.sonarr.listSeasonReleases(seriesId, seasonNumber),
            ),
          )
        : null;
    for (const id of chosenIds) {
      const child = seasonEpisodes.find((c) => c.arrChildId === id)!;
      const file = files.find((f) => f.id === child.episodeFileId);
      if (!file) continue;
      let replacement = UNCHECKED;
      if (releases) {
        const check = checkReplacement(fileIdentity(file, history), releases, {
          covers: (r) =>
            child.episodeNumber === null
              ? false
              : releaseCoversEpisode(r, { seasonNumber, episodeNumber: child.episodeNumber }),
          episodeOfPack: true,
        });
        replacement = {
          verdict: check.verdict,
          candidate: check.candidate ? planRelease(check.candidate) : null,
          basis: check.basis,
        };
      }
      const entry = { episode: ref(id), file: planFile(file), replacement };
      if (replacement.verdict === 'same_release' || replacement.verdict === 'no_replacement') refused.push(entry);
      else deletes.push(entry);
    }
    searchEpisodeIds = deletes.map((d) => d.episode.episodeId);
  }

  // Today's season Fix searches the whole season when everything on disk was chosen and acted on.
  const actedOnAll =
    wholeSeason &&
    heldBack.length === 0 &&
    noRecord.length === 0 &&
    refused.length === 0;
  const actionable = mode === 'blocklist' ? marks.length > 0 : deletes.length > 0;
  return {
    kind: 'season',
    seasonNumber,
    targetLabel: `Season ${seasonNumber}`,
    mode,
    chosen: chosenIds.map(ref),
    marks,
    heldBack,
    noRecord,
    deletes,
    refused,
    searchEpisodeIds,
    wholeSeason: actedOnAll,
    actionable,
    digest: planDigest({
      kind: 'season',
      mode,
      marks: marks.map((m) => m.grabId).sort((a, b) => a - b),
      deletes: deletes.map((d) => d.file.fileId).sort((a, b) => a - b),
      search: actedOnAll ? 'season' : [...searchEpisodeIds].sort((a, b) => a - b),
    }),
  };
}

/** One on-disk episode of a season, for the guide's "Which episodes are wrong?" list. */
export interface SeasonChoice {
  episodeId: number;
  label: string;
  /** The release its latest grab names, or null when it has no download record. */
  releaseName: string | null;
  /** Groups the episodes one download backs; null with no download record. */
  downloadKey: string | null;
  /** How many on-disk episodes of the season that download backs (2+ is a pack). */
  downloadEpisodes: number;
}

/**
 * DESIGN-055 D-09 — the season guard's list: every on-disk episode of the season with the download behind it, so the
 * guide can show which ones share a pack before anything is chosen. READ-ONLY, and no release search.
 */
export async function readSeasonChoices(input: {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  mediaItemId: string;
  seasonNumber: number;
}): Promise<SeasonChoice[]> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.arrKind !== 'sonarr') throw new FixTargetRequiredError('Only a TV season has episodes to choose');
  const children = await listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: item.id });
  const onDisk = children.filter((c) => c.seasonNumber === input.seasonNumber && c.hasFile);
  if (onDisk.length === 0) return [];
  const history = await guardArrCall(`sonarr GET /history/series?seriesId=${item.arrItemId}`, () =>
    input.arr.read.sonarr.getSeriesReleaseHistory(item.arrItemId),
  );
  const latest = latestGrabsByEpisode(history);
  const counts = new Map<string, number>();
  for (const c of onDisk) {
    const key = latest.get(c.arrChildId)?.downloadKey;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return onDisk.map((c) => {
    const grab = latest.get(c.arrChildId);
    return {
      episodeId: c.arrChildId,
      label: c.label,
      releaseName: grab?.sourceTitle ?? null,
      downloadKey: grab?.downloadKey ?? null,
      downloadEpisodes: grab ? (counts.get(grab.downloadKey) ?? 1) : 0,
    };
  });
}

/**
 * DESIGN-055 D-01, D-09 — the guide's preview for one person (`fix.preview`): null when no planning remedy is on or the
 * kind has none (Lidarr). It refuses early, like the Fix itself, when the person is over their hourly budget or a Fix is
 * already open on the grain, so a request that would be refused anyway never runs a release search.
 */
export async function previewFix(
  input: Omit<PlanFixInput, 'requesterId'> & { requesterId: string },
): Promise<FixPlan | null> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (!planApplies(item.arrKind, input.remedies)) return null;
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
  return planFix(input);
}
