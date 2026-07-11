// ADR-026 / DESIGN-012 (PLAN-009 Bulletin) — the generic secured webhook receiver, e2e (advisory).
// Hermetic: POSTs each source's sample payload to POST /api/webhooks/<source> against the real Next
// route and asserts the ingest contract end-to-end (secret gating, size cap, unknown source, valid
// 202 with a persisted id, and idempotent dedupe via the `deduped` flag). Attribution correctness
// (email→user, tmdb/tvdb→media) is covered by the @hnet/domain + @hnet/api integration tests
// (embedded PG16). The Feed/Messages UI is a separate Fable UX follow-up.
import { test, expect } from '@playwright/test';
import { armAndConfirm, signIn, signOut } from './support/helpers';
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

// ── the section UI (DESIGN-012 D-08) — nav gating, the Feed browse, the Messages board ────

test.describe('Bulletin section UI (ADR-026 / DESIGN-012 D-08)', () => {
  test('the Default member: nav entry, Messages-only (no Feed tab — ADR-049), read-only board', async ({
    page,
  }) => {
    // ADR-049 C-02 (PLAN-027) — the Default role is narrowed to the MESSAGES view only (the Feed
    // carries Family/Friends-oriented ops chatter). So the member sees the Bulletin nav entry and
    // lands on the Messages board, but there is NO Feed tab (and the feed endpoint FORBIDs it
    // server-side — covered by the @hnet/domain/@hnet/api unit tests).
    await signIn(page, 'member');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Bulletin' })
      .click();
    await page.waitForURL(/\/bulletin/);

    // No Feed tab; the Messages tab IS present and is the landing view.
    await expect(page.getByRole('tab', { name: 'Feed' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Messages' })).toBeVisible();
    await expect(page.getByTestId('feed-row')).toHaveCount(0);

    // Messages: readable, but NO composer without the post grant (R-103).
    await expect(page.getByTestId('composer-absent')).toBeVisible();
    await expect(page.getByTestId('message-composer')).toHaveCount(0);
  });

  test('admin sees BOTH sub-views: the seeded Feed (source-filterable) + the Messages board', async ({
    page,
  }) => {
    // Admin implies both Bulletin views (ADR-049) — the Feed tab is present with the seeded rows.
    await signIn(page, 'admin');
    await page.goto('/bulletin?tab=feed');
    await expect(page.getByRole('tab', { name: 'Feed' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Messages' })).toBeVisible();

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
  });

  test('admin: post (with a media link) → persists → edit → two-step hide → invisible to members', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/bulletin?tab=messages');
    const composer = page.getByTestId('message-composer');
    await expect(composer).toBeVisible();

    // Fable UX regression guard: the composer's Subject/Message/media-search controls use the
    // SHARED themed input surface (not the browser-default white that stood out in dark mode).
    // Their background must resolve to a themed color, never `rgb(255, 255, 255)` / transparent.
    for (const control of [
      composer.getByLabel('Subject'),
      composer.getByLabel(/^Message/),
      page.getByTestId('composer-media-search'),
    ]) {
      const bg = await control.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgb(255, 255, 255)');
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    }

    // Compose: subject + body + a Media Item link through the picker.
    await composer.getByLabel('Subject').fill('Buffering again');
    await composer.getByLabel(/^Message/).fill('The Fixture buffers at 12 minutes, every time.');
    await page.getByTestId('composer-media-search').fill('Fixture');
    await page.getByRole('option', { name: /The Fixture/ }).click();
    await expect(page.getByTestId('composer-media-picked')).toContainText('The Fixture');
    await page.getByTestId('message-post').click();

    const card = page.getByTestId('message-card').filter({ hasText: 'Buffering again' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('buffers at 12 minutes');

    // The linked title now renders as a prominent, clickable media chip that DEEP-LINKS to the
    // item page (/library/[id] — where History + Fix live), carrying a static repair cue sourced
    // server-side from fix_requests. The Fixture has a seeded (resolved) fix, so the chip shows a
    // "repairs recorded" hint. This is the owner's ask: jump from a message to the title's history.
    const chip = card.getByTestId('message-media-chip');
    await expect(chip).toBeVisible();
    // Carries ?from=bulletin so the item back-link reads "← Bulletin" (ADR-033 / DESIGN-005 D-17).
    await expect(chip).toHaveAttribute('href', /^\/library\/[0-9a-f-]{36}\?from=bulletin$/);
    await expect(chip).toContainText('The Fixture');
    await expect(chip.getByTestId('repair-hint')).toContainText(/repair/i);

    // Parity: an UNLINKED message renders NO chip (the picker stays optional).
    await composer.getByLabel(/^Message/).fill('Household heads-up — no title linked here.');
    await page.getByTestId('message-post').click();
    const plainCard = page.getByTestId('message-card').filter({ hasText: 'Household heads-up' });
    await expect(plainCard).toHaveCount(1);
    await expect(plainCard.getByTestId('message-media-chip')).toHaveCount(0);

    // Durable: a full reload still shows it (R-101).
    await page.reload();
    await expect(card).toHaveCount(1);

    // Author edit rides the Modal; the card shows the new body + the edited marker.
    await card.getByTestId('message-edit').click();
    await page
      .getByRole('dialog', { name: 'Edit message' })
      .getByLabel(/^Message/)
      .fill('Fixed after a re-download — resolved.');
    await page.getByTestId('message-edit-save').click();
    await expect(card).toContainText('resolved');
    await expect(card).toContainText('edited');

    // Moderation is the inline two-step ConfirmButton (ADR-014) — content preserved, status Hidden.
    await armAndConfirm(card.getByTestId('message-hide'));
    await expect(card).toContainText('Hidden');

    // A member (no moderate grant) can NEVER see the hidden message (R-102/AC-16).
    await signOut(page);
    await signIn(page, 'member');
    await page.goto('/bulletin?tab=messages');
    await expect(
      page.getByTestId('message-card').filter({ hasText: 'Buffering again' }),
    ).toHaveCount(0);

    // Moderator restore brings it back for everyone (leaves the suite's shared state visible).
    await signOut(page);
    await signIn(page, 'admin');
    await page.goto('/bulletin?tab=messages');
    const hiddenCard = page.getByTestId('message-card').filter({ hasText: 'Buffering again' });
    await hiddenCard.getByTestId('message-restore').click();
    await expect(hiddenCard).not.toContainText('Hidden');
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
