import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, withMigratedDb, type StartedPostgres } from '@hnet/test-utils';
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from '../src/migrate';

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
const DEFAULT_VISIBLE_SLUGS = ['seerr', 'plex', 'k8plex'];

async function seedSql(): Promise<string> {
  return readFile(join(DEFAULT_MIGRATIONS_FOLDER, '0002_seed_app_catalog.sql'), 'utf8');
}

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

  it('creates all Phase 1 tables and the effective_app_grants view', async () => {
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
      'user_role_transitions',
      'app_catalog',
      'user_app_grants',
      'tags',
      'tag_app_grants',
      'user_tags',
      'permission_audit',
    ]) {
      expect(names).toContain(expected);
    }
    const view = await client.query(
      `SELECT table_name FROM information_schema.views
        WHERE table_schema = 'public' AND table_name = 'effective_app_grants'`,
    );
    expect(view.rowCount).toBe(1);
  });

  it('is idempotent: re-running runMigrations applies nothing new', async () => {
    await runMigrations({ databaseUrl: pg.connectionString });
    const seeded = await client.query('SELECT count(*)::int AS n FROM app_catalog');
    expect(seeded.rows[0].n).toBe(8);
  });

  it('seeds the catalog exactly per DESIGN-001 D-14 (R-12 visible, R-13 hidden)', async () => {
    const rows = await client.query(
      'SELECT slug, name, url, icon, default_visible, sort_order FROM app_catalog ORDER BY sort_order',
    );
    expect(rows.rows.map((r) => r.slug)).toEqual(SEED_SLUGS);
    const visible = rows.rows.filter((r) => r.default_visible).map((r) => r.slug);
    expect(visible).toEqual(DEFAULT_VISIBLE_SLUGS);
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

  it('re-running the seed against a non-empty table inserts nothing (rows present exactly once)', async () => {
    await client.query(await seedSql());
    const rows = await client.query(
      'SELECT slug, count(*)::int AS n FROM app_catalog GROUP BY slug',
    );
    expect(rows.rowCount).toBe(8);
    for (const row of rows.rows) {
      expect(row.n).toBe(1);
    }
  });

  it('admin edits and deletions survive a seed re-run (D-14 empty-table guard)', async () => {
    await client.query(
      `UPDATE app_catalog SET url = 'https://seerr.haynesnetwork.com' WHERE slug = 'seerr'`,
    );
    await client.query(`DELETE FROM app_catalog WHERE slug = 'tautulli'`);
    await client.query(await seedSql());
    const count = await client.query('SELECT count(*)::int AS n FROM app_catalog');
    expect(count.rows[0].n).toBe(7); // tautulli stays deleted
    const seerr = await client.query(`SELECT url FROM app_catalog WHERE slug = 'seerr'`);
    expect(seerr.rows[0].url).toBe('https://seerr.haynesnetwork.com'); // edit survives
  });

  describe('app_catalog_url_haynesnetwork_only CHECK (R-14, end-anchored)', () => {
    const insert = (slug: string, url: string) =>
      client.query({
        text: `INSERT INTO app_catalog (slug, name, url) VALUES ($1, $2, $3)`,
        values: [slug, slug, url],
      });

    it('rejects *.haynesops.com (LAN-only ingress — CLAUDE.md rule 3)', async () => {
      await expect(insert('bad-ops', 'https://x.haynesops.com')).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('rejects the suffix attack https://evil.haynesnetwork.com.attacker.io', async () => {
      await expect(
        insert('bad-suffix', 'https://evil.haynesnetwork.com.attacker.io'),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects http:// and the bare apex', async () => {
      await expect(insert('bad-http', 'http://plex.haynesnetwork.com')).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert('bad-apex', 'https://haynesnetwork.com')).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('accepts https://plex.haynesnetwork.com (and deep paths)', async () => {
      await insert('good-plex', 'https://plex2.haynesnetwork.com');
      await insert('good-path', 'https://plex2.haynesnetwork.com/web/index.html');
      await client.query(`DELETE FROM app_catalog WHERE slug IN ('good-plex','good-path')`);
    });
  });

  describe('enum CHECK constraints (text + CHECK, DESIGN-001 D-01.5)', () => {
    it('users_role_enum rejects unknown roles', async () => {
      await expect(
        client.query(
          `INSERT INTO users (email, display_name, role) VALUES ('bad-role@example.com', 'Bad', 'Owner')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('user_role_transitions_initiator_kind_enum rejects "user" (users never change their own role)', async () => {
      const user = await client.query(
        `INSERT INTO users (email, display_name) VALUES ('kind@example.com', 'Kind') RETURNING id`,
      );
      await expect(
        client.query({
          text: `INSERT INTO user_role_transitions (user_id, to_role, initiator_kind) VALUES ($1, 'Admin', 'user')`,
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
