// Named to run after library.spec.ts (the suite is serial, alphabetical): this spec writes repair and search events on
// Breaking Prod, and library.spec.ts asserts that title's newest timeline event.
// ADR-109 C-02 / ADR-110 C-03, C-04 / DESIGN-055 D-04, D-05 (PLAN-077 P4) end to end — the Episode Re-map, against the
// stub *arr's re-map season (POST /_stub/remap: Breaking Prod Season 3, whose library files follow Sonarr 4.0.20.3012's
// ManualImport and RenameFiles semantics):
//   • A Title Check flag (D-05): the real `title-check` sync judges the season's import history; the episode whose file
//     name says it is another episode shows the flag on its row, and "Move it" opens the guide at the preview of that one
//     move. Confirmed, the file is re-linked to the episode its name says and renamed; nothing is deleted.
//   • Case A (AC-40): a member's season Fix chooses "They're all off by one" from E11, one later, to the end. The preview
//     lists the seven moves highest first, what each file's name says, the episodes left empty, and that nothing is
//     downloaded or deleted, with nothing to tick. Confirmed, seven ManualImports land highest first, one rename, no
//     file orphaned or deleted; E11 is left empty and offered Force Search; BiOMA is offered the Mislabel Block, which
//     saves a "must not contain" term in Sonarr.
//   • Staff see the term on /admin/fixes and remove it (the inline two-step confirm).
// The `episode_remap` remedy is switched on through the admin card for this file only and switched off afterwards, and
// the stub is reset, so no later spec sees the guide, the season or the term.
//
// NB: the file name keeps this suite alphabetically BEFORE library.spec.ts; the Repair Requests it lands on Breaking Prod
// are completed (not open) and are not Fix requests, so library.spec's /admin/fixes and timeline assertions are unmoved.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  REMAP_MISLABEL_GROUP,
  remapEpisodeIdFor,
  type RecordedArrWrite,
  type RemapStubFile,
} from './support/stub-arr';

const REMEDY_LABEL = /Move files onto the right episodes/;

async function stubArr(path: string, body?: unknown): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub-arr ${path} failed: ${res.status}`);
}

async function arrCalls(): Promise<RecordedArrWrite[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-arr calls fetch failed: ${res.status}`);
  return ((await res.json()) as { calls: RecordedArrWrite[] }).calls;
}

interface RemapSeasonState {
  episodes: Array<{ id: number; episodeNumber: number; hasFile: boolean; episodeFileId?: number }>;
  files: Array<Pick<RemapStubFile, 'id' | 'relativePath' | 'size'>>;
  orphaned: string[];
}

async function remapSeason(): Promise<RemapSeasonState> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/remap`);
  if (!res.ok) throw new Error(`stub-arr remap read failed: ${res.status}`);
  return (await res.json()) as RemapSeasonState;
}

/** The file now on episode `n` of the re-map season, or null. */
function fileOn(state: RemapSeasonState, n: number) {
  const ep = state.episodes.find((e) => e.episodeNumber === n);
  if (!ep?.hasFile) return null;
  return state.files.find((f) => f.id === ep.episodeFileId) ?? null;
}

async function stageRemapSeason(): Promise<void> {
  await stubArr('/_stub/reset');
  await stubArr('/_stub/remap', { on: true });
}

/** Run the real hourly Title Check once against the stub (it reads the season's import history). */
function runTitleCheck(): void {
  const env = readRuntimeEnv();
  const run = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=title-check'],
    { env: { ...process.env, ...env }, stdio: 'inherit', cwd: process.cwd() },
  );
  expect(run.status, 'the title-check sync must succeed').toBe(0);
}

/** Switch the `episode_remap` remedy through the admin card (audited, one Save). */
async function setRemap(page: Page, on: boolean): Promise<void> {
  await page.goto('/admin/fixes');
  const card = page.locator('.repair-guide-settings');
  await expect(card.getByRole('heading', { name: 'Repair Guide' })).toBeVisible();
  const box = card.getByRole('checkbox', { name: REMEDY_LABEL });
  if (on) await box.check();
  else await box.uncheck();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved.');
}

async function asAdmin(browser: Browser, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, 'admin');
    await run(page);
  } finally {
    await context.close();
  }
}

async function openSeasonThree(page: Page) {
  await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
  await page.waitForURL('/library');
  await page.getByRole('tab', { name: 'TV' }).click();
  await page.locator('.media-card').filter({ hasText: 'Breaking Prod' }).click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await expect(page.locator('.detail-head__title')).toContainText('Breaking Prod');
  // The episode list is read live from Sonarr, so Season 3 is there while the re-map fixtures are on.
  const section = page.locator('.season').filter({ hasText: 'Season 3' });
  await section.locator('.season__title').click();
  await expect(section).toHaveJSProperty('open', true);
  return section;
}

/** The dialog fits a phone and a desktop: no sideways page scroll, the box inside the viewport. Captured for review. */
async function checkWidths(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const [label, w, h] of [
    ['desktop', 1280, 900],
    ['390', 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    const box = await page.getByRole('dialog').boundingBox();
    expect(box, label).not.toBeNull();
    expect(box!.x, label).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, label).toBeLessThanOrEqual(w + 0.5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, label).toBeLessThanOrEqual(0);
    const path = testInfo.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`${name}-${label}`, { path, contentType: 'image/png' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const manualImports = (calls: RecordedArrWrite[]) =>
  calls
    .filter((c) => c.path === '/command' && (c.body as { name?: string }).name === 'ManualImport')
    .map((c) => c.body as { importMode: string; files: Array<{ episodeIds: number[]; episodeFileId: number; path: string }> });

test.describe.configure({ mode: 'serial' });

test.describe('Episode Re-map (ADR-109 C-02 / DESIGN-055 D-04, D-05, PLAN-077 P4)', () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, (page) => setRemap(page, true));
  });

  test.afterAll(async ({ browser }) => {
    await stubArr('/_stub/reset');
    // Later specs expect today's Fix.
    await asAdmin(browser, (page) => setRemap(page, false));
  });

  test('a Title Check flag opens the one move its file name points at, and the file moves (D-05)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageRemapSeason();
    runTitleCheck();
    await signIn(page, 'member');
    const season = await openSeasonThree(page);

    const row = season.locator('.child-row').filter({ hasText: 'S03E02 · Disney Plus' });
    const flag = row.getByTestId('title-check-flag');
    await expect(flag).toContainText("This file's name says it's S03E01 · All You Can Fit", { timeout: 30_000 });
    await expect(season.locator('.season__head')).toContainText('may be misplaced');
    const rowShot = testInfo.outputPath('remap-flag-row.png');
    await season.screenshot({ path: rowShot });
    await testInfo.attach('remap-flag-row', { path: rowShot, contentType: 'image/png' });
    await flag.getByRole('button', { name: 'Move it' }).click();

    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
    await expect(dialog.getByRole('heading', { name: 'Here’s what will happen' })).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('The file on S03E02 · Disney Plus moves to S03E01 · All You Can Fit.');
    await expect(dialog).toContainText('Its name says All You Can Fit.');
    await expect(dialog).toContainText('Nothing is downloaded or deleted.');
    await expect(dialog.locator('.repair-guide__group').filter({ hasText: 'Left empty' })).toContainText('S03E02 · Disney Plus');
    // Nothing is gone afterwards, so nothing is ticked.
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    expect(manualImports(await arrCalls())).toEqual([]);
    await checkWidths(page, testInfo, 'remap-flag-preview');

    await dialog.getByRole('button', { name: 'Move 1 file' }).click();
    await expect(dialog).toContainText('Moved 1 file. It is on the right episode now.', { timeout: 30_000 });

    // One move onto E01, of the file on E02, then a rename; nothing deleted, nothing orphaned.
    const calls = await arrCalls();
    const imports = manualImports(calls);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ importMode: 'move', files: [{ episodeIds: [remapEpisodeIdFor(1)], episodeFileId: 3402 }] });
    expect(calls.filter((c) => (c.body as { name?: string } | undefined)?.name === 'RenameFiles')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const state = await remapSeason();
    expect(state.orphaned).toEqual([]);
    expect(fileOn(state, 2)).toBeNull();
    expect(fileOn(state, 1)?.relativePath).toContain('S03E01 - All You Can Fit');
    // A single move is not a pattern: no Mislabel offer.
    await expect(dialog).not.toContainText('from filing this show again');

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('Case A: a member moves a season that is off by one, and nothing is lost (AC-40)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageRemapSeason();
    await signIn(page, 'member');
    const season = await openSeasonThree(page);
    await season.locator('.season__head').getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });

    // "What's wrong?" offers the shift (the season guard is off here, so it is the season's first question).
    await dialog.getByRole('radio', { name: /They're all off by one/ }).check();
    await dialog.getByRole('button', { name: 'Next' }).click();

    await expect(dialog.getByRole('heading', { name: 'Which files are off by one?' })).toBeVisible({ timeout: 30_000 });
    await dialog.getByLabel('The first episode that plays the wrong one').selectOption({ label: 'S03E11 · Prank Callers' });
    await dialog.getByRole('radio', { name: /The next episode/ }).check();
    await expect(dialog.getByLabel('Up to which episode')).toHaveValue('');
    await checkWidths(page, testInfo, 'remap-shift-question');
    await dialog.getByRole('button', { name: 'Next' }).click();

    // The preview: every move in the order it runs (highest first), what each name says, what is left empty.
    await expect(dialog.getByRole('heading', { name: 'Here’s what will happen' })).toBeVisible({ timeout: 30_000 });
    const moves = dialog.getByRole('list', { name: 'The moves, in the order they run' }).locator('> li');
    await expect(moves).toHaveCount(7);
    await expect(moves.first()).toContainText('The file on S03E18 · Thats Funny moves to S03E19 · Cool Boss.');
    await expect(moves.first()).toContainText('Its name says Cool Boss.');
    await expect(moves.last()).toContainText('The file on S03E11 · Prank Callers moves to S03E12 · Secret Menu Item.');
    const order = (await moves.allTextContents()).map((t) => /The file on S03E(\d+)/.exec(t)?.[1]);
    expect(order).toEqual(['18', '17', '16', '15', '14', '13', '11']);
    const leftEmpty = dialog.locator('.repair-guide__group').filter({ hasText: 'Left empty' });
    await expect(leftEmpty).toContainText('S03E11 · Prank Callers');
    await expect(leftEmpty).toContainText('S03E13 · Time Out');
    await expect(dialog).toContainText('Nothing is downloaded or deleted.');
    await expect(dialog).toContainText('Plex keeps watched marks with the episode number');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    expect(manualImports(await arrCalls())).toEqual([]);
    await checkWidths(page, testInfo, 'remap-shift-preview');

    await dialog.getByRole('button', { name: 'Move 7 files' }).click();
    await expect(dialog).toContainText('Moved 7 files. Each one is on the right episode now.', { timeout: 60_000 });

    // Seven ManualImports, highest first, each onto a free slot; one rename; nothing deleted, nothing orphaned.
    const calls = await arrCalls();
    const imports = manualImports(calls);
    expect(imports.map((b) => b.importMode)).toEqual(Array(7).fill('move'));
    expect(imports.map((b) => b.files[0]!.episodeIds)).toEqual(
      [19, 18, 17, 16, 15, 14, 12].map((n) => [remapEpisodeIdFor(n)]),
    );
    expect(calls.filter((c) => (c.body as { name?: string } | undefined)?.name === 'RenameFiles')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const state = await remapSeason();
    expect(state.orphaned).toEqual([]);
    expect(fileOn(state, 11)).toBeNull();
    expect(fileOn(state, 13)).toBeNull();
    for (const [was, now] of [[11, 12], [13, 14], [14, 15], [15, 16], [16, 17], [17, 18], [18, 19]] as const) {
      expect(fileOn(state, now)?.relativePath, `E${now}`).toContain(`S03E${now} - `);
      expect(fileOn(state, now)?.size, `E${now} holds the file that was on E${was}`).toBe(was === 11 ? 1_073_741_811 : 1_073_741_800 + was);
    }

    // E11 is left empty and offered Force Search (the same search as the title page: one EpisodeSearch).
    const vacated = dialog.locator('.remap-guide__vacated-row').filter({ hasText: 'S03E11 · Prank Callers' });
    await vacated.getByRole('button', { name: 'Force Search' }).click();
    await expect
      .poll(async () =>
        (await arrCalls()).some(
          (c) =>
            (c.body as { name?: string } | undefined)?.name === 'EpisodeSearch' &&
            JSON.stringify((c.body as { episodeIds?: number[] }).episodeIds) === JSON.stringify([remapEpisodeIdFor(11)]),
        ),
      )
      .toBe(true);
    await expect(vacated.getByRole('button', { name: 'Force Search' })).toHaveCount(0);

    // The Mislabel offer: BiOMA filed every moved file, so blocking it for this show is offered and saved in Sonarr.
    const offer = dialog.locator('.remap-guide__offer');
    await expect(offer).toContainText(`Stop ${REMAP_MISLABEL_GROUP} from filing this show again`);
    await offer.getByRole('button', { name: `Block ${REMAP_MISLABEL_GROUP} for this show` }).click();
    await expect(offer.getByRole('status')).toHaveText(`Saved. Sonarr will skip ${REMAP_MISLABEL_GROUP}'s releases of this show.`, {
      timeout: 30_000,
    });
    const env = readRuntimeEnv();
    const profiles = (await (await fetch(`${env.STUB_ARR_URL}/_stub/release-profiles`)).json()) as {
      sonarr: Array<{ name?: string; ignored?: string[] }>;
    };
    const managed = profiles.sonarr.find((p) => p.name === 'haynesnetwork: mislabelled releases (managed, do not edit)');
    // One "must not contain" term for this show and this group (the term is a case-insensitive pattern, lowercased).
    expect(managed?.ignored?.some((t) => t.includes('breaking') && t.includes(REMAP_MISLABEL_GROUP.toLowerCase()))).toBe(true);

    await checkWidths(page, testInfo, 'remap-shift-result');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('staff see the Mislabel Block term and remove it, and the Title Check census (D-05)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, 'admin');
    await page.goto('/admin/fixes');

    const census = page.locator('.repair-admin-card').filter({ has: page.getByRole('heading', { name: 'Title Check' }) });
    await expect(census).toContainText('Names another episode');

    const card = page.locator('.repair-admin-card').filter({ has: page.getByRole('heading', { name: 'Mislabel Block' }) });
    const term = card.locator('.mislabel-terms__row').filter({ hasText: REMAP_MISLABEL_GROUP });
    await expect(term).toContainText('Breaking Prod');
    await expect(term.getByRole('link', { name: 'Breaking Prod' })).toHaveAttribute('href', /\/library\/[0-9a-f-]{36}$/);
    for (const [name, section] of [['mislabel-card', card], ['title-check-card', census]] as const) {
      const shot = testInfo.outputPath(`${name}.png`);
      await section.screenshot({ path: shot });
      await testInfo.attach(name, { path: shot, contentType: 'image/png' });
    }
    const remove = term.getByRole('button', { name: /Remove the block on BiOMA/ });
    await remove.click();
    await expect(term.getByRole('button', { name: /Confirm removing the block on BiOMA/ })).toHaveText('Confirm remove');
    await page.waitForTimeout(350);
    await term.getByRole('button', { name: /Confirm removing the block on BiOMA/ }).click();
    await expect(card.locator('.mislabel-terms__row').filter({ hasText: REMAP_MISLABEL_GROUP })).toHaveCount(0, { timeout: 30_000 });
    await expect(card).toContainText('ended term');
  });
});
