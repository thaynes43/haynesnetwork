// DESIGN-004 D-17 close-out — render the LIVE production MOTD copy (the markdown-link version now
// stored in prod app_settings) through the real compose form + <MotdBanner> in the hermetic stack,
// and capture it at desktop + 390px in both themes. Validates: themed SVG glyph (no emoji), the
// GitHub markdown link renders as a real anchor, no raw syntax, no 390px overflow.
//
//   pnpm --filter web exec tsx e2e/support/capture-motd-live.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';
import type { PersonaName } from './stub-oidc';

const PROD_MESSAGE =
  'Welcome! The site is very new so please file any issues or feature requests on ' +
  '[GitHub](https://github.com/thaynes43/haynesnetwork/issues) and I will tend to them. ' +
  'Or just tell me.';

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
  console.error('usage: tsx e2e/support/capture-motd-live.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3227;

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

async function shootBanner(page: Page, name: string, fullPage: boolean): Promise<void> {
  await page.goto('/');
  const banner = page.getByTestId('motd-banner');
  await banner.waitFor();
  // The markdown link must render as a real anchor with the right href — and no raw syntax.
  const link = banner.getByRole('link', { name: 'GitHub' });
  const href = await link.getAttribute('href');
  if (href !== 'https://github.com/thaynes43/haynesnetwork/issues') {
    throw new Error(`GitHub link href wrong: ${href}`);
  }
  const text = (await banner.textContent()) ?? '';
  if (text.includes('](') || text.includes('https://github.com')) {
    throw new Error('raw markdown syntax leaked into the rendered banner');
  }
  await hidePortal(page);
  await page.waitForTimeout(300);
  if (fullPage) {
    await page.screenshot({ path: join(OUT, `${name}.png`) });
  } else {
    await banner.screenshot({ path: join(OUT, `${name}.png`) });
  }
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    const browser = await chromium.launch();

    // ── Compose the prod message through the real admin form (real writer, real clamp) ──
    await setPersona(stack.oidc.baseUrl, 'admin');
    const admin = await signInTo(browser, stack.appUrl, { width: 1280, height: 1000 });
    await admin.goto('/admin/motd');
    await admin.getByLabel('Message', { exact: true }).fill(PROD_MESSAGE);
    await admin.getByLabel('Severity', { exact: true }).selectOption('info');
    const enabled = admin.getByRole('checkbox', { name: /Enabled/ });
    if (!(await enabled.isChecked())) await enabled.check();
    await admin.getByRole('button', { name: 'Save', exact: true }).click();
    await admin.getByRole('status').waitFor();
    await hidePortal(admin);
    await admin.waitForTimeout(300);
    await admin.screenshot({ path: join(OUT, 'motd-compose-desktop-dark.png') });
    console.log('[capture] motd-compose-desktop-dark');

    // ── The banner as a member sees it ──
    await setPersona(stack.oidc.baseUrl, 'member');
    const memberDesktop = await signInTo(browser, stack.appUrl, { width: 1280, height: 900 });
    await setTheme(memberDesktop, 'hnet-dark');
    await shootBanner(memberDesktop, 'motd-banner-desktop-dark', false);
    await setTheme(memberDesktop, 'hnet-light');
    await shootBanner(memberDesktop, 'motd-banner-desktop-light', false);

    const memberMobile = await signInTo(browser, stack.appUrl, { width: 390, height: 844 });
    await setTheme(memberMobile, 'hnet-dark');
    await shootBanner(memberMobile, 'motd-banner-390-dark', true);
    await setTheme(memberMobile, 'hnet-light');
    await shootBanner(memberMobile, 'motd-banner-390-light', true);

    // No horizontal overflow at 390px.
    const overflow = await memberMobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) throw new Error(`390px horizontal overflow: ${overflow}px`);
    console.log('[capture] 390px overflow check passed');

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
