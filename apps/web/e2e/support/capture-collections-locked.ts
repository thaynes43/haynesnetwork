// Owner ruling 2026-07-18 — screenshot proof of the /collections Movies list IMMUTABLE tag + the SOURCE
// multi-select filter. The Movies/TV (Kometa) leg binds haynes-ops/GitHub, which the standing
// capture-collections.ts harness does not stub (see its note); this dedicated harness stands a tiny fake
// GitHub READ server in front of the same @hnet/haynesops read client (env: GITHUB_API_URL) so the real app
// renders a real Movies list:
//   • an "Added here" app-managed recipe row (from the app-owned managed include),
//   • an EDITABLE "Kometa config" hand-file row (single allowlisted builder → active Edit),
//   • a LOCKED "Kometa config" hand-file row (multi-builder, too custom → greyed Edit + the "Locked" tag).
// Captures (390 + desktop, dark): the full list (editable vs Locked side by side), the source-filter chip
// OPEN, and the list FILTERED (Locked unchecked → the immutable row hidden).
//
//   pnpm --filter web exec tsx e2e/support/capture-collections-locked.ts <output-dir>
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { compileManagedFile } from '@hnet/domain';
import { startStack } from './harness';
import type { PersonaName } from './stub-oidc';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-collections-locked.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3226;
const REPO = 'thaynes43/haynes-ops';
const CONFIG_DIR = 'kubernetes/main/apps/media/kometa/app/config';
const MANAGED_FILE = 'hnet-managed-movies.yml';
const HAND_FILE = 'movies-franchises.yml';

// One app-managed movies recipe → the "Added here" row (compiled by the real serializer, so the manifest
// the app reads back is byte-authentic).
const MANAGED_MOVIES = compileManagedFile({
  mediaType: 'movies',
  recipes: [
    {
      id: 'fast-saga',
      name: 'The Fast Saga',
      mediaType: 'movies',
      builderType: 'tmdb_collection_details',
      builderRef: '9485',
      syncMode: 'sync',
      ordered: false,
      findMissing: false,
    },
  ],
});

// A hand-authored franchise file: one single-builder collection (EDITABLE "Kometa config") and one
// multi-builder collection (LOCKED — too custom to model here). Mirrors the estate's real layout.
const HAND_MOVIES = `# The estate's hand-authored movie franchise collections (Kometa collection_files include).
collections:
  The Bourne Collection:
    tmdb_collection_details: 31562
    sort_title: "!E Bourne"
  John Wick:
    tmdb_collection_details: 404609
  The Marvel Cinematic Universe:
    tmdb_movie: [1726, 10138, 10195]
    imdb_list: https://www.imdb.com/list/ls000000001/
`;

/** A tiny GitHub REST READ stand-in: contents (dir listing + file), and an empty open-PR list. */
function startFakeGithub(): Promise<{ server: Server; baseUrl: string }> {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const fileBody = (text: string) =>
    JSON.stringify({ content: b64(text), encoding: 'base64', sha: `sha-${text.length}` });

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      const json = (payload: string) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
      };
      if (path === `/repos/${REPO}/contents/${CONFIG_DIR}`) {
        // Directory listing — the app scans for movies-*.yml hand files (excludes the app include itself).
        json(
          JSON.stringify([
            { name: MANAGED_FILE, type: 'file' },
            { name: HAND_FILE, type: 'file' },
          ]),
        );
        return;
      }
      if (path === `/repos/${REPO}/contents/${CONFIG_DIR}/${MANAGED_FILE}`) {
        json(fileBody(MANAGED_MOVIES));
        return;
      }
      if (path === `/repos/${REPO}/contents/${CONFIG_DIR}/${HAND_FILE}`) {
        json(fileBody(HAND_MOVIES));
        return;
      }
      if (path === `/repos/${REPO}/pulls`) {
        json('[]');
        return;
      }
      // Any other content path (e.g. the tv include) is a normal "absent" read.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function setPersona(oidcBaseUrl: string, persona: PersonaName): Promise<void> {
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

async function setThemeDark(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));
  await page.reload();
  await page.locator('html[data-theme="hnet-dark"]').waitFor();
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

async function shoot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const github = await startFakeGithub();
  // The Movies/TV overview reads haynes-ops through @hnet/haynesops; point it at the fake GitHub server and
  // give it a (stub) write token so the env contract is satisfied. Set BEFORE startStack so the spawned Next
  // dev child inherits them (it boots with { ...process.env, ...composed }).
  process.env.HAYNESOPS_WRITE_TOKEN = 'stub-haynesops-token';
  process.env.GITHUB_API_URL = github.baseUrl;
  process.env.HAYNESOPS_REPO = REPO;
  process.env.HAYNESOPS_BASE_BRANCH = 'main';
  process.env.HAYNESOPS_KOMETA_CONFIG_DIR = CONFIG_DIR;

  const stack = await startStack({ port: PORT, prewarm: false, cwd });
  try {
    const browser = await chromium.launch();
    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;

    await setPersona(stack.oidc.baseUrl, 'admin');
    for (const [label, viewport] of viewports) {
      const page = await signIn(browser, stack.appUrl, viewport);
      await setThemeDark(page);

      // 1) The full Movies list — the "Added here" recipe + the editable and LOCKED "Kometa config" rows.
      await page.goto('/collections?tab=movies');
      await page.getByTestId('collections-list').waitFor();
      await page.getByTestId('collection-locked-badge').first().waitFor();
      await hidePortal(page);
      await shoot(page, `collections-movies-locked-${label}-dark`);

      // 2) The SOURCE filter chip OPEN (the multi-select checklist — Added here / Kometa config / Locked).
      await page.locator('[data-testid="collections-source-filter"] .hnet-chip-open').click();
      await page.getByRole('dialog').waitFor();
      await hidePortal(page);
      await shoot(page, `collections-movies-filter-open-${label}-dark`, false);

      // 3) Uncheck "Locked" → the immutable row is hidden. Then close the popover and shoot the filtered list.
      await page.getByRole('dialog').locator('.hnet-chip-check', { hasText: 'Locked' }).click();
      await page.getByTestId('collection-locked-badge').first().waitFor({ state: 'detached' });
      await page.keyboard.press('Escape');
      await hidePortal(page);
      await shoot(page, `collections-movies-filtered-${label}-dark`);

      await page.context().close();
    }
    await browser.close();
  } finally {
    await stack.stop();
    await new Promise<void>((r) => github.server.close(() => r()));
  }
  console.log(`[capture] done → ${OUT}`);
}

main().catch((err: unknown) => {
  console.error('[capture] failed:', err);
  process.exit(1);
});
