'use client';

// DESIGN-004 D-11 — /admin users list: displayName, email, role, family badge, tags,
// direct-grant count; rows link to /admin/users/[id]. Table → card collapse <760px is
// CSS-only via data-label (D-06).

import Link from 'next/link';
import { trpc } from '@/lib/trpc-client';

export default function AdminUsersPage() {
  const users = trpc.users.list.useQuery();

  if (users.isLoading) return <p className="muted">Loading users…</p>;
  if (users.error) {
    return (
      <p className="alert" role="alert">
        Failed to load users: {users.error.message}
      </p>
    );
  }

  return (
    <>
      <h1>Users</h1>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Family</th>
            <th>Tags</th>
            <th>Grants</th>
          </tr>
        </thead>
        <tbody>
          {(users.data ?? []).map((u) => (
            <tr key={u.id}>
              <td data-label="Name">
                <Link className="row-link" href={`/admin/users/${u.id}`}>
                  {u.displayName}
                </Link>
              </td>
              <td data-label="Email">{u.email}</td>
              <td data-label="Role">{u.role}</td>
              <td data-label="Family">
                {u.isFamily ? <span className="badge">family</span> : <span aria-hidden="true">—</span>}
              </td>
              <td data-label="Tags">
                {u.tags.length === 0 ? (
                  <span aria-hidden="true">—</span>
                ) : (
                  <span className="chips">
                    {u.tags.map((t) => (
                      <span key={t.id} className="chip">
                        {t.name}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td data-label="Grants">{u.directGrants.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(users.data ?? []).length === 0 ? <p className="muted">No users yet.</p> : null}
    </>
  );
}
