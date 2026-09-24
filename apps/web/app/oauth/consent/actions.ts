'use server';

// ADR-091 / DESIGN-050 D-05 steps 6–7 — the consent decision. The decision and the transaction are BOUND into
// the action (`decide.bind(null, 'approve', txn)`): a submit button's own name/value is dropped from the FormData
// when it carries formAction={serverAction}, so a `name="decision"` button reads as empty server-side and every
// click denies (cigar-journal #29, hit live 2026-08-27). The user is re-derived from the session here — the form
// never carries a user id. Approve / Deny each run as one transaction with their oauth_audit row (@hnet/domain).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { denyConsent, grantConsent } from '@hnet/domain';
import { issuerOrigin } from '@hnet/oauth';
import { loginPath } from '@/lib/safe-next';

export type ConsentDecision = 'approve' | 'deny';

export async function decide(decision: ConsentDecision, txnId: string): Promise<void> {
  const issuer = issuerOrigin();
  const consentPath = `/oauth/consent?txn=${encodeURIComponent(String(txnId))}`;
  if (decision !== 'approve' && decision !== 'deny') redirect(`${issuer}${consentPath}`);
  const session = await getServerSession(await headers());
  if (!session) redirect(`${issuer}${loginPath(consentPath)}`);
  const input = { txnId: String(txnId), userId: session.user.id };
  const outcome = decision === 'approve' ? await grantConsent(input) : await denyConsent(input);
  // Back to the client (code or access_denied), else the consent page shows the expired state.
  redirect(outcome.status === 'redirect' ? outcome.redirectUrl : `${issuer}${consentPath}`);
}
