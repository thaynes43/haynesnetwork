// ADR-026 / DESIGN-012 (PLAN-009 Bulletin) — the generic secured webhook receiver, e2e (advisory).
// Hermetic: POSTs each source's sample payload to POST /api/webhooks/<source> against the real Next
// route and asserts the ingest contract end-to-end (secret gating, size cap, unknown source, valid
// 202 with a persisted id, and idempotent dedupe via the `deduped` flag). Attribution correctness
// (email→user, tmdb/tvdb→media) is covered by the @hnet/domain + @hnet/api integration tests
// (embedded PG16). The Feed/Messages UI is a separate Fable UX follow-up.
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { ADMIN_EMAIL } from './support/stub-oidc';

const env = () => readRuntimeEnv();
const webhookUrl = (source: string) => `${env().BETTER_AUTH_URL}/api/webhooks/${source}`;

test.describe('Bulletin webhook receiver (ADR-026 / DESIGN-012)', () => {
  test('unknown source → 404', async ({ request }) => {
    const res = await request.post(`${env().BETTER_AUTH_URL}/api/webhooks/bogus`, {
      headers: { 'x-webhook-secret': env().SEERR_WEBHOOK_SECRET },
      data: { notification_type: 'X' },
    });
    expect(res.status()).toBe(404);
  });

  test('seerr: wrong secret 401, oversize 413, valid 202, idempotent dedupe', async ({
    request,
  }) => {
    const body = {
      notification_type: 'MEDIA_APPROVED',
      event: 'Request Automatically Approved',
      subject: 'The Fixture (2022)',
      message: 'Your request was approved',
      media: { media_type: 'movie', tmdbId: '880001', tvdbId: '', status: 'PROCESSING' },
      request: {
        request_id: 'e2e-seerr-9',
        requestedBy_email: ADMIN_EMAIL,
        requestedBy_username: 'admin',
      },
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

    // Re-POST the identical event → deduped (same id, no second row).
    const again = await request.post(webhookUrl('seerr'), {
      headers: { 'x-webhook-secret': env().SEERR_WEBHOOK_SECRET },
      data: body,
    });
    expect(again.status()).toBe(202);
    const againJson = (await again.json()) as { id: string; deduped: boolean };
    expect(againJson.deduped).toBe(true);
    expect(againJson.id).toBe(json.id);
  });

  test('tautulli: valid payload via the designed template + Authorization Bearer secret', async ({
    request,
  }) => {
    const res = await request.post(webhookUrl('tautulli'), {
      headers: { authorization: `Bearer ${env().TAUTULLI_WEBHOOK_SECRET}` },
      data: {
        event_type: 'playback.start',
        subject: 'Breaking Prod S01E02',
        message: 'ada started playing Breaking Prod',
        user: 'ada',
        user_email: 'ada@example.com',
        media_type: 'episode',
        tmdb_id: '',
        tvdb_id: '990001',
        source_event_id: 'playback.start:e2e-taut-1',
      },
    });
    expect(res.status()).toBe(202);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test('maintainerr: the original receiver still works at the same URL (?token= secret)', async ({
    request,
  }) => {
    const res = await request.post(
      `${webhookUrl('maintainerr')}?token=${encodeURIComponent(env().MAINTAINERR_WEBHOOK_SECRET)}`,
      { data: { notification_type: 'MEDIA_DELETED', subject: 'Cleaned up', message: '2 items' } },
    );
    expect(res.status()).toBe(202);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

// ── the section UI (DESIGN-012 D-12) — nav gating + the Feed browse. The Helpdesk ticket
// journeys (file → transition → reply → filters) live in helpdesk.spec.ts (PLAN-034).

test.describe('Bulletin section UI (ADR-026 / ADR-050 / DESIGN-012)', () => {
  test('the Default member: nav entry, Helpdesk-only (no Feed tab — ADR-049), no New-ticket button', async ({
    page,
  }) => {
    // ADR-049 C-02 (PLAN-027) — the Default role is narrowed to the MESSAGES view only (which
    // carries the Helpdesk since PLAN-034; the Feed is Family/Friends-oriented ops chatter). So
    // the member sees the Bulletin nav entry and lands on the Helpdesk, but there is NO Feed tab
    // (and the feed endpoint FORBIDs it server-side — covered by the unit tests).
    await signIn(page, 'member');
    // DESIGN-004 D-22 — the `bulletin` nav entry now reads "Tickets" (label change; route stays).
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Tickets' })
      .click();
    await page.waitForURL(/\/bulletin/);

    // No Feed tab; the Tickets (Helpdesk) tab IS present and is the landing view.
    await expect(page.getByRole('tab', { name: 'Feed' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Tickets' })).toBeVisible();
    await expect(page.getByTestId('feed-row')).toHaveCount(0);

    // Helpdesk: readable, but NO New-ticket button without the post grant (R-160/R-162).
    await expect(page.getByTestId('composer-absent')).toBeVisible();
    await expect(page.getByTestId('ticket-new')).toHaveCount(0);
  });

  test('admin sees BOTH sub-views (Helpdesk FIRST): the seeded Feed stays source-filterable', async ({
    page,
  }) => {
    // Admin implies both Bulletin views (ADR-049) — Helpdesk leads (R-160), the Feed follows.
    await signIn(page, 'admin');
    await page.goto('/bulletin?tab=feed');
    const tabs = page.getByRole('tablist', { name: 'Tickets sections' }).getByRole('tab');
    await expect(tabs.first()).toHaveText('Tickets');
    await expect(tabs.nth(1)).toHaveText('Feed');

    const rows = page.getByTestId('feed-row');
    await expect(rows.filter({ hasText: 'The Fixture (2022)' }).first()).toBeVisible();
    await expect(rows.filter({ hasText: 'Breaking Prod' }).first()).toBeVisible();

    // Source seg: Seerr-only swaps the result set in place (Tautulli rows gone).
    await page
      .getByRole('group', { name: 'Source' })
      .getByRole('button', { name: 'Seerr' })
      .click();
    await expect(rows.filter({ hasText: 'The Fixture (2022)' }).first()).toBeVisible();
    await expect(rows.filter({ hasText: 'playback.start' })).toHaveCount(0);

    // The retired ?tab=messages deep link ALIASES to the Helpdesk (ADR-050 C-06 — never a 404).
    await page.goto('/bulletin?tab=messages');
    await expect(page.locator('#bulletintab-helpdesk')).toHaveAttribute('aria-selected', 'true');
  });

  test('/admin/roles: the Bulletin access select + per-action grid; seeded roles summarized', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/roles');
    // The seeded Bulletin Poster role: Enabled (stored read_only) + exactly the post grant. The
    // Bulletin cell is now a 2-state Enabled/Disabled dropdown (ADR-049 — no meaningful Edit), whose
    // "Enabled" option persists read_only, so the stored-value assertion still holds.
    await expect(page.getByLabel('Bulletin access for Bulletin Poster')).toHaveValue('read_only');
    await expect(page.getByTestId('message-actions-summary-Bulletin Poster')).toHaveText(
      '1 action',
    );

    // ADR-049 C-02 (PLAN-027) — the Feed/Messages SUB-VIEW checkboxes. A role with no view rows
    // resolves to BOTH (Bulletin Poster); the Default role is narrowed to Messages-only.
    await expect(page.getByTestId('bulletin-view-feed-Bulletin Poster')).toBeChecked();
    await expect(page.getByTestId('bulletin-view-messages-Bulletin Poster')).toBeChecked();
    await expect(page.getByTestId('bulletin-view-feed-Default')).not.toBeChecked();
    await expect(page.getByTestId('bulletin-view-messages-Default')).toBeChecked();
    // Disabling Bulletin greys (disables) both view checkboxes (they're moot when hidden).
    await page.getByLabel('Bulletin access for Bulletin Poster').selectOption('disabled');
    await expect(page.getByTestId('bulletin-view-feed-Bulletin Poster')).toBeDisabled();
    await page.getByLabel('Bulletin access for Bulletin Poster').selectOption('read_only');
    await expect(page.getByTestId('message-actions-summary-Bulletin Moderator')).toHaveText(
      '2 actions',
    );
    // The row editor carries the per-action grid with the granted boxes checked.
    await page
      .getByRole('row', { name: /Bulletin Moderator/ })
      .getByRole('button', { name: 'Edit' })
      .click();
    await expect(page.getByTestId('message-actions-grid')).toBeVisible();
    await expect(page.getByTestId('message-action-post')).toBeChecked();
    await expect(page.getByTestId('message-action-moderate')).toBeChecked();
  });
});
