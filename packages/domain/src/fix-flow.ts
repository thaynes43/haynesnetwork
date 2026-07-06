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
import {
  mediaItems,
  type ArrKind,
  type DbClient,
  type FixPath,
  type FixReason,
  type FixStatus,
} from '@hnet/db';
import type { FixActionEntry } from '@hnet/db';
import { eq } from 'drizzle-orm';
import {
  ArrError,
  ArrHttpError,
  LIDARR_GRABBED_EVENT_TYPE,
  SONARR_GRABBED_EVENT_TYPE,
} from '@hnet/arr';
import {
  ArrUpstreamError,
  LedgerItemTombstonedError,
  NotFoundError,
  SubtitleFixUnsupportedError,
} from './errors';
import { resolveDb } from './db-client';
import { createFixRequest, recordFixAction } from './fix-requests';
import { arrApiBasePath, type ArrClientBundle } from './arr-clients';
import { listMediaChildren } from './media-children';
import { resolveFixTarget, type FixScope, type SearchScope } from './action-scope';

export interface RunFixRequestInput {
  db?: DbClient;
  arr: ArrClientBundle;
  requesterId: string;
  /** Admins bypass the hourly rate limit (D-09). */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  /**
   * The fix scope (media-hierarchy actions): radarr 'item'; sonarr 'season' | 'episode';
   * lidarr 'album'. Omitted ⇒ the legacy default (radarr item / sonarr episode / lidarr
   * album). Whole-show/artist are Force-Search-only (D-15) — resolveFixTarget rejects
   * them here (widened to SearchScope only so the caller's union flows through cleanly).
   */
  scope?: SearchScope;
  /** Episode id (sonarr) / album id (lidarr); absent for radarr / a season (domain-validated). */
  targetChildId?: number;
  /** Sonarr season number — for the 'season' scope. */
  seasonNumber?: number;
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
  // Validate the (kind, scope, child, season) tuple up front. Kind/scope mismatches
  // throw FixTargetRequiredError here (also re-checked inside createFixRequest).
  const { scope, targetChildId, seasonNumber } = resolveFixTarget(kind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });

  // ADR-016 / D-19: a missing_subtitles Fix routes to Bazarr (subtitle search), never the
  // blocklist/delete paths — a subtitle gap is not a bad grab. Placed BEFORE the season
  // branch so a season-scoped subtitle fix does NOT fall into runSeasonFix's blocklist/
  // delete path; runSubtitleFix covers episode AND season scope via one series-level Bazarr
  // call. The kind guard (sonarr/radarr only) lands inside, before any fix_requests row.
  if (input.reason === 'missing_subtitles') {
    return runSubtitleFix(
      input,
      { id: item.id, arrKind: kind, arrItemId: item.arrItemId },
      { scope, targetChildId, seasonNumber },
    );
  }

  // Season roll-up is its own orchestration (blocklist every backing grab + SeasonSearch).
  if (scope === 'season') {
    return runSeasonFix(input, { id: item.id, arrItemId: item.arrItemId }, seasonNumber!);
  }

  // Live target validation + display label (D-06: children are never synced). A read
  // that fails here aborts BEFORE the pending row — nothing has been promised yet.
  let targetLabel: string | null = null;
  let episodeFileId: number | null = null;
  if (targetChildId !== null) {
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
    scope,
    targetArrChildId: targetChildId,
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
  // The paged `/history` grab lookups filter by the INTEGER eventType enum (a lowercase
  // string 400s upstream — D-03/D-15); Radarr's separate `/history/movie` path is
  // tolerant and keeps the string form.
  const grabEndpoint =
    kind === 'sonarr'
      ? `GET ${base}/history?episodeId=${targetChildId}&eventType=${SONARR_GRABBED_EVENT_TYPE}`
      : kind === 'radarr'
        ? `GET ${base}/history/movie?movieId=${item.arrItemId}&eventType=grabbed`
        : `GET ${base}/history?albumId=${targetChildId}&eventType=${LIDARR_GRABBED_EVENT_TYPE}`;
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

/**
 * ADR-016 / DESIGN-005 D-19 — Subtitle Fix (reason 'missing_subtitles'). Routes to Bazarr
 * instead of the ADR-007 blocklist/delete paths: a subtitle gap is not a bad grab, so the
 * media file is left untouched. Fire-and-forget — Bazarr's async `search-missing` action is
 * triggered and the fix rests at 'search_triggered' (completeFixRequests excludes it, so an
 * unrelated later import can't spuriously complete it). Covers radarr (movie) and sonarr
 * (episode OR season — both trigger the series-level Bazarr search; Bazarr 1.5.6 has no async
 * per-episode action). Lidarr is unsupported (guarded before any fix_requests row).
 *
 *   1. guard kind ∈ {sonarr, radarr} else SubtitleFixUnsupportedError (no orphan pending row);
 *   2. resolve the display label (read-only): sonarr episode via listMediaChildren, season →
 *      'Season N', radarr → null (the movie is the target);
 *   3. createFixRequest — pending row + 'fix_requested' event committed BEFORE any Bazarr call;
 *   4. Bazarr pre-read (audit color: which languages are missing) then the PATCH search;
 *   5. recordFixAction → 'actioned' (path 'bazarr_subtitle') then 'search_triggered'.
 */
async function runSubtitleFix(
  input: RunFixRequestInput,
  item: { id: string; arrKind: ArrKind; arrItemId: number },
  resolved: { scope: FixScope; targetChildId: number | null; seasonNumber: number | null },
): Promise<RunFixRequestResult> {
  const kind = item.arrKind;
  // ---- Step 1: kind guard (BEFORE createFixRequest — no orphan pending row). ----
  if (kind !== 'sonarr' && kind !== 'radarr') {
    throw new SubtitleFixUnsupportedError(
      `Subtitle Fix is not available for ${kind} — Bazarr covers the Radarr/Sonarr estate only`,
    );
  }
  const base = '/api'; // Bazarr base path (for the audit endpoint strings)

  // ---- Step 2: resolve the display label (read-only). A read failure here aborts
  // BEFORE the pending row — nothing has been promised yet. ----
  let targetLabel: string | null = null;
  if (kind === 'sonarr') {
    if (resolved.scope === 'season') {
      targetLabel = `Season ${resolved.seasonNumber}`;
    } else if (resolved.targetChildId !== null) {
      const children = await listMediaChildren({
        db: input.db,
        arr: input.arr,
        mediaItemId: item.id,
      });
      const child = children.find((c) => c.arrChildId === resolved.targetChildId);
      if (!child) {
        throw new NotFoundError(
          `sonarr episode ${resolved.targetChildId} not found on live item ${item.arrItemId}`,
        );
      }
      targetLabel = child.label;
    }
  }
  // radarr: the movie itself is the target — no child, label stays null.

  // ---- Step 3: pending row + fix_requested event before any Bazarr call (D-09). ----
  const { fixRequestId } = await createFixRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: item.id,
    scope: resolved.scope,
    targetArrChildId: resolved.targetChildId,
    seasonNumber: resolved.seasonNumber,
    targetLabel,
    reason: input.reason,
    reasonText: input.reasonText ?? null,
  });

  const fail = async (entry: FixActionEntry, err: unknown): Promise<never> => {
    await recordFixAction({ db: input.db, fixRequestId, transition: 'failed', actions: [entry] });
    throw new ArrUpstreamError(
      err instanceof Error ? err.message : `subtitle fix step ${entry.step} failed`,
      { cause: err },
    );
  };

  const actions: FixActionEntry[] = [];

  // ---- Step 4a: Bazarr pre-read (audit color — which languages are missing). Fail-closed:
  // Bazarr down = subtitle fix fails, no file touched. Season scope has no single target,
  // so it is skipped. ----
  if (kind === 'radarr') {
    const endpoint = `GET ${base}/movies?radarrid[]=${item.arrItemId}`;
    try {
      const state = await input.arr.read.bazarr.getMovieSubtitleState(item.arrItemId);
      actions.push(
        stepOk('bazarr_subtitle_state', endpoint, {
          missingSubtitles: state?.missing_subtitles.map((s) => s.code2) ?? [],
        }),
      );
    } catch (err) {
      if (err instanceof ArrError) await fail(stepFailed('bazarr_subtitle_state', endpoint, err), err);
      throw err;
    }
  } else if (resolved.scope !== 'season' && resolved.targetChildId !== null) {
    const endpoint = `GET ${base}/episodes?episodeid[]=${resolved.targetChildId}`;
    try {
      const state = await input.arr.read.bazarr.getEpisodeSubtitleState(resolved.targetChildId);
      actions.push(
        stepOk('bazarr_subtitle_state', endpoint, {
          missingSubtitles: state?.missing_subtitles.map((s) => s.code2) ?? [],
        }),
      );
    } catch (err) {
      if (err instanceof ArrError) await fail(stepFailed('bazarr_subtitle_state', endpoint, err), err);
      throw err;
    }
  }

  // ---- Step 4b: the Bazarr search-missing PATCH (async/queued — HTTP 204). ----
  const patchEndpoint =
    kind === 'radarr'
      ? `PATCH ${base}/movies?radarrid=${item.arrItemId}&action=search-missing`
      : `PATCH ${base}/series?seriesid=${item.arrItemId}&action=search-missing`;
  try {
    if (kind === 'radarr') {
      await input.arr.write.bazarr.searchMovieSubtitles(item.arrItemId);
    } else {
      // sonarr episode OR season — both trigger the series-level Bazarr search.
      await input.arr.write.bazarr.searchSeriesSubtitles(item.arrItemId);
    }
    actions.push(stepOk('bazarr_subtitle_search', patchEndpoint, { status: 204 }));
  } catch (err) {
    if (err instanceof ArrError)
      await fail(stepFailed('bazarr_subtitle_search', patchEndpoint, err), err);
    throw err;
  }

  // ---- Step 5: actioned (path 'bazarr_subtitle') then rest at search_triggered. ----
  const pathTaken: FixPath = 'bazarr_subtitle';
  await recordFixAction({ db: input.db, fixRequestId, transition: 'actioned', pathTaken, actions });
  await recordFixAction({ db: input.db, fixRequestId, transition: 'search_triggered' });

  return { id: fixRequestId, status: 'search_triggered', pathTaken, targetLabel };
}

/**
 * Season roll-up Fix (sonarr only, hierarchy-actions). Repairs a whole on-disk season:
 * resolve every ON-DISK episode's latest grab from LIVE per-episode history (reusing the
 * production-verified `GET /history?episodeId=&eventType=grabbed` per-target endpoint, so
 * this never hits the paged-history integer-eventType pitfall), blocklist each DISTINCT
 * backing grab (a season pack shares one id — the Set dedupes it), then fire ONE
 * SeasonSearch. When no on-disk episode has a grab record, fall back to deleting the
 * season's episode files (AC-08). One fix_requests row (scope 'season') is the audit.
 */
async function runSeasonFix(
  input: RunFixRequestInput,
  item: { id: string; arrItemId: number },
  seasonNumber: number,
): Promise<RunFixRequestResult> {
  const base = arrApiBasePath('sonarr');
  const targetLabel = `Season ${seasonNumber}`;

  // Live season episodes (D-06). A read failure here aborts BEFORE the pending row.
  const children = await listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: item.id });
  const seasonEpisodes = children.filter((c) => c.seasonNumber === seasonNumber);
  if (seasonEpisodes.length === 0) {
    throw new NotFoundError(
      `Season ${seasonNumber} has no episodes on live series ${item.arrItemId}`,
    );
  }
  const onDisk = seasonEpisodes.filter((c) => c.hasFile);

  // D-09: pending row + fix_requested event commit before any mutating *arr call.
  const { fixRequestId } = await createFixRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: item.id,
    scope: 'season',
    seasonNumber,
    targetLabel,
    reason: input.reason,
    reasonText: input.reasonText ?? null,
  });

  const fail = async (entry: FixActionEntry, err: unknown): Promise<never> => {
    await recordFixAction({ db: input.db, fixRequestId, transition: 'failed', actions: [entry] });
    throw new ArrUpstreamError(
      err instanceof Error ? err.message : `season fix step ${entry.step} failed`,
      { cause: err },
    );
  };

  // ---- Step 1: resolve the distinct grabs backing the on-disk episodes. ----
  const actions: FixActionEntry[] = [];
  const grabIds = new Set<number>();
  try {
    for (const ep of onDisk) {
      const endpoint = `GET ${base}/history?episodeId=${ep.arrChildId}&eventType=grabbed`;
      const page = await input.arr.read.sonarr.getEpisodeGrabHistory(ep.arrChildId);
      const grab = page.records[0];
      actions.push(
        stepOk('resolve_grab', endpoint, {
          episodeId: ep.arrChildId,
          grabHistoryId: grab?.id ?? null,
        }),
      );
      if (grab) grabIds.add(grab.id);
    }
  } catch (err) {
    if (err instanceof ArrError)
      await fail(stepFailed('resolve_grab', `${base}/history (season)`, err), err);
    throw err;
  }

  let pathTaken: FixPath;
  if (grabIds.size > 0) {
    // ---- Primary path (AC-07): blocklist every distinct backing grab. ----
    pathTaken = 'blocklist_search';
    for (const grabId of grabIds) {
      const endpoint = `POST ${base}/history/failed/${grabId}`;
      try {
        await input.arr.write.sonarr.markHistoryFailed(grabId);
      } catch (err) {
        if (err instanceof ArrError) await fail(stepFailed('mark_failed', endpoint, err), err);
        throw err;
      }
      actions.push(stepOk('mark_failed', endpoint, { status: 200, grabHistoryId: grabId }));
    }
  } else {
    // ---- Fallback (AC-08): no grabs to blocklist → delete the season's files. ----
    pathTaken = 'delete_search';
    try {
      for (const ep of onDisk) {
        if (ep.episodeFileId !== null && ep.episodeFileId > 0) {
          const endpoint = `DELETE ${base}/episodefile/${ep.episodeFileId}`;
          await input.arr.write.sonarr.deleteEpisodeFile(ep.episodeFileId);
          actions.push(stepOk('delete_file', endpoint, { status: 200, episodeId: ep.arrChildId }));
        }
      }
    } catch (err) {
      if (err instanceof ArrError)
        await fail(stepFailed('delete_file', `${base} (season fallback)`, err), err);
      throw err;
    }
    if (!actions.some((a) => a.step === 'delete_file')) {
      actions.push(
        stepOk('delete_file', `${base} (season fallback)`, {
          skipped: true,
          note: 'no grab history and nothing on disk to delete — search only',
        }),
      );
    }
  }
  await recordFixAction({ db: input.db, fixRequestId, transition: 'actioned', pathTaken, actions });

  // ---- Step 3: SeasonSearch for the whole season. ----
  const commandEndpoint = `POST ${base}/command`;
  try {
    const command = await input.arr.write.sonarr.searchSeason(item.arrItemId, seasonNumber);
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
