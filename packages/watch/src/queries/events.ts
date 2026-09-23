// DESIGN-049 D-07/D-09 — Watch Event reads. SELECT only.
import { watchEvents, type DbClient, type PlexServerSlug, type WatchEventRow } from '@hnet/db';
import { and, eq, isNotNull, isNull, inArray, or, sql, type SQL } from 'drizzle-orm';
import { normalizeTitle } from '../normalize';
import type { WatchKind } from '../types';

/** Every event of the owner (the `watch` sync's input — a few thousand rows). */
export async function selectAccountEvents(db: DbClient, plexAccountId: number): Promise<WatchEventRow[]> {
  return db.select().from(watchEvents).where(eq(watchEvents.plexAccountId, plexAccountId));
}

/**
 * The events of ONE title (the Watch Mark write-through and live revalidation recompute its event facts).
 * Shows: the episodes whose `show_guid` is the show's Plex guid, plus guid-less episodes (a show Tautulli
 * could not resolve, Q-06) whose normalized show title is the title's. Movies: the plays whose item guid is
 * the movie's, plus guid-less plays with the same normalized title and year.
 */
export async function selectTitleEvents(
  db: DbClient,
  plexAccountId: number,
  t: { kind: WatchKind; plexGuid: string | null; title: string; year: number | null },
): Promise<WatchEventRow[]> {
  const norm = normalizeTitle(t.title).norm;
  if (t.kind === 'show') {
    const guidless = await db
      .selectDistinct({ showTitle: watchEvents.showTitle })
      .from(watchEvents)
      .where(
        and(
          eq(watchEvents.plexAccountId, plexAccountId),
          eq(watchEvents.kind, 'episode'),
          isNull(watchEvents.showGuid),
          isNotNull(watchEvents.showTitle),
        ),
      );
    const titles = guidless
      .map((r) => r.showTitle)
      .filter((s): s is string => s !== null && normalizeTitle(s).norm === norm);
    const match: SQL[] = [];
    if (t.plexGuid) match.push(eq(watchEvents.showGuid, t.plexGuid));
    if (titles.length > 0) {
      match.push(and(isNull(watchEvents.showGuid), inArray(watchEvents.showTitle, titles)) as SQL);
    }
    if (match.length === 0) return [];
    return db
      .select()
      .from(watchEvents)
      .where(
        and(eq(watchEvents.plexAccountId, plexAccountId), eq(watchEvents.kind, 'episode'), or(...match)),
      );
  }
  const guidless = await db
    .selectDistinct({ title: watchEvents.title, year: watchEvents.year })
    .from(watchEvents)
    .where(
      and(
        eq(watchEvents.plexAccountId, plexAccountId),
        eq(watchEvents.kind, 'movie'),
        or(isNull(watchEvents.itemGuid), sql`${watchEvents.itemGuid} NOT LIKE 'plex://movie/%'`),
      ),
    );
  const sameYear = (year: number | null) => t.year === null || year === null || year === t.year;
  const titles = [
    ...new Set(
      guidless.filter((r) => normalizeTitle(r.title).norm === norm && sameYear(r.year)).map((r) => r.title),
    ),
  ];
  const match: SQL[] = [];
  if (t.plexGuid) match.push(eq(watchEvents.itemGuid, t.plexGuid));
  if (titles.length > 0) {
    match.push(
      and(
        or(isNull(watchEvents.itemGuid), sql`${watchEvents.itemGuid} NOT LIKE 'plex://movie/%'`),
        inArray(watchEvents.title, titles),
      ) as SQL,
    );
  }
  if (match.length === 0) return [];
  const rows = await db
    .select()
    .from(watchEvents)
    .where(and(eq(watchEvents.plexAccountId, plexAccountId), eq(watchEvents.kind, 'movie'), or(...match)));
  // The title filter above is by name only; a guid-less play of a same-name movie of another year is not
  // this title.
  return rows.filter(
    (r) => (t.plexGuid !== null && r.itemGuid === t.plexGuid) || sameYear(r.year),
  );
}

/** Show guids already known for (instance, grandparent key) pairs — the D-09 "first in stored events". */
export async function selectKnownShowGuids(
  db: DbClient,
  plexAccountId: number,
  instance: PlexServerSlug,
  grandparentKeys: readonly string[],
): Promise<Map<string, string>> {
  if (grandparentKeys.length === 0) return new Map();
  const rows = await db
    .selectDistinct({ key: watchEvents.grandparentRatingKey, guid: watchEvents.showGuid })
    .from(watchEvents)
    .where(
      and(
        eq(watchEvents.plexAccountId, plexAccountId),
        eq(watchEvents.instance, instance),
        inArray(watchEvents.grandparentRatingKey, [...grandparentKeys]),
        isNotNull(watchEvents.showGuid),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) if (r.key && r.guid) out.set(r.key, r.guid);
  return out;
}

/**
 * DESIGN-049 Q-06 (driver ruling) — the (instance, grandparent key) pairs whose episodes still have a NULL
 * `show_guid` and were ingested since `since`, at most `limit`, in an order that rotates with `salt` (a
 * truly gone show must not starve the others: each run asks a different slice).
 */
export async function selectUnresolvedShowPairs(
  db: DbClient,
  plexAccountId: number,
  opts: { since: Date; limit: number; salt: string },
): Promise<Array<{ instance: PlexServerSlug; grandparentRatingKey: string }>> {
  const rows = await db
    .select({ instance: watchEvents.instance, key: watchEvents.grandparentRatingKey })
    .from(watchEvents)
    .where(
      and(
        eq(watchEvents.plexAccountId, plexAccountId),
        eq(watchEvents.kind, 'episode'),
        isNull(watchEvents.showGuid),
        isNotNull(watchEvents.grandparentRatingKey),
        sql`${watchEvents.ingestedAt} > ${opts.since}`,
      ),
    )
    .groupBy(watchEvents.instance, watchEvents.grandparentRatingKey)
    .orderBy(sql`md5(${watchEvents.instance} || ':' || ${watchEvents.grandparentRatingKey} || ':' || ${opts.salt})`)
    .limit(opts.limit);
  return rows.flatMap((r) => (r.key ? [{ instance: r.instance, grandparentRatingKey: r.key }] : []));
}
