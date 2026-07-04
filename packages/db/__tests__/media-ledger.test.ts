import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@hnet/test-utils';
import { runMigrations } from '../src/migrate';

// NOTE: this file exercises schema-level invariants of migration 0003 (CHECK
// constraints, the dedupe unique index, the wanted_items view) with direct SQL on
// purpose — it is on the ALLOWED_FILES list of the no-direct-state-writes guard
// (packages/domain/__tests__), same as migrations.test.ts. App code goes through
// the @hnet/domain single-writers (DESIGN-005 D-12).

describe('0003_media_ledger against embedded Postgres 16', () => {
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

  /** Insert a minimal valid media_items row; returns its uuid. */
  async function insertItem(overrides: Record<string, unknown> = {}): Promise<string> {
    const row: Record<string, unknown> = {
      arr_kind: 'radarr',
      arr_item_id: Math.floor(Math.random() * 1_000_000_000),
      tmdb_id: 550,
      title: 'Fight Club',
      sort_title: 'fight club',
      monitored: true,
      quality_profile_id: 1,
      quality_profile_name: 'Any',
      root_folder: '/data/haynestower/Media/Movies',
      ...overrides,
    };
    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const res = await client.query({
      text: `INSERT INTO media_items (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING id`,
      values: cols.map((c) => row[c]),
    });
    return res.rows[0].id as string;
  }

  it('applies cleanly on top of 0001+0002: all D-05..D-11 tables + the wanted_items view exist', async () => {
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = tables.rows.map((r) => r.table_name as string);
    for (const expected of [
      'media_items',
      'ledger_events',
      'fix_requests',
      'restore_runs',
      'sync_runs',
      'sync_state',
      'users', // 0001 still intact
      'app_catalog',
    ]) {
      expect(names).toContain(expected);
    }
    const views = await client.query(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`,
    );
    const viewNames = views.rows.map((r) => r.table_name as string);
    expect(viewNames).toContain('wanted_items'); // DESIGN-001 D-15 reserved name claimed (D-08)
    expect(viewNames).toContain('effective_app_grants');
  });

  it('is idempotent: re-running runMigrations applies nothing new', async () => {
    await runMigrations({ databaseUrl: pg.connectionString });
    const seeded = await client.query('SELECT count(*)::int AS n FROM app_catalog');
    expect(seeded.rows[0].n).toBe(8);
  });

  describe('media_items (D-05)', () => {
    it('accepts a valid row per kind', async () => {
      await insertItem({
        arr_kind: 'sonarr',
        tmdb_id: null,
        tvdb_id: 121361,
        title: 'GoT',
        sort_title: 'got',
      });
      await insertItem(); // radarr
      await insertItem({
        arr_kind: 'lidarr',
        tmdb_id: null,
        musicbrainz_artist_id: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
        title: 'Nirvana',
        sort_title: 'nirvana',
      });
    });

    it('media_items_arr_kind_enum rejects unknown kinds', async () => {
      await expect(insertItem({ arr_kind: 'plex' })).rejects.toMatchObject({ code: '23514' });
    });

    it('media_items_external_id_for_kind requires the external id per kind', async () => {
      await expect(
        insertItem({ arr_kind: 'sonarr', tmdb_id: 1, tvdb_id: null }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(insertItem({ arr_kind: 'radarr', tmdb_id: null })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        insertItem({ arr_kind: 'lidarr', tmdb_id: null, musicbrainz_artist_id: null }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('media_items_arr_identity_unique forbids two rows for one *arr item', async () => {
      await insertItem({ arr_item_id: 777001, tmdb_id: 601 });
      await expect(insertItem({ arr_item_id: 777001, tmdb_id: 602 })).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  describe('ledger_events (D-07)', () => {
    let itemId: string;
    beforeAll(async () => {
      itemId = await insertItem({ arr_item_id: 777100, tmdb_id: 603 });
    });

    const insertEvent = (eventType: string, source: string, sourceEventId: string | null) =>
      client.query({
        text: `INSERT INTO ledger_events (media_item_id, event_type, source, source_event_id, occurred_at, payload)
               VALUES ($1, $2, $3, $4, now(), '{}'::jsonb)`,
        values: [itemId, eventType, source, sourceEventId],
      });

    it('event_type and source enums are CHECK-enforced', async () => {
      await expect(insertEvent('renamed', 'radarr', null)).rejects.toMatchObject({ code: '23514' });
      await expect(insertEvent('grabbed', 'plex', null)).rejects.toMatchObject({ code: '23514' });
    });

    it('the (source, source_event_id) dedupe UNIQUE holds — idempotent re-ingestion', async () => {
      await insertEvent('grabbed', 'radarr', 'hist-1');
      await expect(insertEvent('grabbed', 'radarr', 'hist-1')).rejects.toMatchObject({
        code: '23505',
      });
      // same source_event_id under a DIFFERENT source is a different event
      await insertEvent('grabbed', 'sonarr', 'hist-1');
    });

    it('NULL source_event_id rows are exempt from the partial unique index', async () => {
      await insertEvent('fix_requested', 'app', null);
      await insertEvent('fix_requested', 'app', null); // no conflict
    });

    it("accepts 'search_requested' (Force Search audit event, migration 0004)", async () => {
      await expect(insertEvent('search_requested', 'app', null)).resolves.toBeDefined();
    });
  });

  describe('fix_requests (D-09)', () => {
    let itemId: string;
    beforeAll(async () => {
      itemId = await insertItem({ arr_item_id: 777200, tmdb_id: 604 });
    });

    const insertFix = (
      reason: string,
      reasonText: string | null,
      extra: Record<string, unknown> = {},
    ) =>
      client.query({
        text: `INSERT INTO fix_requests (media_item_id, reason, reason_text, status, path_taken)
               VALUES ($1, $2, $3, $4, $5)`,
        values: [itemId, reason, reasonText, extra.status ?? 'pending', extra.path_taken ?? null],
      });

    it('reason / status / path enums are CHECK-enforced', async () => {
      await expect(insertFix('bad_reason', null)).rejects.toMatchObject({ code: '23514' });
      await expect(insertFix('wrong_language', null, { status: 'done' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        insertFix('wrong_language', null, { path_taken: 'reboot' }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('reason_text is required IFF reason = other (both directions, R-45)', async () => {
      await expect(insertFix('other', null)).rejects.toMatchObject({ code: '23514' });
      await expect(insertFix('other', '   ')).rejects.toMatchObject({ code: '23514' });
      await expect(insertFix('wrong_language', 'free text')).rejects.toMatchObject({
        code: '23514',
      });
      await insertFix('other', 'audio drops out at 12:34'); // OK
      await insertFix('wrong_language', null); // OK
    });
  });

  describe('restore_runs / sync_runs / sync_state enums (D-10, D-11)', () => {
    it('restore_runs rejects unknown arr_kind and status', async () => {
      await expect(
        client.query(
          `INSERT INTO restore_runs (arr_kind, arr_instance_id, preview, item_count) VALUES ('plex', 'main', '[]'::jsonb, 0)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `INSERT INTO restore_runs (arr_kind, arr_instance_id, status, preview, item_count) VALUES ('sonarr', 'main', 'paused', '[]'::jsonb, 0)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('sync_runs rejects unknown source / run_kind / status', async () => {
      await expect(
        client.query(`INSERT INTO sync_runs (source, run_kind) VALUES ('app', 'full')`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(`INSERT INTO sync_runs (source, run_kind) VALUES ('sonarr', 'partial')`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `INSERT INTO sync_runs (source, run_kind, status) VALUES ('sonarr', 'full', 'done')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('sync_state enforces the source enum and one row per source', async () => {
      await expect(
        client.query(`INSERT INTO sync_state (source) VALUES ('app')`),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(`INSERT INTO sync_state (source) VALUES ('seerr')`);
      await expect(
        client.query(`INSERT INTO sync_state (source) VALUES ('seerr')`),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('wanted_items view (D-08 — DDD-001 T-27: monitored + nothing on disk)', () => {
    it('returns exactly the monitored, live, zero-on-disk items', async () => {
      const wantedId = await insertItem({
        arr_item_id: 777300,
        tmdb_id: 605,
        title: 'Wanted Movie',
        sort_title: 'wanted movie',
        monitored: true,
        on_disk_file_count: 0,
        expected_file_count: 1,
      });
      await insertItem({
        arr_item_id: 777301,
        tmdb_id: 606,
        monitored: true,
        on_disk_file_count: 1,
        expected_file_count: 1,
      }); // on disk → not wanted
      await insertItem({
        arr_item_id: 777302,
        tmdb_id: 607,
        monitored: false,
        on_disk_file_count: 0,
      }); // unmonitored → not wanted
      await insertItem({
        arr_item_id: 777303,
        tmdb_id: 608,
        monitored: true,
        on_disk_file_count: 0,
        deleted_from_arr_at: new Date(),
      }); // tombstoned → not wanted

      const wanted = await client.query(
        `SELECT media_item_id, arr_kind, title, sort_title, expected_file_count
           FROM wanted_items WHERE media_item_id = ANY($1::uuid[]) OR title = 'Wanted Movie'`,
        [[wantedId]],
      );
      expect(wanted.rowCount).toBe(1);
      expect(wanted.rows[0]).toMatchObject({
        media_item_id: wantedId,
        arr_kind: 'radarr',
        title: 'Wanted Movie',
        sort_title: 'wanted movie',
        expected_file_count: 1,
      });

      const all = await client.query(
        `SELECT media_item_id FROM wanted_items WHERE media_item_id IN
           (SELECT id FROM media_items WHERE arr_item_id IN (777301, 777302, 777303))`,
      );
      expect(all.rowCount).toBe(0);
    });
  });
});
