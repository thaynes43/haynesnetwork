// DESIGN-003 test strategy — catalog: the myApps union (default ∪ direct ∪ tag with
// overlap dedupe, AC-06), admin CRUD via the audited domain helpers, the URL
// normalize+validate path across the lenient zod edge (layer 1) and the authoritative
// domain assert (layer 2, BRANCH-A: any host allowed), and the D-13 error taxonomy
// through the real errorFormatter. Layer 3 (the scheme-only DB CHECK) is exercised
// by packages/db/__tests__/migrations.test.ts per the design's test strategy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appCatalog, SEEDED_ROLE_IDS, type users } from '@hnet/db';
import { createApp, InvalidCatalogUrlError } from '@hnet/domain';
import { mapDomainErrors } from '../src/trpc';
import { catalogUrlSchema } from '../src/schemas';
import {
  auditRows,
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  wireShape,
  type Caller,
  type TestDb,
} from './helpers';

let testDb: TestDb;
let admin: typeof users.$inferSelect;
let member: typeof users.$inferSelect;
let adminCaller: Caller;
let memberCaller: Caller;
let appIdBySlug: Map<string, string>;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  admin = await createUser(testDb.db, { admin: true, displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { displayName: 'Member Mia' }); // Default role
  adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
  memberCaller = caller(makeCtx(testDb.db, sessionUser(member)));
  const rows = await testDb.db
    .select({ id: appCatalog.id, slug: appCatalog.slug })
    .from(appCatalog);
  appIdBySlug = new Map(rows.map((r) => [r.slug, r.id]));
});

afterAll(async () => {
  await testDb.stop();
});

describe('catalog.myApps — role-based visible apps (R-10, ADR-012)', () => {
  it('a Default-role user sees exactly the Default role app set, ordered by sort_order', async () => {
    const apps = await memberCaller.catalog.myApps();
    expect(apps.map((a) => a.slug)).toEqual(['seerr', 'plex', 'k8plex', 'plexops']);
    // Provenance-free projection: no sortOrder on the wire (D-05).
    expect(Object.keys(apps[0]!).sort()).toEqual([
      'description',
      'icon',
      'id',
      'name',
      'slug',
      'url',
    ]);
  });

  it('an Admin sees every catalog app (implicit all-apps superuser)', async () => {
    const apps = await adminCaller.catalog.myApps();
    expect(apps.map((a) => a.slug)).toEqual([
      'seerr',
      'plex',
      'k8plex',
      'plexops',
      'immich',
      'open-webui',
      'paperless',
      'tautulli',
    ]);
  });

  it('assigning the user a different role changes the visible set (setRole)', async () => {
    const { roleId } = await adminCaller.roles.create({
      name: 'media-power',
      description: 'seerr + immich',
      appIds: [appIdBySlug.get('seerr')!, appIdBySlug.get('immich')!],
    });
    await adminCaller.users.setRole({ userId: member.id, roleId });
    expect((await memberCaller.catalog.myApps()).map((a) => a.slug)).toEqual(['seerr', 'immich']);

    // Restore to Default so later tests observe the default set again.
    await adminCaller.users.setRole({ userId: member.id, roleId: SEEDED_ROLE_IDS.default });
    expect((await memberCaller.catalog.myApps()).map((a) => a.slug)).toEqual([
      'seerr',
      'plex',
      'k8plex',
      'plexops',
    ]);
  });
});

describe('catalog.adminList (R-11)', () => {
  it('returns every entry incl. hidden ones, ordered, with ISO-8601 timestamps (D-03)', async () => {
    const rows = await adminCaller.catalog.adminList();
    expect(rows.map((r) => r.slug)).toEqual([
      'seerr',
      'plex',
      'k8plex',
      'plexops',
      'immich',
      'open-webui',
      'paperless',
      'tautulli',
    ]);
    const seerr = rows[0]!;
    expect(seerr.sortOrder).toBe(10);
    expect(typeof seerr.createdAt).toBe('string');
    expect(new Date(seerr.createdAt).toISOString()).toBe(seerr.createdAt);
  });
});

describe('catalog.create / update / delete — audited domain writes (D-07/D-08)', () => {
  it('creates an entry and writes the create_app audit row with the acting admin', async () => {
    const { appId } = await adminCaller.catalog.create({
      slug: 'jellyfin',
      name: 'Jellyfin',
      description: 'Alt media server',
      url: 'https://jellyfin.haynesnetwork.com',
    });
    appIdBySlug.set('jellyfin', appId);

    const rows = await auditRows(testDb.db, 'create_app');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.id, appId });

    const list = await adminCaller.catalog.adminList();
    expect(list.map((r) => r.slug)).toContain('jellyfin');
  });

  it('update patches only the provided fields (zod v4 partial keeps no defaults)', async () => {
    const id = appIdBySlug.get('jellyfin')!;
    await adminCaller.catalog.update({ id, description: 'Edited desc' });
    let row = (await adminCaller.catalog.adminList()).find((r) => r.id === id)!;
    expect(row.description).toBe('Edited desc');

    // Patching the name must NOT silently reset description/icon.
    await adminCaller.catalog.update({ id, name: 'Jellyfin 2' });
    row = (await adminCaller.catalog.adminList()).find((r) => r.id === id)!;
    expect(row.name).toBe('Jellyfin 2');
    expect(row.description).toBe('Edited desc');

    const updates = await auditRows(testDb.db, 'update_app');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.every((r) => r.actorId === admin.id)).toBe(true);
  });

  it('delete audits delete_app and cascades role grants away in the same transaction', async () => {
    const id = appIdBySlug.get('jellyfin')!;
    const { roleId } = await adminCaller.roles.create({ name: 'jelly-role', appIds: [id] });
    await adminCaller.users.setRole({ userId: member.id, roleId });
    expect((await memberCaller.catalog.myApps()).map((a) => a.slug)).toContain('jellyfin');

    await adminCaller.catalog.delete({ id });

    const rows = await auditRows(testDb.db, 'delete_app');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ app_slug: 'jellyfin' });

    // The role_app_grants row cascaded away — the role no longer grants the deleted app.
    expect((await memberCaller.catalog.myApps()).map((a) => a.slug)).not.toContain('jellyfin');
    await adminCaller.users.setRole({ userId: member.id, roleId: SEEDED_ROLE_IDS.default });
  });

  it('unknown target id → NOT_FOUND (D-06)', async () => {
    await expect(
      adminCaller.catalog.update({ id: '00000000-0000-4000-8000-00000000dead', name: 'X' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('catalog URL handling — normalize + validate, BRANCH-A: any host allowed (AC-04)', () => {
  // Genuinely-invalid inputs: a non-http(s) scheme or embedded credentials. Layer 2 (the
  // domain assert) rejects these; the lenient zod edge (layer 1) only guards a blank string.
  const invalid = [
    'javascript:alert(1)', // non-http(s) scheme
    'mailto:x@y.com', // non-http(s) scheme
    'https://user:secret@a.example.com', // credentials
  ];
  // raw input → canonical stored form (the normalizer's job). *.haynesops.com is now allowed.
  const normalized: Array<[string, string]> = [
    ['google.com', 'https://google.com'], // bare host → default https, no trailing slash
    ['www.google.com', 'https://www.google.com'], // www kept
    ['https://google.com', 'https://google.com'], // external https now ACCEPTED
    ['sonarr.haynesops.com', 'https://sonarr.haynesops.com'], // ALLOWED — BRANCH-A
    ['https://plex.haynesnetwork.com/web', 'https://plex.haynesnetwork.com/web'], // path kept
    ['http://foo.internal:8080/x', 'http://foo.internal:8080/x'], // explicit scheme + port kept
  ];

  it('layer 1 (zod edge): accepts any non-empty string, rejects only blank', () => {
    expect(catalogUrlSchema.safeParse('').success).toBe(false);
    expect(catalogUrlSchema.safeParse('   ').success).toBe(false); // trims to empty
    for (const [raw] of normalized) {
      expect(catalogUrlSchema.safeParse(raw).success, raw).toBe(true);
    }
    // Even eventually-invalid inputs survive layer 1 — the domain is authoritative.
    for (const url of invalid) {
      expect(catalogUrlSchema.safeParse(url).success, url).toBe(true);
    }
  });

  it('layer 1 via the procedure: a blank URL → BAD_REQUEST before any logic runs', async () => {
    await expect(
      adminCaller.catalog.create({ slug: 'blank', name: 'Blank', url: '   ' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('stores the canonical normalized URL, not the raw input', async () => {
    let n = 0;
    for (const [raw, canonical] of normalized) {
      const slug = `norm-${n++}`;
      const { appId } = await adminCaller.catalog.create({ slug, name: 'Norm', url: raw });
      const row = (await adminCaller.catalog.adminList()).find((r) => r.id === appId)!;
      expect(row.url, raw).toBe(canonical);
      await adminCaller.catalog.delete({ id: appId });
    }
  });

  it('layer 2 (domain assert): createApp throws InvalidCatalogUrlError for invalid URLs', async () => {
    for (const url of invalid) {
      await expect(
        createApp({ db: testDb.db, slug: 'bad', name: 'Bad', url, actorId: admin.id }),
      ).rejects.toBeInstanceOf(InvalidCatalogUrlError);
    }
  });

  it('the typed error surfaces as appCode CATALOG_URL_INVALID on the wire (D-13)', async () => {
    // mapDomainErrors is exactly what catalog.create wraps its domain call in; feeding
    // the thrown TRPCError through the router's real errorFormatter (wireShape) is the
    // same path the HTTP adapter takes to build the client-visible shape.
    let thrown: unknown;
    try {
      await mapDomainErrors(() =>
        createApp({
          db: testDb.db,
          slug: 'bad',
          name: 'Bad',
          url: 'javascript:alert(1)',
          actorId: admin.id,
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    expect((thrown as Error).cause).toBeInstanceOf(InvalidCatalogUrlError);
    const shape = wireShape(thrown, 'catalog.create');
    expect(shape.data.appCode).toBe('CATALOG_URL_INVALID');
    expect(shape.data.code).toBe('UNPROCESSABLE_CONTENT');
  });

  it('layer 2 catches what layer 1 misses, end to end through catalog.create', async () => {
    // The lenient zod edge lets any non-empty string through; the domain assert rejects a
    // non-http(s) scheme, so this input reaches layer 2 and returns the typed domain error.
    await expect(
      adminCaller.catalog.create({
        slug: 'sneaky',
        name: 'Sneaky',
        url: 'javascript:alert(1)',
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
  });
});

describe('catalog.reorder (D-06/D-08)', () => {
  it('a stale/partial id set → CONFLICT with appCode REORDER_SET_MISMATCH', async () => {
    const rows = await adminCaller.catalog.adminList();
    const staleSet = rows.slice(1).map((r) => r.id); // one id missing
    let thrown: unknown;
    try {
      await adminCaller.catalog.reorder({ orderedIds: staleSet });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'CONFLICT' });
    expect(wireShape(thrown, 'catalog.reorder').data.appCode).toBe('REORDER_SET_MISMATCH');
  });

  it('a complete permutation reassigns sort_order in gaps of 10 and audits once', async () => {
    const before = await adminCaller.catalog.adminList();
    const reversed = before.map((r) => r.id).reverse();
    const updateAuditCountBefore = (await auditRows(testDb.db, 'update_app')).length;

    await adminCaller.catalog.reorder({ orderedIds: reversed });

    const after = await adminCaller.catalog.adminList();
    expect(after.map((r) => r.id)).toEqual(reversed);
    expect(after.map((r) => r.sortOrder)).toEqual(reversed.map((_, i) => (i + 1) * 10));
    // D-08: one audit row for the whole reorder, not one per shifted entry.
    expect((await auditRows(testDb.db, 'update_app')).length).toBe(updateAuditCountBefore + 1);
  });
});
