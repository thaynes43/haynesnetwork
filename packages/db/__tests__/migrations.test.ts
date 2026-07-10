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

  // ADR-026 / DESIGN-012 (migration 0018) — the Bulletin widening: the rebuilt CHECKs preserve the
  // prior values AND admit the new ones, and the widened notifications columns + dedupe index exist.
  describe('0018 Bulletin widening (ADR-026 — CHECK preservation + new tables/columns)', () => {
    it('notifications_source_enum admits maintainerr + the new seerr/tautulli, rejects unknown', async () => {
      for (const src of ['maintainerr', 'seerr', 'tautulli']) {
        await client.query({
          text: `INSERT INTO notifications (source, type, title) VALUES ($1, 'ev', 't')`,
          values: [src],
        });
      }
      await expect(
        client.query(`INSERT INTO notifications (source, type, title) VALUES ('overseerr', 'ev', 't')`),
      ).rejects.toMatchObject({ code: '23514' }); // 'overseerr' folds into 'seerr' — not its own value
      await client.query(`DELETE FROM notifications WHERE type = 'ev'`);
    });

    it('the widened notification columns + partial-unique dedupe index exist', async () => {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      for (const c of ['media_item_id', 'tmdb_id', 'tvdb_id', 'actor_user_id', 'occurred_at', 'source_event_id']) {
        expect(names).toContain(c);
      }
      // occurred_at is NOT NULL with a default (backfilled from created_at).
      const occ = await client.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
           WHERE table_name = 'notifications' AND column_name = 'occurred_at'`,
      );
      expect(occ.rows[0].is_nullable).toBe('NO');
      expect(String(occ.rows[0].column_default)).toContain('now()');
      // The (source, source_event_id) partial-unique dedupe index enforces idempotent re-delivery.
      await client.query(
        `INSERT INTO notifications (source, type, title, source_event_id) VALUES ('seerr','ev','a','X1')`,
      );
      await expect(
        client.query(
          `INSERT INTO notifications (source, type, title, source_event_id) VALUES ('seerr','ev','b','X1')`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
      // ...but two NULL source_event_ids are allowed (partial index — WHERE source_event_id IS NOT NULL).
      await client.query(`INSERT INTO notifications (source, type, title) VALUES ('maintainerr','ev','n1')`);
      await client.query(`INSERT INTO notifications (source, type, title) VALUES ('maintainerr','ev','n2')`);
      await client.query(`DELETE FROM notifications WHERE type = 'ev'`);
    });

    it('messages_status_enum admits visible/hidden/deleted, rejects unknown', async () => {
      const u = await client.query(
        `INSERT INTO users (email, display_name, role_id)
           VALUES ('msg@example.com', 'Msg', (SELECT id FROM roles WHERE is_default)) RETURNING id`,
      );
      const author = u.rows[0].id as string;
      for (const st of ['visible', 'hidden', 'deleted']) {
        await client.query({
          text: `INSERT INTO messages (author_user_id, body, status) VALUES ($1, 'b', $2)`,
          values: [author, st],
        });
      }
      await expect(
        client.query({
          text: `INSERT INTO messages (author_user_id, body, status) VALUES ($1, 'b', 'archived')`,
          values: [author],
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('role_message_action_grants_action_enum admits post/moderate, rejects unknown', async () => {
      const role = await client.query(`SELECT id FROM roles WHERE is_default`);
      const roleId = role.rows[0].id as string;
      for (const a of ['post', 'moderate']) {
        await client.query({
          text: `INSERT INTO role_message_action_grants (role_id, action) VALUES ($1, $2)`,
          values: [roleId, a],
        });
      }
      await expect(
        client.query({
          text: `INSERT INTO role_message_action_grants (role_id, action) VALUES ($1, 'admin')`,
          values: [roleId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM role_message_action_grants WHERE role_id = '${roleId}'`);
    });

    it('permission_audit_action_enum admits the new update_message_actions (preservation)', async () => {
      await client.query(
        `INSERT INTO permission_audit (action) VALUES ('update_message_actions')`,
      );
      // The prior values still validate (rebuild preserved them).
      await client.query(`INSERT INTO permission_audit (action) VALUES ('update_app_setting')`);
    });

    it('role_section_permissions_section_enum admits the new bulletin section', async () => {
      const role = await client.query(`SELECT id FROM roles WHERE is_default`);
      const roleId = role.rows[0].id as string;
      await client.query({
        text: `INSERT INTO role_section_permissions (role_id, section_id, level)
                 VALUES ($1, 'bulletin', 'read_only')`,
        values: [roleId],
      });
      await expect(
        client.query({
          text: `INSERT INTO role_section_permissions (role_id, section_id, level)
                   VALUES ($1, 'nonesuch', 'read_only')`,
          values: [roleId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM role_section_permissions WHERE role_id = '${roleId}' AND section_id = 'bulletin'`,
      );
    });
  });

  // ADR-027 / DESIGN-004 D-15 (migration 0019) — the MOTD reuses the app_settings store, so the
  // app_settings.key CHECK is relaxed to admit 'motd' (preserving the prior two keys).
  describe('0019 MOTD app_setting key (ADR-027 — CHECK relax, preservation)', () => {
    it('app_settings_key_enum admits motd + the prior keys, rejects unknown', async () => {
      for (const key of ['trash_skip_admin_gate', 'trash_default_window_days', 'motd']) {
        await client.query({
          text: `INSERT INTO app_settings (key, value) VALUES ($1, '{}'::jsonb)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          values: [key],
        });
      }
      await expect(
        client.query(`INSERT INTO app_settings (key, value) VALUES ('bogus_key', '{}'::jsonb)`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM app_settings WHERE key IN ('trash_skip_admin_gate','trash_default_window_days','motd')`);
    });
  });

  // ADR-034 / DESIGN-015 (migration 0024) — the Pushover notification outbox + two CHECK relaxes.
  describe('0024 Pushover notify outbox (ADR-034 — new table + CHECK relaxes)', () => {
    it('creates notification_outbox with the partial due index', async () => {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_outbox'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      for (const c of ['id', 'channel', 'event_type', 'payload', 'created_at', 'earliest_send_at', 'sent_at', 'attempts', 'last_error']) {
        expect(names).toContain(c);
      }
      const idx = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'notification_outbox'`,
      );
      expect(idx.rows.map((r) => r.indexname)).toContain('notification_outbox_due_idx');
    });

    it('notification_outbox CHECKs admit the known channel/event types, reject unknown', async () => {
      await client.query(
        `INSERT INTO notification_outbox (event_type) VALUES ('batch_created')`,
      );
      await client.query(
        `INSERT INTO notification_outbox (channel, event_type) VALUES ('pushover', 'batch_leaving_soon_reminder')`,
      );
      await expect(
        client.query(`INSERT INTO notification_outbox (channel, event_type) VALUES ('sms', 'batch_created')`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(`INSERT INTO notification_outbox (event_type) VALUES ('bogus_event')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM notification_outbox`);
    });

    it('app_settings_key_enum admits notify_window + the prior keys (preservation)', async () => {
      for (const key of ['trash_skip_admin_gate', 'space_policy', 'notify_window']) {
        await client.query({
          text: `INSERT INTO app_settings (key, value) VALUES ($1, '{}'::jsonb)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          values: [key],
        });
      }
      await expect(
        client.query(`INSERT INTO app_settings (key, value) VALUES ('nope_key', '{}'::jsonb)`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM app_settings WHERE key IN ('trash_skip_admin_gate','space_policy','notify_window')`);
    });

    it('sync_runs_run_kind_enum admits notify-outbox + the prior kinds (preservation)', async () => {
      for (const kind of ['full', 'trash-batch-sweep', 'space-policy', 'notify-outbox']) {
        await client.query({
          text: `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', $1, 'running')`,
          values: [kind],
        });
      }
      await expect(
        client.query(`INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'bogus-mode', 'running')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'notify-outbox'`);
    });
  });

  describe('0027 Trash candidate read-model (ADR-035 — snapshot + state tables)', () => {
    it('creates trash_candidates (kind CHECK + kind index) and trash_candidates_state', async () => {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'trash_candidates'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      for (const c of ['id', 'media_kind', 'collection_id', 'collection_title', 'delete_after_days', 'maintainerr_media_id', 'tmdb_id', 'tvdb_id', 'size_bytes', 'add_date', 'ord']) {
        expect(names).toContain(c);
      }
      const idx = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'trash_candidates'`,
      );
      expect(idx.rows.map((r) => r.indexname)).toContain('trash_candidates_kind_idx');
      const stateCols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'trash_candidates_state'`,
      );
      expect(stateCols.rows.map((r) => r.column_name as string).sort()).toEqual([
        'item_count',
        'media_kind',
        'refreshed_at',
        'total_size_bytes',
      ]);
    });

    it('both tables reject an unknown media_kind (movie|tv only — R-87)', async () => {
      await client.query(
        `INSERT INTO trash_candidates (media_kind, collection_id) VALUES ('movie', 1)`,
      );
      await expect(
        client.query(`INSERT INTO trash_candidates (media_kind, collection_id) VALUES ('music', 1)`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `INSERT INTO trash_candidates_state (media_kind, refreshed_at, item_count, total_size_bytes)
           VALUES ('music', now(), 0, 0)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM trash_candidates`);
    });
  });

  // DESIGN-015 amendment (migration 0030) — the final-warning push + honest sweep copy: two CHECK
  // relaxes that must admit the new values AND preserve every prior one.
  describe('0030 final-warning outbox (DESIGN-015 amendment — CHECK relaxes, preservation)', () => {
    it('notification_outbox event_type admits batch_final_warning + the prior events, rejects unknown', async () => {
      for (const evt of [
        'batch_created',
        'batch_leaving_soon',
        'batch_leaving_soon_reminder',
        'batch_final_warning',
        'batch_swept',
      ]) {
        await client.query({
          text: `INSERT INTO notification_outbox (event_type) VALUES ($1)`,
          values: [evt],
        });
      }
      await expect(
        client.query(`INSERT INTO notification_outbox (event_type) VALUES ('bogus_event')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM notification_outbox`);
    });

    it('app_settings_key_enum admits final_warning + the prior keys (preservation)', async () => {
      for (const key of ['motd', 'notify_window', 'pool_refresh_after_save', 'final_warning']) {
        await client.query({
          text: `INSERT INTO app_settings (key, value) VALUES ($1, '{}'::jsonb)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          values: [key],
        });
      }
      await expect(
        client.query(`INSERT INTO app_settings (key, value) VALUES ('nope_key', '{}'::jsonb)`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM app_settings WHERE key IN ('motd','notify_window','pool_refresh_after_save','final_warning')`,
      );
    });
  });

  // ADR-037 / DESIGN-016 (migration 0031) — the Metrics foundation: a new roles.metrics_level column +
  // three CHECK relaxes (permission_audit action, role_section_permissions section, app_settings key).
  describe('0031 metrics foundation (ADR-037 — column + CHECK relaxes, preservation)', () => {
    const DEFAULT_ROLE = '11111111-1111-4111-8111-111111111111';
    const ADMIN_ROLE = '22222222-2222-4222-8222-222222222222';

    it('roles.metrics_level exists, defaults limited, seeds admin to full, and is CHECK-enforced', async () => {
      const seed = await client.query(
        `SELECT metrics_level FROM roles WHERE id = '${ADMIN_ROLE}'`,
      );
      expect(seed.rows[0].metrics_level).toBe('full'); // migration seeds is_admin ⇒ full
      const def = await client.query(
        `SELECT metrics_level FROM roles WHERE id = '${DEFAULT_ROLE}'`,
      );
      expect(def.rows[0].metrics_level).toBe('limited'); // column default
      for (const level of ['full', 'limited']) {
        await client.query({
          text: `UPDATE roles SET metrics_level = $1 WHERE id = '${DEFAULT_ROLE}'`,
          values: [level],
        });
      }
      await expect(
        client.query(`UPDATE roles SET metrics_level = 'bogus' WHERE id = '${DEFAULT_ROLE}'`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`UPDATE roles SET metrics_level = 'limited' WHERE id = '${DEFAULT_ROLE}'`);
    });

    it('role_section_permissions_section_enum admits the new metrics section, rejects unknown', async () => {
      await client.query(
        `INSERT INTO role_section_permissions (role_id, section_id, level)
           VALUES ('${DEFAULT_ROLE}', 'metrics', 'read_only')
           ON CONFLICT (role_id, section_id) DO UPDATE SET level = EXCLUDED.level`,
      );
      await expect(
        client.query({
          text: `INSERT INTO role_section_permissions (role_id, section_id, level)
                   VALUES ('${DEFAULT_ROLE}', 'nope_section', 'read_only')`,
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM role_section_permissions WHERE role_id = '${DEFAULT_ROLE}' AND section_id = 'metrics'`,
      );
    });

    it('permission_audit_action_enum admits update_role_metrics_level + prior actions', async () => {
      for (const action of ['update_message_actions', 'update_role_metrics_level']) {
        await client.query({
          text: `INSERT INTO permission_audit (action) VALUES ($1)`,
          values: [action],
        });
      }
      await expect(
        client.query(`INSERT INTO permission_audit (action) VALUES ('bogus_action')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM permission_audit WHERE action IN ('update_message_actions','update_role_metrics_level')`,
      );
    });

    it('app_settings_key_enum admits the WAN capacity keys + the prior keys (preservation)', async () => {
      for (const key of ['final_warning', 'upload_capacity_mbps', 'download_capacity_mbps']) {
        await client.query({
          text: `INSERT INTO app_settings (key, value) VALUES ($1, '300'::jsonb)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          values: [key],
        });
      }
      await expect(
        client.query(`INSERT INTO app_settings (key, value) VALUES ('nope_key', '{}'::jsonb)`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM app_settings WHERE key IN ('final_warning','upload_capacity_mbps','download_capacity_mbps')`,
      );
    });
  });

  // ADR-038 / DESIGN-017 (migration 0032) — the ytdl-sub Library section: ONE CHECK relax admitting the
  // new 'ytdlsub' role_section_permissions section (visibility; ships Admin-only). No new column/table.
  describe('0032 ytdl-sub section (ADR-038 — role_section_permissions CHECK relax, preservation)', () => {
    const DEFAULT_ROLE = '11111111-1111-4111-8111-111111111111';

    it('role_section_permissions_section_enum admits the new ytdlsub section + prior sections, rejects unknown', async () => {
      for (const section of ['metrics', 'ytdlsub']) {
        await client.query(
          `INSERT INTO role_section_permissions (role_id, section_id, level)
             VALUES ('${DEFAULT_ROLE}', '${section}', 'read_only')
             ON CONFLICT (role_id, section_id) DO UPDATE SET level = EXCLUDED.level`,
        );
      }
      await expect(
        client.query({
          text: `INSERT INTO role_section_permissions (role_id, section_id, level)
                   VALUES ('${DEFAULT_ROLE}', 'nope_section', 'read_only')`,
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM role_section_permissions WHERE role_id = '${DEFAULT_ROLE}' AND section_id IN ('metrics','ytdlsub')`,
      );
    });
  });

  // ADR-044 / DESIGN-022 (migration 0035) — the AI usage mirror: a new ai_usage_chats table + ONE
  // sync_runs.run_kind CHECK relax admitting 'ai-usage-sync'. Additive; no existing table altered.
  describe('0035 AI usage chats (ADR-044 — new table + run_kind CHECK relax, preservation)', () => {
    it('creates ai_usage_chats with the identity + aggregate columns and both indexes', async () => {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'ai_usage_chats'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      for (const expected of [
        'owui_chat_id',
        'owui_user_id',
        'user_name',
        'title',
        'models',
        'image_count',
        'total_duration_ms',
        'chat_created_at',
      ]) {
        expect(names).toContain(expected);
      }
      const idx = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'ai_usage_chats'`,
      );
      const idxNames = idx.rows.map((r) => r.indexname as string);
      expect(idxNames).toContain('ai_usage_chats_created_idx');
      expect(idxNames).toContain('ai_usage_chats_user_idx');
    });

    it('upserts a row by owui_chat_id (models jsonb round-trips)', async () => {
      await client.query(
        `INSERT INTO ai_usage_chats
           (owui_chat_id, owui_user_id, models, image_count, total_duration_ms, chat_created_at, chat_updated_at)
         VALUES ('c1', 'u1', '["gpt-oss:latest"]'::jsonb, 2, 1500, now(), now())
         ON CONFLICT (owui_chat_id) DO UPDATE SET image_count = EXCLUDED.image_count`,
      );
      const row = await client.query(`SELECT models, image_count FROM ai_usage_chats WHERE owui_chat_id = 'c1'`);
      expect(row.rows[0].image_count).toBe(2);
      expect(row.rows[0].models).toEqual(['gpt-oss:latest']);
      await client.query(`DELETE FROM ai_usage_chats WHERE owui_chat_id = 'c1'`);
    });

    it('sync_runs_run_kind_enum admits ai-usage-sync + the prior kinds (preservation)', async () => {
      for (const kind of ['smart-alerts', 'poster-guard', 'ai-usage-sync']) {
        await client.query({
          text: `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', $1, 'running')`,
          values: [kind],
        });
      }
      await expect(
        client.query(`INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'bogus-mode', 'running')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'ai-usage-sync'`);
    });
  });
});
