// DESIGN-009 / ADR-021 / ADR-022 end to end: the /ledger section — nav gating by section
// level, the spreadsheet browse over EVERYTHING (tombstones included, unlike /library), the
// ledger-only Monitored/Has-file chips + sortable headers (URL-synced, deep-linkable), the
// JSONL export of the CURRENT filter set (AC-12), the selection → Modal → bulk
// Monitor-&-search run against the stub *arr with its per-item report (AC-11), the
// Read-Only/Disabled role behaviors (AC-13), and the /admin/roles section-access editor.
//
// Seeded movies (support/seed-ledger.ts): The Fixture (monitored, on disk, live+monitored in
// the stub *arr → SKIP), Stub Runner (monitored, on disk, ABSENT from the stub live list →
// ADD), Vanished Heist (unmonitored, fileless, TOMBSTONED in the ledger; present-but-
// unmonitored in the stub live list → MONITOR-FLIP). Serial like the rest of the suite —
// tests share one stack, and the role-juggling tests restore the member to Default.
import { test, expect, type Page } from '@playwright/test';
import { signIn, expectViewportFit, openUserMenu } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  STUB_MOVIE_TMDB_ID,
  STUB_VANISHED_ID,
  STUB_VANISHED_TMDB_ID,
  type RecordedArrWrite,
} from './support/stub-arr';

async function openLedgerMovies(page: Page): Promise<void> {
  await page.goto('/ledger');
  await expect(page.locator('.ledger-row').filter({ hasText: 'The Fixture' })).toHaveCount(1);
}

/** The visible Title-cell texts, in DOM (= sort) order. */
async function rowTitles(page: Page): Promise<string[]> {
  return page.locator('.ledger-table tbody .ledger-title').allInnerTexts();
}

/** Assign the Marge Member persona's user to a role by name (admin user-detail select). */
async function assignMemberRole(page: Page, roleLabel: string): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Marge Member' }).click();
  await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
  // The select applies on change — wait for the setRole mutation round trip so the next
  // sign-in (or reload) is guaranteed to see the new role.
  const settled = page.waitForResponse((r) => r.url().includes('users.setRole'));
  await page.locator('#user-role').selectOption({ label: roleLabel });
  await settled;
}

test.describe('ledger section (DESIGN-009)', () => {
  test('admin: Ledger rides the user menu (ADR-032); the spreadsheet shows everything, tombstones included', async ({
    page,
  }) => {
    await signIn(page, 'admin');

    // ADR-032 / DESIGN-004 D-16 — the top row is the UNIVERSAL section nav (Home · Library ·
    // Trash · Bulletin; the admin's implicit trash=edit shows Trash, Bulletin defaults
    // read_only for everyone). Ledger and My Plex moved into the user menu.
    const navTexts = await page.locator('.topbar__nav a').allInnerTexts();
    expect(navTexts).toEqual(['Home', 'Library', 'Trash', 'Bulletin']);
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: 'My Plex' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Ledger' }).click();
    await page.waitForURL('/ledger');

    // The tablist: three media sheets + the Runs history tab (owner UX 2026-07-07).
    expect(await page.getByRole('tab').allInnerTexts()).toEqual(['Movies', 'TV', 'Music', 'Runs']);

    // Movies default tab: all three seeded movies — the tombstoned one INCLUDED (D-04),
    // which /library never shows.
    await expect(page.locator('.ledger-row')).toHaveCount(3);
    expect(await rowTitles(page)).toEqual(['The Fixture', 'Stub Runner', 'Vanished Heist']);

    // The spreadsheet columns are all present.
    for (const col of [
      'Title',
      'Year',
      'Monitored',
      'On disk',
      'Size',
      'Quality',
      'Root',
      'Rating',
      'Votes',
      'Requesters',
      'Collections',
      'Removed',
      'Added',
    ]) {
      await expect(page.locator('.ledger-table thead')).toContainText(col);
    }

    // Row facts: The Fixture is monitored (✓), 1/1 on disk, rated; Vanished Heist is
    // unmonitored, 0/1, and carries its tombstone date in the Removed column.
    const fixture = page.locator('.ledger-row').filter({ hasText: 'The Fixture' });
    await expect(fixture.locator('.ledger-yes')).toHaveCount(1);
    await expect(fixture).toContainText('1/1');
    await expect(fixture).toContainText('★ 7.7');
    const vanished = page.locator('.ledger-row').filter({ hasText: 'Vanished Heist' });
    await expect(vanished.locator('.ledger-yes')).toHaveCount(0);
    await expect(vanished).toContainText('0/1');
    await expect(vanished.locator('.ledger-removed')).toHaveCount(1);

    // Title cells are click-throughs to the /library detail page.
    await expect(fixture.locator('a.ledger-title')).toHaveAttribute(
      'href',
      /^\/library\/[0-9a-f-]{36}$/,
    );

    // TV tab: Breaking Prod; Music tab: The Stub Band (music included — Q-04).
    await page.getByRole('tab', { name: 'TV' }).click();
    await expect(page.locator('.ledger-row').filter({ hasText: 'Breaking Prod' })).toHaveCount(1);
    await expect(page.locator('.ledger-row').filter({ hasText: 'Breaking Prod' })).toContainText(
      '9/10',
    );
    await page.getByRole('tab', { name: 'Music' }).click();
    await expect(page.locator('.ledger-row').filter({ hasText: 'The Stub Band' })).toHaveCount(1);
  });

  test('the ledger-only chips (Monitored / Has file) narrow the sheet, sync the URL, and deep-link', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openLedgerMovies(page);
    const wrapBefore = (await page.getByTestId('ledger-tablewrap').boundingBox())!;

    // Monitored · No → only the unmonitored tombstoned row; the URL carries ?mon=no.
    await page.getByTitle('Edit the Monitored filter').click();
    const monPopover = page.getByRole('dialog', { name: 'Edit the Monitored filter' });
    await monPopover.getByLabel('No', { exact: true }).click();
    await expect(page.locator('.ledger-row')).toHaveCount(1);
    expect(await rowTitles(page)).toEqual(['Vanished Heist']);
    await expect(page).toHaveURL(/mon=no/);
    // Single-select semantics: choosing Yes REPLACES No.
    await monPopover.getByLabel('Yes', { exact: true }).click();
    await expect(page).toHaveURL(/mon=yes/);
    await expect(page.locator('.ledger-row')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Monitored' })).toContainText(
      'Monitored · Yes',
    );

    // Has file · None on top → nothing is monitored AND fileless → honest empty state.
    await page.getByTitle('Edit the Has file filter').click();
    await page
      .getByRole('dialog', { name: 'Edit the Has file filter' })
      .getByLabel('None', { exact: true })
      .click();
    await expect(page).toHaveURL(/file=none/);
    await expect(page.locator('.ledger-row')).toHaveCount(0);
    await expect(page.locator('.ledger-empty')).toBeVisible();

    // The chip bar + sheet never moved while filtering (ADR-015).
    const wrapAfter = (await page.getByTestId('ledger-tablewrap').boundingBox())!;
    expect(wrapAfter.y).toBe(wrapBefore.y);

    // Deep link: ?mon=no&file=none restores both chips and the one matching row.
    await page.goto('/ledger?tab=movies&mon=no&file=none');
    await expect(page.locator('.ledger-row')).toHaveCount(1);
    expect(await rowTitles(page)).toEqual(['Vanished Heist']);
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Monitored' })).toContainText(
      'Monitored · No',
    );
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Has file' })).toContainText(
      'Has file · None',
    );

    // Tab switch keeps ONLY ?tab — the Movies filters never leak into TV.
    await page.getByRole('tab', { name: 'TV' }).click();
    await expect(page).toHaveURL(/\/ledger\?tab=tv$/);
    await expect(page.locator('.ledger-row').filter({ hasText: 'Breaking Prod' })).toHaveCount(1);
  });

  test('sortable headers: Rating toggles best-first ↔ reversed (two-state, never clears), nulls always last', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openLedgerMovies(page);

    const ratingHeader = page
      .locator('.ledger-table thead')
      .getByRole('button', { name: 'Rating' });
    // The URL syncs synchronously, but the re-sorted rows swap in place only once the
    // placeholderData refetch settles (ADR-015 — the old order stays, dimmed, until then). Read
    // the order with expect.poll so the assertion waits out that window instead of racing it.
    await ratingHeader.click();
    await expect(page).toHaveURL(/sort=imdb_rating%3Adesc|sort=imdb_rating:desc/);
    await expect.poll(() => rowTitles(page)).toEqual(['The Fixture', 'Stub Runner', 'Vanished Heist']);

    await ratingHeader.click();
    await expect(page).toHaveURL(/sort=imdb_rating%3Aasc|sort=imdb_rating:asc/);
    // Ascending still keeps the unrated row LAST (NULLS LAST keyset, D-09).
    await expect.poll(() => rowTitles(page)).toEqual(['Stub Runner', 'The Fixture', 'Vanished Heist']);

    // Third click toggles BACK to best-first — the header never silently clears the sort (the
    // reported nit: the old third click dropped ?sort= and the sheet looked unsorted).
    await ratingHeader.click();
    await expect(page).toHaveURL(/sort=imdb_rating%3Adesc|sort=imdb_rating:desc/);
    await expect.poll(() => rowTitles(page)).toEqual(['The Fixture', 'Stub Runner', 'Vanished Heist']);
  });

  test('export streams the CURRENT filter set as JSONL — deterministic, filter-true (AC-12)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openLedgerMovies(page);

    // The Export control is labeled with the honest row count and mirrors the live filter in
    // its href (the FILTER, never the selection).
    await expect(page.getByTestId('ledger-export')).toContainText('Export filtered (3 rows)');
    await page.getByTitle('Edit the Monitored filter').click();
    await page
      .getByRole('dialog', { name: 'Edit the Monitored filter' })
      .getByLabel('No', { exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ledger-export')).toContainText('Export filtered (1 row)');
    await expect(page.getByTestId('ledger-export')).toHaveAttribute(
      'href',
      /\/api\/ledger\/export\?.*monitored=false/,
    );

    // The narrowed export: exactly the one unmonitored row, tombstone included, round-trippable.
    const narrow = await page.request.get('/api/ledger/export?arrKind=radarr&monitored=false');
    expect(narrow.status()).toBe(200);
    expect(narrow.headers()['content-disposition']).toContain('attachment');
    expect(narrow.headers()['content-type']).toContain('application/x-ndjson');
    const narrowLines = (await narrow.text()).trim().split('\n');
    expect(narrowLines).toHaveLength(1);
    const row = JSON.parse(narrowLines[0]!) as Record<string, unknown>;
    expect(row).toMatchObject({
      kind: 'radarr',
      title: 'Vanished Heist',
      tmdbId: STUB_VANISHED_TMDB_ID,
      monitored: false,
      onDisk: false,
      qualityProfileName: 'Any',
    });
    expect(row.tombstonedAt).not.toBeNull();

    // The whole-tab export: all three movies, ordered by (sort_title, id).
    const full = await page.request.get('/api/ledger/export?arrKind=radarr');
    const titles = (await full.text())
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { title: string }).title);
    expect(titles).toEqual(['The Fixture', 'Stub Runner', 'Vanished Heist']);
  });

  test('selection → Modal → bulk Monitor & search: added / monitored / skipped, stub-verified (AC-11)', async ({
    page,
  }) => {
    const env = readRuntimeEnv();
    await page.request.post(`${env.STUB_ARR_URL}/_stub/reset`);
    await signIn(page, 'admin');
    await openLedgerMovies(page);

    // Baseline geometry (ADR-015): selecting rows recolors them; the bar and sheet must not move.
    const barBefore = (await page.locator('.ledger-actionsbar').boundingBox())!;
    const wrapBefore = (await page.getByTestId('ledger-tablewrap').boundingBox())!;

    // Page-level select-all → 3 selected; the row tint flips, nothing reflows.
    await page.getByLabel('Select all loaded rows').check();
    await expect(page.getByTestId('ledger-selected-count')).toHaveText('3 selected');
    await expect(page.locator('.ledger-row.is-selected')).toHaveCount(3);
    const barAfter = (await page.locator('.ledger-actionsbar').boundingBox())!;
    const wrapAfter = (await page.getByTestId('ledger-tablewrap').boundingBox())!;
    expect(barAfter.y).toBe(barBefore.y);
    expect(barAfter.height).toBe(barBefore.height);
    expect(wrapAfter.y).toBe(wrapBefore.y);

    // The explanatory Modal (ADR-014): outcome matrix + the search toggle (default ON).
    await page.getByTestId('ledger-bulk-open').click();
    const dialog = page.getByRole('dialog', { name: 'Monitor & search in Radarr' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('3 selected items');
    await expect(dialog).toContainText('added monitored');
    await expect(dialog).toContainText('switched to monitored');
    await expect(dialog).toContainText('skipped');
    await expect(
      dialog.getByLabel('Trigger a search for each added or newly-monitored item'),
    ).toBeChecked();

    // Submit → the per-item report replaces the confirm (AC-11), keyed off ok/outcome/searched.
    await page.getByTestId('ledger-bulk-submit').click();
    const report = page.getByTestId('ledger-run-report');
    await expect(report).toBeVisible();
    await expect(page.getByTestId('ledger-run-summary')).toContainText('1 added');
    await expect(page.getByTestId('ledger-run-summary')).toContainText('1 monitored');
    await expect(page.getByTestId('ledger-run-summary')).toContainText('1 skipped');
    await expect(page.getByTestId('ledger-run-summary')).toContainText('0 failed');
    await expect(page.getByTestId('ledger-run-summary')).toContainText('2 search commands sent');

    const reportRow = (title: string) => report.locator('tbody tr').filter({ hasText: title });
    await expect(reportRow('Stub Runner')).toContainText('added');
    await expect(reportRow('Stub Runner')).toContainText('searched');
    await expect(reportRow('Vanished Heist')).toContainText('monitored');
    await expect(reportRow('Vanished Heist')).toContainText('searched');
    await expect(reportRow('The Fixture')).toContainText('skipped');
    await expect(reportRow('The Fixture')).toContainText('already present and monitored');

    // The stub *arr saw exactly the sanctioned writes: one add POST (Stub Runner, monitored),
    // one bulk-editor monitor PUT (Vanished Heist's live id), and two search commands.
    const { calls } = (await (
      await page.request.get(`${env.STUB_ARR_URL}/_stub/calls`)
    ).json()) as { calls: RecordedArrWrite[] };
    const addCalls = calls.filter((c) => c.method === 'POST' && c.path === '/movie');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.body).toMatchObject({ tmdbId: 880002, monitored: true });
    expect(addCalls[0]!.body).not.toMatchObject({ tmdbId: STUB_MOVIE_TMDB_ID });
    const editorCalls = calls.filter((c) => c.method === 'PUT' && c.path === '/movie/editor');
    expect(editorCalls).toHaveLength(1);
    expect(editorCalls[0]!.body).toMatchObject({ movieIds: [STUB_VANISHED_ID], monitored: true });
    const searchCalls = calls.filter(
      (c) =>
        c.method === 'POST' &&
        c.path === '/command' &&
        (c.body as { name?: string }).name === 'MoviesSearch',
    );
    expect(searchCalls).toHaveLength(2);

    // Close the report (the Modal is retitled 'Run report' once the run lands); the selection
    // was consumed and the sheet reflects the monitor flip.
    const reportDialog = page.getByRole('dialog', { name: 'Run report' });
    await reportDialog.getByRole('button', { name: 'Done' }).click();
    await expect(reportDialog).toBeHidden();
    await expect(page.getByTestId('ledger-selected-count')).toHaveText('0 selected');
    await expect(
      page.locator('.ledger-row').filter({ hasText: 'Vanished Heist' }).locator('.ledger-yes'),
    ).toHaveCount(1);

    // The media tabs no longer carry a Recent-runs card below the sheet (owner UX
    // 2026-07-07) — run history lives on the Runs tab.
    await expect(page.getByTestId('ledger-runs')).toHaveCount(0);

    // The Runs tab lists the run: when/media/status/outcome-counts/initiator on one row.
    await page.getByRole('tab', { name: 'Runs' }).click();
    await expect(page).toHaveURL(/\/ledger\?tab=runs$/);
    const runsList = page.getByTestId('ledger-runs');
    await expect(runsList.locator('.ledger-runcard')).toHaveCount(1);
    const runCard = runsList.locator('.ledger-runcard').first();
    await expect(runCard).toContainText('Movies');
    await expect(runCard).toContainText('Completed');
    await expect(runCard).toContainText('1 added');
    await expect(runCard).toContainText('1 monitored');
    await expect(runCard).toContainText('1 skipped');
    await expect(runCard).toContainText('0 failed');
    await expect(runCard).toContainText('by Bootstrap Admin');

    // The media-type filter narrows server-side and rides the URL: TV → none of these
    // (honest filtered-empty copy), Movies → the run, All → everything again.
    const filterBar = page.getByRole('group', { name: 'Filter runs by media type' });
    const barBox = (await filterBar.boundingBox())!;
    await filterBar.getByRole('button', { name: 'TV' }).click();
    await expect(page).toHaveURL(/kind=tv/);
    await expect(runsList.locator('.ledger-runcard')).toHaveCount(0);
    await expect(page.getByTestId('ledger-runs-empty')).toContainText('No TV runs yet');
    await filterBar.getByRole('button', { name: 'Movies' }).click();
    await expect(page).toHaveURL(/kind=movies/);
    await expect(runsList.locator('.ledger-runcard')).toHaveCount(1);

    // Expanding a run opens its per-item report IN PLACE (sanctioned ADR-015 expansion —
    // titles resolve via the run's preview); the filter bar above must not move.
    await runsList.locator('.ledger-runcard__head').first().click();
    const inlineReport = runsList.getByTestId('ledger-run-report');
    await expect(inlineReport).toBeVisible();
    await expect(inlineReport.getByTestId('ledger-run-summary')).toContainText('1 added');
    await expect(inlineReport.locator('tbody tr').filter({ hasText: 'Stub Runner' })).toContainText(
      'added',
    );
    const barBoxAfter = (await filterBar.boundingBox())!;
    expect(barBoxAfter.y).toBe(barBox.y);
    // Collapse again — the card contracts back to its header row.
    await runsList.locator('.ledger-runcard__head').first().click();
    await expect(inlineReport).toBeHidden();

    // Leave the shared stub call log clean — later spec files (library.spec's AC-07 flow)
    // assert exact call counts against it.
    await page.request.post(`${env.STUB_ARR_URL}/_stub/reset`);
  });

  test('read-only role: browse + export stay, selection and Monitor & search are gone (AC-13)', async ({
    page,
    browser,
  }) => {
    // Member signs in FIRST (creates the user row on first OIDC login — keeps this spec
    // self-sufficient standalone); the role change then applies on their next request.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');

    await signIn(page, 'admin');
    await assignMemberRole(page, 'Ledger Read-Only');

    // The user menu carries the role-gated Ledger entry (ADR-032 — Read-Only ⇒ shown)…
    await memberPage.goto('/');
    await openUserMenu(memberPage);
    await expect(memberPage.getByRole('menuitem', { name: 'Ledger' })).toBeVisible();
    await memberPage.keyboard.press('Escape');
    // …the sheet browses (tombstones included) and Export stays…
    await memberPage.goto('/ledger');
    await expect(memberPage.locator('.ledger-row')).toHaveCount(3);
    await expect(memberPage.getByTestId('ledger-export')).toBeVisible();
    // …but there is no Monitor & search, no selection column, no select-all.
    await expect(memberPage.getByTestId('ledger-bulk-open')).toHaveCount(0);
    await expect(memberPage.locator('.ledger-check')).toHaveCount(0);
    await expect(memberPage.getByTestId('ledger-selected-count')).toHaveCount(0);

    // The Runs tab is a READ surface (ledgerAdmin.runs gates at read_only) — Read-Only
    // browses run history; only the run-CREATING bulk action above is edit-gated.
    await memberPage.getByRole('tab', { name: 'Runs' }).click();
    await expect(memberPage.getByTestId('ledger-runs')).toBeVisible();
    // Settled (skeleton gone) without a FORBIDDEN alert — the read gate admits Read-Only.
    await expect(memberPage.getByTestId('ledger-runs-skeleton')).toHaveCount(0);
    await expect(memberPage.locator('.alert')).toHaveCount(0);

    // The export route serves Read-Only callers.
    const res = await memberPage.request.get('/api/ledger/export?arrKind=radarr');
    expect(res.status()).toBe(200);

    await memberContext.close();
  });

  test('default + disabled roles: NO Ledger anywhere (ADR-032 default flip); a direct URL gets the clean unavailable state', async ({
    page,
    browser,
  }) => {
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');

    // The read-only test above left the member on 'Ledger Read-Only' — put them back on
    // Default FIRST so this test exercises the shipped default experience.
    await signIn(page, 'admin');
    await assignMemberRole(page, 'Default (default)');

    // ADR-032 — the shipped Default role (no ledger row) now resolves DISABLED: no top-row
    // entry (the row is universal — Home · Library · Bulletin for this role), no user-menu
    // Ledger item (My Plex stays — it's personal), and the route dead-ends.
    await memberPage.goto('/');
    expect(await memberPage.locator('.topbar__nav a').allInnerTexts()).toEqual([
      'Home',
      'Library',
      'Bulletin',
    ]);
    await openUserMenu(memberPage);
    await expect(memberPage.getByRole('menuitem', { name: 'My Plex' })).toBeVisible();
    await expect(memberPage.getByRole('menuitem', { name: 'Ledger' })).toHaveCount(0);
    await memberPage.keyboard.press('Escape');
    await memberPage.goto('/ledger');
    await expect(memberPage.getByTestId('ledger-unavailable')).toBeVisible();

    // An explicit Disabled row behaves identically (the section level rides the session
    // read — a reload suffices).
    await assignMemberRole(page, 'Ledger Disabled');
    await memberPage.goto('/');
    expect(await memberPage.locator('.topbar__nav a').allInnerTexts()).toEqual([
      'Home',
      'Library',
      'Bulletin',
    ]);
    await openUserMenu(memberPage);
    await expect(memberPage.getByRole('menuitem', { name: 'Ledger' })).toHaveCount(0);
    await memberPage.keyboard.press('Escape');

    // …and the direct URL renders the friendly dead end, never a raw error.
    await memberPage.goto('/ledger');
    await expect(memberPage.getByTestId('ledger-unavailable')).toBeVisible();
    await expect(memberPage.getByTestId('ledger-unavailable')).toContainText(
      'isn’t available on your account',
    );
    await expect(memberPage.locator('.ledger-table')).toHaveCount(0);

    await memberContext.close();

    // Restore the member to Default — the later spec files depend on its seeded grants.
    await assignMemberRole(page, 'Default (default)');
  });

  test('/admin/roles: the Ledger access editor — Admin implicit Edit, levels persist', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/roles');

    // The Admin role shows its implicit Edit, uneditable (ADR-021 C-03).
    const adminRow = page.locator('.admin-table tbody tr').filter({ hasText: 'superuser' });
    await expect(adminRow).toContainText('Edit');
    await expect(adminRow.locator('.section-select')).toHaveCount(0);

    // The seeded Read-Only role's select reflects its stored level; a change persists.
    const roSelect = page.getByLabel('Ledger access for Ledger Read-Only');
    await expect(roSelect).toHaveValue('read_only');
    await roSelect.selectOption('edit');
    await expect(roSelect).toHaveValue('edit');
    await page.reload();
    await expect(page.getByLabel('Ledger access for Ledger Read-Only')).toHaveValue('edit');
    // Put it back (the seeded roles stay canonical for the suite).
    await page.getByLabel('Ledger access for Ledger Read-Only').selectOption('read_only');
    await expect(page.getByLabel('Ledger access for Ledger Read-Only')).toHaveValue('read_only');
  });

  test('portrait mobile 390×844: the 13-column sheet becomes stacked cards — scannable, selectable, filterable', async ({
    page,
  }) => {
    // Owner report 2026-07-07: the spreadsheet was a sideways-panning wall on a phone. Below
    // 640px the wrap paints .ledger-cards (condensed 3-line cards) instead of the <table>.
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await page.goto('/ledger');

    const cards = page.getByTestId('ledger-cards');
    const card = (title: string) => cards.getByTestId('ledger-card').filter({ hasText: title });

    // The sheet is swapped for cards — one per seeded movie, tombstone included (D-04) — and
    // the desktop <table> is not painted at this width.
    await expect(cards.getByTestId('ledger-card')).toHaveCount(3);
    await expect(page.locator('.ledger-table')).toBeHidden();
    // The whole point: the page no longer scrolls sideways (no 1080px pan wall — AC-10).
    await expectViewportFit(page);

    // Each card condenses the row: title + kind, the condensed facts (on-disk/size/rating), the
    // monitored ✓ cue, and the Removed badge on the tombstone. (Assertions stay independent of
    // the serial suite's monitor-flips: The Fixture is skipped by the bulk run so it stays
    // monitored; Vanished Heist's tombstone is permanent.)
    await expect(card('The Fixture')).toContainText('Movie');
    await expect(card('The Fixture')).toContainText('1/1 files');
    await expect(card('The Fixture')).toContainText('★ 7.7');
    await expect(card('The Fixture').locator('.ledger-yes')).toHaveCount(1); // monitored ✓
    await expect(card('Vanished Heist')).toContainText('Removed');

    // Tapping the card body opens the item page (the same /library/[id] deep link as the sheet).
    await expect(card('The Fixture').getByTestId('ledger-card-link')).toHaveAttribute(
      'href',
      /^\/library\/[0-9a-f-]{36}$/,
    );

    // Selection rides the edge checkbox — export/bulk stay usable on mobile. The card re-tints
    // (is-selected), the actions bar recounts; the count control sits ABOVE the cards and holds.
    const barBefore = (await page.locator('.ledger-actionsbar').boundingBox())!;
    await card('The Fixture').getByRole('checkbox').check();
    await expect(page.getByTestId('ledger-selected-count')).toHaveText('1 selected');
    await expect(card('The Fixture')).toHaveClass(/is-selected/);
    const barAfter = (await page.locator('.ledger-actionsbar').boundingBox())!;
    expect(barAfter.y).toBe(barBefore.y);
    // Export still mirrors the FILTER set (three rows), never the one-item selection (AC-12).
    await expect(page.getByTestId('ledger-export')).toContainText('Export filtered (3 rows)');

    // A search narrows the cards to the one title match and clears the now-stale selection
    // (membership changed). Title search is deterministic regardless of the suite's monitor state.
    await page.locator('.library-search').fill('Vanished');
    await expect(cards.getByTestId('ledger-card')).toHaveCount(1);
    await expect(cards.getByTestId('ledger-card')).toContainText('Vanished Heist');
    await expect(page.getByTestId('ledger-selected-count')).toHaveText('0 selected');
    await expect(page).toHaveURL(/q=Vanished/);

    // The chip bar stays one fixed-height pan-row (never wraps — ADR-015).
    const bar = (await page.locator('.library-chipbar').boundingBox())!;
    expect(bar.height).toBeLessThanOrEqual(52);
  });

  test('tablet-portrait 768×1024: the sheet still pans INSIDE its container (table mode above 640px)', async ({
    page,
  }) => {
    // The card swap is a phone treatment (<640px); at tablet-portrait the full spreadsheet is
    // back, panning inside its wrap while the page stays viewport-clean.
    await page.setViewportSize({ width: 768, height: 1024 });
    await signIn(page, 'admin');
    await openLedgerMovies(page);

    const wrap = page.getByTestId('ledger-tablewrap');
    const overflow = await wrap.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeGreaterThan(100);
    await expect(page.getByTestId('ledger-cards')).toBeHidden();
    await expectViewportFit(page);

    // The frozen Title column holds its x as the sheet pans right.
    const titleCell = page.locator('.ledger-row .col-title').first();
    const xBefore = (await titleCell.boundingBox())!.x;
    await wrap.evaluate((el) => el.scrollTo({ left: 300 }));
    const xAfter = (await titleCell.boundingBox())!.x;
    expect(Math.abs(xAfter - xBefore)).toBeLessThan(2);
  });
});
