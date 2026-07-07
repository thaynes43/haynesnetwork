'use client';

// DESIGN-005 D-17 / R-46 — the caller's own fix history and status, newest first
// (fix.myFixes). Table → card collapse <760px via data-label (D-06). Extracted from
// the former /my-fixes page so it can render inside the Library "My Fixes" sub-tab.
//
// ADR-028 / D-21 — rows whose stored status is still in flight get a LIVE phase chip
// (poll fix.progress at the slow table cadence, stop on terminal); terminal rows keep
// the static status badge and are never polled. The Status column reserves width so a
// chip ↔ badge swap or a percent tick never shifts the table (hard rule 9).
import Link from 'next/link';
import { trpc } from '@/lib/trpc-client';
import {
  ARR_KIND_LABELS,
  FIX_REASON_LABELS,
  FIX_STATUS_LABELS,
  fixStatusTone,
  formatWhen,
  type ArrKindName,
} from '@/lib/media';
import { ActionLiveChip, TABLE_POLL_MS, useActionProgress } from '@/components/action-progress';

const OPEN_FIX_STATUSES = new Set(['pending', 'actioned', 'search_triggered']);
/** Bound the poll fan-out: only the newest N in-flight rows go live (rows are newest-first). */
const MAX_LIVE_ROWS = 8;

/** One live status cell — its own component so each row owns exactly one poll. */
function LiveStatusCell({ fixRequestId }: { fixRequestId: string }) {
  const live = useActionProgress(
    { kind: 'fix', fixRequestId },
    { slowMs: TABLE_POLL_MS },
  );
  return <ActionLiveChip {...live} />;
}

export function MyFixesPanel() {
  const fixes = trpc.fix.myFixes.useQuery();

  if (fixes.isLoading) return <p className="muted">Loading your fixes…</p>;
  if (fixes.error) {
    return (
      <p className="alert" role="alert">
        Failed to load your fixes: {fixes.error.message}
      </p>
    );
  }
  const rows = fixes.data ?? [];

  if (rows.length === 0) {
    return (
      <section className="card empty-state">
        <p>
          No fixes yet. Find a broken item in the <Link href="/library">Library</Link> and hit Fix.
        </p>
      </section>
    );
  }

  // Subtitle fixes rest at search_triggered by design (fire-and-forget — nothing in
  // the *arr pipeline to watch), so they keep the static badge like terminal rows.
  const isLiveRow = (row: (typeof rows)[number]) =>
    OPEN_FIX_STATUSES.has(row.status) &&
    row.pathTaken !== 'bazarr_subtitle' &&
    row.reason !== 'missing_subtitles';
  const liveIds = new Set(
    rows
      .filter(isLiveRow)
      .slice(0, MAX_LIVE_ROWS)
      .map((row) => row.id),
  );

  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Target</th>
          <th>Reason</th>
          <th className="status-col">Status</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((fix) => (
          <tr key={fix.id}>
            <td data-label="Item">
              <Link className="row-link" href={`/library/${fix.item.id}`}>
                {fix.item.title}
              </Link>{' '}
              <span className="badge badge--muted">
                {ARR_KIND_LABELS[fix.item.arrKind as ArrKindName]}
              </span>
            </td>
            <td data-label="Target">{fix.targetLabel ?? '—'}</td>
            <td data-label="Reason">
              {FIX_REASON_LABELS[fix.reason] ?? fix.reason}
              {fix.reasonText ? <span className="muted"> — {fix.reasonText}</span> : null}
            </td>
            <td data-label="Status" className="status-col">
              {liveIds.has(fix.id) ? (
                <LiveStatusCell fixRequestId={fix.id} />
              ) : (
                <span className={`badge badge--${fixStatusTone(fix.status)}`}>
                  {FIX_STATUS_LABELS[fix.status] ?? fix.status}
                </span>
              )}
            </td>
            <td data-label="Updated">{formatWhen(fix.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
