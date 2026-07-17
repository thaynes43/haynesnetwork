// ADR-027 / DESIGN-004 D-15 + D-17 (PLAN-010) — Message-of-the-Day dashboard banner. Journeys:
//   • admin composes + enables an info MOTD → a MEMBER's dashboard shows it (right severity + message,
//     D-17 markdown rendered — the [text](url) link is a real new-tab anchor, never literal syntax);
//   • the member dismisses it → it hides and STAYS hidden on reload (per-user localStorage version);
//   • the admin edits it (new version) → it RE-SHOWS for the member; warning severity ⇒ role="alert";
//   • the admin clears it → the member's dashboard shows no banner.
//   • ADR-015: dismiss/hover does not shift the content below (only presence toggles the banner).
// D-23 note: the banner's mount is HOME (`/` — the landing screen), where the neighbor below
// the greeting is the About tile, not the (relocated) tile grid.
// The suite shares one DB (workers:1); this spec CLEANS UP (clears the MOTD) so it never leaks into
// later specs' dashboards.
import { test, expect, type Page } from '@playwright/test';
import { armAndConfirm, signIn } from './support/helpers';

const banner = (page: Page) => page.getByTestId('motd-banner');

/** Compose/enable (or disable) the MOTD from /admin/motd as the currently-signed-in admin. */
async function setMotd(
  admin: Page,
  opts: { message: string; severity: 'info' | 'warning'; enabled?: boolean },
): Promise<void> {
  await admin.goto('/admin/motd');
  // exact: the Clear button's aria-label also contains "Message" (substring match otherwise collides).
  await admin.getByLabel('Message', { exact: true }).fill(opts.message);
  await admin.getByLabel('Severity', { exact: true }).selectOption(opts.severity);
  const enabled = admin.getByRole('checkbox', { name: /Enabled/ });
  if (opts.enabled === false) await enabled.uncheck();
  else await enabled.check();
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(admin.locator('.status-note')).toContainText('Saved');
}

/** Clear the MOTD (two-step confirm). After the write settles the form re-syncs to the now-disabled
 *  record, so the Enabled checkbox unchecks — a reliable signal the clear landed. */
async function clearMotd(admin: Page): Promise<void> {
  await admin.goto('/admin/motd');
  await armAndConfirm(admin.getByTestId('motd-clear'));
  await expect(admin.getByRole('checkbox', { name: /Enabled/ })).not.toBeChecked();
}

test.afterAll(async ({ browser }) => {
  // Safety net: ensure no enabled MOTD leaks into later specs even if a test failed mid-journey.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'admin');
    await clearMotd(page);
  } finally {
    await ctx.close();
  }
});

test('AC-MOTD — set · member sees · dismiss (sticky) · edit re-shows · clear removes', async ({
  browser,
}) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();

  await signIn(adminPage, 'admin');
  await signIn(memberPage, 'member');
  // Baseline: no banner before anything is set.
  await expect(banner(memberPage)).toBeHidden();

  // Admin enables an INFO MOTD (with a D-17 markdown link) → the member's dashboard shows it on
  // refresh, message rendered as markdown: the link is a real new-tab anchor, not literal syntax.
  await setMotd(adminPage, {
    message:
      'New app added: Immich — details [on my GitHub](https://github.com/thaynes43/haynesnetwork/issues)',
    severity: 'info',
  });
  await memberPage.reload();
  await expect(banner(memberPage)).toBeVisible();
  await expect(banner(memberPage)).toHaveAttribute('data-severity', 'info');
  await expect(banner(memberPage)).toContainText('New app added: Immich');
  const link = banner(memberPage).getByRole('link', { name: 'on my GitHub' });
  await expect(link).toHaveAttribute('href', 'https://github.com/thaynes43/haynesnetwork/issues');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // …and the raw markdown syntax never shows to the user.
  await expect(banner(memberPage)).not.toContainText('](');
  // Info ⇒ role="status" (a polite live region, not an alert).
  await expect(memberPage.getByRole('status').filter({ hasText: 'New app added' })).toBeVisible();

  // The member dismisses it → hides, and STAYS hidden across a reload (localStorage version).
  await memberPage.getByTestId('motd-dismiss').click();
  await expect(banner(memberPage)).toBeHidden();
  await memberPage.reload();
  await expect(banner(memberPage)).toBeHidden();

  // The admin EDITS it (new content → new version) and switches to WARNING → it re-shows.
  await setMotd(adminPage, { message: 'Emergency: Plex maintenance at 10pm', severity: 'warning' });
  await memberPage.reload();
  await expect(banner(memberPage)).toBeVisible();
  await expect(banner(memberPage)).toHaveAttribute('data-severity', 'warning');
  await expect(banner(memberPage)).toContainText('Plex maintenance at 10pm');
  // Warning ⇒ role="alert" (assertive).
  await expect(memberPage.getByRole('alert').filter({ hasText: 'Plex maintenance' })).toBeVisible();

  // The admin CLEARS it → the member's dashboard shows no banner.
  await clearMotd(adminPage);
  await memberPage.reload();
  await expect(banner(memberPage)).toBeHidden();

  await adminCtx.close();
  await memberCtx.close();
});

test('AC-MOTD — ADR-015: hovering the dismiss control does not shift the content below', async ({
  browser,
}) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();

  await signIn(adminPage, 'admin');
  await signIn(memberPage, 'member');
  await setMotd(adminPage, { message: 'Heads up — read the notes', severity: 'info' });
  await memberPage.reload();
  await expect(banner(memberPage)).toBeVisible();

  // Home's content below the banner (D-23): the About tile stands in for the old tile grid.
  const below = memberPage.locator('.tile--about');
  const before = await below.boundingBox();
  // Hover the dismiss control (an interaction) — it may recolor, but must not reflow neighbors.
  await memberPage.getByTestId('motd-dismiss').hover();
  const after = await below.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);

  await clearMotd(adminPage);
  await adminCtx.close();
  await memberCtx.close();
});
