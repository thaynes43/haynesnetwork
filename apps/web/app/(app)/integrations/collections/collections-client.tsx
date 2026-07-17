'use client';

// ADR-069 / DESIGN-042 (PLAN-052 — collection manager) — the manager sub-section. Reads Libretto LIVE via
// the confined tRPC surface (collections.overview) and degrades honestly when Libretto is unreachable
// (D-01/C-09). Recipe rows carry the builder badge, target, produced-count, the acquisition ON/OFF puck
// (recolor-not-reflow, ADR-015), and the run verdict; the composer is a Modal with a ref PREVIEW (validate)
// before save (C-07); apply/delete are ConfirmButtons (delete warns about the orphaned collection, C-08).
// The acquisition toggle shows only for acquire-granted callers. A manage admin reviews member suggestions
// here. Owner tone: no em-dashes, plain friendly labels; all color via tokens (no raw hex — hard rule 2).
import { useState } from 'react';
import Link from 'next/link';
import { ConfirmButton } from '@hnet/ui';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

const BUILDER_LABELS: Record<string, string> = {
  static_ids: 'ID list',
  hardcover_series: 'Hardcover series',
  nyt_list: 'NYT list',
  wikidata_award: 'Award',
};

const BUILDER_OPTIONS = [
  { value: 'hardcover_series', label: 'Hardcover series' },
  { value: 'nyt_list', label: 'NYT list' },
  { value: 'wikidata_award', label: 'Award (Wikidata)' },
  { value: 'static_ids', label: 'ID list' },
] as const;

type RecipeDraft = {
  id: string;
  name: string;
  builderType: 'static_ids' | 'hardcover_series' | 'nyt_list' | 'wikidata_award';
  builderRef: string;
  targetLibrary: string;
  ordered: boolean;
  syncMode: 'append' | 'sync';
  acquisitionEnabled: boolean;
};

const EMPTY_DRAFT: RecipeDraft = {
  id: '',
  name: '',
  builderType: 'hardcover_series',
  builderRef: '',
  targetLibrary: '',
  ordered: true,
  syncMode: 'sync',
  acquisitionEnabled: false,
};

export function CollectionsClient() {
  const utils = trpc.useUtils();
  const overviewQ = trpc.collections.overview.useQuery(undefined, { retry: false });

  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<RecipeDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);

  if (overviewQ.isPending) {
    return (
      <div className="collections-page">
        <ManagerHead />
        <section className="card">
          <p className="muted">Loading collections…</p>
        </section>
      </div>
    );
  }

  if (overviewQ.error) {
    // FORBIDDEN (no manage grant) or another error — honest, no controls.
    const forbidden = overviewQ.error.data?.code === 'FORBIDDEN';
    return (
      <div className="collections-page">
        <ManagerHead />
        <section className="card empty-state">
          <p>{forbidden ? 'Managing collections isn’t available on your account.' : 'Could not load collections.'}</p>
          <p className="muted">
            {forbidden
              ? 'Your role can browse collections on the Books walls. Ask an admin if you should be able to manage them.'
              : describeMutationError(overviewQ.error)}
          </p>
        </section>
      </div>
    );
  }

  const data = overviewQ.data;
  const canAcquire = data.canAcquire;
  const collectionByRecipe = new Map(
    data.collections.filter((c) => c.recipeId).map((c) => [c.recipeId as string, c]),
  );

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setEditing(false);
    setComposerOpen(true);
  }
  function openEdit(recipe: (typeof data.recipes)[number]) {
    setDraft({
      id: recipe.id,
      name: recipe.name ?? '',
      builderType: (recipe.builderType as RecipeDraft['builderType']) ?? 'hardcover_series',
      builderRef: recipe.builderRef ?? '',
      targetLibrary: '',
      ordered: recipe.ordered ?? true,
      syncMode: (recipe.syncMode as RecipeDraft['syncMode']) ?? 'sync',
      acquisitionEnabled: recipe.acquisitionEnabled ?? false,
    });
    setEditing(true);
    setComposerOpen(true);
  }

  return (
    <div className="collections-page">
      <ManagerHead />

      {!data.reachable ? (
        <section className="card empty-state" data-testid="collections-unreachable">
          <p>Libretto is unreachable right now.</p>
          <p className="muted">
            The collections manager talks to Libretto to read and build collections. Your existing
            collections on the Books walls are unaffected. Try again in a bit.
          </p>
        </section>
      ) : (
        <>
          <div className="collections-toolbar">
            <p className="muted">
              These are the recipes Libretto runs to build your book collections. Run history keeps only the
              most recent runs.
            </p>
            <button type="button" className="btn primary" onClick={openCreate} data-testid="collections-new">
              New recipe
            </button>
          </div>

          {data.issues.length > 0 ? (
            <section className="card collections-attention" data-testid="collections-issues">
              <h2 className="collections-attention__title">Needs attention</h2>
              <ul className="collections-attention__list">
                {data.issues.map((iss, i) => (
                  <li key={i}>
                    <span className="badge badge--warn">recipe</span> {iss.recipeId ? `${iss.recipeId}: ` : ''}
                    {iss.message ?? 'invalid recipe'}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {data.recipes.length === 0 ? (
            <section className="card empty-state">
              <p className="muted">No recipes yet. Create one to start building a collection.</p>
            </section>
          ) : (
            <ul className="collections-list" data-testid="collections-list">
              {data.recipes.map((recipe) => {
                const produced = collectionByRecipe.get(recipe.id);
                const acqOn = recipe.acquisitionEnabled ?? false;
                return (
                  <li key={recipe.id} className="collection-row" data-testid="collection-row">
                    <div className="collection-row__main">
                      <span className="collection-row__title">{recipe.name ?? recipe.id}</span>
                      <span className="collection-row__meta">
                        <span className="badge badge--info">
                          {BUILDER_LABELS[recipe.builderType ?? ''] ?? recipe.builderType ?? 'recipe'}
                        </span>
                        {recipe.builderRef ? <span className="muted">{recipe.builderRef}</span> : null}
                        {produced ? (
                          <span className="muted">{produced.itemCount ?? 0} in collection</span>
                        ) : (
                          <span className="muted">not built yet</span>
                        )}
                      </span>
                    </div>
                    <div className="collection-row__actions">
                      {/* The acquisition puck reserves its slot; ON/OFF recolors, never reflows. */}
                      <span
                        className={`acq-puck ${acqOn ? 'acq-puck--on' : 'acq-puck--off'}`}
                        data-testid="acq-puck"
                        title={acqOn ? 'Acquisition on: pulls missing books' : 'Acquisition off'}
                      >
                        {acqOn ? 'Pulls content' : 'No pull'}
                      </span>
                      <ApplyButton recipeId={recipe.id} onDone={() => void utils.collections.overview.invalidate()} />
                      <button type="button" className="btn sm" onClick={() => openEdit(recipe)}>
                        Edit
                      </button>
                      <DeleteControl recipeId={recipe.id} onDone={() => void utils.collections.overview.invalidate()} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {data.pendingSuggestions.length > 0 ? (
            <section className="card collections-suggestions" data-testid="collections-suggestion-queue">
              <h2 className="collections-attention__title">Member suggestions</h2>
              <ul className="collections-suggestions__list">
                {data.pendingSuggestions.map((s) => (
                  <SuggestionReviewRow
                    key={s.id}
                    suggestion={s}
                    canAcquire={canAcquire}
                    onDone={() => void utils.collections.overview.invalidate()}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <ComposerModal
        open={composerOpen}
        draft={draft}
        setDraft={setDraft}
        editing={editing}
        canAcquire={canAcquire}
        onClose={() => setComposerOpen(false)}
        onSaved={() => {
          setComposerOpen(false);
          void utils.collections.overview.invalidate();
        }}
      />
    </div>
  );
}

function ManagerHead() {
  return (
    <div className="gr-head">
      <Link className="btn sm" href="/integrations">
        ‹ Integrations
      </Link>
      <h1 className="page-title">Collections</h1>
    </div>
  );
}

function ApplyButton({ recipeId, onDone }: { recipeId: string; onDone: () => void }) {
  const [runId, setRunId] = useState<string | null>(null);
  const apply = trpc.collections.applyRecipe.useMutation({
    onSuccess: (res) => {
      setRunId(res.runId);
      onDone();
    },
  });
  // Poll the run once it exists (bounded — the manager is not a hot surface).
  const runQ = trpc.collections.run.useQuery(
    { runId: runId ?? '' },
    { enabled: runId !== null, refetchInterval: (q) => (q.state.data?.status === 'running' ? 2500 : false) },
  );
  const counts = runQ.data?.counts;
  return (
    <span className="collection-row__apply">
      <ConfirmButton
        className="btn sm"
        label="Run now"
        confirmLabel="Run it?"
        restingAriaLabel="Run this recipe now — click twice to confirm"
        confirmAriaLabel="Confirm running this recipe now"
        onConfirm={() => apply.mutate({ scope: recipeId })}
      />
      {counts ? (
        <span className="muted collection-row__runcounts" data-testid="collection-runcounts">
          {counts.matched ?? 0} matched · {counts.missing ?? 0} missing
          {counts.acquired ? ` · ${counts.acquired} pulled` : ''}
        </span>
      ) : null}
    </span>
  );
}

function DeleteControl({ recipeId, onDone }: { recipeId: string; onDone: () => void }) {
  const [also, setAlso] = useState(false);
  const remove = trpc.collections.remove.useMutation({ onSuccess: onDone });
  return (
    <span className="collection-row__delete">
      <label className="collection-row__alsodelete" title="Also delete the built collection in the library">
        <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} /> also delete
      </label>
      <ConfirmButton
        className="btn sm danger"
        label="Delete"
        confirmLabel={also ? 'Delete both?' : 'Delete recipe?'}
        restingAriaLabel="Delete this recipe — click twice to confirm"
        confirmAriaLabel="Confirm deleting this recipe"
        onConfirm={() => remove.mutate({ id: recipeId, deleteCollection: also })}
      />
    </span>
  );
}

function SuggestionReviewRow({
  suggestion,
  canAcquire,
  onDone,
}: {
  suggestion: { id: string; name: string; builderType: string; builderRef: string; note: string | null };
  canAcquire: boolean;
  onDone: () => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [acq, setAcq] = useState(false);
  const review = trpc.collections.reviewSuggestion.useMutation({ onSuccess: onDone });
  return (
    <li className="suggestion-row" data-testid="suggestion-row">
      <div className="suggestion-row__main">
        <span className="collection-row__title">{suggestion.name}</span>
        <span className="collection-row__meta">
          <span className="badge badge--info">{BUILDER_LABELS[suggestion.builderType] ?? suggestion.builderType}</span>
          <span className="muted">{suggestion.builderRef}</span>
        </span>
        {suggestion.note ? <p className="muted suggestion-row__note">{suggestion.note}</p> : null}
      </div>
      {declining ? (
        <div className="suggestion-row__decline">
          <input
            type="text"
            className="library-search"
            placeholder="Reason (the member sees this)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="btn sm danger"
            disabled={reason.trim().length === 0}
            onClick={() => review.mutate({ decision: 'decline', suggestionId: suggestion.id, reason: reason.trim() })}
          >
            Decline
          </button>
          <button type="button" className="btn sm" onClick={() => setDeclining(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="suggestion-row__actions">
          {canAcquire ? (
            <label className="collection-row__alsodelete" title="Enable pulling missing books for this recipe">
              <input type="checkbox" checked={acq} onChange={(e) => setAcq(e.target.checked)} /> pull content
            </label>
          ) : null}
          <ConfirmButton
            className="btn sm primary"
            label="Approve"
            confirmLabel="Create it?"
            restingAriaLabel="Approve this suggestion and create the recipe — click twice to confirm"
            confirmAriaLabel="Confirm approving this suggestion"
            onConfirm={() =>
              review.mutate({ decision: 'approve', suggestionId: suggestion.id, enableAcquisition: canAcquire && acq })
            }
          />
          <button type="button" className="btn sm" onClick={() => setDeclining(true)}>
            Decline
          </button>
        </div>
      )}
    </li>
  );
}

function ComposerModal({
  open,
  draft,
  setDraft,
  editing,
  canAcquire,
  onClose,
  onSaved,
}: {
  open: boolean;
  draft: RecipeDraft;
  setDraft: (d: RecipeDraft) => void;
  editing: boolean;
  canAcquire: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name?: string | null; workCount?: number | null; issues: string[] } | null>(
    null,
  );
  const validate = trpc.collections.validate.useMutation({
    onError: (e) => setError(describeMutationError(e)),
    onSuccess: (res) => {
      setError(null);
      setPreview({
        name: res.resolved?.name ?? null,
        workCount: res.resolved?.workCount ?? null,
        issues: res.issues,
      });
    },
  });
  const save = trpc.collections.save.useMutation({
    onError: (e) => setError(describeMutationError(e)),
    onSuccess: onSaved,
  });

  const payload = {
    id: draft.id.trim(),
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    builderType: draft.builderType,
    builderRef: draft.builderRef.trim(),
    ...(draft.targetLibrary.trim() ? { targetLibrary: draft.targetLibrary.trim() } : {}),
    ordered: draft.ordered,
    syncMode: draft.syncMode,
    acquisitionEnabled: draft.acquisitionEnabled,
  };
  const canSubmit = payload.id.length > 0 && payload.builderRef.length > 0;

  return (
    <Modal open={open} title={editing ? 'Edit recipe' : 'New recipe'} onClose={onClose} banner={error ? <p className="alert" role="alert">{error}</p> : null}>
      <form
        className="composer-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) save.mutate(payload);
        }}
      >
        <label className="composer-field">
          <span>Recipe id</span>
          <input
            className="library-search"
            value={draft.id}
            disabled={editing}
            placeholder="stormlight-archive"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
        </label>
        <label className="composer-field">
          <span>Name</span>
          <input
            className="library-search"
            value={draft.name}
            placeholder="The Stormlight Archive"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="composer-field">
          <span>Builder</span>
          <select
            className="library-search"
            value={draft.builderType}
            onChange={(e) => setDraft({ ...draft, builderType: e.target.value as RecipeDraft['builderType'] })}
          >
            {BUILDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="composer-field">
          <span>Reference</span>
          <input
            className="library-search"
            value={draft.builderRef}
            placeholder="the-stormlight-archive"
            onChange={(e) => setDraft({ ...draft, builderRef: e.target.value })}
          />
        </label>
        <label className="composer-field">
          <span>Target library</span>
          <input
            className="library-search"
            value={draft.targetLibrary}
            placeholder="optional (a Libretto target)"
            onChange={(e) => setDraft({ ...draft, targetLibrary: e.target.value })}
          />
        </label>
        <div className="composer-row">
          <label className="composer-inline">
            <input
              type="checkbox"
              checked={draft.ordered}
              onChange={(e) => setDraft({ ...draft, ordered: e.target.checked })}
            />
            Keep reading order
          </label>
          <label className="composer-inline">
            Sync
            <select
              className="library-search composer-sync"
              value={draft.syncMode}
              onChange={(e) => setDraft({ ...draft, syncMode: e.target.value as RecipeDraft['syncMode'] })}
            >
              <option value="sync">replace to match</option>
              <option value="append">add only</option>
            </select>
          </label>
        </div>

        {/* The acquisition knob — only for acquire-granted roles (ADR-069 C-04). */}
        <label className={`composer-inline composer-acq ${canAcquire ? '' : 'composer-acq--locked'}`}>
          <input
            type="checkbox"
            checked={draft.acquisitionEnabled}
            disabled={!canAcquire}
            onChange={(e) => setDraft({ ...draft, acquisitionEnabled: e.target.checked })}
          />
          Pull missing books into the library
          {!canAcquire ? <span className="muted"> (needs the acquire grant)</span> : null}
        </label>
        {draft.acquisitionEnabled ? (
          <p className="composer-warn">
            This makes the estate acquire the books this list wants but you don’t have yet, a few at a time.
          </p>
        ) : null}

        {preview ? (
          <div className="composer-preview" data-testid="composer-preview">
            {preview.name ? (
              <p>
                Resolved to <strong>{preview.name}</strong>
                {preview.workCount != null ? ` — ${preview.workCount} works` : ''}
                {preview.workCount === 0 ? ' (this reference has no works, check it)' : ''}
              </p>
            ) : (
              <p className="muted">Could not resolve this reference. Check it before saving.</p>
            )}
            {preview.issues.length > 0 ? (
              <ul className="composer-preview__issues">
                {preview.issues.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="composer-actions">
          <button
            type="button"
            className="btn sm"
            disabled={!canSubmit || validate.isPending}
            onClick={() => validate.mutate(payload)}
          >
            {validate.isPending ? 'Checking…' : 'Preview'}
          </button>
          <button type="submit" className="btn sm primary" disabled={!canSubmit || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
