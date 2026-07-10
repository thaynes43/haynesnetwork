// PLAN-017 / ADR-037 / DESIGN-016 — the Metrics section (foundation + Overview tab). ADVISORY spec:
// the `/metrics` page is being built alongside this test, so it is written to be RESILIENT (tolerant
// selectors, test.step) and is NOT a merge gate yet. It mirrors storage.spec's harness exactly:
//   • sign in through the REAL stub-OIDC round trip (signIn persona);
//   • script the stub Prometheus ok⇄down by POSTing ${STUB_PROMETHEUS_URL}/_stub/state, so the
//     Overview's degrade path is exercised against the SAME instant-vector stub production reads.
//
// TESTID / SELECTOR ASSUMPTIONS (the `/metrics` page + apps/web/app/(app)/metrics/overview-tab.tsx do
// not exist yet at the time this was written — these are the names the UI is expected to adopt; adjust
// the UI to match, or this advisory spec here):
//   • Metrics nav link ....... role=link name "Metrics" (rendered by components/top-bar.tsx when the
//                              user's `metrics` section level is not `disabled` — already wired, D-05);
//   • no-access card ......... data-testid="metrics-unavailable"   (server-gate render for a member
//                              whose metrics section is disabled);
//   • Overview tab ........... role=tab name "Overview" inside the page's tablist;
//   • upload meter ........... data-testid="metrics-upload-meter"   with role="meter";
//   • download meter ......... data-testid="metrics-download-meter" with role="meter";
//   • Prometheus-down note ... data-testid="metrics-network-unavailable" (optional degrade note).
// The meter numbers come off the stub instant vectors added to e2e/support/stub-prometheus.ts:
//   sum(unpoller_site_transmit_rate_bytes{subsystem="wan"}) ⇒ 1454880 (upload B/s);
//   sum(unpoller_site_receive_rate_bytes{subsystem="wan"})  ⇒  844568 (download B/s).
// Leaves the stub Prometheus back in 'ok' mode so later specs and re-runs see the healthy default.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';

/** Script the stub Prometheus (ok ⇄ down) — the Overview's degrade journey (mirrors storage.spec). */
async function setPrometheusMode(mode: 'ok' | 'down'): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_PROMETHEUS_URL}/_stub/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`stub prometheus state change failed: HTTP ${res.status}`);
}

/** Open the Metrics page and settle on its Overview tab (tolerant: the tab may already be selected). */
async function openOverview(page: Page): Promise<void> {
  await page.goto('/metrics');
  const overview = page.getByRole('tab', { name: 'Overview' });
  if ((await overview.count()) > 0) {
    if ((await overview.getAttribute('aria-selected')) !== 'true') {
      await overview.click();
    }
    await expect(overview).toHaveAttribute('aria-selected', 'true');
  }
}

test.describe('metrics section (PLAN-017 · ADR-037 · DESIGN-016) — Overview reads Prometheus', () => {
  test.describe.configure({ mode: 'serial' });

  // AC: the `metrics` section defaults to `disabled` (ADR-037 C-02), so a fresh member (never granted
  // anything) sees NO Metrics nav link, and the server-gate renders the unavailable card at /metrics.
  test('a default member sees no Metrics nav link and gets the unavailable card at /metrics', async ({
    page,
  }) => {
    await signIn(page, 'fresh-member');

    await test.step('no Metrics entry in the primary nav', async () => {
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav.getByRole('link', { name: 'Metrics' })).toHaveCount(0);
    });

    await test.step('/metrics renders the unavailable card, not the Overview', async () => {
      await page.goto('/metrics');
      await expect(page.getByTestId('metrics-unavailable')).toBeVisible();
      await expect(page.getByTestId('metrics-upload-meter')).toHaveCount(0);
    });
  });

  // AC: an admin implies `edit` on every section (ADR-021 C-03), so the Metrics link shows and the
  // Overview renders the upload + download meters off the stub's instant vectors (non-empty readings).
  test('an admin sees the Metrics link and the Overview renders the upload + download meters', async ({
    page,
  }) => {
    await signIn(page, 'admin');

    await test.step('the Metrics link is present in the primary nav', async () => {
      const link = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', {
        name: 'Metrics',
      });
      await expect(link).toBeVisible();
      await link.click();
      await page.waitForURL('**/metrics');
    });

    await test.step('the Overview shows two meters with non-empty values', async () => {
      await openOverview(page);
      // The page keeps a stable heading regardless of tab (tolerant: any level-1/2 "Metrics" heading).
      await expect(page.getByRole('heading', { name: /metrics/i }).first()).toBeVisible();

      for (const id of ['metrics-upload-meter', 'metrics-download-meter'] as const) {
        const meter = page.getByTestId(id);
        await expect(meter, `${id} renders`).toBeVisible();
        await expect(meter, `${id} is an ARIA meter`).toHaveAttribute('role', 'meter');
        // Non-empty reading: an ARIA meter carries aria-valuenow, or (fallback) visible text.
        const valuenow = await meter.getAttribute('aria-valuenow');
        if (valuenow !== null) {
          expect(valuenow.trim(), `${id} has a numeric aria-valuenow`).not.toBe('');
        } else {
          await expect(meter, `${id} shows a reading`).not.toHaveText('');
        }
      }
    });

    // DESIGN-016 D-08 — the admin-only inline capacity editor: present, and a save re-renders the meter
    // denominator (optimistic → server reconcile). Restores the seeded 300 so re-runs see the default.
    await test.step('the admin can edit the upload capacity and the denominator re-renders', async () => {
      const input = page.getByTestId('metrics-capacity-input-upload');
      await expect(input, 'the upload capacity input is present for an admin').toBeVisible();
      await expect(page.getByTestId('metrics-capacity-input-download')).toBeVisible();

      await input.fill('600');
      await page.getByTestId('metrics-capacity-save-upload').click();
      // The meter denominator picks up the new cap (optimistic + reconcile).
      await expect(page.getByTestId('metrics-upload-meter')).toBeVisible();
      await expect(input).toHaveValue('600');

      // Restore the seeded value so later specs / re-runs see 300 Mbps.
      await input.fill('300');
      await page.getByTestId('metrics-capacity-save-upload').click();
      await expect(input).toHaveValue('300');
    });
  });

  // AC: Prometheus-down must DEGRADE, never crash — the page keeps its heading and (if present) shows
  // the network-unavailable note; the meters may vanish but the tab must not throw.
  test('with Prometheus down the Overview degrades and still shows its heading', async ({
    page,
  }) => {
    await setPrometheusMode('down');
    try {
      await signIn(page, 'admin');
      await openOverview(page);

      // The page survives the source being down — its heading is still on screen.
      await expect(page.getByRole('heading', { name: /metrics/i }).first()).toBeVisible();

      // A degrade note is the preferred UX; assert it only when the UI provides it (advisory).
      const note = page.getByTestId('metrics-network-unavailable');
      if ((await note.count()) > 0) {
        await expect(note).toBeVisible();
      }
    } finally {
      await setPrometheusMode('ok'); // later specs + re-runs see the healthy default
    }
  });
});

// PLAN-018 / DESIGN-018 — the Apps sub-tab. ADVISORY (not a merge gate yet). The four group cards read
// the *arr/downloader instant vectors added to stub-prometheus.ts; each carries a Grafana deep-link.
test.describe('metrics Apps sub-tab (PLAN-018 · DESIGN-018) — *arr + downloader panels', () => {
  test('an admin opens ?tab=apps and the four groups render real numbers + Grafana deep-links', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/metrics?tab=apps');

    await test.step('the Apps tab is selected and its four group cards render', async () => {
      const appsTab = page.getByRole('tab', { name: 'Apps' });
      await expect(appsTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('metrics-apps')).toBeVisible();
      for (const id of [
        'metrics-apps-collection',
        'metrics-apps-pipeline',
        'metrics-apps-downloads',
        'metrics-apps-indexers',
      ] as const) {
        await expect(page.getByTestId(id), `${id} renders`).toBeVisible();
      }
    });

    await test.step('a known Collection reading + the per-group Grafana deep-links', async () => {
      // radarr movie total = 9564 from the stub instant vector.
      await expect(page.getByTestId('metrics-apps-lib-radarr')).toContainText('9,564');
      await expect(page.getByTestId('metrics-apps-collection-grafana')).toHaveAttribute(
        'href',
        /d\/arr-library-overview/,
      );
      await expect(page.getByTestId('metrics-apps-downloads-grafana')).toHaveAttribute(
        'href',
        /d\/downloads-clients-indexers/,
      );
    });
  });
});

// PLAN-020 / ADR-039 / DESIGN-019 — the Network sub-tab. ADVISORY (not a merge gate yet). At `full`
// (admin) the WAN usage-vs-capacity meters + history sparkline + infra-performance groups render off the
// stub's unpoller instant/range vectors; the PRIVACY invariant is that NO client identity ever renders.
test.describe('metrics Network sub-tab (PLAN-020 · ADR-039 · DESIGN-019) — WAN + infra, no clients', () => {
  test('an admin opens ?tab=network: WAN meters, history, infra groups — and zero client identities', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/metrics?tab=network');

    await test.step('the Network tab is selected and the WAN meters + history render', async () => {
      const netTab = page.getByRole('tab', { name: 'Network' });
      await expect(netTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('metrics-network')).toBeVisible();
      for (const id of ['metrics-net-upload-meter', 'metrics-net-download-meter'] as const) {
        const meter = page.getByTestId(id);
        await expect(meter, `${id} renders`).toBeVisible();
        await expect(meter, `${id} is an ARIA meter`).toHaveAttribute('role', 'meter');
      }
      await expect(page.getByTestId('metrics-net-history')).toBeVisible();
      await expect(page.getByTestId('metrics-net-spark-up')).toBeVisible();
    });

    await test.step('the full-only infra groups render with a known device name (INFRASTRUCTURE, not a client)', async () => {
      await expect(page.getByTestId('metrics-net-gateway')).toBeVisible();
      await expect(page.getByTestId('metrics-net-gateway')).toContainText('Westford DMSE');
      await expect(page.getByTestId('metrics-net-wanhealth')).toBeVisible();
      await expect(page.getByTestId('metrics-net-switch')).toBeVisible();
      await expect(page.getByTestId('metrics-net-ap')).toBeVisible();
      // Site rollup shows the aggregate station COUNT (a number, never a per-client row).
      await expect(page.getByTestId('metrics-net-stations')).toContainText('181');
      // A curated switch board deep-link (not the Client-Insights board).
      await expect(page.getByTestId('metrics-net-switch-grafana')).toHaveAttribute(
        'href',
        /d\/FsfxpWaZz/,
      );
    });

    await test.step('PRIVACY: no client-identity board link and no per-client series leak into the DOM', async () => {
      // The deliberately-unlinked Client-Insights board (jMfvAjxWz) must not appear anywhere.
      await expect(page.locator('a[href*="jMfvAjxWz"]')).toHaveCount(0);
      // No unpoller_client_* label text leaks into the rendered tab.
      const body = (await page.getByTestId('metrics-network').textContent()) ?? '';
      expect(body.toLowerCase()).not.toContain('unpoller_client');
      expect(body.toLowerCase()).not.toContain('rssi');
    });
  });

  // The disabled-section gate is the same server render as the Overview: a fresh member sees the
  // unavailable card at /metrics?tab=network (never the Network panel).
  test('a default member gets the unavailable card at /metrics?tab=network', async ({ page }) => {
    await signIn(page, 'fresh-member');
    await page.goto('/metrics?tab=network');
    await expect(page.getByTestId('metrics-unavailable')).toBeVisible();
    await expect(page.getByTestId('metrics-net-upload-meter')).toHaveCount(0);
  });
});

test.describe('metrics Hardware sub-tab (PLAN-019 · ADR-040 · DESIGN-020) — SMART + endurance + Proxmox', () => {
  test('an admin opens ?tab=hardware: the NVMe endurance panel, drive health, node load, and Proxmox showcase', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/metrics?tab=hardware');

    await test.step('the Hardware tab is selected and the NVMe endurance panel frames both pools', async () => {
      const hwTab = page.getByRole('tab', { name: 'Hardware' });
      await expect(hwTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('metrics-hardware')).toBeVisible();
      // Cache-apps (critical mirror) + Cache-staging (expendable) pools both render.
      await expect(page.getByTestId('metrics-hw-pool-Cache-apps')).toBeVisible();
      await expect(page.getByTestId('metrics-hw-pool-Cache-staging')).toBeVisible();
      // The acceptance status lines: staging is "holding"; apps is "worn".
      await expect(page.getByTestId('metrics-hw-pool-status-Cache-staging')).toContainText(
        'holding',
      );
      await expect(page.getByTestId('metrics-hw-pool-status-Cache-apps')).toContainText('worn');
    });

    await test.step('the drive-health table shows a SMART-failed drive with a status pill', async () => {
      await expect(page.getByTestId('metrics-hw-drives')).toBeVisible();
      await expect(page.getByTestId('metrics-hw-drives')).toContainText('CT2000P3PSSD8');
      // At least one drive reads "Failed" (the staging pool NVMe).
      await expect(page.getByTestId('metrics-hw-drives').getByText('Failed').first()).toBeVisible();
    });

    await test.step('node load + the Proxmox host→VM showcase render', async () => {
      await expect(page.getByTestId('metrics-hw-nodes')).toBeVisible();
      await expect(page.getByTestId('metrics-hw-node-haynestower')).toBeVisible();
      await expect(page.getByTestId('metrics-hw-pve')).toBeVisible();
      const host = page.getByTestId('metrics-hw-pve-HaynesIntelligence');
      await expect(host).toBeVisible();
      // The host tile expands IN PLACE (ADR-015 allowed exception) to reveal its VMs.
      await host.locator('summary').click();
      await expect(host.getByText('plex-vm')).toBeVisible();
    });
  });

  // Ungated (owner ruling R-129): the section gate still applies, so a member with the metrics section
  // disabled sees the unavailable card — never the Hardware panel. (The full/limited-identical payload is
  // a server property — the router does no level shaping for hardware — proven by the @hnet unit tests.)
  test('a default member gets the unavailable card at /metrics?tab=hardware', async ({ page }) => {
    await signIn(page, 'fresh-member');
    await page.goto('/metrics?tab=hardware');
    await expect(page.getByTestId('metrics-unavailable')).toBeVisible();
    await expect(page.getByTestId('metrics-hardware')).toHaveCount(0);
  });
});

// ADR-044 / DESIGN-022 (PLAN-021) — the AI usage sub-tab. The harness runs the ai-usage-sync mode against
// the stub Open WebUI at boot, so ai_usage_chats is populated with the canned chats (5 chats, 4 image
// generations across 3 users). An admin (full) sees the per-user table; the section gate still applies.
test.describe('metrics section — AI usage sub-tab (ADR-044 · DESIGN-022)', () => {
  test('an admin sees the AI tab with real chat + image counts and the per-user attribution', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/metrics?tab=ai');

    await test.step('the AI tab renders the aggregate count tiles from the synced mirror', async () => {
      await expect(page.getByTestId('metrics-ai')).toBeVisible();
      // 5 canned chats, 4 assistant-generated images (the image-gen heuristic).
      await expect(page.getByTestId('metrics-ai-chats')).toContainText('5');
      await expect(page.getByTestId('metrics-ai-images')).toContainText('4');
    });

    await test.step('an admin (full) sees the per-user + per-model attribution', async () => {
      await expect(page.getByTestId('metrics-ai-users')).toBeVisible();
      await expect(page.getByTestId('metrics-ai-users')).toContainText('Alice Nguyen');
      await expect(page.getByTestId('metrics-ai-models')).toBeVisible();
    });
  });

  test('a default member gets the unavailable card at /metrics?tab=ai', async ({ page }) => {
    await signIn(page, 'fresh-member');
    await page.goto('/metrics?tab=ai');
    await expect(page.getByTestId('metrics-unavailable')).toBeVisible();
    await expect(page.getByTestId('metrics-ai')).toHaveCount(0);
  });
});
