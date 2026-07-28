// ADR-079 / DESIGN-004 D-25 (R-235, PLAN-064) — the front-page uptime badge, the three
// honest states against the stub Gatus:
//   • up — accent state, the 30d percent + qualifier + the 24h/7d/30d tooltip;
//   • down — danger state, same anatomy (percent still renders; the dot/tone carries it);
//   • unreachable Gatus — the muted "unmeasured" state, NEVER fake green and never a
//     broken Home (the rest of the page still renders).
// The harness sets UPTIME_BADGE_TTL_MS=0, so every reload re-reads the stub and a
// /_stub/state flip is visible on the next goto. Leaves the stub back in 'up' mode so
// later specs and re-runs see the healthy default.
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';

async function setGatusState(body: {
  mode?: 'up' | 'down' | 'unreachable';
  uptimes?: Partial<Record<'1h' | '24h' | '7d' | '30d', number>>;
}): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_GATUS_URL}/_stub/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub gatus state change failed: HTTP ${res.status}`);
}

async function resetGatus(): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_GATUS_URL}/_stub/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`stub gatus reset failed: HTTP ${res.status}`);
}

test.describe('front-page uptime badge (ADR-079 / D-25)', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async () => {
    await resetGatus();
  });

  test('up — accent state with the 30d percent and the windows tooltip', async ({ page }) => {
    await signIn(page, 'member');
    await page.goto('/');

    const badge = page.getByTestId('uptime-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-state', 'up');
    // Stub default 30d = 0.999783 → "99.98%" + the 30d qualifier; label reads "Uptime".
    await expect(badge).toContainText('Uptime');
    await expect(badge).toContainText('99.98%');
    await expect(badge).toContainText('30d');
    // The native tooltip carries all three windows (24h/7d/30d), middot-joined.
    const title = await badge.getAttribute('title');
    expect(title).toContain('24h 100%');
    expect(title).toContain('7d 99.91%');
    expect(title).toContain('30d 99.98%');
  });

  test('down — danger state, same anatomy (the tone carries the state, not a reflow)', async ({
    page,
  }) => {
    await setGatusState({ mode: 'down' });
    await signIn(page, 'member');
    await page.goto('/');

    const badge = page.getByTestId('uptime-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-state', 'down');
    // The percent still renders (state swaps color/text only — ADR-015 anatomy hold).
    await expect(badge).toContainText('99.98%');
    await expect(badge).toContainText('30d');
  });

  test('unreachable Gatus — the honest muted "unmeasured" state; Home still renders', async ({
    page,
  }) => {
    await setGatusState({ mode: 'unreachable' });
    await signIn(page, 'member');
    await page.goto('/');

    const badge = page.getByTestId('uptime-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-state', 'unmeasured');
    await expect(badge).toContainText('Uptime');
    await expect(badge).toContainText('unmeasured');
    // Never fake numbers in the unmeasured state.
    await expect(badge).not.toContainText('%');
    // The badge degrading never breaks its Home neighbors (ADR-079 C-02).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /About haynesnetwork\.com/ })).toBeVisible();
  });
});
