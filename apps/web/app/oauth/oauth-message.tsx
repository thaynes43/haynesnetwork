// ADR-091 / DESIGN-050 D-14 — the one-card message the OAuth pages render for the states that are not a consent
// (a bad request, an expired request). The login page's centred card, token colours only.
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';

export function OAuthCard({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="login-wrap">
      <section className="card login-card oauth-card" data-testid={testId}>
        <div className="brand login-brand">
          <BrandMark className="brand__mark" />
          <span className="brand__name" aria-hidden="true" />
        </div>
        {children}
      </section>
    </div>
  );
}

/** D-14 "Bad request" — an unknown client or a redirect it never registered (and a rate-limited request, D-10). */
export function BadRequestCard() {
  return (
    <OAuthCard testId="oauth-bad-request">
      <h1 className="oauth-card__title">Something is off with this connection request</h1>
      <p>
        haynesnetwork did not recognise the app or where it wants to send you back. Start the
        connection again from the app.
      </p>
    </OAuthCard>
  );
}

/** D-14 "Expired request" — names the client when the request was the user's own, else "your app". */
export function ExpiredCard({ clientName }: { clientName: string | null }) {
  return (
    <OAuthCard testId="oauth-expired">
      <h1 className="oauth-card__title">This request expired</h1>
      <p>Start the connection again from {clientName ?? 'your app'}.</p>
    </OAuthCard>
  );
}
