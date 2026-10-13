// ADR-111 C-04 / DESIGN-055 D-11 (PLAN-077 P3) — `/r/seerr/<id>`, the stable fix-it-yourself link for a Seerr report.
// Public: a reporter may have no haynesnetwork account yet. Signed out, it shows the onboarding card, whose
// "Sign in with Plex" goes through Authentik and comes back here (the first sign-in creates the account in the Default
// role, R-03); nothing about the report is shown before sign-in. Signed in, it sends the person to the title page
// with the guide the report points at preselected, or says why it cannot (lib/seerr-link.ts has the rules).
// Read-only toward Seerr: at most one fresh GET of the issue, when the mirror is missing it or its reporter.
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getServerSession, oidcEnabled } from '@hnet/auth';
import { isMediaItemAccessibleToUser } from '@hnet/api';
import { refreshSeerrIssueFromEnv, seerrIssueLinkTarget } from '@hnet/domain';
import { BrandMark } from '@/components/brand-mark';
import { SEERR_URL } from '@/lib/seerr-issues';
import { resolveSeerrLink } from '@/lib/seerr-link';
import { LoginButton } from '../../../login/login-button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fix a reported problem · haynesnetwork', robots: { index: false } };

function SeerrCard({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="login-wrap">
      <section className="card login-card oauth-card seerr-link" data-testid={testId}>
        <div className="brand login-brand">
          <BrandMark className="brand__mark" />
          <span className="brand__name" aria-hidden="true" />
        </div>
        {children}
      </section>
    </div>
  );
}

const seerrLink = (
  <a href={SEERR_URL} target="_blank" rel="noreferrer">
    Seerr
  </a>
);

function LibraryButton() {
  return (
    <Link className="btn primary seerr-link__btn" href="/library">
      Go to the Library
    </Link>
  );
}

function SignInCard({ next }: { next: string }) {
  return (
    <SeerrCard testId="seerr-link-sign-in">
      <h1 className="oauth-card__title">Thanks for reporting this</h1>
      <p>
        You can usually sort out a problem like this one yourself on haynesnetwork. Here&apos;s how it
        works.
      </p>
      <ol className="seerr-steps">
        <li className="seerr-steps__item">
          <span className="seerr-steps__num" aria-hidden="true">
            1
          </span>
          <span>
            Sign in with the Plex account you use for Seerr. The first time sets up your account.
          </span>
        </li>
        <li className="seerr-steps__item">
          <span className="seerr-steps__num" aria-hidden="true">
            2
          </span>
          <span>We open the title you reported, with the right fix ready to go.</span>
        </li>
        <li className="seerr-steps__item">
          <span className="seerr-steps__num" aria-hidden="true">
            3
          </span>
          <span>You see what it found and what it will do. Nothing changes until you confirm.</span>
        </li>
      </ol>
      {oidcEnabled ? (
        <LoginButton callbackURL={next} label="Sign in with Plex" />
      ) : (
        <p className="alert" role="alert">
          Sign-in is not configured (missing OIDC credentials). See DESIGN-002 D-08.
        </p>
      )}
      <p className="seerr-link__aside muted">
        Prefer to leave it to staff? Your report stays open in {seerrLink}.
      </p>
    </SeerrCard>
  );
}

export default async function SeerrLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(await headers());
  const view = await resolveSeerrLink({
    rawId: id,
    userId: session?.user.id ?? null,
    lookup: (seerrIssueId) => seerrIssueLinkTarget({ seerrIssueId }),
    refresh: (seerrIssueId) => refreshSeerrIssueFromEnv({ seerrIssueId }),
    canSee: (userId, mediaItemId) => isMediaItemAccessibleToUser(userId, mediaItemId),
  });

  switch (view.kind) {
    case 'sign_in':
      return <SignInCard next={view.next} />;
    case 'redirect':
      redirect(view.to);
      break;
    case 'no_title':
      return (
        <SeerrCard testId="seerr-link-no-title">
          <h1 className="oauth-card__title">This title isn&apos;t in the Library yet</h1>
          <p>
            There&apos;s nothing here to fix yet, so your report is in the right place. Staff will pick it up in{' '}
            {seerrLink}. A requested title shows up here once it has been added.
          </p>
          <LibraryButton />
        </SeerrCard>
      );
    case 'removed':
      return (
        <SeerrCard testId="seerr-link-removed">
          <h1 className="oauth-card__title">This report was removed</h1>
          <p>
            It was taken down in {seerrLink}, so there&apos;s nothing to follow up here. If the problem is still
            there, find the title in the Library and use Fix or Force Search on its page.
          </p>
          <LibraryButton />
        </SeerrCard>
      );
    case 'no_access':
      return (
        <SeerrCard testId="seerr-link-no-access">
          <h1 className="oauth-card__title">This title isn&apos;t in your libraries</h1>
          <p>
            Your account can&apos;t see the library this title is in, so staff will handle your report in {seerrLink}.
            If you think you should have access, ask on the{' '}
            <Link href="/bulletin?tab=helpdesk">Helpdesk</Link>.
          </p>
          <LibraryButton />
        </SeerrCard>
      );
    default:
      return (
        <SeerrCard testId="seerr-link-not-found">
          <h1 className="oauth-card__title">We couldn&apos;t find that report</h1>
          <p>
            The link may be incomplete, or the report hasn&apos;t reached haynesnetwork yet. Try the link again, or
            check the report in {seerrLink}.
          </p>
          <LibraryButton />
        </SeerrCard>
      );
  }
}
