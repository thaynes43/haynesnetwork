// ADR-117 / DESIGN-052 D-29 — the one-off loader of the release names from before the 2026-07-03 move: the old Radarr
// and Sonarr history and file records, and the two old SABnzbd histories, into legacy_release_names and
// legacy_download_jobs. This module is the single writer of both tables (the no-direct-state-writes guard covers them).
//
// Every non-empty line of a file gets exactly one outcome: usable, refused (any field holds "://": nothing of the line
// is stored) or unusable for one reason. A release name is stored exactly as the file has it, never trimmed (a later
// term must match it as the *arr saw it). The download id, the year and the event count are read and discarded. The
// report, the log line and every error carry counts and line numbers only, never a line's content.
//
// A dry run (apply: false) only reads, inside a read-only transaction. Apply inserts every row in ONE transaction,
// 1,000 at a time, ON CONFLICT (dedupe_key) DO NOTHING, so a second load adds nothing. Rows are never updated or
// deleted.
import { createHash } from 'node:crypto';
import {
  legacyDownloadJobs,
  legacyReleaseNames,
  mediaItems,
  trashCandidates,
  type DbClient,
  type DeletedReleaseArrKind,
  type LegacyReleaseRecordKind,
} from '@hnet/db';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';

/** The five input files, by kind. */
export const LEGACY_FILE_KINDS = [
  'radarrHistory',
  'radarrFiles',
  'sonarrHistory',
  'sonarrFiles',
  'sabJobs',
] as const;
export type LegacyFileKind = (typeof LEGACY_FILE_KINDS)[number];

/** The file name of each kind inside the loader's directory. */
export const LEGACY_FILE_NAMES: Readonly<Record<LegacyFileKind, string>> = {
  radarrHistory: 'old-radarr-history.tsv',
  radarrFiles: 'old-radarr-files.tsv',
  sonarrHistory: 'old-sonarr-history.tsv',
  sonarrFiles: 'old-sonarr-files.tsv',
  sabJobs: 'legacy-sab-full.tsv',
};

/** Why a line was not stored (a line with "://" is counted as `refusedUrl` instead). */
export const LEGACY_UNUSABLE_REASONS = [
  'columns',
  'id',
  'event',
  'name_empty',
  'file_without_name',
  'size',
  'completed',
] as const;
export type LegacyUnusableReason = (typeof LEGACY_UNUSABLE_REASONS)[number];

/** Rows per INSERT. */
export const LEGACY_LOAD_CHUNK = 1000;

/** The first line numbers kept per outcome and file. */
const LINES_KEPT = 5;
/** Cannot occur in a stored field (fields are split on TAB, and no export field carries it). */
const KEY_SEPARATOR = '\u0001';
const INT4_MAX = 2_147_483_647;
const COLUMNS: Readonly<Record<LegacyFileKind, number>> = {
  radarrHistory: 9,
  radarrFiles: 8,
  sonarrHistory: 10,
  sonarrFiles: 8,
  sabJobs: 6,
};
const EVENT_KINDS: Readonly<Record<string, LegacyReleaseRecordKind>> = {
  '1': 'grabbed',
  '3': 'imported',
  '4': 'failed',
};

/** One row for legacy_release_names (the stored fields and the key over them). */
export interface LegacyReleaseNameDraft {
  arrKind: DeletedReleaseArrKind;
  externalId: number;
  recordKind: LegacyReleaseRecordKind;
  /** Exactly as the file has it, never trimmed. */
  releaseName: string;
  sizeBytes: number | null;
  occurredAt: Date | null;
  releaseGroup: string | null;
  season: number | null;
  quality: string | null;
  title: string | null;
  dedupeKey: string;
}

/** One row for legacy_download_jobs. */
export interface LegacyDownloadJobDraft {
  source: string;
  /** Exactly as the file has it, never trimmed. */
  name: string;
  bytes: number;
  completedAt: Date;
  category: string | null;
  status: string | null;
  dedupeKey: string;
}

/** Line outcomes whose first line numbers the report keeps. `dateUnparsed` rows are still usable. */
export type LegacyLineTag = 'refusedUrl' | 'dateUnparsed' | LegacyUnusableReason;

/** What one file's parse saw. read = usable + refusedUrl + the unusable counts. */
export interface LegacyParseReport {
  /** Non-empty lines. */
  read: number;
  usable: number;
  refusedUrl: number;
  unusable: Record<LegacyUnusableReason, number>;
  /** Usable rows stored with a null `occurred_at` because the date did not parse. */
  dateUnparsed: number;
  /** Usable rows whose key already appeared in this file (stored once). */
  duplicateInFile: number;
  /** The first five 1-based line numbers per outcome; only outcomes that occurred. */
  lines: Partial<Record<LegacyLineTag, number[]>>;
}

/** A parse: the distinct rows (duplicates collapsed) and the report. */
export interface ParsedLegacyFile<Row> {
  rows: Row[];
  report: LegacyParseReport;
}

export interface LegacyFileLoadReport extends LegacyParseReport {
  /** Rows inserted (apply), or that an apply would insert now (dry run). */
  inserted: number;
  /** Distinct rows the table already held. */
  alreadyPresent: number;
}

export interface LegacyTableTotals {
  read: number;
  usable: number;
  refusedUrl: number;
  unusable: number;
  duplicateInFile: number;
  distinct: number;
  inserted: number;
  alreadyPresent: number;
  rowsBefore: number;
  /** Rows after this run (a dry run writes nothing, so it equals `rowsBefore`). */
  rowsAfter: number;
}

/** Movie and TV titles in the Trash pool, against this run's rows plus the table. */
export interface LegacyPoolReport {
  movies: {
    titles: number;
    /** A `file` row of the tmdb id has the byte size of the live file (size_on_disk > 0) exactly. */
    fileNamedByExactSize: number;
    /** Any `grabbed` or `failed` row. */
    withGrabName: number;
    withAnyName: number;
    withNoName: number;
  };
  shows: { titles: number; withAnyName: number; withNoName: number };
}

export interface LegacyLoadReport {
  apply: boolean;
  files: Record<LegacyFileKind, LegacyFileLoadReport | 'absent'>;
  totals: { legacyReleaseNames: LegacyTableTotals; legacyDownloadJobs: LegacyTableTotals };
  pool: LegacyPoolReport;
}

export interface LegacyLoadFiles {
  radarrHistory?: string;
  radarrFiles?: string;
  sonarrHistory?: string;
  sonarrFiles?: string;
  sabJobs?: string;
}

export interface LegacyLoadInput {
  db?: DbClient;
  files: LegacyLoadFiles;
  apply: boolean;
  logger?: DomainLogger;
}

/** A failed insert, named by table, file and chunk only (a driver error can carry the row's values). */
export class LegacyReleaseLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyReleaseLoadError';
  }
}

// --- parsing -------------------------------------------------------------------------------------------------------

type LineResult<Row> = { row: Row; dateUnparsed: boolean } | { reason: LegacyUnusableReason };

function emptyReport(): LegacyParseReport {
  return {
    read: 0,
    usable: 0,
    refusedUrl: 0,
    unusable: {
      columns: 0,
      id: 0,
      event: 0,
      name_empty: 0,
      file_without_name: 0,
      size: 0,
      completed: 0,
    },
    dateUnparsed: 0,
    duplicateInFile: 0,
    lines: {},
  };
}

function noteLine(report: LegacyParseReport, tag: LegacyLineTag, lineNo: number): void {
  const kept = (report.lines[tag] ??= []);
  if (kept.length < LINES_KEPT) kept.push(lineNo);
}

/** Split, classify and dedupe one file. Each non-empty line is counted exactly once. */
function parseFile<Row extends { dedupeKey: string }>(
  kind: LegacyFileKind,
  text: string,
  parseLine: (fields: string[]) => LineResult<Row>,
): ParsedLegacyFile<Row> {
  const report = emptyReport();
  const rows: Row[] = [];
  const seen = new Set<string>();
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;
    const lineNo = i + 1;
    report.read += 1;
    // Any field holding "://" refuses the whole line (TAB is never part of "://").
    if (line.includes('://')) {
      report.refusedUrl += 1;
      noteLine(report, 'refusedUrl', lineNo);
      continue;
    }
    const fields = line.split('\t');
    const result: LineResult<Row> =
      fields.length === COLUMNS[kind] ? parseLine(fields) : { reason: 'columns' };
    if ('reason' in result) {
      report.unusable[result.reason] += 1;
      noteLine(report, result.reason, lineNo);
      continue;
    }
    report.usable += 1;
    if (result.dateUnparsed) {
      report.dateUnparsed += 1;
      noteLine(report, 'dateUnparsed', lineNo);
    }
    if (seen.has(result.row.dedupeKey)) {
      report.duplicateInFile += 1;
      continue;
    }
    seen.add(result.row.dedupeKey);
    rows.push(result.row);
  }
  return { rows, report };
}

const DIGITS = /^[0-9]+$/;

/** A positive integer up to `max`, else null. */
function positiveInt(field: string, max: number): number | null {
  const t = field.trim();
  if (!DIGITS.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= max ? n : null;
}

/** A non-negative integer up to `max`, else null. */
function nonNegativeInt(field: string, max: number): number | null {
  const t = field.trim();
  if (!DIGITS.test(t)) return null;
  const n = Number(t);
  return n <= max ? n : null;
}

function textOrNull(field: string): string | null {
  const t = field.trim();
  return t === '' ? null : t;
}

const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z?$/;

/** `YYYY-MM-DD HH:MM:SS` (optionally fractional seconds, `T` or a trailing `Z`) read as UTC; null when invalid. */
export function parseLegacyUtcDate(field: string): Date | null {
  const m = UTC_DATE.exec(field.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  // Date.UTC rolls over (month 13, day 31 of a 30-day month): refuse what does not round-trip.
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return null;
  }
  return date;
}

/** sha256 over the table, the file kind and the stored fields (null as '', a date as its ISO string). */
function dedupeKey(
  table: 'legacy_release_names' | 'legacy_download_jobs',
  kind: LegacyFileKind,
  fields: ReadonlyArray<string | number | Date | null>,
): string {
  const canonical = [
    table,
    kind,
    ...fields.map((v) => (v === null ? '' : v instanceof Date ? v.toISOString() : String(v))),
  ].join(KEY_SEPARATOR);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function nameRow(
  kind: LegacyFileKind,
  fields: Omit<LegacyReleaseNameDraft, 'dedupeKey'>,
): LegacyReleaseNameDraft {
  const key = dedupeKey('legacy_release_names', kind, [
    fields.arrKind,
    fields.externalId,
    fields.recordKind,
    fields.releaseName,
    fields.sizeBytes,
    fields.occurredAt,
    fields.releaseGroup,
    fields.season,
    fields.quality,
    fields.title,
  ]);
  return { ...fields, dedupeKey: key };
}

/** The shared shape of a history line once its columns are picked out. */
interface HistoryFields {
  id: string;
  event: string;
  date: string;
  name: string;
  size: string;
  group: string;
  season: string | null;
  title: string;
}

function parseHistoryLine(
  kind: 'radarrHistory' | 'sonarrHistory',
  f: HistoryFields,
): LineResult<LegacyReleaseNameDraft> {
  const externalId = positiveInt(f.id, INT4_MAX);
  if (externalId === null) return { reason: 'id' };
  const recordKind = EVENT_KINDS[f.event.trim()];
  if (recordKind === undefined) return { reason: 'event' };
  if (f.name.trim() === '') return { reason: 'name_empty' };
  let sizeBytes: number | null = null;
  if (f.size.trim() !== '') {
    sizeBytes = nonNegativeInt(f.size, Number.MAX_SAFE_INTEGER);
    if (sizeBytes === null) return { reason: 'size' };
  }
  const occurredAt = parseLegacyUtcDate(f.date);
  return {
    row: nameRow(kind, {
      arrKind: kind === 'radarrHistory' ? 'radarr' : 'sonarr',
      externalId,
      recordKind,
      releaseName: f.name,
      sizeBytes,
      occurredAt,
      releaseGroup: textOrNull(f.group),
      season: f.season === null ? null : nonNegativeInt(f.season, INT4_MAX),
      quality: null,
      title: textOrNull(f.title),
    }),
    dateUnparsed: occurredAt === null,
  };
}

interface FileFields {
  id: string;
  season: string | null;
  name: string;
  group: string;
  size: string;
  quality: string;
  date: string;
  title: string;
}

function parseFileLine(
  kind: 'radarrFiles' | 'sonarrFiles',
  f: FileFields,
): LineResult<LegacyReleaseNameDraft> {
  const externalId = positiveInt(f.id, INT4_MAX);
  if (externalId === null) return { reason: 'id' };
  if (f.name.trim() === '') return { reason: 'file_without_name' };
  const sizeBytes = positiveInt(f.size, Number.MAX_SAFE_INTEGER);
  if (sizeBytes === null) return { reason: 'size' };
  const occurredAt = parseLegacyUtcDate(f.date);
  return {
    row: nameRow(kind, {
      arrKind: kind === 'radarrFiles' ? 'radarr' : 'sonarr',
      externalId,
      recordKind: 'file',
      releaseName: f.name,
      sizeBytes,
      occurredAt,
      releaseGroup: textOrNull(f.group),
      season: f.season === null ? null : nonNegativeInt(f.season, INT4_MAX),
      quality: textOrNull(f.quality),
      title: textOrNull(f.title),
    }),
    dateUnparsed: occurredAt === null,
  };
}

/** `old-radarr-history.tsv`: tmdbId, year, eventType, date, name, downloadId, size, group, title. */
export function parseLegacyRadarrHistory(text: string): ParsedLegacyFile<LegacyReleaseNameDraft> {
  return parseFile('radarrHistory', text, (f) => {
    // f[1] (year) and f[5] (download id) are discarded.
    const [id, , event, date, name, , size, group, title] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return parseHistoryLine('radarrHistory', {
      id,
      event,
      date,
      name,
      size,
      group,
      season: null,
      title,
    });
  });
}

/** `old-radarr-files.tsv`: tmdbId, year, original name, group, size, quality, date added, title. */
export function parseLegacyRadarrFiles(text: string): ParsedLegacyFile<LegacyReleaseNameDraft> {
  return parseFile('radarrFiles', text, (f) => {
    // f[1] (year) is discarded.
    const [id, , name, group, size, quality, date, title] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return parseFileLine('radarrFiles', {
      id,
      season: null,
      name,
      group,
      size,
      quality,
      date,
      title,
    });
  });
}

/** `old-sonarr-history.tsv`: tvdbId, eventType, first date, name, downloadId, size, group, lowest season, count, title. */
export function parseLegacySonarrHistory(text: string): ParsedLegacyFile<LegacyReleaseNameDraft> {
  return parseFile('sonarrHistory', text, (f) => {
    // f[4] (download id) and f[8] (event count) are discarded.
    const [id, event, date, name, , size, group, season, , title] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return parseHistoryLine('sonarrHistory', { id, event, date, name, size, group, season, title });
  });
}

/** `old-sonarr-files.tsv`: tvdbId, season, original name, group, size, quality, date added, title. */
export function parseLegacySonarrFiles(text: string): ParsedLegacyFile<LegacyReleaseNameDraft> {
  return parseFile('sonarrFiles', text, (f) => {
    const [id, season, name, group, size, quality, date, title] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return parseFileLine('sonarrFiles', { id, season, name, group, size, quality, date, title });
  });
}

const POSITIVE_NUMBER = /^[0-9]+(?:\.[0-9]+)?$/;

/** `legacy-sab-full.tsv`: source, name, bytes, completion (epoch seconds), category, status. */
export function parseLegacySabJobs(text: string): ParsedLegacyFile<LegacyDownloadJobDraft> {
  return parseFile<LegacyDownloadJobDraft>('sabJobs', text, (f) => {
    const [source, name, bytesField, completed, category, status] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (name.trim() === '') return { reason: 'name_empty' };
    const bytes = positiveInt(bytesField, Number.MAX_SAFE_INTEGER);
    if (bytes === null) return { reason: 'size' };
    const seconds = POSITIVE_NUMBER.test(completed.trim()) ? Number(completed.trim()) : NaN;
    const completedAt = new Date(Math.round(seconds * 1000));
    if (!(seconds > 0) || Number.isNaN(completedAt.getTime())) return { reason: 'completed' };
    const fields = {
      source: source.trim(),
      name,
      bytes,
      completedAt,
      category: textOrNull(category),
      status: textOrNull(status),
    };
    const key = dedupeKey('legacy_download_jobs', 'sabJobs', [
      fields.source,
      fields.name,
      fields.bytes,
      fields.completedAt,
      fields.category,
      fields.status,
    ]);
    return { row: { ...fields, dedupeKey: key }, dateUnparsed: false };
  });
}

const NAME_PARSERS = {
  radarrHistory: parseLegacyRadarrHistory,
  radarrFiles: parseLegacyRadarrFiles,
  sonarrHistory: parseLegacySonarrHistory,
  sonarrFiles: parseLegacySonarrFiles,
} as const;
type NameFileKind = keyof typeof NAME_PARSERS;
const NAME_FILE_KINDS = Object.keys(NAME_PARSERS) as NameFileKind[];

// --- reads and writes ----------------------------------------------------------------------------------------------

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += LEGACY_LOAD_CHUNK)
    out.push(items.slice(i, i + LEGACY_LOAD_CHUNK));
  return out;
}

/** Keep the driver's code and constraint name only: its message or detail can quote the row. */
function loadError(
  table: string,
  kind: LegacyFileKind,
  chunk: number,
  error: unknown,
): LegacyReleaseLoadError {
  const e = (error ?? {}) as { code?: unknown; constraint?: unknown };
  const code = typeof e.code === 'string' ? e.code : 'unknown';
  const constraint = typeof e.constraint === 'string' ? ` ${e.constraint}` : '';
  return new LegacyReleaseLoadError(
    `legacy release load: insert into ${table} failed (${kind}, chunk ${chunk + 1}): ${code}${constraint}`,
  );
}

async function insertNames(
  tx: DbClient,
  kind: LegacyFileKind,
  rows: readonly LegacyReleaseNameDraft[],
): Promise<number> {
  let inserted = 0;
  for (const [n, chunk] of chunks(rows).entries()) {
    try {
      const done = await tx
        .insert(legacyReleaseNames)
        .values(chunk)
        .onConflictDoNothing({ target: legacyReleaseNames.dedupeKey })
        .returning({ id: legacyReleaseNames.id });
      inserted += done.length;
    } catch (error) {
      throw loadError('legacy_release_names', kind, n, error);
    }
  }
  return inserted;
}

async function insertJobs(tx: DbClient, rows: readonly LegacyDownloadJobDraft[]): Promise<number> {
  let inserted = 0;
  for (const [n, chunk] of chunks(rows).entries()) {
    try {
      const done = await tx
        .insert(legacyDownloadJobs)
        .values(chunk)
        .onConflictDoNothing({ target: legacyDownloadJobs.dedupeKey })
        .returning({ id: legacyDownloadJobs.id });
      inserted += done.length;
    } catch (error) {
      throw loadError('legacy_download_jobs', 'sabJobs', n, error);
    }
  }
  return inserted;
}

async function presentNameKeys(executor: DbClient, keys: readonly string[]): Promise<number> {
  let present = 0;
  for (const chunk of chunks(keys)) {
    const found = await executor
      .select({ key: legacyReleaseNames.dedupeKey })
      .from(legacyReleaseNames)
      .where(inArray(legacyReleaseNames.dedupeKey, chunk));
    present += found.length;
  }
  return present;
}

async function presentJobKeys(executor: DbClient, keys: readonly string[]): Promise<number> {
  let present = 0;
  for (const chunk of chunks(keys)) {
    const found = await executor
      .select({ key: legacyDownloadJobs.dedupeKey })
      .from(legacyDownloadJobs)
      .where(inArray(legacyDownloadJobs.dedupeKey, chunk));
    present += found.length;
  }
  return present;
}

async function tableRows(executor: DbClient): Promise<{ names: number; jobs: number }> {
  const [names] = await executor.select({ n: count() }).from(legacyReleaseNames);
  const [jobs] = await executor.select({ n: count() }).from(legacyDownloadJobs);
  return { names: Number(names?.n ?? 0), jobs: Number(jobs?.n ?? 0) };
}

interface NameEvidence {
  grab: boolean;
  fileSizes: Set<number>;
}

/** Per external id of one *arr: whether any row names it, any grab or failure, and its `file` sizes. */
async function nameEvidence(
  executor: DbClient,
  arrKind: DeletedReleaseArrKind,
  ids: readonly number[],
  parsed: readonly LegacyReleaseNameDraft[],
): Promise<Map<number, NameEvidence>> {
  const wanted = new Set(ids);
  const evidence = new Map<number, NameEvidence>();
  const add = (id: number, recordKind: LegacyReleaseRecordKind, size: number | null) => {
    if (!wanted.has(id)) return;
    let e = evidence.get(id);
    if (!e) {
      e = { grab: false, fileSizes: new Set() };
      evidence.set(id, e);
    }
    if (recordKind === 'grabbed' || recordKind === 'failed') e.grab = true;
    if (recordKind === 'file' && size !== null) e.fileSizes.add(size);
  };
  for (const chunk of chunks(ids)) {
    const stored = await executor
      .select({
        id: legacyReleaseNames.externalId,
        recordKind: legacyReleaseNames.recordKind,
        size: legacyReleaseNames.sizeBytes,
      })
      .from(legacyReleaseNames)
      .where(
        and(eq(legacyReleaseNames.arrKind, arrKind), inArray(legacyReleaseNames.externalId, chunk)),
      );
    for (const r of stored) add(r.id, r.recordKind, r.size);
  }
  for (const r of parsed) if (r.arrKind === arrKind) add(r.externalId, r.recordKind, r.sizeBytes);
  return evidence;
}

/** The Trash pool's titles (live in the *arr) against the names this run parsed and the table holds. */
async function readPool(
  executor: DbClient,
  parsed: readonly LegacyReleaseNameDraft[],
): Promise<LegacyPoolReport> {
  const movieRows = await executor
    .selectDistinct({ id: trashCandidates.tmdbId, size: mediaItems.sizeOnDisk })
    .from(trashCandidates)
    .innerJoin(
      mediaItems,
      and(
        eq(mediaItems.arrKind, 'radarr'),
        eq(mediaItems.tmdbId, trashCandidates.tmdbId),
        isNull(mediaItems.deletedFromArrAt),
      ),
    )
    .where(eq(trashCandidates.mediaKind, 'movie'));
  const movieSizes = new Map<number, Set<number>>();
  for (const r of movieRows) {
    if (r.id === null) continue;
    const sizes = movieSizes.get(r.id) ?? new Set<number>();
    if (r.size > 0) sizes.add(r.size);
    movieSizes.set(r.id, sizes);
  }
  const movieEvidence = await nameEvidence(executor, 'radarr', [...movieSizes.keys()], parsed);
  const movies = {
    titles: 0,
    fileNamedByExactSize: 0,
    withGrabName: 0,
    withAnyName: 0,
    withNoName: 0,
  };
  for (const [id, sizes] of movieSizes) {
    movies.titles += 1;
    const e = movieEvidence.get(id);
    if (!e) continue;
    movies.withAnyName += 1;
    if (e.grab) movies.withGrabName += 1;
    if ([...sizes].some((s) => e.fileSizes.has(s))) movies.fileNamedByExactSize += 1;
  }
  movies.withNoName = movies.titles - movies.withAnyName;

  const showRows = await executor
    .selectDistinct({ id: trashCandidates.tvdbId })
    .from(trashCandidates)
    .innerJoin(
      mediaItems,
      and(
        eq(mediaItems.arrKind, 'sonarr'),
        eq(mediaItems.tvdbId, trashCandidates.tvdbId),
        isNull(mediaItems.deletedFromArrAt),
      ),
    )
    .where(eq(trashCandidates.mediaKind, 'tv'));
  const showIds = [...new Set(showRows.map((r) => r.id).filter((id): id is number => id !== null))];
  const showEvidence = await nameEvidence(executor, 'sonarr', showIds, parsed);
  const withAnyName = showIds.filter((id) => showEvidence.has(id)).length;
  return {
    movies,
    shows: { titles: showIds.length, withAnyName, withNoName: showIds.length - withAnyName },
  };
}

function emptyTotals(): LegacyTableTotals {
  return {
    read: 0,
    usable: 0,
    refusedUrl: 0,
    unusable: 0,
    duplicateInFile: 0,
    distinct: 0,
    inserted: 0,
    alreadyPresent: 0,
    rowsBefore: 0,
    rowsAfter: 0,
  };
}

function addTotals(totals: LegacyTableTotals, file: LegacyFileLoadReport, distinct: number): void {
  totals.read += file.read;
  totals.usable += file.usable;
  totals.refusedUrl += file.refusedUrl;
  totals.unusable += Object.values(file.unusable).reduce((a, b) => a + b, 0);
  totals.duplicateInFile += file.duplicateInFile;
  totals.distinct += distinct;
  totals.inserted += file.inserted;
  totals.alreadyPresent += file.alreadyPresent;
}

/**
 * ADR-117 / DESIGN-052 D-29 — load the files given (each optional) into legacy_release_names and legacy_download_jobs.
 * `apply: false` reads only; `inserted` then counts what an apply would insert now. `apply: true` writes everything in
 * one transaction and never updates or deletes a row. The report is JSON-serialisable and holds counts only.
 */
export async function loadLegacyReleaseNames(input: LegacyLoadInput): Promise<LegacyLoadReport> {
  const logger = input.logger ?? consoleDomainLogger;
  const parsedNames = new Map<NameFileKind, ParsedLegacyFile<LegacyReleaseNameDraft>>();
  for (const kind of NAME_FILE_KINDS) {
    const text = input.files[kind];
    if (text !== undefined) parsedNames.set(kind, NAME_PARSERS[kind](text));
  }
  const parsedJobs =
    input.files.sabJobs === undefined ? null : parseLegacySabJobs(input.files.sabJobs);
  const allNameRows = [...parsedNames.values()].flatMap((p) => p.rows);

  const run = async (executor: DbClient): Promise<LegacyLoadReport> => {
    const before = await tableRows(executor);
    const files = Object.fromEntries(
      LEGACY_FILE_KINDS.map((k) => [k, 'absent']),
    ) as LegacyLoadReport['files'];
    const totals = { legacyReleaseNames: emptyTotals(), legacyDownloadJobs: emptyTotals() };

    for (const [kind, parsed] of parsedNames) {
      const keys = parsed.rows.map((r) => r.dedupeKey);
      const inserted = input.apply
        ? await insertNames(executor, kind, parsed.rows)
        : keys.length - (await presentNameKeys(executor, keys));
      const file = { ...parsed.report, inserted, alreadyPresent: keys.length - inserted };
      files[kind] = file;
      addTotals(totals.legacyReleaseNames, file, keys.length);
    }
    if (parsedJobs) {
      const keys = parsedJobs.rows.map((r) => r.dedupeKey);
      const inserted = input.apply
        ? await insertJobs(executor, parsedJobs.rows)
        : keys.length - (await presentJobKeys(executor, keys));
      const file = { ...parsedJobs.report, inserted, alreadyPresent: keys.length - inserted };
      files.sabJobs = file;
      addTotals(totals.legacyDownloadJobs, file, keys.length);
    }

    const pool = await readPool(executor, allNameRows);
    const after = await tableRows(executor);
    totals.legacyReleaseNames.rowsBefore = before.names;
    totals.legacyReleaseNames.rowsAfter = after.names;
    totals.legacyDownloadJobs.rowsBefore = before.jobs;
    totals.legacyDownloadJobs.rowsAfter = after.jobs;
    return { apply: input.apply, files, totals, pool };
  };

  const report = input.apply
    ? await inTransaction(input.db, run)
    : await resolveDb(input.db).transaction(run, { accessMode: 'read only' });

  const names = report.totals.legacyReleaseNames;
  const jobs = report.totals.legacyDownloadJobs;
  logger.info('[legacy-release-load] done', {
    apply: input.apply,
    names: {
      usable: names.usable,
      refusedUrl: names.refusedUrl,
      unusable: names.unusable,
      inserted: names.inserted,
    },
    jobs: {
      usable: jobs.usable,
      refusedUrl: jobs.refusedUrl,
      unusable: jobs.unusable,
      inserted: jobs.inserted,
    },
  });
  return report;
}
