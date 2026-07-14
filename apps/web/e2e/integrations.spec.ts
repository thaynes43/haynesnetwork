// ADR-055 / DESIGN-028 (PLAN-044) end to end — the Integrations tab: the section gate (fresh member
// gets NO tab + a "not available" state; admin implied edit), the link flow (a vanity Goodreads URL →
// resolved + shelf probed → linked), the goodreads-sync (mirror → mint → BOTH-format LazyLibrarian push →
// reconcile → coverage %), the requests/Missing wall (per-format chips; a Missing routable request offers
// Search again; the comic is parked out of LL), and the audited manual re-search firing a real LL
// searchBook (asserted via the LL stub's call recorder).
//
// NB: the file name keeps this suite ordering-stable; it links the admin's Goodreads account into the
// shared DB, which only this spec queries.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';

interface LlCall {
  cmd: string;
  id: string | null;
  type: string | null;
}

function runGoodreadsSync(): void {
  const env = readRuntimeEnv();
  const run = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=goodreads-sync'],
    { env: { ...process.env, ...env }, stdio: 'inherit', cwd: process.cwd() },
  );
  expect(run.status, 'goodreads-sync subprocess must succeed').toBe(0);
}

async function llCalls(): Promise<LlCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_LAZYLIBRARIAN_URL}/_stub/calls`);
  const body = (await res.json()) as { calls: LlCall[] };
  return body.calls;
}

async function resetLl(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_LAZYLIBRARIAN_URL}/_stub/reset`, { method: 'POST' });
}

// ADR-056 (PLAN-046) — the Kapowarr stub call recorder (comic add + auto_search force-search).
interface KapowarrCall {
  method: string;
  path: string;
  comicvineId?: number;
  volumeId?: number;
  cmd?: string;
}
async function kapowarrCalls(): Promise<KapowarrCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_KAPOWARR_URL}/_stub/calls`);
  const body = (await res.json()) as { calls: KapowarrCall[] };
  return body.calls;
}

test.describe('Integrations tab', () => {
  test('a fresh member sees no Integrations tab and a not-available state', async ({ page }) => {
    await signIn(page, 'fresh-member');
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Integrations' })).toHaveCount(0);
    await page.goto('/integrations');
    await expect(page.getByTestId('integrations-unavailable')).toBeVisible();
  });

  test('admin links Goodreads, syncs, sees coverage + Missing, and re-searches', async ({ page }) => {
    await resetLl();
    await signIn(page, 'admin');

    // The tab is present for admin (implied edit on every section).
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Integrations' }).click();
    await expect(page.getByTestId('integrations-link-card')).toBeVisible();

    // Link via the VANITY URL — resolved server-side to the numeric id, shelf probed.
    await page.getByTestId('integrations-profile-input').fill('https://www.goodreads.com/haynesnetwork');
    await page.getByTestId('integrations-link-btn').click();
    await expect(page.getByTestId('integrations-linked')).toBeVisible();

    // Run the real goodreads-sync (mirror → mint → LazyLibrarian push → reconcile → coverage).
    runGoodreadsSync();

    // The both-format queueBook push + searchBook reached LazyLibrarian for the two routable novels only
    // (the comic goes to Kapowarr, never LL). addBook alone would land Skipped — queueBook is the mandatory follow.
    const calls = await llCalls();
    const queued = calls.filter((c) => c.cmd === 'queueBook');
    expect(queued.some((c) => c.type === 'eBook')).toBe(true);
    expect(queued.some((c) => c.type === 'AudioBook')).toBe(true);
    expect(calls.some((c) => c.cmd === 'addBook')).toBe(true);
    // BOTH comics are parked — neither touched LazyLibrarian. Scott Pilgrim is caught by the full-category
    // confirm GET (search truncated it to "Fiction"); Batman by the "DC Comics" title marker (no GB categories).
    expect(calls.some((c) => c.id === 'gb-scottpilgrim')).toBe(false);
    expect(calls.some((c) => c.id === 'gb-batman')).toBe(false);

    // ADR-056 — the comic was routed to KAPOWARR: a volume was ADDED (its own GetComics-DDL source, not LL).
    const kapo = await kapowarrCalls();
    expect(kapo.some((c) => c.path === '/api/volumes' && c.method === 'POST')).toBe(true);

    await page.reload();

    // Coverage renders (Ready Player One landed → 1 of 4 = 25%).
    await expect(page.getByTestId('integrations-coverage')).toContainText('25%');

    // The requests wall shows all four wants.
    await expect(page.getByTestId('request-card')).toHaveCount(4);

    // Throne of Glass is Missing (LL Skipped) → Search again is offered.
    const tog = page.getByTestId('request-card').filter({ hasText: 'Throne of Glass' });
    await expect(tog).toContainText('Missing');
    const searchBtn = tog.getByTestId('request-search-btn');
    await expect(searchBtn).toBeVisible();

    // Scott Pilgrim IS routed to Kapowarr (the stub's ComicVine search matches it) — a Comic status chip,
    // Wanted (monitored), NOT queued in LazyLibrarian; its Force-Search dispatches to Kapowarr below.
    const comic = page.getByTestId('request-card').filter({ hasText: 'Scott Pilgrim' });
    await expect(comic).toContainText('Comic');
    await expect(comic).toContainText('Wanted');
    // Batman "Zero Year" has NO ComicVine match (the Kapowarr stub returns none) → it stays PARKED out of
    // LazyLibrarian, showing the Kapowarr routing note (no Search again — the hourly CronJob retries).
    await expect(page.getByTestId('request-card').filter({ hasText: 'Zero Year' })).toContainText(
      'Kapowarr',
    );

    // Manual "Search again" on the routable book fires a real LL searchBook.
    await resetLl();
    await searchBtn.click();
    await expect(async () => {
      const after = await llCalls();
      expect(after.some((c) => c.cmd === 'searchBook' && c.id === 'gb-tog')).toBe(true);
    }).toPass({ timeout: 10_000 });

    // ADR-056 — the comic's Force-Search dispatches to KAPOWARR's auto_search task (never LazyLibrarian).
    const comicSearchBtn = comic.getByTestId('request-search-btn');
    await expect(comicSearchBtn).toBeVisible();
    await comicSearchBtn.click();
    await expect(async () => {
      const after = await kapowarrCalls();
      expect(after.some((c) => c.path === '/api/system/tasks' && c.cmd === 'auto_search')).toBe(true);
    }).toPass({ timeout: 10_000 });
  });
});
