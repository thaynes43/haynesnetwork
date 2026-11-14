'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import type { ArrKindName } from '@/lib/media';

/** ADR-121: a fresh failsafe diff and its excluded titles are visible before consent. */
export function FailsafeRestore() {
  const [kind, setKind] = useState<ArrKindName>('radarr');
  return (
    <section className="card">
      <h1>Failsafe restore</h1>
      <p>
        Recover missing monitored ledger titles after a media manager rebuild. Searches stay off.
      </p>
      <p>
        Trash-deleted titles are skipped. Request them in Seerr or use an admin Restore in{' '}
        <Link href="/trash?tab=deleted">Trash</Link>.
      </p>
      <label>
        Manager{' '}
        <select value={kind} onChange={(e) => setKind(e.target.value as ArrKindName)}>
          <option value="radarr">Movies</option>
          <option value="sonarr">TV</option>
          <option value="lidarr">Music</option>
        </select>
      </label>
      <RestoreDiff key={kind} kind={kind} />
    </section>
  );
}

function RestoreDiff({ kind }: { kind: ArrKindName }) {
  const diff = trpc.restore.diff.useQuery({ arrKind: kind });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const execute = trpc.restore.execute.useMutation({ onSuccess: () => setConfirm(false) });
  const report = trpc.restore.run.useQuery(
    { id: execute.data?.runId ?? '' },
    { enabled: !!execute.data },
  );
  return (
    <>
      {diff.error ? <p role="alert">{diff.error.message}</p> : null}
      <p role="status">
        {diff.data
          ? `${diff.data.items.length} eligible; ${diff.data.skippedTrashCount} Trash-deleted titles skipped.`
          : 'Loading preview…'}
      </p>
      <ul>
        {diff.data?.skippedTrash.map((i) => (
          <li key={i.mediaItemId}>{i.title} — skipped: Trash-deleted</li>
        ))}
      </ul>
      <ul>
        {diff.data?.items.map((i) => (
          <li key={i.mediaItemId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(i.mediaItemId)}
                onChange={(e) =>
                  setSelected((old) => {
                    const next = new Set(old);
                    if (e.target.checked) next.add(i.mediaItemId);
                    else next.delete(i.mediaItemId);
                    return next;
                  })
                }
              />{' '}
              {i.title}
            </label>
          </li>
        ))}
      </ul>
      <button
        className="btn"
        disabled={selected.size === 0 || execute.isPending}
        onClick={() => setConfirm(true)}
      >
        Restore selected
      </button>
      <Modal
        open={confirm}
        title="Confirm failsafe restore"
        onClose={() => {
          if (!execute.isPending) setConfirm(false);
        }}
      >
        <p>
          Re-add {selected.size} selected titles, monitored, with searches off. Trash history is
          checked again; newly ineligible titles are skipped.
        </p>
        {execute.error ? <p role="alert">{execute.error.message}</p> : null}
        <button
          className="btn"
          disabled={execute.isPending}
          onClick={() => execute.mutate({ arrKind: kind, mediaItemIds: [...selected] })}
        >
          Confirm restore
        </button>
      </Modal>
      {execute.data ? (
        <p role="status">
          {execute.data.skippedTrashCount} Trash-deleted titles skipped:{' '}
          {execute.data.skippedTrash.map((i) => i.title).join(', ') || 'none'}.
        </p>
      ) : null}
      {report.error ? <p role="alert">{report.error.message}</p> : null}
      {report.data ? (
        <p role="status">
          {report.data.successCount} restored; {report.data.status}.
        </p>
      ) : null}
    </>
  );
}
