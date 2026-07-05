'use client';

// DESIGN-004 D-11 — /admin/catalog: entries table (cards <760px via data-label).
// Add opens a Modal with the create form; Edit expands the row IN PLACE into an inline
// editor (no shared bottom form). URL validated live against R-14 (server stays
// authoritative — appCode errors surfaced), defaultVisible toggle, icon picker from
// ICON_KEYS, up/down-button reorder → catalog.reorder with the complete id set (D-06).

import { useState, type FormEvent } from 'react';
import { ICON_KEYS, AppIcon, isIconKey } from '@hnet/ui';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { catalogUrlError } from '@/lib/catalog-url';

interface FormState {
  slug: string;
  name: string;
  description: string;
  icon: string; // '' = none (null on the wire)
  url: string;
  defaultVisible: boolean;
}

const EMPTY_FORM: FormState = {
  slug: '',
  name: '',
  description: '',
  icon: '',
  url: '',
  defaultVisible: false,
};

export default function AdminCatalogPage() {
  const utils = trpc.useUtils();
  const catalog = trpc.catalog.adminList.useQuery();

  // Three independent error surfaces so a modal/inline/row error never bleeds across:
  const [error, setError] = useState<string | null>(null); // top-level (delete/reorder)
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);
  const [addUrlTouched, setAddUrlTouched] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [editUrlTouched, setEditUrlTouched] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const invalidate = () =>
    Promise.all([utils.catalog.adminList.invalidate(), utils.catalog.myApps.invalidate()]);

  const create = trpc.catalog.create.useMutation({
    onError: (err) => setAddError(describeMutationError(err)),
    onSuccess: () => {
      setAdding(false);
      setAddError(null);
    },
    onSettled: invalidate,
  });
  const update = trpc.catalog.update.useMutation({
    onError: (err) => setEditError(describeMutationError(err)),
    onSuccess: () => {
      setEditingId(null);
      setEditError(null);
    },
    onSettled: invalidate,
  });
  const del = trpc.catalog.delete.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  const reorder = trpc.catalog.reorder.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  // Table controls (reorder/delete) lock during any write so the id set can't race.
  const busy = create.isPending || update.isPending || del.isPending || reorder.isPending;

  const entries = catalog.data ?? [];
  const addUrlError = catalogUrlError(addForm.url);
  const editUrlError = catalogUrlError(editForm.url);

  function openAdd() {
    setAddForm(EMPTY_FORM);
    setAddUrlTouched(false);
    setAddError(null);
    setEditingId(null); // never both editors open at once
    setAdding(true);
  }

  function submitAdd(e: FormEvent) {
    e.preventDefault();
    setAddUrlTouched(true);
    if (addUrlError) return; // live client check; the server re-validates regardless
    create.mutate({
      slug: addForm.slug.trim(),
      name: addForm.name.trim(),
      description: addForm.description.trim(),
      icon: isIconKey(addForm.icon) ? addForm.icon : null,
      url: addForm.url.trim(),
      defaultVisible: addForm.defaultVisible,
    });
  }

  function startEdit(entry: (typeof entries)[number]) {
    setAdding(false);
    setEditingId(entry.id);
    setEditForm({
      slug: entry.slug,
      name: entry.name,
      description: entry.description ?? '',
      icon: entry.icon ?? '',
      url: entry.url,
      defaultVisible: entry.defaultVisible,
    });
    setEditUrlTouched(false);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  function submitEdit(id: string, e: FormEvent) {
    e.preventDefault();
    setEditUrlTouched(true);
    if (editUrlError) return;
    update.mutate({
      id,
      name: editForm.name.trim(),
      description: editForm.description.trim(),
      icon: isIconKey(editForm.icon) ? editForm.icon : null,
      url: editForm.url.trim(),
      defaultVisible: editForm.defaultVisible,
    });
  }

  function move(index: number, delta: -1 | 1) {
    const ids = entries.map((en) => en.id);
    const target = index + delta;
    const a = ids[index];
    const b = ids[target];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[target] = a;
    reorder.mutate({ orderedIds: ids });
  }

  if (catalog.isLoading) return <p className="muted">Loading catalog…</p>;
  if (catalog.error) {
    return (
      <p className="alert" role="alert">
        Failed to load catalog: {catalog.error.message}
      </p>
    );
  }

  return (
    <>
      <div className="admin-head">
        <h1>Catalog</h1>
        <button type="button" className="btn primary" onClick={openAdd} disabled={busy}>
          Add entry
        </button>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="muted">No catalog entries yet — use “Add entry” to create the first one.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>App</th>
              <th>URL</th>
              <th>Default</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => {
              const editingThis = editingId === entry.id;
              const editingElsewhere = editingId !== null && !editingThis;
              if (editingThis) {
                return (
                  <tr key={entry.id} className="row-edit">
                    <td colSpan={5}>
                      <form className="admin-form row-edit-form" onSubmit={(e) => submitEdit(entry.id, e)}>
                        <p className="muted row-edit__slug">
                          Editing <strong>{entry.slug}</strong> — slug is immutable.
                        </p>
                        <div className="row-edit__grid">
                          <label className="field">
                            <span>Name</span>
                            <input
                              required
                              maxLength={64}
                              value={editForm.name}
                              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                            />
                          </label>
                          <label className="field field--url">
                            <span>URL</span>
                            <input
                              required
                              type="url"
                              inputMode="url"
                              placeholder="https://app.haynesnetwork.com"
                              value={editForm.url}
                              onBlur={() => setEditUrlTouched(true)}
                              onChange={(e) => setEditForm({ ...editForm, url: e.target.value })}
                              aria-invalid={editUrlTouched && editUrlError !== null}
                            />
                            {editUrlTouched && editUrlError ? (
                              <span className="field-error">{editUrlError}</span>
                            ) : null}
                          </label>
                          <label className="field">
                            <span>Icon</span>
                            <select
                              value={editForm.icon}
                              onChange={(e) => setEditForm({ ...editForm, icon: e.target.value })}
                            >
                              <option value="">(generic)</option>
                              {ICON_KEYS.map((key) => (
                                <option key={key} value={key}>
                                  {key}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field field--desc">
                            <span>Description</span>
                            <input
                              maxLength={280}
                              value={editForm.description}
                              onChange={(e) =>
                                setEditForm({ ...editForm, description: e.target.value })
                              }
                            />
                          </label>
                          <label className="check-row">
                            <input
                              type="checkbox"
                              checked={editForm.defaultVisible}
                              onChange={(e) =>
                                setEditForm({ ...editForm, defaultVisible: e.target.checked })
                              }
                            />
                            <span>Visible to everyone by default (R-12)</span>
                          </label>
                        </div>
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
                            onClick={cancelEdit}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={entry.id}>
                  <td data-label="Order">
                    <span className="reorder">
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Move ${entry.name} up`}
                        disabled={busy || editingElsewhere || i === 0}
                        onClick={() => move(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Move ${entry.name} down`}
                        disabled={busy || editingElsewhere || i === entries.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  </td>
                  <td data-label="App">
                    <span className="app-cell">
                      <AppIcon icon={entry.icon} width={18} height={18} />
                      <span>
                        {entry.name} <span className="muted">({entry.slug})</span>
                      </span>
                    </span>
                  </td>
                  <td data-label="URL" className="url-cell">
                    {entry.url}
                  </td>
                  <td data-label="Default">{entry.defaultVisible ? 'visible' : '—'}</td>
                  <td data-label="Actions">
                    <span className="row-actions">
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy || editingElsewhere}
                        onClick={() => startEdit(entry)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={busy || editingElsewhere}
                        onClick={() => {
                          if (window.confirm(`Delete ${entry.name}? Grants to it cascade away.`)) {
                            del.mutate({ id: entry.id });
                          }
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <Modal
        open={adding}
        title="Add entry"
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
            <span>Slug</span>
            <input
              required
              pattern="[a-z0-9-]+"
              maxLength={48}
              value={addForm.slug}
              onChange={(e) => setAddForm({ ...addForm, slug: e.target.value })}
            />
            <span className="field-hint">lowercase letters, digits, dashes — immutable</span>
          </label>
          <label className="field">
            <span>Name</span>
            <input
              required
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
          <label className="field">
            <span>URL</span>
            <input
              required
              type="url"
              inputMode="url"
              placeholder="https://app.haynesnetwork.com"
              value={addForm.url}
              onBlur={() => setAddUrlTouched(true)}
              onChange={(e) => setAddForm({ ...addForm, url: e.target.value })}
              aria-invalid={addUrlTouched && addUrlError !== null}
            />
            {addUrlTouched && addUrlError ? (
              <span className="field-error">{addUrlError}</span>
            ) : null}
          </label>
          <label className="field">
            <span>Icon</span>
            <select
              value={addForm.icon}
              onChange={(e) => setAddForm({ ...addForm, icon: e.target.value })}
            >
              <option value="">(generic)</option>
              {ICON_KEYS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={addForm.defaultVisible}
              onChange={(e) => setAddForm({ ...addForm, defaultVisible: e.target.checked })}
            />
            <span>Visible to everyone by default (R-12)</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={create.isPending}>
              Create entry
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
