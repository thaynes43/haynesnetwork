// DESIGN-010/014 amendment (2026-07-09, build D) — the debounced post-save pool refresh. Proves the
// `pool_refresh_after_save` setting round-trip (+ the audited single-writer + fail-safe read), the
// per-kind debounce marker (one row per kind, each save PUSHES due_at out = trailing coalesce), the
// disabled path (no marker armed / due markers cleared without executing), and the crash-safe BACKSTOP
// drain (an overdue marker → ONE Maintainerr rule execution + delete; a not-yet-due one is left; a
// failed/again-running execution keeps the marker for the next tick).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { appSettings, pendingPoolRefresh, permissionAudit } from '@hnet/db/schema';
import {
  __clearPoolRefreshTimersForTests,
  drainDuePoolRefreshes,
  getPoolRefreshAfterSave,
  requestPoolRefreshAfterSave,
  setAppSetting,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';
import { baseState, makeMaintainerr } from './maintainerr-stub';

const executeCalls = (calls: { method: string; pathname: string }[]) =>
  calls.filter((c) => c.method === 'POST' && c.pathname === '/rules/execute');

describe('pool refresh after save (build D)', () => {
  let t: TestDb;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'pool-admin@example.com' })).id;
  });
  afterAll(async () => t?.stop());
  afterEach(async () => {
    __clearPoolRefreshTimersForTests();
    await t.db.delete(pendingPoolRefresh);
    await t.db.delete(appSettings).where(eq(appSettings.key, 'pool_refresh_after_save'));
  });

  describe('the setting round-trip + audit + fail-safe read', () => {
    it('defaults ON with a 5-minute debounce when unset', async () => {
      expect(await getPoolRefreshAfterSave(t.db)).toEqual({ enabled: true, delayMinutes: 5 });
    });

    it('round-trips through setAppSetting and writes ONE update_app_setting audit row (same tx)', async () => {
      await setAppSetting({
        db: t.db,
        key: 'pool_refresh_after_save',
        value: { enabled: false, delayMinutes: 12 },
        actorId,
      });
      expect(await getPoolRefreshAfterSave(t.db)).toEqual({ enabled: false, delayMinutes: 12 });
      const audits = await t.db
        .select()
        .from(permissionAudit)
        .where(eq(permissionAudit.action, 'update_app_setting'));
      const mine = audits.filter(
        (a) => (a.detail as { key?: string } | null)?.key === 'pool_refresh_after_save',
      );
      expect(mine).toHaveLength(1);
      expect((mine[0]!.detail as { after: unknown }).after).toEqual({ enabled: false, delayMinutes: 12 });
    });

    it('fail-safe read: garbage jsonb clamps the delay and keeps the gate at its default (ON)', async () => {
      await t.db
        .insert(appSettings)
        .values({ key: 'pool_refresh_after_save', value: { enabled: 'yes', delayMinutes: -3 } as never });
      // enabled non-boolean → default ON; delayMinutes -3 → clamped to the 1-minute floor.
      expect(await getPoolRefreshAfterSave(t.db)).toEqual({ enabled: true, delayMinutes: 1 });
    });
  });

  describe('the per-kind debounce marker', () => {
    it('a second save for the same kind PUSHES due_at out (one row, coalesced)', async () => {
      const t0 = new Date('2026-07-09T18:00:00Z');
      const t1 = new Date('2026-07-09T18:02:00Z');
      const first = await requestPoolRefreshAfterSave({ db: t.db, maintainerr: makeMaintainerr(baseState()).bundle, kind: 'movie', actorId, now: t0, scheduleTimer: false });
      const second = await requestPoolRefreshAfterSave({ db: t.db, maintainerr: makeMaintainerr(baseState()).bundle, kind: 'movie', actorId, now: t1, scheduleTimer: false });
      expect(first.enabled).toBe(true);
      expect(second.enabled).toBe(true);

      const rows = await t.db.select().from(pendingPoolRefresh);
      expect(rows).toHaveLength(1); // coalesced to one movie marker
      expect(rows[0]!.mediaKind).toBe('movie');
      // due_at trails the SECOND save (t1 + 5 min), not the first.
      expect(rows[0]!.dueAt.getTime()).toBe(t1.getTime() + 5 * 60_000);
    });

    it('different kinds arm independent markers', async () => {
      const now = new Date('2026-07-09T18:00:00Z');
      const { bundle } = makeMaintainerr(baseState());
      await requestPoolRefreshAfterSave({ db: t.db, maintainerr: bundle, kind: 'movie', actorId, now, scheduleTimer: false });
      await requestPoolRefreshAfterSave({ db: t.db, maintainerr: bundle, kind: 'tv', actorId, now, scheduleTimer: false });
      const rows = await t.db.select().from(pendingPoolRefresh);
      expect(rows.map((r) => r.mediaKind).sort()).toEqual(['movie', 'tv']);
    });

    it('disabled ⇒ no marker is armed (respects enabled=false)', async () => {
      await setAppSetting({ db: t.db, key: 'pool_refresh_after_save', value: { enabled: false, delayMinutes: 5 }, actorId });
      const res = await requestPoolRefreshAfterSave({ db: t.db, maintainerr: makeMaintainerr(baseState()).bundle, kind: 'movie', actorId, scheduleTimer: false });
      expect(res).toEqual({ enabled: false, dueAt: null });
      expect(await t.db.select().from(pendingPoolRefresh)).toHaveLength(0);
    });
  });

  describe('the backstop drain', () => {
    const armMarker = (kind: 'movie' | 'tv', dueAt: Date) =>
      t.db.insert(pendingPoolRefresh).values({ mediaKind: kind, dueAt, requestedBy: actorId });

    it('an OVERDUE marker fires exactly one rule execution and deletes the drained marker', async () => {
      const now = new Date('2026-07-09T18:10:00Z');
      await armMarker('movie', new Date('2026-07-09T18:05:00Z')); // 5 min overdue
      const { bundle, calls } = makeMaintainerr(baseState());
      const res = await drainDuePoolRefreshes({ db: t.db, maintainerr: bundle, now });
      expect(res).toMatchObject({ dueKinds: ['movie'], executed: true, disabled: false });
      expect(executeCalls(calls)).toHaveLength(1);
      expect(await t.db.select().from(pendingPoolRefresh)).toHaveLength(0);
    });

    it('two overdue kinds COALESCE into a single execution', async () => {
      const now = new Date('2026-07-09T18:10:00Z');
      await armMarker('movie', new Date('2026-07-09T18:00:00Z'));
      await armMarker('tv', new Date('2026-07-09T18:01:00Z'));
      const { bundle, calls } = makeMaintainerr(baseState());
      const res = await drainDuePoolRefreshes({ db: t.db, maintainerr: bundle, now });
      expect(res.dueKinds.sort()).toEqual(['movie', 'tv']);
      expect(res.executed).toBe(true);
      expect(executeCalls(calls)).toHaveLength(1); // ONE run covers all rules, not one per kind
      expect(await t.db.select().from(pendingPoolRefresh)).toHaveLength(0);
    });

    it('a NOT-yet-due marker is left untouched (cheap no-op, no Maintainerr call)', async () => {
      const now = new Date('2026-07-09T18:00:00Z');
      await armMarker('movie', new Date('2026-07-09T18:05:00Z')); // due in the future
      const { bundle, calls } = makeMaintainerr(baseState());
      const res = await drainDuePoolRefreshes({ db: t.db, maintainerr: bundle, now });
      expect(res).toMatchObject({ dueKinds: [], executed: false });
      expect(executeCalls(calls)).toHaveLength(0);
      expect(await t.db.select().from(pendingPoolRefresh)).toHaveLength(1); // kept
    });

    it('disabled at drain time clears the due markers WITHOUT executing', async () => {
      await setAppSetting({ db: t.db, key: 'pool_refresh_after_save', value: { enabled: false, delayMinutes: 5 }, actorId });
      const now = new Date('2026-07-09T18:10:00Z');
      await armMarker('movie', new Date('2026-07-09T18:00:00Z'));
      const { bundle, calls } = makeMaintainerr(baseState());
      const res = await drainDuePoolRefreshes({ db: t.db, maintainerr: bundle, now });
      expect(res).toMatchObject({ dueKinds: ['movie'], executed: false, disabled: true });
      expect(executeCalls(calls)).toHaveLength(0);
      expect(await t.db.select().from(pendingPoolRefresh)).toHaveLength(0);
    });

    it('a failed execution KEEPS the marker for the next backstop tick', async () => {
      const now = new Date('2026-07-09T18:10:00Z');
      await armMarker('movie', new Date('2026-07-09T18:00:00Z'));
      const { bundle } = makeMaintainerr(baseState({ fail: new Set(['POST /rules/execute']) }));
      const res = await drainDuePoolRefreshes({ db: t.db, maintainerr: bundle, now });
      expect(res).toMatchObject({ dueKinds: ['movie'], executed: false, disabled: false });
      expect(await t.db.select().from(pendingPoolRefresh)).toHaveLength(1); // retained → retried later
    });
  });
});
