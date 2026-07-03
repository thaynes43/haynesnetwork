// DESIGN-005 D-15 — the Fix flow orchestrator (ADR-007, AC-07/AC-08). Lives in
// packages/domain so the mutating *arr surface (@hnet/arr/write) stays confined to
// this package (D-12/D-18 guard). Sequence:
//
//   1. validate item + resolve the live child target/label (read-only lookups);
//   2. createFixRequest — pending row + 'fix_requested' event in ONE tx, BEFORE any
//      mutating *arr call (a crash mid-fix leaves an admin-visible pending row);
//   3. resolve the latest grab from LIVE *arr history;
//   4. primary path (AC-07): POST history/failed/{grabId} (blocklist) — or the
//      fallback (AC-08): delete the file(s) — then recordFixAction → 'actioned';
//   5. POST /command (EpisodeSearch | MoviesSearch | AlbumSearch) → 'search_triggered'.
//
// Every step's outcome (endpoint, status, response ids) is appended to
// fix_requests.actions_taken; any *arr failure lands 'failed' + a 'fix_failed' event
// and re-throws as ArrUpstreamError (D-17).
import { mediaItems, type DbClient, type FixPath, type FixReason, type FixStatus } from '@hnet/db';
import type { FixActionEntry } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { ArrError, ArrHttpError } from '@hnet/arr';
import { ArrUpstreamError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { resolveDb } from './db-client';
import { createFixRequest, recordFixAction } from './fix-requests';
import { arrApiBasePath, type ArrClientBundle } from './arr-clients';
import { listMediaChildren } from './media-children';

export interface RunFixRequestInput {
  db?: DbClient;
  arr: ArrClientBundle;
  requesterId: string;
  /** Admins bypass the hourly rate limit (D-09). */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  /** Episode id (sonarr) / album id (lidarr); absent for radarr (domain-validated). */
  targetChildId?: number;
  reason: FixReason;
  reasonText?: string;
}

export interface RunFixRequestResult {
  id: string;
  status: FixStatus; // 'search_triggered' on success
  pathTaken: FixPath;
  targetLabel: string | null;
}

const nowIso = () => new Date().toISOString();

function stepOk(
  step: string,
  endpoint: string,
  extra: Record<string, unknown> = {},
): FixActionEntry {
  return { step, endpoint, ok: true, at: nowIso(), ...extra };
}

function stepFailed(step: string, endpoint: string, err: unknown): FixActionEntry {
  return {
    step,
    endpoint,
    ok: false,
    at: nowIso(),
    ...(err instanceof ArrHttpError ? { status: err.status } : {}),
    error: err instanceof Error ? err.message : String(err),
  };
}

export async function runFixRequest(input: RunFixRequestInput): Promise<RunFixRequestResult> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      title: mediaItems.title,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(
      `Media item ${input.mediaItemId} is tombstoned — nothing to fix in the *arr`,
    );
  }

  const kind = item.arrKind;
  const base = arrApiBasePath(kind);
  const targetChildId = input.targetChildId;

  // Live target validation + display label (D-06: children are never synced). A read
  // that fails here aborts BEFORE the pending row — nothing has been promised yet.
  // Kind/target mismatches fall through to createFixRequest's FixTargetRequiredError.
  let targetLabel: string | null = null;
  let episodeFileId: number | null = null;
  if ((kind === 'sonarr' || kind === 'lidarr') && targetChildId !== undefined) {
    const children = await listMediaChildren({
      db: input.db,
      arr: input.arr,
      mediaItemId: item.id,
    });
    const child = children.find((c) => c.arrChildId === targetChildId);
    if (!child) {
      throw new NotFoundError(
        `${kind} ${kind === 'sonarr' ? 'episode' : 'album'} ${targetChildId} not found on live item ${item.arrItemId}`,
      );
    }
    targetLabel = child.label;
    episodeFileId = child.episodeFileId;
  }

  // D-09: pending row + fix_requested event commit before any mutating *arr call.
  const { fixRequestId } = await createFixRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: item.id,
    targetArrChildId: targetChildId ?? null,
    targetLabel,
    reason: input.reason,
    reasonText: input.reasonText ?? null,
  });

  const fail = async (entry: FixActionEntry, err: unknown): Promise<never> => {
    await recordFixAction({
      db: input.db,
      fixRequestId,
      transition: 'failed',
      actions: [entry],
    });
    throw new ArrUpstreamError(
      err instanceof Error ? err.message : `fix step ${entry.step} failed`,
      { cause: err },
    );
  };

  // ---- Step 1: latest grab from LIVE history (D-15 / ADR-008 C-04). ----
  const grabEndpoint =
    kind === 'sonarr'
      ? `GET ${base}/history?episodeId=${targetChildId}&eventType=grabbed`
      : kind === 'radarr'
        ? `GET ${base}/history/movie?movieId=${item.arrItemId}&eventType=grabbed`
        : `GET ${base}/history?albumId=${targetChildId}&eventType=grabbed`;
  let grab: { id: number; sourceTitle: string | null } | null = null;
  try {
    if (kind === 'sonarr') {
      const page = await input.arr.read.sonarr.getEpisodeGrabHistory(targetChildId!);
      grab = page.records[0]
        ? { id: page.records[0].id, sourceTitle: page.records[0].sourceTitle ?? null }
        : null;
    } else if (kind === 'radarr') {
      const records = await input.arr.read.radarr.getMovieGrabHistory(item.arrItemId);
      const newest = records.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
      grab = newest ? { id: newest.id, sourceTitle: newest.sourceTitle ?? null } : null;
    } else {
      const page = await input.arr.read.lidarr.getAlbumGrabHistory(targetChildId!);
      grab = page.records[0]
        ? { id: page.records[0].id, sourceTitle: page.records[0].sourceTitle ?? null }
        : null;
    }
  } catch (err) {
    if (err instanceof ArrError) await fail(stepFailed('resolve_grab', grabEndpoint, err), err);
    throw err;
  }
  const resolveEntry = stepOk('resolve_grab', grabEndpoint, {
    grabHistoryId: grab?.id ?? null,
    ...(grab?.sourceTitle ? { sourceTitle: grab.sourceTitle } : {}),
  });

  let pathTaken: FixPath;
  if (grab !== null) {
    // ---- Primary path (AC-07): blocklist via POST history/failed/{id}. ----
    pathTaken = 'blocklist_search';
    const endpoint = `POST ${base}/history/failed/${grab.id}`;
    try {
      await input.arr.write[kind].markHistoryFailed(grab.id);
    } catch (err) {
      if (err instanceof ArrError) await fail(stepFailed('mark_failed', endpoint, err), err);
      throw err;
    }
    await recordFixAction({
      db: input.db,
      fixRequestId,
      transition: 'actioned',
      pathTaken,
      actions: [resolveEntry, stepOk('mark_failed', endpoint, { status: 200 })],
    });
  } else {
    // ---- Fallback path (AC-08): no grab history — delete the file(s) + search. The
    // *arr cannot blocklist without a grab record; the limitation rides on the row.
    pathTaken = 'delete_search';
    const deleteEntries: FixActionEntry[] = [];
    try {
      if (kind === 'sonarr') {
        if (episodeFileId !== null && episodeFileId > 0) {
          const endpoint = `DELETE ${base}/episodefile/${episodeFileId}`;
          await input.arr.write.sonarr.deleteEpisodeFile(episodeFileId);
          deleteEntries.push(stepOk('delete_file', endpoint, { status: 200 }));
        }
      } else if (kind === 'radarr') {
        const movie = await input.arr.read.radarr.getMovieById(item.arrItemId);
        if (movie.hasFile && movie.movieFileId > 0) {
          const endpoint = `DELETE ${base}/moviefile/${movie.movieFileId}`;
          await input.arr.write.radarr.deleteMovieFile(movie.movieFileId);
          deleteEntries.push(stepOk('delete_file', endpoint, { status: 200 }));
        }
      } else {
        // Lidarr deletes at track-file granularity — every file of the album (D-03).
        const files = await input.arr.read.lidarr.listTrackFiles(targetChildId!);
        for (const file of files) {
          const endpoint = `DELETE ${base}/trackfile/${file.id}`;
          await input.arr.write.lidarr.deleteTrackFile(file.id);
          deleteEntries.push(stepOk('delete_file', endpoint, { status: 200 }));
        }
      }
    } catch (err) {
      if (err instanceof ArrError) {
        await fail(stepFailed('delete_file', `${base} (fix fallback)`, err), err);
      }
      throw err;
    }
    if (deleteEntries.length === 0) {
      deleteEntries.push(
        stepOk('delete_file', `${base} (fix fallback)`, {
          skipped: true,
          note: 'no grab history and nothing on disk to delete — search only',
        }),
      );
    }
    await recordFixAction({
      db: input.db,
      fixRequestId,
      transition: 'actioned',
      pathTaken,
      actions: [resolveEntry, ...deleteEntries],
    });
  }

  // ---- Step 3: trigger the search command (D-03 command names). ----
  const commandEndpoint = `POST ${base}/command`;
  try {
    const command =
      kind === 'sonarr'
        ? await input.arr.write.sonarr.searchEpisodes([targetChildId!])
        : kind === 'radarr'
          ? await input.arr.write.radarr.searchMovies([item.arrItemId])
          : await input.arr.write.lidarr.searchAlbums([targetChildId!]);
    await recordFixAction({
      db: input.db,
      fixRequestId,
      transition: 'search_triggered',
      actions: [
        stepOk('trigger_search', commandEndpoint, {
          commandId: command.id,
          commandName: command.name,
        }),
      ],
    });
  } catch (err) {
    if (err instanceof ArrError)
      await fail(stepFailed('trigger_search', commandEndpoint, err), err);
    throw err;
  }

  return { id: fixRequestId, status: 'search_triggered', pathTaken, targetLabel };
}
