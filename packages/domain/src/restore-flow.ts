// DESIGN-005 D-16 — the Restore flow (R-50..R-52, AC-09). Explicitly NOT automatic:
// only the two admin procedures reach this module; sync never writes to an *arr.
//
//   diff    → computeRestoreDiff: live item list vs ledger by EXTERNAL id (the identity
//             that survives a rebuild); tombstoned rows included and badged — the
//             disaster that lost the *arr DB is exactly what tombstoned them.
//   execute → executeRestore: re-validates the admin-approved ids against a FRESH diff
//             (now-present/vanished items are skipped into the report — no TOCTOU
//             re-adds), persists the approved preview (startRestoreRun), then per item
//             maps profile/root-folder/tags BY NAME against the live target and POSTs
//             the add with searches OFF (Q-04: indexer safety beats convenience).
import {
  mediaItems,
  type ArrKind,
  type DbClient,
  type MediaItemRow,
  type RestorePreviewItem,
  type RestoreRunStatus,
} from '@hnet/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ArrError } from '@hnet/arr';
import type { ArrTag } from '@hnet/arr';
import { resolveDb } from './db-client';
import { RestoreProfileUnmappedError } from './errors';
import { finishRestoreRun, recordRestoreResult, startRestoreRun } from './restore-runs';
import { guardArrCall } from './media-children';
import type { ArrClientBundle } from './arr-clients';

export interface RestoreDiffItem {
  mediaItemId: string;
  title: string;
  year: number | null;
  /** tvdbId (sonarr) / tmdbId (radarr) / MusicBrainz artist id (lidarr) as a string. */
  externalId: string;
  qualityProfileName: string;
  rootFolder: string;
  arrTags: string[];
  /** Non-null ⇒ the row is tombstoned (badged in the preview — D-16 step 1). */
  tombstonedAt: string | null;
}

function externalIdOfRow(
  kind: ArrKind,
  row: Pick<MediaItemRow, 'tvdbId' | 'tmdbId' | 'musicbrainzArtistId'>,
): string | null {
  const raw =
    kind === 'sonarr' ? row.tvdbId : kind === 'radarr' ? row.tmdbId : row.musicbrainzArtistId;
  return raw === null || raw === undefined ? null : String(raw);
}

async function liveExternalIds(
  arr: Pick<ArrClientBundle, 'read'>,
  kind: ArrKind,
): Promise<Set<string>> {
  if (kind === 'sonarr') {
    const series = await guardArrCall('sonarr GET /series', () => arr.read.sonarr.listSeries());
    return new Set(series.map((s) => String(s.tvdbId)));
  }
  if (kind === 'radarr') {
    const movies = await guardArrCall('radarr GET /movie', () => arr.read.radarr.listMovies());
    return new Set(movies.map((m) => String(m.tmdbId)));
  }
  const artists = await guardArrCall('lidarr GET /artist', () => arr.read.lidarr.listArtists());
  return new Set(artists.map((a) => a.foreignArtistId));
}

/** Ledger rows Restore considers: monitored rows of the instance, tombstoned included. */
async function candidateRows(
  db: ReturnType<typeof resolveDb>,
  arrKind: ArrKind,
  arrInstanceId: string,
): Promise<MediaItemRow[]> {
  return db
    .select()
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, arrKind),
        eq(mediaItems.arrInstanceId, arrInstanceId),
        eq(mediaItems.monitored, true),
      ),
    )
    .orderBy(asc(mediaItems.sortTitle));
}

function toDiffItem(kind: ArrKind, row: MediaItemRow): RestoreDiffItem {
  return {
    mediaItemId: row.id,
    title: row.title,
    year: row.year,
    externalId: externalIdOfRow(kind, row) ?? '',
    qualityProfileName: row.qualityProfileName,
    rootFolder: row.rootFolder,
    arrTags: row.arrTags,
    tombstonedAt: row.deletedFromArrAt?.toISOString() ?? null,
  };
}

export interface ComputeRestoreDiffInput {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  arrKind: ArrKind;
  arrInstanceId?: string;
}

/**
 * D-16 step 1 — the read-only preview: monitored ledger rows of the instance whose
 * external id is absent from the live *arr. Never persisted; R-52's preview is the
 * admin seeing this list before execute.
 */
export async function computeRestoreDiff(
  input: ComputeRestoreDiffInput,
): Promise<RestoreDiffItem[]> {
  const db = resolveDb(input.db);
  const arrInstanceId = input.arrInstanceId ?? 'main';
  const live = await liveExternalIds(input.arr, input.arrKind);
  const rows = await candidateRows(db, input.arrKind, arrInstanceId);
  return rows
    .filter((row) => {
      const ext = externalIdOfRow(input.arrKind, row);
      return ext !== null && !live.has(ext);
    })
    .map((row) => toDiffItem(input.arrKind, row));
}

export interface ExecuteRestoreInput {
  db?: DbClient;
  arr: ArrClientBundle;
  arrKind: ArrKind;
  arrInstanceId?: string;
  /** The initiating admin (SET NULL on user deletion). */
  initiatedBy: string | null;
  /** The EXPLICIT id list the admin approved (D-16 step 2). */
  mediaItemIds: string[];
}

export interface ExecuteRestoreResultItem {
  mediaItemId: string;
  title: string;
  ok: boolean;
  newArrItemId?: number;
  error?: string;
  /** True when the item was approved but no longer missing at execute time. */
  skipped?: boolean;
}

export interface ExecuteRestoreResult {
  runId: string;
  status: RestoreRunStatus;
  itemCount: number;
  successCount: number;
  results: ExecuteRestoreResultItem[];
}

interface LiveTargetState {
  profileIdByName: Map<string, number>;
  metadataProfileIdByName: Map<string, number>;
  rootFolderPaths: Set<string>;
  tagIdByLabel: Map<string, number>;
}

async function fetchLiveTargetState(arr: ArrClientBundle, kind: ArrKind): Promise<LiveTargetState> {
  const read = arr.read[kind];
  const [profiles, folders, tags] = await Promise.all([
    guardArrCall(`${kind} GET /qualityprofile`, () => read.listQualityProfiles()),
    guardArrCall(`${kind} GET /rootfolder`, () => read.listRootFolders()),
    guardArrCall(`${kind} GET /tag`, () => read.listTags()),
  ]);
  const metadataProfiles =
    kind === 'lidarr'
      ? await guardArrCall('lidarr GET /metadataprofile', () =>
          arr.read.lidarr.listMetadataProfiles(),
        )
      : [];
  return {
    profileIdByName: new Map(profiles.map((p) => [p.name, p.id])),
    metadataProfileIdByName: new Map(metadataProfiles.map((p) => [p.name, p.id])),
    rootFolderPaths: new Set(folders.map((f) => f.path)),
    tagIdByLabel: new Map(tags.map((t: ArrTag) => [t.label, t.id])),
  };
}

/** Resolve tag labels → live ids, creating missing tags by label (the one auxiliary write). */
async function resolveTagIds(
  arr: ArrClientBundle,
  kind: ArrKind,
  state: LiveTargetState,
  labels: string[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const label of labels) {
    let id = state.tagIdByLabel.get(label);
    if (id === undefined) {
      const created = await arr.write[kind].createTag(label);
      state.tagIdByLabel.set(created.label, created.id);
      id = created.id;
    }
    ids.push(id);
  }
  return ids;
}

const attrString = (attrs: Record<string, unknown>, key: string): string | undefined =>
  typeof attrs[key] === 'string' ? (attrs[key] as string) : undefined;
const attrBool = (attrs: Record<string, unknown>, key: string): boolean | undefined =>
  typeof attrs[key] === 'boolean' ? (attrs[key] as boolean) : undefined;

/** One re-add POST with searches OFF (D-16 step 2 / Q-04). Returns the new *arr item id. */
async function addItemToArr(
  arr: ArrClientBundle,
  kind: ArrKind,
  row: MediaItemRow,
  state: LiveTargetState,
  qualityProfileId: number,
  tags: number[],
): Promise<number> {
  const attrs = row.arrAttrs;
  if (kind === 'sonarr') {
    const added = await arr.write.sonarr.addSeries({
      tvdbId: row.tvdbId!,
      title: row.title,
      qualityProfileId,
      rootFolderPath: row.rootFolder,
      monitored: true,
      seasonFolder: attrBool(attrs, 'seasonFolder') ?? true,
      seriesType: attrString(attrs, 'seriesType'),
      monitorNewItems: attrString(attrs, 'monitorNewItems'),
      tags,
      addOptions: { monitor: 'all', searchForMissingEpisodes: false },
    });
    return added.id;
  }
  if (kind === 'radarr') {
    const added = await arr.write.radarr.addMovie({
      tmdbId: row.tmdbId!,
      title: row.title,
      qualityProfileId,
      rootFolderPath: row.rootFolder,
      monitored: true,
      minimumAvailability: attrString(attrs, 'minimumAvailability'),
      tags,
      addOptions: { searchForMovie: false },
    });
    return added.id;
  }
  const metadataProfileId =
    row.metadataProfileName !== null
      ? state.metadataProfileIdByName.get(row.metadataProfileName)
      : undefined;
  if (row.metadataProfileName !== null && metadataProfileId === undefined) {
    throw new RestoreProfileUnmappedError(
      `metadata profile '${row.metadataProfileName}' not found on the live lidarr`,
    );
  }
  const added = await arr.write.lidarr.addArtist({
    foreignArtistId: row.musicbrainzArtistId!,
    artistName: row.title,
    qualityProfileId,
    metadataProfileId,
    rootFolderPath: row.rootFolder,
    monitored: true,
    monitorNewItems: attrString(attrs, 'monitorNewItems'),
    tags,
    addOptions: { searchForMissingAlbums: false },
  });
  return added.id;
}

/**
 * D-16 step 2+3 — execute an admin-approved Restore. Awaited end to end (household
 * scale); the durable report is the restore_runs row (AC-09), also returned inline.
 */
export async function executeRestore(input: ExecuteRestoreInput): Promise<ExecuteRestoreResult> {
  const db = resolveDb(input.db);
  const arrInstanceId = input.arrInstanceId ?? 'main';

  // Fresh diff — the approved set is re-validated; no TOCTOU re-adds (D-16).
  const live = await liveExternalIds(input.arr, input.arrKind);
  const approvedIds = [...new Set(input.mediaItemIds)];
  const rows = await db
    .select()
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, input.arrKind),
        eq(mediaItems.arrInstanceId, arrInstanceId),
        inArray(mediaItems.id, approvedIds),
      ),
    )
    .orderBy(asc(mediaItems.sortTitle));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const actionable: MediaItemRow[] = [];
  const skipped: ExecuteRestoreResultItem[] = [];
  for (const id of approvedIds) {
    const row = rowById.get(id);
    const ext = row === undefined ? null : externalIdOfRow(input.arrKind, row);
    if (row === undefined || !row.monitored || ext === null) {
      skipped.push({
        mediaItemId: id,
        title: row?.title ?? '(unknown item)',
        ok: false,
        skipped: true,
        error: 'skipped: not an eligible ledger row for this instance',
      });
    } else if (live.has(ext)) {
      skipped.push({
        mediaItemId: id,
        title: row.title,
        ok: false,
        skipped: true,
        error: 'skipped: already present in the live *arr',
      });
    } else {
      actionable.push(row);
    }
  }

  const preview: RestorePreviewItem[] = actionable.map((row) => ({
    ...toDiffItem(input.arrKind, row),
  }));
  const { runId } = await startRestoreRun({
    db: input.db,
    arrKind: input.arrKind,
    arrInstanceId,
    initiatedBy: input.initiatedBy,
    preview,
  });

  const results: ExecuteRestoreResultItem[] = [];
  for (const skip of skipped) {
    await recordRestoreResult({
      db: input.db,
      runId,
      result: { mediaItemId: skip.mediaItemId, ok: false, error: skip.error },
    });
    results.push(skip);
  }

  let state: LiveTargetState;
  try {
    state = await fetchLiveTargetState(input.arr, input.arrKind);
  } catch (err) {
    // Catastrophic: the target isn't answering — close the run as failed (D-10).
    await finishRestoreRun({ db: input.db, runId, status: 'failed' });
    throw err;
  }

  for (const row of actionable) {
    let result: ExecuteRestoreResultItem;
    try {
      const qualityProfileId = state.profileIdByName.get(row.qualityProfileName);
      if (qualityProfileId === undefined) {
        // Recorded per item, never a silent default (D-16/D-17).
        throw new RestoreProfileUnmappedError(
          `quality profile '${row.qualityProfileName}' not found on the live ${input.arrKind}`,
        );
      }
      if (!state.rootFolderPaths.has(row.rootFolder)) {
        throw new Error(`root folder '${row.rootFolder}' not found on the live ${input.arrKind}`);
      }
      const tags = await resolveTagIds(input.arr, input.arrKind, state, row.arrTags);
      const newArrItemId = await addItemToArr(
        input.arr,
        input.arrKind,
        row,
        state,
        qualityProfileId,
        tags,
      );
      result = { mediaItemId: row.id, title: row.title, ok: true, newArrItemId };
    } catch (err) {
      const message = err instanceof ArrError || err instanceof Error ? err.message : String(err);
      result = { mediaItemId: row.id, title: row.title, ok: false, error: message };
    }
    await recordRestoreResult({
      db: input.db,
      runId,
      result: {
        mediaItemId: result.mediaItemId,
        ok: result.ok,
        ...(result.newArrItemId !== undefined ? { newArrItemId: result.newArrItemId } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    });
    results.push(result);
  }

  const { status } = await finishRestoreRun({ db: input.db, runId });
  return {
    runId,
    status,
    itemCount: actionable.length,
    successCount: results.filter((r) => r.ok).length,
    results,
  };
}
