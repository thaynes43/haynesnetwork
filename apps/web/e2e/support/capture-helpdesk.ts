// PLAN-034 (ADR-050 / DESIGN-012 D-10..D-13) — screenshot harness for owner sign-off of the
// Helpdesk: the ticket poster WALL (state pucks + badges, category icon tiles, reply counts,
// state filter chips), the compose MODAL (title / category icon-grid / linked-title picker /
// details / GitHub note), and the ticket DETAIL (hero + staff transition buttons + History
// timeline + reply thread). Boots the hermetic stack (embedded PG16 with all migrations incl.
// 0040, stub OIDC + stub *arrs for real posters), seeds a realistic mixed-state wall THROUGH THE
// DOMAIN SINGLE-WRITERS (never a raw write), and captures desktop + 390px in dark + light.
//
//   pnpm --filter web exec tsx e2e/support/capture-helpdesk.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { db } from '@hnet/db';
import { addTicketReply, createTicket, transitionTicket } from '@hnet/domain';
import { startStack } from './harness';
import { ADMIN_EMAIL, type PersonaName } from './stub-oidc';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-helpdesk.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3224;

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

async function userIdByEmail(email: string): Promise<string> {
  const row = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email) });
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function mediaIdByTitle(title: string): Promise<string> {
  const row = await db.query.mediaItems.findFirst({ where: (m, { eq }) => eq(m.title, title) });
  if (!row) throw new Error(`media item not found: ${title}`);
  return row.id;
}

/** Seed the mixed-state wall through the real writers (the states the owner asked to see). */
async function seedTickets(): Promise<void> {
  const admin = await userIdByEmail(ADMIN_EMAIL);
  const member = await userIdByEmail('member@example.test');
  const fixture = await mediaIdByTitle('The Fixture');
  const breaking = await mediaIdByTitle('Breaking Prod');
  const stubRunner = await mediaIdByTitle('Stub Runner');

  // 1 — IN PROGRESS with a staff note + a member reply (the "living" ticket).
  const t1 = await createTicket({
    authorId: member,
    title: 'No sound from minute 3',
    body: 'Living-room TV, every playback. Audio drops out around 03:00 and never comes back.',
    category: 'audio',
    mediaItemId: fixture,
  });
  await transitionTicket({
    ticketId: t1.id,
    actorId: admin,
    toStatus: 'in_progress',
    note: 'Checking the audio track — looks like a bad mux',
  });
  await addTicketReply({
    ticketId: t1.id,
    authorId: member,
    body: 'Happens on the bedroom TV too, so probably not the client.',
  });

  // 2 — OPEN, linked to a show (fresh report).
  await createTicket({
    authorId: member,
    title: 'Buffering mid-episode on S02',
    body: 'Every episode of season 2 stalls around the 20-minute mark.',
    category: 'playback',
    mediaItemId: breaking,
  });

  // 3 — COMPLETE with a resolution comment (what "done" looks like).
  const t3 = await createTicket({
    authorId: admin,
    title: 'Subtitles out of sync',
    body: 'English subs drift about 2 seconds by the end.',
    category: 'subtitles',
    mediaItemId: stubRunner,
  });
  await transitionTicket({
    ticketId: t3.id,
    actorId: admin,
    toStatus: 'complete',
    note: 'Re-synced via Bazarr — try it now',
  });

  // 4 — REJECTED, non-media (the category icon tile + the GitHub-bound reason).
  const t4 = await createTicket({
    authorId: member,
    title: 'Request page looks broken on my phone',
    body: 'The request button overlaps the poster on small screens.',
    category: 'other',
  });
  await transitionTicket({
    ticketId: t4.id,
    actorId: admin,
    toStatus: 'rejected',
    note: 'Site bug, not a media issue — filed on GitHub',
  });

  // 5 — OPEN, non-media MISSING (the second icon-tile flavour).
  await createTicket({
    authorId: member,
    title: 'Season 3 is missing episodes 4–6',
    body: 'The season jumps from episode 3 straight to 7.',
    category: 'missing',
  });
}

async function shootWall(page: Page, name: string): Promise<void> {
  await page.goto('/bulletin?tab=helpdesk');
  await page.getByRole('tablist', { name: 'Bulletin sections' }).waitFor();
  await page.getByTestId('ticket-wall').waitFor();
  // Let the posters stream in from the stub *arr before shooting.
  await hidePortal(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`[capture] ${name}`);
}

async function shootCompose(page: Page, name: string): Promise<void> {
  await page.goto('/bulletin?tab=helpdesk');
  await page.getByTestId('ticket-new').waitFor();
  await page.getByTestId('ticket-new').click();
  await page.getByTestId('ticket-compose').waitFor();
  await page.getByTestId('ticket-title').fill('No sound from minute 3');
  await page.getByTestId('ticket-category-audio').click();
  await hidePortal(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[capture] ${name}`);
  await page.keyboard.press('Escape');
}

async function shootDetail(page: Page, name: string): Promise<void> {
  await page.goto('/bulletin?tab=helpdesk');
  await page.getByTestId('ticket-wall').waitFor();
  await page
    .getByTestId('ticket-tile')
    .filter({ hasText: 'No sound from minute 3' })
    .locator('.twall-link')
    .click();
  await page.waitForURL(/\/bulletin\/ticket\//);
  await page.getByTestId('ticket-timeline').waitFor();
  await hidePortal(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  // Point the lazy @hnet/db client at the stack's embedded Postgres before the first query.
  process.env.DATABASE_URL = stack.pg.connectionString;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // Log both personas in ONCE so their user rows exist, then seed the wall via the writers.
    await setPersona(stack.oidc.baseUrl, 'member');
    const warm = await signInTo(browser, stack.appUrl, { width: 800, height: 600 });
    await warm.context().close();
    await setPersona(stack.oidc.baseUrl, 'admin');
    const adminDesktop = await signInTo(browser, stack.appUrl, { width: 1280, height: 1100 });
    await seedTickets();

    // ── ADMIN desktop: wall + compose + detail, dark then light ──
    await setTheme(adminDesktop, 'hnet-dark');
    await shootWall(adminDesktop, 'helpdesk-wall-desktop-dark');
    await shootCompose(adminDesktop, 'helpdesk-compose-desktop-dark');
    await shootDetail(adminDesktop, 'helpdesk-detail-desktop-dark');
    await setTheme(adminDesktop, 'hnet-light');
    await shootWall(adminDesktop, 'helpdesk-wall-desktop-light');
    await shootCompose(adminDesktop, 'helpdesk-compose-desktop-light');
    await shootDetail(adminDesktop, 'helpdesk-detail-desktop-light');

    // ── ADMIN 390px (the owner-declared weakest page's acid test) ──
    const adminMobile = await signInTo(browser, stack.appUrl, { width: 390, height: 1100 });
    await setTheme(adminMobile, 'hnet-dark');
    await shootWall(adminMobile, 'helpdesk-wall-390-dark');
    await shootCompose(adminMobile, 'helpdesk-compose-390-dark');
    await shootDetail(adminMobile, 'helpdesk-detail-390-dark');
    await setTheme(adminMobile, 'hnet-light');
    await shootWall(adminMobile, 'helpdesk-wall-390-light');
    await shootCompose(adminMobile, 'helpdesk-compose-390-light');
    await shootDetail(adminMobile, 'helpdesk-detail-390-light');

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
