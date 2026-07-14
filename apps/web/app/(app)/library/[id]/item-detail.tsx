'use client';

// DESIGN-005 D-17 / D-15 — the /library/[id] client view: metadata card, the live
// per-episode / per-album list (D-06 ledger.children) with a per-child action —
// Fix when it is on disk (something to repair), Force Search when it is missing
// (nothing to blocklist, just search). Media-hierarchy actions add roll-ups: sonarr
// episodes group into collapsible SEASON sections (each with a season Force Search +
// Fix), and a whole-show / whole-artist Force Search sits in the section header.
// Radarr acts at the movie level in the header. Below: fix history for the item (R-46)
// and the ledger event timeline (R-41).
//
// ADR-028 / DESIGN-005 D-21 — the in-flight LOCK: while an open fix (or a
// just-submitted force search) targets a grain, its action slot renders the LIVE
// phase chip IN PLACE of the buttons — no more clicking Fix into a
// FixAlreadyOpenError toast; the buttons re-arm when the live phase lands a
// terminal. Every slot reserves width (hard rule 9), so button ↔ chip swaps and
// percent ticks never reflow the row.
import { useMemo, useState, type ReactNode } from 'react';
import { trpc } from '@/lib/trpc-client';
import { PhaseChip } from '@hnet/ui';
import { BackLink } from '@/components/back-link';
import {
  ARR_KIND_LABELS,
  EVENT_TYPE_LABELS,
  FIX_REASON_LABELS,
  FIX_STATUS_LABELS,
  RESOLUTION_LABELS,
  fixStatusTone,
  formatBytes,
  formatRating,
  formatRuntime,
  formatWhen,
  groupBySeason,
  onDiskSummary,
  ratingOrNull,
  seasonName,
  type ActionScope,
  type ActionTarget,
  type ArrKindName,
  type SeasonEpisode,
} from '@/lib/media';
import { MediaPoster } from '@/components/cards';
import { NotOnDiskButton } from '@/components/not-on-disk-button';
import { TrashPendingNotice, type TrashAccess } from '@/components/trash-shield';
import { PROTECTED_TAG } from '@/lib/trash';
import {
  ActionLiveChip,
  useActionProgress,
  type ProgressSource,
  type SearchProgressInput,
} from '@/components/action-progress';
import { FixDialog } from './fix-dialog';
import { ForceSearchDialog } from './force-search-dialog';

/** The open dialog: repair (Fix) vs search-only (Force Search), and its scoped target. */
type PendingAction = {
  mode: 'fix' | 'search';
  target: ActionTarget | null;
};

/** Client mirror of @hnet/domain OPEN_FIX_STATUSES (lib/media never imports domain). */
const OPEN_FIX_STATUSES = new Set(['pending', 'actioned', 'search_triggered']);

/** An open fix row as ledger.detail returns it (the lock's data source). */
interface OpenFixRow {
  id: string;
  status: string;
  reason: string;
  pathTaken: string | null;
  targetScope: string;
  targetArrChildId: number | null;
  targetSeason: number | null;
  watchable: boolean;
}

/**
 * One session-key per action grain — force searches leave no durable row (D-20),
 * so the lock tracks the grains this session submitted searches for.
 */
function grainKey(scope: ActionScope, childId?: number | null, seasonNumber?: number | null) {
  return `${scope}:${childId ?? ''}:${seasonNumber ?? ''}`;
}

/** Mirror of the server's default-scope resolution, for session-key normalization. */
function searchInputKey(kind: ArrKindName, input: SearchProgressInput): string {
  let scope = input.scope;
  if (scope === undefined) {
    if (kind === 'radarr') scope = 'item';
    else if (kind === 'sonarr') scope = input.targetChildId !== undefined ? 'episode' : 'show';
    else scope = input.targetChildId !== undefined ? 'album' : 'artist';
  }
  return grainKey(scope, input.targetChildId ?? null, input.seasonNumber ?? null);
}

interface LiveSearch {
  input: SearchProgressInput;
  label: string;
}

/**
 * The reserved action slot (D-21): renders the enabled button(s) by default, the live
 * phase chip while an open fix / in-flight search targets this grain, and — for a fix
 * that landed nothing_found/stalled (its row is still open server-side, so a fresh Fix
 * would only CONFLICT) — the chip plus the re-enabled Force Search button as the retry.
 * The slot's min-width is reserved in CSS for its widest state (hard rule 9).
 */
function ActionSlot({
  fix,
  liveSearch,
  onSearchTerminal,
  onFixTerminal,
  fixButton,
  searchButton,
  className,
}: {
  fix: OpenFixRow | null;
  liveSearch: LiveSearch | null;
  onSearchTerminal: () => void;
  onFixTerminal: () => void;
  fixButton: ReactNode;
  searchButton: ReactNode;
  className?: string;
}) {
  // A session search is the newest signal for the grain; else the caller's own open
  // fix polls live; someone else's open fix renders a static in-flight chip (the
  // progress query is own-or-admin — no leak, and the server lock protects anyway).
  const source: ProgressSource | null =
    liveSearch !== null
      ? { kind: 'search', input: liveSearch.input }
      : fix !== null && fix.watchable
        ? { kind: 'fix', fixRequestId: fix.id }
        : null;
  const live = useActionProgress(source, {
    onTerminal: liveSearch !== null ? onSearchTerminal : onFixTerminal,
  });
  const phase = live.progress?.phase ?? null;

  let content: ReactNode;
  if (source !== null) {
    if (liveSearch === null && (phase === 'completed' || phase === 'failed')) {
      // The fix reached a real terminal — the buttons re-arm.
      content = (
        <>
          {fixButton}
          {searchButton}
        </>
      );
    } else if (liveSearch === null && (phase === 'nothing_found' || phase === 'stalled')) {
      // Never-stuck terminals on an OPEN fix row: a fresh Fix would 409 against the
      // one-open-fix rule, so the retry affordance is the (lock-free) Force Search.
      content = (
        <>
          <ActionLiveChip {...live} />
          {searchButton}
        </>
      );
    } else {
      content = <ActionLiveChip {...live} />;
    }
  } else if (fix !== null) {
    content = (
      <PhaseChip
        phase="in_progress"
        label="Fix in progress"
        tone="info"
        pulse
        title="Someone already has a fix running for this"
      />
    );
  } else {
    content = (
      <>
        {fixButton}
        {searchButton}
      </>
    );
  }

  return <span className={['action-slot', className].filter(Boolean).join(' ')}>{content}</span>;
}

/**
 * PLAN-030 (ADR-048 / DESIGN-005 D-22) — one TV season's episode rows, with each episode's Plex STILL
 * lazily fetched when the season opens (mirrors the ytdl-sub drill-in's per-season episode load — a huge
 * season never pulls art up front). The still merges onto the *arr episode row by episode number; a row
 * whose number has no Plex art (or when the show is unmatched) keeps the tinted still box / no box. Rows
 * are static (ADR-015): the still fades in over its reserved box, never re-orienting neighbors.
 */
function TvSeasonEpisodes({
  mediaItemId,
  seasonNumber,
  episodes,
  open,
  plexArtAvailable,
  renderRow,
}: {
  mediaItemId: string;
  seasonNumber: number;
  episodes: SeasonEpisode[];
  open: boolean;
  plexArtAvailable: boolean;
  renderRow: (ep: SeasonEpisode, stillUrl: string | null) => ReactNode;
}) {
  const art = trpc.ledger.plexEpisodeArt.useQuery(
    { mediaItemId, seasonNumber },
    { enabled: open && plexArtAvailable, refetchOnWindowFocus: false },
  );
  const stillFor = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const e of art.data?.episodes ?? []) map.set(e.episodeNumber, e.stillUrl);
    return map;
  }, [art.data]);
  return (
    <ul className="child-list">
      {episodes.map((ep) =>
        renderRow(ep, ep.episodeNumber !== null ? (stillFor.get(ep.episodeNumber) ?? null) : null),
      )}
    </ul>
  );
}

/** DESIGN-010 D-09 — the caller's Trash access (null when the section is Disabled for them). */
export type ItemTrashAccess = TrashAccess | null;

export function ItemDetail({
  mediaItemId,
  trashAccess = null,
  from = null,
}: {
  mediaItemId: string;
  trashAccess?: ItemTrashAccess;
  /** The `?from=` origin key (resolved server-side; DESIGN-005 D-17). */
  from?: string | null;
}) {
  const utils = trpc.useUtils();
  const [action, setAction] = useState<PendingAction | null>(null);
  // D-21 — force searches leave no durable row, so the grains THIS session searched
  // are tracked here; each keeps its slot locked behind the live chip until terminal.
  const [liveSearches, setLiveSearches] = useState<Record<string, LiveSearch>>({});
  // PLAN-030 — which season <details> are open (episode art loads lazily per open season).
  const [openSeasons, setOpenSeasons] = useState<Record<number, boolean>>({});

  const detail = trpc.ledger.detail.useQuery({ id: mediaItemId });
  const events = trpc.ledger.events.useInfiniteQuery(
    { mediaItemId, limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  const arrKind = detail.data?.item.arrKind;
  const tombstoned = detail.data?.item.tombstonedAt != null;
  const needsChildren = arrKind === 'sonarr' || arrKind === 'lidarr';
  const childNoun = arrKind === 'lidarr' ? 'album' : 'episode';
  const children = trpc.ledger.children.useQuery(
    { mediaItemId },
    { enabled: needsChildren && !tombstoned },
  );

  // Sonarr episodes group into collapsible season sections (media-hierarchy actions).
  const seasons = useMemo(
    () => (arrKind === 'sonarr' ? groupBySeason(children.data ?? []) : []),
    [arrKind, children.data],
  );

  // PLAN-030 (ADR-048) — the show's SEASON POSTERS from the matched Plex title (sonarr only). Keyed by
  // season number to merge onto each groupBySeason row; `available` also gates the per-season episode-still
  // fetches below. Unmatched / inaccessible / Plex-down ⇒ available:false ⇒ no icons (the pre-030 layout).
  const plexSeasons = trpc.ledger.plexSeasons.useQuery(
    { mediaItemId },
    { enabled: arrKind === 'sonarr' && !tombstoned, refetchOnWindowFocus: false },
  );
  const plexArtAvailable = plexSeasons.data?.available === true;
  const seasonPosterFor = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const s of plexSeasons.data?.seasons ?? []) map.set(s.seasonNumber, s.posterUrl);
    return map;
  }, [plexSeasons.data]);

  if (detail.isLoading) return <p className="muted">Loading item…</p>;
  if (detail.error) {
    return (
      <p className="alert" role="alert">
        Failed to load this item: {detail.error.message}
      </p>
    );
  }
  const { item, fixes } = detail.data!;
  const disk = onDiskSummary(item);
  // ledger.detail.metadata is now ALWAYS an object (all-null when unharvested — same shape as
  // search, DESIGN-008 D-09), so the old `metadata !== null` guards are dead. The About card
  // still renders only when it has something to show — gate it on real harvested content.
  const meta = item.metadata;
  const hasAbout =
    ratingOrNull(meta.imdbRating) !== null ||
    ratingOrNull(meta.tmdbRating) !== null ||
    ratingOrNull(meta.rtTomatometer) !== null ||
    ratingOrNull(meta.rtPopcorn) !== null ||
    meta.playCount !== null ||
    meta.lastViewedAt !== null ||
    meta.addedAt !== null ||
    meta.genres.length > 0 ||
    meta.requesters.length > 0 ||
    meta.sourceCollections.length > 0;
  const timeline = events.data?.pages.flatMap((p) => p.events) ?? [];

  // Plain closures (not hooks) — they sit below the loading/error early returns.
  const refresh = () => {
    void utils.ledger.detail.invalidate({ id: mediaItemId });
    void utils.ledger.events.invalidate();
    void utils.ledger.children.invalidate({ mediaItemId });
    void utils.fix.myFixes.invalidate();
  };

  const kindName = item.arrKind as ArrKindName;

  // D-21 lock plumbing — the open fix matching a grain (subtitle fixes excluded:
  // they rest open forever by design and never occupy the *arr pipeline), and the
  // session-search register/clear pair the slots + dialog share.
  const openFixFor = (
    scope: ActionScope,
    childId: number | null = null,
    seasonNumber: number | null = null,
  ): OpenFixRow | null =>
    fixes.find(
      (f) =>
        OPEN_FIX_STATUSES.has(f.status) &&
        f.pathTaken !== 'bazarr_subtitle' &&
        f.reason !== 'missing_subtitles' &&
        f.targetScope === scope &&
        (f.targetArrChildId ?? null) === childId &&
        (f.targetSeason ?? null) === seasonNumber,
    ) ?? null;

  const registerSearch = (search: { input: SearchProgressInput; label: string }) => {
    setLiveSearches((prev) => ({
      ...prev,
      [searchInputKey(kindName, search.input)]: search,
    }));
    refresh();
  };
  const clearSearch = (key: string) => {
    setLiveSearches((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    refresh();
  };
  const liveSearchFor = (
    scope: ActionScope,
    childId: number | null = null,
    seasonNumber: number | null = null,
  ): { key: string; search: LiveSearch } | null => {
    const key = grainKey(scope, childId, seasonNumber);
    const search = liveSearches[key];
    return search !== undefined ? { key, search } : null;
  };

  /** The reserved slot for one grain — buttons by default, live chip while locked. */
  const actionSlot = (input: {
    scope: ActionScope;
    childId?: number | null;
    seasonNumber?: number | null;
    fixButton: ReactNode;
    searchButton: ReactNode;
    className?: string;
  }) => {
    const childId = input.childId ?? null;
    const seasonNumber = input.seasonNumber ?? null;
    const search = liveSearchFor(input.scope, childId, seasonNumber);
    return (
      <ActionSlot
        fix={openFixFor(input.scope, childId, seasonNumber)}
        liveSearch={search?.search ?? null}
        onSearchTerminal={() => {
          if (search !== null) clearSearch(search.key);
        }}
        onFixTerminal={refresh}
        fixButton={input.fixButton}
        searchButton={input.searchButton}
        className={input.className}
      />
    );
  };

  // Shared "children not loaded yet" node (tombstoned / loading / error / empty) — null
  // when the live child list is ready to render.
  const childrenNotReady = tombstoned ? (
    <p className="muted">This item was removed from the manager — nothing to fix.</p>
  ) : children.isLoading ? (
    <p className="muted">Loading {childNoun}s…</p>
  ) : children.error ? (
    <p className="alert" role="alert">
      Could not load the {childNoun} list: {children.error.message}
    </p>
  ) : (children.data ?? []).length === 0 ? (
    <p className="muted">No {childNoun}s found on the manager.</p>
  ) : null;

  // One child row (owner availability rule 2026-07-04): ON DISK → BOTH Fix (repair the
  // grab) and Force Search (just re-grab); MISSING → Force Search only (nothing on disk
  // to blocklist/delete). Force Search is always available; Fix is gated on hasFile.
  // The action pair rides a reserved ActionSlot (D-21): a live fix/search on this
  // child swaps the buttons for its phase chip without moving anything else.
  const childRow = (
    child: { arrChildId: number; label: string; hasFile: boolean },
    scope: 'episode' | 'album',
    // PLAN-030 — when the season's Plex art is available (TV only), each episode reserves a 16:9 still box
    // (the shared `shape="still"` reveal, same as the Peloton drill-in). `url` null ⇒ a tinted box (no
    // icon), NOT rendered at all for albums (still === undefined). ADR-015 reflow-free.
    still?: { url: string | null },
  ) => (
    <li key={child.arrChildId} className="child-row">
      {still !== undefined ? (
        <MediaPoster posterUrl={still.url} kind="show" alt="" shape="still" />
      ) : null}
      <span className="child-row__label">{child.label}</span>
      <span className={`badge badge--${child.hasFile ? 'ok' : 'warn'}`}>
        {child.hasFile ? 'On disk' : 'Missing'}
      </span>
      <span className="child-row__actions">
        {actionSlot({
          scope,
          childId: child.arrChildId,
          fixButton: child.hasFile ? (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                setAction({
                  mode: 'fix',
                  target: { scope, childId: child.arrChildId, label: child.label },
                })
              }
            >
              Fix
            </button>
          ) : null,
          searchButton: (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                setAction({
                  mode: 'search',
                  target: { scope, childId: child.arrChildId, label: child.label },
                })
              }
            >
              Force Search
            </button>
          ),
        })}
      </span>
    </li>
  );

  return (
    <>
      <BackLink from={from} />

      <section className="card detail-head">
        {/* DESIGN-008 D-11 — the fixed 2:3 poster box replaces the kind icon; the KindIcon
            fallback lives inside MediaPoster (null poster / load error), so tombstoned or
            unharvested items still read correctly. */}
        <span className="detail-head__poster">
          <MediaPoster posterUrl={item.posterUrl} kind={item.arrKind} alt="" />
        </span>
        <div className="detail-head__body">
          <h1 className="detail-head__title">
            {item.title}
            {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
          </h1>
          <div className="media-card__badges">
            <span className="badge badge--muted">
              {ARR_KIND_LABELS[item.arrKind as ArrKindName]}
            </span>
            <span className={`badge badge--${disk.tone}`}>{disk.label}</span>
            {!item.monitored ? <span className="badge badge--muted">Not monitored</span> : null}
            {item.tombstonedAt !== null ? (
              <span className="badge badge--danger">Removed from the manager</span>
            ) : null}
            {/* DESIGN-010 D-09 — the Maintainerr-managed protective tag read off arrTags (the
                first-class "protected" signal, addendum b). Display-only: un-saving needs the
                item's Maintainerr id, which only pending rows carry. */}
            {item.arrTags.includes(PROTECTED_TAG) ? (
              <span className="badge badge--shield" data-testid="badge-protected">
                Protected from deletion
              </span>
            ) : null}
          </div>
          {item.metadata.runtimeMinutes !== null || item.metadata.resolution !== null ? (
            <p className="detail-head__meta muted">
              {[
                formatRuntime(item.metadata.runtimeMinutes),
                item.metadata.resolution !== null
                  ? (RESOLUTION_LABELS[item.metadata.resolution] ?? item.metadata.resolution)
                  : null,
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </p>
          ) : null}
          {/* ADR-047 / DESIGN-025 (PLAN-028) — the app-specific "Watch on Plex — <library>" PRIMARY deep
              link(s). Server attaches one per Plex library the caller can access, ONLY for a PRESENT,
              GUID-matched item (a missing/unmatched/inaccessible item gets none). Opens app.plex.tv (hands
              off to the native app where installed); the ↗ marks the external jump. Static affordance — its
              presence is fixed per item, so it never re-orients on interaction (ADR-015). */}
          {item.play.length > 0 ? (
            <p className="detail-head__play">
              {item.play.map((target) => (
                <a
                  key={target.url}
                  className="btn primary"
                  href={target.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {target.label}
                  <span className="btn__ext" aria-hidden="true">
                    {' '}
                    ↗
                  </span>
                </a>
              ))}
            </p>
          ) : !tombstoned && item.onDiskFileCount <= 0 ? (
            // The MISSING counterpart of the play row (DESIGN-025 D-07, owner UX polish 2026-07-11):
            // an item with nothing on disk (the same `onDiskFileCount <= 0` the "Not on disk"/"Wanted"
            // badge reads — for a sonarr show, a WHOLE-show miss; a partial show keeps its per-season
            // grain below) gets a disabled, muted "Not on Disk" pill in the SAME slot as Watch on Plex,
            // with a caption tying it to the page's Force Search. Reserved by the flex column so the
            // on-disk↔missing swap never reflows (ADR-015). Tombstoned items are excluded — they carry
            // their own "Removed from the manager" badge and their Force Search is disabled.
            <NotOnDiskButton hint="Force Search can add this title to your library if a release is found." />
          ) : null}
        </div>
        {/* Radarr acts at the movie level (the movie IS the unit — ADR-007). Sonarr/Lidarr
            act per episode/album below, so the show-level nuke is gone (owner feedback).
            Owner availability rule (2026-07-04): ON DISK → BOTH Fix and Force Search;
            MISSING → Force Search only. */}
        {item.arrKind === 'radarr' ? (
          <div className="detail-head__actions">
            {actionSlot({
              scope: 'item',
              className: 'action-slot--head',
              fixButton:
                item.onDiskFileCount > 0 ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={item.tombstonedAt !== null}
                    onClick={() => setAction({ mode: 'fix', target: null })}
                  >
                    Fix
                  </button>
                ) : null,
              searchButton: (
                <button
                  type="button"
                  className={item.onDiskFileCount > 0 ? 'btn' : 'btn primary'}
                  disabled={item.tombstonedAt !== null}
                  onClick={() => setAction({ mode: 'search', target: null })}
                >
                  Force Search
                </button>
              ),
            })}
          </div>
        ) : null}
      </section>

      {/* DESIGN-010 D-09 / Q-02 (protect-in-context) — the deletion-guard panel: renders ONLY
          when this Movie/TV item is actually in Maintainerr's pending set (the pending row is
          the only place its Maintainerr id exists — we never guess ratingKeys). Music (Lidarr)
          never mounts it (R-87); a Disabled-trash caller has null access. */}
      {trashAccess !== null &&
      (item.arrKind === 'radarr' || item.arrKind === 'sonarr') &&
      item.tombstonedAt === null ? (
        <TrashPendingNotice mediaItemId={item.id} arrKind={item.arrKind} access={trashAccess} />
      ) : null}

      {/* DESIGN-008 D-11 — the harvested metadata block: ratings row, watch stats, and the
          genre / requester / collection chips. Rendered only once the metadata-refresh harvest
          has run for this item; the layout is static — nothing here re-orients on interaction
          (ADR-015). NB: the facts <dl> is `about-facts`, NOT `.meta-grid` — the Details section
          below owns that class (and the e2e suite targets it singularly). */}
      {hasAbout ? (
        <section className="card admin-section">
          <h2>About</h2>
          <div className="ratings-row" role="group" aria-label="Ratings">
            {/* A 0 upstream rating means "unrated" — suppress the pill so no "IMDb 0.0" /
                "RT 0%" renders (DESIGN-008 live-validation fix). */}
            {ratingOrNull(item.metadata.imdbRating) !== null ? (
              <span
                className="rating-pill"
                title={
                  item.metadata.imdbVotes !== null
                    ? `IMDb — ${item.metadata.imdbVotes.toLocaleString()} votes`
                    : 'IMDb rating'
                }
              >
                <span className="rating-pill__src">IMDb</span>
                <span className="rating-pill__val">{formatRating(item.metadata.imdbRating)}</span>
              </span>
            ) : null}
            {ratingOrNull(item.metadata.tmdbRating) !== null ? (
              <span
                className="rating-pill"
                title={
                  item.metadata.tmdbVotes !== null
                    ? `TMDb — ${item.metadata.tmdbVotes.toLocaleString()} votes`
                    : 'TMDb rating'
                }
              >
                <span className="rating-pill__src">TMDb</span>
                <span className="rating-pill__val">{formatRating(item.metadata.tmdbRating)}</span>
              </span>
            ) : null}
            {ratingOrNull(item.metadata.rtTomatometer) !== null ? (
              <span className="rating-pill" title="Rotten Tomatoes tomatometer">
                <span className="rating-pill__src">RT</span>
                <span className="rating-pill__val">{item.metadata.rtTomatometer}%</span>
              </span>
            ) : null}
            {ratingOrNull(item.metadata.rtPopcorn) !== null ? (
              <span className="rating-pill" title="Rotten Tomatoes audience">
                <span className="rating-pill__src">RT Audience</span>
                <span className="rating-pill__val">{item.metadata.rtPopcorn}%</span>
              </span>
            ) : null}
            {ratingOrNull(item.metadata.imdbRating) === null &&
            ratingOrNull(item.metadata.tmdbRating) === null &&
            ratingOrNull(item.metadata.rtTomatometer) === null &&
            ratingOrNull(item.metadata.rtPopcorn) === null ? (
              <span className="muted">No ratings yet.</span>
            ) : null}
          </div>
          <dl className="about-facts">
            {item.metadata.playCount !== null ? (
              <div>
                <dt>Plays</dt>
                <dd>{item.metadata.playCount}</dd>
              </div>
            ) : null}
            {item.metadata.lastViewedAt !== null ? (
              <div>
                <dt>Last watched</dt>
                <dd>{formatWhen(item.metadata.lastViewedAt)}</dd>
              </div>
            ) : null}
            {item.metadata.addedAt !== null ? (
              <div>
                <dt>Added to the manager</dt>
                <dd>{formatWhen(item.metadata.addedAt)}</dd>
              </div>
            ) : null}
          </dl>
          {item.metadata.genres.length > 0 ? (
            <div className="meta-chips">
              <span className="meta-chips__label">Genres</span>
              <span className="chips">
                {item.metadata.genres.map((g) => (
                  <span key={g} className="chip">
                    {g}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {item.metadata.requesters.length > 0 ? (
            <div className="meta-chips">
              <span className="meta-chips__label">Requested by</span>
              <span className="chips">
                {item.metadata.requesters.map((r) => (
                  <span key={r} className="chip chip--requester">
                    {r}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {item.metadata.sourceCollections.length > 0 ? (
            <div className="meta-chips">
              <span className="meta-chips__label">Collections</span>
              <span className="chips">
                {item.metadata.sourceCollections.map((c) => (
                  <span key={c} className="chip">
                    {c}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Sonarr: episodes grouped into collapsible SEASON sections. Each season header
          is a touch target that expands the episode list, and carries a season-level
          Force Search (always) + Fix (when the season has something on disk). The whole
          SHOW gets a Force Search here too — but no whole-show Fix: blocklisting every
          grab of a series is too broad, so on-disk repair stays at season/episode grain
          (owner judgment call — Force Search covers the whole-show "just search" need). */}
      {item.arrKind === 'sonarr' ? (
        <section className="card admin-section">
          <div className="section-head">
            <h2>Episodes</h2>
            {!tombstoned
              ? actionSlot({
                  scope: 'show',
                  className: 'action-slot--roll',
                  fixButton: null,
                  searchButton: (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        setAction({ mode: 'search', target: { scope: 'show', label: item.title } })
                      }
                    >
                      Force Search show
                    </button>
                  ),
                })
              : null}
          </div>
          {childrenNotReady ?? (
            <div className="season-list">
              {seasons.map((s) => {
                const seasonPoster = seasonPosterFor.get(s.seasonNumber) ?? null;
                return (
                <details
                  key={s.seasonNumber}
                  className="season"
                  onToggle={(e) =>
                    setOpenSeasons((prev) => ({
                      ...prev,
                      [s.seasonNumber]: (e.target as HTMLDetailsElement).open,
                    }))
                  }
                >
                  <summary className="season__head">
                    {/* PLAN-030 — the season poster icon from the matched Plex title. Reserved box
                        (ADR-015 reflow-free); no icon when the season has no Plex art / the show is
                        unmatched (the pre-030 layout). */}
                    {seasonPoster !== null ? (
                      <span className="season__poster">
                        <MediaPoster posterUrl={seasonPoster} kind="show" alt="" />
                      </span>
                    ) : null}
                    <span className="season__title">{seasonName(s.seasonNumber)}</span>
                    <span
                      className={`badge badge--${s.onDiskCount >= s.total ? 'ok' : s.onDiskCount > 0 ? 'info' : 'warn'}`}
                    >
                      {s.onDiskCount}/{s.total} on disk
                    </span>
                    <span className="season__actions">
                      {actionSlot({
                        scope: 'season',
                        seasonNumber: s.seasonNumber,
                        fixButton:
                          s.onDiskCount > 0 ? (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={(e) => {
                                e.preventDefault();
                                setAction({
                                  mode: 'fix',
                                  target: {
                                    scope: 'season',
                                    seasonNumber: s.seasonNumber,
                                    label: seasonName(s.seasonNumber),
                                  },
                                });
                              }}
                            >
                              Fix season
                            </button>
                          ) : null,
                        searchButton: (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={(e) => {
                              e.preventDefault();
                              setAction({
                                mode: 'search',
                                target: {
                                  scope: 'season',
                                  seasonNumber: s.seasonNumber,
                                  label: seasonName(s.seasonNumber),
                                },
                              });
                            }}
                          >
                            Force Search
                          </button>
                        ),
                      })}
                    </span>
                  </summary>
                  <TvSeasonEpisodes
                    mediaItemId={mediaItemId}
                    seasonNumber={s.seasonNumber}
                    episodes={s.episodes}
                    open={openSeasons[s.seasonNumber] === true}
                    plexArtAvailable={plexArtAvailable}
                    renderRow={(ep, stillUrl) =>
                      childRow(ep, 'episode', plexArtAvailable ? { url: stillUrl } : undefined)
                    }
                  />
                </details>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {/* Lidarr: albums as a flat list (albums are the fix unit — no per-track scope in
          our design; DESIGN-005 D-06). The whole ARTIST gets a Force Search roll-up. */}
      {item.arrKind === 'lidarr' ? (
        <section className="card admin-section">
          <div className="section-head">
            <h2>Albums</h2>
            {!tombstoned
              ? actionSlot({
                  scope: 'artist',
                  className: 'action-slot--roll',
                  fixButton: null,
                  searchButton: (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        setAction({
                          mode: 'search',
                          target: { scope: 'artist', label: item.title },
                        })
                      }
                    >
                      Force Search artist
                    </button>
                  ),
                })
              : null}
          </div>
          {childrenNotReady ?? (
            <ul className="child-list">
              {(children.data ?? []).map((child) => childRow(child, 'album'))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="card admin-section">
        <h2>Details</h2>
        <dl className="meta-grid">
          <div>
            <dt>Quality profile</dt>
            <dd>{item.qualityProfileName}</dd>
          </div>
          <div>
            <dt>Root folder</dt>
            <dd className="url-cell">{item.rootFolder}</dd>
          </div>
          <div>
            <dt>Size on disk</dt>
            <dd>{item.sizeOnDisk > 0 ? formatBytes(item.sizeOnDisk) : '—'}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>
              {item.onDiskFileCount}/{item.expectedFileCount}
            </dd>
          </div>
          <div>
            <dt>Tags</dt>
            <dd>
              {item.arrTags.length === 0 ? (
                '—'
              ) : (
                <span className="chips">
                  {item.arrTags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>{formatWhen(item.lastSeenAt)}</dd>
          </div>
        </dl>
      </section>

      {fixes.length > 0 ? (
        <section className="card admin-section">
          <h2>Fixes on this item</h2>
          <ul className="fix-list">
            {fixes.map((fix) => (
              <li key={fix.id} className="fix-list__row">
                <span className={`badge badge--${fixStatusTone(fix.status)}`}>
                  {FIX_STATUS_LABELS[fix.status] ?? fix.status}
                </span>
                <span className="fix-list__what">
                  {fix.targetLabel ?? 'Whole item'} — {FIX_REASON_LABELS[fix.reason] ?? fix.reason}
                  {fix.reasonText ? `: ${fix.reasonText}` : ''}
                </span>
                <span className="muted fix-list__when">
                  {fix.requesterDisplayName ?? 'someone'} · {formatWhen(fix.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card admin-section">
        <h2>History</h2>
        {timeline.length === 0 ? (
          <p className="muted">No recorded events yet.</p>
        ) : (
          <ol className="timeline">
            {timeline.map((event) => (
              <li key={event.id}>
                <span className="timeline__type">
                  {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}
                </span>
                <span className="timeline__detail">
                  {typeof event.payload.sourceTitle === 'string' ? event.payload.sourceTitle : null}
                  {event.eventType === 'requested' ? (
                    <> by {event.requestedByDisplayName ?? 'unattributed'}</>
                  ) : null}
                </span>
                <span className="muted timeline__when">
                  {formatWhen(event.occurredAt)} · {event.source}
                </span>
              </li>
            ))}
          </ol>
        )}
        {events.hasNextPage ? (
          <div className="load-more">
            <button
              type="button"
              className="btn sm"
              disabled={events.isFetchingNextPage}
              onClick={() => void events.fetchNextPage()}
            >
              {events.isFetchingNextPage ? 'Loading…' : 'Older events'}
            </button>
          </div>
        ) : null}
      </section>

      <FixDialog
        open={action?.mode === 'fix'}
        onClose={() => setAction(null)}
        item={{ id: item.id, arrKind: item.arrKind, title: item.title }}
        target={action?.mode === 'fix' ? action.target : null}
        onSubmitted={refresh}
      />
      <ForceSearchDialog
        open={action?.mode === 'search'}
        onClose={() => setAction(null)}
        item={{ id: item.id, arrKind: item.arrKind, title: item.title }}
        target={action?.mode === 'search' ? action.target : null}
        onSubmitted={registerSearch}
      />
    </>
  );
}
