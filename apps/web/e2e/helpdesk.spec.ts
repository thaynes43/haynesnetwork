// ADR-050 / DESIGN-012 D-10..D-13 (PLAN-034) — the Helpdesk ticket system end to end, against the
// hermetic stack (embedded PG16 + stub OIDC/*arrs). One serial journey (workers=1, shared DB):
//
//   • a MEMBER (Bulletin Poster — the `post` grant) files a ticket through the compose Modal,
//     linking a library title through the picker → lands on the new ticket's detail page;
//   • the member sees NO transition buttons (staff-only — Q-02), but CAN reply later;
//   • STAFF (admin — implies `moderate`) starts progress WITH a reason, the timeline records it;
//   • the member REPLIES (the messages-view power — no action grant);
//   • staff completes with a resolution comment; complete is terminal (no buttons remain);
//   • a second, NON-media ticket proves the category icon tile; staff REJECTS it with a
//     GitHub-bound reason, then RE-OPENS it (the rejected → open edge);
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
    test.setTimeout(120_000);
    await signIn(page, 'admin');
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    await assignMemberRole(page, 'Bulletin Poster');

    // ── the member files a LINKED ticket through the compose Modal (requirement 2) ──
    await memberPage.goto('/bulletin');
    await expect(memberPage.getByTestId('ticket-new')).toBeVisible();
    await memberPage.getByTestId('ticket-new').click();
    const compose = memberPage.getByTestId('ticket-compose');
    await expect(compose).toBeVisible();
    // The intake copy routes SITE bugs to GitHub (requirement 3).
    await expect(compose).toContainText('GitHub');
    await memberPage.getByTestId('ticket-title').fill('No sound from minute 3');
    await memberPage.getByTestId('ticket-category-audio').click();
    await expect(memberPage.getByTestId('ticket-category-audio')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await memberPage.getByTestId('composer-media-search').fill('Fixture');
    await memberPage
      .getByRole('option', { name: /The Fixture/ })
      .first()
      .click();
    await expect(memberPage.getByTestId('composer-media-picked')).toContainText('The Fixture');
    await memberPage.getByTestId('ticket-body').fill('Living-room TV, every playback.');
    await memberPage.getByTestId('ticket-create').click();

    // Success PUSHES the new ticket's detail page (requirement 6 + D-19).
    await memberPage.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);
    const ticketUrl = memberPage.url();
    await expect(memberPage.getByTestId('ticket-detail-title')).toHaveText(
      'No sound from minute 3',
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
    await page.getByTestId('transition-note').fill('Checking the audio track');
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('In progress');
    await expect(page.getByTestId('ticket-timeline').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('ticket-timeline')).toContainText('Open → In progress');
    await expect(page.getByTestId('ticket-timeline')).toContainText('Checking the audio track');

    // ── the MEMBER replies (the messages-view power — Q-02, no action grant needed) ──
    await memberPage.reload();
    await expect(memberPage.getByTestId('ticket-detail-status')).toHaveText('In progress');
    await memberPage.getByTestId('reply-body').fill('Happens on the bedroom TV too.');
    await memberPage.getByTestId('reply-send').click();
    await expect(memberPage.getByTestId('ticket-reply')).toHaveCount(1);
    await expect(memberPage.getByTestId('ticket-reply')).toContainText('Marge Member');
    await expect(memberPage.getByTestId('ticket-reply')).toContainText('bedroom TV');

    // ── staff completes with a resolution comment; complete is TERMINAL ──
    await page.reload();
    await page.getByTestId('ticket-move-complete').click();
    await page.getByTestId('transition-note').fill('Regrabbed a clean copy — try it now');
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('Complete');
    await expect(page.getByTestId('ticket-timeline').locator('li')).toHaveCount(3);
    await expect(page.getByTestId('ticket-timeline')).toContainText('Regrabbed a clean copy');
    await expect(page.getByTestId('ticket-transitions')).toHaveCount(0);

    // ── a second, NON-media ticket (the category icon tile) — then reject + re-open ──
    await memberPage.goto('/bulletin?tab=helpdesk');
    await memberPage.getByTestId('ticket-new').click();
    await memberPage.getByTestId('ticket-title').fill('Buffering on everything tonight');
    await memberPage.getByTestId('ticket-category-playback').click();
    await memberPage.getByTestId('ticket-body').fill('All titles, all apps.');
    await memberPage.getByTestId('ticket-create').click();
    await memberPage.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);
    const secondUrl = memberPage.url();

    await page.goto(secondUrl);
    await page.getByTestId('ticket-move-rejected').click();
    await page.getByTestId('transition-note').fill('Looks like the ISP, not our media');
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('Rejected');
    // Rejected RE-OPENS (the hide/restore analog).
    await page.getByTestId('ticket-move-open').click();
    await page.getByTestId('transition-apply').click();
    await expect(page.getByTestId('ticket-detail-status')).toHaveText('Open');
    await expect(page.getByTestId('ticket-timeline').locator('li')).toHaveCount(3);

    // ── the WALL: tiles, pucks, reply count, and the STATE filter chips (requirement 7) ──
    await memberPage.goto('/bulletin?tab=helpdesk');
    const tiles = memberPage.getByTestId('ticket-tile');
    await expect(tiles).toHaveCount(2);
    const soundTile = tiles.filter({ hasText: 'No sound from minute 3' });
    const bufferTile = tiles.filter({ hasText: 'Buffering on everything' });
    // The linked ticket bakes its state on (puck + badge) and shows the linked title + replies.
    await expect(soundTile).toHaveAttribute('data-status', 'complete');
    await expect(soundTile).toContainText('Complete');
    await expect(soundTile).toContainText('The Fixture');
    await expect(soundTile.locator('.twall-replies')).toHaveText('1');
    // The non-media ticket renders its CATEGORY icon tile.
    await expect(bufferTile).toHaveAttribute('data-status', 'open');
    await expect(bufferTile.locator('.twall-cattile')).toBeVisible();
    await expect(bufferTile.locator('.twall-cattile__label')).toHaveText('Playback');

    // State chips swap the result set in place (router.replace — D-19).
    await memberPage.getByTestId('ticket-filter-open').click();
    await expect(memberPage).toHaveURL(/state=open/);
    await expect(memberPage.getByTestId('ticket-tile')).toHaveCount(1);
    await expect(memberPage.getByTestId('ticket-tile')).toContainText('Buffering');
    await memberPage.getByTestId('ticket-filter-complete').click();
    await expect(memberPage.getByTestId('ticket-tile')).toHaveCount(1);
    await expect(memberPage.getByTestId('ticket-tile')).toContainText('No sound');
    await memberPage.getByTestId('ticket-filter-all').click();
    await expect(memberPage.getByTestId('ticket-tile')).toHaveCount(2);

    // A wall tile drills into the detail (a history PUSH — D-19).
    await memberPage
      .getByTestId('ticket-tile')
      .filter({ hasText: 'No sound' })
      .locator('.twall-link')
      .click();
    await memberPage.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);
    await expect(memberPage.getByTestId('ticket-detail-title')).toHaveText(
      'No sound from minute 3',
    );

    // Leave the shared suite state as it was found: Marge back on Default.
    await assignMemberRole(page, 'Default');
    await memberContext.close();
  });
});
