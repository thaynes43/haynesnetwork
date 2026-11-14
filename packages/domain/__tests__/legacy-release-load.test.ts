// ADR-117 / DESIGN-052 D-29 — the legacy release-name loader: the five parsers (pure) and the load itself on embedded
// PostgreSQL 16. Every name, group and title here is invented; the one fake URL proves a URL line is refused.
// It imports the module itself and boots its own database, so it does not load the whole domain index.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Database } from '@hnet/db';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';
import { startPostgres, trackPoolClose, type StartedPostgres } from '@hnet/test-utils';
import {
  legacyDownloadJobs,
  legacyReleaseNames,
  mediaItems,
  trashCandidates,
} from '@hnet/db/schema';
import { silentDomainLogger } from '../src/domain-logger';
import {
  LEGACY_FILE_KINDS,
  LEGACY_UNUSABLE_REASONS,
  loadLegacyReleaseNames,
  parseLegacyRadarrFiles,
  parseLegacyRadarrHistory,
  parseLegacySabJobs,
  parseLegacySonarrFiles,
  parseLegacySonarrHistory,
  parseLegacyUtcDate,
  type LegacyFileKind,
  type LegacyFileLoadReport,
  type LegacyLoadFiles,
  type LegacyLoadReport,
  type LegacyParseReport,
} from '../src/legacy-release-load';

const FAKE_URL = 'https://example.invalid/x';
const tsv = (...rows: string[][]): string => rows.map((r) => r.join('\t')).join('\n');

/** read = usable + refusedUrl + every unusable reason. */
function balanced(r: LegacyParseReport): void {
  const unusable = Object.values(r.unusable).reduce((a, b) => a + b, 0);
  expect(r.usable + r.refusedUrl + unusable).toBe(r.read);
}

const fileReport = (report: LegacyLoadReport, kind: LegacyFileKind): LegacyFileLoadReport => {
  const f = report.files[kind];
  if (f === 'absent') throw new Error(`${kind} absent`);
  return f;
};

// --- fixtures: one valid line per kind, then the outcome lines ------------------------------------------------------

// tmdbId, year, eventType, date, name, downloadId, size, group, title
const RH_GRAB = [
  '101',
  '2019',
  '1',
  '2023-04-01 12:00:00',
  'Lantern.Harbor.2019.1080p.WEB.x264-QZXLAB',
  'DLID-0001',
  '4500000000',
  'QZXLAB',
  'Lantern Harbor',
];
// tmdbId, year, name, group, size, quality, date added, title
const RF_FILE = [
  '101',
  '2019',
  'Lantern.Harbor.2019.1080p.WEB.x264-QZXLAB',
  'QZXLAB',
  '4500000000',
  'WEBDL-1080p',
  '2023-04-01 13:05:00',
  'Lantern Harbor',
];
// tvdbId, eventType, first date, name, downloadId, size, group, lowest season, event count, title
const SH_GRAB = [
  '201',
  '1',
  '2022-02-02 02:02:02',
  'Quiet.Orchard.S01.1080p.WEB-PLUMCART',
  'DLID-0101',
  '9000',
  'PLUMCART',
  '1',
  '12',
  'Quiet Orchard',
];
// tvdbId, season, name, group, size, quality, date added, title
const SF_FILE = [
  '201',
  '1',
  'Quiet.Orchard.S01E01.1080p.WEB-PLUMCART',
  'PLUMCART',
  '1500',
  'WEBDL-1080p',
  '2022-02-03 00:00:00',
  'Quiet Orchard',
];
// source, name, bytes, completion (epoch seconds), category, status
const SAB_JOB = [
  'sab-old-a',
  'Copper.Kettle.2020.720p.BluRay-MOOSEPIE',
  '123456',
  '1690000000',
  'movies',
  'Completed',
];

const with_ = (row: string[], i: number, value: string): string[] =>
  row.map((v, j) => (j === i ? value : v));

const RADARR_HISTORY =
  tsv(
    RH_GRAB, // 1 usable (grabbed)
    with_(RH_GRAB, 5, 'DLID-0002'), // 2 the same stored tuple: only the download id differs
    [
      '101',
      '2019',
      '3',
      '2023-04-01 13:00:00',
      ' Lantern.Harbor.2019.1080p.WEB.x264-QZXLAB ',
      'DLID-0003',
      '',
      '',
      'Lantern Harbor',
    ], // 3 imported, untrimmed
    [
      '102',
      '2020',
      '4',
      'not-a-date',
      'Copper.Kettle.2020.720p.BluRay-MOOSEPIE',
      'DLID-0004',
      '0',
      'MOOSEPIE',
      'Copper Kettle',
    ], // 4 failed, no date
    with_(with_(RH_GRAB, 4, 'Url.Line.Name.2021-QZXLAB'), 5, FAKE_URL), // 5 a URL in the download id column
    RH_GRAB.slice(0, 8), // 6 columns
    with_(RH_GRAB, 0, '0'), // 7 id
    with_(RH_GRAB, 0, 'abc'), // 8 id
    with_(RH_GRAB, 2, '2'), // 9 event
    with_(RH_GRAB, 4, '   '), // 10 name_empty
    with_(RH_GRAB, 6, '12x'), // 11 size
    [], // 12 an empty line
  ) + `\n${with_(RH_GRAB, 4, 'Crlf.Line.2019-QZXLAB').join('\t')}\r\n`; // 13 usable, CRLF

const RADARR_FILES = tsv(
  RF_FILE, // 1 usable
  ['104', '2018', '', 'QZXLAB', '777', 'Bluray-720p', '2023-01-01 00:00:00', 'Nameless Reel'], // 2 file_without_name
  with_(RF_FILE, 4, '0'), // 3 size
  with_(RF_FILE, 4, ''), // 4 size (a file row needs one)
  with_(RF_FILE, 7, FAKE_URL), // 5 a URL in the title column
  with_(RF_FILE, 0, '-5'), // 6 id
  [...RF_FILE, 'extra'], // 7 columns
  with_(with_(RF_FILE, 2, 'Tin.Lake.2017.2160p-MOOSEPIE'), 6, '2023-13-01 00:00:00'), // 8 usable, no date
);

const SONARR_HISTORY = tsv(
  SH_GRAB, // 1 usable, season 1
  with_(SH_GRAB, 1, '9'), // 2 event
  with_(SH_GRAB, 3, ''), // 3 name_empty
  with_(SH_GRAB, 5, '-1'), // 4 size
  SH_GRAB.slice(1), // 5 columns
  with_(with_(with_(SH_GRAB, 3, 'Quiet.Orchard.S02.720p-PLUMCART'), 5, ''), 7, ''), // 6 usable, no size, no season
  with_(SH_GRAB, 0, '99999999999'), // 7 id (beyond an integer column)
);

const SONARR_FILES = tsv(
  SF_FILE, // 1 usable
  with_(SF_FILE, 2, ' '), // 2 file_without_name
  with_(SF_FILE, 0, 'x'), // 3 id
  with_(SF_FILE, 4, 'abc'), // 4 size
);

const SAB_JOBS = tsv(
  SAB_JOB, // 1 usable
  SAB_JOB, // 2 duplicate
  ['sab-old-b', ' Spaced.Name.2019-QZXLAB ', '999', '1690000000.5', '', ''], // 3 usable, untrimmed, no category
  with_(SAB_JOB, 1, ''), // 4 name_empty
  with_(SAB_JOB, 2, '0'), // 5 size
  with_(SAB_JOB, 3, '0'), // 6 completed
  with_(SAB_JOB, 3, 'yesterday'), // 7 completed
  with_(SAB_JOB, 1, `Copper.Kettle.${FAKE_URL}`), // 8 a URL inside the name
  SAB_JOB.slice(0, 5), // 9 columns
);

const ALL_FILES: LegacyLoadFiles = {
  radarrHistory: RADARR_HISTORY,
  radarrFiles: RADARR_FILES,
  sonarrHistory: SONARR_HISTORY,
  sonarrFiles: SONARR_FILES,
  sabJobs: SAB_JOBS,
};

const NAME_ROW_KEYS = [
  'arrKind',
  'dedupeKey',
  'externalId',
  'occurredAt',
  'quality',
  'recordKind',
  'releaseGroup',
  'releaseName',
  'season',
  'sizeBytes',
  'title',
];

const zero = Object.fromEntries(LEGACY_UNUSABLE_REASONS.map((r) => [r, 0]));

describe('legacy release-name parsers (DESIGN-052 D-29)', () => {
  it('radarr history: every outcome, the untrimmed name, the discarded download id', () => {
    const { rows, report } = parseLegacyRadarrHistory(RADARR_HISTORY);
    balanced(report);
    expect(report).toMatchObject({
      read: 12,
      usable: 5,
      refusedUrl: 1,
      unusable: { ...zero, columns: 1, id: 2, event: 1, name_empty: 1, size: 1 },
      dateUnparsed: 1,
      duplicateInFile: 1,
    });
    expect(report.lines).toEqual({
      refusedUrl: [5],
      columns: [6],
      id: [7, 8],
      event: [9],
      name_empty: [10],
      size: [11],
      dateUnparsed: [4],
    });
    expect(rows).toHaveLength(4);
    const [grab, imported, failed, crlf] = rows;
    expect(grab).toMatchObject({
      arrKind: 'radarr',
      externalId: 101,
      recordKind: 'grabbed',
      releaseName: 'Lantern.Harbor.2019.1080p.WEB.x264-QZXLAB',
      sizeBytes: 4_500_000_000,
      occurredAt: new Date('2023-04-01T12:00:00.000Z'),
      releaseGroup: 'QZXLAB',
      season: null,
      quality: null,
      title: 'Lantern Harbor',
    });
    expect(imported).toMatchObject({
      recordKind: 'imported',
      releaseName: ' Lantern.Harbor.2019.1080p.WEB.x264-QZXLAB ',
      sizeBytes: null,
      releaseGroup: null,
    });
    expect(failed).toMatchObject({ recordKind: 'failed', occurredAt: null, sizeBytes: 0 });
    expect(crlf?.releaseName).toBe('Crlf.Line.2019-QZXLAB');
    expect(crlf?.title).toBe('Lantern Harbor');
    // Only the stored fields: no download id, no year.
    expect(Object.keys(grab ?? {}).sort()).toEqual(NAME_ROW_KEYS);
    expect(JSON.stringify(rows)).not.toContain('DLID-');
  });

  it('radarr files: a file needs a name and a positive size', () => {
    const { rows, report } = parseLegacyRadarrFiles(RADARR_FILES);
    balanced(report);
    expect(report).toMatchObject({
      read: 8,
      usable: 2,
      refusedUrl: 1,
      unusable: { ...zero, columns: 1, id: 1, file_without_name: 1, size: 2 },
      dateUnparsed: 1,
      duplicateInFile: 0,
    });
    expect(report.lines).toMatchObject({ file_without_name: [2], size: [3, 4], refusedUrl: [5] });
    expect(rows[0]).toMatchObject({
      arrKind: 'radarr',
      externalId: 101,
      recordKind: 'file',
      sizeBytes: 4_500_000_000,
      quality: 'WEBDL-1080p',
      occurredAt: new Date('2023-04-01T13:05:00.000Z'),
      season: null,
    });
    expect(rows[1]).toMatchObject({
      releaseName: 'Tin.Lake.2017.2160p-MOOSEPIE',
      occurredAt: null,
    });
  });

  it('sonarr history: the lowest season is kept, the event count and download id are not', () => {
    const { rows, report } = parseLegacySonarrHistory(SONARR_HISTORY);
    balanced(report);
    expect(report).toMatchObject({
      read: 7,
      usable: 2,
      refusedUrl: 0,
      unusable: { ...zero, columns: 1, id: 1, event: 1, name_empty: 1, size: 1 },
    });
    expect(rows[0]).toMatchObject({
      arrKind: 'sonarr',
      externalId: 201,
      recordKind: 'grabbed',
      season: 1,
      sizeBytes: 9000,
      occurredAt: new Date('2022-02-02T02:02:02.000Z'),
    });
    expect(rows[1]).toMatchObject({ sizeBytes: null, season: null });
    // Only the stored fields: no download id, no event count.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(NAME_ROW_KEYS);
    expect(JSON.stringify(rows)).not.toContain('DLID-');
  });

  it('sonarr files: season, quality and size', () => {
    const { rows, report } = parseLegacySonarrFiles(SONARR_FILES);
    balanced(report);
    expect(report).toMatchObject({
      read: 4,
      usable: 1,
      unusable: { ...zero, id: 1, file_without_name: 1, size: 1 },
    });
    expect(rows[0]).toMatchObject({
      arrKind: 'sonarr',
      recordKind: 'file',
      season: 1,
      sizeBytes: 1500,
      quality: 'WEBDL-1080p',
    });
  });

  it('SABnzbd jobs: bytes and completion, empty category and status become null', () => {
    const { rows, report } = parseLegacySabJobs(SAB_JOBS);
    balanced(report);
    expect(report).toMatchObject({
      read: 9,
      usable: 3,
      refusedUrl: 1,
      unusable: { ...zero, columns: 1, name_empty: 1, size: 1, completed: 2 },
      duplicateInFile: 1,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: 'sab-old-a',
      bytes: 123456,
      completedAt: new Date(1_690_000_000_000),
      category: 'movies',
      status: 'Completed',
    });
    expect(rows[1]).toMatchObject({
      name: ' Spaced.Name.2019-QZXLAB ',
      completedAt: new Date(1_690_000_000_500),
      category: null,
      status: null,
    });
  });

  it('a URL in ANY column refuses the whole line', () => {
    const cases: Array<
      [(text: string) => { report: LegacyParseReport; rows: unknown[] }, string[]]
    > = [
      [parseLegacyRadarrHistory, RH_GRAB],
      [parseLegacyRadarrFiles, RF_FILE],
      [parseLegacySonarrHistory, SH_GRAB],
      [parseLegacySonarrFiles, SF_FILE],
      [parseLegacySabJobs, SAB_JOB],
    ];
    for (const [parse, valid] of cases) {
      const text = tsv(...valid.map((_, i) => with_(valid, i, `x${FAKE_URL}x`)));
      const { report, rows } = parse(text);
      expect(report.refusedUrl).toBe(valid.length);
      expect(report.usable).toBe(0);
      expect(rows).toEqual([]);
      expect(report.lines.refusedUrl).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('the report holds counts and line numbers only', () => {
    for (const [parse, text] of [
      [parseLegacyRadarrHistory, RADARR_HISTORY],
      [parseLegacyRadarrFiles, RADARR_FILES],
      [parseLegacySonarrHistory, SONARR_HISTORY],
      [parseLegacySonarrFiles, SONARR_FILES],
      [parseLegacySabJobs, SAB_JOBS],
    ] as const) {
      const json = JSON.stringify(parse(text).report);
      for (const leak of [
        'example.invalid',
        'QZXLAB',
        'MOOSEPIE',
        'PLUMCART',
        'DLID-',
        'Lantern',
        'sab-old',
      ]) {
        expect(json).not.toContain(leak);
      }
    }
  });

  it('keeps at most five line numbers per outcome and tolerates a byte-order mark', () => {
    const many = tsv(...Array.from({ length: 8 }, () => with_(RH_GRAB, 0, 'zz')));
    const { report } = parseLegacyRadarrHistory(`\uFEFF${tsv(RH_GRAB)}\n${many}`);
    expect(report.usable).toBe(1);
    expect(report.unusable.id).toBe(8);
    expect(report.lines.id).toEqual([2, 3, 4, 5, 6]);
  });

  it('dates are UTC and must round-trip', () => {
    expect(parseLegacyUtcDate('2023-04-01 12:00:00')).toEqual(new Date('2023-04-01T12:00:00Z'));
    expect(parseLegacyUtcDate('2023-04-01T12:00:00.1234567Z')).toEqual(
      new Date('2023-04-01T12:00:00.123Z'),
    );
    expect(parseLegacyUtcDate('2023-02-30 00:00:00')).toBeNull();
    expect(parseLegacyUtcDate('2023-04-01')).toBeNull();
    expect(parseLegacyUtcDate('')).toBeNull();
  });

  it('identical stored tuples give one key; any stored difference gives another', () => {
    const a = parseLegacyRadarrHistory(tsv(RH_GRAB)).rows[0];
    const b = parseLegacyRadarrHistory(tsv(with_(with_(RH_GRAB, 5, 'DLID-9'), 1, '1999'))).rows[0];
    const c = parseLegacyRadarrHistory(tsv(with_(RH_GRAB, 4, `${RH_GRAB[4]} `))).rows[0];
    expect(a?.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(b?.dedupeKey).toBe(a?.dedupeKey);
    expect(c?.dedupeKey).not.toBe(a?.dedupeKey);
    // The same name from another file kind is another row.
    const f = parseLegacyRadarrFiles(tsv(RF_FILE)).rows[0];
    expect(f?.dedupeKey).not.toBe(a?.dedupeKey);
  });
});

describe('loadLegacyReleaseNames on PG16 (DESIGN-052 D-29)', () => {
  let pg: StartedPostgres;
  let closePool: () => Promise<void>;
  const t = {} as { db: Database };

  beforeAll(async () => {
    pg = await startPostgres();
    await runMigrations({ databaseUrl: pg.connectionString });
    const pool = new Pool({ connectionString: pg.connectionString });
    closePool = trackPoolClose(pool);
    t.db = drizzle(pool, { schema }) as Database;
  });

  afterAll(async () => {
    await closePool?.();
    await pg?.stop();
  });

  beforeEach(async () => {
    await t.db.execute(
      sql`TRUNCATE legacy_release_names, legacy_download_jobs, trash_candidates, media_items CASCADE`,
    );
  });

  const load = (files: LegacyLoadFiles, apply: boolean) =>
    loadLegacyReleaseNames({ db: t.db, files, apply, logger: silentDomainLogger });
  const rowCounts = async () => ({
    names: (await t.db.select().from(legacyReleaseNames)).length,
    jobs: (await t.db.select().from(legacyDownloadJobs)).length,
  });

  it('a dry run writes nothing, and predicts what the apply inserts', async () => {
    const dry = await load(ALL_FILES, false);
    expect(await rowCounts()).toEqual({ names: 0, jobs: 0 });
    expect(dry.apply).toBe(false);
    expect(dry.totals.legacyReleaseNames).toMatchObject({
      rowsBefore: 0,
      rowsAfter: 0,
      distinct: 9,
      inserted: 9,
    });
    expect(dry.totals.legacyDownloadJobs).toMatchObject({
      rowsBefore: 0,
      rowsAfter: 0,
      distinct: 2,
      inserted: 2,
    });

    const applied = await load(ALL_FILES, true);
    for (const kind of LEGACY_FILE_KINDS) {
      expect(fileReport(applied, kind).inserted, kind).toBe(fileReport(dry, kind).inserted);
      expect(fileReport(applied, kind).alreadyPresent, kind).toBe(0);
    }
    expect(applied.totals.legacyReleaseNames).toMatchObject({
      inserted: 9,
      rowsBefore: 0,
      rowsAfter: 9,
    });
    expect(applied.totals.legacyDownloadJobs).toMatchObject({
      inserted: 2,
      rowsBefore: 0,
      rowsAfter: 2,
    });
    expect(await rowCounts()).toEqual({ names: 9, jobs: 2 });
  });

  it('a second apply inserts nothing and leaves the row counts unchanged', async () => {
    await load(ALL_FILES, true);
    const before = await rowCounts();
    const again = await load(ALL_FILES, true);
    expect(again.totals.legacyReleaseNames).toMatchObject({ inserted: 0, alreadyPresent: 9 });
    expect(again.totals.legacyDownloadJobs).toMatchObject({ inserted: 0, alreadyPresent: 2 });
    expect(await rowCounts()).toEqual(before);
    const dry = await load(ALL_FILES, false);
    expect(dry.totals.legacyReleaseNames.inserted).toBe(0);
  });

  it('stores names untrimmed, collapses duplicate lines, and keeps no URL line and no download id', async () => {
    const report = await load(ALL_FILES, true);
    expect(fileReport(report, 'radarrHistory').duplicateInFile).toBe(1);
    expect(fileReport(report, 'sabJobs').duplicateInFile).toBe(1);

    const grabs = await t.db
      .select()
      .from(legacyReleaseNames)
      .where(
        and(
          eq(legacyReleaseNames.externalId, 101),
          eq(legacyReleaseNames.recordKind, 'grabbed'),
          eq(legacyReleaseNames.releaseName, RH_GRAB[4] as string),
        ),
      );
    expect(grabs).toHaveLength(1); // lines 1 and 2 differ only in the download id
    const [imported] = await t.db
      .select({ name: legacyReleaseNames.releaseName })
      .from(legacyReleaseNames)
      .where(
        and(eq(legacyReleaseNames.externalId, 101), eq(legacyReleaseNames.recordKind, 'imported')),
      );
    expect(imported?.name).toBe(' Lantern.Harbor.2019.1080p.WEB.x264-QZXLAB ');
    const spaced = await t.db.select({ name: legacyDownloadJobs.name }).from(legacyDownloadJobs);
    expect(spaced.map((r) => r.name)).toContain(' Spaced.Name.2019-QZXLAB ');

    const stored = JSON.stringify([
      await t.db.select().from(legacyReleaseNames),
      await t.db.select().from(legacyDownloadJobs),
    ]);
    expect(stored).not.toContain('://');
    expect(stored).not.toContain('Url.Line.Name');
    expect(stored).not.toContain('DLID-');
    const json = JSON.stringify(report);
    for (const leak of ['example.invalid', 'QZXLAB', 'DLID-', 'Lantern'])
      expect(json).not.toContain(leak);
  });

  it('reports a file that was not given as absent', async () => {
    const report = await load({ sabJobs: SAB_JOBS }, false);
    expect(report.files.radarrHistory).toBe('absent');
    expect(fileReport(report, 'sabJobs').usable).toBe(3);
    expect(report.totals.legacyReleaseNames).toMatchObject({ read: 0, distinct: 0, inserted: 0 });
  });

  describe('the pool section', () => {
    let itemSeq = 0;
    const movie = (tmdbId: number, sizeOnDisk: number, deleted = false) =>
      t.db.insert(mediaItems).values({
        arrKind: 'radarr',
        arrItemId: ++itemSeq,
        tmdbId,
        title: `Pool Movie ${tmdbId}`,
        sortTitle: `pool movie ${tmdbId}`,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
        sizeOnDisk,
        deletedFromArrAt: deleted ? new Date('2026-10-01T00:00:00Z') : null,
      });
    const show = (tvdbId: number, deleted = false) =>
      t.db.insert(mediaItems).values({
        arrKind: 'sonarr',
        arrItemId: ++itemSeq,
        tvdbId,
        title: `Pool Show ${tvdbId}`,
        sortTitle: `pool show ${tvdbId}`,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/tv',
        sizeOnDisk: 5000,
        deletedFromArrAt: deleted ? new Date('2026-10-01T00:00:00Z') : null,
      });
    const candidate = (mediaKind: 'movie' | 'tv', id: number, collectionId = 1) =>
      t.db.insert(trashCandidates).values({
        mediaKind,
        collectionId,
        tmdbId: mediaKind === 'movie' ? id : null,
        tvdbId: mediaKind === 'tv' ? id : null,
      });

    // 301 file at the exact size + a grab; 302 a file one byte off; 303 a file row with an empty name only; 304 a
    // failed download only; 307 an import only, listed by two collections; 306 tombstoned; 308 not a candidate.
    const POOL_RADARR_FILES = tsv(
      [
        '301',
        '2001',
        'Pool.Exact.2001.1080p-QZXLAB',
        'QZXLAB',
        '1000',
        'WEBDL-1080p',
        '2023-01-01 00:00:00',
        'Pool Exact',
      ],
      [
        '302',
        '2002',
        'Pool.OffByOne.2002.1080p-QZXLAB',
        'QZXLAB',
        '2001',
        'WEBDL-1080p',
        '2023-01-01 00:00:00',
        'Pool Off',
      ],
      ['303', '2003', '', 'QZXLAB', '3000', 'WEBDL-1080p', '2023-01-01 00:00:00', 'Pool Unnamed'],
      [
        '306',
        '2006',
        'Pool.Gone.2006-QZXLAB',
        'QZXLAB',
        '6000',
        'WEBDL-1080p',
        '2023-01-01 00:00:00',
        'Pool Gone',
      ],
    );
    const POOL_RADARR_HISTORY = tsv(
      [
        '301',
        '2001',
        '1',
        '2023-01-01 00:00:00',
        'Pool.Exact.2001.1080p-QZXLAB',
        'DLID-P1',
        '',
        'QZXLAB',
        'Pool Exact',
      ],
      [
        '304',
        '2004',
        '4',
        '2023-01-01 00:00:00',
        'Pool.Failed.2004-QZXLAB',
        'DLID-P4',
        '',
        'QZXLAB',
        'Pool Failed',
      ],
      [
        '307',
        '2007',
        '3',
        '2023-01-01 00:00:00',
        'Pool.Imported.2007-QZXLAB',
        'DLID-P7',
        '',
        'QZXLAB',
        'Pool Imported',
      ],
      // A Radarr row for 402: a TMDB id never names a series of the same number.
      [
        '402',
        '2002',
        '1',
        '2023-01-01 00:00:00',
        'Pool.Wrong.Kind-QZXLAB',
        'DLID-P8',
        '',
        'QZXLAB',
        'Pool Wrong',
      ],
    );
    const POOL_SONARR_HISTORY = tsv(
      [
        '401',
        '1',
        '2023-01-01 00:00:00',
        'Pool.Show.S01-PLUMCART',
        'DLID-S1',
        '',
        'PLUMCART',
        '1',
        '3',
        'Pool Show',
      ],
      [
        '403',
        '1',
        '2023-01-01 00:00:00',
        'Pool.Show.Gone.S01-PLUMCART',
        'DLID-S3',
        '',
        'PLUMCART',
        '1',
        '3',
        'Gone',
      ],
    );
    const EXPECTED = {
      movies: {
        titles: 5,
        fileNamedByExactSize: 1,
        withGrabName: 2,
        withAnyName: 4,
        withNoName: 1,
      },
      shows: { titles: 2, withAnyName: 1, withNoName: 1 },
    };

    beforeEach(async () => {
      for (const [id, size] of [
        [301, 1000],
        [302, 2000],
        [303, 3000],
        [304, 4000],
        [307, 7000],
        [308, 8000],
      ] as const) {
        await movie(id, size);
      }
      await movie(306, 6000, true);
      for (const id of [301, 302, 303, 304, 306]) await candidate('movie', id);
      await candidate('movie', 307, 1);
      await candidate('movie', 307, 2);
      await show(401);
      await show(402);
      await show(403, true);
      for (const id of [401, 402, 403]) await candidate('tv', id);
    });

    it('counts the five movie figures and the show figures, the same before and after the load', async () => {
      const files = {
        radarrFiles: POOL_RADARR_FILES,
        radarrHistory: POOL_RADARR_HISTORY,
        sonarrHistory: POOL_SONARR_HISTORY,
      };
      const dry = await load(files, false);
      expect(dry.pool).toEqual(EXPECTED);
      const applied = await load(files, true);
      expect(applied.pool).toEqual(EXPECTED);
      // From the table alone (no file given).
      expect((await load({}, false)).pool).toEqual(EXPECTED);
    });

    it('combines the rows already in the table with the rows this run parsed', async () => {
      await load({ radarrFiles: POOL_RADARR_FILES }, true);
      const dry = await load(
        { radarrHistory: POOL_RADARR_HISTORY, sonarrHistory: POOL_SONARR_HISTORY },
        false,
      );
      expect(dry.pool).toEqual(EXPECTED);
      expect(await rowCounts()).toEqual({ names: 3, jobs: 0 });
    });
  });
});
