import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, withMigratedDb, type StartedPostgres } from '@hnet/test-utils';
import { runMigrations } from '../src/migrate';

// NOTE: this file exercises schema-level invariants (CHECK constraints, seed
// semantics) with direct SQL on purpose — it is on the ALLOWED_FILES list of the
// no-direct-state-writes guard (packages/domain/__tests__), donor pattern.

const SEED_SLUGS = [
  'seerr',
  'plex',
  'k8plex',
  'plexops',
  'immich',
  'open-webui',
  'paperless',
  'tautulli',
];
describe('withMigratedDb', () => {
  it('boots an embedded Postgres 16, applies both migrations, and tears down', async () => {
    const version = await withMigratedDb(async (connectionString) => {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const seeded = await client.query('SELECT count(*)::int AS n FROM app_catalog');
        expect(seeded.rows[0].n).toBe(8);
        const v = await client.query('SHOW server_version');
        return String(v.rows[0].server_version);
      } finally {
        await client.end();
      }
    });
    expect(version.startsWith('16.')).toBe(true); // CLAUDE.md rule 1: PostgreSQL 16, no substitutes
  });
});

describe('migrations against embedded Postgres 16', () => {
  let pg: StartedPostgres;
  let client: Client;

  beforeAll(async () => {
    pg = await startPostgres();
    await runMigrations({ databaseUrl: pg.connectionString });
    client = new Client({ connectionString: pg.connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await pg?.stop();
  });

  it('creates the Phase 1 tables (ADR-012 roles model) and drops the tag/grant surface', async () => {
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = tables.rows.map((r) => r.table_name as string);
    for (const expected of [
      'users',
      'session',
      'account',
      'verification',
      'roles',
      'role_app_grants',
      'user_role_transitions',
      'app_catalog',
      'permission_audit',
    ]) {
      expect(names).toContain(expected);
    }
    // ADR-012 dropped the tag/grant tables and the derivation view.
    for (const gone of ['tags', 'tag_app_grants', 'user_tags', 'user_app_grants']) {
      expect(names).not.toContain(gone);
    }
    const view = await client.query(
      `SELECT table_name FROM information_schema.views
        WHERE table_schema = 'public' AND table_name = 'effective_app_grants'`,
    );
    expect(view.rowCount).toBe(0);
  });

  it('is idempotent: re-running runMigrations applies nothing new', async () => {
    await runMigrations({ databaseUrl: pg.connectionString });
    const seeded = await client.query('SELECT count(*)::int AS n FROM app_catalog');
    expect(seeded.rows[0].n).toBe(8);
  });

  it('seeds the catalog exactly per DESIGN-001 D-14', async () => {
    const rows = await client.query(
      'SELECT slug, name, url, icon, sort_order FROM app_catalog ORDER BY sort_order',
    );
    expect(rows.rows.map((r) => r.slug)).toEqual(SEED_SLUGS);
    const bySlug = new Map(rows.rows.map((r) => [r.slug, r]));
    expect(bySlug.get('seerr').url).toBe('https://overseerr.haynesnetwork.com');
    expect(bySlug.get('plex').url).toBe('https://plex.haynesnetwork.com');
    expect(bySlug.get('k8plex').url).toBe('https://k8plex.haynesnetwork.com');
    expect(bySlug.get('plexops').url).toBe('https://plexops.haynesnetwork.com');
    expect(bySlug.get('immich').url).toBe('https://immich.haynesnetwork.com');
    expect(bySlug.get('open-webui').url).toBe('https://ai.haynesnetwork.com');
    expect(bySlug.get('paperless').url).toBe('https://paperless.haynesnetwork.com');
    expect(bySlug.get('tautulli').url).toBe('https://tautulli.haynesnetwork.com');
    expect(rows.rows.map((r) => r.sort_order)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('seeds Admin + Default + Family roles with the right app sets (ADR-012)', async () => {
    const roleRows = await client.query(
      'SELECT name, is_admin, is_default, grants_all FROM roles ORDER BY sort_order',
    );
    expect(roleRows.rows.map((r) => r.name)).toEqual(['Admin', 'Default', 'Family']);
    expect(roleRows.rows.find((r) => r.name === 'Admin').is_admin).toBe(true);
    expect(roleRows.rows.find((r) => r.name === 'Default').is_default).toBe(true);
    expect(roleRows.rows.every((r) => r.grants_all === false)).toBe(true); // none are all-apps

    const grantsFor = async (name: string) => {
      const res = await client.query(
        `SELECT ac.slug FROM role_app_grants rag
           JOIN roles r ON r.id = rag.role_id AND r.name = $1
           JOIN app_catalog ac ON ac.id = rag.app_id
          ORDER BY ac.sort_order`,
        [name],
      );
      return res.rows.map((r) => r.slug);
    };
    // Default = the old default-visible set PLUS plexops.
    expect(await grantsFor('Default')).toEqual(['seerr', 'plex', 'k8plex', 'plexops']);
    // Family (extended family) = every app except tautulli.
    expect(await grantsFor('Family')).toEqual([
      'seerr',
      'plex',
      'k8plex',
      'plexops',
      'immich',
      'open-webui',
      'paperless',
    ]);
    // Admin stores NO explicit grants (all-apps is implicit via is_admin).
    expect(await grantsFor('Admin')).toEqual([]);
  });

  // (The 0002 seed's idempotency / empty-table guard was validated when it shipped and is
  // re-proven by "re-running runMigrations applies nothing new" above. Manually replaying
  // the raw 0002 SQL is no longer possible: migration 0007 drops app_catalog.default_visible,
  // which that historical INSERT references — and shipped migrations are never edited.)

  it('0011 corrects the haynestower registry base_url to the external ingress (live defect fix)', async () => {
    const rows = await client.query('SELECT slug, base_url FROM plex_servers ORDER BY slug');
    const bySlug = new Map(rows.rows.map((r) => [r.slug as string, r.base_url as string]));
    // haynestower is the EXTERNAL Unraid box — reachable via its public ingress, NOT an
    // in-cluster Service (the 0010 seed's svc.cluster.local URL did not resolve).
    expect(bySlug.get('haynestower')).toBe('https://plex.haynesnetwork.com');
    // The other two ARE genuine in-cluster Services and are left untouched by 0011.
    expect(bySlug.get('haynesops')).toBe('http://plexops.media.svc.cluster.local:32400');
    expect(bySlug.get('hayneskube')).toBe('http://plex.media.svc.cluster.local:32400');
  });

  describe('app_catalog_url_scheme CHECK (ADR-013 — scheme backstop only, arbitrary hosts)', () => {
    const insert = (slug: string, url: string) =>
      client.query({
        text: `INSERT INTO app_catalog (slug, name, url) VALUES ($1, $2, $3)`,
        values: [slug, slug, url],
      });

    it('accepts arbitrary hosts, including *.haynesops.com (host no longer restricted)', async () => {
      await insert('ok-google', 'https://google.com');
      await insert('ok-http', 'http://foo.com');
      await insert('ok-ops', 'https://x.haynesops.com');
      await client.query(`DELETE FROM app_catalog WHERE slug IN ('ok-google','ok-http','ok-ops')`);
    });

    it('rejects a non-http(s) scheme', async () => {
      await expect(insert('bad-ftp', 'ftp://x.com')).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects a value with no http(s):// prefix', async () => {
      await expect(insert('bad-bare', 'notaurl')).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('constraints (roles model — DESIGN-001 D-01.5 + ADR-012)', () => {
    it('roles_not_admin_and_default rejects a role that is both', async () => {
      await expect(
        client.query(`INSERT INTO roles (name, is_admin, is_default) VALUES ('both', true, true)`),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('roles_single_admin_idx allows only one Admin role', async () => {
      await expect(
        client.query(`INSERT INTO roles (name, is_admin) VALUES ('admin2', true)`),
      ).rejects.toMatchObject({ code: '23505' }); // partial unique index (the seeded Admin exists)
    });

    it('user_role_transitions_initiator_kind_enum rejects "user" (users never change their own role)', async () => {
      const user = await client.query(
        `INSERT INTO users (email, display_name, role_id)
           VALUES ('kind@example.com', 'Kind', (SELECT id FROM roles WHERE is_default)) RETURNING id`,
      );
      await expect(
        client.query({
          text: `INSERT INTO user_role_transitions (user_id, to_role_id, initiator_kind)
                   VALUES ($1, (SELECT id FROM roles WHERE is_admin), 'user')`,
          values: [user.rows[0].id],
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('permission_audit_action_enum rejects unknown actions', async () => {
      await expect(
        client.query(`INSERT INTO permission_audit (action) VALUES ('grant_everything')`),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
