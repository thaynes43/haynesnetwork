// PLAN-029 (ADR-051/052 / DESIGN-026) — screenshot harness for owner sign-off of the Library
// views/grouping + sort & filter UX: the view selector + the grouped-by-Author Books wall
// (aggregate cards, D-04), the drilled author grid (D-04 drill-in), the audiobook facet chip bar
// (D-08 — the shipped books.filterFacets finally wearing UI), and the Movies wall with the new
// registry sort bar + Released/Decade chips + the armed A–Z jump rail (D-09). Desktop + 390px,
// dark + light — the standing owner screenshot-review rule.
//
//   pnpm --filter web exec tsx e2e/support/capture-library-views.ts <output-dir>
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
  console.error('usage: tsx e2e/support/capture-library-views.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3223;

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

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400); // poster fades settle (opacity-only, ADR-015)
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[capture] ${name}`);
}

/** The grouped Books wall: view selector + author aggregate cards (D-01/D-04). */
async function openBooksGrouped(page: Page): Promise<void> {
  await page.goto('/library?tab=books&view=grouped');
  await page.getByTestId('books-groups').waitFor();
  await page.getByTestId('view-selector').waitFor();
  await hidePortal(page);
}

/** The drilled author grid (D-04 drill-in header + pre-filtered flat wall). */
async function openBooksDrill(page: Page): Promise<void> {
  await page.goto('/library?tab=books&group=Charlaine%20Harris');
  await page.getByTestId('library-drill').waitFor();
  await page.getByTestId('books-grid').waitFor();
  await hidePortal(page);
}

/** The audiobook flat wall: the D-08 facet chip bar (genre/author/narrator/series/language/length). */
async function openAudiobookChips(page: Page): Promise<void> {
  await page.goto('/library?tab=audiobooks&view=flat');
  await page.getByTestId('books-grid').waitFor();
  await page.getByTitle('Edit the Narrator filter').waitFor();
  await hidePortal(page);
}

/** Movies with the registry sort bar + Released/Decade chips + the ARMED A–Z jump rail (D-09). */
async function openMoviesJump(page: Page): Promise<void> {
  await page.goto('/library?tab=movies&sort=title:asc&at=s');
  await page.getByTestId('letter-jump-bar').waitFor();
  await page.getByTitle('Edit the Released filter').waitFor();
  await hidePortal(page);
}

const SHOTS: Array<{ name: string; open: (page: Page) => Promise<void> }> = [
  { name: 'books-grouped', open: openBooksGrouped },
  { name: 'books-drill', open: openBooksDrill },
  { name: 'audiobook-chips', open: openAudiobookChips },
  { name: 'movies-jump', open: openMoviesJump },
];

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'admin');

    for (const [label, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const) {
      const page = await signInTo(browser, stack.appUrl, viewport);
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        await setTheme(page, theme);
        for (const shot of SHOTS) {
          await shot.open(page);
          await shoot(page, `${shot.name}-${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`);
        }
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
