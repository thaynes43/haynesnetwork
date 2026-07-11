// ADR-050 / DESIGN-012 D-10..D-13 (PLAN-034) — the Helpdesk ticket system end to end, against the
// hermetic stack (embedded PG16 + stub OIDC/*arrs). One serial journey (workers=1, shared DB):
//
//   • a MEMBER (Bulletin Poster — the `post` grant) files a ticket through the compose Modal →
//     lands on the new ticket's detail page;
//   • the member sees NO transition buttons (staff-only — Q-02), but CAN reply later;
//   • STAFF (admin — implies `moderate`) starts progress WITH a reason, the timeline records it;
//   • the member REPLIES (the messages-view power — no action grant);
//   • staff completes with a resolution comment; complete is terminal (no buttons remain);
//   • the ADMIN files a LINKED ticket through the media picker (the poster-tile path — admins are
//     access-unrestricted; the hermetic stack seeds no plex-matches, so a member's ledger.search
//     is gated empty by THE INVARIANT — ADR-047), then REJECTS it with a GitHub-bound reason and
//     RE-OPENS it (the rejected → open edge);
//   • the WALL: poster + category tiles, status pucks/badges, reply count, and the STATE filter
//     chips (requirement 7) swapping the result set.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';

/** Assign the Marge Member persona's user to a role by name (admin user-detail select). */
async function assignMemberRole(adminPage: Page, roleLabel: string): Promise<void> {
  await adminPage.goto('/admin');
  await adminPage.getByRole('link', { name: 'Marge Member' }).click();
  await expect(adminPage.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
  const settled = adminPage.waitForResponse((r) => r.url().includes('users.setRole'));
  await adminPage.locator('#user-role').selectOption({ label: roleLabel });
  await settled;
}

test.describe('Helpdesk tickets (ADR-050 / DESIGN-012 D-10..D-13)', () => {
  test('member files → staff transitions with reasons → member replies → wall + state filters', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    await signIn(page, 'admin');
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    await assignMemberRole(page, 'Bulletin Poster');

    // ── the MEMBER files a ticket through the compose Modal (requirement 2) ──
    await memberPage.goto('/bulletin');
    await expect(memberPage.getByTestId('ticket-new')).toBeVisible();
    await memberPage.getByTestId('ticket-new').click();
    const compose = memberPage.getByTestId('ticket-compose');
    await expect(compose).toBeVisible();
    // The intake copy routes SITE bugs to GitHub (requirement 3).
    await expect(compose).toContainText('GitHub');
    await memberPage.getByTestId('ticket-title').fill('Buffering on everything tonight');
    await memberPage.getByTestId('ticket-category-playback').click();
    await expect(memberPage.getByTestId('ticket-category-playback')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await memberPage.getByTestId('ticket-body').fill('All titles, all apps, since about 8pm.');
    await memberPage.getByTestId('ticket-create').click();

    // Success PUSHES the new ticket's detail page (requirement 6 + D-19).
    await memberPage.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);
    const ticketUrl = memberPage.url();
    await expect(memberPage.getByTestId('ticket-detail-title')).toHaveText(
      'Buffering on everything tonight',
    );
    await expect(memberPage.getByTestId('ticket-detail-status')).toHaveText('Open');
    // The timeline starts at "Filed"; the member (no moderate grant) sees NO transition buttons.
    await expect(memberPage.getByTestId('ticket-timeline').locator('li')).toHaveCount(1);
    await expect(memberPage.getByTestId('ticket-timeline')).toContainText('Filed');
    await expect(memberPage.getByTestId('ticket-transitions')).toHaveCount(0);

    // ── STAFF starts progress WITH a reason (requirement 5) ──
    await page.goto(ticketUrl);
    await expect(page.getByTestId('ticket-transitions')).toBeVisible();
    await page.getByTestId('ticket-move-in_progress').click();
    await page.getByTestId('transition-note').fill('Checking the server load');
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('In progress');
    await expect(page.getByTestId('ticket-timeline').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('ticket-timeline')).toContainText('Open → In progress');
    await expect(page.getByTestId('ticket-timeline')).toContainText('Checking the server load');

    // ── the MEMBER replies (the messages-view power — Q-02, no action grant needed) ──
    await memberPage.reload();
    await expect(memberPage.getByTestId('ticket-detail-status')).toHaveText('In progress');
    await memberPage.getByTestId('reply-body').fill('Fine again on my end since 9.');
    await memberPage.getByTestId('reply-send').click();
    await expect(memberPage.getByTestId('ticket-reply')).toHaveCount(1);
    await expect(memberPage.getByTestId('ticket-reply')).toContainText('Marge Member');
    await expect(memberPage.getByTestId('ticket-reply')).toContainText('Fine again');

    // ── staff completes with a resolution comment; complete is TERMINAL ──
    await page.reload();
    await page.getByTestId('ticket-move-complete').click();
    await page.getByTestId('transition-note').fill('Transcoder restarted — back to normal');
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('Complete');
    await expect(page.getByTestId('ticket-timeline').locator('li')).toHaveCount(3);
    await expect(page.getByTestId('ticket-timeline')).toContainText('Transcoder restarted');
    await expect(page.getByTestId('ticket-transitions')).toHaveCount(0);

    // ── the ADMIN files a LINKED ticket via the media picker (the poster-tile path) ──
    await page.goto('/bulletin?tab=helpdesk');
    await page.getByTestId('ticket-new').click();
    await page.getByTestId('ticket-title').fill('No sound from minute 3');
    await page.getByTestId('ticket-category-audio').click();
    await page.getByTestId('composer-media-search').fill('Fixture');
    await page
      .getByRole('option', { name: /The Fixture/ })
      .first()
      .click();
    await expect(page.getByTestId('composer-media-picked')).toContainText('The Fixture');
    await page.getByTestId('ticket-body').fill('Living-room TV, every playback.');
    await page.getByTestId('ticket-create').click();
    await page.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);
    // The linked title renders the library deep link + the seeded repair cue (The Fixture has a
    // resolved fix in the seed — "1 repair recorded").
    await expect(page.getByRole('link', { name: /The Fixture.*history & repairs/ })).toBeVisible();
    await expect(page.getByTestId('repair-hint')).toContainText(/repair/i);

    // Staff REJECTS it with a GitHub-bound reason, then RE-OPENS (the rejected → open edge).
    await page.getByTestId('ticket-move-rejected').click();
    await page.getByTestId('transition-note').fill('Client-side issue — not our media');
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('Rejected');
    await page.getByTestId('ticket-move-open').click();
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('Open');
    await expect(page.getByTestId('ticket-timeline').locator('li')).toHaveCount(3);

    // ── the WALL: tiles, pucks, reply count, and the STATE filter chips (requirement 7) ──
    await memberPage.goto('/bulletin?tab=helpdesk');
    const tiles = memberPage.getByTestId('ticket-tile');
    await expect(tiles).toHaveCount(2);
    const bufferTile = tiles.filter({ hasText: 'Buffering on everything' });
    const soundTile = tiles.filter({ hasText: 'No sound from minute 3' });
    // The non-media ticket renders its CATEGORY icon tile + the state baked on.
    await expect(bufferTile).toHaveAttribute('data-status', 'complete');
    await expect(bufferTile).toContainText('Complete');
    await expect(bufferTile.locator('.twall-cattile')).toBeVisible();
    await expect(bufferTile.locator('.twall-cattile__label')).toHaveText('Playback');
    await expect(bufferTile.locator('.twall-replies')).toHaveText('1');
    // The linked ticket shows the linked title text (its poster streams from the stub *arr).
    await expect(soundTile).toHaveAttribute('data-status', 'open');
    await expect(soundTile).toContainText('The Fixture');

    // State chips swap the result set in place (router.replace — D-19).
    await memberPage.getByTestId('ticket-filter-open').click();
    await expect(memberPage).toHaveURL(/state=open/);
    await expect(memberPage.getByTestId('ticket-tile')).toHaveCount(1);
    await expect(memberPage.getByTestId('ticket-tile')).toContainText('No sound');
    await memberPage.getByTestId('ticket-filter-complete').click();
    await expect(memberPage.getByTestId('ticket-tile')).toHaveCount(1);
    await expect(memberPage.getByTestId('ticket-tile')).toContainText('Buffering');
    await memberPage.getByTestId('ticket-filter-all').click();
    await expect(memberPage.getByTestId('ticket-tile')).toHaveCount(2);

    // A wall tile drills into the detail (a history PUSH — D-19).
    await memberPage
      .getByTestId('ticket-tile')
      .filter({ hasText: 'Buffering on everything' })
      .locator('.twall-link')
      .click();
    await memberPage.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);
    await expect(memberPage.getByTestId('ticket-detail-title')).toHaveText(
      'Buffering on everything tonight',
    );

    // Leave the shared suite state as it was found: Marge back on Default (the option label
    // renders "Default (default)", so select by the FIXED seeded role id).
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Marge Member' }).click();
    await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
    const restored = page.waitForResponse((r) => r.url().includes('users.setRole'));
    await page.locator('#user-role').selectOption('11111111-1111-4111-8111-111111111111');
    await restored;
    await memberContext.close();
  });
});
