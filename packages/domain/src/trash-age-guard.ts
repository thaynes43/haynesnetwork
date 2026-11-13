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
//
// ADR-119 / DESIGN-052 D-31 — when the audited setting `age_guard_ignore_library_fill` is on, and that *arr's first
// download import in the ledger is at least 180 days old, a library-fill Plex date is left out of the newest date
// when another server already has a strictly older date in a library whose type fits the title. The setting defaults
// off. Off, and a ledger that does not yet cover the whole window, leave every stamp in place. A pool member with
// no Plex match is `unknown` (kept) with the setting on or off: that is the one change here that alters today's
// behaviour, and it only ever keeps more.
import { ledgerEvents, mediaPlexMatches, plexLibraries, type DbClient } from '@hnet/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getAppSetting, setAppSetting } from './app-settings';
import { resolveDb } from './db-client';

/** The window: a title whose newest date is younger than this many days is never deleted. */
export const TRASH_AGE_GUARD_DAYS = 180;

const DAY_MS = 86_400_000;

/** The *arr history events that count as a file arriving (a download or an upgrade). Folder imports do not count. */
export const DOWNLOAD_IMPORT_EVENT_TYPES = ['downloadFolderImported'] as const;

/**
 * ADR-119 / DESIGN-052 D-31 — the audited switch. Absent or any non-boolean row ⇒ off, which is D-26's date
 * selection. On, and only when that *arr's ledger covers the whole window: a library-fill Plex date does not count
 * when another server has a strictly older date in a library of the fitting type.
 */
export const AGE_GUARD_LIBRARY_FILL_SETTING = 'age_guard_ignore_library_fill' as const;

/**
 * The audited way to set the switch and to set it back. `setAppSetting` writes the row and the
 * `update_app_setting` audit row in one transaction. A non-boolean is refused here; a stored non-boolean still
 * reads as off through `getAppSetting`. This does not turn the setting on by itself.
 */
export async function setAgeGuardIgnoreLibraryFill(input: {
  db?: DbClient;
  enabled: boolean;
  actorId: string | null;
}): Promise<{ changed: boolean; before: boolean; after: boolean }> {
  if (typeof input.enabled !== 'boolean') {
    throw new TypeError('age_guard_ignore_library_fill accepts only a boolean');
  }
  return setAppSetting({
    db: input.db,
    key: AGE_GUARD_LIBRARY_FILL_SETTING,
    value: input.enabled,
    actorId: input.actorId,
  });
}

/**
 * A library-day is a fill only at or above this many titles. The adversarial review of PR 1067 (2026-11-13, replica
 * `postgres16-11`, the review's SQL with `minT` varied) measured the same 389-show and 40-movie verdicts for every
 * cutoff from 13 through 232. At 12, 46 movies change; at 9, 65; at 8, 70. The two HaynesOps TV fill days are 638
 * and 232. 100 also leaves out the 2026-05-05 movie day (39 titles, outside the window).
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
  /**
   * The library's type fits the title: a movie library for Radarr, a show library for Sonarr. A stamp that does
   * not fit never counts as the older date on another server (ADR-119). It can still be a stamp of its own.
   */
  fitsTitle: boolean;
}

/** Radarr is a movie title; Sonarr is a show. Any other library type, including a missing one, does not fit. */
export function libraryFitsTitle(arrKind: 'radarr' | 'sonarr', mediaType: string | null): boolean {
  if (arrKind === 'radarr') return mediaType === 'movie';
  return mediaType === 'show';
}

/**
 * The ledger covers the Age Guard's window when its first download import is at least `windowDays` old. A missing
 * first import does not cover it. Compared the same way as `judgeAge`: a date younger than the window is still
 * inside it (`now - first < window`), so the first import must be at or beyond the boundary.
 */
export function ledgerCoversAgeWindow(
  firstImportAt: Date | null,
  nowMs: number,
  windowDays: number = TRASH_AGE_GUARD_DAYS,
): boolean {
  if (firstImportAt === null) return false;
  return nowMs - firstImportAt.getTime() >= windowDays * DAY_MS;
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
 * date, that older stamp's library fits the title, and this stamp has no download import within 6 hours. A
 * wrong-type stamp never supplies that older date. The oldest dated stamp that can retire another always stays:
 * nothing fitting is strictly older than it. A title on one server, or whose other server is not dated older in
 * a fitting library, keeps every stamp.
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
          other.fitsTitle &&
          other.serverId !== stamp.serverId &&
          other.addedAt.getTime() < stamp.addedAt.getTime(),
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
 * - `unknown` — it cannot be judged (not in our ledger, a Plex library holds it that the sync has not dated yet,
 *               as on every match until the first plex-match run after migration 0086, or no Plex library is
 *               matched to it and no download import inside the window already kept it): the sweep keeps it
 *               `unevaluable`, as the guardian does with anything it cannot clear (P4). A pool member with no
 *               `media_plex_matches` row used to be `clear`, on the comment that Maintainerr's HaynesOps
 *               date-added clause still covered it. DESIGN-014 D-15 removes that clause for TV. `unknown` keeps
 *               the title instead. This holds with the library-fill setting on or off, and it only ever keeps more.
 */
export type TrashAgeGuard = 'recent' | 'clear' | 'unknown';

export interface AgeEvidence {
  /** Newest download import (new or upgrade) in the ledger's *arr history; null when there is none. */
  newestImportAt: Date | null;
  /**
   * Newest Plex `addedAt` that counts. With the library-fill setting off, or when that *arr's ledger does not
   * cover the window, the newest across every matched library. With the setting on and the ledger covering
   * (ADR-119), a library-fill stamp is left out when another server has a strictly older date in a fitting library.
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
  // No matched library, or a match the sync has not dated: keep the title. A recent import already returned above.
  if (evidence.plexMatches === 0 || evidence.plexUndated > 0) {
    return { ageGuard: 'unknown', newestAddedAt };
  }
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
 * either read gets `{ null, null, 0, 0 }` (no import, no Plex match), which judges `unknown` unless a later import
 * inside the window makes it `recent`. The library-fill setting is read once per call. A sweep reads it once per
 * batch and kind, Expedite once per call, a wall page once per page. Those are separate statements, not one
 * snapshot: a change between two batches of one run applies to the second.
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

  // ADR-119. Off (the default, and any non-boolean row) returns the D-26 dates above unchanged.
  // One read per pending read, not a snapshot shared with the next batch.
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
 * dated match, and an undated match still makes a non-recent title `unknown`. A dated stamp stays unless a
 * fitting older stamp on another server retires it. A wrong-type stamp never supplies that older date.
 */
async function applyLibraryFill(
  db: DbClient,
  out: Map<string, AgeEvidence>,
  ids: string[],
  arrKind: 'radarr' | 'sonarr',
): Promise<void> {
  // Leave every stamp in place until this *arr's own ledger can see the whole window. The other *arr's history
  // does not count. A show's Plex date does not move when an episode arrives, so an import the ledger cannot
  // see is the only evidence, and removing the stamp would drop that protection.
  const firstResult = await db.execute(sql`
    SELECT min(occurred_at) AS first_import
    FROM ledger_events
    WHERE event_type = 'imported'
      AND payload->>'rawEventType' = 'downloadFolderImported'
      AND source = ${arrKind}
  `);
  const firstImport = asDate(resultRows(firstResult)[0]?.first_import as Date | string | null);
  if (!ledgerCoversAgeWindow(firstImport, Date.now())) return;

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
      mediaType: plexLibraries.mediaType,
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
      fitsTitle: libraryFitsTitle(arrKind, row.mediaType),
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
