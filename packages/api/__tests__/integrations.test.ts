// ADR-055 / DESIGN-028 (PLAN-044) — the Integrations router: the section VISIBILITY gate (unauth ⇒
// UNAUTHORIZED; a non-admin whose `integrations` section is the default `disabled` ⇒ FORBIDDEN; admin ⇒
// implied edit), the link flow (vanity/URL resolve + public-shelf probe via the injected Goodreads client),
// and the manual re-search ownership check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GoodreadsRssClient } from '@hnet/goodreads';
import { bootMigratedDb, caller, createUser, makeCtx, sessionUser, type TestDb } from './helpers';
import type { TRPCContext } from '../src/trpc';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

/** A stub Goodreads RSS client (resolve + probe) injected into the context. */
function stubGoodreads(opts?: {
  resolveUserId?: (ref: string) => Promise<string>;
  fetchShelf?: () => Promise<unknown[]>;
}): GoodreadsRssClient {
  return {
    resolveUserId: opts?.resolveUserId ?? (async () => '202652880'),
    fetchShelf: opts?.fetchShelf ?? (async () => []),
  } as unknown as GoodreadsRssClient;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

describe('integrations router — section gate', () => {
  it('rejects an anonymous caller with UNAUTHORIZED', async () => {
    const ctx = makeCtx(t.db, null);
    expect(await codeOf(() => caller(ctx).integrations.status())).toBe('UNAUTHORIZED');
  });

  it('rejects a non-admin (integrations defaults to disabled) with FORBIDDEN', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member));
    expect(await codeOf(() => caller(ctx).integrations.status())).toBe('FORBIDDEN');
    expect(await codeOf(() => caller(ctx).integrations.requests())).toBe('FORBIDDEN');
  });

  it('allows a member whose role opted into read_only', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member, { integrations: 'read_only' }));
    const res = await caller(ctx).integrations.status();
    expect(res.integration.linked).toBe(false);
  });
});

describe('integrations router — link + shelf', () => {
  it('resolves the profile, probes the shelf, links, and reports coverage', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = { ...makeCtx(t.db, sessionUser(admin)), goodreads: stubGoodreads() };

    const linked = await caller(ctx).integrations.link({
      profileRef: 'https://www.goodreads.com/haynesnetwork',
    });
    expect(linked.integration.linked).toBe(true);
    expect(linked.integration.externalUserId).toBe('202652880');

    const status = await caller(ctx).integrations.status();
    expect(status.integration.linked).toBe(true);

    const shelf = await caller(ctx).integrations.shelf();
    expect(shelf.coverage).toEqual({ total: 0, covered: 0, pct: 0 });

    // Unlink flips it back.
    const un = await caller(ctx).integrations.unlink();
    expect(un.changed).toBe(true);
    expect((await caller(ctx).integrations.status()).integration.linked).toBe(false);
  });

  it('rejects an unreadable/private shelf with UNPROCESSABLE_CONTENT', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = {
      ...makeCtx(t.db, sessionUser(admin)),
      goodreads: stubGoodreads({
        fetchShelf: async () => {
          throw new Error('403 private');
        },
      }),
    };
    expect(
      await codeOf(() => caller(ctx).integrations.link({ profileRef: '202652880' })),
    ).toBe('UNPROCESSABLE_CONTENT');
  });

  it('rejects an unresolvable profile with UNPROCESSABLE_CONTENT', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = {
      ...makeCtx(t.db, sessionUser(admin)),
      goodreads: stubGoodreads({
        resolveUserId: async () => {
          throw new Error('no id');
        },
      }),
    };
    expect(
      await codeOf(() => caller(ctx).integrations.link({ profileRef: 'https://x/nope' })),
    ).toBe('UNPROCESSABLE_CONTENT');
  });
});
