'use client';

// DESIGN-004 D-11 / ADR-012 — user detail: assign the user's single role. Access is
// entirely defined by that role; the apps it grants are shown read-only for context
// (edit them on /admin/roles). Mutations invalidate-and-refetch; a LAST_ADMIN / not-found
// error surfaces in the alert.

import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

export function UserDetail({ userId }: { userId: string }) {
  const utils = trpc.useUtils();
  const users = trpc.users.list.useQuery();
  const roles = trpc.roles.list.useQuery();
  const catalog = trpc.catalog.adminList.useQuery();
  const [error, setError] = useState<string | null>(null);
  // fix/plex-identity-mapping — the Plex identity override inputs (seeded from the user row below).
  const [plexEmail, setPlexEmail] = useState('');
  const [plexUsername, setPlexUsername] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const setRole = trpc.users.setRole.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: () => utils.users.list.invalidate(),
  });
  const setPlexIdentity = trpc.users.setPlexIdentity.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: () => utils.users.list.invalidate(),
  });

  if (users.isLoading || roles.isLoading || catalog.isLoading) {
    return <p className="muted">Loading…</p>;
  }
  const loadError = users.error ?? roles.error ?? catalog.error;
  if (loadError) {
    return (
      <p className="alert" role="alert">
        Failed to load: {loadError.message}
      </p>
    );
  }

  const user = (users.data ?? []).find((u) => u.id === userId);
  // Seed the Plex identity inputs once per loaded user (React's adjust-state-on-change pattern) so
  // the fields show the current override without a useEffect; admin edits then persist locally.
  if (user && seededFor !== user.id) {
    setSeededFor(user.id);
    setPlexEmail(user.plexEmail ?? '');
    setPlexUsername(user.plexUsername ?? '');
  }
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

  const allRoles = roles.data ?? [];
  const currentRole = allRoles.find((r) => r.id === user.role.id);
  const appNameById = new Map((catalog.data ?? []).map((a) => [a.id, a.name]));
  const grantsAllApps = Boolean(currentRole?.isAdmin || currentRole?.grantsAll);
  const grantedAppNames = grantsAllApps
    ? null // superuser or "All apps" role → every app
    : (currentRole?.appIds ?? [])
        .map((id) => appNameById.get(id) ?? id)
        .sort((a, b) => a.localeCompare(b));

  return (
    <>
      <p>
        <Link href="/admin">← Users</Link>
      </p>
      <h1>{user.displayName}</h1>
      <p className="muted">{user.email}</p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="card admin-section">
        <h2>Role</h2>
        <div className="form-row">
          <label className="sr-only" htmlFor="user-role">
            Role
          </label>
          <select
            id="user-role"
            value={user.role.id}
            disabled={setRole.isPending}
            onChange={(e) => setRole.mutate({ userId, roleId: e.target.value })}
          >
            {allRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.isAdmin ? ' (superuser)' : r.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
          {setRole.isPending ? <span className="muted">Saving…</span> : null}
        </div>
        <p className="field-hint">
          A user has exactly one role. Edit what a role grants on{' '}
          <Link href="/admin/roles">Roles</Link>.
        </p>
      </section>

      <section className="card admin-section">
        <h2>Plex identity</h2>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            setPlexIdentity.mutate({
              userId,
              plexEmail: plexEmail.trim() || null,
              plexUsername: plexUsername.trim() || null,
            });
          }}
        >
          <div className="form-row">
            <label htmlFor="plex-email">Plex email</label>
            <input
              id="plex-email"
              type="text"
              inputMode="email"
              autoComplete="off"
              placeholder="name@example.com"
              value={plexEmail}
              disabled={setPlexIdentity.isPending}
              onChange={(e) => setPlexEmail(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="plex-username">Plex username</label>
            <input
              id="plex-username"
              type="text"
              autoComplete="off"
              placeholder="plexuser"
              value={plexUsername}
              disabled={setPlexIdentity.isPending}
              onChange={(e) => setPlexUsername(e.target.value)}
            />
          </div>
          <div className="form-row">
            <button type="submit" className="btn sm primary" disabled={setPlexIdentity.isPending}>
              {setPlexIdentity.isPending ? 'Saving…' : 'Save Plex identity'}
            </button>
          </div>
        </form>
        <p className="field-hint">
          Maps this user to their real Plex account when their sign-in email differs from their
          plex.tv email (e.g. an account linked to Plex after it was created). My Plex uses this to
          recognize the owner and friends. Leave blank to fall back to the sign-in email. Set either
          the email or the username — whichever matches their Plex account.
        </p>
      </section>

      <section className="card admin-section">
        <h2>Apps this role grants</h2>
        {grantedAppNames === null ? (
          <p className="muted">
            All apps — {currentRole?.name}{' '}
            {currentRole?.isAdmin ? 'is a superuser role' : 'grants every app'}.
          </p>
        ) : grantedAppNames.length === 0 ? (
          <p className="muted">This role grants no apps yet.</p>
        ) : (
          <ul className="chips chips--list">
            {grantedAppNames.map((name) => (
              <li key={name} className="chip">
                {name}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
