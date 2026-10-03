// DESIGN-052 D-26 — the Trash Age Guard (owner ruling 2026-10-03, "Yes, newest date wins"). Trash never deletes a
// title that was downloaded, upgraded or added to any Plex server in the last 180 days. The guard takes the NEWEST of
// two dates and judges the title by it:
//   • the newest DOWNLOAD import in the ledger's synced *arr history (`ledger_events`, event `imported`, raw
//     `downloadFolderImported`): a new download or an upgrade. For TV the ledger row is the series, so any episode
//     imported in the window protects the series the pool holds.
//   • the newest Plex "date added" across every Plex library holding the title (`media_plex_matches.plex_added_at`,
//     stamped by the hourly plex-match sync from each server's `addedAt`).
// Neither the *arr's own `added` date nor its file's `dateAdded` is read: the 2026-07-03 Radarr rebuild re-added 8,988
// movies from files already on disk that hour, which stamped both on nearly every movie. Folder imports
// (`movieFolderImported` / `seriesFolderImported`, the shape a library scan or rebuild re-add takes) never count either:
// only a download import says a file arrived. The guard is enforced by the app at batch build and at the sweep, so it
// holds even when the Maintainerr rules drift. Read-only; no writes here.
import { ledgerEvents, mediaPlexMatches, type DbClient } from '@hnet/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { resolveDb } from './db-client';

/** The window: a title whose newest date is younger than this many days is never deleted. */
export const TRASH_AGE_GUARD_DAYS = 180;

/** The *arr history events that count as a file arriving (a download or an upgrade). Folder imports do not count. */
export const DOWNLOAD_IMPORT_EVENT_TYPES = ['downloadFolderImported'] as const;

/**
 * The Age Guard's verdict for one pending item:
 * - `recent`  — the newest date is inside the window: kept (`recently_added`), never proposed.
 * - `clear`   — every Plex library holding it is dated and the newest date (import or Plex) is older than the window.
 *               A title no Plex library is matched to has no Plex date to read; it is judged on its imports alone
 *               (the Maintainerr rule's own HaynesOps date-added clause still applies to it).
 * - `unknown` — it cannot be judged (not in our ledger, or a Plex library holds it that the sync has not dated yet,
 *               as on every match until the first plex-match run after migration 0086): the sweep keeps it
 *               `unevaluable`, as the guardian does with anything it cannot clear (P4).
 */
export type TrashAgeGuard = 'recent' | 'clear' | 'unknown';

export interface AgeEvidence {
  /** Newest download import (new or upgrade) in the ledger's *arr history; null when there is none. */
  newestImportAt: Date | null;
  /** Newest Plex `addedAt` across the matched libraries; null when none is dated. */
  newestPlexAddedAt: Date | null;
  /** How many Plex libraries hold the title (media_plex_matches rows). */
  plexMatches: number;
  /** Of `plexMatches`, how many carry no date yet (the sync has not stamped them, or Plex omitted `addedAt`). */
  plexUndated: number;
}

export interface AgeJudgement {
  ageGuard: TrashAgeGuard;
  /** The newest of the import and Plex dates (ISO), whichever won; null when neither exists. */
  newestAddedAt: string | null;
}

const DAY_MS = 86_400_000;

const newer = (a: Date | null, b: Date | null): Date | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
};

/** Judge one item's evidence. A recent date wins over anything unknown: one fresh signal is enough to keep it. */
export function judgeAge(
  evidence: AgeEvidence | undefined,
  nowMs: number,
  windowDays: number = TRASH_AGE_GUARD_DAYS,
): AgeJudgement {
  if (evidence === undefined) return { ageGuard: 'unknown', newestAddedAt: null };
  const newest = newer(evidence.newestImportAt, evidence.newestPlexAddedAt);
  const newestAddedAt = newest === null ? null : newest.toISOString();
  if (newest !== null && nowMs - newest.getTime() < windowDays * DAY_MS) {
    return { ageGuard: 'recent', newestAddedAt };
  }
  if (evidence.plexUndated > 0) return { ageGuard: 'unknown', newestAddedAt };
  return { ageGuard: 'clear', newestAddedAt };
}

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Read the Age Guard's evidence for a set of ledger items of one *arr kind: two grouped reads (the newest download
 * import per item, and the newest Plex date plus the dated/undated match counts per item). An id with no row in
 * either read gets `{ null, null, 0, 0 }` (no import, no Plex match), which judges `clear`.
 */
export async function loadAgeEvidence(input: {
  db?: DbClient;
  arrKind: 'radarr' | 'sonarr';
  mediaItemIds: readonly string[];
}): Promise<Map<string, AgeEvidence>> {
  const out = new Map<string, AgeEvidence>();
  const ids = [...new Set(input.mediaItemIds)];
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { newestImportAt: null, newestPlexAddedAt: null, plexMatches: 0, plexUndated: 0 });
  const db = resolveDb(input.db);

  const imports = await db
    .select({
      mediaItemId: ledgerEvents.mediaItemId,
      newest: sql<Date | string | null>`max(${ledgerEvents.occurredAt})`,
    })
    .from(ledgerEvents)
    .where(
      and(
        inArray(ledgerEvents.mediaItemId, ids),
        eq(ledgerEvents.eventType, 'imported'),
        eq(ledgerEvents.source, input.arrKind),
        inArray(sql<string>`${ledgerEvents.payload}->>'rawEventType'`, [...DOWNLOAD_IMPORT_EVENT_TYPES]),
      ),
    )
    .groupBy(ledgerEvents.mediaItemId);
  for (const r of imports) {
    if (r.mediaItemId === null) continue;
    const e = out.get(r.mediaItemId);
    if (e) e.newestImportAt = asDate(r.newest);
  }

  const plex = await db
    .select({
      mediaItemId: mediaPlexMatches.mediaItemId,
      newest: sql<Date | string | null>`max(${mediaPlexMatches.plexAddedAt})`,
      total: sql<number>`count(*)::int`,
      dated: sql<number>`count(${mediaPlexMatches.plexAddedAt})::int`,
    })
    .from(mediaPlexMatches)
    .where(inArray(mediaPlexMatches.mediaItemId, ids))
    .groupBy(mediaPlexMatches.mediaItemId);
  for (const r of plex) {
    const e = out.get(r.mediaItemId);
    if (!e) continue;
    e.newestPlexAddedAt = asDate(r.newest);
    e.plexMatches = Number(r.total);
    e.plexUndated = Number(r.total) - Number(r.dated);
  }
  return out;
}

export type AgeGuardVerdict = { keep: true; reason: 'recently_added' | 'unevaluable' } | { keep: false };

/**
 * The sweep's Age Guard verdict (D-26), checked after the guardian: `recent` keeps the item `recently_added`, `unknown`
 * keeps it `unevaluable` (we never delete what we cannot clear), `clear` lets it through.
 */
export function classifyAgeGuard(item: { ageGuard: TrashAgeGuard }): AgeGuardVerdict {
  if (item.ageGuard === 'recent') return { keep: true, reason: 'recently_added' };
  if (item.ageGuard === 'unknown') return { keep: true, reason: 'unevaluable' };
  return { keep: false };
}
