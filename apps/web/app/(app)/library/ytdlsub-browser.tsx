'use client';

// ADR-038 / DESIGN-017 D-05 (PLAN-022) + ADR-051/052 / DESIGN-026 (PLAN-029) — a ytdl-sub Library
// sub-tab (Peloton / YouTube). Reuses the Library idioms wholesale: the `.media-list.poster-grid` of
// `.poster-card` tiles, `MediaPoster` (null / load-error → KindIcon fallback tile), and the
// `@hnet/ui` sort engine (nextSort / arrowFor / sortRowsClientSide) + the `.sort-btn` fixed-arrow
// idiom. The data is read DIRECTLY from the k8plex Plex server via `ytdlsub.list` (no *arr, no
// ledger). Filter + sort are client-side over the (small) show set; a one-shot query (no poll).
//
// PLAN-029: these walls ARE the R2 grouped views — each Plex show is an Exercise discipline
// (Peloton) or a Channel (YouTube), so the show grid is the aggregate-card grid (count badges
// included) and the drill-in is the existing show detail. One honest shape ⇒ no view selector.
// The SORT is registry-declared (`peloton:wall` / `youtube:wall` — title + recently-added only;
// the classes' dates/durations belong to the episode level, R5 asymmetry), URL-synced (`?sort=`,
// a replace — D-10), resolved per ADR-052 (URL → stored preference → the R6 recently-added
// default), and persisted on explicit selection via library.preferences.set.
//
// Reflow-free (ADR-015): fixed 2:3 poster boxes, dim-in-place on refetch, a fixed-height sort row,
// and skeleton tiles on first load.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  arrowFor,
  cmpNum,
  cmpStr,
  nextSort,
  sortRowsClientSide,
  type FieldSpec,
} from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { formatSeasonEpisodeCounts } from '@/lib/media';
import { MediaPoster } from '@/components/media-poster';
import {
  parseWallSortToken,
  type WallSortDir,
  type WallView,
} from '@/lib/library-views';
import { WALL_VIEWS, registryFor, type ViewLevelKey } from '@/lib/library-view-registry';
import type { YtdlsubShow } from '@hnet/api';

// The registry's wall-level keys (added_at / title) bound to the client-side field specs.
const SORT_FIELDS: Record<string, Omit<FieldSpec<YtdlsubShow>, 'dir'>> = {
  title: { get: (r) => r.title, compare: cmpStr },
  added_at: { get: (r) => r.addedAt, compare: cmpNum },
};

export function YtdlsubBrowser({
  library,
  label,
  stored,
}: {
  library: 'peloton' | 'youtube';
  label: string;
  /** The caller's stored wall preference (null = none; undefined = still loading). */
  stored: WallView | null | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState('');

  const entry = registryFor(`${library}:wall` as ViewLevelKey);
  const sortKeys = useMemo(() => entry.sorts.map((s) => s.key), [entry]);

  // ADR-052 — URL sort wins (shared-link fidelity, never persisted back), else the stored
  // preference (validated against this wall's registry keys), else the R6 recently-added default.
  const prefsReady = stored !== undefined;
  const urlSort = parseWallSortToken(searchParams.get('sort'), sortKeys);
  const storedSort =
    stored != null && sortKeys.includes(stored.sortField)
      ? { field: stored.sortField, dir: stored.sortDir }
      : null;
  const sort = urlSort ?? storedSort ?? { field: entry.defaultSort.field, dir: entry.defaultSort.dir };
  const sortToken = `${sort.field}:${sort.dir}`;

  const utils = trpc.useUtils();
  const setPreference = trpc.library.preferences.set.useMutation({
    onSuccess: () => utils.library.preferences.getAll.invalidate(),
  });

  const clickCycle = Object.fromEntries(
    entry.sorts.map((c) => [
      c.key,
      c.firstDir === 'asc'
        ? { asc: `${c.key}:asc`, desc: `${c.key}:desc` }
        : { asc: `${c.key}:desc`, desc: `${c.key}:asc` },
    ]),
  ) as Record<string, { asc: string; desc: string }>;
  const arrowCycle = Object.fromEntries(
    entry.sorts.map((c) => [c.key, { asc: `${c.key}:asc`, desc: `${c.key}:desc` }]),
  ) as Record<string, { asc: string; desc: string }>;
  const cycleSort = (col: string) => {
    const next = nextSort<string, string>(sortToken, col, clickCycle);
    const [field, dir] = next.split(':') as [string, WallSortDir];
    // A sort change is a refinement (replace — D-19); persist the last-used sort (R6, explicit
    // selection). The wall's shape is fixed (grouped by discipline/channel — R2).
    const params = new URLSearchParams(window.location.search);
    params.set('sort', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    setPreference.mutate({
      wall: library,
      view: 'grouped',
      groupBy: WALL_VIEWS[library].groupings?.[0]?.dimension ?? null,
      sortField: field,
      sortDir: dir,
    });
  };

  const list = trpc.ytdlsub.list.useQuery(
    { library },
    { placeholderData: (prev) => prev, refetchOnWindowFocus: false },
  );

  const shows = useMemo(() => {
    const rows = list.data?.items ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q === '' ? rows : rows.filter((r) => r.title.toLowerCase().includes(q));
    const spec = SORT_FIELDS[sort.field];
    if (spec === undefined) return filtered;
    return sortRowsClientSide(filtered, sortToken, {
      fields: { [sortToken]: { ...spec, dir: sort.dir } },
      tiebreaker: (a, b) => cmpStr(a.title, b.title),
    });
  }, [list.data, query, sort.field, sort.dir, sortToken]);

  const refreshing = list.isFetching && !list.isLoading;

  return (
    <>
      <div className="library-toolbar">
        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder={`Search ${label.toLowerCase()}…`}
            aria-label={`Search ${label}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Sort bar — the shared `.sort-btn` idiom (fixed-width arrow slot ⇒ no reflow, ADR-015);
            keys from the registry (this level answers title + date-added ONLY — R5). */}
        <div className="library-sortbar" role="group" aria-label="Sort">
          {entry.sorts.map((c) => {
            const isActive = sort.field === c.key;
            return (
              <button
                key={c.key}
                type="button"
                className={`sort-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => cycleSort(c.key)}
              >
                {c.label}
                <span className="sort-btn__arrow" aria-hidden="true">
                  {arrowFor<string, string>(sortToken, c.key, arrowCycle).trim()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {list.isLoading || !prefsReady ? (
        <div className="media-list poster-grid" aria-hidden="true" data-testid="ytdlsub-skeleton">
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
      ) : list.error ? (
        <p className="alert" role="alert">
          Failed to load {label}: {list.error.message}
        </p>
      ) : list.data?.unavailable ? (
        <section className="card empty-state" data-testid="ytdlsub-unavailable">
          <p className="muted">Couldn’t reach the {label} library right now — try again shortly.</p>
        </section>
      ) : list.data?.found === false ? (
        <section className="card empty-state" data-testid="ytdlsub-missing">
          <p className="muted">The {label} library isn’t on the server yet.</p>
        </section>
      ) : shows.length === 0 ? (
        <section className="card empty-state">
          <p>Nothing matches your search.</p>
        </section>
      ) : (
        <div
          className={`media-list poster-grid${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
          data-testid="ytdlsub-grid"
        >
          {shows.map((show) => {
            const counts = formatSeasonEpisodeCounts(show.seasonCount, show.episodeCount);
            return (
              // DESIGN-017 D-09 (R-132) — tiles are click-throughs to the read-only drill-in
              // (the MediaBrowser card idiom; supersedes the action-free-tile scope note).
              <Link
                key={show.ratingKey}
                href={`/library/ytdlsub/${library}/${show.ratingKey}`}
                className="media-card poster-card"
              >
                <MediaPoster posterUrl={show.posterUrl} kind="show" alt="" />
                <span className="poster-card__body">
                  <span className="media-card__title">
                    {show.title}
                    {show.year !== null ? <span className="muted"> ({show.year})</span> : null}
                  </span>
                  {counts !== null ? (
                    <span className="media-card__badges">
                      <span className="badge">{counts}</span>
                    </span>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
