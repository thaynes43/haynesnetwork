// ADR-117 / DESIGN-052 D-29 (owner ruling 2026-11-13) — the Release Name Check: does the app's own database hold a
// verified posted release name for a pending movie's file on disk? Trash deletes a title only when it does, so the
// pending wall, the batch builder and the guardian all read this one verdict and never offer, propose or pass a
// title the delete path would keep.
//
// It is the database's view (the ledger and the legacy tables; no *arr read, so a wall of hundreds of titles costs
// three grouped reads). The delete path (`identifyRelease`, release-block.ts) reads the *arr's own file record and
// decides again; it can only keep MORE (a file replaced outside the *arr's history, a name with no term). A movie is
// `verified` when:
//   • it has no file on disk (nothing there to fetch again); or
//   • the ledger names its import: its newest download import (`imported`, never a folder import) carries a release
//     name, its own or its grab's (the same `downloadId`); or
//   • a legacy file record of its TMDB id has the IDENTICAL byte size (`media_items.size_on_disk`, never a ratio)
//     and an original release name.
// Anything else is `unverified`: only the name Radarr rebuilt when it renamed the file is known. A series is
// `unchecked` here (it has many files and the database holds no per-file size): the delete path decides it from
// Sonarr's files (Q-23). Read-only.
import { ledgerEvents, legacyReleaseNames, mediaItems, type DbClient } from '@hnet/db';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { resolveDb } from './db-client';

/**
 * The Release Name Check's verdict for one pending item:
 * - `verified`   — the database can name the file on disk (or there is none).
 * - `unverified` — it cannot: kept `release_unverified`, never proposed, never offered by the default wall.
 * - `unchecked`  — not judged here (a series; an item with no ledger row, which the guardian keeps anyway).
 */
export type TrashReleaseName = 'verified' | 'unverified' | 'unchecked';

/** *arr history events that are a library scan, not a download: their name is the renamed file, not a posted name. */
export const FOLDER_IMPORT_EVENT_TYPES = ['movieFolderImported', 'seriesFolderImported'] as const;

const IDS_PER_READ = 1_000;

/** The Release Name Check for a set of ledger items of one *arr kind (see the file header for the rule). */
export async function loadReleaseNameStates(input: {
  db?: DbClient;
  arrKind: 'radarr' | 'sonarr';
  mediaItemIds: readonly string[];
}): Promise<Map<string, TrashReleaseName>> {
  const out = new Map<string, TrashReleaseName>();
  const ids = [...new Set(input.mediaItemIds)];
  if (input.arrKind !== 'radarr') {
    for (const id of ids) out.set(id, 'unchecked');
    return out;
  }
  const db = resolveDb(input.db);
  const grab = alias(ledgerEvents, 'grab');
  const named = (column: unknown) =>
    sql`(btrim(coalesce(${column}, '')) <> '' AND position('://' in coalesce(${column}, '')) = 0)`;
  for (let at = 0; at < ids.length; at += IDS_PER_READ) {
    const chunk = ids.slice(at, at + IDS_PER_READ);
    const items = await db
      .select({ id: mediaItems.id, files: mediaItems.onDiskFileCount })
      .from(mediaItems)
      .where(inArray(mediaItems.id, chunk));
    for (const item of items) out.set(item.id, item.files > 0 ? 'unverified' : 'verified');

    // The newest download import of each item, and whether it (or its grab) carries a release name.
    const imports = await db
      .selectDistinctOn([ledgerEvents.mediaItemId], {
        id: ledgerEvents.mediaItemId,
        named: sql<boolean>`(${named(sql`${ledgerEvents.payload}->>'sourceTitle'`)} OR EXISTS (
          SELECT 1 FROM ${ledgerEvents} AS ${grab}
          WHERE ${grab.mediaItemId} = ${ledgerEvents.mediaItemId}
            AND ${grab.eventType} = 'grabbed'
            AND ${grab.payload}->>'downloadId' = ${ledgerEvents.payload}->>'downloadId'
            AND ${named(sql`${grab.payload}->>'sourceTitle'`)}
        ))`,
      })
      .from(ledgerEvents)
      .where(
        and(
          inArray(ledgerEvents.mediaItemId, chunk),
          eq(ledgerEvents.eventType, 'imported'),
          sql`coalesce(${ledgerEvents.payload}->>'rawEventType', '') NOT IN (${sql.join(
            FOLDER_IMPORT_EVENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
          )})`,
        ),
      )
      .orderBy(ledgerEvents.mediaItemId, desc(ledgerEvents.occurredAt), desc(ledgerEvents.id));
    for (const row of imports) {
      if (row.id !== null && row.named === true && out.has(row.id)) out.set(row.id, 'verified');
    }

    // A legacy file record of the same TMDB id with the identical byte size and an original release name.
    const legacy = await db
      .selectDistinct({ id: mediaItems.id })
      .from(mediaItems)
      .innerJoin(
        legacyReleaseNames,
        and(
          eq(legacyReleaseNames.arrKind, 'radarr'),
          eq(legacyReleaseNames.recordKind, 'file'),
          eq(legacyReleaseNames.externalId, mediaItems.tmdbId),
          eq(legacyReleaseNames.sizeBytes, mediaItems.sizeOnDisk),
        ),
      )
      .where(and(inArray(mediaItems.id, chunk), gt(mediaItems.sizeOnDisk, 0)));
    for (const row of legacy) out.set(row.id, 'verified');
  }
  return out;
}
