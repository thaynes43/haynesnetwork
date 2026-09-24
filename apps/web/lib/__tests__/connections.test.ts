// ADR-091 C-10 / DESIGN-050 D-08 / D-14 — the Connected apps page (@hnet/auth and @hnet/domain mocked — web tests
// never touch a database): the D-14 copy and chips, the self view vs the admin view (every user's connections,
// with a user column), the Disconnect server action's session and ownership rules, and the client markup — the
// two-step confirm with "Confirm disconnect" armed and the ADR-015 width reservation.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedirectSignal, elements, expand, textOf } from './oauth-helpers';

const getServerSession = vi.hoisted(() => vi.fn());
const listConnectedApps = vi.hoisted(() => vi.fn());
const disconnectClient = vi.hoisted(() => vi.fn());
const headersFn = vi.hoisted(() => vi.fn());
vi.mock('@hnet/auth', () => ({ getServerSession }));
vi.mock('@hnet/domain', () => ({ listConnectedApps, disconnectClient }));
vi.mock('next/headers', () => ({ headers: headersFn }));
vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new RedirectSignal(location);
  },
}));

import { connectionDate, connectionRows, type ConnectedAppInput } from '../connections';
import ConnectionsPage from '../../app/(app)/settings/connections/page';
import { disconnectConnection } from '../../app/(app)/settings/connections/actions';
import { ConnectionsClient } from '../../app/(app)/settings/connections/connections-client';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = 'a'.repeat(32);
const APP: ConnectedAppInput = {
  clientId: CLIENT,
  clientName: 'ChatGPT',
  redirectHost: 'chatgpt.com',
  userId: USER,
  userEmail: 'owner@example.test',
  userName: 'Owner',
  connectedAt: new Date('2026-09-20T15:00:00Z'),
  lastUsedAt: new Date('2026-09-24T02:30:00Z'), // still Sep 23 in New York
  scopes: ['watch:read', 'watch:write', 'offline_access'],
};

const session = (isAdmin = false, id = USER) => ({
  user: { id, email: 'x@example.test', role: { isAdmin } },
});

beforeEach(() => {
  headersFn.mockResolvedValue(new Headers());
  getServerSession.mockReset().mockResolvedValue(session());
  listConnectedApps.mockReset().mockResolvedValue([APP]);
  disconnectClient
    .mockReset()
    .mockResolvedValue({ changed: true, refreshRevoked: 1, accessRevoked: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe('connectionRows (D-14 copy)', () => {
  it('Connected <date> · Last used <date>, the three chips in order, no user column in the self view', () => {
    expect(connectionRows([APP], { withUser: false })).toEqual([
      {
        key: `${CLIENT}|${USER}`,
        clientId: CLIENT,
        userId: USER,
        clientName: 'ChatGPT',
        redirectHost: 'chatgpt.com',
        connected: 'Connected Sep 20, 2026',
        lastUsed: 'Last used Sep 23, 2026',
        chips: ['Read history', 'Mark titles', 'Stays connected'],
        user: null,
      },
    ]);
  });

  it('Never used; a narrower grant shows fewer chips; the admin view carries the user', () => {
    const [row] = connectionRows([{ ...APP, lastUsedAt: null, scopes: ['watch:read'] }], {
      withUser: true,
    });
    expect(row).toMatchObject({
      lastUsed: 'Never used',
      chips: ['Read history'],
      user: { name: 'Owner', email: 'owner@example.test' },
    });
  });

  it("dates are the app's display timezone (America/New_York)", () => {
    expect(connectionDate(new Date('2026-01-01T04:59:00Z'))).toBe('Dec 31, 2025');
    expect(connectionDate(new Date('2026-01-01T05:00:00Z'))).toBe('Jan 1, 2026');
  });
});

describe('the /settings/connections page (D-08)', () => {
  const render = async () => expand(await ConnectionsPage(), ['ConnectionsClient']);

  it('a user sees their OWN connections under the D-14 title and lead', async () => {
    const page = await render();
    expect(listConnectedApps).toHaveBeenCalledWith({ userId: USER });
    const text = textOf(page);
    expect(text).toContain('Connected apps');
    expect(text).toContain(
      'Apps you have allowed to use your watch history. Disconnecting stops an app at its next request.',
    );
    const client = elements(await ConnectionsPage()).find((e) => e.type === ConnectionsClient)!;
    expect((client.props as { rows: Array<{ user: unknown }> }).rows[0]!.user).toBeNull();
  });

  it("an admin sees EVERY user's connections, with the user column", async () => {
    getServerSession.mockResolvedValue(session(true));
    listConnectedApps.mockResolvedValue([
      APP,
      { ...APP, userId: OTHER, userName: 'Kid', userEmail: 'kid@example.test' },
    ]);
    const client = elements(await ConnectionsPage()).find((e) => e.type === ConnectionsClient)!;
    expect(listConnectedApps).toHaveBeenCalledWith({ userId: null });
    const rows = (client.props as { rows: Array<{ user: { name: string } | null }> }).rows;
    expect(rows.map((r) => r.user?.name)).toEqual(['Owner', 'Kid']);
  });

  it('no session ⇒ /login (defense in depth behind the (app) gate)', async () => {
    getServerSession.mockResolvedValue(null);
    await expect(ConnectionsPage()).rejects.toMatchObject({ location: '/login' });
  });
});

describe('the Disconnect action (D-08)', () => {
  it('a user disconnects their own connection, recorded as the actor', async () => {
    expect(await disconnectConnection(CLIENT, USER)).toBe('ok');
    expect(disconnectClient).toHaveBeenCalledWith({
      clientId: CLIENT,
      userId: USER,
      actorUserId: USER,
    });
  });

  it("a user can NOT disconnect someone else's; an admin can", async () => {
    expect(await disconnectConnection(CLIENT, OTHER)).toBe('failed');
    expect(disconnectClient).not.toHaveBeenCalled();
    getServerSession.mockResolvedValue(session(true));
    expect(await disconnectConnection(CLIENT, OTHER)).toBe('ok');
    expect(disconnectClient).toHaveBeenCalledWith({
      clientId: CLIENT,
      userId: OTHER,
      actorUserId: USER,
    });
  });

  it('refuses without a session, and malformed ids before any lookup', async () => {
    getServerSession.mockResolvedValue(null);
    expect(await disconnectConnection(CLIENT, USER)).toBe('failed');
    getServerSession.mockClear();
    for (const [c, u] of [
      ['x', USER],
      [CLIENT, 'not-a-uuid'],
      [42, USER],
    ] as const) {
      expect(await disconnectConnection(c as string, u as string)).toBe('failed');
    }
    expect(getServerSession).not.toHaveBeenCalled();
    expect(disconnectClient).not.toHaveBeenCalled();
  });

  it('a writer failure is "failed" (the button re-arms), logged without internals leaking to the client', async () => {
    disconnectClient.mockRejectedValue(new Error('deadlock detected'));
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a));
    expect(await disconnectConnection(CLIENT, USER)).toBe('failed');
    expect(errors).toEqual([['[oauth] disconnect failed', 'deadlock detected']]);
  });
});

describe('the Connected apps list markup (D-14 / ADR-014 / ADR-015)', () => {
  it('each row: name, host, dates, chips and a two-step Disconnect whose slot reserves "Confirm disconnect"', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionsClient, { rows: connectionRows([APP], { withUser: false }) }),
    );
    expect(html).toContain('<strong>ChatGPT</strong>');
    expect(html).toContain('chatgpt.com');
    expect(html).toContain('Connected Sep 20, 2026 · Last used Sep 23, 2026');
    for (const chip of ['Read history', 'Mark titles', 'Stays connected'])
      expect(html).toContain(`>${chip}</li>`);
    // The resting button, with the armed label as its hidden width ghost (the widest, bold state).
    expect(html).toMatch(/class="confirm-btn btn sm danger conn-row__disconnect"/);
    expect(html).toContain('aria-label="Disconnect ChatGPT — click twice to confirm"');
    expect(html).toContain(
      '<span class="conn-reserve"><span>Disconnect</span><span class="conn-reserve__ghost" aria-hidden="true">Confirm disconnect</span></span>',
    );
    expect(html).not.toContain('data-testid="connection-user"');
  });

  it('the admin view shows the user; no rows ⇒ the D-14 empty state', () => {
    const admin = renderToStaticMarkup(
      createElement(ConnectionsClient, { rows: connectionRows([APP], { withUser: true }) }),
    );
    expect(admin).toContain('Owner · owner@example.test');
    expect(renderToStaticMarkup(createElement(ConnectionsClient, { rows: [] }))).toContain(
      'No connected apps yet.',
    );
  });
});
