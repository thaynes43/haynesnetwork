// ADR-038 / DESIGN-017 (PLAN-022) — the ytdl-sub Library tRPC surface. Read-only reads of the two
// k8plex/HAYNESKUBE ytdl-sub libraries (Peloton, YouTube), surfaced as Library sub-tabs. This content has
// NO *arr and is NEVER synced (Plex is the source of record, ADR-038 C-01) — the router reads the Plex
// server DIRECTLY via the existing read bundle. Sections are resolved by library TITLE (not a hardcoded
// id, ADR-038 C-03), so a renamed/absent library degrades to an empty-state, never a crash.
//   ytdlsub.access    — the caller's own ytdlsub visibility (any authed user).
//   ytdlsub.libraries — the resolved tabs + whether each library was found on the server.
//   ytdlsub.list      — one library's shows (poster-grid rows), gated by `ytdlsubProcedure`.
import { z } from 'zod';
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexSectionItem } from '@hnet/plex';
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

export const ytdlsubRouter = router({
  /** Any authed user: whether the ytdl-sub sub-tabs are visible to them (mirrors metrics.access). */
  access: authedProcedure.query(({ ctx }) => ({
    canSee: effectiveSectionLevel(ctx.user.role, 'ytdlsub') !== 'disabled',
  })),

  /** The two sub-tabs + whether each library was found on k8plex. Degrades to found:false on outage. */
  libraries: ytdlsubProcedure.query(async ({ ctx }): Promise<{ libraries: YtdlsubLibrarySummary[] }> => {
    const read = resolvePlexBundle(ctx).read.hayneskube;
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
        found: titles.some((t) => LIBRARY_MATCHERS[id].test(t)),
      })),
    };
  }),

  /** One library's shows for the poster grid. Read-only, bounded; never throws to the client. */
  list: ytdlsubProcedure
    .input(z.object({ library: z.enum(YTDLSUB_LIBRARY_IDS) }))
    .query(async ({ ctx, input }): Promise<YtdlsubListResult> => {
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
});
