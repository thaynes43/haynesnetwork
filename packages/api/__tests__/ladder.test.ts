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
  role: {
    id: UUID_B,
    name: 'Default',
    isAdmin: false,
    sectionPermissions: { ledger: 'read_only', trash: 'disabled' },
    trashActions: [],
  },
};

/** Every procedure behind authedProcedure (directly or via adminProcedure). */
const AUTHED_CALLS: Array<[string, (c: Caller) => Promise<unknown>]> = [
  ['profile.me', (c) => c.profile.me()],
  ['catalog.myApps', (c) => c.catalog.myApps()],
  ['ledger.search', (c) => c.ledger.search({})],
  ['ledger.detail', (c) => c.ledger.detail({ id: UUID_A })],
  ['ledger.events', (c) => c.ledger.events({ mediaItemId: UUID_A })],
  ['ledger.children', (c) => c.ledger.children({ mediaItemId: UUID_A })],
  ['ledger.wanted', (c) => c.ledger.wanted({})],
  ['fix.create', (c) => c.fix.create({ mediaItemId: UUID_A, reason: 'wrong_language' })],
  ['fix.myFixes', (c) => c.fix.myFixes()],
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
  ['users.setRole', (c) => c.users.setRole({ userId: UUID_A, roleId: UUID_B })],
  ['roles.list', (c) => c.roles.list()],
  ['roles.create', (c) => c.roles.create({ name: 'x' })],
  ['roles.update', (c) => c.roles.update({ id: UUID_A, name: 'y' })],
  ['roles.delete', (c) => c.roles.delete({ id: UUID_A })],
  ['roles.setTrashActions', (c) => c.roles.setTrashActions({ roleId: UUID_A, actions: [] })],
  ['fix.adminList', (c) => c.fix.adminList({})],
  ['restore.diff', (c) => c.restore.diff({ arrKind: 'sonarr' })],
  ['restore.execute', (c) => c.restore.execute({ arrKind: 'sonarr', mediaItemIds: [UUID_A] })],
  ['restore.run', (c) => c.restore.run({ id: UUID_A })],
  ['restore.runs', (c) => c.restore.runs()],
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
