// ADR-052 / DESIGN-026 D-06 (PLAN-029 — server-side per-user Library preferences). Proves the pure
// URL-precedence RESOLVER (URL wins per-dimension + fromUrl; bare URL fills from store; missing row →
// R2/R6 default) and the single-writer STORE (upsert on (user,wall), own-row only). Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { libraryPreferences } from '@hnet/db/schema';
import { eq } from 'drizzle-orm';
import {
  defaultLibraryView,
  getLibraryPreference,
  getLibraryPreferences,
  resolveLibraryView,
  setLibraryPreference,
  LIBRARY_WALL_DEFAULTS,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('resolveLibraryView — URL-precedence resolver (pure, DESIGN-026 D-06/D-10)', () => {
  it('bare URL + no stored row ⇒ the R2/R6 default, fromUrl false', () => {
    const r = resolveLibraryView({ wall: 'movies' });
    expect(r).toMatchObject({ ...LIBRARY_WALL_DEFAULTS.movies, fromUrl: false });
  });

  it('bare URL fills from the stored preference (not the default)', () => {
    const stored = { view: 'grouped' as const, groupBy: 'decade', sortField: 'released_at', sortDir: 'desc' as const };
    const r = resolveLibraryView({ wall: 'movies', stored });
    expect(r).toMatchObject({ ...stored, fromUrl: false });
  });

  it('an explicit URL param WINS per-dimension and sets fromUrl (shared-link fidelity, no write-back)', () => {
    const stored = { view: 'flat' as const, groupBy: null, sortField: 'added_at', sortDir: 'desc' as const };
    const r = resolveLibraryView({
      wall: 'books',
      stored,
      url: { view: 'grouped', sortField: 'title' },
    });
    // URL view + sortField win; groupBy/sortDir fall to stored; fromUrl true (do NOT persist a shared link).
    expect(r).toMatchObject({ view: 'grouped', sortField: 'title', sortDir: 'desc', groupBy: null, fromUrl: true });
  });

  it('an explicit URL groupBy: null still counts as an override (fromUrl true)', () => {
    const r = resolveLibraryView({ wall: 'books', url: { groupBy: null } });
    expect(r.fromUrl).toBe(true);
    expect(r.groupBy).toBeNull();
  });
});

describe('the preference store (single-writer, own-row only) — embedded PG16', () => {
  let t: TestDb;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    userA = (await createUser(t.db, { email: 'pref-a@example.com' })).id;
    userB = (await createUser(t.db, { email: 'pref-b@example.com' })).id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('no stored row ⇒ getLibraryPreference null (the resolver falls to the default)', async () => {
    expect(await getLibraryPreference(t.db, userA, 'movies')).toBeNull();
    expect(defaultLibraryView('movies')).toEqual(LIBRARY_WALL_DEFAULTS.movies);
  });

  it('setLibraryPreference upserts one row per (user, wall) and a change replaces it', async () => {
    await setLibraryPreference({
      db: t.db,
      userId: userA,
      wall: 'movies',
      view: 'flat',
      groupBy: null,
      sortField: 'released_at',
      sortDir: 'desc',
    });
    expect(await getLibraryPreference(t.db, userA, 'movies')).toEqual({
      view: 'flat',
      groupBy: null,
      sortField: 'released_at',
      sortDir: 'desc',
    });

    // A change REPLACES (never appends a second row).
    await setLibraryPreference({
      db: t.db,
      userId: userA,
      wall: 'movies',
      view: 'flat',
      groupBy: null,
      sortField: 'title',
      sortDir: 'asc',
    });
    const rows = await t.db
      .select()
      .from(libraryPreferences)
      .where(eq(libraryPreferences.userId, userA));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sortField).toBe('title');
  });

  it('preferences are per-user (user B never sees user A rows) and getAll merges defaults', async () => {
    await setLibraryPreference({
      db: t.db,
      userId: userB,
      wall: 'books',
      view: 'grouped',
      groupBy: 'author',
      sortField: 'author',
      sortDir: 'asc',
    });
    // A's movies row is unaffected by B; B has no movies row.
    expect(await getLibraryPreference(t.db, userB, 'movies')).toBeNull();
    const allB = await getLibraryPreferences(t.db, userB);
    expect(allB.books).toEqual({ view: 'grouped', groupBy: 'author', sortField: 'author', sortDir: 'asc' });
    expect(allB.movies).toBeUndefined(); // no stored row for B's movies → resolver uses the default
  });
});
