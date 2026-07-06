// ADR-016 / DESIGN-005 D-19 end to end: the missing_subtitles Fix routes to Bazarr, never
// the ADR-007 blocklist/delete/re-grab paths. A member opens the seeded Sonarr episode /
// Radarr movie, picks "Missing subtitles", submits, and the stub Bazarr records the
// search-missing PATCH (plus the pre-read GET) while the stub *arr records NOTHING
// destructive. Music (Lidarr) offers no "Missing subtitles" radio at all.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import type { RecordedArrWrite } from './support/stub-arr';

interface RecordedBazarrCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

async function bazarrCalls(): Promise<RecordedBazarrCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_BAZARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-bazarr calls fetch failed: ${res.status}`);
  return ((await res.json()) as { calls: RecordedBazarrCall[] }).calls;
}

async function resetBazarrCalls(): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_BAZARR_URL}/_stub/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`stub-bazarr reset failed: ${res.status}`);
}

async function arrCalls(): Promise<RecordedArrWrite[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-arr calls fetch failed: ${res.status}`);
  return ((await res.json()) as { calls: RecordedArrWrite[] }).calls;
}

async function resetArrCalls(): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`stub-arr reset failed: ${res.status}`);
}

async function openTvItem(page: Page): Promise<void> {
  await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
  await page.waitForURL('/library');
  await page.getByRole('tab', { name: 'TV' }).click();
  const card = page.locator('.media-card').filter({ hasText: 'Breaking Prod' });
  await card.click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await expect(page.locator('.detail-head__title')).toContainText('Breaking Prod');
}

test.describe('subtitle Fix routes to Bazarr (ADR-016 / D-19)', () => {
  test('sonarr episode: Missing subtitles → Bazarr series search, no *arr blocklist/delete', async ({
    page,
  }) => {
    // Admin bypasses the shared hourly budget so this stays order-independent.
    await signIn(page, 'admin');
    await openTvItem(page);

    // S01E04 is on disk (E10 is the only missing one) — distinct from the episodes the
    // library spec fixes, so no open-fix collision.
    const season1 = page.locator('.season').filter({ hasText: 'Season 1' });
    await season1.locator('.season__title').click();
    await expect(season1).toHaveJSProperty('open', true);
    const row = page.locator('.child-row').filter({ hasText: 'S01E04 · Chapter 4' });
    await expect(row).toContainText('On disk');

    await resetBazarrCalls();
    await resetArrCalls();

    await row.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('S01E04 · Chapter 4');
    // The reason IS offered for TV.
    await dialog.getByRole('radio', { name: 'Missing subtitles' }).check();
    await dialog.getByRole('button', { name: 'Submit fix' }).click();

    // Success copy names Bazarr and reassures the file is untouched.
    await expect(dialog).toContainText('Bazarr is searching', { timeout: 15_000 });
    await expect(dialog).toContainText('untouched');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Bazarr got the series-level search-missing PATCH plus the episode pre-read GET.
    const bz = await bazarrCalls();
    const patch = bz.filter((c) => c.method === 'PATCH' && c.path === '/api/series');
    expect(patch).toHaveLength(1);
    expect(patch[0]!.query.seriesid).toBe('501');
    expect(patch[0]!.query.action).toBe('search-missing');
    expect(bz.some((c) => c.method === 'GET' && c.path === '/api/episodes')).toBe(true);

    // The stub *arr recorded NOTHING destructive — no blocklist, no delete, no search command.
    const arr = await arrCalls();
    expect(arr.filter((c) => c.path.startsWith('/history/failed/'))).toHaveLength(0);
    expect(arr.filter((c) => c.path === '/command')).toHaveLength(0);
    expect(arr.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  test('radarr movie: Missing subtitles → Bazarr movie search, no *arr writes', async ({ page }) => {
    await signIn(page, 'admin');
    await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
    await page.waitForURL('/library');
    const card = page.locator('.media-card').filter({ hasText: 'The Fixture' });
    await card.click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
    await expect(page.locator('.detail-head__title')).toContainText('The Fixture');

    await resetBazarrCalls();
    await resetArrCalls();

    await page.locator('.detail-head__actions').getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix The Fixture' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: 'Missing subtitles' }).check();
    await dialog.getByRole('button', { name: 'Submit fix' }).click();
    await expect(dialog).toContainText('Bazarr is searching', { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();

    const bz = await bazarrCalls();
    const patch = bz.filter((c) => c.method === 'PATCH' && c.path === '/api/movies');
    expect(patch).toHaveLength(1);
    expect(patch[0]!.query.radarrid).toBe('601');
    expect(patch[0]!.query.action).toBe('search-missing');

    const arr = await arrCalls();
    expect(arr.filter((c) => c.path.startsWith('/history/failed/'))).toHaveLength(0);
    expect(arr.filter((c) => c.path === '/command')).toHaveLength(0);
    expect(arr.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  test('lidarr (Music) offers NO Missing subtitles radio in the Fix dialog', async ({ page }) => {
    await signIn(page, 'admin');
    await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
    await page.waitForURL('/library');
    await page.getByRole('tab', { name: 'Music' }).click();
    const card = page.locator('.media-card').filter({ hasText: 'The Stub Band' });
    await card.click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
    await expect(page.locator('.detail-head__title')).toContainText('The Stub Band');

    // Open the Fix dialog on the on-disk album.
    const albumRow = page.locator('.child-row').filter({ hasText: 'Stub Sessions' });
    await expect(albumRow).toContainText('On disk');
    await albumRow.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix The Stub Band' });
    await expect(dialog).toBeVisible();

    // Music excludes 'Missing subtitles' (Bazarr covers movies/TV only) — but keeps the rest.
    await expect(dialog.getByRole('radio', { name: 'Missing subtitles' })).toHaveCount(0);
    await expect(dialog.getByRole('radio', { name: 'Wrong language' })).toBeVisible();
  });
});
