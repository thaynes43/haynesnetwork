// ADR-091 / DESIGN-050 D-05 step 7 — the consent decision single-writers (hard rule 6): Approve and Deny each
// run as ONE transaction that removes the pending request and writes its `oauth_audit` row (Approve also inserts
// the single-use code). The decision arrives bound into the server action — never a submit button's value
// (cigar-journal #29) — and the user is the session's, re-derived by the caller.
import {
  oauthAudit,
  oauthAuthorizationCodes,
  oauthAuthorizations,
  oauthClients,
  type DbClient,
} from '@hnet/db';
import {
  authEvent,
  denialRedirect,
  fingerprint,
  isUuid,
  planApproval,
  redirectHost,
  type OAuthScope,
} from '@hnet/oauth';
import { eq } from 'drizzle-orm';
import { inTransaction } from '../db-client';

export type ConsentOutcome =
  /** The browser goes back to the client: `?code=&state=` (Approve) or `?error=access_denied&state=` (Deny). */
  | { status: 'redirect'; redirectUrl: string; clientId: string }
  /** The user's own request, past its 10 minutes: nothing was issued; the page shows the expired state. */
  | { status: 'expired'; clientName: string }
  /** Malformed, unknown, already decided, or another user's request: nothing happened. */
  | { status: 'missing' };

interface Locked {
  txn: typeof oauthAuthorizations.$inferSelect;
  clientName: string;
}

/** Lock the user's own pending request (FOR UPDATE: two racing Approves serialize; the loser finds it gone). */
async function lockTransaction(
  tx: DbClient,
  txnId: string,
  userId: string,
): Promise<Locked | null> {
  if (!isUuid(txnId)) return null;
  const [txn] = await tx
    .select()
    .from(oauthAuthorizations)
    .where(eq(oauthAuthorizations.id, txnId))
    .limit(1)
    .for('update');
  if (!txn || txn.userId !== userId) return null;
  const [client] = await tx
    .select({ clientName: oauthClients.clientName })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, txn.clientId))
    .limit(1);
  return { txn, clientName: client?.clientName ?? txn.clientId };
}

/**
 * D-05 step 7 Approve — one transaction: delete the pending request (re-checking its expiry), insert the
 * single-use code (60 s, SHA-256 only), and write the `consent_granted` audit row; then the caller redirects to
 * `redirect_uri?code=&state=`. An expired request issues nothing and stays for the pruner (so the page can still
 * name the client).
 */
export async function grantConsent(input: {
  db?: DbClient;
  txnId: string;
  userId: string;
  now?: Date;
}): Promise<ConsentOutcome> {
  const now = input.now ?? new Date();
  let code: string | null = null;
  let scopes: OAuthScope[] = [];
  const outcome = await inTransaction(input.db, async (tx): Promise<ConsentOutcome> => {
    const locked = await lockTransaction(tx, input.txnId, input.userId);
    if (!locked) return { status: 'missing' };
    const { txn, clientName } = locked;
    const plan = planApproval(txn, now);
    if (plan.kind === 'expired') return { status: 'expired', clientName };
    await tx.delete(oauthAuthorizations).where(eq(oauthAuthorizations.id, txn.id));
    await tx.insert(oauthAuthorizationCodes).values(plan.row);
    await tx.insert(oauthAudit).values({
      event: 'consent_granted',
      userId: txn.userId,
      clientId: txn.clientId,
      details: {
        client_name: clientName,
        redirect_host: redirectHost(txn.redirectUri),
        scopes: plan.row.scopes,
      },
      at: now,
    });
    code = plan.code;
    scopes = plan.row.scopes as OAuthScope[];
    return { status: 'redirect', redirectUrl: plan.redirectUrl, clientId: txn.clientId };
  });
  if (outcome.status === 'redirect' && code) {
    authEvent('consent_granted', {
      client_id: outcome.clientId,
      txn: input.txnId,
      scopes,
      code: fingerprint(code),
    });
  }
  return outcome;
}

/**
 * D-05 step 7 Deny — one transaction: delete the pending request and write the `consent_denied` audit row; the
 * caller redirects to `redirect_uri?error=access_denied&state=`. An expired request is treated like Approve's
 * (the expired page; nothing written).
 */
export async function denyConsent(input: {
  db?: DbClient;
  txnId: string;
  userId: string;
  now?: Date;
}): Promise<ConsentOutcome> {
  const now = input.now ?? new Date();
  const outcome = await inTransaction(input.db, async (tx): Promise<ConsentOutcome> => {
    const locked = await lockTransaction(tx, input.txnId, input.userId);
    if (!locked) return { status: 'missing' };
    const { txn, clientName } = locked;
    if (txn.expiresAt.getTime() <= now.getTime()) return { status: 'expired', clientName };
    await tx.delete(oauthAuthorizations).where(eq(oauthAuthorizations.id, txn.id));
    await tx.insert(oauthAudit).values({
      event: 'consent_denied',
      userId: txn.userId,
      clientId: txn.clientId,
      details: {
        client_name: clientName,
        redirect_host: redirectHost(txn.redirectUri),
        scopes: txn.scopes,
      },
      at: now,
    });
    return { status: 'redirect', redirectUrl: denialRedirect(txn), clientId: txn.clientId };
  });
  if (outcome.status === 'redirect') {
    authEvent('consent_denied', { client_id: outcome.clientId, txn: input.txnId });
  }
  return outcome;
}
