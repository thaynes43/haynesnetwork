// ADR-027 / DESIGN-004 D-15 (PLAN-010) — MOTD domain seam over the audited app_settings store.
// Embedded PG16. Proves: the getActiveMotd enabled + time-window resolution matrix (the ADR
// predicate — inclusive start, exclusive end); setMotd upserts the `motd` key AND co-writes an
// `update_app_setting` permission_audit row in ONE tx; clearMotd flips enabled=false + audits; and the
// pure isMotdActive / motdVersion helpers behave (dismiss versioning re-shows on edit).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { appSettings, permissionAudit } from '@hnet/db/schema';
import {
  clearMotd,
  getActiveMotd,
  getMotd,
  isMotdActive,
  motdVersion,
  setMotd,
  type MotdRecord,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
let actorId: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  actorId = (await createUser(t.db, { email: 'motd-actor@example.com' })).id;
});

afterAll(async () => {
  await t?.stop();
});

const motdAuditRows = () =>
  t.db
    .select({ actorId: permissionAudit.actorId, action: permissionAudit.action, detail: permissionAudit.detail })
    .from(permissionAudit)
    .where(eq(permissionAudit.action, 'update_app_setting'))
    .orderBy(asc(permissionAudit.createdAt));

const settingRow = () =>
  t.db.select().from(appSettings).where(eq(appSettings.key, 'motd'));

describe('isMotdActive — the enabled + time-window predicate (ADR-027)', () => {
  const base: MotdRecord = {
    message: 'Scheduled maintenance tonight.',
    severity: 'info',
    enabled: true,
    startsAt: null,
    endsAt: null,
    updatedBy: null,
  };
  const now = new Date('2026-07-07T12:00:00.000Z');

  it('enabled + no window ⇒ active', () => {
    expect(isMotdActive(base, now)).toBe(true);
  });

  it('disabled ⇒ inactive even with a valid window', () => {
    expect(isMotdActive({ ...base, enabled: false }, now)).toBe(false);
  });

  it('enabled but blank message ⇒ inactive', () => {
    expect(isMotdActive({ ...base, message: '   ' }, now)).toBe(false);
  });

  it('before the window (now < startsAt) ⇒ inactive', () => {
    expect(isMotdActive({ ...base, startsAt: '2026-07-07T18:00:00.000Z' }, now)).toBe(false);
  });

  it('inside the window ⇒ active', () => {
    expect(
      isMotdActive(
        { ...base, startsAt: '2026-07-07T06:00:00.000Z', endsAt: '2026-07-07T18:00:00.000Z' },
        now,
      ),
    ).toBe(true);
  });

  it('at/after the end (now >= endsAt, EXCLUSIVE end) ⇒ inactive', () => {
    expect(isMotdActive({ ...base, endsAt: '2026-07-07T12:00:00.000Z' }, now)).toBe(false);
    expect(isMotdActive({ ...base, endsAt: '2026-07-07T06:00:00.000Z' }, now)).toBe(false);
  });

  it('at the start boundary (now === startsAt, INCLUSIVE start) ⇒ active', () => {
    expect(isMotdActive({ ...base, startsAt: '2026-07-07T12:00:00.000Z' }, now)).toBe(true);
  });

  it('open-ended windows (only startsAt / only endsAt) resolve correctly', () => {
    expect(isMotdActive({ ...base, startsAt: '2026-07-07T06:00:00.000Z' }, now)).toBe(true);
    expect(isMotdActive({ ...base, endsAt: '2026-07-07T18:00:00.000Z' }, now)).toBe(true);
  });
});

describe('motdVersion — dismiss versioning (edit re-shows)', () => {
  it('changes when updatedAt changes (an edit bumps the row updated_at)', () => {
    const rec = { message: 'Hi', severity: 'info' as const };
    const v1 = motdVersion(new Date('2026-07-07T12:00:00.000Z'), rec);
    const v2 = motdVersion(new Date('2026-07-07T12:00:01.000Z'), rec);
    expect(v1).not.toBe(v2);
  });

  it('is stable for the same updatedAt + content (a dismissed banner stays dismissed)', () => {
    const when = new Date('2026-07-07T12:00:00.000Z');
    const rec = { message: 'Hi', severity: 'info' as const };
    expect(motdVersion(when, rec)).toBe(motdVersion(when, rec));
  });
});

describe('setMotd / clearMotd — audited single-writer over app_settings (hard rule 6)', () => {
  it('unset ⇒ getActiveMotd null and getMotd returns the disabled default', async () => {
    expect(await getActiveMotd(t.db)).toBeNull();
    expect(await getMotd(t.db)).toMatchObject({ enabled: false, message: '' });
  });

  it('setMotd upserts the motd row AND writes one update_app_setting audit row in the same tx', async () => {
    const rec = await setMotd({
      db: t.db,
      message: '  Server maintenance at 10pm.  ',
      severity: 'warning',
      enabled: true,
      actorId,
    });
    expect(rec.message).toBe('Server maintenance at 10pm.'); // trimmed

    const rows = await settingRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toMatchObject({ message: 'Server maintenance at 10pm.', severity: 'warning', enabled: true });

    const audits = await motdAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(actorId);
    expect(audits[0]!.detail).toMatchObject({ key: 'motd' });
    expect((audits[0]!.detail as { after: MotdRecord }).after).toMatchObject({
      enabled: true,
      severity: 'warning',
    });
  });

  it('getActiveMotd returns the wire shape (with a version) once enabled', async () => {
    const active = await getActiveMotd(t.db);
    expect(active).not.toBeNull();
    expect(active).toMatchObject({ message: 'Server maintenance at 10pm.', severity: 'warning' });
    expect(typeof active!.version).toBe('string');
    expect(active!.version.length).toBeGreaterThan(0);
  });

  it('a set with a past endsAt window ⇒ getActiveMotd null (out of window)', async () => {
    await setMotd({
      db: t.db,
      message: 'Expired notice',
      severity: 'info',
      enabled: true,
      endsAt: '2000-01-01T00:00:00.000Z',
      actorId,
    });
    expect(await getActiveMotd(t.db)).toBeNull();
  });

  it('clearMotd flips enabled=false (preserving the message) + audits a second row', async () => {
    await setMotd({ db: t.db, message: 'Live notice', severity: 'info', enabled: true, actorId });
    expect(await getActiveMotd(t.db)).not.toBeNull();

    const cleared = await clearMotd({ db: t.db, actorId });
    expect(cleared.enabled).toBe(false);
    expect(cleared.message).toBe('Live notice'); // preserved for a one-edit re-enable

    expect(await getActiveMotd(t.db)).toBeNull();
    // still exactly one motd row (upsert, never append) and the clear appended an audit row.
    expect(await settingRow()).toHaveLength(1);
    const audits = await motdAuditRows();
    expect(audits.length).toBeGreaterThanOrEqual(4); // set, set(window), set(live), clear
    expect(audits.at(-1)!.detail).toMatchObject({ key: 'motd' });
  });
});
