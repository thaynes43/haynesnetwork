'use client';

// DESIGN-005 D-17 / R-46 — the caller's own fix history and status, newest first
// (fix.myFixes). Table → card collapse <760px via data-label (D-06). Extracted from
// the former /my-fixes page so it can render inside the Library "My Fixes" sub-tab.
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

  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Target</th>
          <th>Reason</th>
          <th>Status</th>
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
            <td data-label="Status">
              <span className={`badge badge--${fixStatusTone(fix.status)}`}>
                {FIX_STATUS_LABELS[fix.status] ?? fix.status}
              </span>
            </td>
            <td data-label="Updated">{formatWhen(fix.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
