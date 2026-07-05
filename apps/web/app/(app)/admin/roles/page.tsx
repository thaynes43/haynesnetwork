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
}

const EMPTY_FORM: RoleForm = { name: '', description: '', appIds: [], grantsAll: false };

export default function AdminRolesPage() {
  const utils = trpc.useUtils();
  const roles = trpc.roles.list.useQuery();
  const catalog = trpc.catalog.adminList.useQuery();

  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState<RoleForm>(EMPTY_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RoleForm>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const invalidate = () =>
    Promise.all([utils.roles.list.invalidate(), utils.catalog.myApps.invalidate()]);

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
  const busy = create.isPending || update.isPending || del.isPending;

  const roleRows = roles.data ?? [];
  const entries = catalog.data ?? [];
  const appNameById = new Map(entries.map((e) => [e.id, e.name]));

  function openAdd() {
    setAddForm(EMPTY_FORM);
    setAddError(null);
    setEditingId(null);
    setAdding(true);
  }

  function submitAdd(e: FormEvent) {
    e.preventDefault();
    create.mutate({
      name: addForm.name.trim(),
      description: addForm.description.trim(),
      appIds: addForm.grantsAll ? [] : addForm.appIds,
      grantsAll: addForm.grantsAll,
    });
  }

  function startEdit(role: (typeof roleRows)[number]) {
    setAdding(false);
    setEditingId(role.id);
    setEditForm({
      name: role.name,
      description: role.description ?? '',
      appIds: [...role.appIds],
      grantsAll: role.grantsAll,
    });
    setEditError(null);
  }

  function submitEdit(role: (typeof roleRows)[number], e: FormEvent) {
    e.preventDefault();
    update.mutate({
      id: role.id,
      // The Default role can't be renamed — omit the name so an unchanged submit is a no-op.
      ...(role.isDefault ? {} : { name: editForm.name.trim() }),
      description: editForm.description.trim(),
      appIds: editForm.grantsAll ? [] : editForm.appIds,
      grantsAll: editForm.grantsAll,
    });
  }

  const toggle = (form: RoleForm, appId: string, on: boolean): RoleForm => ({
    ...form,
    appIds: on ? [...form.appIds, appId] : form.appIds.filter((id) => id !== appId),
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

  const appChecklist = (
    form: RoleForm,
    apply: (next: (f: RoleForm) => RoleForm) => void,
  ) => (
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

  return (
    <>
      <div className="admin-head">
        <h1>Roles</h1>
        <button type="button" className="btn primary" onClick={openAdd} disabled={busy}>
          Add role
        </button>
      </div>
      <p className="muted">
        Every user has exactly one role. Assign roles to users on their detail page.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Apps</th>
            <th>Members</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {roleRows.map((role) => {
            if (editingId === role.id) {
              return (
                <tr key={role.id} className="row-edit">
                  <td colSpan={4}>
                    <form className="admin-form" onSubmit={(e) => submitEdit(role, e)}>
                      <label className="field">
                        <span>
                          Name <span className="req" aria-hidden="true">*</span>
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
              Name <span className="req" aria-hidden="true">*</span>
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
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={create.isPending}>
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
