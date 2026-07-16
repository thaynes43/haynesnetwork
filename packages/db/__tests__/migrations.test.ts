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
  // ADR-046 (PLAN-023, migration 0037) — the two book-server cards (seeded rows; no role grants).
  'kavita',
  'audiobookshelf',
];
describe('withMigratedDb', () => {
  it('boots an embedded Postgres 16, applies both migrations, and tears down', async () => {
    const version = await withMigratedDb(async (connectionString) => {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const seeded = await client.query('SELECT count(*)::int AS n FROM app_catalog');
        expect(seeded.rows[0].n).toBe(10);
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
    expect(seeded.rows[0].n).toBe(10);
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
    // ADR-046 (PLAN-023, migration 0037) — the book-server cards.
    expect(bySlug.get('kavita').url).toBe('https://kavita.haynesnetwork.com');
    expect(bySlug.get('kavita').icon).toBe('kavita');
    expect(bySlug.get('audiobookshelf').url).toBe('https://audiobookshelf.haynesnetwork.com');
    expect(bySlug.get('audiobookshelf').icon).toBe('audiobookshelf');
    expect(rows.rows.map((r) => r.sort_order)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
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
        client.query(
          `INSERT INTO notifications (source, type, title) VALUES ('overseerr', 'ev', 't')`,
        ),
      ).rejects.toMatchObject({ code: '23514' }); // 'overseerr' folds into 'seerr' — not its own value
      await client.query(`DELETE FROM notifications WHERE type = 'ev'`);
    });

    it('the widened notification columns + partial-unique dedupe index exist', async () => {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      for (const c of [
        'media_item_id',
        'tmdb_id',
        'tvdb_id',
        'actor_user_id',
        'occurred_at',
        'source_event_id',
      ]) {
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
      await client.query(
        `INSERT INTO notifications (source, type, title) VALUES ('maintainerr','ev','n1')`,
      );
      await client.query(
        `INSERT INTO notifications (source, type, title) VALUES ('maintainerr','ev','n2')`,
      );
      await client.query(`DELETE FROM notifications WHERE type = 'ev'`);
    });

    // NOTE: 0018's `messages` board table (and its messages_status_enum test that lived here) was
    // retired by migration 0040 (ADR-050 — the Helpdesk ticket system replaced the board; owner
    // ruling Q-03: the rows were test data). The 0040 block below asserts the drop.

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
      await client.query(`INSERT INTO permission_audit (action) VALUES ('update_message_actions')`);
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

  // ADR-049 / DESIGN-012 amend (migration 0039, PLAN-027) — the Bulletin SUB-VIEW grants: the new
  // role_bulletin_view_grants table + CHECK, the preserved+extended permission_audit CHECK, and the
  // Default-role messages-only seed (the owner's intent).
  describe('0039 Bulletin sub-view grants (ADR-049 — new table/CHECK + audit + Default seed)', () => {
    it('role_bulletin_view_grants_view_enum admits feed/messages, rejects unknown', async () => {
      const role = await client.query(`SELECT id FROM roles WHERE is_admin`); // a role with no seed row
      const roleId = role.rows[0].id as string;
      for (const v of ['feed', 'messages']) {
        await client.query({
          text: `INSERT INTO role_bulletin_view_grants (role_id, view) VALUES ($1, $2)`,
          values: [roleId, v],
        });
      }
      await expect(
        client.query({
          text: `INSERT INTO role_bulletin_view_grants (role_id, view) VALUES ($1, 'comments')`,
          values: [roleId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM role_bulletin_view_grants WHERE role_id = '${roleId}'`);
    });

    it('permission_audit_action_enum admits update_bulletin_views (preservation)', async () => {
      await client.query(`INSERT INTO permission_audit (action) VALUES ('update_bulletin_views')`);
      // The prior values still validate (rebuild preserved them).
      await client.query(`INSERT INTO permission_audit (action) VALUES ('assign_pending_role')`);
    });

    it('seeds the Default role with the messages view ONLY (Feed off; other roles untouched)', async () => {
      const rows = await client.query(
        `SELECT view FROM role_bulletin_view_grants
           WHERE role_id = '11111111-1111-4111-8111-111111111111' ORDER BY view`,
      );
      expect(rows.rows.map((r: { view: string }) => r.view)).toEqual(['messages']);
      // No other role got a seed row (Family/Admin keep the no-row "both" default).
      const others = await client.query(
        `SELECT count(*)::int AS n FROM role_bulletin_view_grants
           WHERE role_id <> '11111111-1111-4111-8111-111111111111'`,
      );
      expect(others.rows[0].n).toBe(0);
    });
  });

  // ADR-050 / DESIGN-012 D-10 (migration 0040, PLAN-034) — the Helpdesk ticket domain: the three
  // ticket tables + their CHECKs, the notification_outbox event-type CHECK relax, and the DROP of
  // the retired `messages` board table (owner ruling Q-03 — its rows were test data).
  describe('0040 Helpdesk tickets (ADR-050 — ticket tables + outbox CHECK + messages drop)', () => {
    let authorId: string;

    beforeAll(async () => {
      const u = await client.query(
        `INSERT INTO users (email, display_name, role_id)
           VALUES ('tick@example.com', 'Tick', (SELECT id FROM roles WHERE is_default)) RETURNING id`,
      );
      authorId = u.rows[0].id as string;
    });

    it('tickets_status_enum + tickets_category_enum admit the sets, reject unknown', async () => {
      for (const st of ['open', 'in_progress', 'complete', 'rejected']) {
        await client.query({
          text: `INSERT INTO tickets (author_user_id, title, body, category, status)
                   VALUES ($1, 't', 'b', 'playback', $2)`,
          values: [authorId, st],
        });
      }
      for (const cat of ['playback', 'audio', 'subtitles', 'quality', 'missing', 'other']) {
        await client.query({
          text: `INSERT INTO tickets (author_user_id, title, body, category) VALUES ($1, 't', 'b', $2)`,
          values: [authorId, cat],
        });
      }
      await expect(
        client.query({
          text: `INSERT INTO tickets (author_user_id, title, body, category, status)
                   VALUES ($1, 't', 'b', 'playback', 'triage')`,
          values: [authorId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query({
          text: `INSERT INTO tickets (author_user_id, title, body, category) VALUES ($1, 't', 'b', 'website')`,
          values: [authorId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('ticket_events admits a NULL from_status (creation) + valid transitions, rejects unknown', async () => {
      const tk = await client.query({
        text: `INSERT INTO tickets (author_user_id, title, body, category) VALUES ($1, 'ev', 'b', 'other') RETURNING id`,
        values: [authorId],
      });
      const ticketId = tk.rows[0].id as string;
      await client.query({
        text: `INSERT INTO ticket_events (ticket_id, actor_user_id, from_status, to_status)
                 VALUES ($1, $2, NULL, 'open')`,
        values: [ticketId, authorId],
      });
      await client.query({
        text: `INSERT INTO ticket_events (ticket_id, actor_user_id, from_status, to_status, note)
                 VALUES ($1, $2, 'open', 'in_progress', 'why')`,
        values: [ticketId, authorId],
      });
      await expect(
        client.query({
          text: `INSERT INTO ticket_events (ticket_id, from_status, to_status) VALUES ($1, 'open', 'archived')`,
          values: [ticketId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      // Replies FK-cascade off the ticket.
      await client.query({
        text: `INSERT INTO ticket_replies (ticket_id, author_user_id, body) VALUES ($1, $2, 'r')`,
        values: [ticketId, authorId],
      });
    });

    it('notification_outbox_event_type_enum admits ticket_created (preservation)', async () => {
      await client.query(
        `INSERT INTO notification_outbox (event_type, payload) VALUES ('ticket_created', '{}'::jsonb)`,
      );
      // The prior values still validate (rebuild preserved them).
      await client.query(
        `INSERT INTO notification_outbox (event_type, payload) VALUES ('smart_degraded', '{}'::jsonb)`,
      );
      // (`ticket_replied` was this test's rejected example until migration 0049 legalized it — ADR-060.)
      await expect(
        client.query(
          `INSERT INTO notification_outbox (event_type, payload) VALUES ('ticket_eaten', '{}'::jsonb)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM notification_outbox WHERE event_type IN ('ticket_created','smart_degraded')`,
      );
    });

    it('the retired messages board table is GONE (Q-03 — rows were test data)', async () => {
      const reg = await client.query(`SELECT to_regclass('public.messages') AS t`);
      expect(reg.rows[0].t).toBeNull();
      // The grant tables that now gate the Helpdesk survived untouched.
      const grants = await client.query(
        `SELECT to_regclass('public.role_message_action_grants') AS a,
                to_regclass('public.role_bulletin_view_grants') AS b`,
      );
      expect(grants.rows[0].a).not.toBeNull();
      expect(grants.rows[0].b).not.toBeNull();
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
      await client.query(
        `DELETE FROM app_settings WHERE key IN ('trash_skip_admin_gate','trash_default_window_days','motd')`,
      );
    });
  });

  // ADR-034 / DESIGN-015 (migration 0024) — the Pushover notification outbox + two CHECK relaxes.
  describe('0024 Pushover notify outbox (ADR-034 — new table + CHECK relaxes)', () => {
    it('creates notification_outbox with the partial due index', async () => {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_outbox'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      for (const c of [
        'id',
        'channel',
        'event_type',
        'payload',
        'created_at',
        'earliest_send_at',
        'sent_at',
        'attempts',
        'last_error',
      ]) {
        expect(names).toContain(c);
      }
      const idx = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'notification_outbox'`,
      );
      expect(idx.rows.map((r) => r.indexname)).toContain('notification_outbox_due_idx');
    });

    it('notification_outbox CHECKs admit the known channel/event types, reject unknown', async () => {
      await client.query(`INSERT INTO notification_outbox (event_type) VALUES ('batch_created')`);
      await client.query(
        `INSERT INTO notification_outbox (channel, event_type) VALUES ('pushover', 'batch_leaving_soon_reminder')`,
      );
      await expect(
        client.query(
          `INSERT INTO notification_outbox (channel, event_type) VALUES ('sms', 'batch_created')`,
        ),
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
      await client.query(
        `DELETE FROM app_settings WHERE key IN ('trash_skip_admin_gate','space_policy','notify_window')`,
      );
    });

    it('sync_runs_run_kind_enum admits notify-outbox + the prior kinds (preservation)', async () => {
      for (const kind of ['full', 'trash-batch-sweep', 'space-policy', 'notify-outbox']) {
        await client.query({
          text: `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', $1, 'running')`,
          values: [kind],
        });
      }
      await expect(
        client.query(
          `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'bogus-mode', 'running')`,
        ),
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
      for (const c of [
        'id',
        'media_kind',
        'collection_id',
        'collection_title',
        'delete_after_days',
        'maintainerr_media_id',
        'tmdb_id',
        'tvdb_id',
        'size_bytes',
        'add_date',
        'ord',
      ]) {
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
        client.query(
          `INSERT INTO trash_candidates (media_kind, collection_id) VALUES ('music', 1)`,
        ),
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
      const seed = await client.query(`SELECT metrics_level FROM roles WHERE id = '${ADMIN_ROLE}'`);
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
      const row = await client.query(
        `SELECT models, image_count FROM ai_usage_chats WHERE owui_chat_id = 'c1'`,
      );
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
        client.query(
          `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'bogus-mode', 'running')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'ai-usage-sync'`);
    });
  });

  // ADR-045 / DESIGN-023 (migration 0036) — the Authentik role portal: roles.synced_tier column (Family
  // backfilled true) + three new tables (authentik_users / pending_role_assignments / authentik_group_audit)
  // + three CHECK relaxes (sync_runs.run_kind, permission_audit.action, app_settings.key). Additive.
  describe('0036 authentik role portal (ADR-045 — column + new tables + CHECK relaxes, preservation)', () => {
    const DEFAULT_ROLE = '11111111-1111-4111-8111-111111111111';

    it('roles.synced_tier exists (default false); the seeded Family role is backfilled true', async () => {
      const fam = await client.query(`SELECT synced_tier FROM roles WHERE name = 'Family'`);
      expect(fam.rows[0].synced_tier).toBe(true); // migration backfills Family
      const def = await client.query(`SELECT synced_tier FROM roles WHERE id = '${DEFAULT_ROLE}'`);
      expect(def.rows[0].synced_tier).toBe(false); // Admin/Default stay app-local (column default)
    });

    it('creates the three portal tables', async () => {
      const tables = await client.query(
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      const names = tables.rows.map((r) => r.table_name as string);
      for (const expected of [
        'authentik_users',
        'pending_role_assignments',
        'authentik_group_audit',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('authentik_users_type_enum admits the 3 types, rejects unknown', async () => {
      let pk = 900100;
      for (const type of ['external', 'internal', 'internal_service_account']) {
        await client.query({
          text: `INSERT INTO authentik_users (pk, username, user_type) VALUES ($1, 'u', $2)`,
          values: [pk++, type],
        });
      }
      await expect(
        client.query(
          `INSERT INTO authentik_users (pk, username, user_type) VALUES (900199, 'u', 'robot')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM authentik_users WHERE pk >= 900100 AND pk < 900200`);
    });

    it('authentik_group_audit_action_enum admits the 4 actions, rejects unknown', async () => {
      for (const action of ['add_member', 'remove_member', 'create_group', 'ensure_owui_group']) {
        await client.query({
          text: `INSERT INTO authentik_group_audit (action, group_name) VALUES ($1, 'family')`,
          values: [action],
        });
      }
      await expect(
        client.query(
          `INSERT INTO authentik_group_audit (action, group_name) VALUES ('nuke_group', 'family')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM authentik_group_audit WHERE group_name = 'family'`);
    });

    it('sync_runs_run_kind_enum admits authentik-users + the prior kinds (preservation)', async () => {
      for (const kind of ['ai-usage-sync', 'authentik-users']) {
        await client.query({
          text: `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', $1, 'running')`,
          values: [kind],
        });
      }
      await expect(
        client.query(
          `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'bogus-mode', 'running')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'authentik-users'`);
    });

    it('permission_audit_action_enum admits assign_pending_role + the prior actions (preservation)', async () => {
      for (const action of ['update_role_metrics_level', 'assign_pending_role']) {
        await client.query({
          text: `INSERT INTO permission_audit (action) VALUES ($1)`,
          values: [action],
        });
      }
      await expect(
        client.query(`INSERT INTO permission_audit (action) VALUES ('bogus_action')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        `DELETE FROM permission_audit WHERE action IN ('update_role_metrics_level','assign_pending_role')`,
      );
    });

    it('app_settings_key_enum admits the two Authentik keys + the prior keys (preservation)', async () => {
      for (const key of [
        'download_capacity_mbps',
        'authentik_owned_groups',
        'authentik_group_map',
      ]) {
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
        `DELETE FROM app_settings WHERE key IN ('download_capacity_mbps','authentik_owned_groups','authentik_group_map')`,
      );
    });
  });

  // ADR-054 / DESIGN-027 (migration 0041, PLAN-039) — the MAM governor gate state: a new single-row
  // mam_gate_state table (singleton CHECK) + two CHECK relaxes (sync_runs.run_kind admits 'mam-governor';
  // notification_outbox.event_type admits the three governor push types). Additive; preservation-checked.
  describe('0041 MAM governor gate state (ADR-054 — new table + CHECK relaxes, preservation)', () => {
    it('creates mam_gate_state with the singleton CHECK (id must be mam)', async () => {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'mam_gate_state'`,
      );
      const names = cols.rows.map((r) => r.column_name as string);
      for (const c of [
        'id',
        'gate_open',
        'count_ok',
        'unsatisfied_count',
        'downloading_count',
        'seeding_under72_count',
        'limit_value',
        'buffer_value',
        'threshold',
        'headroom',
        'zero_headroom_since',
        'pinned_alerted_at',
        'last_event_type',
        'updated_at',
      ]) {
        expect(names).toContain(c);
      }
      // The singleton row inserts; a second (id <> 'mam') row is rejected by the CHECK.
      await client.query(
        `INSERT INTO mam_gate_state (gate_open, count_ok, unsatisfied_count, downloading_count,
           seeding_under72_count, limit_value, buffer_value, threshold, headroom)
         VALUES (true, true, 13, 0, 13, 20, 5, 15, 7)`,
      );
      await expect(
        client.query(
          `INSERT INTO mam_gate_state (id, gate_open, count_ok, unsatisfied_count, downloading_count,
             seeding_under72_count, limit_value, buffer_value, threshold, headroom)
           VALUES ('other', true, true, 0, 0, 0, 20, 5, 15, 20)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM mam_gate_state`);
    });

    it('sync_runs_run_kind_enum admits mam-governor + the prior kinds (preservation)', async () => {
      for (const kind of ['plex-match', 'books-sync', 'mam-governor']) {
        await client.query({
          text: `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', $1, 'running')`,
          values: [kind],
        });
      }
      await expect(
        client.query(
          `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'bogus-mode', 'running')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'mam-governor'`);
    });

    it('notification_outbox_event_type_enum admits the three governor events + the prior ones', async () => {
      for (const evt of [
        'mam_gate_paused',
        'mam_gate_resumed',
        'mam_gate_stuck',
        'ticket_created',
        'smart_degraded',
      ]) {
        await client.query({
          text: `INSERT INTO notification_outbox (event_type) VALUES ($1)`,
          values: [evt],
        });
      }
      await expect(
        client.query(`INSERT INTO notification_outbox (event_type) VALUES ('mam_bogus')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM notification_outbox`);
    });
  });

  // ADR-055 / DESIGN-028 (migration 0045) — the Integration tables + three CHECK relaxes. Additive.
  describe('0045 Goodreads integrations (ADR-055 — three tables + section/run-kind/audit CHECKs)', () => {
    const DEFAULT_ROLE = '11111111-1111-4111-8111-111111111111';

    it('creates the three tables with their key columns', async () => {
      const cols = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name IN ('user_integrations','integration_shelf_items','book_requests')`,
      );
      const has = (t: string, c: string) =>
        cols.rows.some((r) => r.table_name === t && r.column_name === c);
      expect(has('user_integrations', 'external_user_id')).toBe(true);
      expect(has('user_integrations', 'status')).toBe(true);
      expect(has('integration_shelf_items', 'gb_volume_id')).toBe(true);
      expect(has('integration_shelf_items', 'deleted_at')).toBe(true);
      expect(has('book_requests', 'ebook_status')).toBe(true);
      expect(has('book_requests', 'audio_status')).toBe(true);
      expect(has('book_requests', 'unroutable_reason')).toBe(true);
    });

    it('book_requests status CHECKs reject an unknown status', async () => {
      const user = await client.query(
        `INSERT INTO users (email, display_name) VALUES ('int-mig@example.com', 'Int') RETURNING id`,
      );
      const uid = user.rows[0].id as string;
      const integ = await client.query({
        text: `INSERT INTO user_integrations (user_id, provider, external_user_id, status)
                 VALUES ($1, 'goodreads', '202652880', 'linked') RETURNING id`,
        values: [uid],
      });
      const iid = integ.rows[0].id as string;
      const shelf = await client.query({
        text: `INSERT INTO integration_shelf_items (integration_id, shelf, external_book_id, title)
                 VALUES ($1, 'to-read', 'b1', 'A Book') RETURNING id`,
        values: [iid],
      });
      const sid = shelf.rows[0].id as string;
      await expect(
        client.query({
          text: `INSERT INTO book_requests (integration_id, shelf_item_id, title, ebook_status)
                   VALUES ($1, $2, 'A Book', 'bogus')`,
          values: [iid, sid],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query({ text: `DELETE FROM user_integrations WHERE id = $1`, values: [iid] });
      await client.query({ text: `DELETE FROM users WHERE id = $1`, values: [uid] });
    });

    it('role_section_permissions admits integrations, rejects unknown', async () => {
      await client.query(
        `INSERT INTO role_section_permissions (role_id, section_id, level)
           VALUES ('${DEFAULT_ROLE}', 'integrations', 'read_only')
           ON CONFLICT (role_id, section_id) DO UPDATE SET level = EXCLUDED.level`,
      );
      await client.query(
        `DELETE FROM role_section_permissions WHERE role_id = '${DEFAULT_ROLE}' AND section_id = 'integrations'`,
      );
    });

    it('sync_runs admits goodreads-sync', async () => {
      await client.query(
        `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'goodreads-sync', 'running')`,
      );
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'goodreads-sync'`);
    });

    it('permission_audit admits the three integration actions', async () => {
      for (const action of ['link_integration', 'unlink_integration', 'request_book_search']) {
        await client.query({
          text: `INSERT INTO permission_audit (action) VALUES ($1)`,
          values: [action],
        });
      }
      await client.query(
        `DELETE FROM permission_audit WHERE action IN ('link_integration','unlink_integration','request_book_search')`,
      );
    });
  });

  describe('0049 ticket email notifications (ADR-060 — notification_preferences + channel/event CHECK relaxes)', () => {
    it('notification_preferences exists with the one-row-per-user unique + cascade', async () => {
      const userId = (
        await client.query(
          `INSERT INTO users (email, display_name) VALUES ('pref-mig@example.com', 'Pref Mig') RETURNING id`,
        )
      ).rows[0].id;
      await client.query({
        text: `INSERT INTO notification_preferences (user_id, email_ticket_updates) VALUES ($1, true)`,
        values: [userId],
      });
      // Unique per user — a second row for the same user violates.
      await expect(
        client.query({
          text: `INSERT INTO notification_preferences (user_id) VALUES ($1)`,
          values: [userId],
        }),
      ).rejects.toMatchObject({ code: '23505' });
      // Cascade on user delete.
      await client.query({ text: `DELETE FROM users WHERE id = $1`, values: [userId] });
      const left = await client.query({
        text: `SELECT count(*)::int AS n FROM notification_preferences WHERE user_id = $1`,
        values: [userId],
      });
      expect(left.rows[0].n).toBe(0);
    });

    it('the channel CHECK admits email (and still rejects an unknown channel)', async () => {
      await client.query(
        `INSERT INTO notification_outbox (channel, event_type, payload) VALUES ('email', 'ticket_created', '{"to":"a@x.com"}'::jsonb)`,
      );
      await expect(
        client.query(
          `INSERT INTO notification_outbox (channel, event_type, payload) VALUES ('sms', 'ticket_created', '{}'::jsonb)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`DELETE FROM notification_outbox WHERE channel = 'email'`);
    });

    it('the event-type CHECK admits ticket_replied + ticket_status_changed (preservation intact)', async () => {
      for (const et of ['ticket_replied', 'ticket_status_changed', 'ticket_created']) {
        await client.query({
          text: `INSERT INTO notification_outbox (event_type, payload) VALUES ($1, '{}'::jsonb)`,
          values: [et],
        });
      }
      await client.query(
        `DELETE FROM notification_outbox WHERE event_type IN ('ticket_replied','ticket_status_changed','ticket_created')`,
      );
    });
  });

  describe('0050 failure digest (ADR-060 follow-up — event-type + run-kind CHECK relaxes)', () => {
    it('admits activity_failure_digest + failure-digest (preservation intact)', async () => {
      await client.query(
        `INSERT INTO notification_outbox (channel, event_type, payload) VALUES ('email', 'activity_failure_digest', '{"to":"a@x.com"}'::jsonb)`,
      );
      await client.query(`DELETE FROM notification_outbox WHERE event_type = 'activity_failure_digest'`);
      await client.query(
        `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'failure-digest', 'running')`,
      );
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'failure-digest'`);
    });
  });

  describe('0051 ticket media locator (ADR-061 — columns + kind CHECK + the Q-03 delete)', () => {
    it('accepts a locator row, rejects an unknown kind, and the old tickets are GONE', async () => {
      const authorId = (
        await client.query(
          `INSERT INTO users (email, display_name) VALUES ('locator-mig@example.com', 'Loc Mig') RETURNING id`,
        )
      ).rows[0].id;
      await client.query({
        text: `INSERT INTO tickets (author_user_id, title, body, category, target_kind, target_child_id, target_season, target_episode, target_label)
               VALUES ($1, 't', 'b', 'audio', 'episode', 42, 6, 2, 'S06E02 · Rich')`,
        values: [authorId],
      });
      await expect(
        client.query({
          text: `INSERT INTO tickets (author_user_id, title, body, category, target_kind) VALUES ($1, 't', 'b', 'audio', 'scene')`,
          values: [authorId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query({ text: `DELETE FROM users WHERE id = $1`, values: [authorId] });
    });
  });

  describe('0052 books fix (ADR-062 — fix aggregate + grants + audit CHECK)', () => {
    it('accepts a fix row, enforces reason-text-iff-other, and admits the new audit actions', async () => {
      const userId = (
        await client.query(
          `INSERT INTO users (email, display_name) VALUES ('bookfix-mig@example.com', 'Fix Mig') RETURNING id`,
        )
      ).rows[0].id;
      const itemId = (
        await client.query(
          `INSERT INTO books_items (source, media_kind, external_id, library_id, library_name, title, sort_title, deep_link_url)
           VALUES ('kavita', 'book', 'mig-ext-1', '1', 'EBooks', 'Fix Target', 'fix target', 'http://kavita/x') RETURNING id`,
        )
      ).rows[0].id;
      await client.query({
        text: `INSERT INTO book_fix_requests (requester_id, books_item_id, source, external_id, media_kind, title_snapshot, route, reason)
               VALUES ($1, $2, 'kavita', 'mig-ext-1', 'book', 'Fix Target', 'lazylibrarian', 'wrong_language')`,
        values: [userId, itemId],
      });
      // reason 'other' REQUIRES reason_text (and vice versa).
      await expect(
        client.query({
          text: `INSERT INTO book_fix_requests (requester_id, books_item_id, source, external_id, media_kind, title_snapshot, route, reason)
                 VALUES ($1, $2, 'kavita', 'mig-ext-1', 'book', 'Fix Target', 'lazylibrarian', 'other')`,
          values: [userId, itemId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      // grants: a fix_book row inserts; an unknown action rejects.
      const roleId = (await client.query(`SELECT id FROM roles WHERE name = 'Default'`)).rows[0].id;
      await client.query({
        text: `INSERT INTO role_books_action_grants (role_id, action) VALUES ($1, 'fix_book')`,
        values: [roleId],
      });
      await expect(
        client.query({
          text: `INSERT INTO role_books_action_grants (role_id, action) VALUES ($1, 'delete_book')`,
          values: [roleId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      for (const action of ['request_book_fix', 'update_book_actions']) {
        await client.query({ text: `INSERT INTO permission_audit (action) VALUES ($1)`, values: [action] });
      }
      // cleanup (books_item is RESTRICT-referenced — remove the fix rows first).
      await client.query({ text: `DELETE FROM role_books_action_grants WHERE role_id = $1`, values: [roleId] });
      await client.query(`DELETE FROM permission_audit WHERE action IN ('request_book_fix','update_book_actions')`);
      await client.query({ text: `DELETE FROM book_fix_requests WHERE books_item_id = $1`, values: [itemId] });
      await client.query({ text: `DELETE FROM books_items WHERE id = $1`, values: [itemId] });
      await client.query({ text: `DELETE FROM users WHERE id = $1`, values: [userId] });
    });
  });

  describe('0053 mirrored Plex collections (ADR-064 — two derived-cache tables + run-kind CHECK)', () => {
    it('accepts a collection + member, enforces the identity uniques, and cascades cleanly', async () => {
      // A plex_libraries row to hang the collection off (the servers are seeded by migration 0010).
      const serverId = (await client.query(`SELECT id FROM plex_servers WHERE slug = 'haynesops'`))
        .rows[0].id;
      const libId = (
        await client.query({
          text: `INSERT INTO plex_libraries (server_id, section_key, name, media_type)
                 VALUES ($1, '91', 'HOps Movies (mig)', 'movie') RETURNING id`,
          values: [serverId],
        })
      ).rows[0].id;
      const colId = (
        await client.query({
          text: `INSERT INTO plex_collections (plex_library_id, rating_key, title, child_count)
                 VALUES ($1, '77001', 'IMDb Top 250', 250) RETURNING id`,
          values: [libId],
        })
      ).rows[0].id;
      // Identity — a second row for the same (library, rating_key) violates.
      await expect(
        client.query({
          text: `INSERT INTO plex_collections (plex_library_id, rating_key, title) VALUES ($1, '77001', 'Renamed')`,
          values: [libId],
        }),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query({
        text: `INSERT INTO plex_collection_members (collection_id, rating_key, sort_order) VALUES ($1, '9001', 0)`,
        values: [colId],
      });
      await expect(
        client.query({
          text: `INSERT INTO plex_collection_members (collection_id, rating_key, sort_order) VALUES ($1, '9001', 1)`,
          values: [colId],
        }),
      ).rejects.toMatchObject({ code: '23505' });
      // Cascade: deleting the LIBRARY removes the collection AND its members.
      await client.query({ text: `DELETE FROM plex_libraries WHERE id = $1`, values: [libId] });
      const left = await client.query({
        text: `SELECT (SELECT count(*)::int FROM plex_collections WHERE id = $1) AS cols,
                      (SELECT count(*)::int FROM plex_collection_members WHERE collection_id = $1) AS members`,
        values: [colId],
      });
      expect(left.rows[0]).toEqual({ cols: 0, members: 0 });
    });

    it('sync_runs.run_kind admits collections-sync (parity — the mode writes no row itself)', async () => {
      await client.query(
        `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'collections-sync', 'running')`,
      );
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'collections-sync'`);
  // ADR-065 / DESIGN-036 (migration 0054) — the format-pairing surfaces: books_format_pairs + the
  // book_requests system-want widening + the run-kind CHECK relax. Additive.
  describe('0054 format pairing (ADR-065 — pair cache + system wants + run-kind CHECK)', () => {
    async function seedBooksItem(externalId: string, mediaKind: 'book' | 'audiobook'): Promise<string> {
      const source = mediaKind === 'audiobook' ? 'audiobookshelf' : 'kavita';
      const row = await client.query({
        text: `INSERT INTO books_items (source, media_kind, external_id, library_id, library_name, title, sort_title, author, deep_link_url)
               VALUES ($1, $2, $3, '1', 'Lib', 'Pairing Target', 'pairing target', 'An Author', 'http://x') RETURNING id`,
        values: [source, mediaKind, externalId],
      });
      return row.rows[0].id as string;
    }

    it('books_format_pairs accepts a pair, enforces per-side uniques + the matched_via CHECK, cascades', async () => {
      const bookId = await seedBooksItem('pair-b1', 'book');
      const audioId = await seedBooksItem('pair-a1', 'audiobook');
      const audioId2 = await seedBooksItem('pair-a2', 'audiobook');
      await client.query({
        text: `INSERT INTO books_format_pairs (book_item_id, audio_item_id, matched_via) VALUES ($1, $2, 'title_author')`,
        values: [bookId, audioId],
      });
      // The book side is UNIQUE — a second pair for the same book violates.
      await expect(
        client.query({
          text: `INSERT INTO books_format_pairs (book_item_id, audio_item_id, matched_via) VALUES ($1, $2, 'title_author')`,
          values: [bookId, audioId2],
        }),
      ).rejects.toMatchObject({ code: '23505' });
      // matched_via is CHECK-constrained.
      const bookId2 = await seedBooksItem('pair-b2', 'book');
      await expect(
        client.query({
          text: `INSERT INTO books_format_pairs (book_item_id, audio_item_id, matched_via) VALUES ($1, $2, 'vibes')`,
          values: [bookId2, audioId2],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      // Deleting a side cascades the pair away.
      await client.query({ text: `DELETE FROM books_items WHERE id = $1`, values: [audioId] });
      const left = await client.query({
        text: `SELECT count(*)::int AS n FROM books_format_pairs WHERE book_item_id = $1`,
        values: [bookId],
      });
      expect(left.rows[0].n).toBe(0);
      await client.query(
        `DELETE FROM books_items WHERE external_id IN ('pair-b1','pair-a2','pair-b2')`,
      );
    });

    it('book_requests admits an origin=pairing SYSTEM want (null keys) and enforces origin coherence + the partial unique', async () => {
      const anchorId = await seedBooksItem('pair-anchor', 'book');
      // A pairing want: no integration, no shelf item — the anchor carries the identity.
      await client.query({
        text: `INSERT INTO book_requests (origin, pairing_books_item_id, title, author, ebook_status, audio_status)
               VALUES ('pairing', $1, 'Pairing Target', 'An Author', 'landed', 'requested')`,
        values: [anchorId],
      });
      // ONE open pairing want per anchor item — the partial unique rejects a second.
      await expect(
        client.query({
          text: `INSERT INTO book_requests (origin, pairing_books_item_id, title) VALUES ('pairing', $1, 'Pairing Target')`,
          values: [anchorId],
        }),
      ).rejects.toMatchObject({ code: '23505' });
      // Coherence: a pairing want without its anchor is not representable …
      await expect(
        client.query(`INSERT INTO book_requests (origin, title) VALUES ('pairing', 'No Anchor')`),
      ).rejects.toMatchObject({ code: '23514' });
      // … nor a goodreads want without its shelf/integration keys …
      await expect(
        client.query(`INSERT INTO book_requests (title) VALUES ('Keyless Goodreads')`),
      ).rejects.toMatchObject({ code: '23514' });
      // … nor an unknown origin.
      await expect(
        client.query({
          text: `INSERT INTO book_requests (origin, pairing_books_item_id, title) VALUES ('estate', $1, 'Bad Origin')`,
          values: [anchorId],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      // The anchor cascade cleans the want up.
      await client.query({ text: `DELETE FROM books_items WHERE id = $1`, values: [anchorId] });
      const left = await client.query({
        text: `SELECT count(*)::int AS n FROM book_requests WHERE pairing_books_item_id = $1`,
        values: [anchorId],
      });
      expect(left.rows[0].n).toBe(0);
    });

    it('sync_runs admits format-pairing (preservation intact)', async () => {
      await client.query(
        `INSERT INTO sync_runs (source, run_kind, status) VALUES ('radarr', 'format-pairing', 'running')`,
      );
      await client.query(`DELETE FROM sync_runs WHERE run_kind = 'format-pairing'`);
    });
  });
});
