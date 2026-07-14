import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  activityImportFailures,
  notificationOutbox,
  permissionAudit,
  roleActivityActionGrants,
  roles,
} from '@hnet/db';
import { bootMigratedDb, createUser, type TestDb } from './helpers';
import {
  evaluateActivityFailures,
  getActivityFailure,
  recordActivityAction,
  toFailureInputs,
  type ActivityFailureInput,
} from '../src/activity/failures';
import { setRoleActivityActions, activityActionsForRole } from '../src/activity-permissions';
import type { ActivityItem } from '../src/activity/contract';

// ADR-059 / DESIGN-030 (PLAN-048) — the durable failure ledger single-writer + audited actions + the grant
// seam. Proves: a NEW failure upserts the ledger AND enqueues EXACTLY ONE outbox row same-tx; a repeat
// scan enqueues zero (dedupe); a cleared failure is CLOSED not deleted; an action stamps + audits same-tx;
// and the grant seam gates (admin ⇒ all, a role grants one, absence ⇒ none).

let boot: TestDb;
beforeAll(async () => {
  boot = await bootMigratedDb();
}, 120_000);
afterAll(async () => {
  await boot?.stop();
});
beforeEach(async () => {
  await boot.db.delete(activityImportFailures);
  await boot.db.delete(notificationOutbox);
  await boot.db.delete(permissionAudit);
  await boot.db.delete(roleActivityActionGrants);
});

function failure(overrides: Partial<ActivityFailureInput> & { sourceRef: string }): ActivityFailureInput {
  return {
    source: 'books',
    kind: 'book',
    section: 'books',
    failureKind: 'stranded_import',
    failureReason: 'downloaded but never imported',
    title: overrides.sourceRef,
    year: null,
    sourceApp: 'lazylibrarian',
    downstreamUrl: 'http://ll',
    ...overrides,
  };
}

describe('evaluateActivityFailures — the failure ledger + same-tx outbox', () => {
  it('records a new failure and enqueues exactly one outbox row', async () => {
    const report = await evaluateActivityFailures({
      db: boot.db,
      failures: [failure({ sourceRef: 'books:ll:b1:ebook' })],
      scannedSources: ['books'],
    });
    expect(report).toMatchObject({ seen: 1, opened: 1, resolved: 0, enqueued: 1 });
    const rows = await boot.db.select().from(activityImportFailures);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'books', sourceRef: 'books:ll:b1:ebook', failureKind: 'stranded_import', resolvedAt: null });
    expect(rows[0]!.notifiedAt).not.toBeNull();
    const outbox = await boot.db.select().from(notificationOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('activity_import_failed');
  });

  it('a repeat scan of the same failure enqueues ZERO more (dedupe) and keeps it open', async () => {
    const f = failure({ sourceRef: 'books:ll:b2:ebook' });
    await evaluateActivityFailures({ db: boot.db, failures: [f], scannedSources: ['books'] });
    const report2 = await evaluateActivityFailures({ db: boot.db, failures: [f], scannedSources: ['books'] });
    expect(report2.opened).toBe(0);
    expect(report2.enqueued).toBe(0);
    expect(await boot.db.select().from(notificationOutbox)).toHaveLength(1);
    expect(await boot.db.select().from(activityImportFailures)).toHaveLength(1);
  });

  it('CLOSES a failure the next scan no longer sees (resolved, not deleted)', async () => {
    await evaluateActivityFailures({ db: boot.db, failures: [failure({ sourceRef: 'books:ll:b3:ebook' })], scannedSources: ['books'] });
    const report = await evaluateActivityFailures({ db: boot.db, failures: [], scannedSources: ['books'] });
    expect(report.resolved).toBe(1);
    const rows = await boot.db.select().from(activityImportFailures);
    expect(rows).toHaveLength(1); // still there
    expect(rows[0]!.resolvedAt).not.toBeNull(); // but closed
  });

  it('only reconciles the SCANNED sources (a books scan never closes an *arr failure)', async () => {
    await evaluateActivityFailures({ db: boot.db, failures: [failure({ source: 'radarr', sourceRef: 'radarr:1' })], scannedSources: ['radarr'] });
    // A books-only scan with no failures must NOT close the radarr failure.
    const report = await evaluateActivityFailures({ db: boot.db, failures: [], scannedSources: ['books'] });
    expect(report.resolved).toBe(0);
    const open = await boot.db.select().from(activityImportFailures).where(isNull(activityImportFailures.resolvedAt));
    expect(open).toHaveLength(1);
  });

  it('re-opens + re-notifies a previously-resolved failure that recurs', async () => {
    const f = failure({ sourceRef: 'books:ll:b4:ebook' });
    await evaluateActivityFailures({ db: boot.db, failures: [f], scannedSources: ['books'] });
    await evaluateActivityFailures({ db: boot.db, failures: [], scannedSources: ['books'] }); // resolve
    const report = await evaluateActivityFailures({ db: boot.db, failures: [f], scannedSources: ['books'] }); // recur
    expect(report.opened).toBe(1);
    expect(await boot.db.select().from(notificationOutbox)).toHaveLength(2);
    const rows = await boot.db.select().from(activityImportFailures);
    expect(rows[0]!.resolvedAt).toBeNull();
  });
});

describe('toFailureInputs', () => {
  it('extracts only the failed items', () => {
    const items: ActivityItem[] = [
      { id: 'books:ll:a:ebook', kind: 'book', section: 'books', wall: 'books', title: 'A', year: null, sourceApp: 'lazylibrarian', stage: 'failed', progress: null, failureReason: 'x', failureKind: 'stranded_import', updatedAt: new Date().toISOString(), posterUrl: null, href: null, downstreamUrl: null, actions: ['retry_import'] },
      { id: 'books:ll:b:ebook', kind: 'book', section: 'books', wall: 'books', title: 'B', year: null, sourceApp: 'sabnzbd', stage: 'downloading', progress: 10, failureReason: null, failureKind: null, updatedAt: new Date().toISOString(), posterUrl: null, href: null, downstreamUrl: null, actions: [] },
    ];
    const inputs = toFailureInputs('books', items);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ source: 'books', sourceRef: 'books:ll:a:ebook', failureKind: 'stranded_import' });
  });
});

describe('recordActivityAction — audited same-tx', () => {
  it('stamps the failure + writes the matching permission_audit row', async () => {
    await evaluateActivityFailures({ db: boot.db, failures: [failure({ sourceRef: 'books:ll:b9:ebook' })], scannedSources: ['books'] });
    const [row] = await boot.db.select().from(activityImportFailures);
    const user = await createUser(boot.db);
    const { failure: updated } = await recordActivityAction({ db: boot.db, failureId: row!.id, action: 'retry_import', actorId: user.id });
    expect(updated.lastAction).toBe('retry_import');
    const audit = await boot.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'activity_retry_import'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(user.id);
  });
});

describe('activity action grant seam (ADR-023 machinery)', () => {
  /** The seeded Admin System Role (migration 0007 — the single-admin unique index forbids a second). */
  async function adminRoleId(): Promise<string> {
    const [row] = await boot.db.select({ id: roles.id }).from(roles).where(eq(roles.isAdmin, true));
    return row!.id;
  }
  /** A fresh non-admin role (no unique-index conflict). */
  async function makeRole(): Promise<string> {
    const [role] = await boot.db
      .insert(roles)
      .values({ name: `r-${Math.random().toString(36).slice(2)}`, isAdmin: false })
      .returning();
    return role!.id;
  }

  it('admin implies every action with no rows', async () => {
    const roleId = await adminRoleId();
    expect(await activityActionsForRole({ db: boot.db, roleId, isAdmin: true })).toEqual(['retry_import', 'force_research']);
  });

  it('a non-admin role has NOTHING until granted, then exactly its grants (audited)', async () => {
    const roleId = await makeRole();
    expect(await activityActionsForRole({ db: boot.db, roleId })).toEqual([]);
    const actor = await createUser(boot.db);
    const res = await setRoleActivityActions({ db: boot.db, roleId, actions: ['retry_import'], actorId: actor.id });
    expect(res.changed).toBe(true);
    expect(await activityActionsForRole({ db: boot.db, roleId })).toEqual(['retry_import']);
    const audit = await boot.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_activity_actions'));
    expect(audit).toHaveLength(1);
  });

  it('rejects editing the Admin role (immutable)', async () => {
    const roleId = await adminRoleId();
    const actor = await createUser(boot.db);
    await expect(setRoleActivityActions({ db: boot.db, roleId, actions: ['retry_import'], actorId: actor.id })).rejects.toThrow();
  });
});

// keep `and`/getActivityFailure referenced (getActivityFailure is exercised via the API path; assert it here too)
describe('getActivityFailure', () => {
  it('reads a row by id', async () => {
    await evaluateActivityFailures({ db: boot.db, failures: [failure({ sourceRef: 'books:ll:read:ebook' })], scannedSources: ['books'] });
    const [row] = await boot.db.select().from(activityImportFailures).where(and(eq(activityImportFailures.source, 'books'), isNull(activityImportFailures.resolvedAt)));
    const got = await getActivityFailure({ db: boot.db, failureId: row!.id });
    expect(got?.id).toBe(row!.id);
  });
});
