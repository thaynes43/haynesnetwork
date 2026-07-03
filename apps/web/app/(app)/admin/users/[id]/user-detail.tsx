'use client';

// DESIGN-004 D-11 — user detail: direct family toggle, tag apply/remove, and the
// per-app grant/revoke checklist against the EFFECTIVE list with provenance chips
// (`default` / `direct` / `tag:<name>`, R-22). Mutations invalidate-and-refetch
// (simple over optimistic — DESIGN-003 D-11 idempotency makes replays harmless).

import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { provenanceForApp, provenanceLabel } from '@/lib/provenance';

export function UserDetail({ userId }: { userId: string }) {
  const utils = trpc.useUtils();
  const users = trpc.users.list.useQuery();
  const catalog = trpc.catalog.adminList.useQuery();
  const tags = trpc.tags.list.useQuery();
  const [error, setError] = useState<string | null>(null);

  const onError = (err: unknown) => setError(describeMutationError(err));
  const refetchUsers = {
    onError,
    onSuccess: () => setError(null),
    onSettled: () => utils.users.list.invalidate(),
  };
  const setFamily = trpc.users.setFamily.useMutation(refetchUsers);
  const grantApp = trpc.users.grantApp.useMutation(refetchUsers);
  const revokeApp = trpc.users.revokeApp.useMutation(refetchUsers);
  const applyTag = trpc.tags.applyToUser.useMutation({
    ...refetchUsers,
    onSettled: () =>
      Promise.all([utils.users.list.invalidate(), utils.tags.list.invalidate()]),
  });
  const removeTag = trpc.tags.removeFromUser.useMutation({
    ...refetchUsers,
    onSettled: () =>
      Promise.all([utils.users.list.invalidate(), utils.tags.list.invalidate()]),
  });
  const busy =
    setFamily.isPending ||
    grantApp.isPending ||
    revokeApp.isPending ||
    applyTag.isPending ||
    removeTag.isPending;

  const [tagToApply, setTagToApply] = useState('');

  if (users.isLoading || catalog.isLoading || tags.isLoading) {
    return <p className="muted">Loading…</p>;
  }
  const loadError = users.error ?? catalog.error ?? tags.error;
  if (loadError) {
    return (
      <p className="alert" role="alert">
        Failed to load: {loadError.message}
      </p>
    );
  }

  const user = (users.data ?? []).find((u) => u.id === userId);
  if (!user) {
    return (
      <>
        <p className="alert" role="alert">
          User not found.
        </p>
        <Link href="/admin">Back to users</Link>
      </>
    );
  }
  const entries = catalog.data ?? [];
  const adminTags = tags.data?.scope === 'admin' ? tags.data.tags : [];
  const appliedIds = new Set(user.tags.map((t) => t.id));
  const applicable = adminTags.filter((t) => !appliedIds.has(t.id));

  return (
    <>
      <p>
        <Link href="/admin">← Users</Link>
      </p>
      <h1>{user.displayName}</h1>
      <p className="muted">
        {user.email} · {user.role}
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="card admin-section">
        <h2>Family designation</h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={user.isFamily}
            disabled={busy}
            onChange={(e) => setFamily.mutate({ userId, isFamily: e.target.checked })}
          />
          <span>
            Direct family designation
            <span className="muted"> — effective family can also flow from a family tag</span>
          </span>
        </label>
      </section>

      <section className="card admin-section">
        <h2>Tags</h2>
        {user.tags.length === 0 ? (
          <p className="muted">No tags applied.</p>
        ) : (
          <ul className="chips chips--list">
            {user.tags.map((t) => (
              <li key={t.id} className="chip chip--action">
                {t.name}
                <button
                  type="button"
                  className="chip__remove"
                  aria-label={`Remove tag ${t.name}`}
                  disabled={busy}
                  onClick={() => removeTag.mutate({ tagId: t.id, userId })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {applicable.length > 0 ? (
          <div className="form-row">
            <label className="sr-only" htmlFor="apply-tag">
              Tag to apply
            </label>
            <select
              id="apply-tag"
              value={tagToApply}
              onChange={(e) => setTagToApply(e.target.value)}
            >
              <option value="">Choose a tag…</option>
              {applicable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={busy || tagToApply === ''}
              onClick={() => {
                applyTag.mutate({ tagId: tagToApply, userId });
                setTagToApply('');
              }}
            >
              Apply tag
            </button>
          </div>
        ) : null}
      </section>

      <section className="card admin-section">
        <h2>Apps</h2>
        <p className="muted">
          Checkbox = direct grant. Chips show every source of effective access (R-22);
          entries with no chips are not visible to this user.
        </p>
        <ul className="grant-list">
          {entries.map((entry) => {
            const chips = provenanceForApp(entry, user, adminTags);
            const direct = chips.some((c) => c.kind === 'direct');
            return (
              <li key={entry.id} className={chips.length > 0 ? 'grant is-effective' : 'grant'}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={direct}
                    disabled={busy}
                    onChange={(e) =>
                      e.target.checked
                        ? grantApp.mutate({ userId, appId: entry.id })
                        : revokeApp.mutate({ userId, appId: entry.id })
                    }
                  />
                  <span className="grant__name">{entry.name}</span>
                </label>
                <span className="chips">
                  {chips.map((c) => (
                    <span key={provenanceLabel(c)} className="chip">
                      {provenanceLabel(c)}
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
        {entries.length === 0 ? <p className="muted">The catalog is empty.</p> : null}
      </section>
    </>
  );
}
