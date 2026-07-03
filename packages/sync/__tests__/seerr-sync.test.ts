// DESIGN-005 D-14 Seerr attribution: tmdb/tvdb item mapping, case-insensitive email
// auto-link (Q-01 — plexUsername is only a payload suggestion), NULL-FK ingestion for
// early requests, and the backfill post-step linking them once item/user appear.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, mediaItems, syncState } from '@hnet/db/schema';
import { runSync } from '../src/index';
import {
  bootMigratedDb,
  createUser,
  fixture,
  radarrStub,
  seerrRequestJson,
  seerrRequestPage,
  seerrStub,
  seriesJson,
  sonarrStub,
  type TestDb,
} from './helpers';

describe('seerr request sync (DESIGN-005 D-14 attribution)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('links requests by tmdb/tvdb and auto-links users by email, case-insensitively', async () => {
    // The ledger already knows the movie (fixture tmdbId 278924 ships in movie-list)
    // and the series (tvdbId 100_042 via seriesJson(42)); the requester exists with a
    // case-differing email.
    await runSync({
      mode: 'full',
      sources: ['sonarr', 'radarr'],
      db: t.db,
      clients: {
        sonarr: sonarrStub([
          { path: '/api/v3/series', body: [seriesJson(42)] },
          { path: '/api/v3/qualityprofile', body: fixture('sonarr.qualityprofile') },
          { path: '/api/v3/tag', body: fixture('sonarr.tag') },
        ]),
        radarr: radarrStub([
          { path: '/api/v3/movie', body: fixture('radarr.movie-list') },
          { path: '/api/v3/qualityprofile', body: fixture('radarr.qualityprofile') },
          { path: '/api/v3/tag', body: fixture('radarr.tag') },
        ]),
      },
    });
    const requester = await createUser(t.db, { email: 'requester@example.test' });

    const report = await runSync({
      mode: 'incremental',
      sources: ['seerr'],
      db: t.db,
      clients: {
        seerr: seerrStub([
          {
            path: '/api/v1/request',
            body: seerrRequestPage([
              seerrRequestJson(11, 'tv', '2026-07-03T10:05:00Z', { tvdbId: 100_042 }, {
                email: 'Requester@Example.TEST', // case differs from users.email
                plexUsername: 'requester',
              }),
              seerrRequestJson(10, 'movie', '2026-07-03T10:00:00Z', { tmdbId: 252_178 }, {
                email: 'Requester@Example.TEST',
                plexUsername: 'requester',
              }),
            ]),
          },
        ]),
      },
    });

    expect(report.sources[0]!.status).toBe('succeeded');
    expect(report.sources[0]!.stats).toMatchObject({
      requestsFetched: 2,
      eventsIngested: 2,
      itemsMatched: 2,
      usersMatched: 2,
    });

    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.source, 'seerr'));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.eventType === 'requested')).toBe(true);
    expect(events.every((e) => e.requestedByUserId === requester.id)).toBe(true);

    const movieEvent = events.find((e) => e.sourceEventId === '10')!;
    const [movieRow] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.tmdbId, 252_178));
    expect(movieEvent.mediaItemId).toBe(movieRow!.id);
    expect(movieEvent.payload).toMatchObject({
      mediaType: 'movie',
      tmdbId: 252_178,
      requestedBy: { plexUsername: 'requester' }, // suggestion recorded, not auto-linked
    });

    const tvEvent = events.find((e) => e.sourceEventId === '11')!;
    const [seriesRow] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.tvdbId, 100_042));
    expect(tvEvent.mediaItemId).toBe(seriesRow!.id);

    // Cursor = max createdAt of the batch (Seerr rides sync_state like the *arrs).
    const [state] = await t.db.select().from(syncState).where(eq(syncState.source, 'seerr'));
    expect(state!.historyCursor!.toISOString()).toBe('2026-07-03T10:05:00.000Z');
  });

  it('re-delivery dedupes on (source, source_event_id) and only newer requests ingest', async () => {
    const report = await runSync({
      mode: 'incremental',
      sources: ['seerr'],
      db: t.db,
      clients: {
        seerr: seerrStub([
          {
            path: '/api/v1/request',
            body: seerrRequestPage([
              // exactly at the cursor → already ingested, page walk stops there
              seerrRequestJson(11, 'tv', '2026-07-03T10:05:00Z', { tvdbId: 100_042 }, {}),
              seerrRequestJson(10, 'movie', '2026-07-03T10:00:00Z', { tmdbId: 252_178 }, {}),
            ]),
          },
        ]),
      },
    });
    expect(report.sources[0]!.stats).toMatchObject({
      requestsFetched: 0, // createdAt ≤ cursor stops the walk before re-ingesting
      eventsIngested: 0,
    });
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.source, 'seerr'));
    expect(events).toHaveLength(2);
  });

  it('a request that precedes the *arr add stays unattributed, then backfills once item + user appear', async () => {
    // 1. Request for a movie the ledger has never seen, from an unknown email.
    const first = await runSync({
      mode: 'incremental',
      sources: ['seerr'],
      db: t.db,
      clients: {
        seerr: seerrStub([
          {
            path: '/api/v1/request',
            body: seerrRequestPage([
              seerrRequestJson(20, 'movie', '2026-07-03T11:00:00Z', { tmdbId: 555_001 }, {
                email: 'early-bird@example.test',
                plexUsername: 'earlybird',
              }),
            ]),
          },
        ]),
      },
    });
    expect(first.sources[0]!.stats).toMatchObject({
      eventsIngested: 1,
      itemsMatched: 0,
      usersMatched: 0,
    });
    let [event] = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.sourceEventId, '20'));
    expect(event).toMatchObject({ mediaItemId: null, requestedByUserId: null }); // ADR-008 C-05

    // 2. The movie syncs in later and the requester logs in for the first time.
    const user = await createUser(t.db, { email: 'early-bird@example.test' });
    const report = await runSync({
      mode: 'full',
      sources: ['radarr'],
      arrInstanceId: 'backfill',
      db: t.db,
      clients: {
        radarr: radarrStub([
          {
            path: '/api/v3/movie',
            body: [
              {
                ...(fixture<Array<Record<string, unknown>>>('radarr.movie-list')[0] as object),
                id: 7001,
                tmdbId: 555_001,
                title: 'Early Bird Movie',
                sortTitle: 'early bird movie',
              },
            ],
          },
          { path: '/api/v3/qualityprofile', body: fixture('radarr.qualityprofile') },
          { path: '/api/v3/tag', body: fixture('radarr.tag') },
        ]),
      },
    });

    // 3. The orchestrator's backfill post-step linked both FKs in the same run.
    expect(report.backfill).toEqual({ itemsLinked: 1, usersLinked: 1 });
    [event] = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.sourceEventId, '20'));
    const [movie] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.tmdbId, 555_001));
    expect(event!.mediaItemId).toBe(movie!.id);
    expect(event!.requestedByUserId).toBe(user.id);
  });
});
