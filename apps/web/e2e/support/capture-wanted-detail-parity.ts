// PLAN-047 (DESIGN-029 amendment-2, owner Wanted-parity ruling) — the ACCEPTANCE side-by-side proof that a
// book WANT now gets the FULL Movies/TV detail experience: poster → DETAIL PAGE → per-format Force-Search
// with live feedback. It boots its own hermetic stack, links Goodreads + runs the real goodreads-sync, seeds
// ONE Wanted movie (so the Movies wall has a Wanted item with a detail page), then for each viewport
// (desktop + 390, dark) captures, cropped so they line up:
//   • movies-detail-<vp> — a Movies WANTED item's detail (the REFERENCE): hero poster + title + Force Search.
//   • book-detail-<vp>   — the NEW book-wanted detail: hero + attribution + per-format Force-Search rows.
//   • book-fired-<vp>    — the same after firing the Ebook leg: the reserved-slot PhaseChip fired state.
// and stitches the two detail pages into a labeled composite `sxs-detail-<vp>.png` (rendered in Chromium —
// no ImageMagick/sharp in this toolchain). The detail experiences must be structurally the same.
//
//   pnpm --filter web exec tsx e2e/support/capture-wanted-detail-parity.ts <output-dir>
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
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
  console.error('usage: tsx e2e/support/capture-wanted-detail-parity.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3229;

async function hidePortal(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function setDark(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));
  await page.reload();
  await page.locator('html[data-theme="hnet-dark"]').waitFor();
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

/** Run a tsx script to completion against the stack DB (stubs are hosted here → async spawn). */
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

/** Clip from the TOP of `top` through the BOTTOM of `bottom` — the detail hero + its primary action area. */
async function shootRegion(page: Page, top: Locator, bottom: Locator, out: string): Promise<void> {
  await top.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const t = await top.boundingBox();
  const b = await bottom.boundingBox();
  if (!t || !b) throw new Error(`no box for ${out}`);
  const x = Math.min(t.x, b.x);
  const width = Math.max(t.x + t.width, b.x + b.width) - x;
  const height = b.y + b.height - t.y;
  await page.screenshot({ path: join(OUT, `${out}.png`), clip: { x, y: t.y, width, height } });
  console.log(`[capture] ${out}`);
}

/** Stitch two crops into one labeled composite, rendered in Chromium (data-URI images). */
async function composite(browser: Browser, label: string, cols: Array<{ title: string; file: string }>): Promise<void> {
  const cards = cols
    .map((c) => {
      const b64 = readFileSync(join(OUT, `${c.file}.png`)).toString('base64');
      return `<figure><figcaption>${c.title}</figcaption><img src="data:image/png;base64,${b64}"/></figure>`;
    })
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:dark}
    body{margin:0;background:#0d0f12;color:#e8eaed;font:600 15px/1.4 system-ui,sans-serif;padding:20px}
    h1{font-size:16px;margin:0 0 14px;font-weight:700}
    .row{display:flex;gap:16px;align-items:flex-start}
    figure{margin:0;flex:1;min-width:0}
    figcaption{font-size:13px;margin-bottom:8px;color:#9aa0a6}
    img{width:100%;height:auto;display:block;border:1px solid #2a2d31;border-radius:8px}
  </style></head><body>
    <h1>PLAN-047 — a book want gets the Movies/TV detail experience (${label})</h1>
    <div class="row">${cards}</div>
  </body></html>`;
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `sxs-detail-${label}.png`), fullPage: true });
  await context.close();
  console.log(`[capture] sxs-detail-${label}`);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const stack = await startStack({ port: PORT, prewarm: false, cwd });
  try {
    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'admin');

    // Phase 1 — link Goodreads, run the real sync, seed the Wanted movie (all once).
    {
      const page = await signInTo(browser, stack.appUrl, { width: 1280, height: 900 });
      await page.goto('/integrations/goodreads');
      await page.getByTestId('integrations-profile-input').fill('https://www.goodreads.com/haynesnetwork');
      await page.getByTestId('integrations-link-btn').click();
      await page.getByTestId('integrations-linked').waitFor();
      await page.context().close();
      await runScript(stack, cwd, [
        join(cwd, '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'),
        '--mode=goodreads-sync',
      ]);
      await runScript(stack, cwd, [join(cwd, 'e2e', 'support', 'seed-wanted-movie.ts')]);
    }

    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;

    for (const [vp, viewport] of viewports) {
      const page = await signInTo(browser, stack.appUrl, viewport);
      await setDark(page);
      await hidePortal(page);

      // (a) The REFERENCE — a Movies WANTED item's detail (poster hero + the item-level Force Search).
      await page.goto('/library?tab=movies');
      await page.locator('.poster-card', { hasText: 'Wanted Signal' }).first().click();
      await page.locator('.detail-head').waitFor();
      await page.getByRole('button', { name: 'Force Search' }).first().waitFor();
      await hidePortal(page);
      await shootRegion(page, page.locator('.detail-head'), page.locator('.detail-head'), `movies-detail-${vp}`);

      // (b) The NEW book-wanted detail — reached exactly like Movies: click the wall card → the detail page.
      await page.goto('/library?tab=books&view=flat');
      await page.getByTestId('wanted-card').filter({ hasText: 'Throne of Glass' }).first().click();
      await page.getByTestId('wanted-detail-head').waitFor();
      await hidePortal(page);
      await shootRegion(
        page,
        page.locator('.detail-head'),
        page.locator('.card.admin-section').first(),
        `book-detail-${vp}`,
      );

      // (c) The per-format Force-Search LIVE FEEDBACK — fire the Ebook leg, capture the fired chip in place.
      const ebookRow = page.getByTestId('format-row').filter({ hasText: 'Ebook' });
      await ebookRow.getByTestId('format-search-btn').click();
      await ebookRow.locator('.phase-chip[data-phase="fired"]').waitFor();
      await shootRegion(
        page,
        page.locator('.detail-head'),
        page.locator('.card.admin-section').first(),
        `book-fired-${vp}`,
      );

      await page.context().close();

      await composite(browser, vp, [
        { title: 'Movies WANTED detail (reference)', file: `movies-detail-${vp}` },
        { title: 'Book WANTED detail (new) — per-format Force Search', file: `book-detail-${vp}` },
      ]);
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
