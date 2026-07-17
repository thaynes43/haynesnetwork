// PLAN-053 owner amendment (2026-07-17) — screenshot proof of the Collection Type chip row after
// the owner's mobile review: per-chip counts removed, "Franchise & Universe" → "Franchise", and
// Trilogies hidden on the TV wall. Captures the Movies AND TV grouped-collection walls at 320 /
// 390 / desktop so the row is shown fitting a narrow phone on one line (ADR-015: never wraps).
//
//   pnpm --filter web exec tsx e2e/support/capture-collection-chips.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';
import type { PersonaName } from './stub-oidc';

async function setPersona(oidcBaseUrl: string, persona: PersonaName): Promise<void> {
  const res = await fetch(`${oidcBaseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (res.status !== 204) throw new Error(`persona switch failed: HTTP ${res.status}`);
}

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-collection-chips.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3224;

async function hidePortal(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

async function signInTo(
  browser: Browser,
  appUrl: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  const context = await browser.newContext({ viewport, baseURL: appUrl, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  return page;
}

/** Open a wall's grouped-by-Collection view and wait for the Type chip row (.library-chipbar). */
async function openCollections(page: Page, tab: 'movies' | 'tv'): Promise<void> {
  await page.goto(`/library?tab=${tab}&view=grouped&by=collection`);
  await page.locator('.library-chipbar .seg[aria-label="Collection type"]').waitFor();
  await hidePortal(page);
}

async function shootChips(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  const bar = page.locator('.library-chipbar').first();
  // Full page (context) + a tight clip of just the chip row (the owner's fit concern).
  await page.screenshot({ path: join(OUT, `${name}-page.png`) });
  await bar.screenshot({ path: join(OUT, `${name}-chips.png`) });
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'admin');

    for (const [label, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
      ['320', { width: 320, height: 780 }],
    ] as const) {
      const page = await signInTo(browser, stack.appUrl, viewport);
      await setTheme(page, 'hnet-dark');
      for (const tab of ['movies', 'tv'] as const) {
        await openCollections(page, tab);
        await shootChips(page, `${tab}-${label}`);
      }
      await page.context().close();
    }

    await browser.close();
  } finally {
    await stack.stop();
  }
  console.log(`[capture] done → ${OUT}`);
}

main().catch((err: unknown) => {
  console.error('[capture] failed:', err);
  process.exit(1);
});
