// ADR-062 / DESIGN-033 D-03/D-06 (PLAN-041) — the books Fix router gate: Admin bypasses; a member
// with NO fix_book grant is FORBIDDEN (the Admin-only ship state); a member GRANTED fix_book (the
// Q-01 flip, simulated by seeding the grant row) passes. books.detail's canFix mirrors the gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booksItems, SEEDED_ROLE_IDS } from '@hnet/db';
import { setRoleBookActions, syncBooks, type LazyLibrarianClientBundle, type KapowarrClientBundle } from '@hnet/domain';
import { eq } from 'drizzle-orm';
import { bootMigratedDb, caller, createUser, makeCtx, sessionUser, type TestDb } from './helpers';
import type { TRPCContext } from '../src/trpc';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

let seedSeq = 0;
/** Seed via the syncBooks single-writer (the guard forbids direct books_items inserts — correctly). */
async function seedBook(): Promise<string> {
  const externalId = `bf-${++seedSeq}`;
  await syncBooks({
    db: t.db,
    syncedSources: [],
    rows: [
      {
        source: 'kavita',
        mediaKind: 'book',
        externalId,
        libraryId: '1',
        libraryName: 'Lib',
        title: `Gate Target ${seedSeq}`,
        sortTitle: `gate target ${seedSeq}`,
        author: null,
        narrator: null,
        seriesName: null,
        year: null,
        releasedAt: null,
        genres: [],
        coverRef: null,
        deepLinkUrl: 'http://x',
        pageCount: null,
        wordCount: null,
        durationSeconds: null,
        sizeBytes: null,
        attrs: {},
        sourceAddedAt: null,
        sourceUpdatedAt: null,
      },
    ],
  });
  const [row] = await t.db
    .select({ id: booksItems.id })
    .from(booksItems)
    .where(eq(booksItems.externalId, externalId));
  return row!.id;
}

/** A no-op LL bundle so create() reaches search_triggered without network (GB resolves inline). */
function stubClients(): Partial<TRPCContext> {
  return {
    lazylibrarian: {
      write: { addBook: async () => {}, queueBook: async () => {}, searchBook: async () => {} },
    } as unknown as LazyLibrarianClientBundle,
    kapowarr: { write: { setMonitored: async () => {}, searchVolume: async () => {} } } as unknown as KapowarrClientBundle,
    googleBooks: { resolveVolume: async () => ({ volumeId: 'gb-gate' }) } as unknown as TRPCContext['googleBooks'],
  };
}

describe('bookFix router — the fix_book gate (ADR-062 C-07)', () => {
  it('a member WITHOUT the grant is FORBIDDEN', async () => {
    const member = await createUser(t.db);
    // books section opened (read_only) — proves the FORBIDDEN comes from the missing GRANT, not the section floor.
    const ctx = makeCtx(t.db, sessionUser(member, { books: 'read_only' }));
    await expect(
      caller(ctx).bookFix.create({ booksItemId: await seedBook(), reason: 'wrong_language' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an ADMIN can fire a fix (bypass) and it lands search_triggered', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = { ...makeCtx(t.db, sessionUser(admin)), ...stubClients() };
    const res = await caller(ctx).bookFix.create({ booksItemId: await seedBook(), reason: 'bad_quality' });
    expect(res.status).toBe('search_triggered');
    expect(res.route).toBe('lazylibrarian');
  });

  it('a member GRANTED fix_book (the Q-01 flip) passes', async () => {
    const member = await createUser(t.db); // default role
    const admin = await createUser(t.db, { admin: true });
    // The flip, via the audited single-writer (the guard forbids direct grant writes — correctly).
    await setRoleBookActions({ db: t.db, roleId: SEEDED_ROLE_IDS.default, actions: ['fix_book'], actorId: admin.id });
    try {
      const ctx: TRPCContext = { ...makeCtx(t.db, sessionUser(member, { books: 'read_only' })), ...stubClients() };
      const res = await caller(ctx).bookFix.create({ booksItemId: await seedBook(), reason: 'wrong_edition' });
      expect(res.status).toBe('search_triggered');
    } finally {
      await setRoleBookActions({ db: t.db, roleId: SEEDED_ROLE_IDS.default, actions: [], actorId: admin.id });
    }
  });

  it('reason=other REQUIRES reasonText (zod refine)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = { ...makeCtx(t.db, sessionUser(admin)), ...stubClients() };
    await expect(
      caller(ctx).bookFix.create({ booksItemId: await seedBook(), reason: 'other' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
