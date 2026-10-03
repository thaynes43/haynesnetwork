import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { mediaItems, ledgerEvents, trashSaveIntents } from '@hnet/db';
import {
  upsertMediaItemsBatch,
  refreshTrashCandidates,
  saveExclusion,
  removeExclusion,
  relinkSaveIntents,
  setAppSetting,
} from '../src/index';
import {
  makeMaintainerr,
  baseState,
  movieCollection,
  purgeDanglingExclusions,
  rekeyStubItem,
  type MaintState,
} from './maintainerr-stub';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

/**
 * ADR-086 / DESIGN-048 — the relink reconciler.
 *
 * The scenario every test here is built on is the real 2026-08-29 incident: a Save is made, the
 * title's file is later replaced, Plex re-keys the item, Maintainerr's nightly maintenance prunes
 * the now-dangling exclusion, and the title reappears in the deletion pool unprotected.
 */
describe('relinkSaveIntents (ADR-086 D-4)', () => {
  let t: TestDb;
  let actorId: string;
  let movieItemId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'relink@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 1,
          tmdbId: 9001,
          title: 'Green Lantern',
          sortTitle: 'green lantern',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
      ],
    });
    const [row] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, 9001));
    movieItemId = row!.id;
  });

  afterAll(async () => t.stop());

  beforeEach(async () => {
    await t.db.delete(trashSaveIntents);
    await t.db.delete(ledgerEvents);
    await setAppSetting({ db: t.db, key: 'trash_relink_enabled', value: true, actorId });
  });

  /** Save → a night passes with the file replaced → the item is back, unprotected, under a new key. */
  async function lapseAfterRekey(): Promise<{ state: MaintState; bundle: ReturnType<typeof makeMaintainerr>['bundle']; calls: ReturnType<typeof makeMaintainerr>['calls'] }> {
    const state = baseState({ collections: [movieCollection()] });
    const first = makeMaintainerr(state);

    await saveExclusion({
      db: t.db,
      maintainerr: first.bundle,
      maintainerrMediaId: 'ms-9001',
      mediaItemId: movieItemId,
      actorId,
    });
    expect(state.exclusions.has('ms-9001')).toBe(true);

    // The file is replaced: Plex drops the old item and mints a new one. Same tmdbId, new ratingKey.
    rekeyStubItem(state, 'ms-9001', 'ms-9101');
    // The nightly RuleMaintenanceService collects the now-dangling exclusion.
    const pruned = purgeDanglingExclusions(
      state,
      state.collections.flatMap((c) => c.items.map((i) => i.mediaServerId)),
    );
    expect(pruned).toEqual(['ms-9001']);

    const next = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: next.bundle });
    return { state, bundle: next.bundle, calls: next.calls };
  }

  it('re-applies a lapsed save onto the title’s new key, audited as a relink', async () => {
    const { state, bundle } = await lapseAfterRekey();

    const report = await relinkSaveIntents({ db: t.db, maintainerr: bundle });

    expect(report.scanned).toBe(1);
    expect(report.relinked).toBe(1);
    expect(report.failed).toBe(0);
    // The protection is real again, under the key the title actually has.
    expect(state.exclusions.has('ms-9101')).toBe(true);

    // Attribution stays honest: a relink is never recorded as a fresh user save.
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_excluded'));
    const relinkEvent = events.find(
      (e) => (e.payload as { reason?: string }).reason === 'relink',
    );
    expect(relinkEvent).toBeDefined();
    expect((relinkEvent!.payload as { maintainerrMediaId?: string }).maintainerrMediaId).toBe(
      'ms-9101',
    );

    // The intent now points at the new key and records the relink.
    const [intent] = await t.db
      .select()
      .from(trashSaveIntents)
      .where(and(eq(trashSaveIntents.mediaItemId, movieItemId), isNull(trashSaveIntents.revokedAt)));
    expect(intent!.maintainerrMediaId).toBe('ms-9101');
    expect(intent!.relinkCount).toBe(1);
    expect(intent!.lastRelinkedAt).not.toBeNull();
  });

  it('ADR-099 — a spent time budget starts no new candidate and reports it (cooperative, never a race)', async () => {
    const { state, bundle, calls } = await lapseAfterRekey();
    const report = await relinkSaveIntents({ db: t.db, maintainerr: bundle, deadlineAt: Date.now() - 1 });
    expect(report.stoppedEarly).toBe(true);
    expect(report.relinked).toBe(0);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(state.exclusions.has('ms-9101')).toBe(false);
    // The next tick, with time to spare, finishes it.
    const next = await relinkSaveIntents({ db: t.db, maintainerr: bundle, deadlineAt: Date.now() + 60_000 });
    expect(next).toMatchObject({ stoppedEarly: false, relinked: 1 });
    expect(state.exclusions.has('ms-9101')).toBe(true);
  });

  it('is idempotent — a second pass finds nothing left to do', async () => {
    const { state, bundle } = await lapseAfterRekey();
    await relinkSaveIntents({ db: t.db, maintainerr: bundle });

    // The snapshot still lists the title (Maintainerr has not re-run its rules), now under the key the intent holds,
    // and Maintainerr holds the exclusion there: read, nothing written.
    const again = makeMaintainerr(state);
    const second = await relinkSaveIntents({ db: t.db, maintainerr: again.bundle });
    expect(second.relinked).toBe(0);
    expect(second.reapplied).toBe(0);
    expect(second.failed).toBe(0);
    expect(again.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  /**
   * ADR-099 D-5 supersedes ADR-086 D-4's carve-out. The owner's ruling: a Save is forever ("if someone clicks save
   * it's saved forever"), and the app's un-save is the release. An exclusion Maintainerr lost under the SAME key is
   * re-applied, audited as `reapply`.
   */
  it('re-applies a same-key lapse (ADR-099 D-5), audited as a reapply', async () => {
    const state = baseState({ collections: [movieCollection()] });
    const first = makeMaintainerr(state);
    await saveExclusion({
      db: t.db,
      maintainerr: first.bundle,
      maintainerrMediaId: 'ms-9001',
      mediaItemId: movieItemId,
      actorId,
    });

    // A human removes the exclusion in Maintainerr directly. No re-key.
    state.exclusions.delete('ms-9001');
    const next = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: next.bundle });

    const report = await relinkSaveIntents({ db: t.db, maintainerr: next.bundle });

    expect(report.scanned).toBe(1);
    expect(report.sameKeyCensus).toBe(1);
    expect(report.relinked).toBe(0);
    expect(report.reapplied).toBe(1);
    // The Save holds: the exclusion is back on the key it was saved on.
    expect(state.exclusions.has('ms-9001')).toBe(true);
    const events = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.eventType, 'trash_excluded'));
    expect(events.filter((e) => (e.payload as { reason?: string }).reason === 'reapply')).toHaveLength(1);
  });

  /** ADR-086 D-3 / C-10 — the brake. A revoked intent is never resurrected. */
  it('never resurrects a revoked intent', async () => {
    const { state, bundle } = await lapseAfterRekey();

    // The owner un-saves the lapsed item. There is NO live exclusion to remove — this is exactly
    // the path that used to no-op silently and would have left the reconciler unstoppable.
    const res = await removeExclusion({
      db: t.db,
      maintainerr: bundle,
      maintainerrMediaId: 'ms-9101',
      mediaItemId: movieItemId,
      actorId,
    });
    expect(res.removed).toBe(false);
    expect(res.intentRevoked).toBe(true);

    const report = await relinkSaveIntents({ db: t.db, maintainerr: bundle });
    expect(report.scanned).toBe(0);
    expect(report.relinked).toBe(0);
    expect(state.exclusions.has('ms-9101')).toBe(false);
  });

  it('un-saving a lapsed item writes an audited unsave even with nothing to un-exclude', async () => {
    const { bundle } = await lapseAfterRekey();
    await removeExclusion({
      db: t.db,
      maintainerr: bundle,
      maintainerrMediaId: 'ms-9101',
      mediaItemId: movieItemId,
      actorId,
    });

    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_excluded'));
    const unsave = events.find((e) => (e.payload as { action?: string }).action === 'unsave');
    expect(unsave).toBeDefined();
    expect((unsave!.payload as { reason?: string }).reason).toBe('lapsed');
  });

  /** Already excluded under the new key ⇒ re-point the intent, no second Maintainerr write. */
  it('re-points the intent without a duplicate exclusion when the new key is already excluded', async () => {
    const { state, bundle } = await lapseAfterRekey();
    state.exclusions.add('ms-9101'); // e.g. the owner re-saved it by hand

    const report = await relinkSaveIntents({ db: t.db, maintainerr: bundle });
    expect(report.alreadyExcluded).toBe(1);
    expect(report.relinked).toBe(0);

    const [intent] = await t.db
      .select()
      .from(trashSaveIntents)
      .where(and(eq(trashSaveIntents.mediaItemId, movieItemId), isNull(trashSaveIntents.revokedAt)));
    expect(intent!.maintainerrMediaId).toBe('ms-9101');
  });

  /** ADR-086 D-9 — it ships enforcing, but the kill switch must genuinely stop every write. */
  it('kill switch off ⇒ census only, zero Maintainerr writes', async () => {
    const { state, bundle, calls } = await lapseAfterRekey();
    await setAppSetting({ db: t.db, key: 'trash_relink_enabled', value: false, actorId });

    const report = await relinkSaveIntents({ db: t.db, maintainerr: bundle });

    expect(report.enforced).toBe(false);
    expect(report.scanned).toBe(1);
    expect(report.relinked).toBe(0);
    expect(report.samples[0]?.outcome).toBe('would-relink');
    expect(state.exclusions.has('ms-9101')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.pathname.includes('exclusion'))).toBe(false);
  });

  /**
   * SCOPE, deliberately: the reconciler joins only against POOL MEMBERS, so an intent whose key
   * went stale while the title is not slated for deletion is left alone. That stale key is inert —
   * nothing is at risk — and it self-corrects the moment the title re-enters a pool. Widening the
   * scan outside the pool would spend Maintainerr reads on non-problems and lose the property that
   * every write this makes is protecting something genuinely slated. (This is the real Green
   * Lantern shape after its hand-repair: re-protected, out of the pool, intent still on the old key.)
   */
  it('relinks lazily — a stale key on a non-pooled title is left alone until it is slated again', async () => {
    const state = baseState({ collections: [movieCollection()] });
    const first = makeMaintainerr(state);
    await saveExclusion({
      db: t.db,
      maintainerr: first.bundle,
      maintainerrMediaId: 'ms-9001',
      mediaItemId: movieItemId,
      actorId,
    });

    // Re-keyed AND no longer pending (it left the pool when the exclusion took effect).
    state.collections[0]!.items = state.collections[0]!.items.filter(
      (i) => i.mediaServerId !== 'ms-9001',
    );
    const mid = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: mid.bundle });

    const quiet = await relinkSaveIntents({ db: t.db, maintainerr: mid.bundle });
    expect(quiet.scanned).toBe(0);
    expect(quiet.relinked).toBe(0);
    const [stale] = await t.db
      .select()
      .from(trashSaveIntents)
      .where(and(eq(trashSaveIntents.mediaItemId, movieItemId), isNull(trashSaveIntents.revokedAt)));
    expect(stale!.maintainerrMediaId).toBe('ms-9001'); // still the old key, and that is fine

    // Now the title is slated again under a NEW key, already excluded (the hand-repair shape).
    state.collections[0]!.items.push({
      mediaServerId: 'ms-9101',
      tmdbId: 9001,
      sizeBytes: 4_000_000_000,
      addDate: '2026-08-06T00:00:00Z',
    });
    state.exclusions.add('ms-9101');
    const late = makeMaintainerr(state);
    await refreshTrashCandidates({ db: t.db, maintainerr: late.bundle });

    const report = await relinkSaveIntents({ db: t.db, maintainerr: late.bundle });
    expect(report.scanned).toBe(1);
    expect(report.alreadyExcluded).toBe(1);
    expect(report.relinked).toBe(0); // already protected — re-point only, no duplicate write
    const [fixed] = await t.db
      .select()
      .from(trashSaveIntents)
      .where(and(eq(trashSaveIntents.mediaItemId, movieItemId), isNull(trashSaveIntents.revokedAt)));
    expect(fixed!.maintainerrMediaId).toBe('ms-9101');
  });

  /** A Maintainerr outage must be reported, never thrown into the caller's face. */
  it('surfaces a per-item failure without aborting the run', async () => {
    const { state, bundle } = await lapseAfterRekey();
    state.fail.add('POST /rules/exclusion');

    const report = await relinkSaveIntents({ db: t.db, maintainerr: bundle });
    expect(report.failed).toBe(1);
    expect(report.relinked).toBe(0);
  });
});
