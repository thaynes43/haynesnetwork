// ADR-072 / DESIGN-043 D-07 + DESIGN-044 — the screenshot harness for owner sign-off of the first-class
// /collections page AND the full-page collection BUILDER (DESIGN-044, the owner-ruled replacement for the
// tiny popup composer). The 2026-07-18 owner REDESIGN ("gotta catch em all"): the cap meter is gone, the
// builder is a compact config over a full-width member WALL, and the header reads the gamified in-library /
// total with a caught-em-all celebration when complete. Boots its OWN stack (incl. the stub Libretto/arr
// answering the search + preview) and captures the standing matrix (desktop 1280x900 + 390px, dark + light):
//   • the Books sub-section collection list (as admin — the delete lens; rows now read held/total, no cap),
//   • the BUILDER page: the empty type-card step, a populated ref search, an incomplete books preview
//     (held/total + missing chip), the CAUGHT-EM-ALL audiobooks preview, a big NYT-style wall, a movies
//     franchise preview (real posters), and the locked-builder edit,
//   • the over-cap "request it" Modal (as a NON-admin member — over-cap is the server error + ticket only),
//   • the Tickets sub-section admin approve lens (seeded once from a member over-cap request),
//   • the admin Settings sub-section (the size cap + the find-missing grant seam).
//
//   pnpm --filter web exec tsx e2e/support/capture-collections.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { syncBooks, syncBooksCollections, type BooksItemInput } from '@hnet/domain';
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

/**
 * DESIGN-044 — drive the builder PAGE to the over-cap "request it" Modal. Pick the series card, enter a ref
 * carrying "over" (the stub resolves it to 40 members, above the cap of 25 — the preview meter deepens), name
 * it, and Save → the over-cap ticket Modal (a non-admin; admins bypass the cap).
 */
async function openBuilderOverCap(page: Page): Promise<void> {
  await page.goto('/collections/new?tab=books');
  await page.getByTestId('builder-card-hardcover_series').click();
  await page.getByTestId('builder-manual-toggle').click();
  await page.getByTestId('builder-ref-manual').fill('the-cosmere-over-everything');
  await page.getByTestId('builder-name').fill('The Cosmere (everything)');
  // No cap chrome anymore — the preview resolves (40 members), and over-cap surfaces only when Save trips the
  // server COLLECTION_SIZE_CAP_EXCEEDED → the request-larger Modal.
  await page.getByTestId('builder-preview').waitFor();
  await page.getByTestId('builder-missing').waitFor();
  await page.getByTestId('builder-save').click();
  await page.getByTestId('builder-over-cap').waitFor();
}

/** DESIGN-044 — an INCOMPLETE books preview (series search → pick → held/total + the missing chip + wall). */
async function openBuilderPreview(page: Page): Promise<void> {
  await page.goto('/collections/new?tab=books');
  await page.getByTestId('builder-card-hardcover_series').click();
  await page.getByTestId('builder-search-input').fill('storm');
  await page.getByTestId('builder-result').first().click();
  await page.getByTestId('builder-preview').waitFor();
}

/** DESIGN-044 D-05 (owner redesign) — the CAUGHT-EM-ALL state: an audiobooks ref every seeded tile holds. */
async function openBuilderCaughtEmAll(page: Page): Promise<void> {
  await page.goto('/collections/new?tab=audiobooks');
  await page.getByTestId('builder-card-hardcover_series').click();
  await page.getByTestId('builder-manual-toggle').click();
  await page.getByTestId('builder-ref-manual').fill('the-complete-collection');
  await page.getByTestId('builder-name').fill('The Complete Shelf');
  await page.getByTestId('builder-preview').waitFor();
  await page.getByTestId('collection-caught').waitFor();
}

/** DESIGN-044 D-05 (owner redesign) — a big NYT-style list so the preview reads as a full-width Library wall. */
async function openBuilderBigList(page: Page): Promise<void> {
  await page.goto('/collections/new?tab=audiobooks');
  await page.getByTestId('builder-card-nyt_list').click();
  await page.getByTestId('builder-search-input').fill('hard');
  await page.getByTestId('builder-result').first().click();
  await page.getByTestId('builder-preview').waitFor();
  await page.getByTestId('builder-missing').waitFor();
}

// NOTE: a MOVIES/TV (Kometa) builder screenshot is not capturable in this stub harness — the Kometa overview
// binds haynes-ops/GitHub, which the harness does not stub (and Kometa internals are out of scope). The
// movies/TV poster resolution (held proxy + missing provider image) is covered by the @hnet/domain
// collection-builder poster tests + the stub-arr /collection fixture instead.

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
        // A Libretto-produced mirror row bound to the stub's stormlight-archive recipe — the binding the
        // on-demand collection Force Search (ADR-071, owner ruling 2026-07-18) resolves the wants against.
        {
          source: 'kavita',
          externalId: 'capture-stormlight-1',
          kind: 'collection',
          libraryId: null,
          title: 'The Stormlight Archive',
          itemCount: 4,
          ordered: true,
          createdBy: 'libretto',
          librettoRecipeId: 'stormlight-archive',
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [{ source: 'kavita', kind: 'collection' }],
    });

    // DESIGN-044 D-05/D-10 — seed two Kavita library rows whose ISBNs match the first two members the stub
    // preview resolves, so the builder-preview gallery shows a POPULATED "In your library" split beside the
    // Missing group (not an all-missing set). `syncedSources: []` upserts additively (never tombstones the
    // stub-books library the harness already synced). Written through the sanctioned domain writer.
    const kavitaBook = (over: Partial<BooksItemInput> & Pick<BooksItemInput, 'externalId' | 'title' | 'isbn'>): BooksItemInput => ({
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
      coverRef: null, // Kavita covers key off a numeric series id; these synthetic refs 404 → the placeholder.
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

    // Seed ONE over-cap ticket as a member so the admin Tickets approve lens has content. The stack's
    // DB persists across the screenshot matrix below.
    await setPersona(stack.oidc.baseUrl, 'member');
    const seed = await signIn(browser, stack.appUrl, { width: 1280, height: 900 });
    await openBuilderOverCap(seed);
    await seed.getByTestId('builder-over-cap-request').click();
    await seed.getByText('Request sent').waitFor();
    await seed.context().close();

    // Prime the on-demand Force Search once (admin) so the matrix's confirm copy shows the LIVE missing
    // count: the fire re-applies the recipe, mints the stub's two missing wants, and the stub
    // LazyLibrarian absorbs the searches (ADR-071 — the whole action, hermetic).
    await setPersona(stack.oidc.baseUrl, 'admin');
    const prime = await signIn(browser, stack.appUrl, { width: 1280, height: 900 });
    await prime.goto('/collections?tab=books');
    await prime.getByTestId('collection-force-search-btn').first().click();
    await prime.getByTestId('collection-force-search-modal').waitFor();
    await prime.getByTestId('collection-force-search-confirm').click();
    await prime.getByText('Search started').waitFor();
    await prime.context().close();

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

        // The on-demand Force Search confirm Modal (the registry action that replaced "Run now" —
        // ADR-071, owner ruling 2026-07-18) with the live missing count, then the fired in-place state.
        await admin.getByTestId('collection-force-search-btn').first().click();
        await admin.getByTestId('collection-force-search-modal').waitFor();
        await hidePortal(admin);
        await shoot(admin, `force-search-modal-${suffix}`);
        await admin.getByTestId('collection-force-search-confirm').click();
        await admin.getByText('Search started').waitFor();
        await hidePortal(admin);
        await shoot(admin, `force-search-fired-${suffix}`, true);
        await admin.goto('/collections?tab=books');
        await admin.getByTestId('collections-list').waitFor();

        // ── DESIGN-044 — the full-page builder states ──
        // 1) The empty type-card step (the plain-language D-03 cards).
        await admin.goto('/collections/new?tab=books');
        await admin.getByTestId('builder-typecards').waitFor();
        await hidePortal(admin);
        await shoot(admin, `builder-empty-${suffix}`, true);

        // 2) A populated ref search (series typeahead results).
        await admin.getByTestId('builder-card-hardcover_series').click();
        await admin.getByTestId('builder-search-input').fill('stor');
        await admin.getByTestId('builder-search-results').waitFor();
        await hidePortal(admin);
        await shoot(admin, `builder-searched-${suffix}`, true);

        // 3) An INCOMPLETE books preview — the held/total read + the missing chip over the full-width wall.
        await openBuilderPreview(admin);
        await admin.getByTestId('builder-missing').waitFor();
        await hidePortal(admin);
        await shoot(admin, `builder-previewed-${suffix}`, true);

        // 3b) The CAUGHT-EM-ALL celebration — an audiobooks collection the estate fully holds (gold star).
        await openBuilderCaughtEmAll(admin);
        await hidePortal(admin);
        await shoot(admin, `builder-caught-${suffix}`, true);

        // 3c) A big NYT-style list — the preview reads as a full-width Library wall, never a skinny column.
        await openBuilderBigList(admin);
        await hidePortal(admin);
        await shoot(admin, `builder-biglist-${suffix}`, true);

        // 4) The locked-builder edit state (name + type locked; only the ref + options change).
        await admin.goto('/collections/stormlight-archive/edit?tab=books');
        await admin.getByTestId('builder-locked-note').waitFor();
        await hidePortal(admin);
        await shoot(admin, `builder-edit-${suffix}`, true);

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

      // ── Member lens: the over-cap "request it" Modal. There is no cap chrome now — a large collection
      //    resolves like any other; Save trips the server cap and surfaces the ticket Modal (owner ruling). ──
      await setPersona(stack.oidc.baseUrl, 'member');
      const member = await signIn(browser, stack.appUrl, viewport);
      for (const theme of themes) {
        const suffix = `${label}-${theme === 'hnet-dark' ? 'dark' : 'light'}`;
        await setTheme(member, theme);
        // A large (over-cap) draft resolves and reads as a plain held/total wall — no cap advertised.
        await openBuilderOverCap(member); // drives to the Save-tripped over-cap Modal
        await hidePortal(member);
        await shoot(member, `over-cap-${suffix}`);
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
