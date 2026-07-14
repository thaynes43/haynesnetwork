// PLAN-047 (ADR-058) — per-wall capture harness for the shared-card-system refit. Boots the SAME
// hermetic stack the e2e suite uses, sets up deterministic wall content (seeded ledger, books-sync,
// a linked Goodreads account + one real goodreads-sync run, two Helpdesk tickets filed through the
// UI), then screenshots EVERY poster-idiom wall at desktop-1280 and 390px (dark). Run it once on the
// pre-refit tree and once after, then diff the pairs — the refit bar is pixel-equivalent or
// deliberately better (the reviewer's rule from the PLAN-045 incident).
//
//   pnpm --filter web exec tsx e2e/support/capture-card-walls.ts <output-dir>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack, type RunningStack } from './harness';
import type { PersonaName } from './stub-oidc';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-card-walls.ts <output-dir>');
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

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images).map((img) =>
        img.complete
          ? undefined
          : new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            }),
      ),
    ),
  );
  await page.waitForTimeout(400);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`[capture] ${name}`);
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

    // ── Setup phase (desktop, one-off): link Goodreads + sync (composed-Wanted cards), file the
    // two Helpdesk tickets (one media-linked, one category-only) so the twall has both tile arts.
    {
      const page = await signInTo(browser, stack.appUrl, { width: 1280, height: 900 });
      await page.goto('/integrations/goodreads');
      await page.getByTestId('integrations-profile-input').fill('https://www.goodreads.com/haynesnetwork');
      await page.getByTestId('integrations-link-btn').click();
      await page.getByTestId('integrations-linked').waitFor();
      await runGoodreadsSync(stack, cwd);

      await page.goto('/bulletin');
      await page.getByTestId('ticket-new').click();
      await page.getByTestId('ticket-title').fill('Buffering on everything tonight');
      await page.getByTestId('ticket-category-playback').click();
      await page.getByTestId('ticket-body').fill('All titles, all apps, since about 8pm.');
      await page.getByTestId('ticket-create').click();
      await page.getByTestId('ticket-detail-title').waitFor();

      await page.goto('/bulletin');
      await page.getByTestId('ticket-new').click();
      await page.getByTestId('ticket-title').fill('No sound from minute 3');
      await page.getByTestId('ticket-category-audio').click();
      await page.getByTestId('composer-media-search').fill('Fixture');
      await page
        .getByRole('option', { name: /The Fixture/ })
        .first()
        .click();
      await page.getByTestId('ticket-body').fill('The Fixture drops audio at 03:00.');
      await page.getByTestId('ticket-create').click();
      await page.getByTestId('ticket-detail-title').waitFor();
      await page.context().close();
    }

    // ── The wall matrix (dark; desktop-1280 + 390) ──
    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;

    for (const [label, viewport] of viewports) {
      const page = await signInTo(browser, stack.appUrl, viewport);
      await setTheme(page, 'hnet-dark');

      // 1 — Library Movies (the canonical poster wall).
      await page.goto('/library?tab=movies');
      await page.locator('.poster-card').first().waitFor();
      await shoot(page, `library-movies-${label}-dark`);

      // 2 — Library TV.
      await page.goto('/library?tab=tv');
      await page.locator('.poster-card').first().waitFor();
      await shoot(page, `library-tv-${label}-dark`);

      // 3 — Library Music (KindIcon fallback tiles).
      await page.goto('/library?tab=music');
      await page.locator('.poster-card').first().waitFor();
      await shoot(page, `library-music-${label}-dark`);

      // 4 — Library Peloton (ytdl-sub wall).
      await page.goto('/library?tab=peloton');
      await page.getByTestId('ytdlsub-grid').waitFor();
      await shoot(page, `library-peloton-${label}-dark`);

      // 5 — Library Books FLAT with the composed-Wanted cards merged inline.
      await page.goto('/library?tab=books&view=flat');
      await page.getByTestId('wanted-card').first().waitFor();
      await shoot(page, `library-books-flat-${label}-dark`);

      // 6 — Library Audiobooks GROUPED by author (group cards: portrait/fan art).
      await page.goto('/library?tab=audiobooks&view=grouped');
      await page.getByTestId('books-groups').waitFor();
      await shoot(page, `library-audiobooks-grouped-${label}-dark`);

      // 7 — Library Audiobooks grouped by GENRE (the designed glyph tiles), when offered.
      await page.goto('/library?tab=audiobooks&view=grouped&by=genre');
      await page.getByTestId('books-groups').waitFor();
      await shoot(page, `library-audiobooks-genres-${label}-dark`);

      // 8 — Goodreads items wall (RequestCards: shelf + status badges).
      await page.goto('/integrations/goodreads?tab=items');
      await page.getByTestId('gr-item').first().waitFor();
      await shoot(page, `goodreads-items-${label}-dark`);

      // 9 — Trash pending wall (TrashCards: corner toggle + lib-link pucks, meta line).
      await page.goto('/trash?tab=movies');
      await page.getByTestId('trash-wall').waitFor();
      await page.getByTestId('trash-tile').first().waitFor();
      await shoot(page, `trash-pending-${label}-dark`);

      // 10 — Helpdesk ticket wall (TicketCards: state puck, media poster + category tile).
      await page.goto('/bulletin');
      await page.getByTestId('ticket-tile').first().waitFor();
      await shoot(page, `helpdesk-twall-${label}-dark`);

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
