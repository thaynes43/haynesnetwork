// DESIGN-044 D-05 (owner "gotta catch em all" redesign, 2026-07-18) — a FOCUSED capture of the builder's
// full-width member WALL (the `builder-preview` region), element-screenshotted so the whole wall is in frame
// regardless of the app shell's inner scroll container (fullPage stops at the viewport). Complements
// capture-collections.ts (which frames the compact config on top). Captures the caught-em-all celebration,
// a big NYT-style wall, and an incomplete books split, dark + light at desktop + 390.
//
//   pnpm --filter web exec tsx e2e/support/capture-builder-walls.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { syncBooks, type BooksItemInput } from '@hnet/domain';
import { startStack } from './harness';
import type { PersonaName } from './stub-oidc';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-builder-walls.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3226;

async function setPersona(oidcBaseUrl: string, persona: PersonaName): Promise<void> {
  const res = await fetch(`${oidcBaseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (res.status !== 204) throw new Error(`persona switch failed: HTTP ${res.status}`);
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

/** Element-screenshot the whole preview wall (config + wall in frame when it fits; wall always whole). */
async function shootPreview(page: Page, name: string): Promise<void> {
  await page.getByTestId('builder-preview').scrollIntoViewIfNeeded();
  // Force the lazy poster images to load (they sit below the initial viewport, so `loading="lazy"` would not
  // fetch them before the element screenshot) and wait for the cover proxy requests to settle so the HELD
  // tiles render their real art, not a mid-load fallback.
  await page.evaluate(() => {
    document.querySelectorAll('img.poster-img').forEach((el) => el.setAttribute('loading', 'eager'));
  });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(700);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.getByTestId('builder-preview').screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[wall] ${name}`);
}

async function caughtEmAll(page: Page): Promise<void> {
  await page.goto('/collections/new?tab=audiobooks');
  await page.getByTestId('builder-card-hardcover_series').click();
  await page.getByTestId('builder-manual-toggle').click();
  await page.getByTestId('builder-ref-manual').fill('the-complete-collection');
  await page.getByTestId('builder-preview').waitFor();
  await page.getByTestId('collection-caught').waitFor();
  await page.getByTestId('builder-held').waitFor();
}

async function bigList(page: Page): Promise<void> {
  await page.goto('/collections/new?tab=audiobooks');
  await page.getByTestId('builder-card-nyt_list').click();
  await page.getByTestId('builder-search-input').fill('hard');
  await page.getByTestId('builder-result').first().click();
  await page.getByTestId('builder-preview').waitFor();
  await page.getByTestId('builder-missing').waitFor();
}

async function booksIncomplete(page: Page): Promise<void> {
  await page.goto('/collections/new?tab=books');
  await page.getByTestId('builder-card-hardcover_series').click();
  await page.getByTestId('builder-search-input').fill('storm');
  await page.getByTestId('builder-result').first().click();
  await page.getByTestId('builder-preview').waitFor();
  await page.getByTestId('builder-missing').waitFor();
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const stack = await startStack({ port: PORT, prewarm: false, cwd });
  try {
    process.env.DATABASE_URL = stack.pg.connectionString;
    // Two Kavita rows the stub's stormlight preview holds → a populated "In your library" split (books tab).
    const kavitaBook = (
      over: Partial<BooksItemInput> & Pick<BooksItemInput, 'externalId' | 'title' | 'isbn'>,
    ): BooksItemInput => ({
      source: 'kavita',
      mediaKind: 'book',
      libraryId: 'lib1',
      libraryName: 'Books',
      sortTitle: over.title.toLowerCase(),
      author: 'Brandon Sanderson',
      narrator: null,
      seriesName: 'The Stormlight Archive',
      year: 2014,
      releasedAt: null,
      genres: [],
      coverRef: null,
      deepLinkUrl: `https://example.test/${over.externalId}`,
      pageCount: null,
      wordCount: null,
      durationSeconds: null,
      sizeBytes: null,
      attrs: {},
      sourceAddedAt: null,
      sourceUpdatedAt: null,
      ...over,
    });
    await syncBooks({
      syncedSources: [],
      rows: [
        kavitaBook({ externalId: 'sl-way-of-kings', title: 'The Way of Kings', isbn: '9780765326355' }),
        kavitaBook({ externalId: 'sl-words-of-radiance', title: 'Words of Radiance', isbn: '9780765326362' }),
      ],
    });

    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'member');
    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;
    for (const [label, viewport] of viewports) {
      const page = await signIn(browser, stack.appUrl, viewport);
      const themes = label === 'desktop' ? (['hnet-dark', 'hnet-light'] as const) : (['hnet-dark'] as const);
      for (const theme of themes) {
        const suffix = `${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`;
        await setTheme(page, theme);
        await caughtEmAll(page);
        await shootPreview(page, `wall-caught-${suffix}`);
        await bigList(page);
        await shootPreview(page, `wall-biglist-${suffix}`);
        await booksIncomplete(page);
        await shootPreview(page, `wall-incomplete-${suffix}`);
      }
      await page.context().close();
    }
    await browser.close();
  } finally {
    await stack.stop();
  }
  console.log(`[wall] done → ${OUT}`);
}

main().catch((err: unknown) => {
  console.error('[wall] failed:', err);
  process.exit(1);
});
