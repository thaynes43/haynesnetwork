// ADR-057 / DESIGN-029 (PLAN-045) — screenshot harness for owner sign-off of the Integrations HUB +
// Goodreads sub-section + Library composed-Wanted redesign. Desktop + 390px, dark + light — the
// standing owner screenshot-review rule. It boots its OWN hermetic stack (stub Goodreads RSS with
// ALL FOUR shelves incl. the 404ing did-not-finish, stub LazyLibrarian, stub Kapowarr), links the
// account via the UI, runs the REAL goodreads-sync once (async spawn — the stubs are hosted in THIS
// process), then captures:
//   • the HUB (provider cards, linked state)
//   • the Goodreads STATS page (want-shelf headline + per-shelf breakdown + phase tiles)
//   • the ITEMS wall with the shelf chips in a COMBINATION state (to-read toggled off)
//   • the Library Books flat wall with its composed-Wanted cards merged inline (owner-corrected)
//   • the items-wall force-search LIVE FEEDBACK (the fired corner puck, recolored in place)
//
//   pnpm --filter web exec tsx e2e/support/capture-plan045.ts <output-dir>
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
  console.error('usage: tsx e2e/support/capture-plan045.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3226;

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

/** Run the real goodreads-sync via ASYNC spawn (the stubs are hosted here — spawnSync would deadlock). */
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

    // Phase 1 — link the account + run the ALL-SHELVES sync ONCE.
    {
      const page = await signInTo(browser, stack.appUrl, { width: 1280, height: 900 });
      await page.goto('/integrations/goodreads');
      await page.getByTestId('integrations-profile-input').fill('https://www.goodreads.com/haynesnetwork');
      await page.getByTestId('integrations-link-btn').click();
      await page.getByTestId('integrations-linked').waitFor();
      await page.context().close();
      await runGoodreadsSync(stack, cwd);
    }

    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;

    // Phase 2 — the matrix: hub · stats · items (chip combination) · Books wall Wanted strip.
    for (const [label, viewport] of viewports) {
      const page = await signInTo(browser, stack.appUrl, viewport);
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        const t = theme === 'hnet-dark' ? 'dark' : 'light';
        await setTheme(page, theme);

        await page.goto('/integrations');
        await page.getByTestId('hub-card-goodreads').waitFor();
        await hidePortal(page);
        await shoot(page, `hub-${label}-${t}`);

        await page.goto('/integrations/goodreads?tab=overview');
        await page.getByTestId('integrations-coverage').waitFor();
        await page.getByTestId('gr-phase-have').waitFor();
        await hidePortal(page);
        await shoot(page, `goodreads-stats-${label}-${t}`, true);

        // The chip COMBINATION state: to-read toggled off (currently-reading + read selected).
        await page.goto('/integrations/goodreads?tab=items&shelf=currently-reading&shelf=read');
        await page.getByTestId('gr-item').first().waitFor();
        await hidePortal(page);
        await shoot(page, `goodreads-items-combo-${label}-${t}`, true);

        // The full items wall (All selected) — the poster-idiom wall the flat page folded into.
        await page.goto('/integrations/goodreads?tab=items');
        await page.getByTestId('gr-item').first().waitFor();
        await hidePortal(page);
        await shoot(page, `goodreads-items-${label}-${t}`, true);

        // The Books flat wall — the composed Wanted cards merged INLINE as the SAME poster block as
        // the on-disk books (owner-corrected — no separate strip).
        await page.goto('/library?tab=books&view=flat');
        await page.getByTestId('wanted-card').first().waitFor();
        await hidePortal(page);
        await shoot(page, `library-books-wanted-${label}-${t}`, true);
      }
      await page.context().close();
    }

    // Phase 3 — the force-search LIVE FEEDBACK (desktop, both themes): fire the ITEMS-wall corner puck
    // (the Library cards have no search button now) and capture its fired state in place (ADR-015).
    {
      const page = await signInTo(browser, stack.appUrl, { width: 1280, height: 900 });
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        const t = theme === 'hnet-dark' ? 'dark' : 'light';
        await setTheme(page, theme);
        await page.goto('/integrations/goodreads?tab=items');
        const tile = page.getByTestId('gr-item').filter({ hasText: 'Throne of Glass' });
        await tile.getByTestId('request-search-btn').click();
        await tile.locator('.gr-search-puck[data-state="fired"]').waitFor();
        await hidePortal(page);
        await shoot(page, `items-force-search-feedback-${t}`);
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
