'use client';

// DESIGN-005 D-17 / R-43 — /library: WAI-ARIA sub-tabs (Movies · TV · Music · My Fixes,
// default Movies, no "All"). Each media tab scopes ledger.search to a fixed arrKind; the
// My Fixes tab hosts the relocated fix ledger (fix.myFixes via MyFixesPanel). Active tab
// is driven by the ?tab= search param. Tiles are ACTION-FREE (owner ruling 2026-07-04):
// every row is a uniform click-through to /library/[id], where all Fix / Force Search
// actions live — the list carries badges only (kind, on-disk, Removed).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { ARR_KIND_LABELS, formatBytes, onDiskSummary, type ArrKindName } from '@/lib/media';
import { KindIcon } from '@/components/kind-icon';
import { MyFixesPanel } from '@/components/my-fixes-panel';

const LIBRARY_TABS = [
  { key: 'movies', label: 'Movies', arrKind: 'radarr' },
  { key: 'tv', label: 'TV', arrKind: 'sonarr' },
  { key: 'music', label: 'Music', arrKind: 'lidarr' },
  { key: 'my-fixes', label: 'My Fixes', arrKind: undefined },
] as const satisfies ReadonlyArray<{ key: string; label: string; arrKind?: ArrKindName }>;

type TabKey = (typeof LIBRARY_TABS)[number]['key'];

const ON_DISK_FILTERS = [
  { value: 'any', label: 'Any' },
  { value: 'complete', label: 'Complete' },
  { value: 'partial', label: 'Partial' },
  { value: 'none', label: 'Missing' },
] as const;

type OnDiskFilter = (typeof ON_DISK_FILTERS)[number]['value'];

function resolveTab(raw: string | null): TabKey {
  return LIBRARY_TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'movies';
}

function LibraryContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const activeTab = LIBRARY_TABS.find((t) => t.key === active) ?? LIBRARY_TABS[0];

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (key: TabKey) => {
    // Merge into the existing params (don't clobber unrelated ones).
    const params = new URLSearchParams(searchParams);
    params.set('tab', key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % LIBRARY_TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + LIBRARY_TABS.length) % LIBRARY_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = LIBRARY_TABS.length - 1;
    else return;
    e.preventDefault();
    const target = LIBRARY_TABS[next];
    if (!target) return;
    selectTab(target.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <h1 className="page-title">Library</h1>

      <div className="library-tabs" role="tablist" aria-label="Library sections">
        {LIBRARY_TABS.map((tab, index) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`libtab-${tab.key}`}
            aria-selected={active === tab.key}
            aria-controls="library-panel"
            tabIndex={active === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(e) => onTabKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="library-panel" role="tabpanel" aria-labelledby={`libtab-${active}`}>
        {activeTab.arrKind ? (
          // Keyed by tab: switching media tabs REMOUNTS with fresh search + filters, so a
          // filter set on Movies never leaks into TV/Music (and back/forward resets too) —
          // cleaner than a reset effect.
          <MediaBrowser key={activeTab.key} arrKind={activeTab.arrKind} label={activeTab.label} />
        ) : (
          <MyFixesPanel />
        )}
      </div>
    </>
  );
}

// One media tab's browse UI: category-scoped search + on-disk/wanted filters + the paginated
// list. Its own state (reset on remount per tab) — see the keyed usage above.
function MediaBrowser({ arrKind, label }: { arrKind: ArrKindName; label: string }) {
  const [query, setQuery] = useState('');
  const [onDisk, setOnDisk] = useState<OnDiskFilter>('any');
  const [wantedOnly, setWantedOnly] = useState(false);

  const search = trpc.ledger.search.useInfiniteQuery(
    {
      query: query.trim() === '' ? undefined : query.trim(),
      arrKind,
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
      <div className="library-toolbar">
        <input
          type="search"
          className="library-search"
          placeholder={`Search ${label.toLowerCase()}…`}
          aria-label="Search the library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="library-filters">
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

      {/* isPlaceholderData: while the (rare) same-mount refetch resolves, keep the loading line
          rather than flashing stale rows. */}
      {search.isLoading || search.isPlaceholderData ? (
        <p className="muted">Loading the ledger…</p>
      ) : search.error ? (
        <p className="alert" role="alert">
          Failed to load the library: {search.error.message}
        </p>
      ) : items.length === 0 ? (
        <section className="card empty-state">
          <p>Nothing matches — the ledger fills in as sync runs.</p>
        </section>
      ) : (
        <div className="media-list">
          {items.map((item) => {
            const disk = onDiskSummary(item);
            return (
              <Link key={item.id} href={`/library/${item.id}`} className="media-card">
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
    </>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LibraryContent />
    </Suspense>
  );
}
