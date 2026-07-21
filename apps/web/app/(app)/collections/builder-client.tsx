'use client';

// DESIGN-044 — the full-page, search-first collection BUILDER. The owner-ruled replacement for the
// DESIGN-043 D-03 "tiny popup" Modal composer (superseded). One progressive page (never a wizard, D-02),
// mobile-first at 390: builder-type CARDS with the plain-language D-03 copy → a SEARCH-first ref field
// (D-04) → a live member PREVIEW split "In your library" vs "Missing" with counts + a cap meter (D-05). The
// save FLOWS are the unchanged DESIGN-043/042 ones (D-07): within-cap writes the provider, over-cap files the
// collection_override ticket; a preview outage never changes the save gate. Owner tone throughout (no
// em-dashes); all color via tokens (hard rule 2); interactions recolor, never reflow (ADR-015) — the only
// in-place expansions are the sanctioned ref reveal + the id-list reorder.
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Modal } from '@/components/modal';
import { BaseCard, PosterGrid, type CardBadge } from '@/components/cards';
import { CollectionCatch } from '@/components/collection-catch';
import { trpc } from '@/lib/trpc-client';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import {
  COLLECTIONS_NAME,
  COLLECTION_MEDIA_TYPE_LABELS,
  builderCard,
  builderCardsFor,
  collectionProgress,
  isValidListUrl,
  type BuilderCard,
  type CollectionBuilderTypeName,
  type CollectionMediaTypeName,
  type CollectionSyncModeName,
} from '@/lib/collections';

// ADR-076 C-01 (PLAN-060) — the Books/Audiobooks tabs merged; 'audiobooks' tolerated at the wire.
const MEDIA_TABS: readonly CollectionMediaTypeName[] = ['movies', 'tv', 'books'];

/** "The Stormlight Archive" → "the-stormlight-archive" (the derived-id convenience; users never invent one). */
function slugifyCollectionId(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** One accumulated pick in a multi-add (Shape C) id list — the ref plus the resolved title, so it is legible. */
interface MultiPick {
  ref: string;
  title: string;
  subtitle?: string | null;
}

interface BuilderDraft {
  /** The recipe id (derived from the name on create; the locked identity on edit). */
  id: string;
  name: string;
  builder: CollectionBuilderTypeName | null;
  /** Single-ref builders keep a string; multi-add builders keep the picks (ref = the id array). */
  ref: string;
  picks: MultiPick[];
  ordered: boolean;
  syncMode: CollectionSyncModeName;
  findMissing: boolean;
  /** Set for a hand-authored Kometa collection edit (locks name+builder, routes Save to editHandCollection). */
  handFile: string | null;
}

const EMPTY_DRAFT: BuilderDraft = {
  id: '',
  name: '',
  builder: null,
  ref: '',
  picks: [],
  ordered: false,
  syncMode: 'append',
  findMissing: false,
  handFile: null,
};

export function CollectionBuilderClient(props: {
  isAdmin: boolean;
  mode: 'create' | 'edit';
  /** The edit target's recipe id / hand-collection name (edit mode only). */
  editId?: string;
}) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <CollectionBuilder {...props} />
    </Suspense>
  );
}

function CollectionBuilder({
  mode,
  editId,
}: {
  isAdmin: boolean;
  mode: 'create' | 'edit';
  editId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The media tab seeds the provider binding + the builder-card set (D-01). A missing/invalid tab
  // falls back to Books; a legacy `?tab=audiobooks` deep link binds the merged Books tab
  // (ADR-076 C-01 — 'audiobooks' stays a tolerated wire value).
  const rawTab = searchParams.get('tab');
  const tab: CollectionMediaTypeName =
    rawTab === 'audiobooks'
      ? 'books'
      : rawTab && (MEDIA_TABS as readonly string[]).includes(rawTab)
        ? (rawTab as CollectionMediaTypeName)
        : 'books';
  const handFileParam = searchParams.get('hand');

  const overviewQ = trpc.collections.overview.useQuery({ mediaType: tab }, { retry: false });

  const [draft, setDraft] = useState<BuilderDraft>(EMPTY_DRAFT);
  // On edit, prefill ONCE from the authoritative overview (the DESIGN-043 openEdit data), then lock the
  // builder + name (the DESIGN-042 D-05 identity rule). Adjust-state-during-render (the codebase idiom —
  // React re-renders before painting; setState-in-effect is disallowed here).
  const [prefilled, setPrefilled] = useState(mode === 'create');
  const [loadError, setLoadError] = useState<string | null>(null);
  if (!prefilled && overviewQ.data && editId) {
    const data = overviewQ.data;
    if (handFileParam) {
      const hand = (data.handCollections ?? []).find((h) => h.name === editId);
      if (hand) {
        setDraft({
          id: hand.name,
          name: hand.name,
          builder: (hand.builderType as CollectionBuilderTypeName | null) ?? null,
          ref: hand.builderRef ?? '',
          picks: [],
          ordered: false,
          syncMode: 'sync',
          findMissing: hand.findMissing,
          handFile: hand.file,
        });
      } else {
        setLoadError('That collection could not be loaded.');
      }
    } else {
      const recipe = data.recipes.find((r) => r.id === editId);
      if (recipe) {
        setDraft({
          id: recipe.id,
          name: recipe.name ?? recipe.id,
          builder: (recipe.builderType as CollectionBuilderTypeName | null) ?? null,
          ref: recipe.builderRef ?? '',
          picks: [],
          ordered: recipe.ordered ?? false,
          syncMode: (recipe.syncMode as CollectionSyncModeName | null) ?? 'append',
          findMissing: recipe.findMissing ?? false,
          handFile: null,
        });
      } else {
        setLoadError('That collection could not be loaded.');
      }
    }
    setPrefilled(true);
  }

  const editing = mode === 'edit';
  const card = draft.builder ? builderCard(tab, draft.builder) : undefined;
  const backToList = () => router.push(`/collections?tab=${tab}`);

  if (overviewQ.isPending) {
    return <BuilderShell tab={tab} onBack={backToList}><p className="muted">Loading…</p></BuilderShell>;
  }
  if (overviewQ.error) {
    return (
      <BuilderShell tab={tab} onBack={backToList}>
        <section className="card empty-state">
          <p>Could not load the {COLLECTION_MEDIA_TYPE_LABELS[tab].toLowerCase()} collection builder.</p>
          <p className="muted">{describeMutationError(overviewQ.error)}</p>
        </section>
      </BuilderShell>
    );
  }

  const overview = overviewQ.data;
  const cards = builderCardsFor(tab);

  return (
    <BuilderShell tab={tab} editing={editing} onBack={backToList}>
      {loadError ? (
        <section className="card empty-state" data-testid="builder-load-error">
          <p className="muted">{loadError}</p>
        </section>
      ) : null}

      <div className="builder-grid">
        <div className="builder-form">
          {/* 1 — What kind of collection? (the builder-type cards, D-03). Locked on edit (D-05 identity). */}
          <section className="builder-section" data-testid="builder-typecards">
            <h2 className="builder-section__title">What kind of collection?</h2>
            {editing ? (
              <p className="muted" data-testid="builder-locked-note">
                The type and name stay as they are while editing. You can change what it points at and its
                options below.
              </p>
            ) : cards.length === 0 ? (
              <p className="muted" data-testid="builder-no-types">
                No collection types are available here yet.
              </p>
            ) : (
              <div className="builder-cards">
                {cards.map((c) => (
                  <BuilderTypeCard
                    key={c.builder}
                    card={c}
                    selected={draft.builder === c.builder}
                    onPick={() =>
                      setDraft({ ...EMPTY_DRAFT, builder: c.builder, ordered: c.shape !== 'multi', name: draft.name })
                    }
                  />
                ))}
              </div>
            )}
            {editing && card ? (
              <div className="builder-cards">
                <BuilderTypeCard card={card} selected locked />
              </div>
            ) : null}
          </section>

          {/* 2 — Which one? (the search-first ref field, D-04). Revealed once a builder is chosen. */}
          {draft.builder && card ? (
            <section className="builder-section" data-testid="builder-reffield">
              <h2 className="builder-section__title">Which one?</h2>
              <RefField
                mediaType={tab}
                card={card}
                draft={draft}
                setDraft={setDraft}
              />
            </section>
          ) : null}

          {/* 3 — Name it. Prefilled from the resolved ref; overridable on create, locked on edit. */}
          {draft.builder ? (
            <section className="builder-section">
              <h2 className="builder-section__title">Name it</h2>
              <label className="composer-field">
                <span>Collection name</span>
                <input
                  className="library-search"
                  data-testid="builder-name"
                  value={draft.name}
                  disabled={editing}
                  placeholder="The Stormlight Archive"
                  onChange={(e) => {
                    const name = e.target.value;
                    setDraft({ ...draft, name, id: editing ? draft.id : slugifyCollectionId(name) });
                  }}
                />
              </label>
            </section>
          ) : null}

          {/* 4 — Options in human words (D-06). Only the ones that mean something for this builder. */}
          {draft.builder && !draft.handFile ? (
            <section className="builder-section" data-testid="builder-options">
              <h2 className="builder-section__title">Options</h2>
              <label className="composer-inline">
                <input
                  type="checkbox"
                  checked={draft.ordered}
                  onChange={(e) => setDraft({ ...draft, ordered: e.target.checked })}
                  data-testid="builder-ordered"
                />
                Keep them in order
                <span className="muted builder-option__note">
                  {card?.shape === 'multi' ? 'the order you add them' : "the source's own order"}
                </span>
              </label>
              <label className="composer-inline builder-option">
                <span>How it stays in sync</span>
                <select
                  className="library-search composer-sync"
                  value={draft.syncMode}
                  data-testid="builder-syncmode"
                  onChange={(e) => setDraft({ ...draft, syncMode: e.target.value as CollectionSyncModeName })}
                >
                  <option value="append">Only add new matches, never remove</option>
                  <option value="sync">Replace the collection to match every run</option>
                </select>
              </label>
            </section>
          ) : null}
        </div>

        {/* The live preview panel (D-05) — sticky on desktop, stacks below the form at phone width (D-08). */}
        {draft.builder && card ? (
          <PreviewPanel mediaType={tab} card={card} draft={draft} />
        ) : (
          <section className="builder-preview" data-testid="builder-preview-empty">
            <p className="muted">Pick a collection type to see what it will hold.</p>
          </section>
        )}
      </div>

      {/* Save (D-07) — the primary action; its behavior is the unchanged DESIGN-043 save flows. */}
      {draft.builder ? (
        <SaveBar
          mediaType={tab}
          draft={draft}
          editing={editing}
          sizeCap={overview.sizeCap}
          onSaved={backToList}
          onCancel={backToList}
        />
      ) : null}
    </BuilderShell>
  );
}

// ── Page chrome ───────────────────────────────────────────────────────────────────────────────

function BuilderShell({
  tab,
  editing = false,
  onBack,
  children,
}: {
  tab: CollectionMediaTypeName;
  editing?: boolean;
  onBack: () => void;
  children: React.ReactNode;
}) {
  const label = COLLECTION_MEDIA_TYPE_LABELS[tab];
  return (
    <div className="collections-page builder-page">
      <div className="builder-head">
        <button type="button" className="btn sm" onClick={onBack} data-testid="builder-back">
          Back to {COLLECTIONS_NAME}
        </button>
        <h1 className="page-title" data-testid="builder-title">
          {editing ? 'Edit collection' : `New ${label.toLowerCase()} collection`}
        </h1>
      </div>
      {children}
    </div>
  );
}

/** One builder-type card (ADR-058 tokens-only card family): title + verbatim D-03 explanation + hint. */
function BuilderTypeCard({
  card,
  selected,
  locked = false,
  onPick,
}: {
  card: BuilderCard;
  selected: boolean;
  locked?: boolean;
  onPick?: () => void;
}) {
  const className = `builder-card${selected ? ' builder-card--selected' : ''}${locked ? ' builder-card--locked' : ''}`;
  const body = (
    <>
      <span className="builder-card__title">{card.title}</span>
      <span className="builder-card__explain">{card.explanation}</span>
      <span className="builder-card__hint">{card.hint}</span>
    </>
  );
  if (locked || !onPick) {
    return (
      <div className={className} data-testid={`builder-card-${card.builder}`} aria-disabled>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      aria-pressed={selected}
      data-testid={`builder-card-${card.builder}`}
      onClick={onPick}
    >
      {body}
    </button>
  );
}

// ── The search-first ref field (D-04) ───────────────────────────────────────────────────────

function RefField({
  mediaType,
  card,
  draft,
  setDraft,
}: {
  mediaType: CollectionMediaTypeName;
  card: BuilderCard;
  draft: BuilderDraft;
  setDraft: (d: BuilderDraft) => void;
}) {
  if (card.shape === 'url') {
    return <UrlRefField card={card} draft={draft} setDraft={setDraft} />;
  }
  if (card.shape === 'multi') {
    return <MultiRefField mediaType={mediaType} card={card} draft={draft} setDraft={setDraft} />;
  }
  return <SearchRefField mediaType={mediaType} card={card} draft={draft} setDraft={setDraft} />;
}

/** A debounced typeahead (250ms, Q-06) over collections.search; picking sets the ref + prefills the name. */
function useDebounced(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Shape A — typeahead search for ONE ref (a series, a list, a franchise). Manual entry stays available. */
function SearchRefField({
  mediaType,
  card,
  draft,
  setDraft,
}: {
  mediaType: CollectionMediaTypeName;
  card: BuilderCard;
  draft: BuilderDraft;
  setDraft: (d: BuilderDraft) => void;
}) {
  const [term, setTerm] = useState('');
  const [manual, setManual] = useState(false);
  const debounced = useDebounced(term);
  const q = trpc.collections.search.useQuery(
    { mediaType, builderType: card.builder, q: debounced },
    { enabled: debounced.trim().length >= 2, retry: false },
  );

  if (manual) {
    return (
      <ManualRefEntry
        draft={draft}
        setDraft={setDraft}
        onSearchAgain={() => setManual(false)}
      />
    );
  }

  return (
    <div className="builder-search">
      <label className="composer-field">
        <span>{card.hint}</span>
        <input
          type="search"
          className="library-search"
          data-testid="builder-search-input"
          placeholder={card.hint}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </label>
      {draft.ref ? (
        <p className="builder-search__chosen" data-testid="builder-ref-chosen">
          Using <strong>{draft.name || draft.ref}</strong>
        </p>
      ) : null}
      {debounced.trim().length >= 2 ? (
        q.isPending ? (
          <p className="muted">Searching…</p>
        ) : q.data && q.data.reachable ? (
          q.data.results.length === 0 ? (
            <p className="muted" data-testid="builder-search-empty">
              Nothing matched that. You can also enter it directly.
            </p>
          ) : (
            <ul className="builder-results" data-testid="builder-search-results">
              {q.data.results.map((r, i) => (
                <li key={`${r.ref}-${i}`}>
                  <button
                    type="button"
                    className="builder-result"
                    disabled={r.disabled}
                    title={r.disabled ? (r.disabledReason ?? undefined) : undefined}
                    data-testid="builder-result"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        ref: r.ref,
                        name: draft.name && draft.name !== '' ? draft.name : r.name,
                        id: draft.id || slugifyCollectionId(r.name),
                      })
                    }
                  >
                    <span className="builder-result__name">{r.name}</span>
                    {r.subtitle ? <span className="builder-result__sub muted">{r.subtitle}</span> : null}
                    {r.detail ? <span className="builder-result__detail muted">{r.detail}</span> : null}
                    {r.disabled ? <span className="builder-result__detail muted">{r.disabledReason}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="muted" data-testid="builder-search-unreachable">
            Search is unavailable right now. You can enter it directly instead.
          </p>
        )
      ) : null}
      <button type="button" className="btn sm" onClick={() => setManual(true)} data-testid="builder-manual-toggle">
        Enter it directly
      </button>
    </div>
  );
}

/** The honest fallback: type the raw slug/id/url when search is down or the advanced user knows it (D-04). */
function ManualRefEntry({
  draft,
  setDraft,
  onSearchAgain,
}: {
  draft: BuilderDraft;
  setDraft: (d: BuilderDraft) => void;
  onSearchAgain: () => void;
}) {
  return (
    <div className="builder-search">
      <label className="composer-field">
        <span>Enter the reference directly</span>
        <input
          className="library-search"
          data-testid="builder-ref-manual"
          value={draft.ref}
          placeholder="the-stormlight-archive"
          onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
        />
      </label>
      <button type="button" className="btn sm" onClick={onSearchAgain}>
        Search by name instead
      </button>
    </div>
  );
}

/** Shape B — a validated list URL (no name search; the honest "preview unavailable" note follows, D-05). */
function UrlRefField({
  card,
  draft,
  setDraft,
}: {
  card: BuilderCard;
  draft: BuilderDraft;
  setDraft: (d: BuilderDraft) => void;
}) {
  const invalid = draft.ref.trim().length > 0 && !isValidListUrl(card.builder, draft.ref);
  return (
    <div className="builder-search">
      <label className="composer-field">
        <span>{card.hint}</span>
        <input
          className="library-search"
          data-testid="builder-url-input"
          value={draft.ref}
          placeholder="https://www.imdb.com/list/ls012345678/"
          onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
        />
      </label>
      {invalid ? (
        <p className="composer-warn" data-testid="builder-url-invalid">
          That does not look like a valid list link yet.
        </p>
      ) : null}
    </div>
  );
}

/** Shape C — a search box that ADDS each pick to an ordered, removable, reorderable id list (D-04). */
function MultiRefField({
  mediaType,
  card,
  draft,
  setDraft,
}: {
  mediaType: CollectionMediaTypeName;
  card: BuilderCard;
  draft: BuilderDraft;
  setDraft: (d: BuilderDraft) => void;
}) {
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);
  const q = trpc.collections.search.useQuery(
    { mediaType, builderType: card.builder, q: debounced },
    { enabled: debounced.trim().length >= 2, retry: false },
  );

  const chosen = new Set(draft.picks.map((p) => p.ref));
  const setPicks = (picks: MultiPick[]) =>
    setDraft({ ...draft, picks, ref: picks.map((p) => p.ref).join(',') });
  const add = (pick: MultiPick) => {
    if (chosen.has(pick.ref)) return;
    setPicks([...draft.picks, pick]);
  };
  const remove = (ref: string) => setPicks(draft.picks.filter((p) => p.ref !== ref));
  const move = (index: number, delta: number) => {
    const next = [...draft.picks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setPicks(next);
  };

  return (
    <div className="builder-search">
      <label className="composer-field">
        <span>{card.hint}</span>
        <input
          type="search"
          className="library-search"
          data-testid="builder-multi-input"
          placeholder={card.hint}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </label>
      {debounced.trim().length >= 2 && q.data && q.data.reachable && q.data.results.length > 0 ? (
        <ul className="builder-results" data-testid="builder-multi-results">
          {q.data.results
            .filter((r) => !r.disabled && !chosen.has(r.ref))
            .map((r, i) => (
              <li key={`${r.ref}-${i}`}>
                <button
                  type="button"
                  className="builder-result"
                  data-testid="builder-multi-result"
                  onClick={() => add({ ref: r.ref, title: r.name, subtitle: r.subtitle })}
                >
                  <span className="builder-result__name">{r.name}</span>
                  {r.subtitle ? <span className="builder-result__sub muted">{r.subtitle}</span> : null}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
      {draft.picks.length > 0 ? (
        <ol className="builder-picks" data-testid="builder-picks">
          {draft.picks.map((p, i) => (
            <li key={p.ref} className="builder-pick">
              <span className="builder-pick__title">
                {p.title}
                {p.subtitle ? <span className="muted"> · {p.subtitle}</span> : null}
              </span>
              <span className="builder-pick__actions">
                <button type="button" className="btn sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="btn sm"
                  aria-label="Move down"
                  disabled={i === draft.picks.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button type="button" className="btn sm danger" data-testid="builder-pick-remove" onClick={() => remove(p.ref)}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">Search above and add each {mediaType === 'tv' ? 'show' : mediaType === 'movies' ? 'movie' : 'book'}.</p>
      )}
    </div>
  );
}

// ── The live preview panel (D-05) ───────────────────────────────────────────────────────────

function PreviewPanel({
  mediaType,
  card,
  draft,
}: {
  mediaType: CollectionMediaTypeName;
  card: BuilderCard;
  draft: BuilderDraft;
}) {
  const isMulti = card.shape === 'multi';
  const ref: string | string[] = isMulti ? draft.picks.map((p) => p.ref) : draft.ref.trim();
  const hasRef = isMulti ? draft.picks.length > 0 : draft.ref.trim().length > 0;

  const preview = trpc.collections.preview.useQuery(
    { mediaType, builderType: card.builder, ref },
    { enabled: hasRef, retry: false },
  );

  const data = preview.data;
  // DESIGN-044 D-05 (owner REDESIGN ruling 2026-07-18) — the header reads the gamified held/total, celebrating
  // a caught-em-all collection; the cap is never advertised (over-cap is the server error + ticket flow only).
  const progress = data?.available ? collectionProgress(data.heldCount, data.total) : null;

  return (
    <section className="builder-preview" data-testid="builder-preview">
      <div className="builder-preview__head">
        <h2 className="builder-section__title">What you are about to build</h2>
        {progress ? <CollectionCatch progress={progress} /> : null}
      </div>

      {!hasRef ? (
        <p className="muted">Pick a {card.shape === 'url' ? 'list' : 'source'} above to see its titles.</p>
      ) : preview.isPending ? (
        <p className="muted">Resolving the titles…</p>
      ) : preview.error ? (
        <p className="muted" data-testid="builder-preview-error">
          A preview is not available right now. You can still save; it resolves when the collection runs.
        </p>
      ) : data && !data.available ? (
        <p className="muted" data-testid="builder-preview-unavailable">
          {data.unavailableReason}
        </p>
      ) : data && data.total === 0 ? (
        <p className="muted" data-testid="builder-preview-zero">
          This resolved to no titles. Check the reference before saving.
        </p>
      ) : data ? (
        <>
          {data.truncated ? (
            <p className="muted" data-testid="builder-preview-truncated">
              Showing the first {data.members.length} of {data.total}.
            </p>
          ) : null}
          <PreviewGroup
            title={`In your library (${data.heldCount})`}
            mediaType={mediaType}
            members={data.members.filter((m) => m.held)}
            held
            testId="builder-held"
          />
          <PreviewGroup
            title={`Missing (${data.missingCount})`}
            mediaType={mediaType}
            members={data.members.filter((m) => !m.held)}
            held={false}
            testId="builder-missing"
          />
        </>
      ) : null}
    </section>
  );
}

function PreviewGroup({
  title,
  mediaType,
  members,
  held,
  testId,
}: {
  title: string;
  mediaType: CollectionMediaTypeName;
  members: Array<{ key: string; title: string; subtitle?: string | null; posterUrl?: string | null; matchedByTitle?: boolean }>;
  held: boolean;
  testId: string;
}) {
  if (members.length === 0) return null;
  const isBooks = mediaType === 'books' || mediaType === 'audiobooks';
  const kind = isBooks ? (mediaType === 'audiobooks' ? 'audiobook' : 'book') : mediaType === 'tv' ? 'sonarr' : 'radarr';
  const statusBadge = (matchedByTitle?: boolean): CardBadge =>
    held
      ? matchedByTitle
        ? { label: 'matched by title', tone: 'muted', title: 'Matched by title, not an exact identifier.' }
        : { label: 'in your library', tone: 'ok' }
      : { label: 'missing', tone: 'warn' };
  return (
    <section className="builder-group" data-testid={testId}>
      <h3 className="builder-group__title">{title}</h3>
      <PosterGrid>
        {/* Non-interactive preview tiles (href=null) — the sanctioned BaseCard anatomy, never a hand-rolled
            card (ADR-058). A missing member has no library row, so its poster is the KindIcon glyph tile. */}
        {members.map((m) => (
          <BaseCard
            key={m.key}
            href={null}
            art={{ type: 'poster', posterUrl: m.posterUrl ?? null, kind }}
            title={m.title}
            subtitle={m.subtitle ?? undefined}
            badges={[statusBadge(m.matchedByTitle)]}
          />
        ))}
      </PosterGrid>
    </section>
  );
}

// ── Save (D-07) ─────────────────────────────────────────────────────────────────────────────

function SaveBar({
  mediaType,
  draft,
  editing,
  sizeCap,
  onSaved,
  onCancel,
}: {
  mediaType: CollectionMediaTypeName;
  draft: BuilderDraft;
  editing: boolean;
  sizeCap: number;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [overCapOpen, setOverCapOpen] = useState(false);
  const [overCapSize, setOverCapSize] = useState<number | null>(null);

  const refValue = builderCard(mediaType, draft.builder!)?.shape === 'multi'
    ? draft.picks.map((p) => p.ref).join(',')
    : draft.ref.trim();

  const payload = {
    id: draft.id.trim(),
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    builderType: draft.builder as CollectionBuilderTypeName,
    builderRef: refValue,
    ordered: draft.ordered,
    syncMode: draft.syncMode,
    mediaType,
  };
  const canSave = payload.id.length > 0 && payload.builderRef.length > 0;

  const onCapOrError = (e: unknown) => {
    if (appCodeOf(e) === 'COLLECTION_SIZE_CAP_EXCEEDED') {
      setOverCapSize(null);
      setOverCapOpen(true);
      return;
    }
    setError(describeMutationError(e));
  };

  const upsert = trpc.collections.upsert.useMutation({ onError: onCapOrError, onSuccess: onSaved });
  const editHand = trpc.collections.editHandCollection.useMutation({ onError: onCapOrError, onSuccess: onSaved });
  const requestOverride = trpc.collections.requestOverride.useMutation({
    onError: (e) => setError(describeMutationError(e)),
  });
  const saving = upsert.isPending || editHand.isPending;

  const submit = () => {
    if (!canSave) return;
    setError(null);
    if (draft.handFile && (mediaType === 'movies' || mediaType === 'tv')) {
      editHand.mutate({
        mediaType,
        file: draft.handFile,
        name: payload.id,
        builderType: draft.builder as
          | 'imdb_list'
          | 'tmdb_collection_details'
          | 'tvdb_list_details'
          | 'tmdb_movie'
          | 'tmdb_show'
          | 'tvdb_show',
        builderRef: payload.builderRef,
      });
      return;
    }
    upsert.mutate(payload);
  };

  const collectionLabel = payload.name ?? payload.id;

  return (
    <div className="builder-savebar" data-testid="builder-savebar">
      {error ? (
        <p className="alert" role="alert" data-testid="builder-save-error">
          {error}
        </p>
      ) : null}
      <div className="builder-savebar__actions">
        <button type="button" className="btn" onClick={onCancel} data-testid="builder-cancel">
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!canSave || saving}
          data-testid="builder-save"
          onClick={submit}
        >
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add collection'}
        </button>
      </div>

      <Modal
        open={overCapOpen}
        title="Collection is over the limit"
        onClose={() => {
          setOverCapOpen(false);
          requestOverride.reset();
        }}
      >
        <div className="over-cap" data-testid="builder-over-cap">
          {requestOverride.isSuccess ? (
            <>
              <p>
                Request sent. Track it under Tickets, where an admin can approve the full size for{' '}
                <strong>{collectionLabel}</strong>.
              </p>
              <div className="form-actions">
                <button type="button" className="btn primary" onClick={onSaved}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                This collection is larger than the limit of {sizeCap}
                {overCapSize != null ? ` (it resolves to ${overCapSize})` : ''}. Request it and an admin can
                approve the full size.
              </p>
              {requestOverride.error ? (
                <p className="alert" role="alert">
                  {describeMutationError(requestOverride.error)}
                </p>
              ) : null}
              <div className="form-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={requestOverride.isPending}
                  data-testid="builder-over-cap-request"
                  onClick={() => requestOverride.mutate(payload)}
                >
                  {requestOverride.isPending ? 'Sending…' : 'Request it'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={requestOverride.isPending}
                  onClick={() => setOverCapOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
