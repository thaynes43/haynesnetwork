// ADR-091 / DESIGN-050 D-05 steps 5–6 — the Authorization transaction single-writer (`startAuthorization`) and
// the consent page's read. The transaction is inserted ONLY for a signed-in user (the route's session gate) —
// `userId` is the session's, never a request parameter.
import { oauthAuthorizations, oauthClients, type DbClient, type OAuthClientRow } from '@hnet/db';
import {
  authEvent,
  consentLookup,
  isUuid,
  planAuthorization,
  redirectHost,
  type ConsentLookup,
  type ValidatedAuthorization,
} from '@hnet/oauth';
import { eq } from 'drizzle-orm';
import { resolveDb } from '../db-client';

/** D-05 step 5 — persist the pending consent transaction (10 minutes) and log `authorize_started`. */
export async function startAuthorization(input: {
  db?: DbClient;
  client: Pick<OAuthClientRow, 'clientId'>;
  userId: string;
  redirectUri: string;
  validated: ValidatedAuthorization;
  now?: Date;
}): Promise<{ txnId: string }> {
  const now = input.now ?? new Date();
  const [row] = await resolveDb(input.db)
    .insert(oauthAuthorizations)
    .values(
      planAuthorization({
        clientId: input.client.clientId,
        userId: input.userId,
        redirectUri: input.redirectUri,
        validated: input.validated,
        now,
      }),
    )
    .returning({ id: oauthAuthorizations.id });
  if (!row) throw new Error('oauth_authorizations insert returned no row');
  authEvent('authorize_started', {
    client_id: input.client.clientId,
    redirect_host: redirectHost(input.redirectUri),
    scopes: input.validated.scopes,
    txn: row.id,
  });
  return { txnId: row.id };
}

/**
 * D-05 step 6 — what the consent page shows for `?txn=`. A malformed id is `missing` without a query (before
 * the port's guard a non-uuid reached the uuid column and 500'd the page — cigar-journal #206); another user's
 * transaction is `missing` too, so its client name never leaks.
 */
export async function getConsentView(input: {
  db?: DbClient;
  txnId: string | undefined;
  userId: string;
  now?: Date;
}): Promise<ConsentLookup> {
  if (!input.txnId || !isUuid(input.txnId)) return { status: 'missing' };
  const [row] = await resolveDb(input.db)
    .select({
      id: oauthAuthorizations.id,
      clientId: oauthAuthorizations.clientId,
      clientName: oauthClients.clientName,
      userId: oauthAuthorizations.userId,
      redirectUri: oauthAuthorizations.redirectUri,
      scopes: oauthAuthorizations.scopes,
      expiresAt: oauthAuthorizations.expiresAt,
    })
    .from(oauthAuthorizations)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthAuthorizations.clientId))
    .where(eq(oauthAuthorizations.id, input.txnId))
    .limit(1);
  return consentLookup(row, input.userId, input.now ?? new Date());
}
