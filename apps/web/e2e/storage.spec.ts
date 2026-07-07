// ADR-030 / DESIGN-013 D-05 (PLAN-013) — the /admin/storage page against the stubbed *arr
// /diskspace route + the seeded space_targets (HaynesTower 80). Journeys:
//   • both physical arrays render with the stub-derived % + capacity copy and the target tick;
//   • the inline targets editor round-trips (optimistic tick move, persisted after reload) and is
//     reflow-free (ADR-015);
//   • reclaim is production-faithfully EMPTY (no batch has swept yet — trash-batches.spec runs
//     later) with the first-class empty state, and the window switcher redrives the query;
//   • the Grafana trend surface is a DEEP LINK (never an iframe — ADR-030 C-04);
//   • the page fits a phone (AC-10 spot check at 390×844).
// Leaves the seeded target back at 80 so later specs (and re-runs) see the seeded state.
import { test, expect, type Page } from '@playwright/test';
import { expectViewportFit, signIn } from './support/helpers';

async function openStorage(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.locator('.admin-nav').getByRole('link', { name: 'Storage' }).click();
  await page.waitForURL('/admin/storage');
  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
}

/** Save the HaynesTower target and wait for the persisted round-trip ("Saved" status). */
async function saveTarget(page: Page, value: string): Promise<void> {
  await page.getByTestId('target-input-haynestower').fill(value);
  await page.getByTestId('target-save-haynestower').click();
  await expect(page.getByTestId('array-haynestower').getByRole('status')).toHaveText('Saved');
}

test.describe('storage metrics (ADR-030 HYBRID, native half)', () => {
  test.describe.configure({ mode: 'serial' });

  test('utilization: both arrays render the stub-derived % · capacity · target tick', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openStorage(page);

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
    await openStorage(page);

    const meter = page.getByTestId('array-haynestower').getByRole('meter');
    const before = await meter.boundingBox();

    await saveTarget(page, '85');
    // The tick moved (optimistically, then confirmed) — and ONLY recolored/slid: no reflow.
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

  test('reclaim: graceful empty state + window switcher redrives the report', async ({ page }) => {
    await signIn(page, 'admin');
    await openStorage(page);

    // Production-faithful: nothing has swept yet, and that is a first-class state.
    await expect(page.getByTestId('reclaim-headline')).toHaveText(
      'Reclaimed 0 B across 0 items · last 90 days',
    );
    const empty = page.getByTestId('reclaim-empty');
    await expect(empty).toContainText('Reclaim accrues when Leaving-Soon batches expire and sweep');
    // No bars/curve/table pretending to be data.
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

  test('Grafana trend is a deep link (new tab, same Authentik SSO) — never an embed', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openStorage(page);

    const link = page.getByTestId('grafana-trend-link');
    await expect(link).toHaveAttribute(
      'href',
      'https://grafana.haynesops.com/d/media-storage-utilization',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toContainText('Free-space trend & history');
    // C-04: the dashboard is linked out, not framed in.
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('phone (390×844): cards, editor and reclaim fit with no page-level overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await page.goto('/admin/storage');
    await expect(page.getByTestId('array-stats-haynestower')).toBeVisible();
    await expect(page.getByTestId('reclaim-empty')).toBeVisible();
    await expectViewportFit(page);
  });
});
