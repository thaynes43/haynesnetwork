import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { plexLibraries, plexServers, SEEDED_PLEX_SERVER_IDS, type Database } from '@hnet/db';
import { refreshPlexRegistry, PlexServerUnavailableError, type PlexClientBundle } from '../src/index';
import { PlexNetworkError } from '@hnet/plex';
import { bootMigratedDb, type TestDb } from './helpers';

type Slug = 'haynestower' | 'haynesops' | 'hayneskube';
interface Section {
  key: string;
  title: string;
  type: string;
}

function makeRefreshBundle(
  sectionsBySlug: Partial<Record<Slug, Section[]>>,
  machineBySlug: Partial<Record<Slug, string>> = {},
): PlexClientBundle {
  const mk = (slug: Slug) => ({
    async listSections() {
      return (sectionsBySlug[slug] ?? []).map((s) => ({ key: s.key, title: s.title, type: s.type, agent: '' }));
    },
    async getIdentity() {
      return { machineIdentifier: machineBySlug[slug] ?? `mid-${slug}`, version: '1.43.2' };
    },
  });
  return {
    read: { haynestower: mk('haynestower'), haynesops: mk('haynesops'), hayneskube: mk('hayneskube') },
    write: {},
  } as unknown as PlexClientBundle;
}

async function librariesFor(db: Database, slug: Slug) {
  return db
    .select({ key: plexLibraries.sectionKey, name: plexLibraries.name, available: plexLibraries.available })
    .from(plexLibraries)
    .where(eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS[slug]));
}

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

describe('refreshPlexRegistry (ADR-017 D-04)', () => {
  it('upserts libraries keyed on (server_id, section_key) — same key/name on two servers stays distinct', async () => {
    const bundle = makeRefreshBundle({
      haynestower: [{ key: '1', title: 'Movies', type: 'movie' }],
      haynesops: [{ key: '1', title: 'Movies', type: 'movie' }],
    });
    const res = await refreshPlexRegistry({
      db: t.db,
      plex: bundle,
      slugs: ['haynestower', 'haynesops'],
    });
    expect(res.servers.map((s) => s.slug).sort()).toEqual(['haynesops', 'haynestower']);
    const tower = await librariesFor(t.db, 'haynestower');
    const ops = await librariesFor(t.db, 'haynesops');
    expect(tower).toHaveLength(1);
    expect(ops).toHaveLength(1);
    // Same section key '1' + same name on both — distinct rows under distinct server ids.
    expect(tower[0]!.key).toBe('1');
    expect(ops[0]!.key).toBe('1');
  });

  it('updates machine_identifier from /identity', async () => {
    await refreshPlexRegistry({
      db: t.db,
      plex: makeRefreshBundle({ hayneskube: [{ key: '2', title: 'HOps Music', type: 'artist' }] }, { hayneskube: 'mid-fresh-kube' }),
      slugs: ['hayneskube'],
    });
    const [srv] = await t.db
      .select({ mid: plexServers.machineIdentifier })
      .from(plexServers)
      .where(eq(plexServers.slug, 'hayneskube'));
    expect(srv!.mid).toBe('mid-fresh-kube');
  });

  it('renames in place (no duplicate) and marks a vanished section unavailable', async () => {
    // First refresh: two libraries on haynesops.
    await refreshPlexRegistry({
      db: t.db,
      plex: makeRefreshBundle({
        haynesops: [
          { key: '1', title: 'HOps Movies', type: 'movie' },
          { key: '2', title: 'HOps TV', type: 'show' },
        ],
      }),
      slugs: ['haynesops'],
    });
    // Second: key '1' renamed, key '2' gone.
    const res = await refreshPlexRegistry({
      db: t.db,
      plex: makeRefreshBundle({ haynesops: [{ key: '1', title: 'HOps Films', type: 'movie' }] }),
      slugs: ['haynesops'],
    });
    expect(res.servers[0]!.markedUnavailable).toBe(1);
    const libs = await librariesFor(t.db, 'haynesops');
    const byKey = new Map(libs.map((l) => [l.key, l]));
    expect(byKey.get('1')).toMatchObject({ name: 'HOps Films', available: true }); // renamed in place
    expect(byKey.get('2')).toMatchObject({ available: false }); // soft-removed, row kept
    // no duplicate for key '1'
    expect(libs.filter((l) => l.key === '1')).toHaveLength(1);
  });

  it('re-availables a section that returns on a later refresh', async () => {
    await refreshPlexRegistry({
      db: t.db,
      plex: makeRefreshBundle({
        haynesops: [
          { key: '1', title: 'HOps Films', type: 'movie' },
          { key: '2', title: 'HOps TV', type: 'show' },
        ],
      }),
      slugs: ['haynesops'],
    });
    const libs = await librariesFor(t.db, 'haynesops');
    expect(libs.find((l) => l.key === '2')).toMatchObject({ available: true });
  });

  it('degrades PER SERVER — one unreachable server does not abort the reachable ones (D-11)', async () => {
    // haynestower fails network-style (the live 2026-07-06 defect); the other two succeed.
    const netErr = new PlexNetworkError('GET', 'https://plex.haynesnetwork.com/library/sections', {
      cause: new TypeError('fetch failed'),
    });
    const bundle = {
      read: {
        haynestower: {
          async listSections(): Promise<never> {
            throw netErr;
          },
          async getIdentity(): Promise<never> {
            throw netErr;
          },
        },
        haynesops: {
          async listSections() {
            return [{ key: '7', title: 'Degrade Ops Movies', type: 'movie', agent: '' }];
          },
          async getIdentity() {
            return { machineIdentifier: 'mid-haynesops', version: '1' };
          },
        },
        hayneskube: {
          async listSections() {
            return [{ key: '8', title: 'Degrade Kube Music', type: 'artist', agent: '' }];
          },
          async getIdentity() {
            return { machineIdentifier: 'mid-hayneskube', version: '1' };
          },
        },
      },
      write: {},
    } as unknown as PlexClientBundle;

    // No throw — the failure is folded into the summary.
    const res = await refreshPlexRegistry({ db: t.db, plex: bundle });
    expect(res.ok).toBe(false);
    const bySlug = new Map(res.servers.map((s) => [s.slug, s]));
    expect(bySlug.get('haynestower')).toMatchObject({ ok: false, error: 'unreachable' });
    expect(bySlug.get('haynesops')).toMatchObject({ ok: true, libraryCount: 1 });
    expect(bySlug.get('hayneskube')).toMatchObject({ ok: true, libraryCount: 1 });
    // The failed server never surfaces a raw message or token.
    expect(bySlug.get('haynestower')!.error).not.toContain('fetch failed');

    // The reachable servers' libraries WERE upserted despite the other server's failure.
    expect((await librariesFor(t.db, 'haynesops')).find((l) => l.key === '7')).toBeDefined();
    expect((await librariesFor(t.db, 'hayneskube')).find((l) => l.key === '8')).toBeDefined();
  });

  it('throws on an unexpected media type (loud — prompts a PLEX_MEDIA_TYPES update)', async () => {
    await expect(
      refreshPlexRegistry({
        db: t.db,
        plex: makeRefreshBundle({ haynestower: [{ key: '9', title: 'Weird', type: 'liveTV' }] }),
        slugs: ['haynestower'],
      }),
    ).rejects.toBeInstanceOf(PlexServerUnavailableError);
    // The bad section was not inserted (validated before the write tx).
    const libs = await librariesFor(t.db, 'haynestower');
    expect(libs.find((l) => l.key === '9')).toBeUndefined();
    // and did not disturb the previously-good row.
    expect(libs.find((l) => l.key === '1')).toBeDefined();
  });
});
