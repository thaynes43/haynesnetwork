// Screenshot harness for the ADR-029 My Plex owner-recognition fix (owner visual sign-off — the
// memory rule: screenshot approval before ship). Boots the SAME hermetic stack the e2e suite
// uses and captures the two states the fix introduces on /library/plex:
//   1. OWNER state — the signed-in user IS the server owner: every server shows
//      "You own {server} — all libraries are already yours", rows read-only "Included", no
//      add/remove/friend/all-toggle controls (dark + light + mobile 390).
//   2. UNLINKED account — a user who is neither owner nor friend (the local-admin case): the
//      corrected "isn't linked to a Plex identity" note instead of the old "not a friend yet".
//
//   pnpm --filter web exec tsx e2e/support/capture-myplex-owner.ts /path/to/outdir
//
// The stub owner email is pinned to the admin persona ONCE, before any myLibraries call (the read
// client caches the owner account per its lifetime). The admin persona then reads as the owner;
// the fresh-member persona (Default role, not a friend, no Plex identity) reads as unlinked.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';
import { ADMIN_EMAIL, type PersonaName } from './stub-oidc';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-myplex-owner.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3212;

async function shoot(page: Page, name: string): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 68, fullPage: true });
  console.log(`[capture] ${name}`);
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

async function setPersona(oidcBaseUrl: string, persona: PersonaName): Promise<void> {
  const res = await fetch(`${oidcBaseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (res.status !== 204) throw new Error(`persona switch failed: HTTP ${res.status}`);
}

async function setOwner(plexBaseUrl: string, email: string): Promise<void> {
  const res = await fetch(`${plexBaseUrl}/_stub/owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.status !== 204) throw new Error(`owner set failed: HTTP ${res.status}`);
}

async function signInTo(browser: Browser, appUrl: string, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, baseURL: appUrl });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  return page;
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    // Pin the server owner to the admin persona BEFORE any /library/plex load (owner account is
    // cached per read client). All three servers now report admin as their owner.
    await setOwner(stack.plex.baseUrl, ADMIN_EMAIL);

    const browser = await chromium.launch();

    // 1) OWNER state — the admin persona is the owner of all three servers.
    await setPersona(stack.oidc.baseUrl, 'admin');
    const owner = await signInTo(browser, stack.appUrl, { width: 1280, height: 940 });
    await owner.goto('/library/plex');
    await owner.getByText('all libraries are already yours').first().waitFor({ timeout: 20_000 });
    await setTheme(owner, 'hnet-dark');
    await owner.getByText('all libraries are already yours').first().waitFor({ timeout: 20_000 });
    await shoot(owner, 'owner-state-dark');
    await setTheme(owner, 'hnet-light');
    await owner.getByText('all libraries are already yours').first().waitFor({ timeout: 20_000 });
    await shoot(owner, 'owner-state-light');

    // 2) OWNER state — mobile 390.
    const ownerM = await signInTo(browser, stack.appUrl, { width: 390, height: 844 });
    await ownerM.goto('/library/plex');
    await setTheme(ownerM, 'hnet-dark');
    await ownerM.getByText('all libraries are already yours').first().waitFor({ timeout: 20_000 });
    await shoot(ownerM, 'owner-state-mobile-390-dark');

    // 3) UNLINKED account — fresh-member: Default role (has libraries), but neither owner nor a
    //    Plex friend, so the corrected "not linked to a Plex identity" note shows.
    await setPersona(stack.oidc.baseUrl, 'fresh-member');
    const unlinked = await signInTo(browser, stack.appUrl, { width: 1280, height: 940 });
    await unlinked.goto('/library/plex');
    await unlinked.getByText('linked to a Plex identity').first().waitFor({ timeout: 20_000 });
    await setTheme(unlinked, 'hnet-dark');
    await unlinked.getByText('linked to a Plex identity').first().waitFor({ timeout: 20_000 });
    await shoot(unlinked, 'unlinked-account-dark');
    await setTheme(unlinked, 'hnet-light');
    await unlinked.getByText('linked to a Plex identity').first().waitFor({ timeout: 20_000 });
    await shoot(unlinked, 'unlinked-account-light');

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
