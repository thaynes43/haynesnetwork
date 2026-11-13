// ADR-030/031/034 · IA reshuffle (2026-07-09, build B) — storage / policy / reclaim / notifications
// now live on the tabbed Trash Settings hub (/settings/trash), NOT the retired /admin/storage page.
// The storage.* routers/procedures are unchanged; only the UI moved. Journeys:
//   • /admin/storage REDIRECTS to /settings/trash?tab=storage (old deep links stay alive);
//   • Storage tab: both physical arrays render with the stub-derived % + capacity + target tick; the
//     inline targets editor round-trips (optimistic tick move, persisted) and is reflow-free (ADR-015);
//     the free-space trend is the NATIVE chart (ADR-030 C-04 amendment 2026-07-09): both series
//     lines + the dashed target floor + the values legend render off the stub Prometheus, the
//     window switcher redrives storage.trend without reflow, Prometheus-down degrades to a note
//     (never a crashed tab), and Grafana survives only as the LAN footnote link (never an iframe);
//   • the Capacity Forecast (DESIGN-013 D-09, story 819) sits above the trend, one panel per array:
//     the target and 100% dates in words beside a plot of the projection and its marks, "no
//     forecast" with its reason, a saved target moving the forecast in place (ADR-015), the
//     set-aside jumps named from the recorded fixture, and the same panels when Prometheus is down;
//   • Reclaim tab: production-faithfully EMPTY, and the window switcher redrives the query;
//   • the Storage tab fits a phone (AC-10 spot check at 390×844).
// Leaves the seeded target back at 80 (and the stub Prometheus back in 'ok' mode) so later specs
// and re-runs see the seeded state.
import { test, expect, type Page } from '@playwright/test';
import { armAndConfirm, expectViewportFit, signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';

/** Script the stub Prometheus (ok ⇄ down) — the trend's degrade journey. */
async function setPrometheusMode(mode: 'ok' | 'down'): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_PROMETHEUS_URL}/_stub/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`stub prometheus state change failed: HTTP ${res.status}`);
}

/** Pick the stub Prometheus's free-space fixture (DESIGN-013 D-09; `steady` is the default). */
async function setFreespace(freespace: 'steady' | 'recorded' | 'draining' | 'short'): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_PROMETHEUS_URL}/_stub/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ freespace }),
  });
  if (!res.ok) throw new Error(`stub prometheus fixture change failed: HTTP ${res.status}`);
}

/** Open a tab of the Trash Settings hub directly (admins pass the trash-edit page gate). */
async function openTab(page: Page, tab: 'general' | 'storage' | 'reclaim' | 'rules'): Promise<void> {
  await page.goto(`/settings/trash?tab=${tab}`);
  await expect(page.getByRole('tab', { name: tabLabel(tab) })).toHaveAttribute('aria-selected', 'true');
}

function tabLabel(tab: string): string {
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

/** Save the HaynesTower target and wait for the persisted round-trip ("Saved" status). */
async function saveTarget(page: Page, value: string): Promise<void> {
  const input = page.getByTestId('target-input-haynestower');
  // The input is empty until the targets query lands, which also means React has hydrated the form. A fill()
  // before that is overwritten by the hydration render (draft never set, Save stays disabled, the click then
  // times out: the storage.spec flake of 2026-10-05), so wait for the stored value first.
  await expect(input).not.toHaveValue('');
  await input.fill(value);
  await expect(page.getByTestId('target-save-haynestower')).toBeEnabled();
  await page.getByTestId('target-save-haynestower').click();
  await expect(page.getByTestId('array-haynestower').getByRole('status')).toHaveText('Saved');
}

test.describe('storage metrics (ADR-030 HYBRID, native half) — on the Trash Settings hub', () => {
  test.describe.configure({ mode: 'serial' });

  test('/admin/storage redirects to the Storage tab (old deep links stay alive)', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/storage');
    await page.waitForURL('**/settings/trash?tab=storage');
    await expect(page.getByRole('tab', { name: 'Storage' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('array-haynestower')).toBeVisible();
  });

  test('utilization: both arrays render the stub-derived % · capacity · target tick', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');

    // HaynesTower: 112.43/529.96 TB ⇒ 78.8% used (the owner's cross-check number), target 80 seeded.
    const tower = page.getByTestId('array-haynestower');
    await expect(tower.getByTestId('array-stats-haynestower')).toHaveText(
      '78.8% used · 112.4 TB free of 530 TB',
    );
    await expect(tower.getByRole('meter')).toHaveAttribute('aria-valuenow', '78.8');
    const tick = page.getByTestId('target-tick-haynestower');
    await expect(tick).toHaveAttribute('data-target', '80');
    await expect(tick).toHaveAttribute('style', /left: 80%/);
    await expect(tower.getByTestId('target-input-haynestower')).toHaveValue('80');

    // Music (CephFS): 130.45/174.84 TB ⇒ 25.4% used; no target slug ⇒ no tick, no editor.
    const ceph = page.getByTestId('array-cephfs');
    await expect(ceph.getByTestId('array-stats-cephfs')).toHaveText(
      '25.4% used · 130.4 TB free of 174.8 TB',
    );
    await expect(ceph.getByRole('meter')).toHaveAttribute('aria-valuenow', '25.4');
    await expect(page.getByTestId('target-tick-cephfs')).toHaveCount(0);
    await expect(ceph.getByText('No space target for this array yet.')).toBeVisible();
  });

  test('targets editor: optimistic tick move, persisted round-trip, reflow-free (ADR-015)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');

    const meter = page.getByTestId('array-haynestower').getByRole('meter');
    const before = await meter.boundingBox();

    await saveTarget(page, '85');
    await expect(page.getByTestId('target-tick-haynestower')).toHaveAttribute('data-target', '85');
    const after = await meter.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);

    // Persisted: a fresh load re-reads space_targets through storage.targets.get.
    await page.reload();
    await expect(page.getByTestId('target-input-haynestower')).toHaveValue('85');
    await expect(page.getByTestId('target-tick-haynestower')).toHaveAttribute('data-target', '85');

    // Restore the seeded 80 (audited server-side like any other set) so later runs see seed state.
    await saveTarget(page, '80');
    await expect(page.getByTestId('target-tick-haynestower')).toHaveAttribute('data-target', '80');
  });

  test('reclaim tab: graceful empty state + window switcher redrives the report', async ({ page }) => {
    await signIn(page, 'admin');
    await openTab(page, 'reclaim');

    // Production-faithful: nothing has swept yet, and that is a first-class state.
    await expect(page.getByTestId('reclaim-headline')).toHaveText(
      'Reclaimed 0 B across 0 items · last 90 days',
    );
    const empty = page.getByTestId('reclaim-empty');
    await expect(empty).toContainText('Reclaim accrues when Leaving-Soon batches expire and sweep');
    await expect(page.getByTestId('reclaim-bars')).toHaveCount(0);
    await expect(page.getByTestId('reclaim-batches')).toHaveCount(0);

    // Window switcher: each option refires storage.reclaim and relabels the headline.
    const seg = page.getByRole('group', { name: 'Reclaim window' });
    await seg.getByRole('button', { name: '1y' }).click();
    await expect(page.getByTestId('reclaim-headline')).toHaveText(
      'Reclaimed 0 B across 0 items · last year',
    );
    await seg.getByRole('button', { name: 'All' }).click();
    await expect(page.getByTestId('reclaim-headline')).toHaveText(
      'Reclaimed 0 B across 0 items · all time',
    );
    await seg.getByRole('button', { name: '30d' }).click();
    await expect(page.getByTestId('reclaim-headline')).toHaveText(
      'Reclaimed 0 B across 0 items · last 30 days',
    );
  });

  test('free-space trend: native chart — series lines, dashed target floor, values legend; Grafana demoted to a footnote', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');

    const trend = page.getByTestId('storage-trend');
    await expect(trend.getByRole('heading', { name: 'Free-space trend' })).toBeVisible();

    // Both physical arrays draw a line (the stub emits radarr+sonarr+lidarr series; the shared
    // HaynesTower array dedupes to ONE line) and the seeded 80% target renders as the dashed
    // free-bytes floor: 20% free of 529.96 TB = 106 TB.
    await expect(page.getByTestId('trend-chart')).toBeVisible();
    await expect(page.getByTestId('trend-line-haynestower')).toBeVisible();
    // The music pool holds steady in the stub — a FLAT path has a zero-height bounding box, which
    // Playwright's toBeVisible treats as hidden even though the 2px stroke renders. Assert the
    // drawn geometry instead: attached, with a real multi-point line in its `d`.
    const cephLine = page.getByTestId('trend-line-cephfs');
    await expect(cephLine).toBeAttached();
    await expect(cephLine).toHaveAttribute('d', /^M [\d.]+ [\d.]+ L /);
    await expect(page.getByTestId('trend-target')).toBeVisible();
    await expect(page.getByTestId('trend-target-label')).toHaveText('Target · 106 TB free');

    // Direct end-labels + the legend carry the current readings — no hover needed (mobile-first).
    await expect(page.getByTestId('trend-endlabel-haynestower')).toHaveText('HaynesTower');
    await expect(page.getByTestId('trend-endlabel-cephfs')).toHaveText('Music (CephFS)');
    const legend = page.getByTestId('trend-legend');
    await expect(legend).toContainText('HaynesTower · 112.4 TB free');
    await expect(legend).toContainText(/Music \(CephFS\) · 130\.[45] TB free/);
    await expect(legend).toContainText('Target · 106 TB free');

    // The old dashboard is a muted footnote LINK now (LAN power tool) — still never an iframe.
    const link = page.getByTestId('grafana-trend-link');
    await expect(link).toHaveAttribute(
      'href',
      'https://grafana.haynesops.com/d/media-storage-utilization',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('capacity forecast: one panel per array above the trend — the dates in words, the projection and its marks, and why there is no forecast', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');

    const card = page.getByTestId('storage-forecast');
    await expect(card.getByRole('heading', { name: 'Capacity forecast' })).toBeVisible();
    await expect(card).toContainText('An estimate, not a schedule.');

    // HaynesTower in the stub: 112.43 TB free, falling 7.57 TB in 90 days (84 GB a day), under its
    // 80% target (106 TB free). Use is rising and the array is still under target, so BOTH dates
    // show: the target in 6.44 TB / 84.1 GB = 77 days, 100% in 112.43 TB / 84.1 GB = 3.66 years.
    const tower = page.getByTestId('forecast-haynestower');
    await expect(tower).toHaveAttribute('data-tone', 'filling');
    await expect(page.getByTestId('forecast-chip-haynestower')).toHaveText('Filling');
    await expect(page.getByTestId('forecast-sentence-haynestower')).toHaveText(
      'Filling by about 84 GB a day (590 GB a week).',
    );
    const target = page.getByTestId('forecast-target-haynestower');
    await expect(target).toContainText('Target (80% used)');
    await expect(target).toContainText(/[A-Z][a-z]{2} 20\d\d/); // a month: it is over 60 days away
    await expect(target).toContainText(/over target in about \d months/);
    const full = page.getByTestId('forecast-full-haynestower');
    await expect(full).toContainText('Full (100% used)');
    await expect(full).toContainText(/20\d\d/); // a year only: it is over 2 years away
    await expect(full).toContainText('in about 3.5 years');

    // The plot: the history, then the projection from today's level down to zero (y = 159 of the
    // 160px plot), a mark where it meets the dashed target floor and one where it meets zero.
    await expect(page.getByTestId('forecast-plot-haynestower')).toBeVisible();
    await expect(page.getByTestId('forecast-history-haynestower')).toHaveAttribute('d', /^M 0 [\d.]+ L /);
    await expect(page.getByTestId('forecast-projection-haynestower')).toHaveAttribute(
      'd',
      /^M [\d.]+ [\d.]+ L [\d.]+ 159$/,
    );
    await expect(page.getByTestId('forecast-mark-target-haynestower')).toBeVisible();
    await expect(page.getByTestId('forecast-mark-full-haynestower')).toBeVisible();
    await expect(page.getByTestId('forecast-target-line-haynestower')).toBeVisible();
    await expect(tower.getByText('Target · 106 TB free')).toBeVisible();
    await expect(page.getByTestId('forecast-notes-haynestower')).toHaveCount(0); // a straight fill: no jump

    // The music pool holds level in the stub: no forecast, and the panel says why. The history is
    // still drawn (a flat path, so assert it is attached, as the trend test does).
    const music = page.getByTestId('forecast-cephfs');
    await expect(music).toHaveAttribute('data-tone', 'steady');
    await expect(page.getByTestId('forecast-chip-cephfs')).toHaveText('Steady');
    await expect(page.getByTestId('forecast-sentence-cephfs')).toHaveText(
      'No forecast: free space has not clearly risen or fallen over the last 90 days, so there is no date to predict.',
    );
    await expect(page.getByTestId('forecast-target-cephfs')).toContainText('Not set');
    await expect(page.getByTestId('forecast-full-cephfs')).toContainText('No date');
    await expect(page.getByTestId('forecast-full-cephfs')).toContainText('holding steady');
    await expect(page.getByTestId('forecast-history-cephfs')).toBeAttached();
    await expect(page.getByTestId('forecast-projection-cephfs')).toHaveCount(0);
    await expect(page.getByTestId('forecast-mark-full-cephfs')).toHaveCount(0);

    // The key names both directions (the colours are never the only cue), and the card sits
    // above the free-space trend.
    const legend = page.getByTestId('forecast-legend');
    await expect(legend).toContainText('Projection while filling');
    await expect(legend).toContainText('Projection while freeing up');
    const cardBox = (await card.boundingBox())!;
    const trendBox = (await page.getByTestId('storage-trend').boundingBox())!;
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(trendBox.y);
  });

  test('capacity forecast: a saved target moves the target date and the dashed floor in place (ADR-015)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');
    await expect(page.getByTestId('forecast-mark-target-haynestower')).toBeVisible();
    const trend = page.getByTestId('storage-trend');
    const before = (await trend.boundingBox())!;

    try {
      // 75% used is a 132.49 TB floor: the array (112.43 TB free) is now OVER target and still
      // filling, so the target date gives way to "over now" and only the 100% date is left.
      await saveTarget(page, '75');
      const target = page.getByTestId('forecast-target-haynestower');
      await expect(target).toContainText('Target (75% used)');
      await expect(target).toContainText('Over now');
      await expect(target).toContainText('by 20.1 TB, and rising');
      await expect(page.getByTestId('forecast-mark-target-haynestower')).toHaveCount(0);
      await expect(page.getByTestId('forecast-mark-full-haynestower')).toBeVisible();
      await expect(
        page.getByTestId('forecast-haynestower').getByText('Target · 132.5 TB free'),
      ).toBeVisible();

      // The card below did not move: the tiles and the plot swapped inside a fixed footprint.
      const after = (await trend.boundingBox())!;
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    } finally {
      await saveTarget(page, '80'); // the seeded target, for later specs and re-runs
    }
    await expect(page.getByTestId('forecast-target-haynestower')).toContainText('Target (80% used)');
    await expect(page.getByTestId('forecast-mark-target-haynestower')).toBeVisible();
  });

  test('capacity forecast: set-aside jumps are named, use falling shows no 100% date, and a short history says what it lacks', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    try {
      // The history recorded 2026-11-13 (DESIGN-013 D-08), replayed by the stub: HaynesTower fills
      // at 212 GB a day with two late rises set aside; the music pool fills at 39 GB a day with
      // three drops and three rises set aside, which outweigh that pace (the Q-03 case).
      await setFreespace('recorded');
      await openTab(page, 'storage');
      await expect(page.getByTestId('forecast-sentence-haynestower')).toHaveText(
        'Filling by about 210 GB a day (1.5 TB a week).',
      );
      const towerNotes = page.getByTestId('forecast-notes-haynestower');
      await expect(towerNotes).toContainText('Free space jumped up by 9.9 TB in the last 90 days (2 jumps');
      await expect(towerNotes).toContainText('The projection treats them as one-offs');
      await expect(towerNotes).not.toContainText('Read this forecast with care');

      await expect(page.getByTestId('forecast-sentence-cephfs')).toHaveText(
        'Filling by about 39 GB a day (280 GB a week).',
      );
      const musicNotes = page.getByTestId('forecast-notes-cephfs');
      await expect(musicNotes).toContainText('Read this forecast with care');
      await expect(musicNotes).toContainText(
        'dropped suddenly by 11.9 TB (3 drops) and jumped up by 3.8 TB (3 jumps)',
      );
      await expect(page.getByTestId('forecast-target-cephfs')).toContainText('Not set');
      await expect(page.getByTestId('forecast-mark-full-cephfs')).toBeVisible();

      // Use falling: free space rises toward nothing it has to reach (the array is under target),
      // so there is a pace and no date, and never a 100% date.
      await setFreespace('draining');
      await page.reload();
      await expect(page.getByTestId('forecast-haynestower')).toHaveAttribute('data-tone', 'draining');
      await expect(page.getByTestId('forecast-chip-haynestower')).toHaveText('Freeing up');
      await expect(page.getByTestId('forecast-sentence-haynestower')).toHaveText(
        /^Freeing up about \d+ GB a day \(\d+(\.\d)? [GT]B a week\)\.$/,
      );
      await expect(page.getByTestId('forecast-full-haynestower')).toContainText('Not ahead');
      await expect(page.getByTestId('forecast-target-haynestower')).toContainText('Under now');
      await expect(page.getByTestId('forecast-target-haynestower')).toContainText(
        '6.4 TB to spare, and growing',
      );
      await expect(page.getByTestId('forecast-projection-haynestower')).toBeAttached();
      await expect(page.getByTestId('forecast-mark-full-haynestower')).toHaveCount(0);

      // Over target and falling (a 75% target is a 132.49 TB floor): the date it is back under
      // target, with its mark on the dashed floor, and still no 100% date.
      await saveTarget(page, '75');
      const target = page.getByTestId('forecast-target-haynestower');
      await expect(target).toContainText(/back under in about \d+ (weeks|months)/);
      await expect(page.getByTestId('forecast-mark-target-haynestower')).toBeVisible();
      await expect(page.getByTestId('forecast-mark-full-haynestower')).toHaveCount(0);
      await expect(page.getByTestId('forecast-full-haynestower')).toContainText('Not ahead');
      await saveTarget(page, '80');

      // 21 days of history: under the 36 the method needs.
      await setFreespace('short');
      await page.reload();
      await expect(page.getByTestId('forecast-chip-haynestower')).toHaveText('No forecast');
      await expect(page.getByTestId('forecast-sentence-haynestower')).toHaveText(
        'No forecast yet: it needs 36 days of readings and this array has 21 so far.',
      );
      await expect(page.getByTestId('forecast-full-haynestower')).toContainText('No date yet');
      await expect(page.getByTestId('forecast-projection-haynestower')).toHaveCount(0);
    } finally {
      await setFreespace('steady'); // later specs + re-runs see the default fixture
    }
  });

  test('trend window switcher redrives storage.trend without reflow (ADR-015)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');
    await expect(page.getByTestId('trend-chart')).toBeVisible();
    // The Capacity Forecast card above (DESIGN-013 D-09) puts the trend below the first screen.
    // Bring its switcher into view first: boundingBox is relative to the viewport, so a click that
    // scrolled the page between the two measurements would read as a reflow.
    await page.getByTestId('trend-window-7d').scrollIntoViewIfNeeded();
    const before = await page.getByTestId('trend-chart').boundingBox();

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('storage.trend')),
      page.getByTestId('trend-window-7d').click(),
    ]);
    await expect(page.locator('.storage-trend__plotwrap')).toHaveAttribute('data-window', '7d');
    await expect(page.getByTestId('trend-line-haynestower')).toBeVisible();

    // The plot region kept its exact geometry — the switch dims + swaps, never reflows.
    const after = await page.getByTestId('trend-chart').boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);

    // Switching BACK hits the React Query cache (no network) — assert the swap only.
    await page.getByTestId('trend-window-30d').click();
    await expect(page.locator('.storage-trend__plotwrap')).toHaveAttribute('data-window', '30d');
  });

  test('Prometheus down ⇒ the trend degrades to a note; the meters keep working', async ({
    page,
  }) => {
    await setPrometheusMode('down');
    try {
      await signIn(page, 'admin');
      await openTab(page, 'storage');

      const note = page.getByTestId('trend-degraded');
      await expect(note).toBeVisible();
      await expect(note).toContainText('couldn’t reach Prometheus');
      await expect(page.getByTestId('trend-chart')).toHaveCount(0);
      // The forecast reads the same source: its panels stay, each saying the forecast is
      // unavailable, with no plot (DESIGN-013 D-09).
      await expect(page.getByTestId('storage-forecast')).toHaveAttribute('data-unavailable', 'true');
      await expect(page.getByTestId('forecast-sentence-haynestower')).toContainText(
        'Forecast unavailable: couldn’t reach Prometheus right now.',
      );
      await expect(page.getByTestId('forecast-full-cephfs')).toContainText('No date');
      await expect(page.getByTestId('forecast-plot-haynestower')).toHaveCount(0);
      await expect(page.getByTestId('forecast-noplot-haynestower')).toBeVisible();
      // The rest of the tab is untouched by the trend source being down (C-03 posture).
      await expect(page.getByTestId('array-stats-haynestower')).toHaveText(
        '78.8% used · 112.4 TB free of 530 TB',
      );
    } finally {
      await setPrometheusMode('ok'); // later specs + re-runs see the healthy default
    }
  });

  test('phone (390×844): the Storage + Reclaim tabs fit with no page-level overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await openTab(page, 'storage');
    await expect(page.getByTestId('array-stats-haynestower')).toBeVisible();
    // The forecast stacks its words over its plot and stays inside the viewport at phone width.
    await expect(page.getByTestId('forecast-plot-haynestower')).toBeVisible();
    await expect(page.getByTestId('forecast-full-haynestower')).toBeVisible();
    // The trend chart stays legible + inside the viewport at phone width too.
    await expect(page.getByTestId('trend-chart')).toBeVisible();
    await expect(page.getByTestId('trend-legend')).toBeVisible();
    await expectViewportFit(page);
    await openTab(page, 'reclaim');
    await expect(page.getByTestId('reclaim-empty')).toBeVisible();
    await expectViewportFit(page);
  });

  // fix/family-strip-mobile-roles (owner screenshot 2026-07-09) — the General tab was the worst
  // portrait offender: the label|control two-column rows kept desktop proportions, so the copy
  // crushed to one word per line, the Timezone select bled past the edge, and the pool-refresh
  // checkbox rendered comically large. It now stacks below 640px. Audit General + Rules at both
  // portrait bounds (the Storage + Reclaim tabs are covered above).
  test('portrait (390×844 + 430×932): the General + Rules tabs stack — no page overflow, and the pool-refresh checkbox is a normal-sized control', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    for (const [w, h] of [
      [390, 844],
      [430, 932],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });

      await openTab(page, 'general');
      await expect(page.getByTestId('trash-settings')).toBeVisible();
      // The Timezone select is reachable and INSIDE the viewport (it used to bleed past the edge).
      await expect(page.getByTestId('notify-tz')).toBeVisible();
      await expectViewportFit(page);
      // The "Enabled" checkbox is a STANDARD ~18px control now, not the native-scaled giant box.
      const cb = page.getByTestId('pool-refresh-enabled');
      await cb.scrollIntoViewIfNeeded();
      const box = (await cb.boundingBox())!;
      expect(box.width, 'the Enabled checkbox is a normal control').toBeLessThanOrEqual(28);
      expect(box.height, 'the Enabled checkbox is a normal control').toBeLessThanOrEqual(28);

      // Rules — the deletion-rules table collapses to cards with no sideways overflow.
      await openTab(page, 'rules');
      await expect(page.getByTestId('trash-rules')).toBeVisible();
      await expectViewportFit(page);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});

// ADR-031 / DESIGN-014 — the propose-only "Space policy" card + the rules-tuning / graduation block,
// now on the Storage tab. Journeys: default OFF; the enable ceremony (two-step ConfirmButton) flips it
// ON; the per-array opt-in; the tuning block renders its (production-faithful) empty state + graduation
// readiness. Leaves the policy OFF + the array opted out so later specs see the default.
test.describe('space policy (ADR-031, propose-only) — Storage tab', () => {
  test.describe.configure({ mode: 'serial' });

  test('card defaults OFF, enables via two-step confirm, opts the array in, and disables', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');

    const card = page.getByTestId('space-policy');
    await expect(card.getByRole('heading', { name: 'Space policy' })).toBeVisible();
    await expect(page.getByTestId('policy-state')).toContainText('OFF');

    // Enable is a two-step ConfirmButton (ADR-014) — it never deletes, only proposes for review.
    await armAndConfirm(page.getByTestId('policy-enable'));
    await expect(page.getByTestId('policy-state')).toContainText('ON');
    await expect(page.getByTestId('policy-disable')).toBeVisible();

    await page.getByTestId('policy-array-enable').click();
    await expect(page.getByTestId('policy-array-state')).toContainText('Opted in');

    await expect(page.getByTestId('policy-status')).toContainText('Last proposal');

    // Restore defaults for later specs: opt out, then turn the policy off.
    await page.getByTestId('policy-array-disable').click();
    await expect(page.getByTestId('policy-array-state')).toContainText('Not opted in');
    await page.getByTestId('policy-disable').click();
    await expect(page.getByTestId('policy-state')).toContainText('OFF');
  });

  test('tuning + graduation block renders (empty-state, not-yet graduation)', async ({ page }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');

    const tuning = page.getByTestId('policy-tuning');
    await expect(tuning.getByRole('heading', { name: 'Rules tuning & graduation' })).toBeVisible();
    await expect(page.getByTestId('tuning-empty')).toBeVisible();
    await expect(page.getByTestId('graduation-verdict')).toContainText('Not yet');
    await expect(page.getByTestId('graduation-verdict')).toContainText('of 3');
  });
});

// ADR-034 / DESIGN-015 (PLAN-016) — the Pushover delivery-window "Notifications" card, relocated to
// the GENERAL tab and folded into that tab's single green Save (build B). Light journey: it renders
// the all-day default 0..24 summary, an hour edit round-trips (persisted), and it is reflow-free. Leaves
// the window back at the seeded all-day default for later runs.
test.describe('notifications delivery window (ADR-034) — General tab', () => {
  test('the card lives in General and a save round-trips via the single green Save', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'general');

    const card = page.getByTestId('notify-window');
    await expect(card.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByTestId('notify-window-summary')).toContainText('All day');
    await expect(page.getByTestId('notify-start')).toHaveValue('0');
    await expect(page.getByTestId('notify-end')).toHaveValue('24');

    // Fable UX regression guard (owner 2026-07-09): the delivery-window From/To hour inputs and the
    // Timezone select use the SHARED themed input surface — never the browser-default WHITE that stood
    // out on the dark UI (same defect class as the earlier Bulletin-composer fix). Their background must
    // resolve to a themed color, never `rgb(255, 255, 255)` / transparent, in whichever theme runs.
    for (const control of [
      page.getByTestId('notify-start'),
      page.getByTestId('notify-end'),
      page.getByTestId('notify-tz'),
    ]) {
      const bg = await control.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgb(255, 255, 255)');
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    }

    // Narrow to a real quiet-hours window and save — the audited storage.notify.window.set round-trips
    // through the General tab's single green Save (not a per-card Save).
    await page.getByTestId('notify-start').fill('18');
    await page.getByTestId('notify-end').fill('22');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('storage.notify.window.set') && r.request().method() === 'POST',
      ),
      page.getByTestId('general-save').click(),
    ]);
    await page.reload();
    await expect(page.getByTestId('notify-start')).toHaveValue('18');
    await expect(page.getByTestId('notify-window-summary')).toContainText('6 PM – 10 PM');

    // Restore the all-day default so later specs/re-runs see it.
    await page.getByTestId('notify-start').fill('0');
    await page.getByTestId('notify-end').fill('24');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('storage.notify.window.set') && r.request().method() === 'POST',
      ),
      page.getByTestId('general-save').click(),
    ]);
    await expect(page.getByTestId('notify-window-summary')).toContainText('All day');
  });

  // DESIGN-010/014 amendment (build D) — the "Refresh pool after saves" knob (the debounced post-save
  // Maintainerr rule re-execution) is part of the same consolidated General form + single green Save.
  test('the Refresh-pool-after-saves setting renders and round-trips via the single green Save', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'general');

    const row = page.getByTestId('pool-refresh-row');
    await expect(row).toBeVisible();
    await expect(row).toContainText('re-evaluate the rules');
    // Defaults: ON, 5-minute debounce.
    await expect(page.getByTestId('pool-refresh-enabled')).toBeChecked();
    await expect(page.getByTestId('pool-refresh-delay')).toHaveValue('5');

    // Change the delay and commit via the single green Save (audited trash.settings.set).
    await page.getByTestId('pool-refresh-delay').fill('8');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('trash.settings.set') && r.request().method() === 'POST',
      ),
      page.getByTestId('general-save').click(),
    ]);
    await page.reload();
    await expect(page.getByTestId('pool-refresh-delay')).toHaveValue('8');

    // Restore the 5-minute default for later specs/re-runs.
    await page.getByTestId('pool-refresh-delay').fill('5');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('trash.settings.set') && r.request().method() === 'POST',
      ),
      page.getByTestId('general-save').click(),
    ]);
    await expect(page.getByTestId('pool-refresh-delay')).toHaveValue('5');
  });

  // DESIGN-015 amendment (2026-07-09) — the "Last-call warning" knob (the configurable final Pushover
  // ping N hours before a batch's window closes) lives in the Notifications area of the same
  // consolidated General form + single green Save.
  test('the Last-call warning setting renders in Notifications and round-trips via the single green Save', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'general');

    const row = page.getByTestId('final-warning-row');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Last-call warning');
    // Defaults: ON, 2 hours before close.
    await expect(page.getByTestId('final-warning-enabled')).toBeChecked();
    await expect(page.getByTestId('final-warning-hours')).toHaveValue('2');

    // Change the lead time and commit via the single green Save (audited trash.settings.set).
    await page.getByTestId('final-warning-hours').fill('4');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('trash.settings.set') && r.request().method() === 'POST',
      ),
      page.getByTestId('general-save').click(),
    ]);
    await page.reload();
    await expect(page.getByTestId('final-warning-hours')).toHaveValue('4');

    // Restore the 2-hour default for later specs/re-runs.
    await page.getByTestId('final-warning-hours').fill('2');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('trash.settings.set') && r.request().method() === 'POST',
      ),
      page.getByTestId('general-save').click(),
    ]);
    await expect(page.getByTestId('final-warning-hours')).toHaveValue('2');
  });
});
