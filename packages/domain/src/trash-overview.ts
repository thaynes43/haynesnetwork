// DESIGN-010 amendment (2026-07-08) — the Trash OVERVIEW read: a single light aggregate that backs
// the new default landing tab AND the Movies/TV count badges. It COMPOSES the existing reads (never
// re-queries what they already answer): the per-kind slated summary, the open-batch lifecycle, and
// the recent Recently-Deleted / Activity heads. One card per kind (Movies, TV) so a TV-only deletion
// window can never hide behind an empty Movies tab (owner rationale: aggregate before navigating).
//
//   • slated summary — an OPEN batch owns the number: its still-`pending` count + frozen pendingBytes
//     (from listBatches — DB-sourced, always available). With NO open batch the number is the LIVE
//     candidate read (listTrashPending). That live read needs Maintainerr; when it fails (unreachable
//     / unsafe) the kind degrades to `live: false` (count unknown, NOT zero) rather than erroring the
//     whole landing — the SafetyBanner is the authoritative health mirror, this stays quietly honest.
//   • recent strip — the newest few Recently-Deleted rows (both kinds, merged newest-first) + the
//     newest few trash/maintainerr Activity events. Heads only; the tabs carry the full lists.
import {
  TRASH_BATCH_OPEN_STATES,
  TRASH_MEDIA_KINDS,
  type DbClient,
  type TrashBatchState,
  type TrashMediaKind,
} from '@hnet/db';
import { resolveDb } from './db-client';
import type { MaintainerrClientBundle } from './maintainerr-clients';
import { listBatches } from './trash-batches';
import { countTrashPending, listRecentlyDeleted, type TrashMedia } from './trash-flow';
import { listNotifications } from './notifications';

/** One kind card's data (Movies, TV). */
export interface TrashOverviewKind {
  kind: TrashMediaKind;
  /** Items slated for deletion: an open batch's still-`pending` count, else the live candidate count. */
  slatedCount: number;
  /** Bytes the slated set would free ("frees 114 GB"). Batch → frozen pendingBytes; else live total. */
  reclaimableBytes: number;
  /** false ⇒ NO open batch AND the live candidate read failed (Maintainerr down) — count is UNKNOWN,
   *  not zero. Always true when a batch is open (the numbers are DB-sourced). */
  live: boolean;
  /** The open batch's lifecycle facts, or null when no batch is open for this kind. */
  batch: { state: TrashBatchState; expiresAt: string | null; pendingCount: number } | null;
}

/** A Recently-Deleted head row (the recent strip). */
export interface TrashOverviewDeleted {
  mediaItemId: string;
  title: string;
  year: number | null;
  media: TrashMedia;
  sizeOnDisk: number;
  deletedAt: string | null;
  deletedBy: string | null;
}

/** An Activity head row (the recent strip). */
export interface TrashOverviewEvent {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface TrashOverview {
  kinds: TrashOverviewKind[];
  recentlyDeleted: TrashOverviewDeleted[];
  activity: TrashOverviewEvent[];
}

const OPEN_STATES = TRASH_BATCH_OPEN_STATES as readonly TrashBatchState[];

/**
 * DESIGN-010 amendment — the Trash Overview aggregate. Read-only; composes existing domain reads.
 * `recentLimit` bounds BOTH strip heads (default 4 — the cards are the stars, the strip is light).
 */
export async function getTrashOverview(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  recentLimit?: number;
}): Promise<TrashOverview> {
  const db = resolveDb(input.db);
  const recentLimit = input.recentLimit ?? 4;

  // One batch list for both kinds; the first open batch per kind is that kind's live lifecycle
  // (the ≤1-open-per-kind invariant means "first" is unambiguous — listBatches is newest-first).
  const batches = await listBatches({ db });
  const openByKind = new Map<TrashMediaKind, (typeof batches)[number]>();
  for (const b of batches) {
    if (OPEN_STATES.includes(b.state) && !openByKind.has(b.mediaKind)) openByKind.set(b.mediaKind, b);
  }

  const kinds: TrashOverviewKind[] = [];
  for (const kind of TRASH_MEDIA_KINDS) {
    const open = openByKind.get(kind);
    if (open !== undefined) {
      kinds.push({
        kind,
        slatedCount: open.counts.pending,
        reclaimableBytes: open.pendingBytes,
        live: true,
        batch: { state: open.state, expiresAt: open.expiresAt, pendingCount: open.counts.pending },
      });
      continue;
    }
    // No open batch → the LIVE candidate count. CHEAP path (owner-directed 2026-07-09): count +
    // bytes come straight off Maintainerr's flat set (no ledger join, no per-item exclusion reads)
    // and share the paginated read's brief memo, so the Overview never full-scans the expensive
    // path per load. Degrade (never throw) when Maintainerr can't answer — the landing must render
    // for every OTHER kind + the recent strip.
    try {
      const pending = await countTrashPending({ maintainerr: input.maintainerr, media: kind });
      kinds.push({
        kind,
        slatedCount: pending.count,
        reclaimableBytes: pending.totalSizeBytes,
        live: true,
        batch: null,
      });
    } catch {
      kinds.push({ kind, slatedCount: 0, reclaimableBytes: 0, live: false, batch: null });
    }
  }

  const [deletedMovie, deletedTv, activity] = await Promise.all([
    listRecentlyDeleted({ db, media: 'movie', limit: recentLimit }),
    listRecentlyDeleted({ db, media: 'tv', limit: recentLimit }),
    listNotifications({ db, sources: ['maintainerr', 'trash'], limit: recentLimit }),
  ]);

  const recentlyDeleted: TrashOverviewDeleted[] = [
    ...deletedMovie.map((r) => ({ ...r, media: 'movie' as const })),
    ...deletedTv.map((r) => ({ ...r, media: 'tv' as const })),
  ]
    .map((r) => ({
      mediaItemId: r.mediaItemId,
      title: r.title,
      year: r.year,
      media: r.media,
      sizeOnDisk: r.sizeOnDisk,
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy,
    }))
    .sort((a, b) => {
      const ax = a.deletedAt === null ? 0 : Date.parse(a.deletedAt);
      const bx = b.deletedAt === null ? 0 : Date.parse(b.deletedAt);
      return bx - ax;
    })
    .slice(0, recentLimit);

  return {
    kinds,
    recentlyDeleted,
    activity: activity.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      createdAt: n.createdAt,
    })),
  };
}
