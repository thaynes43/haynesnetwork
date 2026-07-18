// ADR-067 / DESIGN-039 (PLAN-055) — the shared Google Books quota circuit breaker. Proves: the
// structural daily-vs-minute 429 classification; the reset math (next 07:00 UTC); trip windows +
// clear-on-success; the single-probe half-open claim (two consumers racing an expired window —
// exactly one probes); and the guardedGbResolve seam's outcome matrix (open ⇒ no call; 429 ⇒ trip
// persisted; non-429 rethrown with the breaker untouched). Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gbQuotaState } from '@hnet/db';
import {
  GB_MINUTE_TRIP_MS,
  classifyGb429,
  clearGbQuotaBreaker,
  consultGbQuotaGate,
  guardedGbResolve,
  nextGbDailyReset,
  peekGbQuotaGate,
  tripGbQuotaBreaker,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(gbQuotaState);
});

/** The GoodreadsHttpError SHAPE (status + message/bodySnippet) — structural, no package import. */
function http429(body: string) {
  return Object.assign(new Error(`GET https://gb/volumes → HTTP 429 — ${body}`), {
    status: 429,
    bodySnippet: body,
  });
}

describe('classifyGb429 (structural daily-vs-minute)', () => {
  it("classifies Google's daily-quota body as 'daily'", () => {
    expect(
      classifyGb429(
        http429(
          `Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com'`,
        ),
      ),
    ).toBe('daily');
  });

  it("classifies a per-minute 429 (and an unhinted 429) as 'minute'", () => {
    expect(classifyGb429(http429(`limit 'Queries per minute per user' exceeded`))).toBe('minute');
    expect(classifyGb429(Object.assign(new Error('429'), { status: 429 }))).toBe('minute');
  });

  it("classifies the REAL Google per-day body as 'daily' even though errors[].reason is 'rateLimitExceeded'", () => {
    // A 2026-07-18 live capture: a genuine per-day exhaustion carries reason "rateLimitExceeded"
    // (not "dailyLimitExceeded") — the window is named ONLY in the message string.
    const realBody =
      `{"error":{"code":429,"message":"Quota exceeded for quota metric 'Queries' and limit ` +
      `'Queries per day' of service 'books.googleapis.com' for consumer 'project_number:X'.",` +
      `"errors":[{"message":"Quota exceeded...","domain":"global","reason":"rateLimitExceeded"}],` +
      `"status":"RESOURCE_EXHAUSTED"}}`;
    expect(classifyGb429(http429(realBody))).toBe('daily');
  });

  it("does NOT arm 'daily' from a 'daily'/'per day' book TITLE in the error message (per-minute burst)", () => {
    // The self-inflicted 24h-starvation class: the error's `.message` embeds the request URL
    // (title-bearing). A per-minute burst on a book titled with "daily" must stay 'minute'.
    const burst = Object.assign(
      new Error(
        `GET https://www.googleapis.com/books/v1/volumes?q=intitle:The+Daily+Stoic&key=REDACTED → ` +
          `HTTP 429 — limit 'Queries per minute per user' exceeded`,
      ),
      { status: 429, bodySnippet: `limit 'Queries per minute per user' exceeded` },
    );
    expect(classifyGb429(burst)).toBe('minute');
  });

  it('returns null for non-429s and non-errors (not the breaker business)', () => {
    expect(classifyGb429(Object.assign(new Error('boom'), { status: 503 }))).toBeNull();
    expect(classifyGb429(new Error('network down'))).toBeNull();
    expect(classifyGb429(null)).toBeNull();
    expect(classifyGb429('429')).toBeNull();
  });
});

describe('nextGbDailyReset (the 07:00 UTC reset math)', () => {
  it('before the reset hour → the SAME day 07:00 UTC; at/after → the NEXT day', () => {
    expect(nextGbDailyReset(new Date('2026-07-16T03:00:00Z')).toISOString()).toBe(
      '2026-07-16T07:00:00.000Z',
    );
    expect(nextGbDailyReset(new Date('2026-07-16T07:00:00Z')).toISOString()).toBe(
      '2026-07-17T07:00:00.000Z',
    );
    // The incident hour: ~20:00 UTC → the fix queues until 07:00 the next morning.
    expect(nextGbDailyReset(new Date('2026-07-16T20:00:00Z')).toISOString()).toBe(
      '2026-07-17T07:00:00.000Z',
    );
  });
});

describe('trip / clear / gate (the single-row state machine)', () => {
  const now = new Date('2026-07-16T20:00:00Z');

  it("a DAILY trip opens until the next 07:00 UTC; a MINUTE trip for 2 minutes; any success clears", async () => {
    const dailyUntil = await tripGbQuotaBreaker({ db: t.db, kind: 'daily', detail: 'Queries per day', now });
    expect(dailyUntil.toISOString()).toBe('2026-07-17T07:00:00.000Z');
    expect(await peekGbQuotaGate({ db: t.db, now })).toMatchObject({
      open: true,
      reason: 'daily: Queries per day',
    });

    const minuteUntil = await tripGbQuotaBreaker({ db: t.db, kind: 'minute', now });
    expect(minuteUntil.getTime()).toBe(now.getTime() + GB_MINUTE_TRIP_MS);

    await clearGbQuotaBreaker({ db: t.db, now });
    expect(await peekGbQuotaGate({ db: t.db, now })).toEqual({ open: false, until: null, reason: null });
    const gate = await consultGbQuotaGate({ db: t.db, now });
    expect(gate.state).toBe('closed');
  });

  it('an open window gates; an EXPIRED window grants exactly ONE half-open probe', async () => {
    await tripGbQuotaBreaker({ db: t.db, kind: 'minute', now });

    // Inside the window: open for everyone (and the peek agrees).
    const during = await consultGbQuotaGate({ db: t.db, now: new Date(now.getTime() + 60_000) });
    expect(during.state).toBe('open');

    // Past the window: the FIRST consult claims the probe (extending the window), the SECOND
    // concurrent-ish consult sees it open again — no thundering herd at reset time.
    const later = new Date(now.getTime() + GB_MINUTE_TRIP_MS + 1_000);
    const first = await consultGbQuotaGate({ db: t.db, now: later });
    expect(first.state).toBe('probe');
    const second = await consultGbQuotaGate({ db: t.db, now: later });
    expect(second.state).toBe('open');
  });
});

describe('guardedGbResolve (THE SEAM)', () => {
  const now = new Date('2026-07-16T20:00:00Z');

  function spyGb(impl: () => Promise<{ volumeId: string } | null>) {
    let calls = 0;
    return {
      calls: () => calls,
      gb: {
        resolveVolume: async () => {
          calls += 1;
          return impl();
        },
      },
    };
  }

  it('an OPEN breaker blocks WITHOUT calling the resolver', async () => {
    await tripGbQuotaBreaker({ db: t.db, kind: 'daily', now });
    const spy = spyGb(async () => ({ volumeId: 'never' }));
    const res = await guardedGbResolve({ db: t.db, gb: spy.gb, query: { title: 'Whispers' }, now });
    expect(res).toMatchObject({ outcome: 'quota_blocked' });
    expect(spy.calls()).toBe(0);
  });

  it('a daily 429 TRIPS the breaker (persisted for the next process) and reports quota_tripped', async () => {
    const spy = spyGb(async () => {
      throw http429(`limit 'Queries per day' of service 'books.googleapis.com'`);
    });
    const res = await guardedGbResolve({ db: t.db, gb: spy.gb, query: { title: 'Dead Ever After' }, now });
    expect(res).toMatchObject({ outcome: 'quota_tripped', kind: 'daily' });
    if (res.outcome === 'quota_tripped') {
      expect(res.until.toISOString()).toBe('2026-07-17T07:00:00.000Z');
    }
    expect((await peekGbQuotaGate({ db: t.db, now })).open).toBe(true);
  });

  it('success resolves AND clears a lingering trip; an honest no-match clears too', async () => {
    await tripGbQuotaBreaker({ db: t.db, kind: 'minute', now });
    const later = new Date(now.getTime() + GB_MINUTE_TRIP_MS + 1_000); // expired ⇒ this call is the probe
    const ok = await guardedGbResolve({
      db: t.db,
      gb: spyGb(async () => ({ volumeId: 'gb-1' })).gb,
      query: { title: 'Hyperion' },
      now: later,
    });
    expect(ok).toMatchObject({ outcome: 'resolved', volume: { volumeId: 'gb-1' } });
    expect((await peekGbQuotaGate({ db: t.db, now: later })).open).toBe(false);

    const none = await guardedGbResolve({
      db: t.db,
      gb: spyGb(async () => null).gb,
      query: { title: 'Unknown' },
      now: later,
    });
    expect(none).toEqual({ outcome: 'no_match' });
  });

  it('a NON-429 error rethrows untouched and never trips the breaker', async () => {
    const spy = spyGb(async () => {
      throw Object.assign(new Error('GB melted'), { status: 503 });
    });
    await expect(
      guardedGbResolve({ db: t.db, gb: spy.gb, query: { title: 'Anything' }, now }),
    ).rejects.toThrow('GB melted');
    expect((await peekGbQuotaGate({ db: t.db, now })).open).toBe(false);
  });
});
