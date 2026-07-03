// R-61 / DESIGN-004 D-02..D-03 — theming behavior in a real browser: the topbar
// toggle flips <html data-theme> and persists via localStorage `hnet-theme`; with
// no stored value the pre-hydration script seeds from prefers-color-scheme.
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';

const THEME_KEY = 'hnet-theme';

test.describe('prefers-color-scheme seeding (no stored value)', () => {
  test.describe('light OS preference', () => {
    test.use({ colorScheme: 'light' });
    test('seeds hnet-light before first paint', async ({ page }) => {
      await page.goto('/login');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'hnet-light');
    });
  });

  test.describe('dark OS preference', () => {
    test.use({ colorScheme: 'dark' });
    test('seeds hnet-dark before first paint', async ({ page }) => {
      await page.goto('/login');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'hnet-dark');
    });
  });
});

test.describe('toggle + persistence', () => {
  // Fixed OS preference so the stored value demonstrably WINS over it on reload.
  test.use({ colorScheme: 'light' });

  test('toggle flips data-theme, writes hnet-theme, and survives reload', async ({ page }) => {
    await signIn(page, 'member');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'hnet-light');

    // Flip to dark via the topbar toggle (label resolves post-mount).
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'hnet-dark');
    await expect
      .poll(async () => page.evaluate((k) => localStorage.getItem(k), THEME_KEY))
      .toBe('hnet-dark');

    // Stored value beats the light OS preference across a reload — and the
    // pre-hydration script stamps it, so it's correct on FIRST paint too.
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'hnet-dark');

    // Toggle back and it persists the other way.
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'hnet-light');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'hnet-light');
    await expect
      .poll(async () => page.evaluate((k) => localStorage.getItem(k), THEME_KEY))
      .toBe('hnet-light');
  });
});
