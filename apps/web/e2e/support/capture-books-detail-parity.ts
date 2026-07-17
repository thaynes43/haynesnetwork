// DESIGN-025 D-08 (owner directive 2026-07-17) — the ACCEPTANCE proof that books/audiobooks/comics detail
// pages now match the movie-detail anatomy (hero → About → Details → History). Boots a hermetic stack (the
// harness already runs books-sync + books-collections-sync, so items carry the enrichment + collection
// membership), seeds a Fix trail + a request, then for each viewport (desktop + 390) and theme (dark + light)
// captures the movie detail (the REFERENCE) beside a book, an audiobook, and a comic detail — full-page.
//
//   pnpm --filter web exec tsx e2e/support/capture-books-detail-parity.ts <output-dir>
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack, type RunningStack } from './harness';
import type { PersonaName } from './stub-oidc';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-books-detail-parity.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const PORT = 3231;

async function setPersona(oidcBaseUrl: string, persona: PersonaName): Promise<void> {
  const res = await fetch(`${oidcBaseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (res.status !== 204) throw new Error(`persona switch failed: HTTP ${res.status}`);
}

async function runScript(stack: RunningStack, cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(cwd, 'node_modules', '.bin', 'tsx'), args, {
      env: { ...process.env, ...stack.env },
      cwd,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`script exit ${String(code)}`))));
  });
}

async function hidePortal(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
  await hidePortal(page);
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

async function shootDetail(page: Page, url: string, out: string): Promise<void> {
  await page.goto(url);
  await page.locator('.detail-head').waitFor();
  await page.waitForTimeout(500);
  await hidePortal(page);
  await page.screenshot({ path: join(OUT, `${out}.png`), fullPage: true });
  console.log(`[capture] ${out}`);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const stack = await startStack({ port: PORT, prewarm: false, cwd });
  try {
    await setPersona(stack.oidc.baseUrl, 'admin');
    // Seed the History (fix trail + a request) so the detail pages show those sections; the seed also
    // writes the three detail-page ids for us to navigate directly (no client-side card-clicking).
    const idsPath = join(OUT, 'ids.json');
    await runScript(stack, cwd, [join(cwd, 'e2e', 'support', 'seed-books-detail-history.ts'), idsPath]);
    const { book: bookId, audio: audioId, comic: comicId } = JSON.parse(
      readFileSync(idsPath, 'utf8'),
    ) as { book: string; audio: string; comic: string };

    const browser = await chromium.launch();
    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;
    const themes = ['hnet-dark', 'hnet-light'] as const;

    for (const [vp, viewport] of viewports) {
      for (const theme of themes) {
        const page = await signIn(browser, stack.appUrl, viewport);
        await setTheme(page, theme);
        const suffix = `${vp}-${theme === 'hnet-dark' ? 'dark' : 'light'}`;
        await shootDetail(page, `/library/books/${bookId}?from=books`, `book-detail-${suffix}`);
        await shootDetail(page, `/library/books/${audioId}?from=audiobooks`, `audiobook-detail-${suffix}`);
        await shootDetail(page, `/library/books/${comicId}?from=comics`, `comic-detail-${suffix}`);
        await page.context().close();
      }
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
