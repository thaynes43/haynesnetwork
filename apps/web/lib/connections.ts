// ADR-091 C-10 / DESIGN-050 D-08 / D-14 — the Connected apps rows as the page shows them: pure view-model
// building (no database, no React), so the D-14 copy and the date and chip rules are unit-tested. The server
// page reads through @hnet/domain `listConnectedApps` and hands these to the client component.
import { SCOPE_CHIPS, type OAuthScope } from '@hnet/oauth';
import { DISPLAY_TZ } from './trash';

export interface ConnectedAppInput {
  clientId: string;
  clientName: string;
  redirectHost: string;
  userId: string;
  userEmail: string;
  userName: string;
  connectedAt: Date;
  lastUsedAt: Date | null;
  scopes: OAuthScope[];
}

export interface ConnectionRow {
  /** `<clientId>|<userId>` — one connection (a client for a user). */
  key: string;
  clientId: string;
  userId: string;
  clientName: string;
  redirectHost: string;
  /** D-14 `Connected <date>`. */
  connected: string;
  /** D-14 `Last used <date>` / `Never used`. */
  lastUsed: string;
  /** D-14 chips, in the advertised scope order. */
  chips: string[];
  /** The admin view's user column: display name and email; null in the self view. */
  user: { name: string; email: string } | null;
}

/** A calendar date in the app's display timezone ("Sep 23, 2026"). */
export function connectionDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    timeZone: DISPLAY_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * D-08 / D-14 — one row per connection. `withUser` is the admin view (every user's connections, with a user
 * column); the self view carries no user.
 */
export function connectionRows(
  apps: readonly ConnectedAppInput[],
  opts: { withUser: boolean },
): ConnectionRow[] {
  return apps.map((a) => ({
    key: `${a.clientId}|${a.userId}`,
    clientId: a.clientId,
    userId: a.userId,
    clientName: a.clientName,
    redirectHost: a.redirectHost,
    connected: `Connected ${connectionDate(a.connectedAt)}`,
    lastUsed: a.lastUsedAt ? `Last used ${connectionDate(a.lastUsedAt)}` : 'Never used',
    chips: a.scopes.map((s) => SCOPE_CHIPS[s]),
    user: opts.withUser ? { name: a.userName, email: a.userEmail } : null,
  }));
}
