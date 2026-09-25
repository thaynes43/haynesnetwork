// ADR-091 / DESIGN-050 (PLAN-069 S5) — the public connector end to end in the real stack (next dev + embedded
// Postgres 16 + the stub OIDC — no mocks): a client registers (RFC 7591), a SIGNED-OUT browser hits
// /oauth/authorize, goes through /login?next= and the stub sign-in straight back to the consent page (D-09), sees
// the D-14 copy with the redirect host and the non-owner watch:write line, approves; the code comes back to the
// client's callback with its state; the PKCE exchange yields tokens that open the public /mcp. Then the user finds
// the connection under Connected apps (user menu), disconnects it with the two-step confirm WITHOUT the row
// moving (ADR-015), sees "Disconnected" in place, and the token is 401 at /mcp at once. A second test denies.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { readRuntimeEnv } from './support/env';
import {
  SIGN_IN_BUTTON,
  expectViewportFit,
  openUserMenu,
  selectStubUser,
  signIn,
} from './support/helpers';
import { STUB_USERS, type PersonaName } from './support/stub-oidc';

const BASE = 'http://localhost:3100';
const CALLBACK = 'https://connector.e2e.test/callback';
/** A disconnected token was presented and refused: `error="invalid_token"` (RFC 6750 §3.1). */
const CHALLENGE_HEADER = `Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;

async function register(name: string): Promise<string> {
  const res = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [CALLBACK] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Capture the browser's arrival at the client's (external) callback instead of leaving the app. */
async function captureCallback(page: Page): Promise<() => URL | null> {
  let seen: URL | null = null;
  await page.route('https://connector.e2e.test/**', async (route) => {
    seen = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'connector callback' });
  });
  return () => seen;
}

function authorizeUrl(clientId: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'watch:read watch:write offline_access',
    resource: `${BASE}/mcp`,
  });
  return `/oauth/authorize?${q.toString()}`;
}

const mcp = (token: string) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

test.describe('public MCP connectors (ADR-091)', () => {
  test('connect through /login?next= and consent, use /mcp, then disconnect from Connected apps without reflow', async ({
    page,
  }) => {
    const clientId = await register('E2E Connector');
    const { verifier, challenge } = pkce();
    const callback = await captureCallback(page);
    await selectStubUser('member');

    // Signed out: the authorize request sends the browser to sign in, then straight back to it (D-09).
    await page.goto(authorizeUrl(clientId, challenge, 'e2e-state'));
    await page.waitForURL(/\/login\?next=/);
    await page.getByRole('button', { name: SIGN_IN_BUTTON }).click();
    await page.waitForURL(/\/oauth\/consent\?txn=/);

    // D-14, verbatim — a member is not the server owner, so watch:write promises the history only.
    await expect(page.getByRole('heading', { name: 'Connect E2E Connector' })).toBeVisible();
    await expect(
      page.getByText(
        'E2E Connector wants to use your watch history on haynesnetwork. It will act as your account and can only do what you approve below.',
      ),
    ).toBeVisible();
    await expect(page.getByText('Sends you back to connector.e2e.test.')).toBeVisible();
    await expect(page.getByText('See what you have watched, what is unfinished, and your watchlist')).toBeVisible();
    await expect(page.getByText('Mark titles watched or dismissed in your history')).toBeVisible();
    await expect(page.getByText('Stay connected without signing in again')).toBeVisible();
    // ADR-015: both buttons reserve the same width.
    const approve = page.getByRole('button', { name: 'Approve' });
    const deny = page.getByRole('button', { name: 'Deny' });
    expect((await approve.boundingBox())!.width).toBeCloseTo((await deny.boundingBox())!.width, 0);

    await approve.click();
    await expect.poll(() => callback()?.searchParams.get('code') ?? null).not.toBeNull();
    const cb = callback()!;
    expect(cb.searchParams.get('state')).toBe('e2e-state');

    // The PKCE exchange at the token endpoint.
    const tokenRes = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: cb.searchParams.get('code')!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CALLBACK,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('cache-control')).toBe('no-store');
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.scope).toBe('watch:read watch:write offline_access');
    expect(tokens.refresh_token).toBeTruthy();

    // The token opens the public /mcp.
    const listed = await mcp(tokens.access_token);
    expect(listed.status).toBe(200);
    const tools = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result
      .tools;
    expect(tools).toHaveLength(7);

    // Connected apps, from the user menu.
    await page.goto('/');
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: 'Connected apps' }).click();
    await page.waitForURL('/settings/connections');
    await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
    await expect(
      page.getByText(
        'Apps you have allowed to use your watch history. Disconnecting stops an app at its next request.',
      ),
    ).toBeVisible();
    const row = page.getByTestId('connection-row').filter({ hasText: 'E2E Connector' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('connector.e2e.test');
    await expect(row).toContainText(/Connected [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    await expect(row).toContainText(/Last used [A-Z][a-z]{2} \d{1,2}, \d{4}/); // /mcp stamped it
    for (const chip of ['Read history', 'Mark titles', 'Stays connected'])
      await expect(row.getByText(chip)).toBeVisible();
    await expect(row.getByTestId('connection-user')).toHaveCount(0); // a member sees no user column

    // Disconnect: arm, confirm — the row never moves or resizes (ADR-015).
    const button = row.getByTestId('connection-disconnect');
    // The visible label is the first span of the reserve; the second is the hidden width ghost.
    const label = (el: typeof button) => el.locator('.conn-reserve > span').first();
    const rowBox = (await row.boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    await expect(label(button)).toHaveText('Disconnect');
    await expect(button).toHaveAccessibleName('Disconnect E2E Connector — click twice to confirm');
    await button.click();
    await expect(label(button)).toHaveText('Confirm disconnect');
    await expect(button).toHaveAccessibleName('Confirm disconnect E2E Connector');
    expect(await row.boundingBox()).toEqual(rowBox);
    expect((await button.boundingBox())!.width).toBeCloseTo(buttonBox.width, 0);
    await page.waitForTimeout(350); // past the ConfirmButton's double-click guard
    await button.click();
    const done = row.getByTestId('connection-disconnected');
    await expect(label(done)).toHaveText('Disconnected');
    expect(await row.boundingBox()).toEqual(rowBox);
    expect((await done.boundingBox())!.width).toBeCloseTo(buttonBox.width, 0);

    // The app is stopped at its next request.
    const after = await mcp(tokens.access_token);
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toBe(CHALLENGE_HEADER);
    // And its refresh token is dead too.
    const refreshed = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshed.status).toBe(400);

    // Reloaded, the connection is gone.
    await page.reload();
    await expect(
      page.getByTestId('connection-row').filter({ hasText: 'E2E Connector' }),
    ).toHaveCount(0);
  });

  test('Deny sends the client access_denied with its state, and connects nothing', async ({
    page,
  }) => {
    const clientId = await register('E2E Denied');
    const { challenge } = pkce();
    const callback = await captureCallback(page);
    await selectStubUser('member');
    await page.goto('/login');
    await page.getByRole('button', { name: SIGN_IN_BUTTON }).click();
    await page.waitForURL('/');
    await page.goto(authorizeUrl(clientId, challenge, 'deny-state'));
    await page.waitForURL(/\/oauth\/consent\?txn=/);
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(() => callback()?.searchParams.get('error') ?? null).toBe('access_denied');
    expect(callback()!.searchParams.get('state')).toBe('deny-state');
    expect(callback()!.searchParams.get('code')).toBeNull();
    await page.goto('/settings/connections');
    await expect(page.getByTestId('connection-row').filter({ hasText: 'E2E Denied' })).toHaveCount(
      0,
    );
  });

  test('"Connected apps" is a universal user-menu item (even a fresh member) → /settings/connections', async ({
    page,
  }) => {
    await signIn(page, 'fresh-member');
    await openUserMenu(page);
    const item = page
      .getByRole('menu', { name: 'Account' })
      .getByRole('menuitem', { name: 'Connected apps' });
    await expect(item).toHaveClass(/usermenu__item/);
    await item.click();
    await page.waitForURL('/settings/connections');
    await expect(page.getByText('No connected apps yet.')).toBeVisible();
  });

  test('a parameter error (plain PKCE) never reaches the client: signed out → our login; signed in → the bad-request page (D-15 #24/#25)', async ({
    page,
  }) => {
    const clientId = await register('E2E Plain');
    const callback = await captureCallback(page);
    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(CALLBACK)) seen.push(r.url());
    });
    const url = authorizeUrl(clientId, pkce().challenge, 'plain-state').replace(
      'code_challenge_method=S256',
      'code_challenge_method=plain',
    );
    await page.goto(url);
    await page.waitForURL(/\/login\?next=/);
    // Signed in, the same request comes back to /oauth/authorize and renders the card — still no redirect.
    await selectStubUser('member');
    await page.getByRole('button', { name: SIGN_IN_BUTTON }).click();
    await page.waitForURL(/\/oauth\/authorize\?/);
    await expect(
      page.getByRole('heading', { name: 'Something is off with this connection request' }),
    ).toBeVisible();
    expect(callback()).toBeNull();
    expect(seen).toEqual([]);
  });

  test('every page refuses to be framed (RFC 9700 §4.16): X-Frame-Options DENY + frame-ancestors none', async ({
    page,
  }) => {
    for (const path of [
      '/login',
      '/oauth/consent?txn=x',
      `/oauth/authorize?client_id=${'0'.repeat(32)}`,
    ]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.headers()['x-frame-options'], path).toBe('DENY');
      expect(res.headers()['content-security-policy'], path).toBe("frame-ancestors 'none'");
    }
  });

  test('an unknown client renders the bad-request page in place (never a redirect)', async ({
    page,
  }) => {
    await page.goto(
      `/oauth/authorize?response_type=code&client_id=${'0'.repeat(32)}&redirect_uri=${encodeURIComponent('https://evil.e2e.test/cb')}&state=x`,
    );
    await expect(
      page.getByRole('heading', { name: 'Something is off with this connection request' }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/oauth/authorize');
  });
});

// AC-10 / R-60 — the resize matrix on Connected apps with 0, 1 and 5 rows (and the admin view with its user
// column): no page-level scrollbar, nothing off-screen, <main> owns the overflow, the first Disconnect reachable.
const SIZES = [
  { w: 375, h: 667 },
  { w: 390, h: 844 },
  { w: 412, h: 915 },
  { w: 768, h: 1024 },
  { w: 820, h: 1180 },
  { w: 1280, h: 800 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
] as const;

function seedConnections(persona: PersonaName, count: number): void {
  const env = readRuntimeEnv();
  const run = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [
      join(process.cwd(), 'e2e', 'support', 'seed-connections.ts'),
      STUB_USERS[persona].email,
      String(count),
    ],
    { env: { ...process.env, ...env }, encoding: 'utf8', cwd: process.cwd() },
  );
  expect(run.status, run.stderr || 'seed-connections must succeed').toBe(0);
}

async function expectMatrix(page: Page, rows: number): Promise<void> {
  for (const { w, h } of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/settings/connections');
    await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
    await expect(page.getByTestId('connection-row')).toHaveCount(rows);
    if (rows === 0) await expect(page.getByText('No connected apps yet.')).toBeInViewport();
    else await expect(page.getByTestId('connection-disconnect').first()).toBeInViewport();
    await expectViewportFit(page);
    const hOverflow = await page.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.scrollWidth - main.clientWidth : -1;
    });
    expect(hOverflow, `no horizontal overflow inside <main> @ ${w}x${h}`).toBeLessThanOrEqual(1);
  }
}

test.describe('Connected apps — resize matrix (AC-10) with 0, 1 and 5 rows', () => {
  test.setTimeout(120_000);

  test('0 rows (a fresh member)', async ({ page }) => {
    await signIn(page, 'fresh-member');
    await expectMatrix(page, 0);
  });

  test('1 row', async ({ page }) => {
    await signIn(page, 'plex-linked-owner');
    seedConnections('plex-linked-owner', 1);
    await expectMatrix(page, 1);
  });

  test('5 rows, long names, loopback and https hosts, narrower grants', async ({ page }) => {
    await signIn(page, 'plex-linked-owner-id');
    seedConnections('plex-linked-owner-id', 5);
    await expectMatrix(page, 5);
  });

  test("the admin view (every user's connections, with the user column)", async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/settings/connections');
    const rows = await page.getByTestId('connection-row').count();
    expect(rows).toBeGreaterThanOrEqual(6);
    await expect(page.getByTestId('connection-user').first()).toBeVisible();
    await expectMatrix(page, rows);
  });
});
