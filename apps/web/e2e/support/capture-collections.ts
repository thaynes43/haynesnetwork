// ADR-070 / DESIGN-043 (PLAN-052 — collection manager) — the screenshot harness for owner sign-off of the
// collection manager. Boots its OWN stack (incl. the stub Libretto) and captures, as admin (admin implies
// every collection action): the manager (/integrations/collections — recipe list with the acquisition puck
// + the needs-attention band) and the composer Modal. Desktop + 390px, dark + light — the standing owner
// screenshot-review rule.
//
//   pnpm --filter web exec tsx e2e/support/capture-collections.ts <output-dir>
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
  console.error('usage: tsx e2e/support/capture-collections.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3225;

async function hidePortal(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

async function signIn(
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

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const stack = await startStack({ port: PORT, prewarm: false, cwd });
  try {
    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'admin');

    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;

    for (const [label, viewport] of viewports) {
      const page = await signIn(browser, stack.appUrl, viewport);
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        const suffix = `${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`;
        await setTheme(page, theme);

        // The manager.
        await page.goto('/integrations/collections');
        await page.getByTestId('collections-list').waitFor();
        await hidePortal(page);
        await shoot(page, `manager-${suffix}`, true);

        // The composer Modal.
        await page.getByTestId('collections-new').click();
        await page.getByRole('dialog').waitFor();
        await hidePortal(page);
        await shoot(page, `composer-${suffix}`);
        await page.keyboard.press('Escape');
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
