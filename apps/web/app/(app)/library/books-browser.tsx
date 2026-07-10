'use client';

// ADR-046 / DESIGN-024 (PLAN-023) — a Books Library sub-tab (Books / Audiobooks / Comics). Reuses the
// Library idioms wholesale: the `.media-list.poster-grid` of `.poster-card` tiles, `MediaPoster` (null /
// load-error → KindIcon fallback), the `.library-toolbar`/`.library-search`/`.library-sortbar` chrome, and
// the `.sort-btn` idiom. The data is the app-owned `books_items` ledger (synced from Kavita + ABS), read
// via `books.search` (server-side filter + sort + offset paging). Tiles are EXTERNAL deep-links to the
// item in Kavita/ABS (public URLs, new tab) — books have no in-app detail page. Reflow-free (ADR-015):
// fixed 2:3 poster boxes, dim-in-place on refetch, a fixed-height sort row, skeleton tiles on first load.
import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { MediaPoster } from '@/components/media-poster';
import type { BooksSort } from '@hnet/api';

type BooksMediaKind = 'book' | 'audiobook' | 'comic';

const BASE_SORTS: Array<{ value: BooksSort; label: string }> = [
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'added', label: 'Recently added' },
];

function sortsForKind(kind: BooksMediaKind): Array<{ value: BooksSort; label: string }> {
  return kind === 'audiobook'
    ? [...BASE_SORTS, { value: 'duration', label: 'Length' }]
    : [...BASE_SORTS, { value: 'year', label: 'Year' }];
}

function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function BooksBrowser({ mediaKind, label }: { mediaKind: BooksMediaKind; label: string }) {
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BooksSort>('title');

  // Debounce the search input into the query fed to the server (250ms — the Library convention).
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const search = trpc.books.search.useInfiniteQuery(
    { mediaKind, sort, ...(query.length > 0 ? { query } : {}) },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      initialCursor: 0,
      placeholderData: (prev) => prev,
      refetchOnWindowFocus: false,
    },
  );

  const items = useMemo(() => search.data?.pages.flatMap((p) => p.items) ?? [], [search.data]);
  const refreshing = search.isFetching && !search.isFetchingNextPage && !search.isLoading;
  const sorts = sortsForKind(mediaKind);

  return (
    <>
      <div className="library-toolbar">
        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder={`Search ${label.toLowerCase()}…`}
            aria-label={`Search ${label}`}
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
          />
        </div>

        {/* Sort bar — single-select (server sort direction is baked per option). Fixed-height row. */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          {sorts.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`sort-btn${sort === s.value ? ' is-active' : ''}`}
              aria-pressed={sort === s.value}
              onClick={() => setSort(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {search.isLoading ? (
        <div className="media-list poster-grid" aria-hidden="true" data-testid="books-skeleton">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="poster-card poster-card--skeleton">
              <div className="poster-box" />
              <span className="poster-card__body">
                <span className="skeleton-line" />
                <span className="skeleton-line skeleton-line--short" />
              </span>
            </div>
          ))}
        </div>
      ) : search.error ? (
        <p className="alert" role="alert">
          Failed to load {label}: {search.error.message}
        </p>
      ) : items.length === 0 ? (
        <section className="card empty-state">
          <p className="muted">
            {query.length > 0 ? 'Nothing matches your search.' : `No ${label.toLowerCase()} yet.`}
          </p>
        </section>
      ) : (
        <>
          <div
            className={`media-list poster-grid${refreshing ? ' is-refreshing' : ''}`}
            aria-busy={refreshing}
            data-testid="books-grid"
          >
            {items.map((item) => {
              const duration = formatDuration(item.durationSeconds);
              const badge =
                mediaKind === 'audiobook'
                  ? duration
                  : item.pageCount
                    ? `${item.pageCount} pp`
                    : null;
              return (
                // Deep-link to the item in Kavita/ABS (public URL, new tab) — books have no in-app page.
                <a
                  key={item.id}
                  href={item.deepLinkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="media-card poster-card"
                >
                  <MediaPoster posterUrl={item.posterUrl} kind={item.mediaKind} alt="" />
                  <span className="poster-card__body">
                    <span className="media-card__title">
                      {item.title}
                      {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
                    </span>
                    {item.author !== null ? (
                      <span className="media-card__subtitle">{item.author}</span>
                    ) : null}
                    {badge !== null ? (
                      <span className="media-card__badges">
                        <span className="badge">{badge}</span>
                      </span>
                    ) : null}
                  </span>
                </a>
              );
            })}
          </div>
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
        </>
      )}
    </>
  );
}
