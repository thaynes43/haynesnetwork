'use client';

// ADR-070 / DESIGN-043 D-05 (PLAN-052 — the member contribution flow) — the "Suggest a collection"
// affordance on the Books/Audiobooks collections walls. Non-invasive: a small trailing card AFTER the
// collections grid (no reflow of existing cards — ADR-015). Shown ONLY to members with the `suggest` grant
// (mySuggestions FORBIDs everyone else — a FORBIDDEN quietly hides the whole affordance). Opening it is a
// Modal (name + builder + ref + note) that files a PENDING suggestion; the affordance then shows the
// member their suggestion's state. Owner tone: no em-dashes, plain friendly labels.
import { useState } from 'react';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

const BUILDER_OPTIONS = [
  { value: 'hardcover_series', label: 'A book series' },
  { value: 'nyt_list', label: 'A NYT list' },
  { value: 'wikidata_award', label: 'An award' },
  { value: 'static_ids', label: 'A list of books' },
] as const;

const STATE_LABEL: Record<string, string> = {
  pending: 'Suggested, pending review',
  approved: 'Approved',
  declined: 'Declined',
};

export function SuggestCollectionAffordance({ mediaKind }: { mediaKind: 'book' | 'audiobook' | 'comic' }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [builderType, setBuilderType] = useState<(typeof BUILDER_OPTIONS)[number]['value']>('hardcover_series');
  const [builderRef, setBuilderRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  // The presence check + state read in one query. FORBIDDEN (no suggest grant) hides everything.
  const mineQ = trpc.collections.mySuggestions.useQuery(undefined, { retry: false });
  const create = trpc.collections.suggest.useMutation({
    onError: (e) => setError(describeMutationError(e)),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      setName('');
      setBuilderRef('');
      setNote('');
      void utils.collections.mySuggestions.invalidate();
    },
  });

  // Comics are not a Libretto v1 target; hide there. Hide entirely if the caller lacks the suggest grant.
  if (mediaKind === 'comic' || mineQ.error) return null;

  const recent = mineQ.data?.suggestions.slice(0, 3) ?? [];
  const canSubmit = name.trim().length > 0 && builderRef.trim().length > 0;

  return (
    <div className="suggest-affordance" data-testid="suggest-affordance">
      <button
        type="button"
        className="suggest-affordance__card"
        onClick={() => setOpen(true)}
        data-testid="suggest-open"
      >
        <span className="suggest-affordance__plus" aria-hidden="true">
          +
        </span>
        <span className="suggest-affordance__label">Suggest a collection</span>
        <span className="suggest-affordance__hint muted">
          Know a series or list we should build? Tell us and we’ll grow the catalogue.
        </span>
      </button>

      {recent.length > 0 ? (
        <ul className="suggest-affordance__mine" data-testid="suggest-mine">
          {recent.map((s) => (
            <li key={s.id} className="suggest-affordance__mine-row">
              <span className="suggest-affordance__mine-name">{s.name}</span>
              <span
                className={`badge ${
                  s.status === 'approved' ? 'badge--ok' : s.status === 'declined' ? 'badge--danger' : 'badge--muted'
                }`}
              >
                {STATE_LABEL[s.status] ?? s.status}
              </span>
              {s.status === 'declined' && s.decisionNote ? (
                <span className="muted suggest-affordance__reason">{s.decisionNote}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <Modal
        open={open}
        title="Suggest a collection"
        onClose={() => setOpen(false)}
        banner={error ? <p className="alert" role="alert">{error}</p> : null}
      >
        <form
          className="composer-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit)
              create.mutate({ name: name.trim(), builderType, builderRef: builderRef.trim(), note: note.trim() || undefined });
          }}
        >
          <label className="composer-field">
            <span>What should we call it?</span>
            <input
              className="library-search"
              value={name}
              placeholder="The Stormlight Archive"
              onChange={(e) => setName(e.target.value)}
              data-testid="suggest-name"
            />
          </label>
          <label className="composer-field">
            <span>What kind?</span>
            <select
              className="library-search"
              value={builderType}
              onChange={(e) => setBuilderType(e.target.value as typeof builderType)}
            >
              {BUILDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="composer-field">
            <span>Which one?</span>
            <input
              className="library-search"
              value={builderRef}
              placeholder="e.g. the series or list name"
              onChange={(e) => setBuilderRef(e.target.value)}
              data-testid="suggest-ref"
            />
          </label>
          <label className="composer-field">
            <span>Anything to add? (optional)</span>
            <input
              className="library-search"
              value={note}
              placeholder="the series I started and want to finish"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="composer-actions">
            <button type="submit" className="btn sm primary" disabled={!canSubmit || create.isPending}>
              {create.isPending ? 'Sending…' : 'Send suggestion'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
