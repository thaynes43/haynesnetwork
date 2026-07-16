// ADR-063 / DESIGN-034 (R-206/R-207) — About/Help smoke: the dashboard shows the inverted
// About card above the perforated rule and it navigates (same tab) to /about; the help
// sections are native <details> that start collapsed, expand/collapse in place, and honor
// #hash deep links; the Trash section renders the LIVE save-window default (D-06); an
// anonymous /about bounces to /login like every (app) route.
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';

/** D-05 — the section ids, in page order (deep-link contract — stable, never renumbered). */
const SECTION_IDS = [
  'plex-servers',
  'fix',
  'tickets',
  'trash',
  'requests',
  'goodreads',
  'reading',
  'audiobooks',
  'watching',
  'music',
];

test('anonymous /about redirects to /login', async ({ page }) => {
  await page.goto('/about');
  await expect(page).toHaveURL(/\/login$/);
});

test('dashboard shows the About card above the perforation and it navigates to /about', async ({
  page,
}) => {
  await signIn(page, 'member');

  const card = page.locator('.tile--about');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('href', '/about');
  await expect(card.locator('.tile__name')).toHaveText('About haynesnetwork.com');
  // Internal link — no new tab, unlike the SSO tiles around it.
  await expect(card).not.toHaveAttribute('target', '_blank');

  // D-01/D-02 DOM order: card → perforated rule → tile grid (querySelectorAll is document order).
  await expect(page.locator('.tile-rule')).toBeVisible();
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tile--about, .tile-rule, .tile-grid')).map((el) =>
      el.classList.contains('tile--about')
        ? 'card'
        : el.classList.contains('tile-rule')
          ? 'rule'
          : 'grid',
    ),
  );
  expect(order, 'About card precedes the rule, rule precedes the grid').toEqual([
    'card',
    'rule',
    'grid',
  ]);

  await card.click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('heading', { name: 'About haynesnetwork.com' })).toBeVisible();
});

test('sections start collapsed and expand/collapse in place', async ({ page }) => {
  await signIn(page, 'member');
  await page.goto('/about');

  // Every D-05 section is present, in order, and collapsed by default.
  const ids = await page.locator('details.about-sec').evaluateAll((els) => els.map((el) => el.id));
  expect(ids).toEqual(SECTION_IDS);
  await expect(page.locator('details.about-sec[open]')).toHaveCount(0);

  // Expand Trash: the body appears (with the LIVE save-window default — D-06) and no other
  // section opens; a second tap collapses it again.
  const trash = page.locator('details#trash');
  await trash.locator('summary').click();
  await expect(trash).toHaveAttribute('open', '');
  await expect(trash.locator('.about-sec__body')).toContainText(/currently \d+ days/);
  await expect(page.locator('details.about-sec[open]')).toHaveCount(1);
  await trash.locator('summary').click();
  await expect(page.locator('details.about-sec[open]')).toHaveCount(0);
});

test('#fix deep link arrives expanded', async ({ page }) => {
  await signIn(page, 'member');
  await page.goto('/about#fix');
  await expect(page.locator('details#fix')).toHaveAttribute('open', '');
  // Only the targeted section opened.
  await expect(page.locator('details.about-sec[open]')).toHaveCount(1);
});
