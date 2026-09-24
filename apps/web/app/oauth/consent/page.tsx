// ADR-091 / DESIGN-050 D-05 step 6 / D-14 — the consent page. It re-derives the user from the session (none ⇒
// sign in and come back); the transaction must be a well-formed UUID, unexpired and the user's own, else the
// expired state. It shows the client name AND the redirect host (anyone can register a client named "ChatGPT"),
// one line per requested scope — `watch:write` promises a Plex change only to the server owner, since Plex
// write-back is owner-only (ADR-091 C-04) — and Approve / Deny with the decision bound into each server action.
// Consent is never remembered.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { db } from '@hnet/db';
import { getConsentView } from '@hnet/domain';
import { authEvent, consentScopeLines, issuerOrigin } from '@hnet/oauth';
import { selectWatchAccountForUser } from '@hnet/watch';
import { firstParam, loginPath } from '@/lib/safe-next';
import { ExpiredCard, OAuthCard } from '../oauth-message';
import { decide } from './actions';
import { ConsentForm } from './consent-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect an app — haynesnetwork', robots: { index: false } };

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ txn?: string | string[] }>;
}) {
  const txn = firstParam((await searchParams).txn) ?? '';
  const session = await getServerSession(await headers());
  if (!session)
    redirect(`${issuerOrigin()}${loginPath(`/oauth/consent?txn=${encodeURIComponent(txn)}`)}`);

  const lookup = await getConsentView({ txnId: txn, userId: session.user.id });
  if (lookup.status !== 'ok') {
    return <ExpiredCard clientName={lookup.status === 'expired' ? lookup.clientName : null} />;
  }
  const { view } = lookup;
  const account = await selectWatchAccountForUser(db, session.user.id);
  const lines = consentScopeLines(view.scopes, { writesPlex: account?.role === 'owner' });
  authEvent('consent_shown', { client_id: view.clientId, txn: view.txnId, scopes: view.scopes });

  return (
    <OAuthCard testId="oauth-consent">
      <h1 className="oauth-card__title">Connect {view.clientName}</h1>
      <p>
        {view.clientName} wants to use your watch history on haynesnetwork. It will act as your
        account and can only do what you approve below.
      </p>
      <p className="muted" data-testid="oauth-consent-redirect">
        Sends you back to {view.redirectHost}.
      </p>
      <ul className="oauth-scopes">
        {lines.map((line) => (
          <li key={line.scope} className="oauth-scopes__item" data-scope={line.scope}>
            {line.description}
          </li>
        ))}
      </ul>
      <ConsentForm
        approve={decide.bind(null, 'approve', view.txnId)}
        deny={decide.bind(null, 'deny', view.txnId)}
      />
    </OAuthCard>
  );
}
