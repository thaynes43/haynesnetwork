// DESIGN-004 D-11 — /login: public, centered .card with the brand and the single
// OIDC sign-in button (AC-01 — no password form exists). An existing session
// server-redirects to /; ?error=… renders an alert (donor: todos-for-dues login).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession, oidcEnabled } from '@hnet/auth';
import { loginRouteRedirect } from '@/lib/route-gate';
import { LoginButton } from './login-button';

export const metadata = { title: 'Sign in — haynesnetwork' };

const ERROR_COPY: Record<string, string> = {
  sso_unavailable: 'Sign-in is temporarily unavailable. Try again in a moment.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getServerSession(await headers());
  const dest = loginRouteRedirect(session?.user ?? null);
  if (dest) redirect(dest);

  const { error } = await searchParams;

  return (
    <div className="login-wrap">
      <section className="card login-card">
        <div className="brand login-brand">
          <svg className="brand__mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="11" height="11" rx="2.5" fill="currentColor" />
            <rect x="18" y="3" width="11" height="11" rx="2.5" fill="currentColor" opacity=".55" />
            <rect x="3" y="18" width="11" height="11" rx="2.5" fill="currentColor" opacity=".55" />
            <rect x="18" y="18" width="11" height="11" rx="2.5" fill="currentColor" />
          </svg>
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
