// ADR-091 / DESIGN-050 D-04 / D-05 step 1 / D-06 — the OAuth client single-writer (`registerClient`, RFC 7591
// DCR) and the two client reads every endpoint starts with. @hnet/oauth validates and decides; this module is
// the only place an `oauth_clients` row is inserted (the no-direct-state-writes guard).
import { oauthClients, type DbClient, type OAuthClientRow } from '@hnet/db';
import {
  authEvent,
  checkClientCredentials,
  checkRegisteredRedirect,
  invalidClient,
  isClientId,
  planClientRegistration,
  redirectHost,
  validateRegistration,
  type ClientCredentials,
  type RegisteredClient,
} from '@hnet/oauth';
import { eq } from 'drizzle-orm';
import { resolveDb } from '../db-client';

/**
 * D-04 — register a client (open, unauthenticated; the route rate-limits it per client IP first). Validates the
 * RFC 7591 body (throws the RFC 7591 OAuthError), inserts the row with the registering IP, logs
 * `client_registered`, and returns the RFC 7591 response — a confidential client's secret appears only here.
 */
export async function registerClient(input: {
  db?: DbClient;
  body: unknown;
  registeredIp?: string | null;
  now?: Date;
}): Promise<RegisteredClient> {
  const reg = validateRegistration(input.body);
  const now = input.now ?? new Date();
  const plan = planClientRegistration(reg, { now, registeredIp: input.registeredIp ?? null });
  await resolveDb(input.db).insert(oauthClients).values(plan.row);
  authEvent('client_registered', {
    client_id: plan.row.clientId,
    client_name: reg.clientName,
    redirect_hosts: reg.redirectUris.map(redirectHost),
    auth_method: reg.authMethod,
    grant_types: reg.grantTypes,
    ...(reg.scope ? { scope: reg.scope } : {}),
    ip: plan.row.registeredIp ?? null,
  });
  return plan.response;
}

/** A client by its public id (a malformed id never reaches the query). */
export async function getOAuthClient(input: {
  db?: DbClient;
  clientId: string | undefined;
}): Promise<OAuthClientRow | undefined> {
  if (!input.clientId || !isClientId(input.clientId)) return undefined;
  const [row] = await resolveDb(input.db)
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, input.clientId))
    .limit(1);
  return row;
}

/**
 * D-05 step 1 — the authorization request's client and redirect: the client must exist and the redirect must
 * match a registered one (the loopback rule). Throws `invalid_client` / `invalid_redirect_uri`; the route renders
 * the bad-request page for both and never redirects.
 */
export async function resolveAuthorizationClient(input: {
  db?: DbClient;
  clientId: string | undefined;
  redirectUri: string | undefined;
}): Promise<OAuthClientRow> {
  if (!input.clientId) throw invalidClient('client_id is required');
  const client = await getOAuthClient(input);
  if (!client) throw invalidClient('Unknown client');
  checkRegisteredRedirect(client, input.redirectUri);
  return client;
}

/** D-06 — token / revoke client authentication (public by PKCE later; a confidential secret as digests). */
export async function authenticateOAuthClient(input: {
  db?: DbClient;
  credentials: Pick<ClientCredentials, 'clientId' | 'clientSecret'>;
}): Promise<OAuthClientRow> {
  const client = await getOAuthClient({ db: input.db, clientId: input.credentials.clientId });
  return checkClientCredentials(client, input.credentials);
}
