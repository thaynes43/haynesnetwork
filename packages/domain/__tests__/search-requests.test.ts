import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, mediaItems } from '@hnet/db/schema';
import {
  FIX_RATE_LIMIT_PER_HOUR,
  FixRateLimitError,
  FixTargetRequiredError,
  LedgerItemTombstonedError,
  createFixRequest,
  recordSearchRequest,
  tombstoneMissingItems,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('Force Search single-writer (DESIGN-005 D-07/D-17)', () => {
  let t: TestDb;
  let memberId: string;
  let sonarrItemId: string;
  let radarrItemId: string;
  let lidarrItemId: string;
  let tombstonedItemId: string;

  const searchEventsFor = (mediaItemId: string) =>
    t.db
      .select()
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.mediaItemId, mediaItemId),
          eq(ledgerEvents.eventType, 'search_requested'),
        ),
      );

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'searcher@example.com', displayName: 'Searcher' }))
      .id;

    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 1,
          tvdbId: 100,
          title: 'Show',
          sortTitle: 'show',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 1,
          tmdbId: 200,
          title: 'Movie',
          sortTitle: 'movie',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
        {
          arrItemId: 2,
          tmdbId: 201,
          title: 'Gone Movie',
          sortTitle: 'gone movie',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'lidarr',
      items: [
        {
          arrItemId: 1,
          musicbrainzArtistId: 'mb-artist-1',
          title: 'Artist',
          sortTitle: 'artist',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Lossless',
          rootFolder: '/music',
        },
      ],
    });
    await tombstoneMissingItems({ db: t.db, arrKind: 'radarr', seenArrItemIds: [1] });

    const items = await t.db.select().from(mediaItems);
    sonarrItemId = items.find((i) => i.arrKind === 'sonarr')!.id;
    radarrItemId = items.find((i) => i.arrKind === 'radarr' && i.arrItemId === 1)!.id;
    lidarrItemId = items.find((i) => i.arrKind === 'lidarr')!.id;
    tombstonedItemId = items.find((i) => i.arrKind === 'radarr' && i.arrItemId === 2)!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('writes an attributed search_requested event (whole-series: no child)', async () => {
    const { eventId, arrKind } = await recordSearchRequest({
      db: t.db,
      requesterId: memberId,
      mediaItemId: sonarrItemId,
      targetLabel: null,
    });
    expect(arrKind).toBe('sonarr');
    const events = await searchEventsFor(sonarrItemId);
    const event = events.find((e) => e.id === eventId)!;
    expect(event.source).toBe('app');
    expect(event.requestedByUserId).toBe(memberId);
    expect(event.payload).toMatchObject({ requesterId: memberId, targetArrChildId: null });
  });

  it('carries an episode/album child target when given', async () => {
    const { eventId } = await recordSearchRequest({
      db: t.db,
      requesterId: memberId,
      mediaItemId: sonarrItemId,
      targetArrChildId: 5010,
      targetLabel: 'S01E10 · Finale',
    });
    const [event] = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.id, eventId));
    expect(event!.payload).toMatchObject({
      targetArrChildId: 5010,
      targetLabel: 'S01E10 · Finale',
    });
  });

  it('enforces per-kind target rules: radarr forbids a child, lidarr requires one', async () => {
    await expect(
      recordSearchRequest({
        db: t.db,
        requesterId: memberId,
        mediaItemId: radarrItemId,
        targetArrChildId: 9,
      }),
    ).rejects.toThrow(FixTargetRequiredError);
    await expect(
      recordSearchRequest({ db: t.db, requesterId: memberId, mediaItemId: lidarrItemId }),
    ).rejects.toThrow(FixTargetRequiredError);
    // radarr with no child, and sonarr with no child, are both allowed.
    await expect(
      recordSearchRequest({ db: t.db, requesterId: memberId, mediaItemId: radarrItemId }),
    ).resolves.toBeDefined();
  });

  it('rejects a force-search on a tombstoned item', async () => {
    await expect(
      recordSearchRequest({ db: t.db, requesterId: memberId, mediaItemId: tombstonedItemId }),
    ).rejects.toThrow(LedgerItemTombstonedError);
  });

  it('shares the hourly budget with Fix: a Fix then searches to the limit → blocked', async () => {
    const user = (await createUser(t.db, { email: 'budget@example.com' })).id;
    // One Fix consumes one unit of the shared 5/hour budget.
    await createFixRequest({
      db: t.db,
      requesterId: user,
      mediaItemId: sonarrItemId,
      targetArrChildId: 700,
      reason: 'wont_play_corrupt',
    });
    // Four more Force Searches reach the limit (1 fix + 4 searches = 5).
    for (let i = 0; i < FIX_RATE_LIMIT_PER_HOUR - 1; i++) {
      await recordSearchRequest({ db: t.db, requesterId: user, mediaItemId: radarrItemId });
    }
    // The next action of EITHER kind is rejected by the shared budget.
    await expect(
      recordSearchRequest({ db: t.db, requesterId: user, mediaItemId: radarrItemId }),
    ).rejects.toThrow(FixRateLimitError);
    await expect(
      createFixRequest({
        db: t.db,
        requesterId: user,
        mediaItemId: sonarrItemId,
        targetArrChildId: 701,
        reason: 'wrong_language',
      }),
    ).rejects.toThrow(FixRateLimitError);
    // Admins bypass.
    await expect(
      recordSearchRequest({
        db: t.db,
        requesterId: user,
        requesterIsAdmin: true,
        mediaItemId: radarrItemId,
      }),
    ).resolves.toBeDefined();
  });
});
