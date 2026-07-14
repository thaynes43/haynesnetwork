// ADR-055 / DESIGN-028 (PLAN-044) — screenshot harness for owner sign-off of the Integrations tab.
// PLAN-045 (ADR-057/DESIGN-029) moved the flat tab into the /integrations/goodreads SUB-SECTION and
// folded the requests wall into its Items tab — this harness now shoots the sub-section's link card +
// Overview; the full PLAN-045 matrix (hub / stats / items / Library-Wanted) lives in capture-plan045.ts.
// Original brief:
// the empty link card, and the linked state (link card + shelf summary + coverage % + the requests/Missing
// wall). Desktop + 390px, dark + light — the standing owner screenshot-review rule. It boots its OWN stack
// (stub Goodreads + stub LazyLibrarian), links the account via the UI, runs the REAL goodreads-sync once
// (async spawn — the stub is hosted in THIS process), then captures the matrix.
//
//   pnpm --filter web exec tsx e2e/support/capture-integrations.ts <output-dir>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack, type RunningStack } from './harness';
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
  console.error('usage: tsx e2e/support/capture-integrations.ts <output-dir>');
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

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  console.log(`[capture] ${name}`);
}

/** Run the real goodreads-sync via ASYNC spawn (the stub is hosted here — spawnSync would deadlock). */
async function runGoodreadsSync(stack: RunningStack, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      join(cwd, 'node_modules', '.bin', 'tsx'),
      [join(cwd, '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=goodreads-sync'],
      { env: { ...process.env, ...stack.env }, cwd, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`goodreads-sync exit ${String(code)}`))));
  });
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

    // Phase 1 — the EMPTY link card (before linking persists to the shared DB).
    for (const [label, viewport] of viewports) {
      const page = await signInTo(browser, stack.appUrl, viewport);
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        await setTheme(page, theme);
        await page.goto('/integrations/goodreads');
        await page.getByTestId('integrations-link-card').waitFor();
        await hidePortal(page);
        await shoot(page, `link-card-${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`);
      }
      await page.context().close();
    }

    // Phase 2 — link the account + run the sync ONCE.
    {
      const page = await signInTo(browser, stack.appUrl, { width: 1280, height: 900 });
      await page.goto('/integrations/goodreads');
      await page.getByTestId('integrations-profile-input').fill('https://www.goodreads.com/haynesnetwork');
      await page.getByTestId('integrations-link-btn').click();
      await page.getByTestId('integrations-linked').waitFor();
      await page.context().close();
      await runGoodreadsSync(stack, cwd);
    }

    // Phase 3 — the LINKED tab (link card + coverage % + requests/Missing wall).
    for (const [label, viewport] of viewports) {
      const page = await signInTo(browser, stack.appUrl, viewport);
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        await setTheme(page, theme);
        await page.goto('/integrations/goodreads');
        await page.getByTestId('integrations-coverage').waitFor();
        await page.getByTestId('gr-phase-have').waitFor();
        await hidePortal(page);
        await shoot(page, `integrations-${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`, true);
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
