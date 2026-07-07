// ADR-026 / DESIGN-012 (PLAN-009 Bulletin) — the generic secured webhook receiver, e2e (advisory).
// Hermetic: POSTs each source's sample payload to POST /api/webhooks/<source> against the real Next
// route and asserts rows land (with attribution + dedupe) + the per-source secret gating. The
// Feed/Messages UI is a separate Fable UX follow-up; this spec exercises the ingest contract only,
// verifying the landed rows directly in the embedded PG (a SELECT — never a guarded write).
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { ADMIN_EMAIL } from './support/stub-oidc';

const env = () => readRuntimeEnv();
const webhookUrl = (source: string) => `${env().BETTER_AUTH_URL}/api/webhooks/${source}`;

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env().DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

test.describe('Bulletin webhook receiver (ADR-026 / DESIGN-012)', () => {
  test('unknown source → 404', async ({ request }) => {
    const res = await request.post(`${env().BETTER_AUTH_URL}/api/webhooks/bogus`, {
      headers: { 'x-webhook-secret': env().SEERR_WEBHOOK_SECRET },
      data: { notification_type: 'X' },
    });
    expect(res.status()).toBe(404);
  });

  test('seerr: wrong secret 401, oversize 413, valid 202 lands an attributed + linked row, dedupe', async ({
    page,
    request,
  }) => {
    // Sign in as admin so the admin user row exists → the seerr requester email can attribute to it.
    await signIn(page, 'admin');

    const body = {
      notification_type: 'MEDIA_APPROVED',
      event: 'Request Automatically Approved',
      subject: 'The Fixture (2022)',
      message: 'Your request was approved',
      media: { media_type: 'movie', tmdbId: '880001', tvdbId: '', status: 'PROCESSING' },
      request: { request_id: 'e2e-seerr-9', requestedBy_email: ADMIN_EMAIL, requestedBy_username: 'admin' },
      extra: [],
    };

    // Wrong secret → 401 (never leaks whether the payload was valid).
    const wrong = await request.post(webhookUrl('seerr'), {
      headers: { 'x-webhook-secret': 'not-the-secret' },
      data: body,
    });
    expect(wrong.status()).toBe(401);

    // Oversize body → 413 (rejected before parse).
    const huge = await request.post(webhookUrl('seerr'), {
      headers: { 'x-webhook-secret': env().SEERR_WEBHOOK_SECRET },
      data: { notification_type: 'X', message: 'B'.repeat(70 * 1024) },
    });
    expect(huge.status()).toBe(413);

    // Valid → 202 { ok, id, deduped:false }.
    const ok = await request.post(webhookUrl('seerr'), {
      headers: { 'x-webhook-secret': env().SEERR_WEBHOOK_SECRET },
      data: body,
    });
    expect(ok.status()).toBe(202);
    const json = (await ok.json()) as { ok: boolean; id: string; deduped: boolean };
    expect(json).toMatchObject({ ok: true, deduped: false });
    expect(json.id).toBeTruthy();

    // The row landed with attribution (email→user) + media link (tmdbId→radarr item).
    await withDb(async (c) => {
      const row = await c.query(
        `SELECT source, type, actor_user_id, media_item_id, source_event_id FROM notifications WHERE id = $1`,
        [json.id],
      );
      expect(row.rows[0].source).toBe('seerr');
      expect(row.rows[0].actor_user_id).not.toBeNull(); // attributed to the admin user
      expect(row.rows[0].media_item_id).not.toBeNull(); // linked to The Fixture (tmdbId 880001)
      expect(row.rows[0].source_event_id).toBe('MEDIA_APPROVED:e2e-seerr-9');
    });

    // Re-POST the identical event → deduped (same id, no second row).
    const again = await request.post(webhookUrl('seerr'), {
      headers: { 'x-webhook-secret': env().SEERR_WEBHOOK_SECRET },
      data: body,
    });
    expect(again.status()).toBe(202);
    const againJson = (await again.json()) as { id: string; deduped: boolean };
    expect(againJson.deduped).toBe(true);
    expect(againJson.id).toBe(json.id);
    await withDb(async (c) => {
      const count = await c.query(
        `SELECT count(*)::int AS n FROM notifications WHERE source='seerr' AND source_event_id=$1`,
        ['MEDIA_APPROVED:e2e-seerr-9'],
      );
      expect(count.rows[0].n).toBe(1);
    });
  });

  test('tautulli: valid payload lands via the designed template + Authorization Bearer secret', async ({
    request,
  }) => {
    const body = {
      event_type: 'playback.start',
      subject: 'Breaking Prod S01E02',
      message: 'ada started playing Breaking Prod',
      user: 'ada',
      user_email: 'ada@example.com',
      media_type: 'episode',
      tmdb_id: '',
      tvdb_id: '990001',
      source_event_id: 'playback.start:e2e-taut-1',
    };
    // The secret rides the Authorization header (Bearer) instead of x-webhook-secret.
    const res = await request.post(webhookUrl('tautulli'), {
      headers: { authorization: `Bearer ${env().TAUTULLI_WEBHOOK_SECRET}` },
      data: body,
    });
    expect(res.status()).toBe(202);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    await withDb(async (c) => {
      const row = await c.query(`SELECT source, type FROM notifications WHERE id = $1`, [json.id]);
      expect(row.rows[0].source).toBe('tautulli');
      expect(row.rows[0].type).toBe('playback.start');
    });
  });

  test('maintainerr: the original receiver still works at the same URL (?token= secret)', async ({
    request,
  }) => {
    const res = await request.post(
      `${webhookUrl('maintainerr')}?token=${encodeURIComponent(env().MAINTAINERR_WEBHOOK_SECRET)}`,
      { data: { notification_type: 'MEDIA_DELETED', subject: 'Cleaned up', message: '2 items' } },
    );
    expect(res.status()).toBe(202);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
  });
});
