// DESIGN-052 D-26 — the Trash Age Guard (owner ruling 2026-10-03, "Yes, newest date wins"). Trash never deletes a
// title that was downloaded, upgraded or added to any Plex server in the last 180 days. The guard takes the NEWEST of
// two dates and judges the title by it.
// ADR-117 / DESIGN-052 D-29 — when the audited setting `age_guard_ignore_library_fill` is on, a library-fill Plex
// date is not the newest date if another server already has an older one. The setting defaults off, and off is this
// file's original rule with no fill query.
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
import { ledgerEvents, mediaPlexMatches, plexLibraries, type DbClient } from '@hnet/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getAppSetting } from './app-settings';
import { resolveDb } from './db-client';

/** The window: a title whose newest date is younger than this many days is never deleted. */
export const TRASH_AGE_GUARD_DAYS = 180;

/** The *arr history events that count as a file arriving (a download or an upgrade). Folder imports do not count. */
export const DOWNLOAD_IMPORT_EVENT_TYPES = ['downloadFolderImported'] as const;

/**
 * ADR-117 / DESIGN-052 D-29 — the audited switch. Absent or any non-boolean row ⇒ off, which is D-26 unchanged.
 * On: a library-fill Plex date does not count when another server has a strictly older date.
 */
export const AGE_GUARD_LIBRARY_FILL_SETTING = 'age_guard_ignore_library_fill' as const;

/**
 * A library-day is a fill only at or above this many titles. Measured 2026-11-13 (replica `postgres16-11`): the two
 * HaynesOps TV fill days are 638 and 232; the next HaynesOps TV day is 8; in-window movie days of 69–141 all have a
 * download import within 6 hours. Any cutoff from 9 through 232 labels the same in-window show days. 100 also leaves
 * out the 2026-05-05 movie day (39 titles, outside the window).
 */
export const LIBRARY_FILL_MIN_TITLES = 100;

/** Near-imports / titles at most 1/20 (5%). Compared in integers: `near * DENOMINATOR <= titles * NUMERATOR`. */
export const LIBRARY_FILL_SHARE_NUMERATOR = 1;
export const LIBRARY_FILL_SHARE_DENOMINATOR = 20;

/** A download import this close to a title's own added date counts as near that stamp, and keeps the stamp. */
export const LIBRARY_FILL_NEAR_MS = 6 * 60 * 60 * 1000;

/** The household calendar. Both July 2026 fill days clear the size cutoff in this zone; UTC would merge them. */
export const LIBRARY_FILL_DAY_TIME_ZONE = 'America/New_York';

/** One Plex library's added date, plus whether the library-fill rule may retire it. */
export interface LibraryFillStamp {
  serverId: string;
  addedAt: Date | null;
  /** This stamp's library-day met `isLibraryFillDay`. */
  fillDay: boolean;
  /** A download import within `LIBRARY_FILL_NEAR_MS` of `addedAt`. */
  nearImport: boolean;
}

/**
 * A library-day (one Plex library, one America/New_York date) whose titles arrived together and almost none of them
 * have a download import within 6 hours. False on a non-integer, a short day, or a day of real imports.
 */
export function isLibraryFillDay(titles: number, nearImports: number): boolean {
  if (!Number.isInteger(titles) || !Number.isInteger(nearImports)) return false;
  if (titles < LIBRARY_FILL_MIN_TITLES || nearImports < 0) return false;
  return nearImports * LIBRARY_FILL_SHARE_DENOMINATOR <= titles * LIBRARY_FILL_SHARE_NUMERATOR;
}

/**
 * The newest Plex date that still counts. A fill stamp is skipped when a different server has a strictly older
 * date and this stamp has no download import within 6 hours. The oldest dated stamp always stays: nothing is
 * strictly older than it. A title on one server, or whose other server is not dated older, keeps every stamp.
 */
export function eligiblePlexAddedAt(stamps: readonly LibraryFillStamp[]): Date | null {
  const dated = stamps.filter((s): s is LibraryFillStamp & { addedAt: Date } => s.addedAt !== null);
  let best: Date | null = null;
  for (const stamp of dated) {
    const blocked =
      stamp.fillDay &&
      !stamp.nearImport &&
      dated.some(
        (other) =>
          other.serverId !== stamp.serverId && other.addedAt.getTime() < stamp.addedAt.getTime(),
      );
    if (blocked) continue;
    if (best === null || stamp.addedAt.getTime() > best.getTime()) best = stamp.addedAt;
  }
  return best;
}

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
  /**
   * Newest Plex `addedAt` that counts. With the library-fill setting off, the newest across every matched library.
   * With it on (ADR-117), a library-fill stamp is left out when another server has a strictly older date.
   */
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
  for (const id of ids)
    out.set(id, { newestImportAt: null, newestPlexAddedAt: null, plexMatches: 0, plexUndated: 0 });
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
        inArray(sql<string>`${ledgerEvents.payload}->>'rawEventType'`, [
          ...DOWNLOAD_IMPORT_EVENT_TYPES,
        ]),
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

  // ADR-117. Off (the default, and any non-boolean row) returns the D-26 evidence above unchanged.
  if ((await getAppSetting(db, AGE_GUARD_LIBRARY_FILL_SETTING)) !== true) return out;
  await applyLibraryFill(db, out, ids, input.arrKind);
  return out;
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * Replace `newestPlexAddedAt` with the eligible date. Match counts stay as read: an ignored fill stamp is still a
 * dated match, and an undated match still makes a non-recent title `unknown`. The oldest dated stamp is always
 * eligible, so a title that had a date still has one.
 */
async function applyLibraryFill(
  db: DbClient,
  out: Map<string, AgeEvidence>,
  ids: string[],
  arrKind: 'radarr' | 'sonarr',
): Promise<void> {
  const fillResult = await db.execute(sql`
    SELECT m.plex_library_id AS library_id,
           to_char((m.plex_added_at AT TIME ZONE ${LIBRARY_FILL_DAY_TIME_ZONE})::date, 'YYYY-MM-DD') AS day_key,
           count(*)::int AS titles,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1
             FROM ledger_events e
             INNER JOIN media_items mi ON mi.id = m.media_item_id
             WHERE e.media_item_id = m.media_item_id
               AND e.event_type = 'imported'
               AND e.payload->>'rawEventType' = 'downloadFolderImported'
               AND e.source = CASE mi.arr_kind WHEN 'radarr' THEN 'radarr' WHEN 'sonarr' THEN 'sonarr' ELSE '' END
               AND abs(extract(epoch FROM (e.occurred_at - m.plex_added_at))) <= ${LIBRARY_FILL_NEAR_MS / 1000}
           ))::int AS near_imports
    FROM media_plex_matches m
    INNER JOIN plex_libraries l ON l.id = m.plex_library_id
    WHERE l.media_type IN ('movie', 'show')
      AND m.plex_added_at IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) >= ${LIBRARY_FILL_MIN_TITLES}
  `);
  const fillKeys = new Set<string>();
  for (const row of resultRows(fillResult)) {
    const titles = Number(row.titles);
    const near = Number(row.near_imports);
    if (!isLibraryFillDay(titles, near)) continue;
    fillKeys.add(`${String(row.library_id)}|${String(row.day_key)}`);
  }

  const matches = await db
    .select({
      mediaItemId: mediaPlexMatches.mediaItemId,
      serverId: plexLibraries.serverId,
      libraryId: mediaPlexMatches.plexLibraryId,
      addedAt: mediaPlexMatches.plexAddedAt,
      dayKey: sql<
        string | null
      >`to_char((${mediaPlexMatches.plexAddedAt} AT TIME ZONE ${LIBRARY_FILL_DAY_TIME_ZONE})::date, 'YYYY-MM-DD')`,
    })
    .from(mediaPlexMatches)
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .where(inArray(mediaPlexMatches.mediaItemId, ids));

  const imports = await db
    .select({ mediaItemId: ledgerEvents.mediaItemId, occurredAt: ledgerEvents.occurredAt })
    .from(ledgerEvents)
    .where(
      and(
        inArray(ledgerEvents.mediaItemId, ids),
        eq(ledgerEvents.eventType, 'imported'),
        eq(ledgerEvents.source, arrKind),
        inArray(sql<string>`${ledgerEvents.payload}->>'rawEventType'`, [
          ...DOWNLOAD_IMPORT_EVENT_TYPES,
        ]),
      ),
    );
  const importsByItem = new Map<string, Date[]>();
  for (const row of imports) {
    if (row.mediaItemId === null) continue;
    const at = asDate(row.occurredAt);
    if (at === null) continue;
    const list = importsByItem.get(row.mediaItemId);
    if (list) list.push(at);
    else importsByItem.set(row.mediaItemId, [at]);
  }
  const isNear = (mediaItemId: string, added: Date): boolean => {
    const list = importsByItem.get(mediaItemId);
    if (list === undefined) return false;
    const t = added.getTime();
    return list.some((at) => Math.abs(at.getTime() - t) <= LIBRARY_FILL_NEAR_MS);
  };

  const byItem = new Map<string, LibraryFillStamp[]>();
  for (const row of matches) {
    const added = asDate(row.addedAt);
    const dayKey = row.dayKey === null || row.dayKey === undefined ? null : String(row.dayKey);
    const stamp: LibraryFillStamp = {
      serverId: row.serverId,
      addedAt: added,
      fillDay: added !== null && dayKey !== null && fillKeys.has(`${row.libraryId}|${dayKey}`),
      nearImport: added !== null && isNear(row.mediaItemId, added),
    };
    const list = byItem.get(row.mediaItemId);
    if (list) list.push(stamp);
    else byItem.set(row.mediaItemId, [stamp]);
  }
  for (const [id, stamps] of byItem) {
    const evidence = out.get(id);
    if (!evidence) continue;
    evidence.newestPlexAddedAt = eligiblePlexAddedAt(stamps);
  }
}
