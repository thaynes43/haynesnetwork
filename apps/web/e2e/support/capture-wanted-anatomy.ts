// PLAN-045 owner-correction (DESIGN-029 amendment) — the ACCEPTANCE side-by-side proof that the
// Books/Audiobooks and Goodreads-items cards now clone the Movies card anatomy EXACTLY. It boots its
// own hermetic stack, links Goodreads + runs the real goodreads-sync, seeds ONE Wanted movie (so the
// Movies wall shows a Wanted card), then for each viewport (desktop + 390, dark) captures the first
// row of three walls cropped so the cards are directly comparable:
//   • movies-<vp>   — the Movies wall (the REFERENCE) with the "Wanted Signal" card
//   • books-<vp>    — the Books flat wall with inline Wanted cards
//   • goodreads-<vp>— the Goodreads items wall
// and stitches each viewport's three crops into a labeled composite `sxs-<vp>.png` (rendered in
// Chromium — no ImageMagick/sharp in this toolchain). The card structure must be indistinguishable
// except the glyph + the badge text.
//
//   pnpm --filter web exec tsx e2e/support/capture-wanted-anatomy.ts <output-dir>
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
  console.error('usage: tsx e2e/support/capture-wanted-anatomy.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3227;

async function hidePortal(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function setDark(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));
  await page.reload();
  await page.locator('html[data-theme="hnet-dark"]').waitFor();
}

async function signInTo(browser: Browser, appUrl: string, viewport: { width: number; height: number }): Promise<Page> {
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

/** Crop a poster grid to its FIRST ROW so every wall's cards line up at the same scale. */
async function shootGridRow(page: Page, grid: Locator, out: string): Promise<void> {
  await grid.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const box = await grid.boundingBox();
  const cardBox = await grid.locator('.poster-card').first().boundingBox();
  if (!box || !cardBox) throw new Error(`no box for ${out}`);
  const clipHeight = Math.min(box.height, cardBox.height * 1.14);
  await page.screenshot({ path: join(OUT, `${out}.png`), clip: { x: box.x, y: box.y, width: box.width, height: clipHeight } });
  console.log(`[capture] ${out}`);
}

/** Stitch three crops into one labeled composite, rendered in Chromium (data-URI images). */
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
    <h1>PLAN-045 fix — one cohesive poster block across walls (${label})</h1>
    <div class="row">${cards}</div>
  </body></html>`;
  const context = await browser.newContext({ viewport: { width: 1600, height: 700 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `sxs-${label}.png`), fullPage: true });
  await context.close();
  console.log(`[capture] sxs-${label}`);
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

      // (a) Movies wall — the REFERENCE — with the Wanted Signal card (Added-desc ⇒ it leads).
      await page.goto('/library?tab=movies');
      await page.locator('.poster-card', { hasText: 'Wanted Signal' }).first().waitFor();
      await shootGridRow(page, page.locator('.media-list.poster-grid').first(), `movies-${vp}`);

      // (b) Books flat wall — Wanted cards merged INLINE with on-disk books.
      await page.goto('/library?tab=books&view=flat');
      await page.getByTestId('wanted-card').first().waitFor();
      await shootGridRow(page, page.getByTestId('books-grid'), `books-${vp}`);

      // (c) Goodreads items wall.
      await page.goto('/integrations/goodreads?tab=items');
      await page.getByTestId('gr-item').first().waitFor();
      await shootGridRow(page, page.getByTestId('gr-items-grid'), `goodreads-${vp}`);

      await page.context().close();

      await composite(browser, vp, [
        { title: 'Movies wall (reference) — Wanted Signal', file: `movies-${vp}` },
        { title: 'Books wall — inline Wanted cards', file: `books-${vp}` },
        { title: 'Goodreads items wall', file: `goodreads-${vp}` },
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
