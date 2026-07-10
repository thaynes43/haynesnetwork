'use client';

// ADR-045 / DESIGN-023 (PLAN-026) — /admin/users: the Authentik DIRECTORY. Lists EVERY mirrored
// Authentik identity — Plex-external accounts, native Authentik users, service accounts, and
// people who have never logged into haynesnetwork — with its app linkage and a per-row role
// assignment. Assigning flips owned-group membership in Authentik; for an identity with no app
// account the intent is PARKED (badge) and applies on their first login. The app-users roster
// (a subset of this view) stays at /admin. Same idioms as that roster: .admin-table with
// data-label card collapse, per-row error Map, apply-on-change select (ADR-015 stable geometry).

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

const SOURCE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'external', label: 'Plex-external' },
  { key: 'internal', label: 'Native' },
  { key: 'service', label: 'Service account' },
  { key: 'app', label: 'App-known' },
] as const;
type SourceFilterKey = (typeof SOURCE_FILTERS)[number]['key'];

/** Coarse relative freshness for the sync footnote ("12 minutes ago"); bad ISO → as-is. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export default function AdminDirectoryPage() {
  const identities = trpc.authentikPortal.listIdentities.useQuery();
  const roles = trpc.roles.list.useQuery();
  const [filter, setFilter] = useState<SourceFilterKey>('all');
  // Refresh failures surface as a page banner; per-row assignment errors are keyed by the
  // Authentik pk and render beside that row's select (same pattern as the /admin roster).
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<ReadonlyMap<number, string>>(() => new Map());

  const refresh = trpc.authentikPortal.refresh.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: () => identities.refetch(),
  });

  const assign = trpc.authentikPortal.assignRole.useMutation({
    onError: (err: unknown, vars) =>
      setRowError((m) => new Map(m).set(vars.authentikUserPk, describeMutationError(err))),
    onSuccess: (_data, vars) =>
      setRowError((m) => {
        const next = new Map(m);
        next.delete(vars.authentikUserPk);
        return next;
      }),
    onSettled: () => identities.refetch(),
  });

  if (identities.isLoading || roles.isLoading) return <p className="muted">Loading directory…</p>;
  const loadError = identities.error ?? roles.error;
  if (loadError) {
    return (
      <p className="alert" role="alert">
        Failed to load: {loadError.message}
      </p>
    );
  }

  const allRoles = roles.data ?? [];
  const all = identities.data ?? [];
  const rows = all.filter((row) => {
    switch (filter) {
      case 'external':
        return row.userType === 'external';
      case 'internal':
        return row.userType === 'internal';
      case 'service':
        return row.userType === 'internal_service_account';
      case 'app':
        return row.appUserId !== null;
      default:
        return true;
    }
  });
  // ISO-8601 strings compare lexicographically — the max is the newest sync.
  const newestSync = all.reduce<string | null>(
    (newest, row) => (newest === null || row.syncedAt > newest ? row.syncedAt : newest),
    null,
  );

  return (
    <>
      <div className="admin-head">
        <h1>Authentik Directory</h1>
        <span className="row-actions">
          {/* On-demand mirror refresh — an idempotent re-read of Authentik (not destructive),
              so a plain button, never a ConfirmButton. */}
          <button
            type="button"
            className="btn"
            data-testid="authentik-refresh"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            {refresh.isPending ? 'Refreshing…' : 'Refresh from Authentik'}
          </button>
        </span>
      </div>
      <p className="muted">
        Every Authentik identity — including Plex-external accounts and people who have never logged
        into haynesnetwork. Assigning a role updates Authentik group membership; for an identity
        without an app account the role is parked and applies on their first login.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {refresh.data ? (
        <p className="status-note" role="status" data-testid="authentik-refresh-status">
          Refreshed {refresh.data.fetched} {refresh.data.fetched === 1 ? 'identity' : 'identities'}
        </p>
      ) : null}

      {/* Source filter: a single-select pill row (aria-pressed radios). Constant pill widths —
          switching recolors the pills and filters rows, nothing else moves (ADR-015). */}
      <div className="dir-filterbar" role="group" aria-label="Filter identities by source">
        {SOURCE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="dir-filter"
            data-testid={`dir-filter-${f.key}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Identity</th>
            <th>Source</th>
            <th>Authentik groups</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const saving = assign.isPending && assign.variables?.authentikUserPk === row.pk;
            const err = rowError.get(row.pk);
            // Service accounts and e-mail-less identities can't hold a role (the server refuses
            // too — email is the first-login join key), so the select never renders for them.
            const assignable = row.userType !== 'internal_service_account' && row.email !== null;
            const pendingOnly = row.appUserId === null && row.pendingRoleName !== null;
            return (
              <tr key={row.pk}>
                <td data-label="Identity">
                  <div>
                    <strong>{row.username}</strong>
                    {row.name && row.name !== row.username ? (
                      <span className="muted"> — {row.name}</span>
                    ) : null}
                    <div className="muted">{row.email ?? 'no email'}</div>
                  </div>
                </td>
                <td data-label="Source">
                  <span className="chips">
                    {row.userType === 'external' ? (
                      <span className="badge badge--info" title="Signed up through the Plex source">
                        Plex
                      </span>
                    ) : row.userType === 'internal' ? (
                      <span className="badge badge--muted" title="Native Authentik account">
                        Native
                      </span>
                    ) : (
                      <span className="badge badge--muted" title="Authentik service account">
                        Service
                      </span>
                    )}
                    {row.appUserId !== null ? (
                      <span className="badge badge--ok" title="Has logged into haynesnetwork">
                        App user
                      </span>
                    ) : null}
                    {!row.isActive ? (
                      <span className="badge badge--danger" title="Deactivated in Authentik">
                        Inactive
                      </span>
                    ) : null}
                  </span>
                </td>
                <td data-label="Authentik groups">
                  {row.groups.length === 0 ? (
                    <span aria-hidden="true">—</span>
                  ) : (
                    <span className="chips">
                      {row.groups.map((g) => (
                        <span key={g} className="chip">
                          {g}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="user-role-cell" data-label="Role">
                  {!assignable ? (
                    <span
                      className="muted"
                      title={
                        row.email === null
                          ? 'No email — a role can’t be parked for this identity'
                          : 'Service accounts can’t hold a role'
                      }
                    >
                      —
                    </span>
                  ) : (
                    /* Apply-on-change role assignment (constant width, ADR-015). The value is the
                       app role when linked, else the parked pending role, else the placeholder. */
                    <div className="role-assign">
                      <label className="sr-only" htmlFor={`dir-role-${row.pk}`}>
                        Role for {row.username}
                      </label>
                      <select
                        id={`dir-role-${row.pk}`}
                        className="role-assign__select"
                        data-testid="dir-role-select"
                        value={row.appRoleId ?? row.pendingRoleId ?? ''}
                        disabled={saving}
                        onChange={(e) =>
                          assign.mutate({ authentikUserPk: row.pk, roleId: e.target.value })
                        }
                      >
                        {row.appRoleId === null && row.pendingRoleId === null ? (
                          <option value="" disabled>
                            —
                          </option>
                        ) : null}
                        {allRoles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                            {r.isAdmin ? ' (superuser)' : r.isDefault ? ' (default)' : ''}
                          </option>
                        ))}
                      </select>
                      {pendingOnly ? (
                        <span
                          className="badge badge--warn"
                          data-testid="dir-role-pending"
                          title="Parked — applies when they first log into haynesnetwork"
                        >
                          pending: {row.pendingRoleName}
                        </span>
                      ) : null}
                      {saving ? <span className="muted role-assign__status">Saving…</span> : null}
                      {err !== undefined ? (
                        <span className="field-error role-assign__error" role="alert">
                          {err}
                        </span>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {all.length === 0 ? (
        <p className="muted">No identities synced yet — click Refresh from Authentik.</p>
      ) : rows.length === 0 ? (
        <p className="muted">No identities match this filter.</p>
      ) : null}
      {newestSync !== null ? (
        <p className="muted" data-testid="dir-sync-note">
          Synced from Authentik {relativeTime(newestSync)}.
        </p>
      ) : null}
    </>
  );
}
