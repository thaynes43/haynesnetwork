// ADR-093 C-07..C-09 / C-15 / C-19 / DESIGN-052 D-11..D-14 / D-21 / D-23 (PLAN-072 S2) — the DELETED-RELEASE RECORD
// (T-264) and the RELEASE BLOCK (T-265).
//
// Before the sweep or Expedite deletes an item, it records the identity of the release being deleted (D-11), derives a
// "must not contain" term from it (D-12, release-terms.ts) and writes the term into ONE app-owned release profile per
// Radarr and Sonarr, reading it back (D-13). Only then does the Maintainerr handle run. A record turns `active` once the
// *arr answers 404 for the item (the delete really happened); a failed handle, or an item the *arr still has, turns it
// `abandoned` and its term leaves the profile on the next reconcile, so a term never blocks the current release of a
// title that is still there (D-14 step 7). An item whose release cannot be recorded is KEPT (`release_unrecorded`,
// D-11): no term, no delete.
//
// Hard rule 4 (amended by ADR-093 C-08): the profile write is the Release Block write-back, confined to this module
// through `@hnet/arr/write`; it never touches library files, quality profiles or custom formats. Every record row is
// written here (the no-direct-state-writes guard covers trash_deleted_releases). No URL is ever stored or logged.
import {
  ledgerEvents,
  mediaItems,
  trashDeletedReleases,
  type DbClient,
  type DeletedReleaseIdentitySource,
  type DeletedReleaseOrigin,
  type DeletedReleaseState,
  type DeletedReleaseTermConfidence,
  type Transaction,
} from '@hnet/db';
import {
  ARR_CLUSTER_URL_DEFAULTS,
  ArrConfigError,
  ArrHttpError,
  MaintainerrWriteFailedError,
  type ArrReleaseHistoryRecord,
} from '@hnet/arr';
import { RadarrClient, SonarrClient } from '@hnet/arr/read';
import { RadarrWriteClient, SonarrWriteClient } from '@hnet/arr/write';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { ReleaseBlockError, type ReleaseBlockStep } from './errors';
import {
  RELEASE_BLOCK_PROFILE_NAME,
  RELEASE_BLOCK_SENTINEL,
  deriveTerm,
  isGrammarTerm,
  looksLikeRelease,
  parseReleaseName,
  releaseBaseName,
  releaseTokens,
  resolutionFromQualityName,
  termMatches,
  toTermResolution,
  type TermResolution,
} from './release-terms';

/** D-13 — a term lives this long from its record (a later record of the same term keeps it alive longer). */
export const RELEASE_TERM_LIFETIME_DAYS = 365;
/** D-13 — at most this many live terms per *arr; beyond it the oldest `active` rows are pruned (WARN). */
export const RELEASE_BLOCK_TERM_CAP = 3_000;
/** D-13 step 1 — an `in_flight` row older than this belongs to a sweep that died mid-way: settle it against the *arr. */
export const RELEASE_IN_FLIGHT_SETTLE_AFTER_MS = 60 * 60_000;
/** D-23 — a re-added title with no grab yet is re-checked hourly for at most this many days. */
export const RELEASE_READD_WINDOW_DAYS = 7;
/** D-23 — the Watchlists card counts re-adds over this many days. */
export const RELEASE_READD_REPORT_DAYS = 30;

const DAY_MS = 86_400_000;

export type ReleaseArrKind = 'radarr' | 'sonarr';

// ---------------------------------------------------------------------------
// The *arr seam: the identity reads and the confined profile writes. ArrClientBundle satisfies it structurally.
// ---------------------------------------------------------------------------

export interface ReleaseBlockArrClients {
  read: {
    radarr: Pick<
      RadarrClient,
      'findMovie' | 'listMovieFiles' | 'getMovieReleaseHistory' | 'countImportListExclusions'
    >;
    sonarr: Pick<
      SonarrClient,
      | 'findSeries'
      | 'listEpisodeFileReleases'
      | 'getSeriesReleaseHistory'
      | 'countImportListExclusions'
    >;
  };
  write: {
    radarr: Pick<
      RadarrWriteClient,
      'listReleaseProfiles' | 'createReleaseProfile' | 'updateReleaseProfile'
    >;
    sonarr: Pick<
      SonarrWriteClient,
      'listReleaseProfiles' | 'createReleaseProfile' | 'updateReleaseProfile'
    >;
  };
}

/**
 * The Release Block's clients from env: RADARR_URL / RADARR_API_KEY and SONARR_URL / SONARR_API_KEY only (the sweep
 * and seed jobs mount `haynesnetwork-secret`). Built here so `@hnet/arr/write` stays confined to packages/domain.
 */
export function releaseBlockArrClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReleaseBlockArrClients {
  const missing: string[] = [];
  const options = (kind: ReleaseArrKind) => {
    const prefix = kind.toUpperCase();
    const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
    if (!apiKey) missing.push(`${prefix}_API_KEY`);
    return { baseUrl: env[`${prefix}_URL`]?.trim() || ARR_CLUSTER_URL_DEFAULTS[kind], apiKey };
  };
  const radarr = options('radarr');
  const sonarr = options('sonarr');
  if (missing.length > 0) throw new ArrConfigError(missing);
  return {
    read: { radarr: new RadarrClient(radarr), sonarr: new SonarrClient(sonarr) },
    write: { radarr: new RadarrWriteClient(radarr), sonarr: new SonarrWriteClient(sonarr) },
  };
}

// ---------------------------------------------------------------------------
// Identity (D-11)
// ---------------------------------------------------------------------------

/** One record the caller is about to write (a movie has one; a show one per season, group and resolution). */
export interface ReleaseRecordDraft {
  arrKind: ReleaseArrKind;
  arrItemId: number | null;
  mediaItemId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  year: number | null;
  season: number | null;
  identitySource: DeletedReleaseIdentitySource;
  releaseTitle: string | null;
  releaseGroup: string | null;
  quality: string | null;
  resolution: number | null;
  sizeBytes: number | null;
  fileName: string | null;
  indexer: string | null;
  years: number[];
  term: string | null;
  termConfidence: DeletedReleaseTermConfidence | null;
  /** D-21 `recorded.shape`: `none` when the item has no file (nothing to re-fetch). */
  shape: 'group' | 'exact' | 'none';
}

export type ReleaseIdentity =
  | { status: 'recordable'; drafts: ReleaseRecordDraft[] }
  | {
      status: 'unrecordable';
      /** `no_term`: no group and no release name (or D-12's self-check rejected every form); `gone`: the *arr no
       *  longer has the item and the ledger cannot name its release; `no_ledger_item`: not in our ledger. */
      reason: 'no_term' | 'gone' | 'no_ledger_item';
    };

/** The ledger's view of the item's last imported release before `before` (D-11 source 3): import + its grab. */
interface LedgerRelease {
  sourceTitles: string[];
  releaseGroup: string | null;
  quality: string | null;
  indexer: string | null;
  occurredAt: Date;
}

const payloadString = (payload: Record<string, unknown>, key: string): string | null => {
  const v = payload[key];
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
};

/**
 * D-11 source 3 / D-15 — the ledger's imported releases for one media item before `before`, newest first: each
 * `imported` row with the `grabbed` row that shares its `downloadId`. Taking imports (not any grab) means an upgraded
 * title names the release that was deleted, not the one it superseded. These rows outlive the *arr delete.
 */
export async function ledgerReleases(
  db: DbClient | undefined,
  mediaItemId: string,
  before: Date,
  limit = 1,
): Promise<LedgerRelease[]> {
  const handle = resolveDb(db);
  const imports = await handle
    .select({ payload: ledgerEvents.payload, occurredAt: ledgerEvents.occurredAt })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.mediaItemId, mediaItemId),
        eq(ledgerEvents.eventType, 'imported'),
        lte(ledgerEvents.occurredAt, before),
      ),
    )
    .orderBy(desc(ledgerEvents.occurredAt))
    .limit(Math.max(1, limit) * 4);
  const out: LedgerRelease[] = [];
  const seenDownloads = new Set<string>();
  for (const imp of imports) {
    if (out.length >= limit) break;
    const downloadId = payloadString(imp.payload, 'downloadId');
    if (downloadId !== null) {
      if (seenDownloads.has(downloadId)) continue;
      seenDownloads.add(downloadId);
    }
    let grab: Record<string, unknown> | null = null;
    if (downloadId !== null) {
      const [row] = await handle
        .select({ payload: ledgerEvents.payload })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.mediaItemId, mediaItemId),
            eq(ledgerEvents.eventType, 'grabbed'),
            sql`${ledgerEvents.payload}->>'downloadId' = ${downloadId}`,
          ),
        )
        .orderBy(desc(ledgerEvents.occurredAt))
        .limit(1);
      grab = row?.payload ?? null;
    }
    const titles = [
      grab ? payloadString(grab, 'sourceTitle') : null,
      payloadString(imp.payload, 'sourceTitle'),
    ].filter((t): t is string => t !== null);
    out.push({
      sourceTitles: [...new Set(titles)],
      releaseGroup:
        (grab ? payloadString(grab, 'releaseGroup') : null) ??
        payloadString(imp.payload, 'releaseGroup'),
      quality:
        (grab ? payloadString(grab, 'quality') : null) ?? payloadString(imp.payload, 'quality'),
      indexer: grab ? payloadString(grab, 'indexer') : null,
      occurredAt: imp.occurredAt,
    });
  }
  return out;
}

/** A path's usable release name: its last segment when it names a release (a title, a year or season, a resolution or a
 *  group), else its folder; null when neither does (a renamed "Title (Year).mkv" is no release name). */
function nameFromOriginalPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = path.split(/[\\/]/).filter((s) => s.trim().length > 0);
  for (const segment of [...segments].reverse().slice(0, 2)) {
    if (looksLikeRelease(parseReleaseName(segment))) return releaseBaseName(segment);
  }
  return null;
}

const GRAB = 'grabbed';
const IMPORT_EVENTS = new Set(['downloadFolderImported']);

/**
 * D-11 — the grab behind a file: the import whose `data.fileId` is the file's id (or, when absent, whose
 * `importedPath` ends with its relative path, or whose `sourceTitle` is its scene name), newest first, then the grab
 * that shares that import's `downloadId`.
 */
export function joinFileToGrab(
  file: { id: number; relativePath?: string | null; sceneName?: string | null },
  history: readonly ArrReleaseHistoryRecord[],
): { grab: ArrReleaseHistoryRecord | null; imported: ArrReleaseHistoryRecord | null } {
  const byDate = [...history].sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''));
  const imports = byDate.filter((h) => IMPORT_EVENTS.has(h.eventType));
  const rel = file.relativePath?.replace(/\\/g, '/') ?? null;
  const imported =
    imports.find((h) => h.fileId === file.id) ??
    (rel
      ? imports.find((h) => h.importedPath?.replace(/\\/g, '/').endsWith(rel) === true)
      : undefined) ??
    (file.sceneName ? imports.find((h) => h.sourceTitle === file.sceneName) : undefined) ??
    null;
  if (!imported || !imported.downloadId) return { grab: null, imported };
  const grab =
    byDate.find((h) => h.eventType === GRAB && h.downloadId === imported.downloadId) ?? null;
  return { grab, imported };
}

interface SubjectRow {
  arrKind: string;
  arrItemId: number;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  year: number | null;
}

async function loadSubject(
  db: DbClient | undefined,
  mediaItemId: string,
): Promise<SubjectRow | null> {
  const [row] = await resolveDb(db)
    .select({
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      tmdbId: mediaItems.tmdbId,
      tvdbId: mediaItems.tvdbId,
      imdbId: mediaItems.imdbId,
      title: mediaItems.title,
      year: mediaItems.year,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  return row ?? null;
}

const isRemuxQuality = (name: string | null | undefined, modifier: string | null | undefined) =>
  /remux/i.test(name ?? '') || (modifier ?? '').toLowerCase() === 'remux';

const distinct = (names: ReadonlyArray<string | null | undefined>): string[] => {
  const out: string[] = [];
  for (const n of names) if (n && n.trim().length > 0 && !out.includes(n)) out.push(n);
  return out;
};

/**
 * D-11 — the identity of the release the caller is about to delete. Reads the *arr (item, files, history) and the
 * ledger; THROWS when an *arr read fails (network, 5xx), which the caller counts toward its consecutive-failure breaker.
 * `before` bounds the ledger read (now for a live delete; `deleted_at` for the seed).
 */
export async function identifyRelease(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients['read'];
  mediaItemId: string;
  before?: Date;
}): Promise<ReleaseIdentity> {
  const subject = await loadSubject(input.db, input.mediaItemId);
  if (!subject || (subject.arrKind !== 'radarr' && subject.arrKind !== 'sonarr')) {
    return { status: 'unrecordable', reason: 'no_ledger_item' };
  }
  const before = input.before ?? new Date();
  return subject.arrKind === 'radarr'
    ? identifyMovie(input.db, input.arr.radarr, input.mediaItemId, subject, before)
    : identifySeries(input.db, input.arr.sonarr, input.mediaItemId, subject, before);
}

function baseDraft(
  kind: ReleaseArrKind,
  mediaItemId: string,
  s: SubjectRow,
): Omit<
  ReleaseRecordDraft,
  | 'identitySource'
  | 'releaseTitle'
  | 'releaseGroup'
  | 'quality'
  | 'resolution'
  | 'sizeBytes'
  | 'fileName'
  | 'indexer'
  | 'years'
  | 'term'
  | 'termConfidence'
  | 'shape'
  | 'season'
> {
  return {
    arrKind: kind,
    arrItemId: s.arrItemId,
    mediaItemId,
    tmdbId: s.tmdbId,
    tvdbId: s.tvdbId,
    imdbId: s.imdbId,
    title: s.title,
    year: s.year,
  };
}

/** A record built from the ledger alone (the *arr no longer has the item, or has no name for it). */
function ledgerDraft(
  kind: ReleaseArrKind,
  mediaItemId: string,
  s: SubjectRow,
  ledger: LedgerRelease,
  arrYears: Array<number | null>,
  season: number | null,
): ReleaseRecordDraft | null {
  const derived = deriveTerm({
    kind: kind === 'radarr' ? 'movie' : 'show',
    arrTitle: s.title,
    arrYears,
    releaseNames: ledger.sourceTitles,
    renamedFileName: null,
    releaseGroup: ledger.releaseGroup,
    resolution: resolutionFromQualityName(ledger.quality),
    remux: isRemuxQuality(ledger.quality, null),
    season,
  });
  if (!derived) return null;
  return {
    ...baseDraft(kind, mediaItemId, s),
    season,
    identitySource: 'ledger_grab',
    releaseTitle: ledger.sourceTitles[0] ?? null,
    releaseGroup: ledger.releaseGroup,
    quality: ledger.quality,
    resolution: resolutionFromQualityName(ledger.quality),
    sizeBytes: null,
    fileName: null,
    indexer: ledger.indexer,
    years: derived.years,
    term: derived.term,
    termConfidence: derived.confidence,
    shape: derived.shape,
  };
}

/**
 * D-11 source 3 / D-15 — records from the ledger alone: the latest import before `before` (a movie), or one record per
 * season / group / resolution the imports name (a series). Null when the ledger cannot name a release, or when any
 * season it names yields no term (fail closed: a series is kept whole).
 */
async function ledgerDrafts(
  db: DbClient | undefined,
  kind: ReleaseArrKind,
  mediaItemId: string,
  s: SubjectRow,
  before: Date,
): Promise<ReleaseRecordDraft[] | null> {
  const arrYears = [s.year];
  if (kind === 'radarr') {
    const [ledger] = await ledgerReleases(db, mediaItemId, before, 1);
    const draft = ledger ? ledgerDraft('radarr', mediaItemId, s, ledger, arrYears, null) : null;
    return draft ? [draft] : null;
  }
  const ledger = await ledgerReleases(db, mediaItemId, before, 200);
  // D-25bc — every import of a (season, group, resolution) key counts, never only the newest: the key's group term
  // must match every import name of the key (one record), else each distinct release name gets its own record, and a
  // key where any name yields no term fails the whole series closed (it is kept, or counted unblockable by the seed).
  const byKey = new Map<string, { season: number; imports: LedgerRelease[] }>();
  for (const l of ledger) {
    const parsed = parseReleaseName(l.sourceTitles[0] ?? '');
    if (parsed.season === null || parsed.season < 1) continue;
    const key = `${parsed.season}|${(l.releaseGroup ?? parsed.group ?? '').toLowerCase()}|${resolutionFromQualityName(l.quality) ?? parsed.resolution}`;
    const entry = byKey.get(key) ?? { season: parsed.season, imports: [] };
    entry.imports.push(l);
    byKey.set(key, entry);
  }
  const drafts: ReleaseRecordDraft[] = [];
  for (const { season, imports } of byKey.values()) {
    const newest = imports[0] as LedgerRelease;
    const names = distinct(imports.flatMap((i) => i.sourceTitles));
    const combined = ledgerDraft(
      'sonarr',
      mediaItemId,
      s,
      { ...newest, sourceTitles: names },
      arrYears,
      season,
    );
    if (
      combined !== null &&
      combined.shape === 'group' &&
      combined.term !== null &&
      names.every((n) => termMatches(combined.term as string, n))
    ) {
      drafts.push(combined);
      continue;
    }
    for (const name of names) {
      const from = imports.find((i) => i.sourceTitles.includes(name)) ?? newest;
      const draft = ledgerDraft(
        'sonarr',
        mediaItemId,
        s,
        { ...from, sourceTitles: [name] },
        arrYears,
        season,
      );
      if (!draft || draft.term === null) return null;
      drafts.push(draft);
    }
  }
  return drafts.length > 0 ? drafts : null;
}

/** D-15 — the ledger-only identity of a media item deleted at `before` (the seed's first source). */
export async function identifyFromLedger(input: {
  db?: DbClient;
  mediaItemId: string;
  before: Date;
}): Promise<ReleaseRecordDraft[] | null> {
  const subject = await loadSubject(input.db, input.mediaItemId);
  if (!subject || (subject.arrKind !== 'radarr' && subject.arrKind !== 'sonarr')) return null;
  return ledgerDrafts(input.db, subject.arrKind, input.mediaItemId, subject, input.before);
}

/** D-25bd — does the ledger's latest import describe the file the *arr has? Unknown on either side never disagrees. */
function ledgerAgreesWithFile(
  ledger: LedgerRelease,
  fileGroup: string | null,
  fileResolution: TermResolution | null,
): boolean {
  const parsed = parseReleaseName(ledger.sourceTitles[0] ?? '');
  const ledgerGroup = ledger.releaseGroup ?? parsed.group;
  if (
    fileGroup !== null &&
    ledgerGroup !== null &&
    releaseTokens(fileGroup).join('') !== releaseTokens(ledgerGroup).join('')
  ) {
    return false;
  }
  const ledgerResolution = resolutionFromQualityName(ledger.quality) ?? parsed.resolution;
  return fileResolution === null || ledgerResolution === null || fileResolution === ledgerResolution;
}

async function identifyMovie(
  db: DbClient | undefined,
  radarr: ReleaseBlockArrClients['read']['radarr'],
  mediaItemId: string,
  s: SubjectRow,
  before: Date,
): Promise<ReleaseIdentity> {
  const movie = await radarr.findMovie(s.arrItemId);
  const arrYears = [movie?.year ?? s.year ?? null, movie?.secondaryYear ?? null];
  if (movie === null) {
    // Gone from Radarr already: only the ledger can name what a re-request would fetch.
    const drafts = await ledgerDrafts(db, 'radarr', mediaItemId, s, before);
    return drafts ? { status: 'recordable', drafts } : { status: 'unrecordable', reason: 'gone' };
  }
  const files = await radarr.listMovieFiles(s.arrItemId);
  const file = files.find((f) => f.id === movie.movieFileId) ?? files[0];
  if (!file) {
    // No file: nothing to re-fetch. Recorded as evidence with no term (D-11 `none`).
    return {
      status: 'recordable',
      drafts: [
        {
          ...baseDraft('radarr', mediaItemId, s),
          year: movie.year,
          season: null,
          identitySource: 'none',
          releaseTitle: null,
          releaseGroup: null,
          quality: null,
          resolution: null,
          sizeBytes: null,
          fileName: null,
          indexer: null,
          years: [],
          term: null,
          termConfidence: null,
          shape: 'none',
        },
      ],
    };
  }
  const history = await radarr.getMovieReleaseHistory(s.arrItemId);
  const { grab, imported } = joinFileToGrab(file, history);
  const [ledger] = await ledgerReleases(db, mediaItemId, before, 1);
  const arrNames = distinct([
    grab?.sourceTitle,
    file.sceneName,
    nameFromOriginalPath(file.originalFilePath),
  ]);
  const q = file.quality?.quality;
  const fileGroup = file.releaseGroup ?? grab?.releaseGroup ?? imported?.releaseGroup ?? null;
  const resolution: TermResolution | null =
    toTermResolution(q?.resolution) ?? resolutionFromQualityName(q?.name);
  // D-25af / D-25bd — the ledger's names join only when the *arr has no name for the file AND the ledger's latest
  // import agrees with the file (the same group, when both name one; the same resolution, when both carry one). A file
  // replaced outside the *arr's history (a disk copy, a rescan) must not take a stale import's name: its term would
  // block that old release and not the file being deleted, which then gets the renamed-file group term instead.
  const useLedger =
    arrNames.length === 0 &&
    ledger !== undefined &&
    ledger.sourceTitles.length > 0 &&
    ledgerAgreesWithFile(ledger, fileGroup, resolution);
  const names = useLedger ? ledger!.sourceTitles : arrNames;
  const releaseGroup = fileGroup ?? (useLedger ? ledger!.releaseGroup : null);
  const derived = deriveTerm({
    kind: 'movie',
    arrTitle: movie.title,
    arrYears,
    releaseNames: names,
    renamedFileName: file.relativePath ?? null,
    releaseGroup,
    resolution,
    remux: isRemuxQuality(q?.name, q?.modifier),
  });
  if (!derived) return { status: 'unrecordable', reason: 'no_term' };
  const identitySource: DeletedReleaseIdentitySource = grab?.sourceTitle
    ? 'arr_grab_history'
    : useLedger
      ? 'ledger_grab'
      : 'arr_file';
  return {
    status: 'recordable',
    drafts: [
      {
        ...baseDraft('radarr', mediaItemId, s),
        title: movie.title,
        year: movie.year,
        tmdbId: movie.tmdbId ?? s.tmdbId,
        imdbId: movie.imdbId ?? s.imdbId,
        season: null,
        identitySource,
        releaseTitle: names[0] ?? null,
        releaseGroup,
        quality: q?.name ?? null,
        resolution: q?.resolution ?? resolution,
        sizeBytes: file.size ?? null,
        fileName: file.relativePath ?? null,
        indexer: grab?.indexer ?? (useLedger ? ledger!.indexer : null),
        years: derived.years,
        term: derived.term,
        termConfidence: derived.confidence,
        shape: derived.shape,
      },
    ],
  };
}

async function identifySeries(
  db: DbClient | undefined,
  sonarr: ReleaseBlockArrClients['read']['sonarr'],
  mediaItemId: string,
  s: SubjectRow,
  before: Date,
): Promise<ReleaseIdentity> {
  const series = await sonarr.findSeries(s.arrItemId);
  const arrYears = [series?.year ?? s.year ?? null];
  if (series === null) {
    // Gone from Sonarr already: the ledger's imports, one record per season / group / resolution they name.
    const drafts = await ledgerDrafts(db, 'sonarr', mediaItemId, s, before);
    return drafts ? { status: 'recordable', drafts } : { status: 'unrecordable', reason: 'gone' };
  }
  const files = (await sonarr.listEpisodeFileReleases(s.arrItemId)).filter(
    (f) => (f.seasonNumber ?? 0) >= 1, // specials (season 0) are skipped (D-11)
  );
  if (files.length === 0) {
    return {
      status: 'recordable',
      drafts: [
        {
          ...baseDraft('sonarr', mediaItemId, s),
          title: series.title,
          year: series.year,
          season: null,
          identitySource: 'none',
          releaseTitle: null,
          releaseGroup: null,
          quality: null,
          resolution: null,
          sizeBytes: null,
          fileName: null,
          indexer: null,
          years: [],
          term: null,
          termConfidence: null,
          shape: 'none',
        },
      ],
    };
  }
  const history = await sonarr.getSeriesReleaseHistory(s.arrItemId);
  interface FileFacts {
    season: number;
    names: string[];
    group: string | null;
    resolution: TermResolution | null;
    remux: boolean;
    qualityName: string | null;
    relativePath: string | null;
    size: number;
    indexer: string | null;
    fromGrab: boolean;
  }
  const facts: FileFacts[] = files.map((f) => {
    const { grab, imported } = joinFileToGrab(f, history);
    const names = distinct([
      grab?.sourceTitle,
      f.sceneName,
      nameFromOriginalPath(f.originalFilePath),
    ]);
    const q = f.quality?.quality;
    const group =
      f.releaseGroup ??
      grab?.releaseGroup ??
      imported?.releaseGroup ??
      (names[0] ? parseReleaseName(names[0]).group : null);
    return {
      season: f.seasonNumber as number,
      names,
      group,
      resolution: toTermResolution(q?.resolution) ?? resolutionFromQualityName(q?.name),
      remux: isRemuxQuality(q?.name, q?.modifier),
      qualityName: q?.name ?? null,
      relativePath: f.relativePath ?? null,
      size: f.size ?? 0,
      indexer: grab?.indexer ?? null,
      fromGrab: Boolean(grab?.sourceTitle),
    };
  });
  // One record per distinct (season, group, resolution); a group-less key needs one exact record per release name.
  const byKey = new Map<string, FileFacts[]>();
  for (const f of facts) {
    const key = `${f.season}|${(f.group ?? '').toLowerCase()}|${f.resolution ?? ''}`;
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  const drafts: ReleaseRecordDraft[] = [];
  for (const group of byKey.values()) {
    const first = group[0] as FileFacts;
    const names = distinct(group.flatMap((f) => f.names));
    const size = group.reduce((n, f) => n + f.size, 0);
    // A group term covers every episode release of the key; when there is no group, or the group term fails the
    // self-check (deriveTerm falls back to the FIRST name's exact form), every distinct release name needs its own
    // exact record, and a file with no release name at all leaves the series unrecordable (D-25ah).
    const exactPerName = () =>
      group.some((f) => f.names.length === 0)
        ? [null]
        : names.map((n) => ({
            name: n,
            derived: deriveTerm({
              kind: 'show',
              arrTitle: series.title,
              arrYears,
              releaseNames: [n],
              renamedFileName: null,
              releaseGroup: null,
              resolution: first.resolution,
              remux: first.remux,
              season: first.season,
            }),
          }));
    let derivations: Array<{ name: string | null; derived: ReturnType<typeof deriveTerm> } | null>;
    if (first.group === null) {
      derivations = exactPerName();
    } else {
      const derived = deriveTerm({
        kind: 'show',
        arrTitle: series.title,
        arrYears,
        releaseNames: names,
        renamedFileName: first.relativePath,
        releaseGroup: first.group,
        resolution: first.resolution,
        remux: first.remux,
        season: first.season,
      });
      // D-25bb — whenever the group term fell back to the exact form, EVERY name of the key needs its own exact record
      // and a nameless file of the key keeps the series (D-25ah), however many names happen to be known: one exact
      // record for the only named file would leave a nameless sibling's release unblocked.
      derivations =
        derived !== null && derived.shape === 'exact'
          ? exactPerName()
          : [{ name: names[0] ?? null, derived }];
    }
    for (const d of derivations) {
      if (d === null || d.derived === null) return { status: 'unrecordable', reason: 'no_term' };
      drafts.push({
        ...baseDraft('sonarr', mediaItemId, s),
        title: series.title,
        year: series.year,
        tvdbId: series.tvdbId ?? s.tvdbId,
        season: first.season,
        identitySource: group.some((f) => f.fromGrab) ? 'arr_grab_history' : 'arr_file',
        releaseTitle: d.name,
        releaseGroup: first.group,
        quality: first.qualityName,
        resolution: first.resolution,
        sizeBytes: size,
        fileName: first.relativePath,
        indexer: group.find((f) => f.indexer)?.indexer ?? null,
        years: d.derived.years,
        term: d.derived.term,
        termConfidence: d.derived.confidence,
        shape: d.derived.shape,
      });
    }
  }
  return { status: 'recordable', drafts };
}

// ---------------------------------------------------------------------------
// Phase A (D-14 step 5): insert `in_flight` records, then reconcile each *arr involved
// ---------------------------------------------------------------------------

export interface KeyedDrafts {
  key: string;
  drafts: readonly ReleaseRecordDraft[];
  /** The batch item the records belong to, when known at insert time (the seed). The sweep stamps it at the claim. */
  batchItemId?: string | null;
}

/** One transaction: an `in_flight` row per draft. Returns the new record ids per caller key. */
export async function insertReleaseRecords(input: {
  db?: DbClient;
  items: readonly KeyedDrafts[];
  origin: DeletedReleaseOrigin;
  state?: Extract<DeletedReleaseState, 'in_flight' | 'active'>;
  recordedAt?: Date;
  /** The seed: the term's 365 days run from the deletion, so old deletions age out on the same clock (D-15). */
  expiresFrom?: (key: string) => Date | undefined;
  logger?: DomainLogger;
}): Promise<Map<string, string[]>> {
  const logger = input.logger ?? consoleDomainLogger;
  const at = input.recordedAt ?? new Date();
  const state = input.state ?? 'in_flight';
  const out = new Map<string, string[]>();
  await inTransaction(input.db, async (tx) => {
    for (const item of input.items) {
      const ids: string[] = [];
      const from = input.expiresFrom?.(item.key) ?? at;
      for (const d of item.drafts) {
        if (d.term !== null && !isGrammarTerm(d.term)) {
          // Never reachable through deriveTerm; a guard so a malformed term can never be stored (D-12).
          throw new ReleaseBlockError(d.arrKind, 'validate');
        }
        const [row] = await tx
          .insert(trashDeletedReleases)
          .values({
            arrKind: d.arrKind,
            arrItemId: d.arrItemId,
            mediaItemId: d.mediaItemId,
            batchItemId: item.batchItemId ?? null,
            tmdbId: d.tmdbId,
            tvdbId: d.tvdbId,
            imdbId: d.imdbId,
            title: d.title,
            year: d.year,
            season: d.season,
            identitySource: d.identitySource,
            releaseTitle: d.releaseTitle,
            releaseGroup: d.releaseGroup,
            quality: d.quality,
            resolution: d.resolution,
            sizeBytes: d.sizeBytes,
            fileName: d.fileName,
            indexer: d.indexer,
            years: d.years,
            term: d.term,
            termConfidence: d.termConfidence,
            state,
            origin: input.origin,
            recordedAt: at,
            activatedAt: state === 'active' ? at : null,
            expiresAt: new Date(from.getTime() + RELEASE_TERM_LIFETIME_DAYS * DAY_MS),
          })
          .returning({ id: trashDeletedReleases.id });
        if (row) ids.push(row.id);
        logger.info('[release-block] recorded', {
          arrKind: d.arrKind,
          origin: input.origin,
          identitySource: d.identitySource,
          shape: d.shape,
          confidence: d.termConfidence,
        });
      }
      out.set(item.key, ids);
    }
  });
  return out;
}

/** Flip still-`in_flight` records to `abandoned` (a lost claim, a failed handle, a failed Phase A). */
export async function abandonReleaseRecords(input: {
  db?: DbClient;
  recordIds: readonly string[];
  at?: Date;
}): Promise<number> {
  if (input.recordIds.length === 0) return 0;
  const rows = await resolveDb(input.db)
    .update(trashDeletedReleases)
    .set({ state: 'abandoned', endedAt: input.at ?? new Date() })
    .where(
      and(
        inArray(trashDeletedReleases.id, [...input.recordIds]),
        eq(trashDeletedReleases.state, 'in_flight'),
      ),
    )
    .returning({ id: trashDeletedReleases.id });
  return rows.length;
}

/** The claim transaction ties the records to the deletion (D-14 step 6): the batch item they belong to. */
export async function stampReleaseRecords(
  tx: Transaction,
  input: { recordIds: readonly string[]; batchItemId: string },
): Promise<void> {
  if (input.recordIds.length === 0) return;
  await tx
    .update(trashDeletedReleases)
    .set({ batchItemId: input.batchItemId })
    .where(inArray(trashDeletedReleases.id, [...input.recordIds]));
}

/**
 * D-14 step 5 — Phase A: record every survivor `in_flight`, then reconcile the profile of each *arr involved (at most
 * one PUT each, validated and read back). On failure the records turn `abandoned`, a best-effort reconcile removes any
 * term an earlier *arr already took, and the ReleaseBlockError is rethrown: nothing may be deleted.
 */
export async function blockReleases(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients;
  items: readonly KeyedDrafts[];
  origin: Extract<DeletedReleaseOrigin, 'sweep' | 'expedite'>;
  logger?: DomainLogger;
  now?: Date;
}): Promise<Map<string, string[]>> {
  const logger = input.logger ?? consoleDomainLogger;
  const recordIds = await insertReleaseRecords({
    db: input.db,
    items: input.items,
    origin: input.origin,
    logger,
    ...(input.now ? { recordedAt: input.now } : {}),
  });
  const kinds = [
    ...new Set(
      input.items.flatMap((i) => i.drafts.filter((d) => d.term !== null).map((d) => d.arrKind)),
    ),
  ].sort();
  const done: ReleaseArrKind[] = [];
  try {
    for (const kind of kinds) {
      await reconcileReleaseBlock({
        db: input.db,
        arr: input.arr,
        arrKind: kind,
        logger,
        now: input.now,
      });
      done.push(kind);
    }
  } catch (error) {
    await abandonReleaseRecords({ db: input.db, recordIds: [...recordIds.values()].flat() });
    for (const kind of done) {
      try {
        await reconcileReleaseBlock({ db: input.db, arr: input.arr, arrKind: kind, logger });
      } catch {
        // best effort: the next reconcile removes the orphan terms
      }
    }
    throw error;
  }
  return recordIds;
}

/**
 * DESIGN-052 D-14 step 7 / D-25ax — how a failed Maintainerr handle is read. `refused`: Maintainerr answered and
 * did not delete (an HTTP 4xx such as the 409 its executor lock gives, or a `code: 0` ReturnStatus). `ambiguous`:
 * the answer was lost (a client timeout, a dropped socket, a 5xx, anything else) and the delete may have run or may
 * still be running, since `handleMedia` deletes the *arr item first and only then does the rest.
 */
export function classifyHandleFailure(error: unknown): 'refused' | 'ambiguous' {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof ArrHttpError) {
      return cur.status >= 400 && cur.status < 500 ? 'refused' : 'ambiguous';
    }
    if (cur instanceof MaintainerrWriteFailedError) return 'refused';
    cur = (cur as { cause?: unknown }).cause;
  }
  return 'ambiguous';
}

/**
 * D-14 step 7 — settle one item's records after its handle, ALWAYS by the *arr's own answer (D-25ax): whatever the
 * handle returned, a `GET` of the item follows. A 404 flips the records `active` (the delete happened, even when the
 * handle's answer was lost). An item the *arr still has flips them `abandoned` (`handle_not_effective`) after a 2xx
 * handle or a definitive refusal (`classifyHandleFailure` → `refused`); after an ambiguous failure (a timeout, a
 * dropped socket, a 5xx) they stay `in_flight`, terms in place, because the delete may still be running: the
 * stranded settle (D-13 step 1) decides by presence an hour later. A `GET` that cannot be answered, or an item with
 * no *arr id, leaves them `in_flight` too (fail closed).
 */
export async function settleReleaseRecords(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients['read'];
  arrKind: ReleaseArrKind;
  arrItemId: number | null;
  recordIds: readonly string[];
  /** null: the handle answered 2xx; otherwise what it threw. */
  handleError: unknown;
  title: string;
  logger?: DomainLogger;
  now?: Date;
}): Promise<'active' | 'abandoned' | 'in_flight' | 'none'> {
  if (input.recordIds.length === 0) return 'none';
  const logger = input.logger ?? consoleDomainLogger;
  const at = input.now ?? new Date();
  const notEffective = async () => {
    await abandonReleaseRecords({ db: input.db, recordIds: input.recordIds, at });
    logger.warn('[release-block] handle_not_effective', {
      arrKind: input.arrKind,
      recordId: input.recordIds[0],
      title: input.title,
    });
    return 'abandoned' as const;
  };
  if (input.arrItemId === null) return 'in_flight';
  let present: unknown;
  try {
    present =
      input.arrKind === 'radarr'
        ? await input.arr.radarr.findMovie(input.arrItemId)
        : await input.arr.sonarr.findSeries(input.arrItemId);
  } catch {
    return 'in_flight';
  }
  if (present !== null) {
    if (input.handleError === null || input.handleError === undefined) return notEffective();
    return classifyHandleFailure(input.handleError) === 'refused' ? notEffective() : 'in_flight';
  }
  await resolveDb(input.db)
    .update(trashDeletedReleases)
    .set({ state: 'active', activatedAt: at })
    .where(
      and(
        inArray(trashDeletedReleases.id, [...input.recordIds]),
        eq(trashDeletedReleases.state, 'in_flight'),
      ),
    );
  return 'active';
}

// ---------------------------------------------------------------------------
// The single writer of the profiles (D-13)
// ---------------------------------------------------------------------------

export interface ReleaseBlockReconcileReport {
  arrKind: ReleaseArrKind;
  total: number;
  added: number;
  removed: number;
  expired: number;
  pruned: number;
  settled: number;
  wrote: boolean;
  ms: number;
}

const releaseLockKey = (kind: ReleaseArrKind) => sql`hashtext(${`release-block:${kind}`})`;

/**
 * D-13 — `reconcileReleaseBlock({ arrKind })`, the single writer of the app's release profile on one *arr, under
 * `pg_advisory_xact_lock('release-block:<kind>')`:
 *  1. rows past `expires_at` turn `expired`; `in_flight` rows older than an hour are settled against the *arr (404 ⇒
 *     `active`, present ⇒ `abandoned`, unreachable ⇒ left in place); desired = the sentinel + the distinct terms of
 *     `in_flight` and `active` rows, newest first, capped at 3,000 (the oldest `active` rows beyond it are `pruned`);
 *  2. every desired term must pass the D-12 grammar, before any write (`validate`);
 *  3. the profile is found by exact name: none ⇒ POST; one ⇒ PUT only when it differs; more ⇒ `duplicate_profile`;
 *  4. a read-back GET must show every desired term (`read_back`).
 * Idempotent (a set comparison). A hand edit is overwritten; a deleted profile is re-created.
 */
export async function reconcileReleaseBlock(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients;
  arrKind: ReleaseArrKind;
  logger?: DomainLogger;
  now?: Date;
}): Promise<ReleaseBlockReconcileReport> {
  const logger = input.logger ?? consoleDomainLogger;
  const kind = input.arrKind;
  const started = Date.now();
  const now = input.now ?? new Date();
  const t = trashDeletedReleases;
  try {
    return await inTransaction(input.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${releaseLockKey(kind)})`);

      // 1 — expiry, the stranded in-flight settle, the cap.
      const expired = await tx
        .update(t)
        .set({ state: 'expired', endedAt: now })
        .where(and(eq(t.arrKind, kind), eq(t.state, 'active'), lte(t.expiresAt, now)))
        .returning({ id: t.id });
      const stranded = await tx
        .select({ id: t.id, arrItemId: t.arrItemId })
        .from(t)
        .where(
          and(
            eq(t.arrKind, kind),
            eq(t.state, 'in_flight'),
            lt(t.recordedAt, new Date(now.getTime() - RELEASE_IN_FLIGHT_SETTLE_AFTER_MS)),
          ),
        );
      let settled = 0;
      const byItem = new Map<number, string[]>();
      for (const r of stranded) {
        if (r.arrItemId === null) continue;
        byItem.set(r.arrItemId, [...(byItem.get(r.arrItemId) ?? []), r.id]);
      }
      for (const [arrItemId, ids] of byItem) {
        let present: unknown;
        try {
          present =
            kind === 'radarr'
              ? await input.arr.read.radarr.findMovie(arrItemId)
              : await input.arr.read.sonarr.findSeries(arrItemId);
        } catch {
          continue; // unreachable: leave them in flight, terms in place (fail closed)
        }
        await tx
          .update(t)
          .set(
            present === null
              ? { state: 'active', activatedAt: now }
              : { state: 'abandoned', endedAt: now },
          )
          .where(and(inArray(t.id, ids), eq(t.state, 'in_flight')));
        settled += ids.length;
      }
      const terms = await tx
        .select({ term: t.term, newest: sql<Date>`max(${t.recordedAt})`.as('newest') })
        .from(t)
        .where(
          and(eq(t.arrKind, kind), inArray(t.state, ['in_flight', 'active']), isNotNull(t.term)),
        )
        .groupBy(t.term)
        .orderBy(sql`newest desc`);
      let pruned = 0;
      if (terms.length > RELEASE_BLOCK_TERM_CAP) {
        const over = terms.slice(RELEASE_BLOCK_TERM_CAP).map((r) => r.term as string);
        const rows = await tx
          .update(t)
          .set({ state: 'pruned', endedAt: now })
          .where(and(eq(t.arrKind, kind), eq(t.state, 'active'), inArray(t.term, over)))
          .returning({ id: t.id });
        pruned = rows.length;
        logger.warn('[release-block] pruned', {
          arrKind: kind,
          terms: over.length,
          records: pruned,
        });
      }
      const live = terms.slice(0, RELEASE_BLOCK_TERM_CAP).map((r) => r.term as string);
      const desired = [RELEASE_BLOCK_SENTINEL, ...live];

      // 2 — the grammar, before any write.
      if (!desired.every(isGrammarTerm)) throw new ReleaseBlockError(kind, 'validate');

      // 3 — the profile.
      const write = input.arr.write[kind];
      let profiles: Awaited<ReturnType<typeof write.listReleaseProfiles>>;
      try {
        profiles = await write.listReleaseProfiles();
      } catch (cause) {
        throw new ReleaseBlockError(kind, 'put', { cause });
      }
      const ours = profiles.filter((p) => p.name === RELEASE_BLOCK_PROFILE_NAME);
      if (ours.length > 1) throw new ReleaseBlockError(kind, 'duplicate_profile');
      const body = {
        name: RELEASE_BLOCK_PROFILE_NAME,
        enabled: true,
        required: [] as string[],
        ignored: desired,
        indexerId: 0,
        tags: [] as number[],
      };
      const current = ours[0];
      const before = new Set(current?.ignored ?? []);
      const want = new Set(desired);
      const same =
        current !== undefined &&
        current.enabled === true &&
        (current.required ?? []).length === 0 &&
        (current.indexerId ?? 0) === 0 &&
        (current.tags ?? []).length === 0 &&
        before.size === want.size &&
        [...want].every((x) => before.has(x));
      let wrote = false;
      if (!same) {
        try {
          if (current === undefined) await write.createReleaseProfile(body);
          else await write.updateReleaseProfile({ ...body, id: current.id });
        } catch (cause) {
          throw new ReleaseBlockError(kind, 'put', { cause });
        }
        wrote = true;
      }

      // 4 — the read-back.
      let after: Awaited<ReturnType<typeof write.listReleaseProfiles>>;
      try {
        after = await write.listReleaseProfiles();
      } catch (cause) {
        throw new ReleaseBlockError(kind, 'read_back', { cause });
      }
      const mine = after.filter((p) => p.name === RELEASE_BLOCK_PROFILE_NAME);
      const back = new Set(mine[0]?.ignored ?? []);
      if (mine.length !== 1 || mine[0]?.enabled !== true || !desired.every((x) => back.has(x))) {
        throw new ReleaseBlockError(kind, 'read_back');
      }
      const report: ReleaseBlockReconcileReport = {
        arrKind: kind,
        total: live.length,
        added: [...want].filter((x) => !before.has(x) && x !== RELEASE_BLOCK_SENTINEL).length,
        removed: [...before].filter((x) => !want.has(x) && x !== RELEASE_BLOCK_SENTINEL).length,
        expired: expired.length,
        pruned,
        settled,
        wrote,
        ms: Date.now() - started,
      };
      logger.info('[release-block] reconciled', { ...report });
      return report;
    });
  } catch (error) {
    if (error instanceof ReleaseBlockError) {
      logger.error('[release-block] failed', { arrKind: kind, step: error.step });
    }
    throw error;
  }
}

export type { ReleaseBlockStep };

// ---------------------------------------------------------------------------
// Survivor identity for a delete path (D-14 step 4) — shared by the sweep and Expedite
// ---------------------------------------------------------------------------

export interface ReleaseSurvivor {
  /** The caller's key (the Maintainerr media id). */
  key: string;
  mediaItemId: string;
  title: string;
}

export interface SurvivorIdentityResult {
  /** Survivors with records to write (a no-file item has one term-less record). */
  recordable: Map<string, ReleaseRecordDraft[]>;
  /** Survivors to keep `release_unrecorded`: no term (D-11) or a single failed *arr read between successes. */
  unrecorded: Map<string, UnrecordedReason>;
  /** Three consecutive *arr read failures: the *arr is down; abort before Phase A, nothing deleted. */
  aborted: boolean;
}

/** D-14 step 4 — the consecutive-failure limit (the existing `HANDLE_FAILURE_LIMIT`). */
export const IDENTITY_FAILURE_LIMIT = 3;

/** D-14 step 4 — read each survivor's identity; three consecutive *arr read failures abort (nothing is written). */
export async function identifySurvivors(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients['read'];
  survivors: readonly ReleaseSurvivor[];
  logger?: DomainLogger;
}): Promise<SurvivorIdentityResult> {
  const logger = input.logger ?? consoleDomainLogger;
  const recordable = new Map<string, ReleaseRecordDraft[]>();
  const unrecorded = new Map<string, UnrecordedReason>();
  let consecutive = 0;
  for (const s of input.survivors) {
    let identity: ReleaseIdentity;
    try {
      identity = await identifyRelease({
        db: input.db,
        arr: input.arr,
        mediaItemId: s.mediaItemId,
      });
      consecutive = 0;
    } catch (error) {
      consecutive += 1;
      logger.warn('[release-block] identity_read_failed', {
        title: s.title,
        error: error instanceof Error ? error.message : String(error),
      });
      if (consecutive >= IDENTITY_FAILURE_LIMIT) return { recordable, unrecorded, aborted: true };
      unrecorded.set(s.key, 'read_failed');
      continue;
    }
    if (identity.status === 'recordable') recordable.set(s.key, identity.drafts);
    else unrecorded.set(s.key, identity.reason);
  }
  return { recordable, unrecorded, aborted: false };
}

export type UnrecordedReason = 'no_term' | 'gone' | 'no_ledger_item' | 'read_failed';

export type RecordAndBlockResult =
  | { aborted: true }
  | {
      aborted: false;
      /** Survivors with records (keyed by the caller's key), in the order given. */
      recordable: Map<string, ReleaseRecordDraft[]>;
      /** Survivors kept `release_unrecorded` (D-11): no term, no delete. */
      unrecorded: Map<string, UnrecordedReason>;
      /** The `in_flight` record ids written for each recordable survivor. */
      recordIds: Map<string, string[]>;
    };

/**
 * DESIGN-052 D-14 steps 4..5 — THE shared seam of the two delete paths (the sweep and Expedite), so they cannot
 * drift: each survivor's identity (three consecutive *arr read failures ⇒ `aborted`, nothing written), each
 * unrecordable survivor handed to `onUnrecorded` BEFORE Phase A, then Phase A for every recordable survivor (records
 * `in_flight`, the Release Block written and read back). A Phase A failure throws ReleaseBlockError (the records are
 * abandoned); the caller pauses (the sweep) or refuses (Expedite).
 */
export async function recordAndBlockReleases(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients;
  survivors: readonly ReleaseSurvivor[];
  origin: Extract<DeletedReleaseOrigin, 'sweep' | 'expedite'>;
  logger?: DomainLogger;
  onUnrecorded?: (key: string, reason: UnrecordedReason) => Promise<void>;
}): Promise<RecordAndBlockResult> {
  const identity = await identifySurvivors({
    db: input.db,
    arr: input.arr.read,
    survivors: input.survivors,
    logger: input.logger,
  });
  if (identity.aborted) return { aborted: true };
  for (const s of input.survivors) {
    const reason = identity.unrecorded.get(s.key);
    if (reason !== undefined) await input.onUnrecorded?.(s.key, reason);
  }
  const recordable = input.survivors.filter((s) => identity.recordable.has(s.key));
  const recordIds =
    recordable.length > 0
      ? await blockReleases({
          db: input.db,
          arr: input.arr,
          items: recordable.map((s) => ({ key: s.key, drafts: identity.recordable.get(s.key) ?? [] })),
          origin: input.origin,
          logger: input.logger,
        })
      : new Map<string, string[]>();
  return {
    aborted: false,
    recordable: identity.recordable,
    unrecorded: identity.unrecorded,
    recordIds,
  };
}

// ---------------------------------------------------------------------------
// D-23 — re-add evidence and visibility
// ---------------------------------------------------------------------------

export interface ReaddCheckReport {
  checked: number;
  stamped: number;
  sameRelease: number;
  failed: number;
}

/**
 * D-23 (ADR-084 E-5) — the hourly re-add check: records `active` / `expired` with no `readd_seen_at` whose title is live
 * again in the ledger under a NEW *arr id (same tmdb id for a movie, tvdb id for a series). Reads that item's grabs from
 * the *arr and tests each release name against the record's term; stamps `readd_seen_at` and `readd_same_release`
 * (true when any grab matches — ruling 2 breached, logged at error). A re-add with no grab yet is re-checked each hour
 * for at most 7 days (then stamped with no verdict). A failure is a warning and never changes the job's exit.
 */
export async function checkReleaseBlockReadds(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients['read'];
  logger?: DomainLogger;
  now?: Date;
}): Promise<ReaddCheckReport> {
  const db = resolveDb(input.db);
  const logger = input.logger ?? consoleDomainLogger;
  const now = input.now ?? new Date();
  const t = trashDeletedReleases;
  const rows = await db
    .select({
      id: t.id,
      arrKind: t.arrKind,
      arrItemId: t.arrItemId,
      tmdbId: t.tmdbId,
      tvdbId: t.tvdbId,
      title: t.title,
      term: t.term,
      liveArrItemId: mediaItems.arrItemId,
      liveFirstSeenAt: mediaItems.firstSeenAt,
    })
    .from(t)
    .innerJoin(
      mediaItems,
      and(
        eq(mediaItems.arrKind, t.arrKind),
        isNull(mediaItems.deletedFromArrAt),
        sql`${mediaItems.arrItemId} IS DISTINCT FROM ${t.arrItemId}`,
        sql`((${t.arrKind} = 'radarr' AND ${mediaItems.tmdbId} = ${t.tmdbId}) OR (${t.arrKind} = 'sonarr' AND ${mediaItems.tvdbId} = ${t.tvdbId}))`,
      ),
    )
    .where(and(inArray(t.state, ['active', 'expired']), isNull(t.readdSeenAt)));
  const report: ReaddCheckReport = { checked: 0, stamped: 0, sameRelease: 0, failed: 0 };
  for (const r of rows) {
    report.checked += 1;
    let grabs: string[];
    try {
      const history =
        r.arrKind === 'radarr'
          ? await input.arr.radarr.getMovieReleaseHistory(r.liveArrItemId)
          : await input.arr.sonarr.getSeriesReleaseHistory(r.liveArrItemId);
      grabs = history
        .filter((h) => h.eventType === GRAB && h.sourceTitle)
        .map((h) => h.sourceTitle as string);
    } catch (error) {
      report.failed += 1;
      logger.warn('[release-block] readd_check_failed', {
        arrKind: r.arrKind,
        recordId: r.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const expiredWindow =
      now.getTime() - r.liveFirstSeenAt.getTime() > RELEASE_READD_WINDOW_DAYS * DAY_MS;
    if (grabs.length === 0 && !expiredWindow) continue; // no grab yet: look again next hour
    const same = r.term !== null && grabs.some((g) => termMatches(r.term as string, g));
    await db
      .update(t)
      .set({ readdSeenAt: now, readdSameRelease: grabs.length === 0 ? null : same })
      .where(eq(t.id, r.id));
    report.stamped += 1;
    if (same) report.sameRelease += 1;
    const fields = {
      arrKind: r.arrKind,
      recordId: r.id,
      title: r.title,
      grabs: grabs.length,
      sameRelease: grabs.length === 0 ? null : same,
    };
    if (same) logger.error('[release-block] readd', fields);
    else logger.info('[release-block] readd', fields);
  }
  return report;
}

export interface ReleaseBlockKindSummary {
  arrKind: ReleaseArrKind;
  /** Distinct live terms (in flight or active) in the profile, and the cap. */
  terms: number;
  cap: number;
  /** Age in days of the oldest live term's record (null: none). */
  oldestTermDays: number | null;
  /** The *arr's import-list exclusion count, read live (null: the *arr did not answer). */
  importListExclusions: number | null;
}

export interface ReleaseBlockSummary {
  kinds: ReleaseBlockKindSummary[];
  /** D-23 / D-25bh — TITLES re-added over the last 30 days (a series or a remediated movie has several records; a title
   *  counts once), how many fetched a blocked release, and how many had no grab within the 7-day window (seen, no
   *  verdict). The rest fetched a different release. */
  readds: { total: number; sameRelease: number; noGrab: number; windowDays: number };
}

/** D-23 — the Watchlists card's Release Block and re-add counts (never a title). */
export async function getReleaseBlockSummary(input: {
  db?: DbClient;
  arr?: Pick<ReleaseBlockArrClients, 'read'> | null;
  now?: Date;
}): Promise<ReleaseBlockSummary> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const t = trashDeletedReleases;
  const kinds: ReleaseBlockKindSummary[] = [];
  for (const kind of ['radarr', 'sonarr'] as const) {
    const [agg] = await db
      .select({
        terms: sql<number>`count(distinct ${t.term})::int`,
        oldest: sql<Date | null>`min(${t.recordedAt})`,
      })
      .from(t)
      .where(
        and(eq(t.arrKind, kind), inArray(t.state, ['in_flight', 'active']), isNotNull(t.term)),
      );
    let exclusions: number | null = null;
    if (input.arr) {
      try {
        exclusions =
          kind === 'radarr'
            ? await input.arr.read.radarr.countImportListExclusions()
            : await input.arr.read.sonarr.countImportListExclusions();
      } catch {
        exclusions = null;
      }
    }
    const oldest = agg?.oldest ? new Date(agg.oldest) : null;
    kinds.push({
      arrKind: kind,
      terms: agg?.terms ?? 0,
      cap: RELEASE_BLOCK_TERM_CAP,
      oldestTermDays: oldest ? Math.floor((now.getTime() - oldest.getTime()) / DAY_MS) : null,
      importListExclusions: exclusions,
    });
  }
  const since = new Date(now.getTime() - RELEASE_READD_REPORT_DAYS * DAY_MS);
  // One row per re-added TITLE (the record's kind and its tmdb id for a movie, tvdb id for a series).
  const titles = db
    .select({
      same: sql<boolean>`coalesce(bool_or(${t.readdSameRelease} IS TRUE), false)`.as('same'),
      noGrab: sql<boolean>`bool_and(${t.readdSameRelease} IS NULL)`.as('no_grab'),
    })
    .from(t)
    .where(and(isNotNull(t.readdSeenAt), gte(t.readdSeenAt, since)))
    .groupBy(
      t.arrKind,
      sql`coalesce((CASE WHEN ${t.arrKind} = 'radarr' THEN ${t.tmdbId} ELSE ${t.tvdbId} END)::text, ${t.id}::text)`,
    )
    .as('titles');
  const [readd] = await db
    .select({
      total: sql<number>`count(*)::int`,
      same: sql<number>`count(*) filter (where ${titles.same})::int`,
      noGrab: sql<number>`count(*) filter (where ${titles.noGrab} AND NOT ${titles.same})::int`,
    })
    .from(titles);
  return {
    kinds,
    readds: {
      total: readd?.total ?? 0,
      sameRelease: readd?.same ?? 0,
      noGrab: readd?.noGrab ?? 0,
      windowDays: RELEASE_READD_REPORT_DAYS,
    },
  };
}
