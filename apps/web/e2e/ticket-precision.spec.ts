// ADR-061 / DESIGN-032 (PLAN-038) — ticket media precision end to end: the leaf-or-scope drill
// in the compose Modal against the hermetic stack (stub sonarr serves Breaking Prod's episodes):
//
//   • picking a HIERARCHICAL title (Breaking Prod — sonarr) surfaces the scope chips and, for a
//     playback-class category (Q-01 nudge), the drill opens with NOTHING preselected — submit is
//     BLOCKED until a leaf or an explicit scope is chosen (R-200);
//   • drilling to an episode files the locator; the detail page renders the SNAPSHOTTED label;
//   • the wall tile's sub-line carries the label (ADR-058 anatomy unchanged).
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';

test.describe('ticket media precision (ADR-061 / PLAN-038)', () => {
  test('leaf-or-scope drill → episode locator → detail + wall labels', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'admin');

    await page.goto('/bulletin');
    await page.getByTestId('ticket-new').click();
    await page.getByTestId('ticket-title').fill('No audio on one episode');
    await page.getByTestId('ticket-category-audio').click();
    await page.getByTestId('ticket-body').fill('Center channel silent on this one.');

    // Link the sonarr series — the scope chips + drill appear (Q-01: audio nudges to the leaf).
    await page.getByTestId('composer-media-search').fill('Breaking');
    await page.getByRole('option', { name: /Breaking Prod/ }).first().click();
    await expect(page.getByTestId('composer-target')).toBeVisible();

    // R-200 — no accidental default: submit is blocked until a deliberate choice lands.
    await expect(page.getByTestId('ticket-create')).toBeDisabled();
    await expect(page.getByTestId('composer-scope-hint')).toBeVisible();

    // Drill to S01E02 (stub episode id 50102 = STUB_SERIES_ID*100 + 2).
    await page.getByTestId('composer-drill-episode-50102').click();
    await expect(page.getByTestId('composer-target-picked')).toContainText('S01E02');
    await expect(page.getByTestId('ticket-create')).toBeEnabled();

    await page.getByTestId('ticket-create').click();
    await page.waitForURL(/\/bulletin\/ticket\/[0-9a-f-]{36}$/);

    // D-05 — the snapshotted label renders on the detail head, prefixed by the media title.
    await expect(page.getByTestId('ticket-target-label')).toContainText('Breaking Prod');
    await expect(page.getByTestId('ticket-target-label')).toContainText('S01E02');

    // The wall tile's sub-line carries the label too.
    await page.goto('/bulletin');
    const tile = page.getByTestId('ticket-tile').filter({ hasText: 'No audio on one episode' });
    await expect(tile).toContainText('S01E02');

    // An explicit whole-show scope also unblocks submit (the deliberate top-level ticket).
    await page.getByTestId('ticket-new').click();
    await page.getByTestId('ticket-title').fill('Entire show missing subs');
    await page.getByTestId('ticket-category-subtitles').click();
    await page.getByTestId('ticket-body').fill('Every episode.');
    await page.getByTestId('composer-media-search').fill('Breaking');
    await page.getByRole('option', { name: /Breaking Prod/ }).first().click();
    await expect(page.getByTestId('ticket-create')).toBeDisabled();
    await page.getByTestId('composer-scope-all').click();
    await expect(page.getByTestId('composer-target-picked')).toContainText('Entire show');
    await expect(page.getByTestId('ticket-create')).toBeEnabled();
  });
});
