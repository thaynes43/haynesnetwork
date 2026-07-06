'use client';

// DESIGN-004 D-11 / ADR-012 — /admin/roles: the roles table + Add-role modal + edit-in-place
// inline editor (same UX as /admin/catalog). A role's app set (replace-whole-bundle) is
// edited here; assigning a role to a user lives on the user detail page. The Admin role is a
// locked superuser (all apps, no edit/delete); the Default role's apps are editable but it
// can't be renamed or deleted. Mutations invalidate-and-refetch.

import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

interface RoleForm {
  name: string;
  description: string;
  appIds: string[];
  grantsAll: boolean;
  // ADR-017 / DESIGN-007 D-06 — the Plex libraries this role may self-add (role_library_grants).
  libraryIds: string[];
}

const EMPTY_FORM: RoleForm = {
  name: '',
  description: '',
  appIds: [],
  grantsAll: false,
  libraryIds: [],
};

export default function AdminRolesPage() {
  const utils = trpc.useUtils();
  const roles = trpc.roles.list.useQuery();
  const catalog = trpc.catalog.adminList.useQuery();
  // Phase 3 — the per-role Plex library grant matrix (folded onto this page).
  const libs = trpc.plex.roleLibraryGrants.useQuery();

  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState<RoleForm>(EMPTY_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RoleForm>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const invalidate = () =>
    Promise.all([
      utils.roles.list.invalidate(),
      utils.catalog.myApps.invalidate(),
      utils.plex.roleLibraryGrants.invalidate(),
      utils.plex.myLibraries.invalidate(),
    ]);

  const create = trpc.roles.create.useMutation({
    onError: (err: unknown) => setAddError(describeMutationError(err)),
    onSuccess: () => {
      setAdding(false);
      setAddError(null);
    },
    onSettled: invalidate,
  });
  const update = trpc.roles.update.useMutation({
    onError: (err: unknown) => setEditError(describeMutationError(err)),
    onSuccess: () => {
      setEditingId(null);
      setEditError(null);
    },
    onSettled: invalidate,
  });
  const del = trpc.roles.delete.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  // Library grants ride a separate single-writer (setRoleLibraries → 'update_role_libraries'
  // audit); its errors surface on the top-level banner since the inline editor may have closed.
  const setLibs = trpc.plex.setRoleLibraryGrants.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSettled: invalidate,
  });
  // Admin registry refresh (ADR-017 D-04) — repopulate plex_libraries from the live servers.
  const refresh = trpc.plex.refreshRegistry.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  // ADR-021 / DESIGN-009 D-08 — a role's per-section access level (Ledger only for now;
  // Trash is reserved for PLAN-006 and stays hidden). Applies on change, like the user-detail
  // role select; the Admin role is implicit Edit and immutable (server-enforced ROLE_IMMUTABLE).
  const setSection = trpc.roles.setSectionPermission.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  const busy =
    create.isPending ||
    update.isPending ||
    del.isPending ||
    setLibs.isPending ||
    refresh.isPending ||
    setSection.isPending;

  const roleRows = roles.data ?? [];
  const entries = catalog.data ?? [];
  const appNameById = new Map(entries.map((e) => [e.id, e.name]));
  const libServers = libs.data?.servers ?? [];
  const grantsByRole = libs.data?.grantsByRole ?? {};

  function openAdd() {
    setAddForm(EMPTY_FORM);
    setAddError(null);
    setEditingId(null);
    setAdding(true);
  }

  async function submitAdd(e: FormEvent) {
    e.preventDefault();
    try {
      const { roleId } = await create.mutateAsync({
        name: addForm.name.trim(),
        description: addForm.description.trim(),
        appIds: addForm.grantsAll ? [] : addForm.appIds,
        grantsAll: addForm.grantsAll,
      });
      // Library grants are independent of grants_all (ADR-017 D-08) — always persisted.
      if (libs.data) await setLibs.mutateAsync({ roleId, libraryIds: addForm.libraryIds });
    } catch {
      /* onError handlers set the banners */
    }
  }

  function startEdit(role: (typeof roleRows)[number]) {
    setAdding(false);
    setEditingId(role.id);
    setEditForm({
      name: role.name,
      description: role.description ?? '',
      appIds: [...role.appIds],
      grantsAll: role.grantsAll,
      libraryIds: [...(grantsByRole[role.id] ?? [])],
    });
    setEditError(null);
  }

  async function submitEdit(role: (typeof roleRows)[number], e: FormEvent) {
    e.preventDefault();
    try {
      await update.mutateAsync({
        id: role.id,
        // The Default role can't be renamed — omit the name so an unchanged submit is a no-op.
        ...(role.isDefault ? {} : { name: editForm.name.trim() }),
        description: editForm.description.trim(),
        appIds: editForm.grantsAll ? [] : editForm.appIds,
        grantsAll: editForm.grantsAll,
      });
      // Only touch library grants when the matrix has loaded (else we'd wipe the current set).
      if (libs.data)
        await setLibs.mutateAsync({ roleId: role.id, libraryIds: editForm.libraryIds });
    } catch {
      /* onError handlers set the banners */
    }
  }

  const toggle = (form: RoleForm, appId: string, on: boolean): RoleForm => ({
    ...form,
    appIds: on ? [...form.appIds, appId] : form.appIds.filter((id) => id !== appId),
  });

  const toggleLibrary = (form: RoleForm, libraryId: string, on: boolean): RoleForm => ({
    ...form,
    libraryIds: on
      ? [...form.libraryIds, libraryId]
      : form.libraryIds.filter((id) => id !== libraryId),
  });

  if (roles.isLoading || catalog.isLoading) return <p className="muted">Loading roles…</p>;
  const loadError = roles.error ?? catalog.error;
  if (loadError) {
    return (
      <p className="alert" role="alert">
        Failed to load: {loadError.message}
      </p>
    );
  }

  const appChecklist = (form: RoleForm, apply: (next: (f: RoleForm) => RoleForm) => void) => (
    <fieldset className="field">
      <legend>Apps this role grants</legend>
      <label className="check-row">
        <input
          type="checkbox"
          checked={form.grantsAll}
          onChange={(e) => apply((f) => ({ ...f, grantsAll: e.target.checked }))}
        />
        <span>
          <strong>All apps</strong>
          <span className="muted"> — every app, including ones added to the catalog later</span>
        </span>
      </label>
      {entries.length === 0 ? (
        <p className="muted">The catalog is empty — nothing to grant.</p>
      ) : (
        // Greyed + non-interactive while "All apps" is on (inputs disabled, rows dimmed).
        <ul className="check-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <label className="check-row" data-disabled={form.grantsAll || undefined}>
                <input
                  type="checkbox"
                  disabled={form.grantsAll}
                  checked={form.grantsAll || form.appIds.includes(entry.id)}
                  onChange={(e) => apply((f) => toggle(f, entry.id, e.target.checked))}
                />
                <span>{entry.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );

  // ADR-017 / DESIGN-007 D-06 — the Plex library grant matrix, grouped per server. Unlike the
  // app matrix there is no "All libraries" master toggle: grants_all does not imply libraries
  // (D-08). Unavailable libraries stay checkable so a soft-removed library's grant round-trips.
  const libraryChecklist = (form: RoleForm, apply: (next: (f: RoleForm) => RoleForm) => void) => (
    <fieldset className="field">
      <legend>Plex libraries this role can self-add</legend>
      {libs.isLoading ? (
        <p className="muted">Loading libraries…</p>
      ) : libServers.length === 0 ? (
        <p className="muted">No libraries yet — run a registry refresh to populate them.</p>
      ) : (
        libServers.map((server) => (
          <div className="lib-group" key={server.slug}>
            <p className="lib-group__name">{server.name}</p>
            <ul className="check-list">
              {server.libraries.map((lib) => (
                <li key={lib.id}>
                  <label className="check-row" data-disabled={!lib.available || undefined}>
                    <input
                      type="checkbox"
                      checked={form.libraryIds.includes(lib.id)}
                      onChange={(e) => apply((f) => toggleLibrary(f, lib.id, e.target.checked))}
                    />
                    <span>
                      {lib.name}
                      {!lib.available ? <span className="muted"> (unavailable)</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </fieldset>
  );

  return (
    <>
      <div className="admin-head">
        <h1>Roles</h1>
        <span className="row-actions">
          <button
            type="button"
            className="btn"
            data-testid="plex-refresh-registry"
            onClick={() => refresh.mutate({})}
            disabled={busy}
          >
            {refresh.isPending ? 'Refreshing…' : 'Refresh Plex libraries'}
          </button>
          <button type="button" className="btn primary" onClick={openAdd} disabled={busy}>
            Add role
          </button>
        </span>
      </div>
      <p className="muted">
        Every user has exactly one role. Assign roles to users on their detail page.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {/* ADR-017 / DESIGN-007 D-12 — per-server refresh outcome. A single unreachable server
          degrades to a warning tone (never the red error banner); all-ok is an info tone. Short
          labels only ('unreachable' etc.) — the domain never surfaces a raw error or token. */}
      {refresh.data ? (
        <p
          className={`status-note${refresh.data.ok ? '' : ' status-note--warn'}`}
          role="status"
          data-testid="plex-refresh-status"
        >
          {refresh.data.servers.length === 0
            ? 'No Plex servers to refresh.'
            : refresh.data.servers
                .map((s) =>
                  s.ok
                    ? `${s.name}: ${s.libraryCount ?? 0} ${s.libraryCount === 1 ? 'library' : 'libraries'}`
                    : `${s.name}: ${s.error ?? 'error'}`,
                )
                .join(' · ')}
        </p>
      ) : null}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Apps</th>
            <th>Members</th>
            <th>Ledger</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {roleRows.map((role) => {
            if (editingId === role.id) {
              return (
                <tr key={role.id} className="row-edit">
                  <td colSpan={5}>
                    <form className="admin-form" onSubmit={(e) => submitEdit(role, e)}>
                      <label className="field">
                        <span>
                          Name{' '}
                          <span className="req" aria-hidden="true">
                            *
                          </span>
                        </span>
                        <input
                          required
                          aria-label="Name"
                          maxLength={64}
                          disabled={role.isDefault}
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        />
                        {role.isDefault ? (
                          <span className="field-hint">The Default role can’t be renamed.</span>
                        ) : null}
                      </label>
                      <label className="field">
                        <span>Description</span>
                        <input
                          maxLength={280}
                          value={editForm.description}
                          onChange={(e) =>
                            setEditForm({ ...editForm, description: e.target.value })
                          }
                        />
                      </label>
                      {appChecklist(editForm, setEditForm)}
                      {libraryChecklist(editForm, setEditForm)}
                      {editError ? (
                        <p className="alert" role="alert">
                          {editError}
                        </p>
                      ) : null}
                      <div className="form-actions">
                        <button type="submit" className="btn primary" disabled={busy}>
                          Save changes
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </td>
                </tr>
              );
            }
            const editingElsewhere = editingId !== null;
            return (
              <tr key={role.id}>
                <td data-label="Role">
                  <strong>{role.name}</strong>
                  {role.isAdmin ? <span className="tag"> superuser</span> : null}
                  {role.isDefault ? <span className="tag"> default</span> : null}
                  {role.grantsAll && !role.isAdmin ? <span className="tag"> all apps</span> : null}
                  {role.description ? <span className="muted"> — {role.description}</span> : null}
                </td>
                <td data-label="Apps">
                  {role.isAdmin || role.grantsAll ? (
                    <span className="muted">All apps</span>
                  ) : role.appIds.length === 0 ? (
                    <span aria-hidden="true">—</span>
                  ) : (
                    <span className="chips">
                      {role.appIds.map((appId) => (
                        <span key={appId} className="chip">
                          {appNameById.get(appId) ?? appId}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td data-label="Members">{role.memberCount}</td>
                {/* ADR-021 — the Sections editor (Ledger level; Trash reserved for PLAN-006).
                    Admin shows its implicit Edit, uneditable (C-03). */}
                <td data-label="Ledger">
                  {role.isAdmin ? (
                    <span className="muted" title="The Admin role implies Edit on every section">
                      Edit
                    </span>
                  ) : (
                    <select
                      className="section-select"
                      aria-label={`Ledger access for ${role.name}`}
                      value={role.sectionPermissions.ledger}
                      disabled={busy || editingElsewhere}
                      onChange={(e) =>
                        setSection.mutate({
                          roleId: role.id,
                          sectionId: 'ledger',
                          level: e.target.value as 'edit' | 'read_only' | 'disabled',
                        })
                      }
                    >
                      <option value="edit">Edit</option>
                      <option value="read_only">Read-only</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  )}
                </td>
                <td data-label="Actions">
                  {role.isAdmin ? (
                    <span className="muted">locked</span>
                  ) : (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy || editingElsewhere}
                        onClick={() => startEdit(role)}
                      >
                        Edit
                      </button>
                      {role.isDefault ? null : (
                        <ConfirmButton
                          className="btn sm danger"
                          data-testid="role-row-delete"
                          disabled={busy || editingElsewhere}
                          label="Delete"
                          restingAriaLabel={`Delete role ${role.name} — its ${role.memberCount} member(s) fall back to Default — click twice to confirm`}
                          confirmAriaLabel={`Confirm delete role ${role.name}`}
                          onConfirm={() => del.mutate({ id: role.id })}
                        />
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Modal
        open={adding}
        title="Add role"
        onClose={() => setAdding(false)}
        banner={
          addError ? (
            <p className="alert" role="alert">
              {addError}
            </p>
          ) : null
        }
      >
        <form className="admin-form catalog-modal-form" onSubmit={submitAdd}>
          <label className="field">
            <span>
              Name{' '}
              <span className="req" aria-hidden="true">
                *
              </span>
            </span>
            <input
              required
              aria-label="Name"
              maxLength={64}
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              maxLength={280}
              value={addForm.description}
              onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
            />
          </label>
          {appChecklist(addForm, setAddForm)}
          {libraryChecklist(addForm, setAddForm)}
          <div className="form-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={create.isPending || setLibs.isPending}
            >
              Create role
            </button>
            <button
              type="button"
              className="btn"
              disabled={create.isPending}
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
