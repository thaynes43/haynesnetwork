'use client';

// DESIGN-004 D-11 — /admin/catalog: entries table (cards <760px via data-label).
// Add opens a Modal with the create form; Edit expands the row IN PLACE into an inline
// editor (no shared bottom form). URL is a free-form http(s) field validated live
// (server stays authoritative — appCode errors surfaced), icon picker from
// ICON_KEYS, drag-and-drop + keyboard (arrow-keys on the grip) reorder → catalog.reorder
// with the complete id set (D-06); optimistic so the drop feels instant (ADR-015).

import { useState, type FormEvent } from 'react';
import { ICON_KEYS, AppIcon, isIconKey, ConfirmButton, useReorderDnD } from '@hnet/ui';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { catalogUrlError, normalizeCatalogUrl } from '@/lib/catalog-url';

interface FormState {
  slug: string;
  name: string;
  description: string;
  icon: string; // '' = none (null on the wire)
  // Free-form URL: any http(s) URL; bare hosts get https:// (BRANCH-A — no host rules).
  url: string;
}

const EMPTY_FORM: FormState = {
  slug: '',
  name: '',
  description: '',
  icon: '',
  url: '',
};

// Slugs are auto-formatted as the user types (lowercase, spaces → dashes, other chars dropped)
// so a "Test" or "My App" never trips a vague format error — it just becomes test / my-app.
function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export default function AdminCatalogPage() {
  const utils = trpc.useUtils();
  const catalog = trpc.catalog.adminList.useQuery();

  // Three independent error surfaces so a modal/inline/row error never bleeds across:
  const [error, setError] = useState<string | null>(null); // top-level (delete/reorder)
  const [reorderMsg, setReorderMsg] = useState(''); // aria-live announce for keyboard moves
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
    // Optimistic: apply the new order to the cache immediately so the drop never snaps back.
    onMutate: async ({ orderedIds }) => {
      await utils.catalog.adminList.cancel();
      const prev = utils.catalog.adminList.getData();
      utils.catalog.adminList.setData(undefined, (old) => {
        if (!old) return old;
        const byId = new Map(old.map((e) => [e.id, e]));
        const next = orderedIds.map((id) => byId.get(id)).filter((e): e is (typeof old)[number] => Boolean(e));
        // Append any not named in orderedIds (defensive; server has the full set).
        for (const e of old) if (!orderedIds.includes(e.id)) next.push(e);
        return next;
      });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) utils.catalog.adminList.setData(undefined, ctx.prev);
      setError(describeMutationError(err));
    },
    onSuccess: () => setError(null),
    onSettled: invalidate,
  });
  // Table controls (reorder/delete) lock during any write so the id set can't race.
  const busy = create.isPending || update.isPending || del.isPending || reorder.isPending;
  // Reorder stays interactive during its OWN optimistic mutation — otherwise disabling the
  // focused grip mid-move blurs it and breaks keyboard chaining. Only a different write or an
  // open inline editor locks dragging/keyboard reorder.
  const dragLocked = create.isPending || update.isPending || del.isPending || editingId !== null;

  const entries = catalog.data ?? [];
  const addUrlError = catalogUrlError(addForm.url);
  const editUrlError = catalogUrlError(editForm.url);
  const addUrlNorm = normalizeCatalogUrl(addForm.url);
  const editUrlNorm = normalizeCatalogUrl(editForm.url);

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
      url: addUrlNorm.ok ? addUrlNorm.url : addForm.url,
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
      url: editUrlNorm.ok ? editUrlNorm.url : editForm.url,
    });
  }

  // Commit the FULL spliced order (D-06): move fromId to toIndex, then send every id.
  function commitReorder(fromId: string, toIndex: number) {
    const ids = entries.map((en) => en.id);
    const from = ids.indexOf(fromId);
    if (from < 0) return;
    const next = ids.slice();
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    const clamped = Math.max(0, Math.min(toIndex, next.length));
    next.splice(clamped, 0, moved);
    const name = entries[from]?.name ?? fromId;
    setReorderMsg(`Moved ${name} to position ${clamped + 1} of ${entries.length}`);
    reorder.mutate({ orderedIds: next });
  }

  const dnd = useReorderDnD({
    ids: entries.map((e) => e.id),
    onReorder: commitReorder,
    disabled: dragLocked,
  });

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
      <p className="sr-only" role="status" aria-live="polite">
        {reorderMsg}
      </p>

      {entries.length === 0 ? (
        <p className="muted">No catalog entries yet — use “Add entry” to create the first one.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>App</th>
              <th>URL</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody {...dnd.containerProps}>
            {entries.map((entry, i) => {
              const editingThis = editingId === entry.id;
              const editingElsewhere = editingId !== null && !editingThis;
              if (editingThis) {
                return (
                  <tr key={entry.id} className="row-edit">
                    <td colSpan={4}>
                      <form className="admin-form row-edit-form" onSubmit={(e) => submitEdit(entry.id, e)}>
                        <p className="muted row-edit__slug">
                          Editing <strong>{entry.slug}</strong> — slug is immutable.
                        </p>
                        <div className="row-edit__grid">
                          <label className="field">
                            <span>
                              Name <span className="req" aria-hidden="true">*</span>
                            </span>
                            <input
                              required
                              aria-label="Name"
                              maxLength={64}
                              value={editForm.name}
                              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                            />
                          </label>
                          <label className="field field--url">
                            <span>
                              URL <span className="req" aria-hidden="true">*</span>
                            </span>
                            <input
                              required
                              aria-label="URL"
                              placeholder="example.com"
                              value={editForm.url}
                              onBlur={() => setEditUrlTouched(true)}
                              onChange={(e) => setEditForm({ ...editForm, url: e.target.value })}
                              aria-invalid={editUrlTouched && editUrlError !== null}
                            />
                            {editUrlTouched && editUrlError ? (
                              <span className="field-error">{editUrlError}</span>
                            ) : editUrlNorm.ok ? (
                              <span className="field-hint">→ {editUrlNorm.url}</span>
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
                <tr
                  key={entry.id}
                  {...dnd.rowProps(entry.id, i)}
                  className={
                    [
                      dnd.isDragging(entry.id) && 'dragging',
                      dnd.showBefore(i) && 'drop-before',
                      dnd.showAtEnd() && i === entries.length - 1 && 'drop-after',
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                >
                  <td data-label="Order">
                    <button
                      type="button"
                      className="drag-handle"
                      disabled={dragLocked}
                      aria-label={`Reorder ${entry.name} — drag, or focus and use arrow keys`}
                      {...dnd.handleProps(entry.id, i)}
                    >
                      ⠿
                    </button>
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
                      <ConfirmButton
                        className="btn sm danger"
                        data-testid="catalog-row-delete"
                        disabled={busy || editingElsewhere}
                        label="Delete"
                        restingAriaLabel={`Delete ${entry.name} — grants to it cascade away — click twice to confirm`}
                        confirmAriaLabel={`Confirm delete ${entry.name}`}
                        onConfirm={() => del.mutate({ id: entry.id })}
                      />
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
            <span>
              Slug <span className="req" aria-hidden="true">*</span>
            </span>
            <input
              required
              aria-label="Slug"
              maxLength={48}
              value={addForm.slug}
              onChange={(e) => setAddForm({ ...addForm, slug: toSlug(e.target.value) })}
            />
            <span className="field-hint">auto-lowercased; immutable after create</span>
          </label>
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
          <label className="field">
            <span>
              URL <span className="req" aria-hidden="true">*</span>
            </span>
            <input
              required
              aria-label="URL"
              placeholder="example.com"
              value={addForm.url}
              onBlur={() => setAddUrlTouched(true)}
              onChange={(e) => setAddForm({ ...addForm, url: e.target.value })}
              aria-invalid={addUrlTouched && addUrlError !== null}
            />
            {addUrlTouched && addUrlError ? (
              <span className="field-error">{addUrlError}</span>
            ) : addUrlNorm.ok ? (
              <span className="field-hint">→ {addUrlNorm.url}</span>
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
