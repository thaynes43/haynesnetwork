'use client';

// DESIGN-017 D-09 (R-132) — the ytdl-sub READ-ONLY drill-in: show → seasons → episodes, read live from
// k8plex via ytdlsub.detail / ytdlsub.episodes (no ledger, no actions, no write surface). Reuses the
// /library/[id] visual language verbatim: BackLink, the `.card.detail-head` (2:3 MediaPoster + title +
// badges), and the sonarr `.season` <details> grammar. Episodes load LAZILY per expanded season
// (`enabled` on open — a 261-episode Peloton season never loads up front) and render as `.epi-row`s:
// a reserved 16:9 still (the ADR-041 `size=still` proxy variant, fading in — ADR-015 reflow-free),
// title, and a muted "date · duration" line. <details> expansion is the sanctioned ADR-015 in-place
// exception (the same one the sonarr seasons use).
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/media-poster';
import { formatDay, formatRuntime } from '@/lib/media';
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

/** The reserved 16:9 still box — the shared .poster-img fade-in over the tinted box. */
function EpisodeStill({ stillUrl, alt }: { stillUrl: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    setLoaded(imgRef.current?.complete === true);
  }, [stillUrl]);
  return (
    <span className="epi-still" aria-hidden={stillUrl === null || failed ? 'true' : undefined}>
      {stillUrl !== null && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- authed proxy route, not a static asset
        <img
          ref={imgRef}
          className={`poster-img${loaded ? ' is-loaded' : ''}`}
          src={stillUrl}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}

/** One season's lazily-loaded episode list (queried only once the season has been opened). */
function SeasonEpisodes({
  library,
  season,
  open,
}: {
  library: YtdlsubLibraryId;
  season: YtdlsubSeason;
  open: boolean;
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
  return (
    <ul className="epi-list">
      {data.episodes.map((ep) => {
        const meta = episodeMeta(ep);
        return (
          <li key={ep.ratingKey} className="epi-row">
            <EpisodeStill stillUrl={ep.stillUrl} alt="" />
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

  const countParts: string[] = [];
  if (show.seasonCount !== null) {
    countParts.push(`${show.seasonCount} ${show.seasonCount === 1 ? 'season' : 'seasons'}`);
  }
  if (show.episodeCount !== null) {
    countParts.push(`${show.episodeCount} ${show.episodeCount === 1 ? 'episode' : 'episodes'}`);
  }

  return (
    <>
      <BackLink from={library} />

      <section className="card detail-head" data-testid="ytdlsub-detail-head">
        <span className="detail-head__poster">
          <MediaPoster posterUrl={show.posterUrl} kind="show" alt="" />
        </span>
        <div className="detail-head__body">
          <h1 className="detail-head__title">
            {show.title}
            {show.year !== null ? <span className="muted"> ({show.year})</span> : null}
          </h1>
          <div className="media-card__badges">
            <span className="badge badge--muted">{label}</span>
            {countParts.length > 0 ? <span className="badge">{countParts.join(' · ')}</span> : null}
          </div>
          {show.summary !== null ? <p className="detail-head__meta muted">{show.summary}</p> : null}
        </div>
      </section>

      <section className="card admin-section">
        <h2>Seasons</h2>
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
                    <span className="season__title">{season.title}</span>
                    {season.episodeCount !== null ? (
                      <span className="badge badge--muted">
                        {season.episodeCount} {season.episodeCount === 1 ? 'episode' : 'episodes'}
                      </span>
                    ) : null}
                  </summary>
                  <SeasonEpisodes library={library} season={season} open={open} />
                </details>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
