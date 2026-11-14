// Cross-revision off-mode fixture: run unchanged against pinned main and this PR, then cmp outputs.
// Synthetic media/configuration only. Generated batch UUIDs are the only normalized payload values.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ledgerEvents, notifications, trashBatches, trashBatchItems } from '@hnet/db';
import {
  buildArrClientBundle,
  defaultPerKind,
  evaluateSpacePolicy,
  setAppSetting,
  type SpacePolicy,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection, tvCollection } from './maintainerr-stub';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => t?.stop());

it('off-mode captures identical selection and payload bytes on actual pinned main and corrections', async () => {
  const captures = [];
  for (const scenario of [
    'mixed-caps',
    'crossing-byte-target',
    'uncapped',
    'continuous-under',
    'continuous-unavailable',
    'under',
    'minimum',
  ] as const) {
    await t.db.delete(trashBatches);
    await t.db.delete(notifications);
    await t.db.delete(ledgerEvents).where(eq(ledgerEvents.eventType, 'trash_space_policy'));
    await setAppSetting({ db: t.db, key: 'trash_default_window_days', value: 7, actorId: null });
    await setAppSetting({
      db: t.db,
      key: 'space_targets',
      value: { haynestower: 80 },
      actorId: null,
    });
    const perKind = defaultPerKind();
    if (scenario === 'mixed-caps') {
      perKind.movie.maxItems = { enabled: true, value: 2 };
      perKind.tv.maxItems = { enabled: true, value: 1 };
    }
    if (scenario === 'crossing-byte-target')
      perKind.movie.targetBytes = { enabled: true, value: 5e9 };
    const policy: SpacePolicy = {
      enabled: true,
      mode: scenario.startsWith('continuous') ? 'continuous' : 'over-target',
      minCandidates: scenario === 'minimum' ? 4 : 1,
      perArray: { haynestower: { enabled: true } },
      perKind,
      dynamicPace: {
        enabled: false,
        observeOnly: false,
        horizonDays: 60,
        floorBytes: 1,
        ceilingBytes: 5e9,
      },
    };
    await setAppSetting({ db: t.db, key: 'space_policy', value: policy, actorId: null });
    const unavailable = scenario === 'continuous-unavailable';
    const freeSpace = scenario === 'under' || scenario === 'continuous-under' ? 300e12 : 100e12;
    const fetchImpl = (async () =>
      unavailable
        ? new Response('{}', { status: 500 })
        : new Response(
            JSON.stringify([{ path: '/data/haynestower', freeSpace, totalSpace: 1000e12 }]),
            { headers: { 'content-type': 'application/json' } },
          )) as typeof fetch;
    const opts = { apiKey: 'synthetic', fetchImpl, retryDelayMs: 0 };
    const arr = buildArrClientBundle({
      radarr: { ...opts, baseUrl: 'http://radarr.test' },
      sonarr: { ...opts, baseUrl: 'http://sonarr.test' },
      lidarr: { ...opts, baseUrl: 'http://lidarr.test' },
      bazarr: { ...opts, baseUrl: 'http://bazarr.test' },
    });
    const { bundle } = makeMaintainerr(
      baseState({ collections: [movieCollection(), tvCollection()] }),
    );
    const report = await evaluateSpacePolicy({
      db: t.db,
      maintainerr: bundle,
      arr,
      now: new Date('2026-11-14T08:00:00Z'),
      readFreeSpace: async () => {
        throw new Error('off reader called');
      },
    });
    const batches = await t.db.select().from(trashBatches);
    const kindByBatch = new Map(batches.map((b) => [b.id, b.mediaKind]));
    const normalize = (payload: Record<string, unknown>): Record<string, unknown> => ({
      ...payload,
      batchId: '<generated>',
    });
    captures.push({
      scenario,
      proposedCount: report.proposedCount,
      proposals: report.arrays[0]!.proposals.map((p) => ({
        ...p,
        batchId: p.batchId ? '<generated>' : null,
      })),
      batches: batches
        .map((b) => ({ kind: b.mediaKind, state: b.state, gateSkipped: b.gateSkipped }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      items: (await t.db.select().from(trashBatchItems))
        .map((i) => ({
          kind: kindByBatch.get(i.batchId),
          maintainerrMediaId: i.maintainerrMediaId,
          sizeBytes: i.sizeBytes,
          state: i.state,
        }))
        .sort((a, b) => a.maintainerrMediaId.localeCompare(b.maintainerrMediaId)),
      ledger: (
        await t.db
          .select()
          .from(ledgerEvents)
          .where(eq(ledgerEvents.eventType, 'trash_space_policy'))
      )
        .map((e) => normalize(e.payload))
        .sort((a, b) => String(a.mediaKind).localeCompare(String(b.mediaKind))),
      notices: (
        await t.db.select().from(notifications).where(eq(notifications.type, 'space_policy'))
      )
        .map((n) => ({
          source: n.source,
          type: n.type,
          title: n.title,
          body: n.body,
          payload: normalize(n.payload),
        }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    });
  }
  expect(captures.map((c) => c.proposedCount)).toEqual([2, 2, 2, 2, 2, 0, 0]);
  if (process.env.PACE_PARITY_OUTPUT)
    writeFileSync(process.env.PACE_PARITY_OUTPUT, JSON.stringify(captures, null, 2) + '\n');
});
