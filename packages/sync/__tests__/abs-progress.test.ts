// ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user ABS read-state) — the books-sync post-step that reads
// each mapped ABS user's mediaProgress[] and upserts the per-user book read-state (joined on
// external_id). Embedded PG16; a stub ABS client (no live API — ADR-010).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AbsMediaProgress } from '@hnet/books';
import {
  syncBooks,
  upsertUserAccountHandles,
  viewerHasBookProgress,
  type BooksItemInput,
} from '@hnet/domain';
import { syncAbsUserProgress, type AbsProgressClient } from '../src/abs-progress';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const audiobook = (externalId: string, title: string): BooksItemInput => ({
  source: 'audiobookshelf',
  mediaKind: 'audiobook',
  externalId,
  libraryId: 'lib1',
  libraryName: 'Audio Books',
  title,
  sortTitle: title.toLowerCase(),
  author: 'A',
  narrator: null,
  seriesName: null,
  year: null,
  releasedAt: null,
  genres: [],
  coverRef: null,
  deepLinkUrl: `https://abs.example.com/item/${externalId}`,
  pageCount: null,
  wordCount: null,
  durationSeconds: 3600,
  sizeBytes: null,
  attrs: {},
  sourceAddedAt: null,
  sourceUpdatedAt: null,
});

/** A stub ABS client returning a fixed progress list per user id. */
function absStub(byUser: Record<string, AbsMediaProgress[]>): AbsProgressClient {
  return {
    async getUserProgress(userId: string): Promise<AbsMediaProgress[]> {
      return byUser[userId] ?? [];
    },
  };
}

let t: TestDb;

beforeAll(async () => {
  t = await bootMigratedDb();
});

afterAll(async () => {
  await t?.stop();
});

describe('syncAbsUserProgress (DESIGN-026 D-07)', () => {
  it('is a no-op when no user has an ABS handle', async () => {
    const report = await syncAbsUserProgress({ db: t.db, abs: absStub({}) });
    expect(report).toEqual({ users: 0, written: 0, failedUsers: 0 });
  });

  it('reads a mapped user progress and upserts per-user rows joined on external_id', async () => {
    const user = await createUser(t.db, { email: 'abs-reader@example.com' });
    await syncBooks({
      db: t.db,
      rows: [audiobook('abs-1', 'Dune'), audiobook('abs-2', 'Foundation')],
      syncedSources: ['audiobookshelf'],
    });
    await upsertUserAccountHandles({ db: t.db, userId: user.id, absUserId: 'abs-user-9' });

    const report = await syncAbsUserProgress({
      db: t.db,
      abs: absStub({
        'abs-user-9': [
          { libraryItemId: 'abs-1', progress: 1, isFinished: true },
          { libraryItemId: 'abs-2', progress: 0.3, isFinished: false },
          { libraryItemId: 'unknown-item', progress: 0.5, isFinished: false }, // dropped (no match)
        ],
      }),
    });

    expect(report).toMatchObject({ users: 1, failedUsers: 0 });
    expect(report.written).toBe(2); // only the two matched live rows
    expect(await viewerHasBookProgress(t.db, user.id)).toBe(true);
  });

  it('isolates a per-user read failure (one bad user never fails the step)', async () => {
    const good = await createUser(t.db, { email: 'abs-good@example.com' });
    await upsertUserAccountHandles({ db: t.db, userId: good.id, absUserId: 'abs-good' });
    const bad = await createUser(t.db, { email: 'abs-bad@example.com' });
    await upsertUserAccountHandles({ db: t.db, userId: bad.id, absUserId: 'abs-bad' });

    const flaky: AbsProgressClient = {
      async getUserProgress(userId: string): Promise<AbsMediaProgress[]> {
        if (userId === 'abs-bad') throw new Error('boom');
        return [{ libraryItemId: 'abs-1', progress: 1, isFinished: true }];
      },
    };
    const report = await syncAbsUserProgress({ db: t.db, abs: flaky });
    // Both good users (this test's + the prior test's mapping) read; only abs-bad failed.
    expect(report.failedUsers).toBe(1);
    expect(report.written).toBeGreaterThanOrEqual(1);
  });
});
