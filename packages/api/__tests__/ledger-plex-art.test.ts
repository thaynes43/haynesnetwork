// ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV season-poster + episode-thumb reads, proven end-to-end
// through the real ledger router against a stub Plex bundle: an accessible matched show yields season
// posters + episode stills as SIGNED /api/library/plex-art URLs; a withheld item is NOT_FOUND (the art
// path re-gates like every other id fetch — THE INVARIANT, ADR-047).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { plexLibraries, SEEDED_PLEX_SERVER_IDS } from '@hnet/db';
import { syncPlexMatches, upsertPlexLibraries } from '@hnet/domain';
import { verifyPlexArtRef } from '../src/library-plex-art';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';
import { makeApiPlexStub } from './plex-stubs';

let t: TestDb;
let showA: string;
let tvLib: string;

/** A haynestower stub whose matched show (7001) has two seasons (S1 with art, S2 without) + S1 episodes. */
function towerBundle() {
  return makeApiPlexStub({
    haynestower: {
      machineIdentifier: 'mid-tower',
      friends: [],
      serverSections: [],
      librarySections: [{ key: '2', title: 'HNet TV', type: 'show' }],
      metadataChildren: {
        // the show's seasons
        '7001': [
          {
            ratingKey: '7101',
            title: 'Season 1',
            type: 'season',
            index: 1,
            thumb: '/library/metadata/7101/thumb/11',
            leafCount: 2,
          },
          { ratingKey: '7102', title: 'Season 2', type: 'season', index: 2, leafCount: 1 }, // no thumb
        ],
        // Season 1's episodes
        '7101': [
          {
            ratingKey: '7201',
            title: 'Pilot',
            type: 'episode',
            index: 1,
            thumb: '/library/metadata/7201/thumb/21',
          },
          { ratingKey: '7202', title: 'Second', type: 'episode', index: 2 }, // no thumb
        ],
      },
      metadataSection: { '7001': '2', '7101': '2', '7102': '2' },
    },
  });
}

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [{ sectionKey: '2', name: 'HNet TV', mediaType: 'show' }],
  });
  const [lib] = await t.db
    .select({ id: plexLibraries.id })
    .from(plexLibraries)
    .where(
      and(
        eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynestower),
        eq(plexLibraries.sectionKey, '2'),
      ),
    );
  tvLib = lib!.id;
  showA = (await seedMediaItem(t.db, 'sonarr', { title: 'Show A', onDiskFileCount: 1 })).id;
  await syncPlexMatches({
    db: t.db,
    matches: [{ mediaItemId: showA, plexLibraryId: tvLib, ratingKey: '7001', matchedVia: 'tvdb' }],
    scopedLibraryIds: [tvLib],
  });
});
afterAll(async () => {
  await t?.stop();
});

async function adminCaller() {
  const admin = await createUser(t.db, { admin: true });
  return caller(makeCtx(t.db, sessionUser(admin), undefined, towerBundle().bundle));
}

describe('ledger.plexSeasons (PLAN-030)', () => {
  it('returns each season keyed by number, with a SIGNED poster URL where Plex has art', async () => {
    const res = await (await adminCaller()).ledger.plexSeasons({ mediaItemId: showA });
    expect(res.available).toBe(true);
    const s1 = res.seasons.find((s) => s.seasonNumber === 1)!;
    const s2 = res.seasons.find((s) => s.seasonNumber === 2)!;
    expect(s1.posterUrl).not.toBeNull();
    expect(s2.posterUrl).toBeNull(); // no thumb ⇒ no icon
    // The poster URL is a signed, item-scoped /api/library/plex-art reference that verifies.
    const q = new URLSearchParams(s1.posterUrl!.split('?')[1]);
    expect(s1.posterUrl!.startsWith('/api/library/plex-art?')).toBe(true);
    expect(q.get('item')).toBe(showA);
    expect(q.get('server')).toBe('haynestower');
    expect(q.get('thumb')).toBe('/library/metadata/7101/thumb/11');
    expect(verifyPlexArtRef(showA, 'haynestower', q.get('thumb')!, 'grid', q.get('sig')!)).toBe(
      true,
    );
    // No Plex token ever leaks into a client URL.
    expect(s1.posterUrl).not.toContain('X-Plex-Token');
  });

  it('a non-admin caller with no library grant is NOT_FOUND (the art path re-gates)', async () => {
    const member = await createUser(t.db); // default role, no library grants
    const c = caller(makeCtx(t.db, sessionUser(member), undefined, towerBundle().bundle));
    await expect(c.ledger.plexSeasons({ mediaItemId: showA })).rejects.toThrow(/not found/i);
  });
});

describe('ledger.plexEpisodeArt (PLAN-030)', () => {
  it('returns one season’s episodes keyed by number, with a SIGNED still URL where Plex has art', async () => {
    const res = await (
      await adminCaller()
    ).ledger.plexEpisodeArt({ mediaItemId: showA, seasonNumber: 1 });
    expect(res.available).toBe(true);
    const e1 = res.episodes.find((e) => e.episodeNumber === 1)!;
    const e2 = res.episodes.find((e) => e.episodeNumber === 2)!;
    expect(e1.stillUrl).not.toBeNull();
    expect(e2.stillUrl).toBeNull();
    const q = new URLSearchParams(e1.stillUrl!.split('?')[1]);
    expect(q.get('size')).toBe('still');
    expect(q.get('thumb')).toBe('/library/metadata/7201/thumb/21');
    expect(verifyPlexArtRef(showA, 'haynestower', q.get('thumb')!, 'still', q.get('sig')!)).toBe(
      true,
    );
  });

  it('an unknown season number resolves to available:true, no episodes (never a crash)', async () => {
    const res = await (
      await adminCaller()
    ).ledger.plexEpisodeArt({ mediaItemId: showA, seasonNumber: 99 });
    expect(res).toEqual({ available: true, episodes: [] });
  });
});
