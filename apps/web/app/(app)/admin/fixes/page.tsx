'use client';

// DESIGN-005 D-17 / R-46 — /admin/fixes: the full queue with status filter,
// requester, outcome, and the raw *arr actions taken (fix.adminList).
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import {
  ARR_KIND_LABELS,
  FIX_REASON_LABELS,
  FIX_STATUS_LABELS,
  fixStatusTone,
  formatWhen,
  type ArrKindName,
} from '@/lib/media';

const STATUS_FILTERS = [
  undefined,
  'pending',
  'actioned',
  'search_triggered',
  'failed',
  'completed',
  'timed_out',
  'closed_manually',
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Client mirror of @hnet/domain OPEN_FIX_STATUSES — only these can be closed manually. */
const OPEN_FIX_STATUSES = new Set(['pending', 'actioned', 'search_triggered']);

export default function AdminFixesPage() {
  const [status, setStatus] = useState<StatusFilter>(undefined);
  const utils = trpc.useUtils();
  const list = trpc.fix.adminList.useInfiniteQuery(
    { status, limit: 50 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: (prev) => prev },
  );
  const closeFix = trpc.fix.close.useMutation({
    onSuccess: () => void utils.fix.adminList.invalidate(),
  });

  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <h1>Fix requests</h1>
      <div className="library-filters admin-filterbar">
        <div className="seg" role="group" aria-label="Status">
          {STATUS_FILTERS.map((value) => (
            <button
              key={value ?? 'all'}
              type="button"
              className={status === value ? 'is-active' : undefined}
              onClick={() => setStatus(value)}
            >
              {value === undefined ? 'All' : (FIX_STATUS_LABELS[value] ?? value)}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? <p className="muted">Loading fixes…</p> : null}
      {list.error ? (
        <p className="alert" role="alert">
          Failed to load fixes: {list.error.message}
        </p>
      ) : null}

      {!list.isLoading && rows.length === 0 ? (
        <p className="muted">No fix requests{status ? ' in this state' : ' yet'}.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Requested</th>
              <th>Requester</th>
              <th>Item</th>
              <th>Target</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Actions taken</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((fix) => (
              <tr key={fix.id}>
                <td data-label="Requested">{formatWhen(fix.createdAt)}</td>
                <td data-label="Requester">{fix.requester?.displayName ?? '(deleted user)'}</td>
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
                  {fix.pathTaken ? (
                    <span className="muted">
                      {' '}
                      {fix.pathTaken === 'bazarr_subtitle'
                        ? 'bazarr subtitles'
                        : fix.pathTaken === 'blocklist_search'
                          ? 'blocklist+search'
                          : 'delete+search'}
                    </span>
                  ) : null}
                  {OPEN_FIX_STATUSES.has(fix.status) ? (
                    <div className="fix-close-action">
                      <ConfirmButton
                        className="btn btn--sm"
                        label="Close fix"
                        confirmLabel="Confirm close"
                        restingAriaLabel={`Close the open fix for ${fix.item.title} — click twice to confirm`}
                        confirmAriaLabel={`Confirm closing the fix for ${fix.item.title}`}
                        disabled={closeFix.isPending}
                        onConfirm={() => closeFix.mutate({ fixRequestId: fix.id })}
                      />
                    </div>
                  ) : null}
                </td>
                <td data-label="Actions taken">
                  <details className="actions-details">
                    <summary>{fix.actionsTaken.length} steps</summary>
                    <pre className="actions-json">{JSON.stringify(fix.actionsTaken, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {list.hasNextPage ? (
        <div className="load-more">
          <button
            type="button"
            className="btn"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}
