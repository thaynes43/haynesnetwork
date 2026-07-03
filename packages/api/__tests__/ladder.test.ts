// DESIGN-003 D-02 test strategy — the procedure ladder fails closed:
// unauthenticated → UNAUTHORIZED on every authed rung; Member → FORBIDDEN on every
// admin procedure. No DB is booted: the gates must fire before any query runs
// (forbidDbAccess throws on first touch).
import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@hnet/auth';
import { caller, forbidDbAccess, makeCtx, type Caller } from './helpers';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';

const member: SessionUser = {
  id: UUID_A,
  email: 'member@example.com',
  displayName: 'Member Mia',
  role: 'Member',
  isFamily: false,
};

/** Every procedure behind authedProcedure (directly or via adminProcedure). */
const AUTHED_CALLS: Array<[string, (c: Caller) => Promise<unknown>]> = [
  ['profile.me', (c) => c.profile.me()],
  ['catalog.myApps', (c) => c.catalog.myApps()],
  ['tags.list', (c) => c.tags.list()],
];

/** Every admin procedure, with schema-valid inputs so FORBIDDEN is the only possible rejection. */
const ADMIN_CALLS: Array<[string, (c: Caller) => Promise<unknown>]> = [
  ['catalog.adminList', (c) => c.catalog.adminList()],
  [
    'catalog.create',
    (c) => c.catalog.create({ slug: 'x', name: 'X', url: 'https://x.haynesnetwork.com' }),
  ],
  ['catalog.update', (c) => c.catalog.update({ id: UUID_A, name: 'X' })],
  ['catalog.delete', (c) => c.catalog.delete({ id: UUID_A })],
  ['catalog.reorder', (c) => c.catalog.reorder({ orderedIds: [UUID_A] })],
  ['users.list', (c) => c.users.list()],
  ['users.setFamily', (c) => c.users.setFamily({ userId: UUID_A, isFamily: true })],
  ['users.grantApp', (c) => c.users.grantApp({ userId: UUID_A, appId: UUID_B })],
  ['users.revokeApp', (c) => c.users.revokeApp({ userId: UUID_A, appId: UUID_B })],
  ['tags.create', (c) => c.tags.create({ name: 'x', bundle: {} })],
  ['tags.update', (c) => c.tags.update({ id: UUID_A, name: 'y' })],
  ['tags.delete', (c) => c.tags.delete({ id: UUID_A })],
  ['tags.applyToUser', (c) => c.tags.applyToUser({ tagId: UUID_A, userId: UUID_B })],
  ['tags.removeFromUser', (c) => c.tags.removeFromUser({ tagId: UUID_A, userId: UUID_B })],
];

describe('procedure ladder (D-02)', () => {
  const anonCaller = caller(makeCtx(forbidDbAccess(), null));
  const memberCaller = caller(makeCtx(forbidDbAccess(), member));

  describe('authedProcedure rejects anonymous callers with UNAUTHORIZED', () => {
    it.each([...AUTHED_CALLS, ...ADMIN_CALLS])('%s', async (_name, call) => {
      await expect(call(anonCaller)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('adminProcedure rejects Members with FORBIDDEN', () => {
    it.each(ADMIN_CALLS)('%s', async (_name, call) => {
      await expect(call(memberCaller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});
