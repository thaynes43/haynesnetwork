'use client';

// DESIGN-005 D-16/D-17 / R-50..R-52 — /admin/restore: pick the *arr kind → live
// diff preview (ledger rows absent from the instance, tombstoned badged) → explicit
// selection + confirm dialog ('re-adds N items, monitored, no auto-search') →
// execute → per-item report (AC-09). Recent runs listed below (R-52 audit).
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { ARR_KIND_LABELS, formatWhen, type ArrKindName } from '@/lib/media';
import { Modal } from '@/components/modal';

const KINDS: ArrKindName[] = ['sonarr', 'radarr', 'lidarr'];

const RUN_STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
};

export default function AdminRestorePage() {
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<ArrKindName>('sonarr');
  const [previewing, setPreviewing] = useState(false);
  /** null ⇒ default state: everything in the current diff is selected. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const diff = trpc.restore.diff.useQuery(
    { arrKind: kind },
    {
      enabled: previewing,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    },
  );
  const runs = trpc.restore.runs.useQuery();
  const report = trpc.restore.run.useQuery({ id: runId ?? '' }, { enabled: runId !== null });

  const execute = trpc.restore.execute.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: ({ runId: id }) => {
      setError(null);
      setConfirmOpen(false);
      setRunId(id);
      setPreviewing(false);
      setSelected(null);
      void utils.restore.runs.invalidate();
    },
  });

  function startPreview(next: ArrKindName) {
    setKind(next);
    setRunId(null);
    setSelected(null);
    setPreviewing(true);
    // A fresh click re-runs the live diff even for the same kind.
    void utils.restore.diff.invalidate({ arrKind: next });
  }

  const rows = previewing ? (diff.data ?? []) : [];
  // Default: everything in the diff is selected; the admin prunes.
  const effectiveSelection = selected ?? new Set(rows.map((r) => r.mediaItemId));
  const selectedCount = rows.filter((r) => effectiveSelection.has(r.mediaItemId)).length;

  function toggle(id: string) {
    const next = new Set(effectiveSelection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  return (
    <>
      <h1>Restore</h1>
      <p className="muted restore-lede">
        Diff the ledger against a live instance and re-add what is missing — monitored, with the
        recorded quality profile, root folder, and tags. Searches are never triggered
        automatically.
      </p>

      <div className="library-filters admin-filterbar">
        <div className="seg" role="group" aria-label="Instance">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={kind === k && previewing ? 'is-active' : undefined}
              onClick={() => startPreview(k)}
            >
              {ARR_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        {previewing && !diff.isFetching ? (
          <button type="button" className="btn sm" onClick={() => startPreview(kind)}>
            Refresh diff
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {previewing ? (
        diff.isLoading || diff.isFetching ? (
          <p className="muted">Comparing the ledger against the live {ARR_KIND_LABELS[kind]} instance…</p>
        ) : diff.error ? (
          <p className="alert" role="alert">
            Diff failed: {diff.error.message}
          </p>
        ) : rows.length === 0 ? (
          <section className="card empty-state">
            <p>Nothing missing — the live instance has every monitored ledger item.</p>
          </section>
        ) : (
          <>
            <p className="muted">
              {rows.length} item{rows.length === 1 ? '' : 's'} in the ledger but not in the live
              instance. {selectedCount} selected.
            </p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Restore</th>
                  <th>Title</th>
                  <th>External id</th>
                  <th>Profile</th>
                  <th>Root folder</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.mediaItemId}>
                    <td data-label="Restore">
                      <label className="check-row restore-check">
                        <input
                          type="checkbox"
                          checked={effectiveSelection.has(row.mediaItemId)}
                          onChange={() => toggle(row.mediaItemId)}
                        />
                        <span className="sr-only">Restore {row.title}</span>
                      </label>
                    </td>
                    <td data-label="Title">
                      {row.title}
                      {row.year !== null ? <span className="muted"> ({row.year})</span> : null}{' '}
                      {row.tombstonedAt !== null ? (
                        <span className="badge badge--danger">tombstoned</span>
                      ) : null}
                    </td>
                    <td data-label="External id">{row.externalId}</td>
                    <td data-label="Profile">{row.qualityProfileName}</td>
                    <td data-label="Root folder" className="url-cell">
                      {row.rootFolder}
                    </td>
                    <td data-label="Tags">
                      {row.arrTags.length === 0 ? '—' : row.arrTags.join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="form-actions restore-actions">
              <button
                type="button"
                className="btn primary"
                disabled={selectedCount === 0 || execute.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                Restore {selectedCount} item{selectedCount === 1 ? '' : 's'}…
              </button>
            </div>
          </>
        )
      ) : null}

      {runId !== null ? (
        <section className="card admin-section">
          <h2>Restore report</h2>
          {report.isLoading ? <p className="muted">Loading the report…</p> : null}
          {report.data ? (
            <>
              <p>
                <span
                  className={`badge badge--${report.data.status === 'completed' ? 'ok' : report.data.status === 'failed' ? 'danger' : 'warn'}`}
                >
                  {RUN_STATUS_LABELS[report.data.status] ?? report.data.status}
                </span>{' '}
                {report.data.successCount}/{report.data.itemCount} re-added to{' '}
                {ARR_KIND_LABELS[report.data.arrKind as ArrKindName]}.
              </p>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.results.map((r) => {
                    const previewItem = report.data!.preview.find(
                      (p) => p.mediaItemId === r.mediaItemId,
                    );
                    return (
                      <tr key={`${r.mediaItemId}-${String(r.at)}`}>
                        <td data-label="Item">{previewItem?.title ?? r.mediaItemId}</td>
                        <td data-label="Result">
                          {r.ok ? (
                            <span className="badge badge--ok">re-added</span>
                          ) : (
                            <>
                              <span className="badge badge--danger">failed</span>{' '}
                              <span className="muted">{String(r.error ?? '')}</span>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="card admin-section">
        <h2>Recent restore runs</h2>
        {(runs.data ?? []).length === 0 ? (
          <p className="muted">No restore runs yet — hopefully it stays that way.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Instance</th>
                <th>Status</th>
                <th>Items</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data ?? []).map((run) => (
                <tr key={run.id}>
                  <td data-label="Started">{formatWhen(run.startedAt)}</td>
                  <td data-label="Instance">{ARR_KIND_LABELS[run.arrKind as ArrKindName]}</td>
                  <td data-label="Status">
                    <span
                      className={`badge badge--${run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'danger' : run.status === 'running' ? 'info' : 'warn'}`}
                    >
                      {RUN_STATUS_LABELS[run.status] ?? run.status}
                    </span>
                  </td>
                  <td data-label="Items">
                    {run.successCount}/{run.itemCount}
                  </td>
                  <td data-label="By">{run.initiatedByDisplayName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal open={confirmOpen} title="Confirm restore" onClose={() => setConfirmOpen(false)}>
        <p>
          This re-adds <strong>{selectedCount}</strong> item{selectedCount === 1 ? '' : 's'} to{' '}
          <strong>{ARR_KIND_LABELS[kind]}</strong> — monitored, with their recorded quality
          profiles, root folders, and tags. <strong>No automatic search</strong> is triggered; the
          instance backfills on its own schedule.
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="btn primary"
            disabled={execute.isPending}
            onClick={() =>
              execute.mutate({
                arrKind: kind,
                mediaItemIds: rows
                  .filter((r) => effectiveSelection.has(r.mediaItemId))
                  .map((r) => r.mediaItemId),
              })
            }
          >
            {execute.isPending ? 'Restoring…' : `Restore ${selectedCount} item${selectedCount === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            className="btn"
            disabled={execute.isPending}
            onClick={() => setConfirmOpen(false)}
          >
            Cancel
          </button>
        </div>
      </Modal>
    </>
  );
}
