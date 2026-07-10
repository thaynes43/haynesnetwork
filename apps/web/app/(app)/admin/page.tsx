'use client';

// DESIGN-004 D-11 / ADR-012 — /admin users list: displayName, email, and the user's
// single role. The Name links to /admin/users/[id] (Plex identity + the role's app set);
// the Role column is an INLINE editable select so an admin can reassign a role straight
// from the list — the same audited users.setRole write + LAST_ADMIN protection as the
// detail page (owner-directed 2026-07-09: the mobile card dropped the desktop control, so
// the wife's role couldn't be changed from a phone). Table → card collapse <760px is
// CSS-only via data-label (D-06); the role select goes full-width in the card (fix/…-roles).

import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

export default function AdminUsersPage() {
  const utils = trpc.useUtils();
  const users = trpc.users.list.useQuery();
  const roles = trpc.roles.list.useQuery();
  // Per-row assignment error (keyed by userId) — a LAST_ADMIN refusal or a not-found surfaces
  // beside that user's select, never as a page-wide banner.
  const [rowError, setRowError] = useState<ReadonlyMap<string, string>>(() => new Map());

  const setRole = trpc.users.setRole.useMutation({
    onError: (err: unknown, vars) =>
      setRowError((m) => new Map(m).set(vars.userId, describeMutationError(err))),
    onSuccess: (_data, vars) =>
      setRowError((m) => {
        const next = new Map(m);
        next.delete(vars.userId);
        return next;
      }),
    // Refetch the roster so the select reflects the committed role (and any no-op reconciles).
    onSettled: () => utils.users.list.invalidate(),
  });

  if (users.isLoading || roles.isLoading) return <p className="muted">Loading users…</p>;
  const loadError = users.error ?? roles.error;
  if (loadError) {
    return (
      <p className="alert" role="alert">
        Failed to load users: {loadError.message}
      </p>
    );
  }

  const allRoles = roles.data ?? [];
  const rows = users.data ?? [];

  return (
    <>
      <h1>Users</h1>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const saving = setRole.isPending && setRole.variables?.userId === u.id;
            const err = rowError.get(u.id);
            return (
              <tr key={u.id}>
                <td data-label="Name">
                  <Link className="row-link" href={`/admin/users/${u.id}`}>
                    {u.displayName}
                  </Link>
                  {u.role.isAdmin ? (
                    <span className="tag" title="This role is a superuser">
                      {' '}
                      superuser
                    </span>
                  ) : null}
                </td>
                <td data-label="Email">{u.email}</td>
                <td className="user-role-cell" data-label="Role">
                  {/* Inline audited role assignment — reassign from the list (works on a phone:
                      the select goes full-width in the card, ADR-015 stable geometry). */}
                  <div className="role-assign">
                    <label className="sr-only" htmlFor={`role-${u.id}`}>
                      Role for {u.displayName}
                    </label>
                    <select
                      id={`role-${u.id}`}
                      className="role-assign__select"
                      data-testid="user-role-select"
                      value={u.role.id}
                      disabled={saving}
                      onChange={(e) => setRole.mutate({ userId: u.id, roleId: e.target.value })}
                    >
                      {allRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                          {r.isAdmin ? ' (superuser)' : r.isDefault ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                    {saving ? <span className="muted role-assign__status">Saving…</span> : null}
                    {err !== undefined ? (
                      <span className="field-error role-assign__error" role="alert">
                        {err}
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted">No users yet.</p> : null}
    </>
  );
}
