'use client';

// DESIGN-005 D-17 / R-43 — /library: search + filter chips over ledger.search, a
// cursor-paginated horizontal-card list (DESIGN-006 shape language: tinted icon
// wells, pill controls), card click → /library/[id].
import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { ARR_KIND_LABELS, formatBytes, onDiskSummary, type ArrKindName } from '@/lib/media';
import { KindIcon } from '@/components/kind-icon';
import { FixDialog } from './[id]/fix-dialog';
import { ForceSearchDialog } from './[id]/force-search-dialog';

type ListItem = {
  id: string;
  arrKind: ArrKindName;
  title: string;
  onDiskFileCount: number;
  tombstoned: boolean;
};

/**
 * D-17 — the item-level quick action: missing content gets Force Search (search only),
 * on-disk content gets Fix. Sonarr/Lidarr repairs happen per episode/album on the
 * detail page (owner feedback: no whole-series nuke), so the list only offers the
 * movie-level Fix (radarr) and a whole-item Force Search where the item is fully
 * missing (radarr movie / sonarr series). Everything else opens the detail view.
 */
function listAction(item: ListItem): 'fix' | 'search' | null {
  if (item.tombstoned) return null;
  const missing = item.onDiskFileCount === 0;
  if (item.arrKind === 'radarr') return missing ? 'search' : 'fix';
  if (item.arrKind === 'sonarr' && missing) return 'search';
  return null;
}

const KIND_FILTERS: Array<{ value: ArrKindName | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'sonarr', label: 'TV' },
  { value: 'radarr', label: 'Movies' },
  { value: 'lidarr', label: 'Music' },
];

const ON_DISK_FILTERS = [
  { value: 'any', label: 'Any' },
  { value: 'complete', label: 'Complete' },
  { value: 'partial', label: 'Partial' },
  { value: 'none', label: 'Missing' },
] as const;

type OnDiskFilter = (typeof ON_DISK_FILTERS)[number]['value'];

export default function LibraryPage() {
  const utils = trpc.useUtils();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ArrKindName | undefined>(undefined);
  const [onDisk, setOnDisk] = useState<OnDiskFilter>('any');
  const [wantedOnly, setWantedOnly] = useState(false);
  const [action, setAction] = useState<{
    mode: 'fix' | 'search';
    item: { id: string; arrKind: string; title: string };
  } | null>(null);

  const search = trpc.ledger.search.useInfiniteQuery(
    {
      query: query.trim() === '' ? undefined : query.trim(),
      arrKind: kind,
      onDisk,
      ...(wantedOnly ? { wanted: true } : {}),
      limit: 50,
    },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      placeholderData: (prev) => prev,
    },
  );

  const items = search.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <h1 className="page-title">Library</h1>
      <div className="library-toolbar">
        <input
          type="search"
          className="library-search"
          placeholder="Search titles…"
          aria-label="Search the library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="library-filters">
          <div className="seg" role="group" aria-label="Kind">
            {KIND_FILTERS.map((f) => (
              <button
                key={f.label}
                type="button"
                className={kind === f.value ? 'is-active' : undefined}
                onClick={() => setKind(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="On disk">
            {ON_DISK_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={onDisk === f.value ? 'is-active' : undefined}
                onClick={() => setOnDisk(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`btn sm${wantedOnly ? ' primary' : ''}`}
            aria-pressed={wantedOnly}
            onClick={() => setWantedOnly((v) => !v)}
          >
            Wanted only
          </button>
        </div>
      </div>

      {search.isLoading ? <p className="muted">Loading the ledger…</p> : null}
      {search.error ? (
        <p className="alert" role="alert">
          Failed to load the library: {search.error.message}
        </p>
      ) : null}

      {!search.isLoading && !search.error && items.length === 0 ? (
        <section className="card empty-state">
          <p>Nothing matches — the ledger fills in as sync runs.</p>
        </section>
      ) : (
        <div className="media-list">
          {items.map((item) => {
            const disk = onDiskSummary(item);
            const quick = listAction(item);
            return (
              <div key={item.id} className="media-row">
                <Link href={`/library/${item.id}`} className="media-card">
                  <span className="media-card__icon">
                    <KindIcon kind={item.arrKind} />
                  </span>
                  <span className="media-card__title">
                    {item.title}
                    {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
                  </span>
                  <span className="media-card__badges">
                    <span className="badge badge--muted">{ARR_KIND_LABELS[item.arrKind]}</span>
                    <span className={`badge badge--${disk.tone}`}>{disk.label}</span>
                    {item.tombstoned ? <span className="badge badge--danger">Removed</span> : null}
                  </span>
                  <span className="media-card__meta">
                    {item.sizeOnDisk > 0 ? formatBytes(item.sizeOnDisk) : '—'}
                  </span>
                </Link>
                {quick !== null ? (
                  <button
                    type="button"
                    className="btn sm media-row__action"
                    onClick={() =>
                      setAction({
                        mode: quick,
                        item: { id: item.id, arrKind: item.arrKind, title: item.title },
                      })
                    }
                  >
                    {quick === 'fix' ? 'Fix' : 'Force Search'}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {search.hasNextPage ? (
        <div className="load-more">
          <button
            type="button"
            className="btn"
            disabled={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            {search.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}

      {action !== null ? (
        <>
          <FixDialog
            open={action.mode === 'fix'}
            onClose={() => setAction(null)}
            item={action.item}
            onSubmitted={() => {
              void utils.ledger.search.invalidate();
              void utils.fix.myFixes.invalidate();
            }}
          />
          <ForceSearchDialog
            open={action.mode === 'search'}
            onClose={() => setAction(null)}
            item={action.item}
            onSubmitted={() => {
              void utils.ledger.search.invalidate();
              void utils.fix.myFixes.invalidate();
            }}
          />
        </>
      ) : null}
    </>
  );
}
