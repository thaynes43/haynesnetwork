// DESIGN-004 D-11 — /login: public, centered .card with the brand and the single
// OIDC sign-in button (AC-01 — no password form exists). An existing session
// server-redirects to /; ?error=… renders an alert (donor: todos-for-dues login).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession, oidcEnabled } from '@hnet/auth';
import { BrandMark } from '@/components/brand-mark';
import { loginRouteRedirect } from '@/lib/route-gate';
import { LoginButton } from './login-button';

export const metadata = { title: 'Sign in — haynesnetwork' };

const ERROR_COPY: Record<string, string> = {
  sso_unavailable: 'Sign-in is temporarily unavailable. Try again in a moment.',
  rate_limited: 'Too many sign-in attempts — wait a minute and try once.',
  callback_failed:
    'Sign-in failed after Authentik. Try again; if it persists the admin should check the pod logs.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const session = await getServerSession(await headers());
  const dest = loginRouteRedirect(session?.user ?? null);
  if (dest) redirect(dest);

  // OAuth callback failures arrive as /login?error=callback_failed&error=<code>:
  // better-auth's redirectOnError appends its machine-readable code as a second
  // `error` param after ours. Render the first (our taxonomy); the raw code stays
  // visible in the URL for debugging.
  const { error: rawError } = await searchParams;
  const error = Array.isArray(rawError) ? rawError[0] : rawError;

  return (
    <div className="login-wrap">
      <section className="card login-card">
        <div className="brand login-brand">
          {/* DESIGN-006 D-01: the hub-and-spoke mark at its 64px hero size;
              stacked over the wordmark by the .login-brand CSS. */}
          <BrandMark className="brand__mark" />
          <span className="brand__name" aria-hidden="true" />
          <h1 className="sr-only">haynesnetwork</h1>
        </div>
        <p className="login-sub">The front door to the Haynes Plex ecosystem.</p>
        {error ? (
          <p className="alert" role="alert">
            {ERROR_COPY[error] ?? 'Something went wrong signing you in. Try again.'}
          </p>
        ) : null}
        {oidcEnabled ? (
          <LoginButton />
        ) : (
          <p className="alert" role="alert">
            Sign-in is not configured (missing OIDC credentials). See DESIGN-002 D-08.
          </p>
        )}
      </section>
    </div>
  );
}
