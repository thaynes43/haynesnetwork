// ADR-093 C-13 / C-21 / DESIGN-052 D-15 (PLAN-072 S8) — seeding the Release Block for past deletions, on embedded PG16
// with the in-memory *arr: the dry run writes nothing; a deleted row whose *arr record still exists is skipped (and one
// whose presence cannot be confirmed); the ledger identifies first, then the legacy SAB by title, year ±1, completion
// before the delete and size 90..100 %; the rest is counted unblockable; the named titles are reported; `--manual`
// adds the remediation names; `--apply` writes `active` records (365 days from the deletion) and reconciles; a re-run
// skips what is already recorded.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  ledgerEvents,
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
} from '@hnet/db/schema';
import {
  RELEASE_BLOCK_SENTINEL,
  createStaticReleaseBlockArr,
  matchLegacySab,
  parseLegacySabFile,
  parseManualSeedFile,
  seedReleaseBlock,
  silentDomainLogger,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const DAY = 86_400_000;

describe('the Release Block seed (DESIGN-052 D-15)', () => {
  let t: TestDb;
  const deletedAt = new Date('2026-08-01T00:00:00Z');
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        [101, 5101, 'Ledger Movie', 2020],
        [102, 5102, 'Silent Night', 2023],
        [103, 5103, 'Still Here', 2021],
        [104, 5104, 'Nobody Knows', 2019],
      ].map(([arrItemId, tmdbId, title, year]) => ({
        arrItemId: arrItemId as number,
        tmdbId: tmdbId as number,
        title: title as string,
        sortTitle: String(title).toLowerCase(),
        year: year as number,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      })),
    });
    for (const r of await t.db.select().from(mediaItems)) ids[r.title] = r.id;
    const [ledgerItem] = [ids['Ledger Movie']!];
    await t.db.insert(ledgerEvents).values([
      {
        mediaItemId: ledgerItem,
        eventType: 'grabbed',
        source: 'radarr',
        sourceEventId: 'seed-g',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
        payload: {
          sourceTitle: 'Ledger.Movie.2020.1080p.BluRay.x264-SPARKS',
          downloadId: 'D1',
          releaseGroup: 'SPARKS',
          quality: 'Bluray-1080p',
        },
      },
      {
        mediaItemId: ledgerItem,
        eventType: 'imported',
        source: 'radarr',
        sourceEventId: 'seed-i',
        occurredAt: new Date('2026-06-01T01:00:00Z'),
        payload: {
          sourceTitle: 'Ledger.Movie.2020.1080p.BluRay.x264-SPARKS',
          downloadId: 'D1',
          quality: 'Bluray-1080p',
        },
      },
    ]);
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashDeletedReleases);
    await t.db.delete(trashBatches);
    const [batch] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'deleted', deletedAt })
      .returning();
    await t.db.insert(trashBatchItems).values(
      [
        ['Ledger Movie', 2020, 5101, 8_000_000_000],
        ['Silent Night', 2023, 5102, 9_600_000_000],
        ['Still Here', 2021, 5103, 1],
        ['Nobody Knows', 2019, 5104, 1],
      ].map(([title, year, tmdbId, size], i) => ({
        batchId: batch!.id,
        maintainerrMediaId: `ms-${i}`,
        mediaItemId: ids[title as string]!,
        title: title as string,
        year: year as number,
        tmdbId: tmdbId as number,
        state: 'deleted' as const,
        deletedAt,
        deletedSizeBytes: size as number,
      })),
    );
    // The ledger still lists every item live; the *arr answers: Still Here (103) is still there, the rest are gone.
    await t.db.update(mediaItems).set({ deletedFromArrAt: null });
  });

  const legacy = parseLegacySabFile(
    [
      '# name<TAB>bytes<TAB>completed',
      'Silent.Night.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX\t10000000000\t2026-03-01T00:00:00Z',
      'Silent.Night.2023.1080p.WEB-DL.DDP5.1.H.264-OTHER\t4000000000\t2026-03-01T00:00:00Z', // wrong size
      '{"name":"Nobody.Knows.2019.1080p.BluRay.x264-GRP","bytes":1,"completed":"2026-09-01T00:00:00Z"}', // after the delete
    ].join('\n'),
  );

  const arrWithPresence = () => {
    const { arr, fixture } = createStaticReleaseBlockArr({ synthesize: false });
    fixture.movies.set(103, { title: 'Still Here', year: 2021, tmdbId: 5103, file: null });
    return { arr, fixture };
  };

  it('parses the legacy SAB export and matches by title, year ±1, completion before the delete and size 90..100 %', () => {
    expect(legacy).toHaveLength(3);
    expect(() => parseLegacySabFile('https://indexer/api?apikey=x\t1\t2026-01-01')).toThrow(/URL/);
    const matches = matchLegacySab(
      { title: 'Silent Night', year: 2023, deletedAt, deletedSizeBytes: 9_600_000_000 },
      legacy,
    );
    expect(matches.map((m) => m.name)).toEqual([
      'Silent.Night.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
    ]);
    expect(
      matchLegacySab(
        { title: 'Silent Night', year: 2021, deletedAt, deletedSizeBytes: 9_600_000_000 },
        legacy,
      ),
    ).toEqual([]);
  });

  it('the dry run counts per source and writes nothing', async () => {
    const { arr, fixture } = arrWithPresence();
    const report = await seedReleaseBlock({
      db: t.db,
      arr,
      apply: false,
      legacySab: legacy,
      logger: silentDomainLogger,
    });
    expect(report).toMatchObject({
      apply: false,
      population: 4,
      skippedPresent: 1,
      identified: { ledger: 1, legacySab: 1 },
      unblockable: { movies: 1, series: 0 },
      records: 2,
    });
    expect(report.named).toEqual([
      { title: 'Silent Night', batchRows: 1, matchedBy: 'legacy_sab' },
      { title: 'The Unholy Trinity', batchRows: 0, matchedBy: null },
    ]);
    expect(await t.db.select().from(trashDeletedReleases)).toEqual([]);
    expect(fixture.calls.some((c) => c.includes('create') || c.includes('update'))).toBe(false);
  });

  it('a presence that cannot be confirmed is skipped (never seeded blind)', async () => {
    const { arr, fixture } = arrWithPresence();
    fixture.fail.add('radarr:find');
    const report = await seedReleaseBlock({
      db: t.db,
      arr,
      apply: false,
      logger: silentDomainLogger,
    });
    expect(report).toMatchObject({ skippedUnverified: 4, records: 0 });
  });

  it('apply writes active records from each deletion, reconciles, and a re-run skips them', async () => {
    const { arr, fixture } = arrWithPresence();
    const manual = parseManualSeedFile(
      JSON.stringify([
        {
          tmdbId: 974573,
          title: 'Another Simple Favor',
          year: 2025,
          releaseNames: [
            'Another.Simple.Favor.2025.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
            'Another.Simple.Favor.2025.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-Kitsune',
          ],
        },
      ]),
    );
    const report = await seedReleaseBlock({
      db: t.db,
      arr,
      apply: true,
      legacySab: legacy,
      manual,
      logger: silentDomainLogger,
    });
    expect(report.manual).toEqual({ entries: 1, records: 2, skipped: 0 });
    const rows = await t.db.select().from(trashDeletedReleases);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.state === 'active')).toBe(true);
    const byOrigin = rows.map((r) => [r.origin, r.identitySource]).sort();
    expect(byOrigin).toEqual([
      ['backfill', 'ledger_grab'],
      ['backfill', 'legacy_sab'],
      ['remediation', 'legacy_sab'],
      ['remediation', 'legacy_sab'],
    ]);
    const ledgerRow = rows.find((r) => r.identitySource === 'ledger_grab')!;
    expect(ledgerRow.expiresAt.getTime()).toBe(deletedAt.getTime() + 365 * DAY);
    expect(fixture.profiles.radarr[0]!.ignored).toHaveLength(5); // the sentinel + four terms
    expect(fixture.profiles.radarr[0]!.ignored).toContain(RELEASE_BLOCK_SENTINEL);
    expect(report.reconciled).toHaveLength(1);

    const again = await seedReleaseBlock({
      db: t.db,
      arr,
      apply: true,
      legacySab: legacy,
      manual,
      logger: silentDomainLogger,
    });
    expect(again).toMatchObject({
      skippedAlreadyRecorded: 2,
      records: 0,
      manual: { records: 0, skipped: 2 },
    });
    expect(await t.db.select().from(trashDeletedReleases)).toHaveLength(4);
    // The records point at the batch rows they seed.
    const [silent] = await t.db
      .select()
      .from(trashBatchItems)
      .where(and(eq(trashBatchItems.title, 'Silent Night'), eq(trashBatchItems.state, 'deleted')));
    expect(
      rows.find((r) => r.identitySource === 'legacy_sab' && r.origin === 'backfill')!.batchItemId,
    ).toBe(silent!.id);
  });
});
