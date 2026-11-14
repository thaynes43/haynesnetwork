// ADR-117 / DESIGN-052 D-29 — the posted-name backfill, on embedded PG16 with the in-memory *arr (no live API):
// one class per title still gone; the names come from the ledger, the legacy tables and the size-matched old jobs;
// review F5 (a title that has a term and still has a posted name no live term matches; a title whose terms would
// not fit under the cap is left out and nothing is pruned; a failed reconcile leaves nothing behind and a second
// apply starts clean); a dry run writes nothing and builds no *arr client; a title back in the library is never
// termed; a delete 365 days old is never restarted. Every title, group and release name here is invented.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { ledgerEvents, mediaItems, trashBatchItems, trashBatches, trashDeletedReleases } from '@hnet/db/schema';
import {
  RELEASE_BLOCK_SENTINEL,
  RELEASE_BLOCK_TERM_CAP,
  RELEASE_TERM_LIFETIME_DAYS,
  ReleaseBlockError,
  backfillPostedReleaseNames,
  createStaticReleaseBlockArr,
  deriveTerm,
  loadLegacyReleaseNames,
  termMatchesRaw,
  upsertMediaItemsBatch,
  type DomainLogger,
  type PostedNameBackfillClass,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-13T12:00:00Z');
const DELETED = new Date('2026-10-10T12:00:00Z');
const EXPIRED = new Date(NOW.getTime() - (RELEASE_TERM_LIFETIME_DAYS + 1) * DAY_MS);
const quiet: DomainLogger = { info: () => {}, warn: () => {}, error: () => {} };

const termFor = (title: string, year: number, name: string) =>
  deriveTerm({
    kind: 'movie',
    arrTitle: title,
    arrYears: [year],
    releaseNames: [name],
    renamedFileName: null,
    releaseGroup: null,
    resolution: null,
    remux: false,
  })!.term;

/** Every title is in exactly one outcome. */
function sums(row: PostedNameBackfillClass): void {
  expect(row.expired + row.named + row.unnamed + row.noNewTerm + row.capRefused + row.unread).toBe(row.titles);
}

describe('the posted-name backfill (ADR-117 / DESIGN-052 D-29)', () => {
  let t: TestDb;
  const ids: Record<string, string> = {};
  const MOVIES: Array<[string, number, number]> = [
    ['Posted Movie', 7001, 2020],
    ['Renamed Movie', 7002, 2019],
    ['Live Movie', 7003, 2018],
    ['Old Movie', 7004, 2017],
    ['Sized Movie', 7005, 2016],
    ['Upgraded Movie', 7006, 2021],
  ];

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: MOVIES.map(([title, tmdbId, year], i) => ({
        arrItemId: 800 + i,
        tmdbId,
        title,
        sortTitle: title.toLowerCase(),
        year,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      })),
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 80,
          tvdbId: 8001,
          title: 'Quiet Show',
          sortTitle: 'quiet show',
          year: 2015,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
    for (const row of await t.db.select().from(mediaItems)) ids[row.title] = row.id;
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashDeletedReleases);
    await t.db.delete(trashBatchItems);
    await t.db.delete(trashBatches);
    await t.db.delete(ledgerEvents);
    await t.db.execute(sql`TRUNCATE legacy_release_names, legacy_download_jobs`);
    // Every title is gone from its *arr, except the one that was added back.
    await t.db.update(mediaItems).set({ deletedFromArrAt: DELETED });
    await t.db.update(mediaItems).set({ deletedFromArrAt: null }).where(eq(mediaItems.tmdbId, 7003));
  });

  async function deletedBatch(
    kind: 'movie' | 'tv',
    rows: Array<{ title: string; deletedAt?: Date; size?: number }>,
  ): Promise<void> {
    const [batch] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: kind, state: 'deleted', deletedAt: rows[0]!.deletedAt ?? DELETED })
      .returning();
    const movie = (title: string) => MOVIES.find(([name]) => name === title);
    await t.db.insert(trashBatchItems).values(
      rows.map((row, i) => ({
        batchId: batch!.id,
        maintainerrMediaId: `bf-${kind}-${batch!.id}-${i}`,
        mediaItemId: ids[row.title]!,
        title: row.title,
        year: kind === 'movie' ? movie(row.title)![2] : 2015,
        tmdbId: kind === 'movie' ? movie(row.title)![1] : null,
        tvdbId: kind === 'tv' ? 8001 : null,
        state: 'deleted' as const,
        deletedAt: row.deletedAt ?? DELETED,
        deletedSizeBytes: row.size ?? null,
      })),
    );
  }
  /** A live record the delete itself wrote. */
  async function record(
    title: string,
    over: {
      term: string;
      identitySource?: 'arr_file' | 'arr_grab_history';
      termConfidence?: 'low_confidence' | 'verified';
      state?: 'active' | 'expired';
    },
  ): Promise<void> {
    const [, tmdbId, year] = MOVIES.find(([name]) => name === title)!;
    await t.db.insert(trashDeletedReleases).values({
      arrKind: 'radarr',
      mediaItemId: ids[title]!,
      tmdbId,
      title,
      year,
      identitySource: over.identitySource ?? 'arr_grab_history',
      term: over.term,
      termConfidence: over.termConfidence ?? 'verified',
      state: over.state ?? 'active',
      origin: 'sweep',
      recordedAt: DELETED,
      activatedAt: DELETED,
      expiresAt: new Date(DELETED.getTime() + RELEASE_TERM_LIFETIME_DAYS * DAY_MS),
    });
  }
  async function grab(title: string, name: string, eventType: 'grabbed' | 'download_failed' = 'grabbed', at = DELETED) {
    await t.db.insert(ledgerEvents).values({
      mediaItemId: ids[title]!,
      eventType,
      source: 'radarr',
      sourceEventId: `${title}:${name}:${eventType}`,
      occurredAt: new Date(at.getTime() - DAY_MS),
      payload: { sourceTitle: name, downloadId: `dl:${name}` },
    });
  }
  const tsv = (...fields: Array<string | number>) => fields.join('\t');
  const legacy = (files: Parameters<typeof loadLegacyReleaseNames>[0]['files']) =>
    loadLegacyReleaseNames({ db: t.db, files, apply: true, logger: quiet });
  const rows = () => t.db.select().from(trashDeletedReleases);

  /** The estate every class test starts from. */
  async function seedClasses(): Promise<{ renamedTerm: string; upgradedTerm: string }> {
    await deletedBatch('movie', [
      { title: 'Posted Movie', size: 5_000 },
      { title: 'Renamed Movie', size: 5_000 },
      { title: 'Live Movie', size: 5_000 },
      { title: 'Old Movie', deletedAt: EXPIRED, size: 5_000 },
      { title: 'Sized Movie', size: 9_600 },
      { title: 'Upgraded Movie', size: 5_000 },
    ]);
    await deletedBatch('tv', [{ title: 'Quiet Show' }]);
    // `movies`: no term at all; the ledger has the grab, a failed grab, a URL and a later (post-delete) grab.
    await grab('Posted Movie', 'Posted.Movie.2020.1080p.WEB-DL.x264-POSTGRP');
    await grab('Posted Movie', 'Posted.Movie.2020.720p.WEB-DL.x264-BROKEN', 'download_failed');
    await grab('Posted Movie', 'https://example.invalid/x');
    await grab('Posted Movie', 'Posted.Movie.2020.2160p.WEB-DL.x265-AFTER', 'grabbed', new Date(DELETED.getTime() + 5 * DAY_MS));
    // `lowConfidence`: a live renamed-file record; only the legacy table names it.
    const renamedTerm = termFor('Renamed Movie', 2019, 'Renamed.Movie.2019.1080p.BluRay.x264-RENGRP');
    await record('Renamed Movie', { term: renamedTerm, identitySource: 'arr_file', termConfidence: 'low_confidence' });
    // Back in the library: never termed, whatever the ledger holds.
    await grab('Live Movie', 'Live.Movie.2018.1080p.WEB-DL.x264-LIVEGRP');
    // 365 days gone: nothing restarts its term.
    await grab('Old Movie', 'Old.Movie.2017.1080p.WEB-DL.x264-OLDGRP', 'grabbed', EXPIRED);
    // `otherNames` (review F5): a verified term for the last file, and an earlier grab it does not match.
    const upgradedTerm = termFor('Upgraded Movie', 2021, 'Upgraded.Movie.2021.2160p.WEB-DL.x265-NEWGRP');
    await record('Upgraded Movie', { term: upgradedTerm });
    await grab('Upgraded Movie', 'Upgraded.Movie.2021.2160p.WEB-DL.x265-NEWGRP');
    await grab('Upgraded Movie', 'Upgraded.Movie.2021.1080p.WEB-DL.x264-FIRSTGRP');
    return { renamedTerm, upgradedTerm };
  }

  it('a dry run counts each class, writes nothing and needs no *arr client', async () => {
    await seedClasses();
    await legacy({
      radarrHistory: tsv(7002, 2019, 1, '2025-01-15 10:00:00', 'Renamed.Movie.2019.1080p.BluRay.x264-TRUEGRP', 'x', '', 'TRUEGRP', 'Renamed Movie'),
      // 96 percent of this job is the deleted file: it adds a term, by the D-15 size rule.
      sabJobs: tsv('old-history-a', 'Sized.Movie.2016.1080p.BluRay.x264-SIZEGRP', 10_000, 1_700_000_000, 'movies', 'Completed'),
    });
    const before = await rows();
    const report = await backfillPostedReleaseNames({ db: t.db, apply: false, logger: quiet, now: NOW });
    expect(await rows()).toEqual(before);
    for (const bucket of [report.lowConfidence, report.movies, report.shows, report.otherNames]) sums(bucket);

    expect(report.lowConfidence).toMatchObject({ titles: 1, named: 1, records: 1, namesSeen: 1 });
    // Posted Movie (2 records, 1 URL skipped, the post-delete grab not read), Old Movie (expired), Sized Movie (1).
    expect(report.movies).toMatchObject({ titles: 3, expired: 1, named: 2, records: 3, urlsSkipped: 1, namesSeen: 3 });
    expect(report.shows).toMatchObject({ titles: 1, unnamed: 1, records: 0 });
    expect(report.otherNames).toMatchObject({ titles: 1, named: 1, records: 1, alreadyBlocked: 1, namesSeen: 2 });
    expect(report.skippedLive).toEqual({ movies: 1, shows: 0 });
    expect(report.terms.radarr).toEqual({ live: 2, added: 5, cap: RELEASE_BLOCK_TERM_CAP });
    expect(report.terms.sonarr).toEqual({ live: 0, added: 0, cap: RELEASE_BLOCK_TERM_CAP });
    expect(report.reconciled).toEqual([]);
  });

  it('apply records the names beside what is there, writes and reads back the profile, then turns them active', async () => {
    const { renamedTerm, upgradedTerm } = await seedClasses();
    await legacy({
      radarrHistory: tsv(7002, 2019, 1, '2025-01-15 10:00:00', 'Renamed.Movie.2019.1080p.BluRay.x264-TRUEGRP', 'x', '', 'TRUEGRP', 'Renamed Movie'),
    });
    const { arr, fixture } = createStaticReleaseBlockArr();
    const report = await backfillPostedReleaseNames({ db: t.db, arr, apply: true, logger: quiet, now: NOW });
    expect(report.reconciled).toHaveLength(1);
    expect(report.reconciled[0]).toMatchObject({ arrKind: 'radarr', added: 6, pruned: 0, wrote: true });

    const all = await rows();
    const backfilled = all.filter((r) => r.origin === 'backfill');
    expect(backfilled).toHaveLength(4);
    expect(backfilled.every((r) => r.state === 'active' && r.termConfidence === 'verified')).toBe(true);
    // The term's life runs from the delete, not from today.
    for (const r of backfilled) {
      expect(r.expiresAt.getTime()).toBe(DELETED.getTime() + RELEASE_TERM_LIFETIME_DAYS * DAY_MS);
    }
    // Nothing that was there is removed or weakened.
    expect(all.find((r) => r.term === renamedTerm)).toMatchObject({ state: 'active', termConfidence: 'low_confidence' });
    expect(all.find((r) => r.term === upgradedTerm)).toMatchObject({ state: 'active' });
    const ignored = fixture.profiles.radarr[0]!.ignored;
    expect(ignored).toContain(RELEASE_BLOCK_SENTINEL);
    for (const name of [
      'Posted.Movie.2020.1080p.WEB-DL.x264-POSTGRP',
      'Posted.Movie.2020.720p.WEB-DL.x264-BROKEN',
      'Renamed.Movie.2019.1080p.BluRay.x264-TRUEGRP',
      'Upgraded.Movie.2021.1080p.WEB-DL.x264-FIRSTGRP',
    ]) {
      expect(ignored.some((term) => termMatchesRaw(term, name)), name).toBe(true);
    }
    // The title back in the library, the post-delete grab and the 365-day-old delete got nothing.
    for (const name of [
      'Live.Movie.2018.1080p.WEB-DL.x264-LIVEGRP',
      'Posted.Movie.2020.2160p.WEB-DL.x265-AFTER',
      'Old.Movie.2017.1080p.WEB-DL.x264-OLDGRP',
    ]) {
      expect(ignored.some((term) => termMatchesRaw(term, name)), name).toBe(false);
    }

    // A second apply adds nothing: every name is blocked now.
    const again = await backfillPostedReleaseNames({ db: t.db, arr, apply: true, logger: quiet, now: NOW });
    expect(again.movies.records + again.lowConfidence.records + again.otherNames.records).toBe(0);
    expect(again.reconciled).toEqual([]);
    expect((await rows()).length).toBe(all.length);
  });

  it('a title that has only an expired record still counts as termed, and its unblocked name is recorded (otherNames)', async () => {
    await deletedBatch('movie', [{ title: 'Upgraded Movie', size: 5_000 }]);
    await record('Upgraded Movie', {
      term: termFor('Upgraded Movie', 2021, 'Upgraded.Movie.2021.2160p.WEB-DL.x265-NEWGRP'),
      state: 'expired',
    });
    await grab('Upgraded Movie', 'Upgraded.Movie.2021.1080p.WEB-DL.x264-FIRSTGRP');
    const report = await backfillPostedReleaseNames({ db: t.db, apply: false, logger: quiet, now: NOW });
    expect(report.movies.titles).toBe(0);
    expect(report.otherNames).toMatchObject({ titles: 1, named: 1, records: 1 });
  });

  it('review F5: a title whose terms would not fit under the cap is left out whole, and apply prunes nothing', async () => {
    await deletedBatch('movie', [{ title: 'Posted Movie', size: 5_000 }, { title: 'Upgraded Movie', size: 5_000 }]);
    // Posted Movie needs two new terms, Upgraded Movie one. One slot is free.
    await grab('Posted Movie', 'Posted.Movie.2020.1080p.WEB-DL.x264-POSTGRP');
    await grab('Posted Movie', 'Posted.Movie.2020.720p.WEB-DL.x264-BROKEN', 'download_failed');
    await grab('Upgraded Movie', 'Upgraded.Movie.2021.1080p.WEB-DL.x264-FIRSTGRP');
    const filler = Array.from({ length: RELEASE_BLOCK_TERM_CAP - 1 }, (_, i) => ({
      arrKind: 'radarr' as const,
      title: `Cap ${i}`,
      identitySource: 'arr_grab_history' as const,
      term: termFor(`Cap ${i}`, 2020, `Cap.${i}.2020.1080p.BluRay.x264-CAPGRP`),
      termConfidence: 'verified' as const,
      state: 'active' as const,
      origin: 'sweep' as const,
      recordedAt: new Date(DELETED.getTime() - DAY_MS + i),
      expiresAt: new Date(NOW.getTime() + 100 * DAY_MS),
    }));
    for (let from = 0; from < filler.length; from += 500) {
      await t.db.insert(trashDeletedReleases).values(filler.slice(from, from + 500));
    }
    const { arr, fixture } = createStaticReleaseBlockArr();
    const report = await backfillPostedReleaseNames({ db: t.db, arr, apply: true, logger: quiet, now: NOW });
    expect(report.movies).toMatchObject({ titles: 2, named: 1, capRefused: 1, records: 1 });
    expect(report.terms.radarr).toEqual({ live: RELEASE_BLOCK_TERM_CAP - 1, added: 1, cap: RELEASE_BLOCK_TERM_CAP });
    expect(report.reconciled[0]).toMatchObject({ pruned: 0, total: RELEASE_BLOCK_TERM_CAP });
    const all = await rows();
    expect(all.some((r) => r.state === 'pruned')).toBe(false);
    expect(all.filter((r) => r.state === 'active')).toHaveLength(RELEASE_BLOCK_TERM_CAP);
    expect(fixture.profiles.radarr[0]!.ignored).toHaveLength(RELEASE_BLOCK_TERM_CAP + 1);
    expect(all.filter((r) => r.origin === 'backfill').map((r) => r.title)).toEqual(['Upgraded Movie']);
  });

  it('a profile that cannot be written leaves no record live and no term behind; the next apply starts clean', async () => {
    await deletedBatch('movie', [{ title: 'Posted Movie', size: 5_000 }]);
    await grab('Posted Movie', 'Posted.Movie.2020.1080p.WEB-DL.x264-POSTGRP');
    const failing = createStaticReleaseBlockArr({ fail: new Set(['radarr:create']) });
    const err = await backfillPostedReleaseNames({ db: t.db, arr: failing.arr, apply: true, logger: quiet, now: NOW }).catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(ReleaseBlockError);
    expect((await rows()).map((r) => r.state)).toEqual(['abandoned']);
    expect(failing.fixture.profiles.radarr).toHaveLength(0);

    const { arr, fixture } = createStaticReleaseBlockArr();
    const report = await backfillPostedReleaseNames({ db: t.db, arr, apply: true, logger: quiet, now: NOW });
    expect(report.movies).toMatchObject({ titles: 1, named: 1, records: 1 });
    expect((await rows()).filter((r) => r.state === 'active')).toHaveLength(1);
    expect(fixture.profiles.radarr[0]!.ignored).toHaveLength(2);
  });

  it('a token-bearing grab is termed or counted, never dropped', async () => {
    await deletedBatch('movie', [{ title: 'Posted Movie', size: 5_000 }]);
    const grabName = 'Posted.Movie.2020.1080p.BluRay.x264-TOKGRP {tmdb-7001}';
    const failedName = 'Posted.Movie.2020.720p.WEB-DL.x264-FAILGRP {imdb-tt0007001}';
    await grab('Posted Movie', grabName);
    await grab('Posted Movie', failedName, 'download_failed');
    const dry = await backfillPostedReleaseNames({ db: t.db, apply: false, logger: quiet, now: NOW });
    sums(dry.movies);
    expect(dry.movies.namesSeen).toBe(2);
    expect(dry.movies.unnamed).toBe(0);
    const termed = dry.movies.records > 0;
    const counted = dry.movies.untermed + dry.movies.skipped > 0;
    expect(termed || counted).toBe(true);
    if (dry.movies.records === 2) {
      const { arr, fixture } = createStaticReleaseBlockArr();
      const applied = await backfillPostedReleaseNames({ db: t.db, arr, apply: true, logger: quiet, now: NOW });
      expect(applied.movies).toMatchObject({ named: 1, records: 2 });
      const ignored = fixture.profiles.radarr[0]!.ignored;
      for (const name of [grabName, failedName]) {
        expect(ignored.some((term) => termMatchesRaw(term, name)), name).toBe(true);
      }
    }
  });

  it('counts a name it cannot term and a name that names no release, and records the rest of the title', async () => {
    await deletedBatch('movie', [{ title: 'Posted Movie', size: 5_000 }]);
    await grab('Posted Movie', 'Posted.Movie.2020.1080p.WEB-DL.x264-POSTGRP');
    await grab('Posted Movie', '[02/31] - "Posted.Movie.2020.1080p.WEB-DL.x264-ODD.part02.rar" yEnc');
    await grab('Posted Movie', 'Posted Movie');
    const report = await backfillPostedReleaseNames({ db: t.db, apply: false, logger: quiet, now: NOW });
    expect(report.movies).toMatchObject({ titles: 1, named: 1, records: 1, untermed: 1, skipped: 1, namesSeen: 3 });
  });

  it('never touches a title the ledger lists as live, whichever class it would be in', async () => {
    await deletedBatch('movie', [{ title: 'Live Movie', size: 5_000 }]);
    await record('Live Movie', {
      term: termFor('Live Movie', 2018, 'Live.Movie.2018.1080p.BluRay.x264-RENGRP'),
      identitySource: 'arr_file',
      termConfidence: 'low_confidence',
    });
    await grab('Live Movie', 'Live.Movie.2018.1080p.WEB-DL.x264-LIVEGRP');
    const { arr } = createStaticReleaseBlockArr();
    const report = await backfillPostedReleaseNames({ db: t.db, arr, apply: true, logger: quiet, now: NOW });
    expect(report.skippedLive).toEqual({ movies: 1, shows: 0 });
    expect(report.lowConfidence.titles + report.movies.titles + report.otherNames.titles).toBe(0);
    expect(await t.db.select().from(trashDeletedReleases).where(inArray(trashDeletedReleases.origin, ['backfill']))).toEqual(
      [],
    );
  });
});
