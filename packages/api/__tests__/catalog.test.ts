// DESIGN-003 test strategy — catalog: the myApps union (default ∪ direct ∪ tag with
// overlap dedupe, AC-06), admin CRUD via the audited domain helpers, the R-14 URL
// table across the zod edge (layer 1) and the domain assert (layer 2), and the D-13
// error taxonomy through the real errorFormatter. Layer 3 (the DB CHECK) is exercised
// by packages/db/__tests__/migrations.test.ts per the design's test strategy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appCatalog, type users } from '@hnet/db';
import { createApp, ForbiddenHostError } from '@hnet/domain';
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
  admin = await createUser(testDb.db, { role: 'Admin', displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { role: 'Member', displayName: 'Member Mia' });
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

describe('catalog.myApps — effective visible apps (R-10, D-05)', () => {
  it('fresh Member sees exactly the seeded default-visible tiles, ordered by sort_order', async () => {
    const apps = await memberCaller.catalog.myApps();
    expect(apps.map((a) => a.slug)).toEqual(['seerr', 'plex', 'k8plex']);
    // Provenance-free projection: no sortOrder/source/tagId on the wire (D-05).
    expect(Object.keys(apps[0]!).sort()).toEqual([
      'description',
      'icon',
      'id',
      'name',
      'slug',
      'url',
    ]);
  });

  it('a direct admin grant adds a hidden app in sort_order position (R-15)', async () => {
    const result = await adminCaller.users.grantApp({
      userId: member.id,
      appId: appIdBySlug.get('immich')!,
    });
    expect(result).toEqual({ changed: true });
    const apps = await memberCaller.catalog.myApps();
    expect(apps.map((a) => a.slug)).toEqual(['seerr', 'plex', 'k8plex', 'immich']);
  });

  it('a tag grant adds its bundle by reference, deduped against direct grants (R-21, AC-06)', async () => {
    const { tagId } = await adminCaller.tags.create({
      name: 'media-power',
      description: 'paperless + tautulli bundle',
      bundle: { appIds: [appIdBySlug.get('paperless')!, appIdBySlug.get('tautulli')!] },
    });
    await adminCaller.tags.applyToUser({ tagId, userId: member.id });
    // Overlap: paperless is now ALSO granted directly — must appear exactly once.
    await adminCaller.users.grantApp({ userId: member.id, appId: appIdBySlug.get('paperless')! });

    const apps = await memberCaller.catalog.myApps();
    expect(apps.map((a) => a.slug)).toEqual([
      'seerr',
      'plex',
      'k8plex',
      'immich',
      'paperless',
      'tautulli',
    ]);

    // AC-06: removing the tag removes exactly the tag-derived permissions — the
    // direct paperless grant survives, tautulli disappears.
    await adminCaller.tags.removeFromUser({ tagId, userId: member.id });
    const after = await memberCaller.catalog.myApps();
    expect(after.map((a) => a.slug)).toEqual(['seerr', 'plex', 'k8plex', 'immich', 'paperless']);
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
    expect(seerr.defaultVisible).toBe(true);
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
    await adminCaller.catalog.update({ id, defaultVisible: true });
    let row = (await adminCaller.catalog.adminList()).find((r) => r.id === id)!;
    expect(row.defaultVisible).toBe(true);

    // Patching the name must NOT silently reset defaultVisible/icon/description.
    await adminCaller.catalog.update({ id, name: 'Jellyfin 2' });
    row = (await adminCaller.catalog.adminList()).find((r) => r.id === id)!;
    expect(row.name).toBe('Jellyfin 2');
    expect(row.defaultVisible).toBe(true);
    expect(row.description).toBe('Alt media server');

    const updates = await auditRows(testDb.db, 'update_app');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.every((r) => r.actorId === admin.id)).toBe(true);
  });

  it('delete audits delete_app and cascades grants away in the same transaction', async () => {
    const id = appIdBySlug.get('jellyfin')!;
    await adminCaller.users.grantApp({ userId: member.id, appId: id });
    await adminCaller.catalog.delete({ id });

    const rows = await auditRows(testDb.db, 'delete_app');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ app_slug: 'jellyfin' });

    const apps = await memberCaller.catalog.myApps();
    expect(apps.map((a) => a.slug)).not.toContain('jellyfin');
  });

  it('unknown target id → NOT_FOUND (D-06)', async () => {
    await expect(
      adminCaller.catalog.update({ id: '00000000-0000-4000-8000-00000000dead', name: 'X' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('R-14 URL validation — the DESIGN-003 rejection table (AC-04)', () => {
  const rejected = [
    'http://plex.haynesnetwork.com', // scheme
    'https://sonarr.haynesops.com', // LAN-only ingress (CLAUDE.md rule 3)
    'https://haynesnetwork.com', // bare apex
    'https://evil.com/?x=.haynesnetwork.com', // host in query
    'https://evil.haynesnetwork.com.attacker.io', // suffix attack
    'https://a.haynesnetwork.com:8443', // port
    'https://user:secret@a.haynesnetwork.com', // credentials
    'https://192.168.4.20', // IP literal
  ];
  const accepted = [
    'https://plex.haynesnetwork.com',
    'https://plex.haynesnetwork.com/web/index.html',
  ];

  it('layer 1 (zod edge): catalogUrlSchema rejects the table and accepts real hosts', () => {
    for (const url of rejected) {
      expect(catalogUrlSchema.safeParse(url).success, url).toBe(false);
    }
    for (const url of accepted) {
      expect(catalogUrlSchema.safeParse(url).success, url).toBe(true);
    }
  });

  it('layer 1 via the procedure: catalog.create → BAD_REQUEST before any logic runs', async () => {
    for (const url of rejected) {
      await expect(
        adminCaller.catalog.create({ slug: 'bad', name: 'Bad', url }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('layer 2 (domain assert): createApp throws ForbiddenHostError for the same table', async () => {
    for (const url of rejected) {
      await expect(
        createApp({ db: testDb.db, slug: 'bad', name: 'Bad', url, actorId: admin.id }),
      ).rejects.toBeInstanceOf(ForbiddenHostError);
    }
  });

  it('the typed error surfaces as appCode CATALOG_URL_FORBIDDEN_HOST on the wire (D-13)', async () => {
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
          url: 'https://sonarr.haynesops.com',
          actorId: admin.id,
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    expect((thrown as Error).cause).toBeInstanceOf(ForbiddenHostError);
    const shape = wireShape(thrown, 'catalog.create');
    expect(shape.data.appCode).toBe('CATALOG_URL_FORBIDDEN_HOST');
    expect(shape.data.code).toBe('UNPROCESSABLE_CONTENT');
  });

  it('layer 2 catches what layer 1 misses, end to end through catalog.create', async () => {
    // zod's URL check tolerates a query string glued to the hostname; the domain
    // assert (mirroring the DB CHECK) requires a `/` first — so this input reaches
    // layer 2 through the real procedure and comes back as the typed domain error.
    await expect(
      adminCaller.catalog.create({
        slug: 'sneaky',
        name: 'Sneaky',
        url: 'https://sneaky.haynesnetwork.com?p=1',
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
