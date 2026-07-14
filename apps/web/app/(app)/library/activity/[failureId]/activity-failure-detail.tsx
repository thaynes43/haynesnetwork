'use client';

// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the import-failure detail view (the books analog
// of the /library/[id] Movies/TV detail + the #264 wanted-detail idiom): BackLink + `.card.detail-head`
// with a 2:3 MediaPoster, title, the stage + failure-class badges, the human failure reason, and — for an
// Admin (or a role granted the action) — the ROLE-CONTROLLED actions (Retry import / Force re-search) in
// the ADR-015 reserved-slot idiom (button ↔ live PhaseChip, no reflow — PLAN-015 feedback). Others see the
// same facts read-only. The downstream operator deep link is Admin-only (the LAN-only operator UIs).
import { useState } from 'react';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { PhaseChip, type PhaseTone } from '@hnet/ui';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/cards';
import { ActivityStageChip, useActivityItemStatus } from '@/components/activity-live';
import { formatWhen } from '@/lib/media';

type FailureWire = RouterOutputs['activity']['failure'];

const FAILURE_LABEL: Record<string, string> = {
  stranded_import: 'Stranded import',
  postprocess_failed: 'Import failed',
  download_failed: 'Download failed',
  import_blocked: 'Blocked',
};

const FAILURE_EXPLAIN: Record<string, string> = {
  stranded_import:
    'The download finished but never imported into the library — it’s stranded. Retrying the import usually lands it.',
  postprocess_failed:
    'The importer ran but couldn’t place the file (a content/type mismatch or a post-process error). A fresh search often fixes it.',
  download_failed:
    'The download itself failed (a dead post or a failed repair). There’s nothing to import — search again for a new source.',
  import_blocked: 'The importer refused this file. Search again for a matching release.',
};

const SOURCE_APP_LABEL: Record<string, string> = {
  lazylibrarian: 'LazyLibrarian',
  sabnzbd: 'SABnzbd',
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
  kapowarr: 'Kapowarr',
};

// ---------------------------------------------------------------------------
// The action slot — the reserved ADR-015 slot (button ↔ live chip). Non-destructive ⇒ a plain button
// (hard rule 8: no ConfirmButton for a benign retry). A single fire per session terminal.
// ---------------------------------------------------------------------------

type Fired = { kind: 'fired' } | { kind: 'failed'; message: string };

function ActionSlot({
  label,
  testId,
  onFire,
  isPending,
  fired,
}: {
  label: string;
  testId: string;
  onFire: () => void;
  isPending: boolean;
  fired: Fired | null;
}) {
  const chip = (phase: string, text: string, tone: PhaseTone, opts?: { pulse?: boolean; title?: string }) => (
    <PhaseChip phase={phase} label={text} tone={tone} pulse={opts?.pulse} meter={opts?.pulse} title={opts?.title} />
  );
  let content;
  if (isPending) {
    content = chip('working', 'Working…', 'neutral', { pulse: true });
  } else if (fired?.kind === 'fired') {
    content = chip('fired', 'Requested', 'info', { pulse: true, title: `${label} requested` });
  } else if (fired?.kind === 'failed') {
    content = chip('failed', 'Failed', 'danger', { title: fired.message });
  } else {
    content = (
      <button type="button" className="btn sm" data-testid={testId} onClick={onFire}>
        {label}
      </button>
    );
  }
  return (
    <span className="action-slot action-slot--roll" data-testid={`${testId}-slot`}>
      {content}
    </span>
  );
}

export function ActivityFailureDetail({ failureId, from }: { failureId: string; from: string | null }) {
  const utils = trpc.useUtils();
  const detail = trpc.activity.failure.useQuery({ failureId });
  const [retryFired, setRetryFired] = useState<Fired | null>(null);
  const [searchFired, setSearchFired] = useState<Fired | null>(null);
  const refresh = () => void utils.activity.failure.invalidate({ failureId });

  const retry = trpc.activity.retryImport.useMutation({
    onSuccess: () => {
      setRetryFired({ kind: 'fired' });
      refresh();
    },
    onError: (e) => setRetryFired({ kind: 'failed', message: e.message }),
  });
  const search = trpc.activity.forceSearch.useMutation({
    onSuccess: () => {
      setSearchFired({ kind: 'fired' });
      refresh();
    },
    onError: (e) => setSearchFired({ kind: 'failed', message: e.message }),
  });

  // D-10 — once a retry/re-search fires, poll the item's LIVE stage so it is SEEN to move off `failed`
  // (searching → downloading % → importing → done), the exact Fix feel. Enabled only after a fire; it stops
  // on landing/clear. `sourceRef` (== the ActivityItem id) is the poll key.
  const anyFired = retryFired?.kind === 'fired' || searchFired?.kind === 'fired';
  const live = useActivityItemStatus(detail.data?.sourceRef ?? null, anyFired);

  if (detail.isLoading) {
    return (
      <>
        <BackLink from={from} />
        <p className="muted">Loading…</p>
      </>
    );
  }
  if (detail.error) {
    return (
      <>
        <BackLink from={from} />
        <p className="alert" role="alert" data-testid="activity-failure-error">
          This item isn’t available: {detail.error.message}
        </p>
      </>
    );
  }
  const d: FailureWire = detail.data!;
  const isFailed = d.resolvedAt === null;
  const canAct = d.canRetryImport || d.canForceSearch;

  return (
    <>
      <BackLink from={from} />

      <section className="card detail-head" data-testid="activity-failure-head">
        <span className="detail-head__poster">
          <MediaPoster posterUrl={null} kind={d.kind} alt="" />
        </span>
        <div className="detail-head__body">
          <h1 className="detail-head__title">
            {d.title}
            {d.year != null ? <span className="muted"> ({d.year})</span> : null}
          </h1>
          <div className="media-card__badges">
            <span className={`badge badge--${isFailed ? 'danger' : 'ok'}`}>
              {isFailed ? 'Stuck' : 'Resolved'}
            </span>
            <span className="badge badge--danger">{FAILURE_LABEL[d.failureKind] ?? 'Failed'}</span>
            {d.sourceApp ? (
              <span className="badge badge--muted">{SOURCE_APP_LABEL[d.sourceApp] ?? d.sourceApp}</span>
            ) : null}
          </div>
          {d.failureReason ? (
            <p className="detail-head__meta" data-testid="activity-failure-reason">
              {d.failureReason}
            </p>
          ) : null}
          <p className="muted">{FAILURE_EXPLAIN[d.failureKind] ?? ''}</p>
        </div>
      </section>

      <section className="card admin-section">
        <h2>Fix it</h2>
        {isFailed && canAct ? (
          <ul className="child-list">
            {d.canRetryImport ? (
              <li className="child-row" data-testid="activity-retry-row">
                <span className="child-row__label">Retry import</span>
                <span className="child-row__actions">
                  <ActionSlot
                    label="Retry import"
                    testId="activity-retry"
                    isPending={retry.isPending}
                    fired={retryFired}
                    onFire={() => retry.mutate({ failureId })}
                  />
                </span>
              </li>
            ) : null}
            {d.canForceSearch ? (
              <li className="child-row" data-testid="activity-search-row">
                <span className="child-row__label">Force re-search</span>
                <span className="child-row__actions">
                  <ActionSlot
                    label="Force re-search"
                    testId="activity-search"
                    isPending={search.isPending}
                    fired={searchFired}
                    onFire={() => search.mutate({ failureId })}
                  />
                </span>
              </li>
            ) : null}
            {/* D-10 — the live movement: once fired, this row polls the item's stage and walks it off `failed`
                (searching → downloading % → importing → done) in the reserved slot, no reflow (ADR-015). */}
            {anyFired ? (
              <li className="child-row" data-testid="activity-live-row">
                <span className="child-row__label">Live status</span>
                <span className="child-row__actions">
                  <ActivityStageChip status={live} />
                </span>
              </li>
            ) : null}
          </ul>
        ) : !isFailed ? (
          <p className="muted">This item is no longer stuck — it imported or cleared on a later scan.</p>
        ) : (
          <p className="muted" data-testid="activity-readonly-note">
            An admin needs to retry this import. You can see the stuck item, but only an admin (or a role
            granted the action) can act on it.
          </p>
        )}
        {d.downstreamUrl ? (
          <p className="muted">
            <a href={d.downstreamUrl} target="_blank" rel="noreferrer" data-testid="activity-downstream">
              Open in {d.sourceApp ? SOURCE_APP_LABEL[d.sourceApp] ?? d.sourceApp : 'the downloader'} ↗
            </a>
          </p>
        ) : null}
      </section>

      <section className="card admin-section">
        <h2>Details</h2>
        <dl className="meta-grid">
          <div>
            <dt>Stuck since</dt>
            <dd>{formatWhen(d.firstSeenAt)}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{formatWhen(d.lastSeenAt)}</dd>
          </div>
          {d.lastActionAt ? (
            <div>
              <dt>Last action</dt>
              <dd>
                {d.lastAction === 'retry_import' ? 'Retry import' : 'Force re-search'} ·{' '}
                {formatWhen(d.lastActionAt)}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
    </>
  );
}
