'use client';

// DESIGN-004 D-11 — /admin/catalog: entries table (cards <760px via data-label),
// create/edit form (URL validated live against R-14, server stays authoritative —
// appCode errors surfaced), defaultVisible toggle, icon picker from ICON_KEYS,
// up/down-button reorder → catalog.reorder with the complete id set (DESIGN-003 D-06).

import { useState, type FormEvent } from 'react';
import { ICON_KEYS, AppIcon, isIconKey } from '@hnet/ui';
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
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // null = create mode
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [urlTouched, setUrlTouched] = useState(false);

  const common = {
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: () =>
      Promise.all([utils.catalog.adminList.invalidate(), utils.catalog.myApps.invalidate()]),
  };
  const create = trpc.catalog.create.useMutation(common);
  const update = trpc.catalog.update.useMutation(common);
  const del = trpc.catalog.delete.useMutation(common);
  const reorder = trpc.catalog.reorder.useMutation(common);
  const busy = create.isPending || update.isPending || del.isPending || reorder.isPending;

  const entries = catalog.data ?? [];
  const urlError = catalogUrlError(form.url);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setUrlTouched(false);
  }

  function startEdit(entry: (typeof entries)[number]) {
    setEditingId(entry.id);
    setForm({
      slug: entry.slug,
      name: entry.name,
      description: entry.description ?? '',
      icon: entry.icon ?? '',
      url: entry.url,
      defaultVisible: entry.defaultVisible,
    });
    setUrlTouched(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setUrlTouched(true);
    if (urlError) return; // live client check; the server re-validates regardless
    const icon = isIconKey(form.icon) ? form.icon : null;
    const shared = {
      name: form.name.trim(),
      description: form.description.trim(),
      icon,
      url: form.url.trim(),
      defaultVisible: form.defaultVisible,
    };
    if (editingId === null) {
      create.mutate(
        { ...shared, slug: form.slug.trim() },
        { onSuccess: () => startCreate() },
      );
    } else {
      update.mutate({ id: editingId, ...shared }, { onSuccess: () => startCreate() });
    }
  }

  function move(index: number, delta: -1 | 1) {
    const ids = entries.map((e) => e.id);
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
      <h1>Catalog</h1>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="muted">No catalog entries yet — add the first one below.</p>
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
            {entries.map((entry, i) => (
              <tr key={entry.id}>
                <td data-label="Order">
                  <span className="reorder">
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Move ${entry.name} up`}
                      disabled={busy || i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Move ${entry.name} down`}
                      disabled={busy || i === entries.length - 1}
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
                      disabled={busy}
                      onClick={() => startEdit(entry)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete ${entry.name}? Grants to it cascade away.`)) {
                          del.mutate({ id: entry.id });
                          if (editingId === entry.id) startCreate();
                        }
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="card admin-section">
        <h2>{editingId === null ? 'Add entry' : 'Edit entry'}</h2>
        <form className="admin-form" onSubmit={submit}>
          {editingId === null ? (
            <label className="field">
              <span>Slug</span>
              <input
                required
                pattern="[a-z0-9-]+"
                maxLength={48}
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
              />
              <span className="field-hint">lowercase letters, digits, dashes — immutable</span>
            </label>
          ) : (
            <p className="muted">
              Slug <strong>{form.slug}</strong> is immutable.
            </p>
          )}
          <label className="field">
            <span>Name</span>
            <input
              required
              maxLength={64}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              maxLength={280}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label className="field">
            <span>URL</span>
            <input
              required
              type="url"
              inputMode="url"
              placeholder="https://app.haynesnetwork.com"
              value={form.url}
              onBlur={() => setUrlTouched(true)}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              aria-invalid={urlTouched && urlError !== null}
            />
            {urlTouched && urlError ? <span className="field-error">{urlError}</span> : null}
          </label>
          <label className="field">
            <span>Icon</span>
            <select value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })}>
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
              checked={form.defaultVisible}
              onChange={(e) => setForm({ ...form, defaultVisible: e.target.checked })}
            />
            <span>Visible to everyone by default (R-12)</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {editingId === null ? 'Create entry' : 'Save changes'}
            </button>
            {editingId !== null ? (
              <button type="button" className="btn" disabled={busy} onClick={startCreate}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </>
  );
}
