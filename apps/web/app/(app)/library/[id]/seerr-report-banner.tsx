'use client';

// ADR-111 C-02 / DESIGN-055 D-10, D-11 (PLAN-077 P3) — a title's Seerr reports, above the episode list: what was
// reported (type, episode, the reporter's own words), when, and the guide button the report points at (the D-10
// routing). Admins also see who reported it (ADR-111 C-02). A person who arrived from the `/r/seerr/<id>` link and
// reported it reads "You reported this in Seerr" (D-11).
//
// Hard rule 9: the banner is present or not from the page's load, never from an interaction; its action slot keeps
// its place while the episodes load (a muted placeholder of the same height), so nothing moves when the button lands.
// Token colours only (hard rule 2).
import { MediaAction } from '@hnet/ui';
import { formatWhen } from '@/lib/media';
import { issueKicker, seerrIssueUrl, type SeerrGuideEntry, type SeerrIssueTypeNumber } from '@/lib/seerr-issues';

export interface SeerrReport {
  seerrIssueId: number;
  issueType: SeerrIssueTypeNumber;
  status: 'open' | 'resolved';
  mediaType: 'movie' | 'tv' | null;
  problemSeason: number;
  problemEpisode: number;
  message: string | null;
  reportedAt: string;
  viewerIsReporter: boolean;
  reporterName: string | null;
}

function ReportIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 21V4" />
      <path d="M4 4h12l-2 4 2 4H4" />
    </svg>
  );
}

export function SeerrReportBanner({
  report,
  arrived,
  entry,
  disabled,
  onOpen,
}: {
  report: SeerrReport;
  /** The person followed this report's `/r/seerr/<id>` link. */
  arrived: boolean;
  /** The guide this report opens; null while the episodes load. */
  entry: SeerrGuideEntry | null;
  /** The title was removed from the manager: nothing to open. */
  disabled: boolean;
  onOpen: (entry: SeerrGuideEntry) => void;
}) {
  const yours = arrived && report.viewerIsReporter;
  const resolved = report.status === 'resolved';
  return (
    <section
      className={`seerr-report${resolved ? ' seerr-report--resolved' : ''}`}
      aria-label={`Reported in Seerr: ${issueKicker(report)}`}
      data-testid="seerr-report"
      data-issue={report.seerrIssueId}
    >
      <span className="seerr-report__icon">
        <ReportIcon />
      </span>
      <div className="seerr-report__body">
        <p className="seerr-report__title">
          {yours ? 'You reported this in Seerr' : 'Reported in Seerr'}
          <span className="seerr-report__kicker">{issueKicker(report)}</span>
        </p>
        {report.message ? (
          <blockquote className="seerr-report__message">{report.message}</blockquote>
        ) : null}
        <p className="seerr-report__meta">
          {report.reporterName ? <>Reported by {report.reporterName} on </> : <>Reported on </>}
          {formatWhen(report.reportedAt)}.{' '}
          <a href={seerrIssueUrl(report.seerrIssueId)} target="_blank" rel="noreferrer">
            See the report in Seerr
          </a>
        </p>
        {resolved ? (
          <p className="seerr-report__note">
            Seerr has this one marked resolved. If it still isn&apos;t right, you can try again here.
          </p>
        ) : yours ? (
          <p className="seerr-report__note">Here&apos;s what you can try first. Nothing changes until you confirm.</p>
        ) : null}
      </div>
      <div className="seerr-report__action">
        {entry !== null ? (
          <MediaAction
            action={entry.mode === 'fix' ? 'fix' : 'forceSearch'}
            scopeLabel={entry.scopeLabel}
            size="sm"
            disabled={disabled}
            testId="seerr-report-action"
            onFire={() => onOpen(entry)}
          />
        ) : (
          <span className="seerr-report__pending muted" aria-live="polite">
            Checking the episodes…
          </span>
        )}
      </div>
    </section>
  );
}
