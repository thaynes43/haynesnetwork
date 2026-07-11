// ADR-038 / DESIGN-017 (PLAN-022) — the ytdl-sub Library tRPC surface. Read-only reads of the two
// k8plex/HAYNESKUBE ytdl-sub libraries (Peloton, YouTube), surfaced as Library sub-tabs. This content has
// NO *arr and is NEVER synced (Plex is the source of record, ADR-038 C-01) — the router reads the Plex
// server DIRECTLY via the existing read bundle. Sections are resolved by library TITLE (not a hardcoded
// id, ADR-038 C-03), so a renamed/absent library degrades to an empty-state, never a crash.
//   ytdlsub.access    — the caller's own ytdlsub visibility (any authed user).
//   ytdlsub.libraries — the resolved tabs + whether each library was found on the server.
//   ytdlsub.list      — one library's shows (poster-grid rows), gated by `ytdlsubProcedure`.
//   ytdlsub.detail    — DESIGN-017 D-09 (R-132): one show + its seasons (read-only drill-in head).
//   ytdlsub.episodes  — D-09: one season's episodes (lazily fetched per expanded season).
// Drill-in reads are SECTION-CONFINED: the metadata's librarySectionID must match the library's
// resolved section key, so a ratingKey can never browse outside the two gated ytdl-sub libraries.
import { z } from 'zod';
import type { PlexReadClient } from '@hnet/plex/read';
import { PlexHttpError, type PlexSectionItem } from '@hnet/plex';
import { buildPlexWebDeepLink, effectiveAllowedLibrariesForUser } from '@hnet/domain';
import { db as defaultDb, type DbClient } from '@hnet/db';
import { resolvePlexBundle, router, authedProcedure } from '../trpc';
import { effectiveSectionLevel, ytdlsubProcedure } from '../middleware/role';

export const YTDLSUB_LIBRARY_IDS = ['peloton', 'youtube'] as const;
export type YtdlsubLibraryId = (typeof YTDLSUB_LIBRARY_IDS)[number];

/** Owner-friendly labels for the two sub-tabs (the k8plex titles are `HOps Peloton` / `HOps YT`). */
export const YTDLSUB_LIBRARY_LABELS: Record<YtdlsubLibraryId, string> = {
  peloton: 'Peloton',
  youtube: 'YouTube',
};

/** Title matchers — the k8plex libraries are titled `HOps Peloton` and `HOps YT` (OPS-002). */
const LIBRARY_MATCHERS: Record<YtdlsubLibraryId, RegExp> = {
  peloton: /peloton/i,
  youtube: /youtube|\byt\b/i,
};

/** A show row for the poster grid (a "TV Show by Date" show; T-111). */
export interface YtdlsubShow {
  ratingKey: string;
  title: string;
  /** The authed Plex-thumb proxy URL (ADR-038 C-06), or null when the show has no Plex art → fallback tile. */
  posterUrl: string | null;
  seasonCount: number | null; // childCount (Peloton durations / YouTube sub-groups)
  episodeCount: number | null; // leafCount
  year: number | null;
  addedAt: number | null; // epoch secs (for the "recently added" sort)
}

export interface YtdlsubListResult {
  items: YtdlsubShow[];
  /** The library was found on the k8plex server (false ⇒ "not on the server yet" empty-state). */
  found: boolean;
  /** The k8plex server couldn't be reached (⇒ a muted "couldn't reach the library" note). */
  unavailable: boolean;
}

export interface YtdlsubLibrarySummary {
  id: YtdlsubLibraryId;
  label: string;
  found: boolean;
}

// ---- DESIGN-017 D-09 (R-132) — the read-only drill-in shapes ----

export interface YtdlsubShowDetail {
  ratingKey: string;
  title: string;
  summary: string | null;
  posterUrl: string | null; // grid variant (the detail head reuses the wall tile art)
  seasonCount: number | null;
  episodeCount: number | null;
  year: number | null;
  // ADR-047 (PLAN-028) — the "Watch on Plex" deep link for this show (hayneskube machineIdentifier +
  // ratingKey). Always present for an accessible show (ytdl-sub content is Plex-native — never "missing").
  playUrl: string | null;
}

export interface YtdlsubSeason {
  ratingKey: string;
  title: string; // Plex's own season title (Peloton durations render as e.g. "Season 30")
  index: number | null;
  episodeCount: number | null; // leafCount
  // PLAN-030 (DESIGN-017 D-09 amend) — the season poster (`grid` variant) so the season ROW shows its
  // small poster icon (Peloton's restored 5/10/…/120-minute duration posters, PLAN-024). null ⇒ no icon.
  posterUrl: string | null;
}

export interface YtdlsubDetailResult {
  /** false ⇒ no such show in THIS library (bogus ratingKey, or a cross-section probe). */
  found: boolean;
  unavailable: boolean;
  show: YtdlsubShowDetail | null;
  seasons: YtdlsubSeason[];
}

export interface YtdlsubEpisode {
  ratingKey: string;
  title: string;
  index: number | null;
  airDate: string | null; // 'YYYY-MM-DD' (originallyAvailableAt)
  durationMs: number | null;
  /** The `size=still` proxy variant (ADR-041 / T-120), or null → no thumb rendered. */
  stillUrl: string | null;
}

export interface YtdlsubEpisodesResult {
  found: boolean;
  unavailable: boolean;
  episodes: YtdlsubEpisode[];
}

function toShow(item: PlexSectionItem): YtdlsubShow {
  const thumb = item.thumb;
  return {
    ratingKey: item.ratingKey,
    title: item.title,
    posterUrl: thumb ? `/api/ytdlsub/poster?thumb=${encodeURIComponent(thumb)}` : null,
    seasonCount: item.childCount ?? null,
    episodeCount: item.leafCount ?? null,
    year: item.year ?? null,
    addedAt: item.addedAt ?? null,
  };
}

/** Resolve a ytdl-sub library's Plex section key by title. null ⇒ not present on the server. */
async function resolveSectionKey(
  read: PlexReadClient,
  library: YtdlsubLibraryId,
): Promise<string | null> {
  const sections = await read.listSections();
  const match = sections.find((s) => LIBRARY_MATCHERS[library].test(s.title));
  return match ? match.key : null;
}

/**
 * ADR-047 / DESIGN-025 (PLAN-028) — THE INVARIANT for the k8plex ytdl-sub libraries (Peloton/YouTube live
 * on Plex too). A caller may see a library iff their role can access the matching hayneskube Plex library
 * (ADR-024 role_library_grants — resolved off the SAME effective-library resolver Movies/TV/Music use, by
 * name regex). Admin ⇒ both (admin implies all libraries). This is the authoritative content gate; the
 * `ytdlsub` section permission is the coarser visibility knob layered on top.
 */
export async function accessibleYtdlsubLibraries(
  userId: string,
  isAdmin: boolean,
  db: DbClient = defaultDb,
): Promise<Set<YtdlsubLibraryId>> {
  if (isAdmin) return new Set(YTDLSUB_LIBRARY_IDS);
  const libs = await effectiveAllowedLibrariesForUser(userId, db);
  const hits = new Set<YtdlsubLibraryId>();
  for (const lib of libs) {
    if (lib.serverSlug !== 'hayneskube') continue;
    for (const id of YTDLSUB_LIBRARY_IDS) {
      if (LIBRARY_MATCHERS[id].test(lib.name)) hits.add(id);
    }
  }
  return hits;
}

/** A Plex 404 (bogus/foreign ratingKey) — the drill-in maps it to found:false, not unavailable. */
function isPlexNotFound(err: unknown): boolean {
  return err instanceof PlexHttpError && err.status === 404;
}

/** A drill-in ratingKey: Plex ratingKeys are decimal ids. Zod-enforced, belt-and-braces bounded. */
const ratingKeyInput = z.string().regex(/^\d{1,12}$/);

export const ytdlsubRouter = router({
  /** Any authed user: whether the ytdl-sub sub-tabs are visible to them (mirrors metrics.access). */
  access: authedProcedure.query(({ ctx }) => ({
    canSee: effectiveSectionLevel(ctx.user.role, 'ytdlsub') !== 'disabled',
  })),

  /** The two sub-tabs + whether each library was found on k8plex. Degrades to found:false on outage.
   *  ADR-047 — a library the caller's role can't access is reported found:false (hidden, never an
   *  empty-state teaser). */
  libraries: ytdlsubProcedure.query(async ({ ctx }): Promise<{ libraries: YtdlsubLibrarySummary[] }> => {
    const read = resolvePlexBundle(ctx).read.hayneskube;
    const allowed = await accessibleYtdlsubLibraries(ctx.user.id, ctx.user.role.isAdmin, ctx.db);
    let titles: string[] = [];
    try {
      titles = (await read.listSections()).map((s) => s.title);
    } catch {
      titles = []; // server unreachable ⇒ neither library resolves; the tabs still render an empty-state
    }
    return {
      libraries: YTDLSUB_LIBRARY_IDS.map((id) => ({
        id,
        label: YTDLSUB_LIBRARY_LABELS[id],
        found: allowed.has(id) && titles.some((t) => LIBRARY_MATCHERS[id].test(t)),
      })),
    };
  }),

  /** One library's shows for the poster grid. Read-only, bounded; never throws to the client. */
  list: ytdlsubProcedure
    .input(z.object({ library: z.enum(YTDLSUB_LIBRARY_IDS) }))
    .query(async ({ ctx, input }): Promise<YtdlsubListResult> => {
      // ADR-047 THE INVARIANT — a withheld library returns zero items (never even hits Plex).
      const allowed = await accessibleYtdlsubLibraries(ctx.user.id, ctx.user.role.isAdmin, ctx.db);
      if (!allowed.has(input.library)) return { items: [], found: false, unavailable: false };
      const read = resolvePlexBundle(ctx).read.hayneskube;
      let sectionKey: string | null;
      try {
        sectionKey = await resolveSectionKey(read, input.library);
      } catch {
        return { items: [], found: false, unavailable: true }; // couldn't list sections
      }
      if (sectionKey === null) return { items: [], found: false, unavailable: false };
      try {
        const items = await read.listSectionContents(sectionKey);
        return { items: items.map(toShow), found: true, unavailable: false };
      } catch {
        return { items: [], found: true, unavailable: true }; // library exists but read failed
      }
    }),

  /**
   * DESIGN-017 D-09 (R-132) — one show + its seasons for the read-only drill-in. SECTION-CONFINED:
   * the show's librarySectionID must match the library's resolved section key (a Music/other-section
   * ratingKey ⇒ found:false, never data). Degrades like list: 404 ⇒ found:false, outage ⇒ unavailable.
   */
  detail: ytdlsubProcedure
    .input(z.object({ library: z.enum(YTDLSUB_LIBRARY_IDS), ratingKey: ratingKeyInput }))
    .query(async ({ ctx, input }): Promise<YtdlsubDetailResult> => {
      const notFound: YtdlsubDetailResult = { found: false, unavailable: false, show: null, seasons: [] };
      // ADR-047 THE INVARIANT — a withheld library's drill-in is indistinguishable from not-found.
      const allowed = await accessibleYtdlsubLibraries(ctx.user.id, ctx.user.role.isAdmin, ctx.db);
      if (!allowed.has(input.library)) return notFound;
      const read = resolvePlexBundle(ctx).read.hayneskube;
      let sectionKey: string | null;
      try {
        sectionKey = await resolveSectionKey(read, input.library);
      } catch {
        return { ...notFound, unavailable: true };
      }
      if (sectionKey === null) return notFound;
      try {
        const meta = await read.getMetadataItem(input.ratingKey);
        if (meta === null || meta.librarySectionId !== sectionKey) return notFound; // confinement
        const children = await read.listMetadataChildren(input.ratingKey);
        const item = meta.item;
        return {
          found: true,
          unavailable: false,
          show: {
            ratingKey: item.ratingKey,
            title: item.title,
            summary: item.summary?.trim() ? item.summary : null,
            posterUrl: item.thumb
              ? `/api/ytdlsub/poster?thumb=${encodeURIComponent(item.thumb)}`
              : null,
            seasonCount: item.childCount ?? null,
            episodeCount: item.leafCount ?? null,
            year: item.year ?? null,
            // ADR-047 Q-D — "Watch on Plex" for this show (hayneskube machineIdentifier + ratingKey).
            playUrl: buildPlexWebDeepLink(read.machineIdentifier, item.ratingKey),
          },
          seasons: children.items
            .filter((c) => c.type === 'season')
            .map((c) => ({
              ratingKey: c.ratingKey,
              title: c.title,
              index: c.index ?? null,
              episodeCount: c.leafCount ?? null,
              // PLAN-030 — the season poster icon for the row (same authed proxy + `grid` variant as the
              // show tile). Peloton season art is the restored duration posters (PLAN-024); null ⇒ no icon.
              posterUrl: c.thumb
                ? `/api/ytdlsub/poster?thumb=${encodeURIComponent(c.thumb)}&size=grid`
                : null,
            }))
            .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER)),
        };
      } catch (err) {
        if (isPlexNotFound(err)) return notFound;
        return { ...notFound, found: true, unavailable: true };
      }
    }),

  /**
   * D-09 — one season's episodes, fetched lazily when the season expands (a 261-episode Peloton
   * season never loads up front). Same section confinement via the children container's
   * librarySectionID; episode stills ride the `size=still` proxy variant (ADR-041 / T-120).
   */
  episodes: ytdlsubProcedure
    .input(z.object({ library: z.enum(YTDLSUB_LIBRARY_IDS), seasonRatingKey: ratingKeyInput }))
    .query(async ({ ctx, input }): Promise<YtdlsubEpisodesResult> => {
      const notFound: YtdlsubEpisodesResult = { found: false, unavailable: false, episodes: [] };
      // ADR-047 THE INVARIANT — no episode leaks from a withheld library.
      const allowed = await accessibleYtdlsubLibraries(ctx.user.id, ctx.user.role.isAdmin, ctx.db);
      if (!allowed.has(input.library)) return notFound;
      const read = resolvePlexBundle(ctx).read.hayneskube;
      let sectionKey: string | null;
      try {
        sectionKey = await resolveSectionKey(read, input.library);
      } catch {
        return { ...notFound, unavailable: true };
      }
      if (sectionKey === null) return notFound;
      try {
        const children = await read.listMetadataChildren(input.seasonRatingKey);
        if (children.librarySectionId !== sectionKey) return notFound; // confinement
        return {
          found: true,
          unavailable: false,
          episodes: children.items
            .filter((c) => c.type === 'episode')
            .map((c) => ({
              ratingKey: c.ratingKey,
              title: c.title,
              index: c.index ?? null,
              airDate: c.originallyAvailableAt ?? null,
              durationMs: c.duration ?? null,
              stillUrl: c.thumb
                ? `/api/ytdlsub/poster?thumb=${encodeURIComponent(c.thumb)}&size=still`
                : null,
            })),
        };
      } catch (err) {
        if (isPlexNotFound(err)) return notFound;
        return { ...notFound, found: true, unavailable: true };
      }
    }),
});
