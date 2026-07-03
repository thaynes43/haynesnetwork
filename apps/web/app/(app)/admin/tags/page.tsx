'use client';

// DESIGN-004 D-11 — /admin/tags: tags table + create/edit (name, description, bundle:
// app checklist + grants-family toggle). Apply/remove to users lives on the user
// detail page. Bundle edits use replace-whole-bundle semantics (DESIGN-003 D-06) and
// instantly change every tagged user's effective set (R-21).

import { useState, type FormEvent } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

interface TagForm {
  name: string;
  description: string;
  isFamily: boolean;
  appIds: string[];
}

const EMPTY_FORM: TagForm = { name: '', description: '', isFamily: false, appIds: [] };

export default function AdminTagsPage() {
  const utils = trpc.useUtils();
  const tags = trpc.tags.list.useQuery();
  const catalog = trpc.catalog.adminList.useQuery();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // null = create mode
  const [form, setForm] = useState<TagForm>(EMPTY_FORM);

  const common = {
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => setError(null),
    onSettled: () => utils.tags.list.invalidate(),
  };
  const create = trpc.tags.create.useMutation(common);
  const update = trpc.tags.update.useMutation(common);
  const del = trpc.tags.delete.useMutation(common);
  const busy = create.isPending || update.isPending || del.isPending;

  const adminTags = tags.data?.scope === 'admin' ? tags.data.tags : [];
  const entries = catalog.data ?? [];
  const appNameById = new Map(entries.map((e) => [e.id, e.name]));

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function startEdit(tag: (typeof adminTags)[number]) {
    setEditingId(tag.id);
    setForm({
      name: tag.name,
      description: tag.description ?? '',
      isFamily: tag.bundle.isFamily,
      appIds: [...tag.bundle.appIds],
    });
  }

  function toggleApp(appId: string, on: boolean) {
    setForm((f) => ({
      ...f,
      appIds: on ? [...f.appIds, appId] : f.appIds.filter((id) => id !== appId),
    }));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      bundle: { appIds: form.appIds, isFamily: form.isFamily },
    };
    if (editingId === null) {
      create.mutate(payload, { onSuccess: () => startCreate() });
    } else {
      update.mutate({ id: editingId, ...payload }, { onSuccess: () => startCreate() });
    }
  }

  if (tags.isLoading || catalog.isLoading) return <p className="muted">Loading tags…</p>;
  const loadError = tags.error ?? catalog.error;
  if (loadError) {
    return (
      <p className="alert" role="alert">
        Failed to load: {loadError.message}
      </p>
    );
  }

  return (
    <>
      <h1>Tags</h1>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {adminTags.length === 0 ? (
        <p className="muted">No tags yet — create the first one below.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Apps in bundle</th>
              <th>Family</th>
              <th>Tagged users</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {adminTags.map((tag) => (
              <tr key={tag.id}>
                <td data-label="Tag">
                  <strong>{tag.name}</strong>
                  {tag.description ? <span className="muted"> — {tag.description}</span> : null}
                </td>
                <td data-label="Apps in bundle">
                  {tag.bundle.appIds.length === 0 ? (
                    <span aria-hidden="true">—</span>
                  ) : (
                    <span className="chips">
                      {tag.bundle.appIds.map((appId) => (
                        <span key={appId} className="chip">
                          {appNameById.get(appId) ?? appId}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td data-label="Family">{tag.bundle.isFamily ? 'grants family' : '—'}</td>
                <td data-label="Tagged users">{tag.taggedUserCount}</td>
                <td data-label="Actions">
                  <span className="row-actions">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => startEdit(tag)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete tag ${tag.name}? Its ${tag.taggedUserCount} user application(s) and bundle grants go with it.`,
                          )
                        ) {
                          del.mutate({ id: tag.id });
                          if (editingId === tag.id) startCreate();
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
        <h2>{editingId === null ? 'Create tag' : 'Edit tag'}</h2>
        <form className="admin-form" onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input
              required
              maxLength={48}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <span className="field-hint">Tag names are visible to tagged members (D-12).</span>
          </label>
          <label className="field">
            <span>Description</span>
            <input
              maxLength={280}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.isFamily}
              onChange={(e) => setForm({ ...form, isFamily: e.target.checked })}
            />
            <span>Grants family designation (R-20)</span>
          </label>
          <fieldset className="field">
            <legend>App bundle</legend>
            {entries.length === 0 ? (
              <p className="muted">The catalog is empty — nothing to bundle.</p>
            ) : (
              <ul className="check-list">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={form.appIds.includes(entry.id)}
                        onChange={(e) => toggleApp(entry.id, e.target.checked)}
                      />
                      <span>{entry.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {editingId === null ? 'Create tag' : 'Save changes'}
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
