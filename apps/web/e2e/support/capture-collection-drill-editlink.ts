// DESIGN-043 D-09' (2026-07-18, owner-ruled) — screenshot harness for the "Edit collection" wall
// drill nav-out. Boots its OWN hermetic stack and captures the collection-DRILL header carrying the
// quiet link, at 390 + desktop, dark + light, for coordinator review:
//   • Audiobooks wall — the "Dickens in Order" collection drill (Libretto-managed → the link renders,
//     deep-linking to /collections?tab=audiobooks&edit=dickens-in-order),
//   • Movies wall — a collection drill (Kometa join by title → the link lands on ?tab=movies, no edit).
//
//   pnpm --filter web exec tsx e2e/support/capture-collection-drill-editlink.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-collection-drill-editlink.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3241;

async function setPersona(oidcBaseUrl: string, persona: string): Promise<void> {
  const res = await fetch(`${oidcBaseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (res.status !== 204) throw new Error(`persona switch failed: HTTP ${res.status}`);
}

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

/** Open a wall's grouped-by-Collection view, then navigate into the first collection card's drill
 *  (read its href + goto — more robust than a click), and wait for the drill header (which carries
 *  the "Edit collection" link when the collection is manager-known). */
async function drillFirstCollection(page: Page, tab: string): Promise<void> {
  await page.goto(`/library?tab=${tab}&view=grouped&by=collection`);
  await page.waitForLoadState('networkidle');
  const firstCard = page.locator('a[href*="group="]').first();
  await firstCard.waitFor({ timeout: 15000 });
  const href = await firstCard.getAttribute('href');
  if (!href) throw new Error(`no collection card href on the ${tab} grouped wall`);
  await page.goto(href);
  await page.getByTestId('library-drill').waitFor();
  await page.waitForLoadState('networkidle');
  await hidePortal(page);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  const drill = page.getByTestId('library-drill');
  await page.screenshot({ path: join(OUT, `${name}-page.png`) });
  await drill.screenshot({ path: join(OUT, `${name}-drill.png`) });
  const hasLink = await page.getByTestId('library-drill-edit').count();
  console.log(`[capture] ${name} — edit link present: ${hasLink === 1}`);
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'admin'); // admin surfaces the Books/Audiobooks + Movies walls
    for (const [label, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const) {
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        const tone = theme === 'hnet-dark' ? 'dark' : 'light';
        const page = await signIn(browser, stack.appUrl, viewport);
        await setTheme(page, theme);
        // Audiobooks — the Libretto-managed "Dickens in Order" drill carries the link (the primary
        // evidence: a Books/Audiobooks drill with the deep-link edit nav-out).
        await drillFirstCollection(page, 'audiobooks');
        await shoot(page, `audiobooks-drill-${label}-${tone}`);
        // Movies — best-effort: the collection drill links to ?tab=movies (no edit param; Kometa join
        // by title). Skipped when this hermetic harness has no movies collection mirror populated.
        try {
          await drillFirstCollection(page, 'movies');
          await shoot(page, `movies-drill-${label}-${tone}`);
        } catch {
          console.log(`[capture] movies-drill-${label}-${tone} — skipped (no movies collection mirror)`);
        }
        await page.context().close();
      }
    }
    await browser.close();
  } finally {
    await stack.stop();
  }
  console.log(`[capture] done → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
