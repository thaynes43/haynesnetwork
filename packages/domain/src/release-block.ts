// ADR-093 C-07..C-09 / C-15 / C-19 / DESIGN-052 D-11..D-14 / D-21 / D-23 (PLAN-072 S2) — the DELETED-RELEASE RECORD
// (T-264) and the RELEASE BLOCK (T-265).
//
// Before the sweep or Expedite deletes an item, it records every posted release name it can show was fetched for the
// title (ADR-117, D-29: the *arr's history, the ledger and the legacy tables, a failed or replaced grab included),
// derives a "must not contain" term from each (D-12, release-terms.ts) and writes the terms into ONE app-owned release
// profile per Radarr and Sonarr, reading it back (D-13). Only then does the Maintainerr handle run. A record turns
// `active` once the *arr answers 404 for the item (the delete really happened); a failed handle, or an item the *arr
// still has, turns it `abandoned` and its term leaves the profile on the next reconcile, so a term never blocks the
// current release of a title that is still there (D-14 step 7). An item whose release cannot be recorded is KEPT
// (`release_unrecorded`, D-11): no term, no delete. So is an item whose file on disk has no verified posted name
// (`release_unverified`, D-29, owner ruling 2026-11-13): a name rebuilt from the renamed file is never a basis for a
// delete. And so is one whose terms would not all fit under the cap (`release_block_full`): nothing older is pruned.
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
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { ReleaseBlockError, TitleExclusionError, type ReleaseBlockStep } from './errors';
import {
  ensureTitleExclusions,
  isTitleExclusionTarget,
  type TitleExclusionArrClients,
  type TitleExclusionTarget,
} from './title-exclusion';
import { matchLegacySab, postedReleaseName } from './release-block-names';
import { FOLDER_IMPORT_EVENT_TYPES } from './trash-release-name';
import {
  legacyNamesOfFile,
  readLegacyJobsForSize,
  readLegacyReleaseNames,
  type LegacyReleaseName,
} from './release-block-legacy';
import {
  RELEASE_BLOCK_PROFILE_NAME,
  RELEASE_BLOCK_SENTINEL,
  deriveTerm,
  deriveTermsPerName,
  isGrammarTerm,
  looksLikeRelease,
  parseReleaseName,
  releaseBaseName,
  releaseTokens,
  resolutionFromQualityName,
  termMatches,
  termMatchesRaw,
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

export interface ReleaseBlockArrClients extends TitleExclusionArrClients {
  read: {
    radarr: Pick<
      RadarrClient,
      | 'findMovie'
      | 'listMovieFiles'
      | 'getMovieReleaseHistory'
      | 'countImportListExclusions'
      | 'listImportListExclusions'
    >;
    sonarr: Pick<
      SonarrClient,
      | 'findSeries'
      | 'listEpisodeFileReleases'
      | 'getSeriesReleaseHistory'
      | 'countImportListExclusions'
      | 'listImportListExclusions'
    >;
  };
  /** ADR-097 / D-27 — `addImportListExclusion` is the Title Exclusion write the delete paths run before Phase A. */
  write: {
    radarr: Pick<
      RadarrWriteClient,
      'listReleaseProfiles' | 'createReleaseProfile' | 'updateReleaseProfile' | 'addImportListExclusion'
    >;
    sonarr: Pick<
      SonarrWriteClient,
      'listReleaseProfiles' | 'createReleaseProfile' | 'updateReleaseProfile' | 'addImportListExclusion'
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
  /** D-25bq — a real release name matched the term only folded (the *arr will not block it); counted by S6(e). */
  foldOnly?: boolean;
  /** D-25cr — a renamed-only term's widened years left out because another title of the same name holds them. */
  namesakeYears?: number[];
}

export type ReleaseIdentity =
  | {
      status: 'recordable';
      drafts: ReleaseRecordDraft[];
      /** D-29 — posted names left without a term because they name no release a term could hold (a season-0
       *  special, a bare title). Counted in the sweep's outcome; a name that carries any mark of a release and
       *  yields no term keeps the title instead (`no_term`). */
      skippedNames: number;
    }
  | {
      status: 'unrecordable';
      /** `no_term`: a name of the title yields no term the *arr would match (D-12's self-check, or a read of its
       *  names that did not finish); `gone`: the *arr no longer has the item and the ledger cannot name its release;
       *  `no_ledger_item`: not in our ledger; `id_mismatch` (D-25ci): the *arr item at the ledger's id is another
       *  title (an *arr rebuild reassigned ids); `unverified_name` (D-29): a file on disk has no verified posted
       *  name, only the name the *arr rebuilt when it renamed the file. */
      reason: 'no_term' | 'gone' | 'no_ledger_item' | 'id_mismatch' | 'unverified_name';
    };

/**
 * D-25ci — is the *arr item read at an `arr_item_id` the title we mean? Maintainerr deletes by tmdb (Radarr) or tvdb
 * (Sonarr), and `media_items.arr_item_id` is not stable across an *arr rebuild until the next sync, so an identity read
 * or a settle by id must check the external id. An id unknown on either side (null, or the *arr's 0) never disagrees.
 */
export function isSameArrTitle(
  kind: ReleaseArrKind,
  item: { tmdbId?: number | null; tvdbId?: number | null },
  expected: { tmdbId: number | null; tvdbId: number | null },
): boolean {
  const known = (id: number | null | undefined): id is number => typeof id === 'number' && id > 0;
  const [have, want] = kind === 'radarr' ? [item.tmdbId, expected.tmdbId] : [item.tvdbId, expected.tvdbId];
  return !known(have) || !known(want) || have === want;
}

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
        // ADR-117 / D-29 — a folder import (a library scan) names the renamed file, never a posted release: it is
        // no import of a download. Measured 2026-11-13: the ledger holds none (1,611 Radarr and 25,352 Sonarr
        // imports, every one `downloadFolderImported`); the filter keeps it that way.
        sql`coalesce(${ledgerEvents.payload}->>'rawEventType', '') NOT IN (${sql.join(
          FOLDER_IMPORT_EVENT_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})`,
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
    foldOnly: derived.foldOnly,
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
    if (!ledger) return null;
    const draft = ledgerDraft('radarr', mediaItemId, s, ledger, arrYears, null);
    if (draft === null) return null;
    // D-25bp — the import and its grab can name the release differently; an exact fallback blocks only the first
    // name, so each distinct name then gets its own record, and a name with no term keeps the movie.
    const names = distinct(ledger.sourceTitles);
    if (draft.shape !== 'exact' || names.length <= 1) return [draft];
    const drafts: ReleaseRecordDraft[] = [];
    for (const name of names) {
      const one = ledgerDraft('radarr', mediaItemId, s, { ...ledger, sourceTitles: [name] }, arrYears, null);
      if (one === null) return null;
      drafts.push(one);
    }
    return drafts;
  }
  const ledger = await ledgerReleases(db, mediaItemId, before, 200);
  // D-25bc — every import of a (season, group, resolution) key counts, never only the newest: the key's group term
  // must match every import name of the key (one record), else each distinct release name gets its own record, and a
  // key where any name yields no term fails the whole series closed (it is kept, or counted unblockable by the seed).
  const byKey = new Map<string, { season: number; imports: LedgerRelease[] }>();
  const drafts: ReleaseRecordDraft[] = [];
  for (const l of ledger) {
    const parsed = parseReleaseName(l.sourceTitles[0] ?? '');
    if (parsed.season === null) {
      // D-25ct — an import that names no season (a daily episode, a complete-series pack) is no key's, but its release
      // is still what a re-request would fetch: each of its names gets its own exact record (the live path's per-name
      // fallback), and one with no name or no term fails the series closed, like a key's.
      const names = distinct(l.sourceTitles);
      if (names.length === 0) return null;
      for (const name of names) {
        const draft = ledgerDraft('sonarr', mediaItemId, s, { ...l, sourceTitles: [name] }, arrYears, null);
        if (!draft || draft.term === null) return null;
        drafts.push(draft);
      }
      continue;
    }
    if (parsed.season < 1) continue; // specials (season 0) are skipped, as on the live path (D-11)
    const key = `${parsed.season}|${(l.releaseGroup ?? parsed.group ?? '').toLowerCase()}|${resolutionFromQualityName(l.quality) ?? parsed.resolution}`;
    const entry = byKey.get(key) ?? { season: parsed.season, imports: [] };
    entry.imports.push(l);
    byKey.set(key, entry);
  }
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

/**
 * ADR-117 / DESIGN-052 D-29 — one posted release name the app can show was fetched for the title: a Radarr or
 * Sonarr history `grabbed` or `downloadFailed` row, a ledger `grabbed` or `download_failed` row, a row of the
 * legacy tables for the title's own id (grabbed, imported, failed, or a file's original name), or an old download
 * job the D-15 size rule matches. `name` is the name AS STORED, never trimmed (review F3). A string containing
 * "://" is never a name.
 */
export interface PostedRelease {
  name: string;
  releaseGroup: string | null;
  quality: string | null;
  indexer: string | null;
  source: Extract<
    DeletedReleaseIdentitySource,
    'arr_grab_history' | 'ledger_grab' | 'legacy_arr' | 'legacy_sab'
  >;
  sizeBytes: number | null;
}

/** D-29 (review F4) — the ledger's grabs and failed downloads of one title are read this many rows at a time. */
export const POSTED_LEDGER_PAGE_SIZE = 500;
/**
 * D-29 — and at most this many pages (20,000 rows). Measured 2026-11-13 (review F4): the longest series has 1,228
 * such rows. Past the bound the read is `truncated` and the title is kept: a name not read is a release not blocked.
 */
export const POSTED_LEDGER_MAX_PAGES = 40;

function uniquePosted(rows: Array<PostedRelease | null>): PostedRelease[] {
  const seen = new Set<string>();
  const out: PostedRelease[] = [];
  for (const row of rows) {
    if (!row || seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return out;
}

function historyPostedReleases(history: readonly ArrReleaseHistoryRecord[]): PostedRelease[] {
  const byDate = [...history].sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''));
  return uniquePosted(
    byDate
      .filter((h) => h.eventType === GRAB || h.eventType === 'downloadFailed')
      .map((h) => {
        const name = postedReleaseName(h.sourceTitle);
        if (!name) return null;
        return {
          name,
          releaseGroup: h.releaseGroup ?? null,
          quality: h.qualityName ?? null,
          indexer: h.indexer ?? null,
          source: 'arr_grab_history' as const,
          sizeBytes: null,
        };
      }),
  );
}

/**
 * D-29 — every ledger grab and failed download of one title at or before `before`, newest first, read in pages by
 * keyset (`occurred_at`, `id`), so a row the sync inserts between two pages is neither skipped nor read twice. The
 * cursor is the row's own timestamp text: a JavaScript date would drop its microseconds and skip a row. `truncated`
 * when the page bound is reached with rows still to read.
 */
export async function ledgerPostedReleases(
  db: DbClient | undefined,
  mediaItemId: string,
  before: Date,
  paging: { pageSize?: number; maxPages?: number } = {},
): Promise<PostedRelease[] | 'truncated'> {
  const pageSize = paging.pageSize ?? POSTED_LEDGER_PAGE_SIZE;
  const maxPages = paging.maxPages ?? POSTED_LEDGER_MAX_PAGES;
  const handle = resolveDb(db);
  const rows: Array<PostedRelease | null> = [];
  let cursor: { at: string; id: string } | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const batch: Array<{ id: string; at: string; payload: Record<string, unknown> }> = await handle
      .select({
        id: ledgerEvents.id,
        at: sql<string>`${ledgerEvents.occurredAt}::text`,
        payload: ledgerEvents.payload,
      })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.mediaItemId, mediaItemId),
          inArray(ledgerEvents.eventType, ['grabbed', 'download_failed']),
          lte(ledgerEvents.occurredAt, before),
          cursor === null
            ? undefined
            : sql`(${ledgerEvents.occurredAt}, ${ledgerEvents.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
        ),
      )
      .orderBy(desc(ledgerEvents.occurredAt), desc(ledgerEvents.id))
      .limit(pageSize);
    for (const row of batch) {
      const name = postedReleaseName(payloadString(row.payload, 'sourceTitle'));
      rows.push(
        name === null
          ? null
          : {
              name,
              releaseGroup: payloadString(row.payload, 'releaseGroup'),
              quality: payloadString(row.payload, 'quality'),
              indexer: payloadString(row.payload, 'indexer'),
              source: 'ledger_grab' as const,
              sizeBytes: null,
            },
      );
    }
    if (batch.length < pageSize) return uniquePosted(rows);
    const last = batch[batch.length - 1] as { id: string; at: string };
    cursor = { at: last.at, id: last.id };
  }
  return 'truncated';
}

/** D-29 — the legacy tables' names of one title, every record kind, as posted releases. */
function legacyPostedReleases(legacy: readonly LegacyReleaseName[]): PostedRelease[] {
  return uniquePosted(
    legacy.map((l) => {
      const name = postedReleaseName(l.releaseName);
      if (!name) return null;
      return {
        name,
        releaseGroup: l.releaseGroup,
        quality: l.quality,
        indexer: null,
        source: 'legacy_arr' as const,
        sizeBytes: l.sizeBytes,
      };
    }),
  );
}

/**
 * D-29 — any mark of a release in a raw name: a resolution, a source, a codec or an episode marker. A posted name
 * that carries one and yields no term is a release the grammar cannot write (a leading bracket or quote, a part
 * counter, a fansub layout; review F4): the title is kept, never deleted with that release unblocked.
 */
const RELEASE_MARK =
  /(?:^|[^a-z0-9])(?:2160p|1080[pi]|720p|576p|480p|x26[45]|h\.?26[45]|hevc|xvid|divx|blu-?ray|bdrip|brrip|dvdrip|web-?dl|webrip|hdtv|remux|s\d{1,3}e\d{1,3})(?:[^a-z0-9]|$)/i;

/**
 * D-29 — one draft for one posted name. `untermed` when the name names a release and no term the *arr would match
 * can be built (the live delete is then kept; the backfill counts it and still records the names that did term).
 * `skip` when the name names nothing a term could hold: a Sonarr season-0 special (D-11), or a name with no mark
 * of a release at all (a bare title). The term is built from, and checked against, the name as stored (review F3):
 * a raw miss is `untermed`.
 */
export function draftForVerifiedName(input: {
  arrKind: ReleaseArrKind;
  arrItemId: number | null;
  mediaItemId: string | null;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  arrYears: Array<number | null>;
  posted: PostedRelease;
}): ReleaseRecordDraft | 'untermed' | 'skip' {
  const name = input.posted.name;
  const years = input.arrYears.filter((y): y is number => typeof y === 'number');
  const parsed = parseReleaseName(name, years);
  if (input.arrKind === 'sonarr' && parsed.season === 0) return 'skip';
  const season = input.arrKind === 'sonarr' ? parsed.season : null;
  const derived = deriveTerm({
    kind: input.arrKind === 'radarr' ? 'movie' : 'show',
    arrTitle: input.title,
    arrYears: input.arrYears,
    releaseNames: [name],
    renamedFileName: null,
    releaseGroup: input.posted.releaseGroup ?? parsed.group,
    resolution: resolutionFromQualityName(input.posted.quality) ?? parsed.resolution,
    remux: isRemuxQuality(input.posted.quality, null) || parsed.remux === true,
    season,
  });
  // The *arr tests the stored name as it is: a term that misses it raw (surrounding spaces, a fold-only match)
  // blocks nothing, so the name has no term.
  if (!derived || !termMatchesRaw(derived.term, name)) {
    return looksLikeRelease(parseReleaseName(name.trim(), years)) || RELEASE_MARK.test(name)
      ? 'untermed'
      : 'skip';
  }
  return {
    arrKind: input.arrKind,
    arrItemId: input.arrItemId,
    mediaItemId: input.mediaItemId,
    tmdbId: input.tmdbId,
    tvdbId: input.tvdbId,
    imdbId: input.imdbId,
    title: input.title,
    year: input.year,
    season,
    identitySource: input.posted.source,
    releaseTitle: name,
    releaseGroup: input.posted.releaseGroup ?? parsed.group,
    quality: input.posted.quality,
    resolution: resolutionFromQualityName(input.posted.quality) ?? parsed.resolution,
    sizeBytes: input.posted.sizeBytes,
    fileName: null,
    indexer: input.posted.indexer,
    years: derived.years,
    term: derived.term,
    termConfidence: derived.confidence,
    shape: derived.shape,
    foldOnly: derived.foldOnly,
    namesakeYears: derived.namesakeYears,
  };
}

function dedupeDraftsByTerm(drafts: readonly ReleaseRecordDraft[]): ReleaseRecordDraft[] {
  const seen = new Set<string>();
  const out: ReleaseRecordDraft[] = [];
  for (const draft of drafts) {
    if (draft.term !== null) {
      const key = `${draft.arrKind}|${draft.season ?? ''}|${draft.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(draft);
  }
  return out;
}

const positiveId = (n: number | null | undefined): number | null =>
  typeof n === 'number' && n > 0 ? n : null;

/**
 * D-29 — the drafts of the file on disk (every one built from a verified name; the callers keep a title whose file
 * has none), then one draft per other posted name of the title: the *arr's history, the ledger, the legacy tables,
 * and for a movie the old download jobs the D-15 size rule matches. Every name gets a term or the title is kept:
 * a name that names a release and yields no term (`untermed`), a term that matches one of its own names only when
 * folded, or a read that did not finish, is `no_term`. Nothing is ever dropped because another source matched
 * (review F1): the size match only adds.
 */
async function withEveryPostedName(input: {
  db?: DbClient;
  mediaItemId: string;
  before: Date;
  arrKind: ReleaseArrKind;
  arrItemId: number | null;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  arrYears: Array<number | null>;
  history: readonly ArrReleaseHistoryRecord[];
  /** The legacy tables' rows for this title's id (already read; the caller keeps the title on `truncated`). */
  legacy: readonly LegacyReleaseName[];
  /** A movie's file size, for the old download jobs' size match. A series never matches that way. */
  fileSize?: number | null;
  drafts: ReleaseRecordDraft[];
  /** `gone` when the *arr no longer has the item and nothing names a release. */
  emptyReason: 'no_term' | 'gone';
}): Promise<ReleaseIdentity> {
  // A term that matches a real name of the file only when folded is one the *arr would not apply to it.
  if (input.drafts.some((d) => d.foldOnly === true)) return { status: 'unrecordable', reason: 'no_term' };
  const ledger = await ledgerPostedReleases(input.db, input.mediaItemId, input.before);
  if (ledger === 'truncated') return { status: 'unrecordable', reason: 'no_term' };
  const jobs =
    input.arrKind === 'radarr'
      ? uniquePosted(
          matchLegacySab(
            {
              title: input.title,
              year: input.year,
              deletedAt: input.before,
              deletedSizeBytes: input.fileSize ?? null,
            },
            await readLegacyJobsForSize(input.db, input.fileSize ?? null),
          ).map((job) => {
            const name = postedReleaseName(job.name);
            if (!name) return null;
            return {
              name,
              releaseGroup: null,
              quality: null,
              indexer: null,
              source: 'legacy_sab' as const,
              sizeBytes: job.bytes,
            };
          }),
        )
      : [];
  const posted = [
    ...historyPostedReleases(input.history),
    ...ledger,
    ...legacyPostedReleases(input.legacy),
    ...jobs,
  ];
  const known = new Set(
    input.drafts
      .map((d) => d.releaseTitle)
      .filter((name): name is string => name !== null && name.length > 0),
  );
  const extras: ReleaseRecordDraft[] = [];
  let skippedNames = 0;
  for (const name of posted) {
    if (known.has(name.name)) continue;
    known.add(name.name);
    const built = draftForVerifiedName({
      arrKind: input.arrKind,
      arrItemId: input.arrItemId,
      mediaItemId: input.mediaItemId,
      title: input.title,
      year: input.year,
      tmdbId: input.tmdbId,
      tvdbId: input.tvdbId,
      imdbId: input.imdbId,
      arrYears: input.arrYears,
      posted: name,
    });
    if (built === 'untermed') return { status: 'unrecordable', reason: 'no_term' };
    if (built === 'skip') {
      skippedNames += 1;
      continue;
    }
    extras.push(built);
  }
  const drafts = dedupeDraftsByTerm([...input.drafts, ...extras]);
  if (drafts.length === 0) return { status: 'unrecordable', reason: input.emptyReason };
  return { status: 'recordable', drafts, skippedNames };
}

/**
 * D-29 — a title already gone from the *arr. There is no file to read, so the ledger's imports are the only record
 * of what was on disk: without one that names a release the title is kept (`gone`), as before ADR-117. With one,
 * every other posted name of the title (the ledger's grabs and failed downloads, the legacy tables) is recorded
 * beside it.
 */
async function identifyGone(input: {
  db?: DbClient;
  kind: ReleaseArrKind;
  mediaItemId: string;
  s: SubjectRow;
  before: Date;
  arrYears: Array<number | null>;
}): Promise<ReleaseIdentity> {
  const drafts = await ledgerDrafts(input.db, input.kind, input.mediaItemId, input.s, input.before);
  if (drafts === null) return { status: 'unrecordable', reason: 'gone' };
  const legacy = await readLegacyReleaseNames(
    input.db,
    input.kind,
    positiveId(input.kind === 'radarr' ? input.s.tmdbId : input.s.tvdbId),
  );
  if (legacy === 'truncated') return { status: 'unrecordable', reason: 'no_term' };
  return withEveryPostedName({
    db: input.db,
    mediaItemId: input.mediaItemId,
    before: input.before,
    arrKind: input.kind,
    arrItemId: input.s.arrItemId,
    title: input.s.title,
    year: input.s.year,
    tmdbId: input.s.tmdbId,
    tvdbId: input.s.tvdbId,
    imdbId: input.s.imdbId,
    arrYears: input.arrYears,
    history: [],
    legacy,
    drafts,
    emptyReason: 'gone',
  });
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

/** A term-less evidence record for an item with no file (nothing on disk to fetch again). */
function noFileDraft(
  kind: ReleaseArrKind,
  mediaItemId: string,
  s: SubjectRow,
  over: Partial<Pick<ReleaseRecordDraft, 'title' | 'year'>>,
): ReleaseRecordDraft {
  return {
    ...baseDraft(kind, mediaItemId, s),
    ...over,
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
  };
}

async function identifyMovie(
  db: DbClient | undefined,
  radarr: ReleaseBlockArrClients['read']['radarr'],
  mediaItemId: string,
  s: SubjectRow,
  before: Date,
): Promise<ReleaseIdentity> {
  const movie = await radarr.findMovie(s.arrItemId);
  // D-25ci — another title at this id: record nothing (the item is kept `release_unrecorded`), never its release.
  if (movie !== null && !isSameArrTitle('radarr', movie, s)) return { status: 'unrecordable', reason: 'id_mismatch' };
  const arrYears = [movie?.year ?? s.year ?? null, movie?.secondaryYear ?? null];
  if (movie === null) {
    // Gone from Radarr already: the ledger's imports, plus every other posted name of the title (D-29).
    return identifyGone({ db, kind: 'radarr', mediaItemId, s, before, arrYears });
  }
  const tmdbId = positiveId(movie.tmdbId) ?? positiveId(s.tmdbId);
  const legacy = await readLegacyReleaseNames(db, 'radarr', tmdbId);
  // A read that did not finish may hide a name: keep the title.
  if (legacy === 'truncated') return { status: 'unrecordable', reason: 'no_term' };
  const files = await radarr.listMovieFiles(s.arrItemId);
  const file = files.find((f) => f.id === movie.movieFileId) ?? files[0];
  const common = {
    db,
    mediaItemId,
    before,
    arrKind: 'radarr' as const,
    arrItemId: s.arrItemId,
    title: movie.title,
    year: movie.year,
    tmdbId: tmdbId ?? s.tmdbId,
    tvdbId: s.tvdbId,
    imdbId: movie.imdbId ?? s.imdbId,
    arrYears,
    legacy,
    emptyReason: 'no_term' as const,
  };
  if (!file) {
    // No file on disk, so nothing there to name. The evidence row stays, and every posted name the history, the
    // ledger or the legacy tables hold is blocked too (D-29): a failed download is still a release a re-request
    // must not fetch.
    return withEveryPostedName({
      ...common,
      history: await radarr.getMovieReleaseHistory(s.arrItemId),
      drafts: [noFileDraft('radarr', mediaItemId, s, { year: movie.year })],
    });
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
  // block that old release and not the file being deleted.
  const useLedger =
    arrNames.length === 0 &&
    ledger !== undefined &&
    ledger.sourceTitles.length > 0 &&
    ledgerAgreesWithFile(ledger, fileGroup, resolution);
  // D-29 — the legacy file records of this title with the file's IDENTICAL byte size name it too (exact, never a
  // ratio): Radarr renamed the file on import, and its own record of the original name went with the 2026-07-03
  // rebuild, but the old database still has it.
  const legacyFile = legacyNamesOfFile(legacy, { sizeBytes: file.size });
  const names = distinct([
    ...(useLedger ? ledger!.sourceTitles : arrNames),
    ...legacyFile.map((l) => postedReleaseName(l.releaseName)),
  ]);
  // D-29 (owner ruling 2026-11-13) — the file on disk has no verified posted name: only the name Radarr rebuilt
  // when it renamed the file is known, and that is never a basis for a delete. The title is kept.
  if (names.length === 0) return { status: 'unrecordable', reason: 'unverified_name' };
  const releaseGroup =
    fileGroup ?? (useLedger ? ledger!.releaseGroup : null) ?? legacyFile.find((l) => l.releaseGroup)?.releaseGroup ?? null;
  // D-25bp — every real name of the file must be blocked: the grab title, the scene name, the original file name and
  // the legacy record can each name the release differently, and the exact fallback blocks only the first.
  // `deriveTermsPerName` gives one record per name then, or null when a name yields no term (the movie is kept
  // `release_unrecorded`).
  const derivations = deriveTermsPerName({
    kind: 'movie',
    arrTitle: movie.title,
    arrYears,
    releaseNames: names,
    renamedFileName: file.relativePath ?? null,
    releaseGroup,
    resolution,
    remux: isRemuxQuality(q?.name, q?.modifier),
    namesakes: [],
  });
  if (!derivations) return { status: 'unrecordable', reason: 'no_term' };
  const identitySource: DeletedReleaseIdentitySource = grab?.sourceTitle
    ? 'arr_grab_history'
    : useLedger
      ? 'ledger_grab'
      : arrNames.length > 0
        ? 'arr_file'
        : 'legacy_arr';
  const fileDrafts = derivations.map(({ name, derived }) => ({
    ...baseDraft('radarr', mediaItemId, s),
    title: movie.title,
    year: movie.year,
    tmdbId: tmdbId ?? s.tmdbId,
    imdbId: movie.imdbId ?? s.imdbId,
    season: null,
    identitySource,
    releaseTitle: name ?? names[0] ?? null,
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
    foldOnly: derived.foldOnly,
    namesakeYears: derived.namesakeYears,
  }));
  return withEveryPostedName({
    ...common,
    history,
    fileSize: file.size ?? null,
    drafts: fileDrafts,
  });
}

async function identifySeries(
  db: DbClient | undefined,
  sonarr: ReleaseBlockArrClients['read']['sonarr'],
  mediaItemId: string,
  s: SubjectRow,
  before: Date,
): Promise<ReleaseIdentity> {
  const series = await sonarr.findSeries(s.arrItemId);
  if (series !== null && !isSameArrTitle('sonarr', series, s)) return { status: 'unrecordable', reason: 'id_mismatch' };
  const arrYears = [series?.year ?? s.year ?? null];
  if (series === null) {
    // Gone from Sonarr already: the ledger's imports, plus every other posted name of the title (D-29).
    return identifyGone({ db, kind: 'sonarr', mediaItemId, s, before, arrYears });
  }
  const tvdbId = positiveId(series.tvdbId) ?? positiveId(s.tvdbId);
  const legacy = await readLegacyReleaseNames(db, 'sonarr', tvdbId);
  if (legacy === 'truncated') return { status: 'unrecordable', reason: 'no_term' };
  const files = (await sonarr.listEpisodeFileReleases(s.arrItemId)).filter(
    (f) => (f.seasonNumber ?? 0) >= 1, // specials (season 0) are skipped (D-11)
  );
  const common = {
    db,
    mediaItemId,
    before,
    arrKind: 'sonarr' as const,
    arrItemId: s.arrItemId,
    title: series.title,
    year: series.year,
    tmdbId: s.tmdbId,
    tvdbId: tvdbId ?? s.tvdbId,
    imdbId: s.imdbId,
    arrYears,
    legacy,
    emptyReason: 'no_term' as const,
  };
  if (files.length === 0) {
    return withEveryPostedName({
      ...common,
      history: await sonarr.getSeriesReleaseHistory(s.arrItemId),
      drafts: [noFileDraft('sonarr', mediaItemId, s, { title: series.title, year: series.year })],
    });
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
    fromArr: boolean;
  }
  const facts: FileFacts[] = files.map((f) => {
    const { grab, imported } = joinFileToGrab(f, history);
    const arrNames = distinct([
      grab?.sourceTitle,
      f.sceneName,
      nameFromOriginalPath(f.originalFilePath),
    ]);
    // D-29 — a legacy file record of this series, in the file's season, with its IDENTICAL byte size names it too.
    const legacyFile = legacyNamesOfFile(legacy, { sizeBytes: f.size, season: f.seasonNumber as number });
    const names = distinct([...arrNames, ...legacyFile.map((l) => postedReleaseName(l.releaseName))]);
    const q = f.quality?.quality;
    const group =
      f.releaseGroup ??
      grab?.releaseGroup ??
      imported?.releaseGroup ??
      legacyFile.find((l) => l.releaseGroup)?.releaseGroup ??
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
      fromArr: arrNames.length > 0,
    };
  });
  // D-29 (owner ruling 2026-11-13) — every file on disk needs a verified posted name of its own. One episode file
  // with only its renamed name keeps the whole series: a group term guessed from its siblings is not a verified name.
  if (facts.some((f) => f.names.length === 0)) return { status: 'unrecordable', reason: 'unverified_name' };
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
    // exact record (D-25ah, D-25bb).
    const exactPerName = () =>
      names.map((n) => ({
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
    let derivations: Array<{ name: string | null; derived: ReturnType<typeof deriveTerm> }>;
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
        namesakes: [],
      });
      derivations =
        derived !== null && derived.shape === 'exact'
          ? exactPerName()
          : [{ name: names[0] ?? null, derived }];
    }
    for (const d of derivations) {
      if (d.derived === null) return { status: 'unrecordable', reason: 'no_term' };
      drafts.push({
        ...baseDraft('sonarr', mediaItemId, s),
        title: series.title,
        year: series.year,
        tvdbId: tvdbId ?? s.tvdbId,
        season: first.season,
        identitySource: group.some((f) => f.fromGrab)
          ? 'arr_grab_history'
          : group.some((f) => f.fromArr)
            ? 'arr_file'
            : 'legacy_arr',
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
        foldOnly: d.derived.foldOnly,
        namesakeYears: d.derived.namesakeYears,
      });
    }
  }
  return withEveryPostedName({ ...common, history, drafts });
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

/**
 * ADR-117 / D-29 — the backfill's settle: its `in_flight` records turn `active` once the profile holding their terms
 * has been written and read back (the titles are already gone, so there is no delete to wait for).
 */
export async function activateReleaseRecords(input: {
  db?: DbClient;
  recordIds: readonly string[];
  at?: Date;
}): Promise<number> {
  if (input.recordIds.length === 0) return 0;
  const at = input.at ?? new Date();
  let activated = 0;
  for (let from = 0; from < input.recordIds.length; from += 1_000) {
    const rows = await resolveDb(input.db)
      .update(trashDeletedReleases)
      .set({ state: 'active', activatedAt: at })
      .where(
        and(
          inArray(trashDeletedReleases.id, input.recordIds.slice(from, from + 1_000)),
          eq(trashDeletedReleases.state, 'in_flight'),
        ),
      )
      .returning({ id: trashDeletedReleases.id });
    activated += rows.length;
  }
  return activated;
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
 * one PUT each, validated and read back). On failure the records turn `abandoned`, a best-effort reconcile removes
 * their terms from every profile that may hold them (an *arr that took them, and the failing one when its write may
 * have landed, D-25cd), and the ReleaseBlockError is rethrown: nothing may be deleted.
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
      // D-29 — a delete never makes room by pruning an older term: over the cap this throws `cap`, nothing written.
      await reconcileReleaseBlock({
        db: input.db,
        arr: input.arr,
        arrKind: kind,
        logger,
        now: input.now,
        prune: false,
      });
      done.push(kind);
    }
  } catch (error) {
    await abandonReleaseRecords({ db: input.db, recordIds: [...recordIds.values()].flat() });
    // D-25al / D-25cd — remove every term of the abandoned records from each profile that may hold them: the *arrs
    // that took them, and the one that failed when its write may have landed (a POST or PUT whose answer was lost, or a
    // `read_back` after a write; `mayHaveWritten`). A `validate` or `duplicate_profile` failure, or a profile list that
    // never answered, wrote nothing. Best effort: the upkeep's drift check (D-25ce) removes whatever is left.
    const failed = error instanceof ReleaseBlockError && error.mayHaveWritten ? error.arrKind : null;
    for (const kind of kinds.filter((k) => done.includes(k) || k === failed)) {
      try {
        await reconcileReleaseBlock({ db: input.db, arr: input.arr, arrKind: kind, logger, prune: false });
      } catch {
        // best effort: the upkeep's drift check removes the orphan terms
      }
    }
    throw error;
  }
  return recordIds;
}

/** D-25ci — the external ids the records were written with (one item's records share them). */
async function recordExternalIds(
  db: DbClient | undefined,
  recordIds: readonly string[],
): Promise<{ tmdbId: number | null; tvdbId: number | null }> {
  const [row] = await resolveDb(db)
    .select({ tmdbId: trashDeletedReleases.tmdbId, tvdbId: trashDeletedReleases.tvdbId })
    .from(trashDeletedReleases)
    .where(inArray(trashDeletedReleases.id, [...recordIds]))
    .limit(1);
  return { tmdbId: row?.tmdbId ?? null, tvdbId: row?.tvdbId ?? null };
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
  let present: { tmdbId?: number | null; tvdbId?: number | null } | null;
  try {
    present =
      input.arrKind === 'radarr'
        ? await input.arr.radarr.findMovie(input.arrItemId)
        : await input.arr.sonarr.findSeries(input.arrItemId);
  } catch {
    return 'in_flight';
  }
  // D-25ci — another title at the record's id (an *arr rebuild) is not the item: ours is gone.
  if (present !== null && !isSameArrTitle(input.arrKind, present, await recordExternalIds(input.db, input.recordIds))) {
    present = null;
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

/** D-13 step 1 — the distinct terms of `in_flight` and `active` rows of one *arr, newest first (uncapped). */
export async function readLiveTerms(exec: DbClient, kind: ReleaseArrKind): Promise<string[]> {
  const t = trashDeletedReleases;
  const rows = await resolveDb(exec)
    .select({ term: t.term, newest: sql<Date>`max(${t.recordedAt})`.as('newest') })
    .from(t)
    .where(and(eq(t.arrKind, kind), inArray(t.state, ['in_flight', 'active']), isNotNull(t.term)))
    .groupBy(t.term)
    .orderBy(sql`newest desc`);
  return rows.map((r) => r.term as string);
}

/** How the app's profile on an *arr differs from what the records want (D-25ce). */
export type ReleaseProfileDriftReason = 'missing' | 'duplicate' | 'disabled' | 'edited' | 'terms';

export interface ReleaseProfileDrift {
  reason: ReleaseProfileDriftReason;
  /** Desired terms the profile lacks (the sentinel included). */
  missingTerms: number;
  /** Terms the profile holds that no live record wants (an abandoned record's orphan, a hand edit). */
  extraTerms: number;
}

/**
 * D-13 step 3 / D-25ce — compare the profiles carrying the managed name with the desired state (one profile, enabled,
 * no required terms, every indexer, no tags, `ignored` exactly `desired` as a set). null ⇒ nothing to write.
 */
export function releaseProfileDrift(
  profiles: ReadonlyArray<{
    name?: string | null;
    enabled?: boolean | null;
    required?: readonly string[] | null;
    ignored?: readonly string[] | null;
    indexerId?: number | null;
    tags?: readonly number[] | null;
  }>,
  desired: readonly string[],
): ReleaseProfileDrift | null {
  const ours = profiles.filter((p) => p.name === RELEASE_BLOCK_PROFILE_NAME);
  const want = new Set(desired);
  if (ours.length === 0) return { reason: 'missing', missingTerms: want.size, extraTerms: 0 };
  if (ours.length > 1) return { reason: 'duplicate', missingTerms: 0, extraTerms: 0 };
  const p = ours[0]!;
  const have = new Set(p.ignored ?? []);
  const missingTerms = [...want].filter((x) => !have.has(x)).length;
  const extraTerms = [...have].filter((x) => !want.has(x)).length;
  if (p.enabled !== true) return { reason: 'disabled', missingTerms, extraTerms };
  if ((p.required ?? []).length > 0 || (p.indexerId ?? 0) !== 0 || (p.tags ?? []).length > 0) {
    return { reason: 'edited', missingTerms, extraTerms };
  }
  if (missingTerms > 0 || extraTerms > 0) return { reason: 'terms', missingTerms, extraTerms };
  return null;
}

/**
 * D-13 — `reconcileReleaseBlock({ arrKind })`, the single writer of the app's release profile on one *arr, under
 * `pg_advisory_xact_lock('release-block:<kind>')`:
 *  1. rows past `expires_at` turn `expired`; `in_flight` rows older than an hour are settled against the *arr (404 ⇒
 *     `active`, present ⇒ `abandoned`, unreachable ⇒ left in place); desired = the sentinel + the distinct terms of
 *     `in_flight` and `active` rows, newest first, capped at 3,000 (the oldest `active` rows beyond it are `pruned`);
 *  2. every desired term must pass the D-12 grammar, before any write (`validate`);
 *  3. the profile is found by exact name: none ⇒ POST; one ⇒ PUT only when it differs; more ⇒ `duplicate_profile`;
 *  4. a read-back GET must show every desired term (`read_back`).
 * Idempotent (a set comparison). A hand edit is overwritten; a deleted profile is re-created. With `prune: false`
 * (every delete path and the backfill, ADR-117 / D-29) step 1 throws `cap` in place of pruning.
 */
export async function reconcileReleaseBlock(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients;
  arrKind: ReleaseArrKind;
  logger?: DomainLogger;
  now?: Date;
  /**
   * ADR-117 / D-29 — `false` on a delete path (Phase A) and in the backfill: when the live terms exceed the cap the
   * reconcile throws ReleaseBlockError `cap` and its transaction rolls back, so no older term is ever pruned to make
   * room for a new one. The hourly upkeep leaves it true (D-13's standing rule).
   */
  prune?: boolean;
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
        .select({ id: t.id, arrItemId: t.arrItemId, tmdbId: t.tmdbId, tvdbId: t.tvdbId })
        .from(t)
        .where(
          and(
            eq(t.arrKind, kind),
            eq(t.state, 'in_flight'),
            lt(t.recordedAt, new Date(now.getTime() - RELEASE_IN_FLIGHT_SETTLE_AFTER_MS)),
          ),
        );
      let settled = 0;
      const byItem = new Map<number, { ids: string[]; tmdbId: number | null; tvdbId: number | null }>();
      for (const r of stranded) {
        if (r.arrItemId === null) continue;
        const entry = byItem.get(r.arrItemId) ?? { ids: [], tmdbId: r.tmdbId, tvdbId: r.tvdbId };
        entry.ids.push(r.id);
        byItem.set(r.arrItemId, entry);
      }
      for (const [arrItemId, { ids, ...expected }] of byItem) {
        let present: { tmdbId?: number | null; tvdbId?: number | null } | null;
        try {
          present =
            kind === 'radarr'
              ? await input.arr.read.radarr.findMovie(arrItemId)
              : await input.arr.read.sonarr.findSeries(arrItemId);
        } catch {
          continue; // unreachable: leave them in flight, terms in place (fail closed)
        }
        // D-25ci — another title at this id (an *arr rebuild) means ours is gone.
        if (present !== null && !isSameArrTitle(kind, present, expected)) present = null;
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
      const terms = await readLiveTerms(tx, kind);
      let pruned = 0;
      if (terms.length > RELEASE_BLOCK_TERM_CAP && input.prune === false) {
        throw new ReleaseBlockError(kind, 'cap', { sent: false });
      }
      if (terms.length > RELEASE_BLOCK_TERM_CAP) {
        const over = terms.slice(RELEASE_BLOCK_TERM_CAP);
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
      const live = terms.slice(0, RELEASE_BLOCK_TERM_CAP);
      const desired = [RELEASE_BLOCK_SENTINEL, ...live];

      // 2 — the grammar, before any write.
      if (!desired.every(isGrammarTerm)) throw new ReleaseBlockError(kind, 'validate');

      // 3 — the profile.
      const write = input.arr.write[kind];
      let profiles: Awaited<ReturnType<typeof write.listReleaseProfiles>>;
      try {
        profiles = await write.listReleaseProfiles();
      } catch (cause) {
        throw new ReleaseBlockError(kind, 'put', { cause, sent: false });
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
      const same = releaseProfileDrift(ours, desired) === null;
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

export interface ReleaseBlockUpkeepKind {
  arrKind: ReleaseArrKind;
  /** `in_flight` records older than the settle age, and `active` records past `expires_at`, when the upkeep looked. */
  stranded: number;
  expiring: number;
  /** D-25ce — how the profile differed from the records (null: it matched, or the records' own work was due). */
  drift: ReleaseProfileDriftReason | 'cap' | null;
  /** The reconcile's report (null when nothing was due, or when it failed). */
  report: ReleaseBlockReconcileReport | null;
  error: string | null;
}

/**
 * D-13 step 1 on schedule (D-25br, D-25ce, D-25cf) — the upkeep the `trash-batch-sweep` job runs every hour after the
 * sweep and the `watchlist-registry` job runs at the end of every run (every 15 minutes, so it keeps going while the
 * sweep CronJob is suspended), whether or not a batch was due. For each *arr it runs `reconcileReleaseBlock` when:
 *  - an `in_flight` record is older than the settle age (an ambiguous handle failure left it stranded) or an `active`
 *    record is past `expires_at` (the stranded settle by presence, and the expiry);
 *  - the live terms exceed the cap (the prune);
 *  - or the profile itself drifted from the records (one `GET /releaseprofile`, D-25ce): the managed profile is
 *    missing while a term is live, duplicated, disabled, hand-edited (required terms, an indexer, tags), or its
 *    `ignored` set differs from the sentinel plus the live terms (an abandoned record's term left behind when a Phase A
 *    failed after its write landed, a term deleted by hand, a restore from an older backup). Logged
 *    `[release-block] drift {arrKind, reason, missingTerms, extraTerms}` (warn) so a hand edit is visible.
 * With no term live and no profile, nothing is created (the first write is a delete path's). Best effort: a failure is
 * `[release-block] upkeep_failed` (warn), never the job's exit, and never pauses the sweep (the next run tries again).
 */
export async function reconcileReleaseBlockIfDue(input: {
  db?: DbClient;
  arr: ReleaseBlockArrClients;
  logger?: DomainLogger;
  now?: Date;
}): Promise<ReleaseBlockUpkeepKind[]> {
  const db = resolveDb(input.db);
  const logger = input.logger ?? consoleDomainLogger;
  const now = input.now ?? new Date();
  const t = trashDeletedReleases;
  const out: ReleaseBlockUpkeepKind[] = [];
  for (const kind of ['radarr', 'sonarr'] as const) {
    const [due] = await db
      .select({
        stranded: sql<number>`count(*) filter (where ${t.state} = 'in_flight' and ${t.recordedAt} < ${new Date(now.getTime() - RELEASE_IN_FLIGHT_SETTLE_AFTER_MS).toISOString()}::timestamptz)::int`,
        expiring: sql<number>`count(*) filter (where ${t.state} = 'active' and ${t.expiresAt} <= ${now.toISOString()}::timestamptz)::int`,
      })
      .from(t)
      .where(eq(t.arrKind, kind));
    const entry: ReleaseBlockUpkeepKind = {
      arrKind: kind,
      stranded: due?.stranded ?? 0,
      expiring: due?.expiring ?? 0,
      drift: null,
      report: null,
      error: null,
    };
    try {
      let run = entry.stranded > 0 || entry.expiring > 0;
      if (!run) {
        const live = await readLiveTerms(db, kind);
        if (live.length > RELEASE_BLOCK_TERM_CAP) {
          entry.drift = 'cap';
        } else {
          const drift = releaseProfileDrift(await input.arr.write[kind].listReleaseProfiles(), [
            RELEASE_BLOCK_SENTINEL,
            ...live,
          ]);
          // No live term and no profile: nothing to block, and nothing to create.
          if (drift !== null && !(drift.reason === 'missing' && live.length === 0)) {
            entry.drift = drift.reason;
            logger.warn('[release-block] drift', {
              arrKind: kind,
              reason: drift.reason,
              missingTerms: drift.missingTerms,
              extraTerms: drift.extraTerms,
            });
          }
        }
        run = entry.drift !== null;
      }
      if (run) entry.report = await reconcileReleaseBlock({ db, arr: input.arr, arrKind: kind, logger, now });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      logger.warn('[release-block] upkeep_failed', {
        arrKind: kind,
        stranded: entry.stranded,
        expiring: entry.expiring,
        drift: entry.drift,
        error: entry.error,
      });
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Survivor identity for a delete path (D-14 step 4) — shared by the sweep and Expedite
// ---------------------------------------------------------------------------

export interface ReleaseSurvivor {
  /** The caller's key (the Maintainerr media id). */
  key: string;
  mediaItemId: string;
  title: string;
  /** ADR-097 / D-27 — the Trash batch item being deleted (the sweep), for the Title Exclusion's audit row. */
  batchItemId?: string | null;
}

export interface SurvivorIdentityResult {
  /** Survivors with records to write (a no-file item has one term-less record). */
  recordable: Map<string, ReleaseRecordDraft[]>;
  /** Survivors to keep: no term (D-11), no verified name for a file on disk (D-29), or a single failed *arr read
   *  between successes. */
  unrecorded: Map<string, UnrecordedReason>;
  /** D-29 — per recordable survivor, the posted names skipped because they name no release (see `ReleaseIdentity`). */
  skippedNames: Map<string, number>;
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
  const skippedNames = new Map<string, number>();
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
      if (consecutive >= IDENTITY_FAILURE_LIMIT) return { recordable, unrecorded, skippedNames, aborted: true };
      unrecorded.set(s.key, 'read_failed');
      continue;
    }
    if (identity.status === 'recordable') {
      recordable.set(s.key, identity.drafts);
      if (identity.skippedNames > 0) skippedNames.set(s.key, identity.skippedNames);
    } else unrecorded.set(s.key, identity.reason);
  }
  return { recordable, unrecorded, skippedNames, aborted: false };
}

/** `no_exclusion_key` (ADR-097 / D-27): the record carries no tmdb id (Radarr) or tvdb id (Sonarr), or no title, so
 *  the Title Exclusion cannot be written; the item is kept like any other unrecordable one. `unverified_name`
 *  (ADR-117 / D-29): a file on disk has no verified posted name. `cap` (D-29): the item's new terms would not all
 *  fit under the cap, and nothing older is pruned to make room. */
export type UnrecordedReason =
  | 'no_term'
  | 'gone'
  | 'no_ledger_item'
  | 'id_mismatch'
  | 'read_failed'
  | 'no_exclusion_key'
  | 'unverified_name'
  | 'cap';

/**
 * ADR-117 / D-29 — the batch item's keep reason for an item the Release Block will not let go: `release_unverified`
 * when a file on disk has no verified posted name, `release_block_full` when its terms would not fit under the cap,
 * `release_unrecorded` (D-11) for everything else.
 */
export function keepReasonForUnrecorded(
  reason: UnrecordedReason,
): 'release_unrecorded' | 'release_unverified' | 'release_block_full' {
  if (reason === 'unverified_name') return 'release_unverified';
  if (reason === 'cap') return 'release_block_full';
  return 'release_unrecorded';
}

/**
 * ADR-117 / D-29 — do an item's terms all fit under the cap beside the live ones? `live` is the distinct terms of the
 * *arr's `in_flight` and `active` records plus those already reserved in this run; when the item fits, its new terms
 * are added to it. When it does not, nothing is added and the item is kept: no older term is pruned to make room.
 */
export function reserveTermsUnderCap(
  live: Set<string>,
  drafts: readonly Pick<ReleaseRecordDraft, 'term'>[],
  cap: number = RELEASE_BLOCK_TERM_CAP,
): { fits: boolean; fresh: number } {
  const fresh = new Set(
    drafts.map((d) => d.term).filter((term): term is string => term !== null && !live.has(term)),
  );
  if (live.size + fresh.size > cap) return { fits: false, fresh: fresh.size };
  for (const term of fresh) live.add(term);
  return { fits: true, fresh: fresh.size };
}

export type RecordAndBlockResult =
  | { aborted: true }
  | {
      aborted: false;
      /** Survivors with records (keyed by the caller's key), in the order given. */
      recordable: Map<string, ReleaseRecordDraft[]>;
      /** Survivors kept (D-11, D-29): no term, no verified name, or no room under the cap. No delete. */
      unrecorded: Map<string, UnrecordedReason>;
      /** The `in_flight` record ids written for each recordable survivor. */
      recordIds: Map<string, string[]>;
      /** D-29 — per recordable survivor, the posted names that got no term because they name no release. */
      skippedNames: Map<string, number>;
    };

/**
 * ADR-097 / D-27 — the Title Exclusion target of a recordable survivor: the *arr's key (tmdb id on Radarr, tvdb id on
 * Sonarr), title and year of its records (one item's records share them), the ledger's where the *arr answered none
 * (an id of 0). Null when no key or no title is known (the item is kept `no_exclusion_key`).
 */
export async function resolveTitleExclusionTarget(
  db: DbClient | undefined,
  drafts: readonly ReleaseRecordDraft[],
  survivor: Pick<ReleaseSurvivor, 'mediaItemId' | 'batchItemId'>,
): Promise<{ arrKind: ReleaseArrKind; target: TitleExclusionTarget } | null> {
  const d = drafts[0];
  if (!d) return null;
  const positive = (n: number | null | undefined): number | null => (typeof n === 'number' && n > 0 ? n : null);
  let externalId = positive(d.arrKind === 'radarr' ? d.tmdbId : d.tvdbId);
  let title = d.title?.trim() ? d.title : null;
  let year = d.year;
  if (externalId === null || title === null) {
    const ledger = await loadSubject(db, survivor.mediaItemId);
    if (ledger && ledger.arrKind === d.arrKind) {
      externalId ??= positive(d.arrKind === 'radarr' ? ledger.tmdbId : ledger.tvdbId);
      title ??= ledger.title?.trim() ? ledger.title : null;
      year ??= ledger.year;
    }
  }
  const candidate = {
    externalId,
    title,
    year: d.arrKind === 'radarr' ? year : null,
    mediaItemId: survivor.mediaItemId,
    batchItemId: survivor.batchItemId ?? null,
  };
  return isTitleExclusionTarget(candidate) ? { arrKind: d.arrKind, target: candidate } : null;
}

/**
 * DESIGN-052 D-14 steps 4..5 — THE shared seam of the two delete paths (the sweep and Expedite), so they cannot
 * drift: each survivor's identity (three consecutive *arr read failures ⇒ `aborted`, nothing written), each
 * unrecordable survivor (no term, no verified name for a file on disk, or no room under the cap: ADR-117 / D-29)
 * handed to `onUnrecorded` BEFORE Phase A, then the Title Exclusion of every recordable survivor
 * (ADR-097 / D-27: written and read back on Radarr or Sonarr; a survivor without the *arr's key is kept
 * `no_exclusion_key`), then Phase A for every recordable survivor (records `in_flight`, the Release Block written and
 * read back). A Title Exclusion failure throws ReleaseBlockError with step `exclusion` (nothing recorded, no profile
 * touched); a Phase A failure throws ReleaseBlockError (the records are abandoned); the caller pauses (the sweep) or
 * refuses (Expedite). Nothing is deleted in either case.
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
  // ADR-117 / D-29 — the cap, before anything is written: a survivor whose new terms would not all fit beside the
  // live ones is kept (`cap`), in the order given, and a later survivor that does fit still goes. Nothing older is
  // pruned to make room; Phase A's reconcile refuses (`cap`) if a concurrent delete took the room in between.
  const live: Partial<Record<ReleaseArrKind, Set<string>>> = {};
  for (const s of input.survivors) {
    const drafts = identity.recordable.get(s.key);
    const kind = drafts?.[0]?.arrKind;
    if (!drafts || !kind) continue;
    const have = (live[kind] ??= new Set(await readLiveTerms(resolveDb(input.db), kind)));
    const room = reserveTermsUnderCap(have, drafts);
    if (!room.fits) {
      identity.recordable.delete(s.key);
      identity.skippedNames.delete(s.key);
      identity.unrecorded.set(s.key, 'cap');
      (input.logger ?? consoleDomainLogger).warn('[release-block] cap_kept', {
        arrKind: kind,
        title: s.title,
        live: have.size,
        needed: room.fresh,
        cap: RELEASE_BLOCK_TERM_CAP,
      });
    }
  }
  // ADR-097 / D-27 — the Title Exclusion target of each recordable survivor; one without the *arr's key is kept.
  const exclusions: Record<ReleaseArrKind, TitleExclusionTarget[]> = { radarr: [], sonarr: [] };
  for (const s of input.survivors) {
    const drafts = identity.recordable.get(s.key);
    if (!drafts) continue;
    const excl = await resolveTitleExclusionTarget(input.db, drafts, s);
    if (excl === null) {
      identity.recordable.delete(s.key);
      identity.unrecorded.set(s.key, 'no_exclusion_key');
      continue;
    }
    exclusions[excl.arrKind].push(excl.target);
  }
  for (const s of input.survivors) {
    const reason = identity.unrecorded.get(s.key);
    if (reason !== undefined) await input.onUnrecorded?.(s.key, reason);
  }
  // ADR-097 / D-27 — before Phase A and before any delete: the title is on the *arr's exclusion list, read back, so
  // neither Kometa nor an import list can add it again. A failure stops here: nothing recorded, deleted or blocked.
  for (const kind of ['radarr', 'sonarr'] as const) {
    if (exclusions[kind].length === 0) continue;
    try {
      await ensureTitleExclusions({
        db: input.db,
        arr: input.arr,
        arrKind: kind,
        targets: exclusions[kind],
        origin: input.origin,
        logger: input.logger,
      });
    } catch (error) {
      if (error instanceof TitleExclusionError) {
        throw new ReleaseBlockError(kind, 'exclusion', { cause: error, sent: false });
      }
      throw error;
    }
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
    skippedNames: identity.skippedNames,
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
 * D-23 (ADR-084 E-5) — the hourly re-add check: records `active` / `expired` with no verdict yet whose title is live
 * again in the ledger under a NEW *arr id (same tmdb id for a movie, tvdb id for a series). Reads that item's grabs from
 * the *arr and tests each release name against the record's term; stamps `readd_same_release` (true when any grab
 * matches — ruling 2 breached, logged at error). The 7-day window runs from the CHECK'S OWN first sighting
 * (`readd_seen_at`, D-25bo), never from the ledger row's `first_seen_at`: the media sync re-matches a re-added title
 * onto its old row, whose `first_seen_at` is the original sync. A re-add with no grab yet is stamped
 * `readd_seen_at = now` (verdict null) on first sight and re-checked each hour until a grab gives the verdict or the 7
 * days pass (then it stays "seen, no verdict"). A failure is a warning and never changes the job's exit.
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
      readdSeenAt: t.readdSeenAt,
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
    .where(
      and(
        inArray(t.state, ['active', 'expired']),
        // Never seen, or seen with no grab yet and still inside the window that sighting opened (D-25bo).
        or(
          isNull(t.readdSeenAt),
          and(
            isNull(t.readdSameRelease),
            gt(t.readdSeenAt, new Date(now.getTime() - RELEASE_READD_WINDOW_DAYS * DAY_MS)),
          ),
        ),
      ),
    );
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
    if (grabs.length === 0) {
      // No grab yet. The first sighting opens the 7-day window (readd_seen_at, verdict null); later hours look again.
      if (r.readdSeenAt !== null) continue;
      await db.update(t).set({ readdSeenAt: now, readdSameRelease: null }).where(eq(t.id, r.id));
      report.stamped += 1;
      logger.info('[release-block] readd', {
        arrKind: r.arrKind,
        recordId: r.id,
        title: r.title,
        grabs: 0,
        sameRelease: null,
      });
      continue;
    }
    const same = r.term !== null && grabs.some((g) => termMatches(r.term as string, g));
    // The verdict. A first sighting that already has grabs is stamped now; a later one keeps its sighting time.
    await db
      .update(t)
      .set({ readdSeenAt: r.readdSeenAt ?? now, readdSameRelease: same })
      .where(eq(t.id, r.id));
    report.stamped += 1;
    if (same) report.sameRelease += 1;
    const fields = {
      arrKind: r.arrKind,
      recordId: r.id,
      title: r.title,
      grabs: grabs.length,
      sameRelease: same,
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

/** D-25cl — the Watchlists card waits this long for each *arr's import-list exclusion count. */
export const EXCLUSION_COUNT_DEADLINE_MS = 4_000;

/** The value, or null when it fails or does not settle within `ms` (the late answer is dropped). */
async function withinDeadline<T>(read: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([read().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** D-23 — the Watchlists card's Release Block and re-add counts (never a title). */
export async function getReleaseBlockSummary(input: {
  db?: DbClient;
  arr?: Pick<ReleaseBlockArrClients, 'read'> | null;
  now?: Date;
  /** D-25cl — how long the card waits for each exclusion count (tests shorten it). */
  exclusionDeadlineMs?: number;
}): Promise<ReleaseBlockSummary> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const t = trashDeletedReleases;
  // D-23 / D-25cl — both *arrs' exclusion counts at once, each given a few seconds: an *arr that accepts the connection
  // and never answers reads "not available" at once instead of holding the whole card on its 30 s timeout and retries.
  const deadline = input.exclusionDeadlineMs ?? EXCLUSION_COUNT_DEADLINE_MS;
  const [radarrExclusions, sonarrExclusions] = input.arr
    ? await Promise.all([
        withinDeadline(() => input.arr!.read.radarr.countImportListExclusions(), deadline),
        withinDeadline(() => input.arr!.read.sonarr.countImportListExclusions(), deadline),
      ])
    : [null, null];
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
    const exclusions = kind === 'radarr' ? radarrExclusions : sonarrExclusions;
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
