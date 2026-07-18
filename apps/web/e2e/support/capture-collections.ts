// ADR-072 / DESIGN-043 D-07 (PLAN-052 PR4a) — the screenshot harness for owner sign-off of the
// first-class /collections page. Boots its OWN stack (incl. the stub Libretto) and captures the
// standing matrix (desktop 1280x900 + 390px, dark + light):
//   • the Books sub-section collection list (as admin — the delete lens),
//   • the composer Modal,
//   • the over-cap Modal (as a NON-admin member — admins bypass the cap, so only a member sees it),
//   • the Tickets sub-section admin approve lens (seeded once from a member over-cap request),
//   • the admin Settings sub-section (the size cap + the find-missing grant seam).
//
//   pnpm --filter web exec tsx e2e/support/capture-collections.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { syncBooksCollections } from '@hnet/domain';
import { startStack } from './harness';
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
  console.error('usage: tsx e2e/support/capture-collections.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3225;

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

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  console.log(`[capture] ${name}`);
}

/** Drive the composer to the over-cap Modal (an "over" ref resolves to 40 works, above the cap of 25). */
async function openOverCapModal(page: Page): Promise<void> {
  await page.goto('/collections?tab=books');
  await page.getByTestId('collections-new').click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('textbox', { name: 'Collection id' }).fill('over-cap-epic');
  await page.getByRole('textbox', { name: 'Reference' }).fill('the-cosmere-everything');
  await page.getByTestId('composer-preview-btn').click();
  await page.getByTestId('composer-preview').waitFor();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('collection-over-cap').waitFor();
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const stack = await startStack({ port: PORT, prewarm: false, cwd });
  try {
    // Seed one HAND-MADE Kavita collection (no Libretto recipe) so the Books tab shows the read-only
    // "Made in your library apps" group beside the managed recipes (DESIGN-043 D-02 amend). Written
    // through the sanctioned domain single-writer (never a direct insert — the no-direct-state-writes
    // guard), against the stack's embedded Postgres.
    process.env.DATABASE_URL = stack.pg.connectionString;
    await syncBooksCollections({
      collections: [
        {
          source: 'kavita',
          externalId: 'capture-handmade-1',
          kind: 'collection',
          libraryId: null,
          title: 'Owner’s Kavita Picks',
          itemCount: 12,
          ordered: false,
          createdBy: 'kavita',
          librettoRecipeId: null,
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [{ source: 'kavita', kind: 'collection' }],
    });

    const browser = await chromium.launch();

    // Seed ONE over-cap ticket as a member so the admin Tickets approve lens has content. The stack's
    // DB persists across the screenshot matrix below.
    await setPersona(stack.oidc.baseUrl, 'member');
    const seed = await signIn(browser, stack.appUrl, { width: 1280, height: 900 });
    await openOverCapModal(seed);
    await seed.getByTestId('collection-over-cap-request').click();
    await seed.getByText('Request sent').waitFor();
    await seed.context().close();

    const viewports = [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const;
    const themes = ['hnet-dark', 'hnet-light'] as const;

    for (const [label, viewport] of viewports) {
      // ── Admin lens: the collection list, composer, Tickets approve, Settings ──
      await setPersona(stack.oidc.baseUrl, 'admin');
      const admin = await signIn(browser, stack.appUrl, viewport);
      for (const theme of themes) {
        const suffix = `${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`;
        await setTheme(admin, theme);

        // The Books collection list — both the managed group and the hand-made read-only group.
        await admin.goto('/collections?tab=books');
        await admin.getByTestId('collections-list').waitFor();
        await admin.getByTestId('collections-readonly-list').waitFor();
        await hidePortal(admin);
        await shoot(admin, `collections-books-${suffix}`, true);

        // The composer Modal.
        await admin.getByTestId('collections-new').click();
        await admin.getByRole('dialog').waitFor();
        await hidePortal(admin);
        await shoot(admin, `composer-${suffix}`);
        await admin.keyboard.press('Escape');

        // The Tickets sub-section (admin approve lens).
        await admin.goto('/collections?tab=tickets');
        await admin.getByTestId('all-tickets-list').waitFor();
        await hidePortal(admin);
        await shoot(admin, `tickets-${suffix}`, true);

        // The Settings sub-section (size cap + find-missing seam).
        await admin.goto('/collections?tab=settings');
        await admin.getByTestId('collections-cap-input').waitFor();
        await hidePortal(admin);
        await shoot(admin, `settings-${suffix}`, true);
      }
      await admin.context().close();

      // ── Member lens: the over-cap Modal (admins bypass the cap, so only a member sees it) ──
      await setPersona(stack.oidc.baseUrl, 'member');
      const member = await signIn(browser, stack.appUrl, viewport);
      for (const theme of themes) {
        const suffix = `${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`;
        await setTheme(member, theme);
        await openOverCapModal(member);
        await hidePortal(member);
        await shoot(member, `over-cap-${suffix}`);
        await member.keyboard.press('Escape');
        await member.keyboard.press('Escape');
      }
      await member.context().close();
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
