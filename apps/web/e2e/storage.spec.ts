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
  await page.getByTestId('target-input-haynestower').fill(value);
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

  test('trend window switcher redrives storage.trend without reflow (ADR-015)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openTab(page, 'storage');
    await expect(page.getByTestId('trend-chart')).toBeVisible();
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
    // The trend chart stays legible + inside the viewport at phone width too.
    await expect(page.getByTestId('trend-chart')).toBeVisible();
    await expect(page.getByTestId('trend-legend')).toBeVisible();
    await expectViewportFit(page);
    await openTab(page, 'reclaim');
    await expect(page.getByTestId('reclaim-empty')).toBeVisible();
    await expectViewportFit(page);
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
});
