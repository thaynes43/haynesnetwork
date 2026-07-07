// ADR-026 / DESIGN-012 D-03 — recordNotification single-writer: idempotent dedupe on
// (source, source_event_id), email→user attribution (the shared ledger path), and
// tmdb/tvdb→media_item link. Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { notifications } from '@hnet/db/schema';
import { recordNotification, upsertMediaItemsBatch } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('recordNotification (ADR-026 D-03)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
    // A movie in the ledger the Seerr/Tautulli tmdbId can link to.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 9001,
          tmdbId: 603,
          title: 'The Matrix',
          sortTitle: 'matrix',
          year: 1999,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/data/movies',
          onDiskFileCount: 1,
          expectedFileCount: 1,
          sizeOnDisk: 1_000,
        },
      ],
    });
    // A tv show for the tvdb match path.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 9002,
          tvdbId: 371980,
          tmdbId: 95396,
          title: 'Severance',
          sortTitle: 'severance',
          year: 2022,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/data/tv',
          onDiskFileCount: 1,
          expectedFileCount: 1,
          sizeOnDisk: 2_000,
        },
      ],
    });
  });

  afterAll(async () => {
    await t?.stop();
  });

  const rowById = async (id: string) => {
    const [row] = await t.db.select().from(notifications).where(eq(notifications.id, id));
    return row!;
  };

  it('attributes to a seeded user by case-insensitive email + links the movie by tmdbId', async () => {
    const requester = await createUser(t.db, { email: 'Requester@Example.com' });
    const { id, deduped } = await recordNotification({
      db: t.db,
      source: 'seerr',
      type: 'MEDIA_APPROVED',
      title: 'The Matrix (1999)',
      body: 'approved',
      sourceEventId: 'MEDIA_APPROVED:42',
      tmdbId: 603,
      mediaType: 'movie',
      requesterEmail: 'requester@example.com', // different case — still matches
    });
    expect(deduped).toBe(false);
    const row = await rowById(id);
    expect(row.actorUserId).toBe(requester.id);
    expect(row.mediaItemId).not.toBeNull();
    expect(row.source).toBe('seerr');
  });

  it('links a tv event by tvdbId', async () => {
    const { id } = await recordNotification({
      db: t.db,
      source: 'seerr',
      type: 'MEDIA_PENDING',
      title: 'Severance',
      body: '',
      sourceEventId: 'MEDIA_PENDING:7',
      tvdbId: 371980,
      mediaType: 'tv',
    });
    const row = await rowById(id);
    expect(row.mediaItemId).not.toBeNull();
  });

  it('leaves actor + media null when the email/id do not match ("unattributed")', async () => {
    const { id } = await recordNotification({
      db: t.db,
      source: 'tautulli',
      type: 'playback.start',
      title: 'Unknown Thing',
      body: '',
      sourceEventId: 'playback.start:1:1',
      tmdbId: 999999,
      requesterEmail: 'nobody@nowhere.test',
    });
    const row = await rowById(id);
    expect(row.actorUserId).toBeNull();
    expect(row.mediaItemId).toBeNull();
  });

  it('is idempotent on (source, source_event_id) — re-delivery is a no-op', async () => {
    const first = await recordNotification({
      db: t.db,
      source: 'seerr',
      type: 'MEDIA_AVAILABLE',
      title: 'dup',
      body: '',
      sourceEventId: 'MEDIA_AVAILABLE:100',
    });
    expect(first.deduped).toBe(false);
    const again = await recordNotification({
      db: t.db,
      source: 'seerr',
      type: 'MEDIA_AVAILABLE',
      title: 'dup (redelivered)',
      body: '',
      sourceEventId: 'MEDIA_AVAILABLE:100',
    });
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(first.id);
    const all = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.sourceEventId, 'MEDIA_AVAILABLE:100'));
    expect(all).toHaveLength(1);
    // The stored row is the FIRST one (ON CONFLICT DO NOTHING — never overwritten).
    expect(all[0]!.title).toBe('dup');
  });

  it('always inserts a null source_event_id event (Maintainerr — no stable id)', async () => {
    const a = await recordNotification({ db: t.db, source: 'maintainerr', type: 'MEDIA_DELETED', title: 'a', body: '' });
    const b = await recordNotification({ db: t.db, source: 'maintainerr', type: 'MEDIA_DELETED', title: 'a', body: '' });
    expect(a.id).not.toBe(b.id);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
  });
});
