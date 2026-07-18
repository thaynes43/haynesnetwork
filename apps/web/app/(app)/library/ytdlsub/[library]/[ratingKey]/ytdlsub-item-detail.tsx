'use client';

// DESIGN-017 D-09 (R-132) — the ytdl-sub READ-ONLY drill-in: show → seasons → episodes, read live from
// k8plex via ytdlsub.detail / ytdlsub.episodes (no ledger, no actions, no write surface). Reuses the
// /library/[id] visual language verbatim: BackLink, the `.card.detail-head` (2:3 MediaPoster + title +
// badges), and the sonarr `.season` <details> grammar. Episodes load LAZILY per expanded season
// (`enabled` on open — a 261-episode Peloton season never loads up front) and render as `.epi-row`s:
// a reserved 16:9 still (the ADR-041 `size=still` proxy variant, fading in — ADR-015 reflow-free),
// title, and a muted "date · duration" line. <details> expansion is the sanctioned ADR-015 in-place
// exception (the same one the sonarr seasons use).
import { useState } from 'react';
import {
  arrowFor,
  cmpNum,
  cmpStr,
  nextSort,
  sortRowsClientSide,
  MediaHero,
  ConsumeLink,
  type FieldSpec,
  type MediaHeroBadge,
} from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/cards';
import { NotOnDiskButton } from '@/components/not-on-disk-button';
import { formatDay, formatRuntime, formatSeasonEpisodeCounts } from '@/lib/media';
import { registryFor, type ViewLevelKey } from '@/lib/library-view-registry';
import type { YtdlsubEpisode, YtdlsubSeason } from '@hnet/api';

type YtdlsubLibraryId = 'peloton' | 'youtube';

const LIBRARY_LABELS: Record<YtdlsubLibraryId, string> = {
  peloton: 'Peloton',
  youtube: 'YouTube',
};

/** "date · duration" — omits whichever half is absent; null when neither exists. */
function episodeMeta(ep: YtdlsubEpisode): string | null {
  const parts: string[] = [];
  // airDate is date-ONLY ('YYYY-MM-DD'); bare Date parsing reads it as UTC midnight, which
  // renders as the PREVIOUS day in western timezones — pin it to local midnight instead.
  if (ep.airDate !== null) parts.push(formatDay(`${ep.airDate}T00:00:00`));
  const runtime = ep.durationMs !== null ? formatRuntime(Math.round(ep.durationMs / 60_000)) : null;
  if (runtime !== null) parts.push(runtime);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ADR-051 / DESIGN-026 D-02 (PLAN-029 step 2) — the EPISODE level's registry-declared sort keys
// (R5 asymmetry made visible: a class/video answers its date, number, title and duration — none of
// which the discipline/channel wall above can). Applied client-side within each season's loaded
// list; session-local (the per-user preference stores the WALL's sort — a drill-in sort is a
// transient refinement).
const EPISODE_SORT_FIELDS: Record<string, Omit<FieldSpec<YtdlsubEpisode>, 'dir'>> = {
  index: { get: (ep) => ep.index, compare: cmpNum },
  // 'YYYY-MM-DD' — lexical order IS chronological order.
  air_date: { get: (ep) => ep.airDate, compare: cmpStr },
  title: { get: (ep) => ep.title, compare: cmpStr },
  duration: { get: (ep) => ep.durationMs, compare: cmpNum },
};

/** One season's lazily-loaded episode list (queried only once the season has been opened). */
function SeasonEpisodes({
  library,
  season,
  open,
  sortToken,
}: {
  library: YtdlsubLibraryId;
  season: YtdlsubSeason;
  open: boolean;
  /** The episode-level `field:dir` token (shared across the seasons — one control above them). */
  sortToken: string;
}) {
  const episodes = trpc.ytdlsub.episodes.useQuery(
    { library, seasonRatingKey: season.ratingKey },
    { enabled: open, refetchOnWindowFocus: false },
  );

  if (!open) return null;
  if (episodes.isLoading) return <p className="muted epi-list">Loading episodes…</p>;
  if (episodes.error) {
    return (
      <p className="alert epi-list" role="alert">
        Could not load this season: {episodes.error.message}
      </p>
    );
  }
  const data = episodes.data;
  if (data === undefined || data.unavailable) {
    return <p className="muted epi-list">Couldn’t reach the library right now — try again shortly.</p>;
  }
  if (!data.found || data.episodes.length === 0) {
    return <p className="muted epi-list">No episodes found for this season.</p>;
  }
  const [field, dir] = sortToken.split(':') as [string, 'asc' | 'desc'];
  const spec = EPISODE_SORT_FIELDS[field];
  const sorted =
    spec === undefined
      ? data.episodes
      : sortRowsClientSide(data.episodes, sortToken, {
          fields: { [sortToken]: { ...spec, dir } },
          tiebreaker: (a, b) => cmpNum(a.index ?? 0, b.index ?? 0),
        });
  return (
    <ul className="epi-list">
      {sorted.map((ep) => {
        const meta = episodeMeta(ep);
        return (
          <li key={ep.ratingKey} className="epi-row">
            {/* the shared MediaPoster reveal in its 16:9 `still` shape (DESIGN-017 D-09) */}
            <MediaPoster posterUrl={ep.stillUrl} kind="show" alt="" shape="still" />
            <span className="epi-row__body">
              <span className="epi-row__title">{ep.title}</span>
              {meta !== null ? <span className="epi-row__meta muted">{meta}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function YtdlsubItemDetail({
  library,
  ratingKey,
}: {
  library: YtdlsubLibraryId;
  ratingKey: string;
}) {
  const label = LIBRARY_LABELS[library];
  // Which seasons have been opened (episodes query mounts on first open and stays warm after).
  const [openSeasons, setOpenSeasons] = useState<Record<string, boolean>>({});
  // PLAN-029 — the episode-level sort (registry-declared; default = the natural episode order).
  const epEntry = registryFor(`${library}:episode` as ViewLevelKey);
  const [epSortToken, setEpSortToken] = useState(
    `${epEntry.defaultSort.field}:${epEntry.defaultSort.dir}`,
  );
  const epClickCycle = Object.fromEntries(
    epEntry.sorts.map((c) => [
      c.key,
      c.firstDir === 'asc'
        ? { asc: `${c.key}:asc`, desc: `${c.key}:desc` }
        : { asc: `${c.key}:desc`, desc: `${c.key}:asc` },
    ]),
  ) as Record<string, { asc: string; desc: string }>;
  const epArrowCycle = Object.fromEntries(
    epEntry.sorts.map((c) => [c.key, { asc: `${c.key}:asc`, desc: `${c.key}:desc` }]),
  ) as Record<string, { asc: string; desc: string }>;

  const detail = trpc.ytdlsub.detail.useQuery(
    { library, ratingKey },
    { refetchOnWindowFocus: false },
  );

  if (detail.isLoading) {
    return (
      <>
        <BackLink from={library} />
        <p className="muted">Loading…</p>
      </>
    );
  }
  if (detail.error) {
    return (
      <>
        <BackLink from={library} />
        <p className="alert" role="alert">
          Failed to load this show: {detail.error.message}
        </p>
      </>
    );
  }
  const data = detail.data!;
  if (data.unavailable) {
    return (
      <>
        <BackLink from={library} />
        <section className="card empty-state" data-testid="ytdlsub-detail-unavailable">
          <p className="muted">Couldn’t reach the {label} library right now — try again shortly.</p>
        </section>
      </>
    );
  }
  if (!data.found || data.show === null) {
    return (
      <>
        <BackLink from={library} />
        <section className="card empty-state" data-testid="ytdlsub-detail-missing">
          <p className="muted">This show isn’t in the {label} library.</p>
        </section>
      </>
    );
  }
  const { show, seasons } = data;
  const counts = formatSeasonEpisodeCounts(show.seasonCount, show.episodeCount);
  // DESIGN-004 D-24 (ADR-071) — the shared <MediaHero>: poster, title/year, typed badges, the
  // summary meta and the consume/missing row are slots (no hand-rolled `.detail-head*`). ytdl-sub
  // has no Fix/Force-Search, so there is no action bar.
  const heroBadges: MediaHeroBadge[] = [
    { label, tone: 'muted' },
    ...(counts !== null ? [{ label: counts }] : []),
  ];

  return (
    <>
      <BackLink from={library} />

      <MediaHero
        testId="ytdlsub-detail-head"
        poster={<MediaPoster posterUrl={show.posterUrl} kind="show" alt="" />}
        title={show.title}
        year={show.year}
        badges={heroBadges}
        meta={show.summary !== null ? show.summary : undefined}
        // ADR-047 / DESIGN-025 — "Watch on Plex" deep link. ytdl-sub content is Plex-native (never
        // "missing"), so an accessible show normally carries a playUrl; the shared <ConsumeLink>
        // keeps the ↗ / target / rel identical to the *arr pages.
        consume={
          show.playUrl !== null ? (
            <ConsumeLink label="Watch on Plex" url={show.playUrl} />
          ) : undefined
        }
        // Consistency (DESIGN-025 D-07): a rare accessible show with no playUrl gets the SAME
        // disabled "Not on Disk" pill — WITHOUT a Force-Search caption (ytdl-sub has no Force Search).
        secondary={show.playUrl === null ? <NotOnDiskButton /> : undefined}
      />

      <section className="card admin-section">
        <h2>Seasons</h2>
        {/* PLAN-029 (DESIGN-026 D-02) — the EPISODE-level sort row: the drill-in's classes/videos
            answer date/number/title/duration (dimensions the wall above can't — R5). Applies within
            each opened season's list; the shared fixed-arrow `.sort-btn` idiom (ADR-015). */}
        {seasons.length > 0 ? (
          <div className="library-sortbar" role="group" aria-label="Sort episodes">
            <span className="library-sortbar__label">Sort episodes</span>
            {epEntry.sorts.map((c) => {
              const isActive = epSortToken.startsWith(`${c.key}:`);
              return (
                <button
                  key={c.key}
                  type="button"
                  className={`sort-btn${isActive ? ' is-active' : ''}`}
                  aria-pressed={isActive}
                  onClick={() =>
                    setEpSortToken(nextSort<string, string>(epSortToken, c.key, epClickCycle))
                  }
                >
                  {c.label}
                  <span className="sort-btn__arrow" aria-hidden="true">
                    {arrowFor<string, string>(epSortToken, c.key, epArrowCycle).trim()}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {seasons.length === 0 ? (
          <p className="muted">No seasons found on the server.</p>
        ) : (
          <div className="season-list">
            {seasons.map((season) => {
              const open = openSeasons[season.ratingKey] === true;
              return (
                <details
                  key={season.ratingKey}
                  className="season"
                  onToggle={(e) =>
                    setOpenSeasons((prev) => ({
                      ...prev,
                      [season.ratingKey]: (e.target as HTMLDetailsElement).open,
                    }))
                  }
                >
                  <summary className="season__head">
                    {/* PLAN-030 — the season poster icon (the restored Peloton duration posters).
                        Reserved box (ADR-015 reflow-free); absent art keeps the pre-030 no-icon row. */}
                    {season.posterUrl !== null ? (
                      <span className="season__poster">
                        <MediaPoster posterUrl={season.posterUrl} kind="show" alt="" />
                      </span>
                    ) : null}
                    <span className="season__title">{season.title}</span>
                    {season.episodeCount !== null ? (
                      <span className="badge badge--muted">
                        {season.episodeCount} {season.episodeCount === 1 ? 'episode' : 'episodes'}
                      </span>
                    ) : null}
                  </summary>
                  <SeasonEpisodes
                    library={library}
                    season={season}
                    open={open}
                    sortToken={epSortToken}
                  />
                </details>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
