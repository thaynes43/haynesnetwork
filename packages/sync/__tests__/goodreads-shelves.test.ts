// ADR-057 / PLAN-045 A3 — the goodreads-sync mode's absent-shelf tolerance: an ABSENT CUSTOM shelf
// ('did-not-finish' on most accounts — Goodreads 404s its RSS) reads as an EMPTY shelf and the sync
// carries on; a BUILT-IN shelf failure (private/unreachable profile) still throws so the
// per-integration error path records it and the mirror is never wrongly tombstoned.
import { describe, expect, it } from 'vitest';
import {
  classifyGoodreadsFailure,
  GoodreadsHttpError,
  GoodreadsNetworkError,
  GoodreadsTimeoutError,
  type GoodreadsRssClient,
} from '@hnet/goodreads';
import { fetchShelfTolerant } from '../src/goodreads';

function stubRss(impl: (userId: string, shelf: string) => Promise<unknown[]>): GoodreadsRssClient {
  return { fetchShelf: impl } as unknown as GoodreadsRssClient;
}

describe('fetchShelfTolerant', () => {
  it('an absent CUSTOM shelf (404) reads as EMPTY — the shelf still counts as synced', async () => {
    const rss = stubRss(async (_u, shelf) => {
      if (shelf === 'did-not-finish') {
        throw new GoodreadsHttpError(404, 'http://gr/review/list_rss/1?shelf=did-not-finish');
      }
      return [{ externalBookId: '1' }];
    });
    await expect(fetchShelfTolerant(rss, '1', 'did-not-finish')).resolves.toEqual([]);
    await expect(fetchShelfTolerant(rss, '1', 'read')).resolves.toHaveLength(1);
  });

  it('a BUILT-IN shelf 404 (private/unreachable profile) still throws', async () => {
    const rss = stubRss(async () => {
      throw new GoodreadsHttpError(404, 'http://gr/review/list_rss/1?shelf=to-read');
    });
    await expect(fetchShelfTolerant(rss, '1', 'to-read')).rejects.toBeInstanceOf(GoodreadsHttpError);
  });

  it('a transient failure on a custom shelf still throws (only shelf-not-found is tolerated)', async () => {
    const rss = stubRss(async () => {
      throw new GoodreadsHttpError(503, 'http://gr/review/list_rss/1?shelf=did-not-finish');
    });
    await expect(fetchShelfTolerant(rss, '1', 'did-not-finish')).rejects.toBeInstanceOf(
      GoodreadsHttpError,
    );
  });
});

// ADR-057 amend — the transient/permanent classifier that keeps a blip (5xx/429/network/timeout) from
// flipping the whole integration to 'error' (which the UI renders as "unlinked" and which used to drop the
// row out of the hourly worklist forever). Only a genuinely-broken profile (4xx that isn't 429, or an
// unexpected throw) is permanent.
describe('classifyGoodreadsFailure', () => {
  const url = 'http://gr/review/list_rss/1?shelf=read';

  it('classifies upstream 5xx + 429 blips as transient (the owner\'s 502 and friends)', () => {
    for (const status of [500, 502, 503, 504, 599, 429]) {
      expect(classifyGoodreadsFailure(new GoodreadsHttpError(status, url))).toBe('transient');
    }
  });

  it('classifies network + timeout failures as transient', () => {
    expect(classifyGoodreadsFailure(new GoodreadsNetworkError(url))).toBe('transient');
    expect(classifyGoodreadsFailure(new GoodreadsTimeoutError(url, 30_000))).toBe('transient');
  });

  it('classifies non-429 4xx (profile private/deleted/forbidden) as permanent', () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(classifyGoodreadsFailure(new GoodreadsHttpError(status, url))).toBe('permanent');
    }
  });

  it('classifies an unexpected non-Goodreads throw as permanent (surface the real bug)', () => {
    expect(classifyGoodreadsFailure(new Error('boom'))).toBe('permanent');
    expect(classifyGoodreadsFailure('nope')).toBe('permanent');
  });
});
