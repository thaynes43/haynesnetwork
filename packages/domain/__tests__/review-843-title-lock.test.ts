import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootMigratedDb, type TestDb } from './helpers';
import { inTransaction } from '../src/db-client';
import {
  lockTrashTitle,
  claimTitleDeletion,
  finishTitleDeletion,
  hasTitleDeleteClaim,
} from '../src/trash-title-lock';
let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => t?.stop());
it('finishes a definitively settled claim after another title transaction releases its lock', async () => {
  const identity = { arrKind: 'radarr' as const, externalId: 83001 };
  const claimId = await inTransaction(t.db, async (tx) => {
    expect(await lockTrashTitle(tx, identity)).toBe(true);
    return claimTitleDeletion(tx, identity);
  });
  let unlock!: () => void, acquired!: () => void;
  const released = new Promise<void>((resolve) => {
      unlock = resolve;
    }),
    locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
  const holder = inTransaction(t.db, async (tx) => {
    expect(await lockTrashTitle(tx, identity)).toBe(true);
    acquired();
    await released;
  });
  await locked;
  const finish = finishTitleDeletion(t.db, identity, claimId!);
  // A claim remains held until the finishing transaction can acquire its lock.
  expect(await inTransaction(t.db, (tx) => hasTitleDeleteClaim(tx, identity))).toBe(true);
  unlock();
  await holder;
  await finish;
  expect(await inTransaction(t.db, (tx) => hasTitleDeleteClaim(tx, identity))).toBe(false);
});
