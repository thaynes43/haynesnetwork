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
import { TRASH_ACTION_LABELS, TRASH_ACTION_NAMES, type TrashActionName } from '@/lib/trash';
import {
  MESSAGE_ACTION_LABELS,
  MESSAGE_ACTION_NAMES,
  type MessageActionName,
} from '@/lib/bulletin';

interface RoleForm {
  name: string;
  description: string;
  appIds: string[];
  grantsAll: boolean;
  // ADR-017 / DESIGN-007 D-06 — the Plex libraries this role may self-add (role_library_grants).
  libraryIds: string[];
  // ADR-024 / DESIGN-007 D-13 — the servers this role all-grants (role_plex_server_all_grants):
  // every library on the server, including ones added later.
  allServerIds: string[];
  // ADR-023 C-03 — the fine-grained Trash action grants (a row per action; replace-set writer).
  trashActions: TrashActionName[];
  // ADR-026 C-04 — the fine-grained Bulletin message action grants (post / moderate).
  messageActions: MessageActionName[];
}

const EMPTY_FORM: RoleForm = {
  name: '',
  description: '',
  appIds: [],
  grantsAll: false,
  libraryIds: [],
  allServerIds: [],
  trashActions: [],
  messageActions: [],
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
  // ADR-023 C-03 / DESIGN-010 D-09 — a role's fine-grained Trash action grants (replace-set;
  // audited 'update_trash_actions' in-tx). Edited inside the inline row editor; errors surface
  // on the editor banner (setTrash rides the row submit, like setLibs).
  const setTrash = trpc.roles.setTrashActions.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSettled: invalidate,
  });
  // ADR-026 C-04 / DESIGN-012 D-04 — a role's fine-grained Bulletin message action grants
  // (replace-set; audited 'update_message_actions' in-tx). Same ride as setTrash.
  const setMessages = trpc.roles.setMessageActions.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSettled: invalidate,
  });
  const busy =
    create.isPending ||
    update.isPending ||
    del.isPending ||
    setLibs.isPending ||
    refresh.isPending ||
    setSection.isPending ||
    setTrash.isPending ||
    setMessages.isPending;

  const roleRows = roles.data ?? [];
  const entries = catalog.data ?? [];
  const appNameById = new Map(entries.map((e) => [e.id, e.name]));
  const libServers = libs.data?.servers ?? [];
  const grantsByRole = libs.data?.grantsByRole ?? {};
  const allGrantsByRole = libs.data?.allGrantsByRole ?? {};

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
      if (libs.data)
        await setLibs.mutateAsync({
          roleId,
          libraryIds: addForm.libraryIds,
          allServerIds: addForm.allServerIds,
        });
      // Trash action grants — only when any were checked (a fresh role has no rows).
      if (addForm.trashActions.length > 0)
        await setTrash.mutateAsync({ roleId, actions: addForm.trashActions });
      // Bulletin message action grants — same convention.
      if (addForm.messageActions.length > 0)
        await setMessages.mutateAsync({ roleId, actions: addForm.messageActions });
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
      allServerIds: [...(allGrantsByRole[role.id] ?? [])],
      trashActions: [...role.trashActions] as TrashActionName[],
      messageActions: [...role.messageActions] as MessageActionName[],
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
        await setLibs.mutateAsync({
          roleId: role.id,
          libraryIds: editForm.libraryIds,
          allServerIds: editForm.allServerIds,
        });
      // Replace-set Trash action grants (skip only when unchanged — the writer is idempotent
      // but a no-op write still audits, so avoid noise).
      const before = [...role.trashActions].sort().join(',');
      const after = [...editForm.trashActions].sort().join(',');
      if (before !== after)
        await setTrash.mutateAsync({ roleId: role.id, actions: editForm.trashActions });
      // Replace-set Bulletin message action grants (skip when unchanged — same audit-noise rule).
      const beforeMsg = [...role.messageActions].sort().join(',');
      const afterMsg = [...editForm.messageActions].sort().join(',');
      if (beforeMsg !== afterMsg)
        await setMessages.mutateAsync({ roleId: role.id, actions: editForm.messageActions });
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

  // ADR-024 — per-server all-libraries grant. The per-library selection is kept underneath
  // (implied-on while All is checked, restored when it's unchecked) — never wiped.
  const toggleAllServer = (form: RoleForm, serverId: string, on: boolean): RoleForm => ({
    ...form,
    allServerIds: on
      ? [...form.allServerIds, serverId]
      : form.allServerIds.filter((id) => id !== serverId),
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

  // ADR-023 C-03 / DESIGN-010 D-09 — the per-action Trash grant grid. Every action is opt-in
  // (section Edit implies NOTHING extra); viewing rides the coarse Trash level in the table
  // column. Destructive actions say so in their labels.
  // ADR-025 errata (2026-07-08) — global Save (`save_exclude`, "Save items, anytime") is a SUPERSET
  // of the windowed rescue (`save_leaving_soon`): when it's checked, the rescue row renders CHECKED +
  // DISABLED with an "included in Save" note. The implication is COMPUTED, never written — the stored
  // `save_leaving_soon` grant is untouched, so unchecking Save re-enables the row at its stored value.
  const trashChecklist = (form: RoleForm, apply: (next: (f: RoleForm) => RoleForm) => void) => {
    const hasSavePower = form.trashActions.includes('save_exclude');
    return (
      <fieldset className="field" data-testid="trash-actions-grid">
        <legend>Trash actions this role may use</legend>
        <p className="field-hint">
          Actions apply only while the role’s Trash access is Read-only or Edit. Every action is
          opt-in — the access level alone never grants any.
        </p>
        <ul className="check-list">
          {TRASH_ACTION_NAMES.map((action) => {
            const impliedBySave = action === 'save_leaving_soon' && hasSavePower;
            return (
              <li key={action}>
                <label className="check-row" data-disabled={impliedBySave || undefined}>
                  <input
                    type="checkbox"
                    data-testid={`trash-action-${action}`}
                    disabled={impliedBySave}
                    checked={impliedBySave || form.trashActions.includes(action)}
                    onChange={(e) =>
                      apply((f) => ({
                        ...f,
                        trashActions: e.target.checked
                          ? [...f.trashActions, action]
                          : f.trashActions.filter((a) => a !== action),
                      }))
                    }
                  />
                  <span>
                    {TRASH_ACTION_LABELS[action]}
                    {impliedBySave ? (
                      <span
                        className="muted"
                        data-testid="trash-action-save_leaving_soon-implied"
                        title="Holding “Save items — anytime” already grants the Leaving-Soon rescue."
                      >
                        {' '}
                        — included in Save
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    );
  };

  // ADR-026 C-04 / DESIGN-012 D-04 — the per-action Bulletin message grant grid. Reading the
  // Feed/board rides the coarse Bulletin level in the table column; post/moderate are opt-in.
  const bulletinChecklist = (form: RoleForm, apply: (next: (f: RoleForm) => RoleForm) => void) => (
    <fieldset className="field" data-testid="message-actions-grid">
      <legend>Bulletin message actions this role may use</legend>
      <p className="field-hint">
        Actions apply only while the role’s Bulletin access is Read-only or Edit. Reading the Feed
        and the board rides the access level alone; posting and moderating are opt-in.
      </p>
      <ul className="check-list">
        {MESSAGE_ACTION_NAMES.map((action) => (
          <li key={action}>
            <label className="check-row">
              <input
                type="checkbox"
                data-testid={`message-action-${action}`}
                checked={form.messageActions.includes(action)}
                onChange={(e) =>
                  apply((f) => ({
                    ...f,
                    messageActions: e.target.checked
                      ? [...f.messageActions, action]
                      : f.messageActions.filter((a) => a !== action),
                  }))
                }
              />
              <span>{MESSAGE_ACTION_LABELS[action]}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );

  // ADR-017 / DESIGN-007 D-06 — the Plex library grant matrix, grouped per server. Unlike the
  // app matrix there is no cross-server master toggle (grants_all does not imply libraries —
  // D-08), but each server group carries a PER-SERVER "All libraries" checkbox (ADR-024 /
  // D-13, role_plex_server_all_grants): every library on that server, including future ones.
  // While it's checked the server's per-library boxes read implied-on and disabled (same
  // treatment as the "All apps" toggle) — their underlying selection is kept, not wiped, so
  // unchecking All restores the explicit set. Unavailable libraries stay checkable so a
  // soft-removed library's grant round-trips.
  const libraryChecklist = (form: RoleForm, apply: (next: (f: RoleForm) => RoleForm) => void) => (
    <fieldset className="field">
      <legend>Plex libraries this role can self-add</legend>
      {libs.isLoading ? (
        <p className="muted">Loading libraries…</p>
      ) : libServers.length === 0 ? (
        <p className="muted">No libraries yet — run a registry refresh to populate them.</p>
      ) : (
        libServers.map((server) => {
          const allOn = form.allServerIds.includes(server.id);
          return (
            <div className="lib-group" key={server.slug}>
              <p className="lib-group__name">{server.name}</p>
              <label className="check-row">
                <input
                  type="checkbox"
                  data-testid={`lib-all-${server.slug}`}
                  checked={allOn}
                  onChange={(e) => apply((f) => toggleAllServer(f, server.id, e.target.checked))}
                />
                <span>
                  <strong>All libraries</strong>
                  <span className="muted">
                    {' '}
                    — everything on {server.name}, including libraries added later
                  </span>
                </span>
              </label>
              <ul className="check-list">
                {server.libraries.map((lib) => (
                  <li key={lib.id}>
                    <label
                      className="check-row"
                      data-disabled={allOn || !lib.available || undefined}
                    >
                      <input
                        type="checkbox"
                        disabled={allOn}
                        checked={allOn || form.libraryIds.includes(lib.id)}
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
          );
        })
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

      <table className="admin-table admin-table--roles">
        <thead>
          <tr>
            <th>Role</th>
            <th>Apps</th>
            <th>Members</th>
            <th>Ledger</th>
            <th>Trash</th>
            <th>Bulletin</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {roleRows.map((role) => {
            if (editingId === role.id) {
              return (
                <tr key={role.id} className="row-edit">
                  <td colSpan={7}>
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
                      {trashChecklist(editForm, setEditForm)}
                      {bulletinChecklist(editForm, setEditForm)}
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
                {/* ADR-023 / DESIGN-010 D-09 — the Trash access level + a grant summary. The
                    per-action grid itself lives in the row editor (Edit); the summary keeps the
                    row constant-width (ADR-015 — changing grants recounts, never reflows). */}
                <td data-label="Trash">
                  {role.isAdmin ? (
                    <span
                      className="muted"
                      title="The Admin role implies Edit on every section and every Trash action"
                    >
                      Edit · all actions
                    </span>
                  ) : (
                    <span className="trash-cell">
                      <select
                        className="section-select"
                        aria-label={`Trash access for ${role.name}`}
                        value={role.sectionPermissions.trash}
                        disabled={busy || editingElsewhere}
                        onChange={(e) =>
                          setSection.mutate({
                            roleId: role.id,
                            sectionId: 'trash',
                            level: e.target.value as 'edit' | 'read_only' | 'disabled',
                          })
                        }
                      >
                        <option value="edit">Edit</option>
                        <option value="read_only">Read-only</option>
                        <option value="disabled">Disabled</option>
                      </select>
                      <span
                        className="action-badge"
                        data-testid={`trash-actions-summary-${role.name}`}
                        title={
                          role.trashActions.length > 0
                            ? role.trashActions
                                .map((a) => TRASH_ACTION_LABELS[a as TrashActionName] ?? a)
                                .join(' · ')
                            : 'No Trash actions granted — this role can only browse'
                        }
                      >
                        {role.trashActions.length}{' '}
                        {role.trashActions.length === 1 ? 'action' : 'actions'}
                      </span>
                    </span>
                  )}
                </td>
                {/* ADR-026 / DESIGN-012 D-04 — the Bulletin access level + a grant summary
                    (same treatment as Trash: the per-action grid lives in the row editor). */}
                <td data-label="Bulletin">
                  {role.isAdmin ? (
                    <span
                      className="muted"
                      title="The Admin role implies Edit on every section and every message action"
                    >
                      Edit · all actions
                    </span>
                  ) : (
                    <span className="trash-cell">
                      <select
                        className="section-select"
                        aria-label={`Bulletin access for ${role.name}`}
                        value={role.sectionPermissions.bulletin}
                        disabled={busy || editingElsewhere}
                        onChange={(e) =>
                          setSection.mutate({
                            roleId: role.id,
                            sectionId: 'bulletin',
                            level: e.target.value as 'edit' | 'read_only' | 'disabled',
                          })
                        }
                      >
                        <option value="edit">Edit</option>
                        <option value="read_only">Read-only</option>
                        <option value="disabled">Disabled</option>
                      </select>
                      <span
                        className="action-badge"
                        data-testid={`message-actions-summary-${role.name}`}
                        title={
                          role.messageActions.length > 0
                            ? role.messageActions
                                .map((a) => MESSAGE_ACTION_LABELS[a as MessageActionName] ?? a)
                                .join(' · ')
                            : 'No message actions granted — this role can only read'
                        }
                      >
                        {role.messageActions.length}{' '}
                        {role.messageActions.length === 1 ? 'action' : 'actions'}
                      </span>
                    </span>
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
          {trashChecklist(addForm, setAddForm)}
          {bulletinChecklist(addForm, setAddForm)}
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
