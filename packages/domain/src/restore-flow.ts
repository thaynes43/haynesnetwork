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
  type ArrAddReason,
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
import { RestoreProfileUnmappedError, SearchCapExceededError } from './errors';
import { finishRestoreRun, recordRestoreResult, startRestoreRun } from './restore-runs';
import { guardArrCall } from './media-children';
import type { ArrClientBundle } from './arr-clients';

/**
 * ADR-022 D-02 — a Ledger bulk Add-&-search (reason 'ledger_add', searches ON) is capped at
 * this many items per run: the *arrs queue search commands internally, but indexers
 * rate-limit, so the UI guides the user to batch (e.g. by vote tier). Restore
 * (reason 'restore', searches OFF) is not search-capped.
 */
export const ARR_ADD_SEARCH_CAP = 1000;

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

/** The live *arr item indexed by its EXTERNAL id: its internal arr id + monitored state.
 *  ADR-022 D-02 uses monitored to split present rows into skip (monitored) vs monitor-flip. */
interface LiveArrItem {
  arrId: number;
  monitored: boolean;
}

async function liveItemsByExternalId(
  arr: Pick<ArrClientBundle, 'read'>,
  kind: ArrKind,
): Promise<Map<string, LiveArrItem>> {
  if (kind === 'sonarr') {
    const series = await guardArrCall('sonarr GET /series', () => arr.read.sonarr.listSeries());
    return new Map(series.map((s) => [String(s.tvdbId), { arrId: s.id, monitored: s.monitored }]));
  }
  if (kind === 'radarr') {
    const movies = await guardArrCall('radarr GET /movie', () => arr.read.radarr.listMovies());
    return new Map(movies.map((m) => [String(m.tmdbId), { arrId: m.id, monitored: m.monitored }]));
  }
  const artists = await guardArrCall('lidarr GET /artist', () => arr.read.lidarr.listArtists());
  return new Map(
    artists.map((a) => [a.foreignArtistId, { arrId: a.id, monitored: a.monitored }]),
  );
}

/** Just the present external ids — the read-only Restore diff (D-16) needs no monitored state. */
async function liveExternalIds(
  arr: Pick<ArrClientBundle, 'read'>,
  kind: ArrKind,
): Promise<Set<string>> {
  return new Set((await liveItemsByExternalId(arr, kind)).keys());
}

/** Trigger the owning *arr's search command on an item id (ADR-022 D-02; search-flow.ts calls). */
async function triggerArrSearch(arr: ArrClientBundle, kind: ArrKind, arrId: number): Promise<void> {
  if (kind === 'sonarr') {
    await arr.write.sonarr.searchSeries(arrId);
  } else if (kind === 'radarr') {
    await arr.write.radarr.searchMovies([arrId]);
  } else {
    await arr.write.lidarr.searchArtist(arrId);
  }
}

/** Flip a present-but-unmonitored *arr item to monitored via the bulk-editor PUT (ADR-022 D-02). */
async function setArrMonitored(arr: ArrClientBundle, kind: ArrKind, arrId: number): Promise<void> {
  if (kind === 'sonarr') {
    await arr.write.sonarr.setSeriesMonitored([arrId], true);
  } else if (kind === 'radarr') {
    await arr.write.radarr.setMoviesMonitored([arrId], true);
  } else {
    await arr.write.lidarr.setArtistsMonitored([arrId], true);
  }
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

export interface ExecuteArrAddInput {
  db?: DbClient;
  arr: ArrClientBundle;
  arrKind: ArrKind;
  arrInstanceId?: string;
  /** The initiating user (SET NULL on user deletion). */
  initiatedBy: string | null;
  /** The EXPLICIT id list the caller approved/selected (D-16 step 2 / Ledger selection). */
  mediaItemIds: string[];
  /**
   * ADR-022 C-01/D-02 — 'restore' (default): the diff-driven failsafe — searches OFF,
   * present items skipped, only monitored ledger rows eligible. 'ledger_add': the Ledger
   * bulk action — present-but-unmonitored items are flipped to monitored (not skipped), and
   * any ledger row (monitored or not) is eligible.
   */
  reason?: ArrAddReason;
  /** ADR-022 D-02 — trigger the owning *arr's item search after each add/monitor. */
  searchOnAdd?: boolean;
}

/** Back-compat alias — Restore is `executeArrAdd({ reason:'restore', searchOnAdd:false })`. */
export type ExecuteRestoreInput = Omit<ExecuteArrAddInput, 'reason' | 'searchOnAdd'>;

export interface ExecuteArrAddResultItem {
  mediaItemId: string;
  title: string;
  ok: boolean;
  /** ADR-022 D-02 — 'added' (re-added monitored) | 'monitored' (present, flipped monitored). */
  outcome?: 'added' | 'monitored';
  newArrItemId?: number;
  /** A search command was triggered for this item (searchOnAdd). */
  searched?: boolean;
  error?: string;
  /** True when the item was approved but skipped at execute time (present / ineligible). */
  skipped?: boolean;
}

export interface ExecuteArrAddResult {
  runId: string;
  status: RestoreRunStatus;
  itemCount: number;
  successCount: number;
  results: ExecuteArrAddResultItem[];
}

/** @deprecated use ExecuteArrAddResultItem */
export type ExecuteRestoreResultItem = ExecuteArrAddResultItem;
/** @deprecated use ExecuteArrAddResult */
export type ExecuteRestoreResult = ExecuteArrAddResult;

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

const errMessage = (err: unknown): string =>
  err instanceof ArrError || err instanceof Error ? err.message : String(err);

/** One planned per-item action, decided against fresh live state (ADR-022 D-02). */
interface ArrAddAction {
  row: MediaItemRow;
  /** 'add' = absent, re-add monitored; 'monitor' = present-but-unmonitored, flip to monitored. */
  kind: 'add' | 'monitor';
  /** The live *arr internal id (the 'monitor' + search target). */
  liveArrId?: number;
}

/**
 * ADR-022 D-02 (generalizes DESIGN-005 D-16 executeRestore) — execute a bulk *arr add over an
 * explicit id list, awaited end to end (household scale); the durable report is the restore_runs
 * row (AC-09), also returned inline. Re-derives FRESH live state and classifies each approved id
 * into three outcomes:
 *   - absent from the live *arr        → add it monitored (recorded profile/root/tags);
 *   - present but unmonitored          → flip it to monitored in place (reason 'ledger_add' only);
 *   - present + monitored (or reason   → skip, recorded as such.
 *     'restore' + any present)
 * When `searchOnAdd`, the owning *arr's item search is triggered (best-effort) on the acted id.
 * Restore is the `{ reason:'restore', searchOnAdd:false }` special case (executeRestore wrapper):
 * only monitored ledger rows are eligible and every present row is skipped (the failsafe contract).
 */
export async function executeArrAdd(input: ExecuteArrAddInput): Promise<ExecuteArrAddResult> {
  const db = resolveDb(input.db);
  const arrInstanceId = input.arrInstanceId ?? 'main';
  const reason: ArrAddReason = input.reason ?? 'restore';
  const searchOnAdd = input.searchOnAdd ?? false;
  const approvedIds = [...new Set(input.mediaItemIds)];

  // Search-cap safety (ADR-022 D-02) — thrown BEFORE any read/write, so nothing is partial.
  if (searchOnAdd && approvedIds.length > ARR_ADD_SEARCH_CAP) {
    throw new SearchCapExceededError(
      `Add-&-search is capped at ${ARR_ADD_SEARCH_CAP} items per run; ${approvedIds.length} were selected — batch the selection (e.g. by tier).`,
      { requested: approvedIds.length, cap: ARR_ADD_SEARCH_CAP },
    );
  }

  // Fresh live state — the approved set is re-validated against reality; no TOCTOU (D-16).
  const live = await liveItemsByExternalId(input.arr, input.arrKind);
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

  const actions: ArrAddAction[] = [];
  const skipped: ExecuteArrAddResultItem[] = [];
  for (const id of approvedIds) {
    const row = rowById.get(id);
    const ext = row === undefined ? null : externalIdOfRow(input.arrKind, row);
    // Eligibility: a real row of this instance with an external id. 'restore' additionally
    // requires the ledger row be monitored (the failsafe re-adds only monitored rows).
    if (row === undefined || ext === null || (reason === 'restore' && !row.monitored)) {
      skipped.push({
        mediaItemId: id,
        title: row?.title ?? '(unknown item)',
        ok: false,
        skipped: true,
        error: 'skipped: not an eligible ledger row for this instance',
      });
      continue;
    }
    const present = live.get(ext);
    if (present === undefined) {
      actions.push({ row, kind: 'add' });
    } else if (reason === 'ledger_add' && !present.monitored) {
      actions.push({ row, kind: 'monitor', liveArrId: present.arrId });
    } else {
      skipped.push({
        mediaItemId: id,
        title: row.title,
        ok: false,
        skipped: true,
        error: present.monitored
          ? 'skipped: already present and monitored in the live *arr'
          : 'skipped: already present in the live *arr',
      });
    }
  }

  const preview: RestorePreviewItem[] = actions.map((a) => ({ ...toDiffItem(input.arrKind, a.row) }));
  const { runId } = await startRestoreRun({
    db: input.db,
    arrKind: input.arrKind,
    arrInstanceId,
    initiatedBy: input.initiatedBy,
    reason,
    preview,
  });

  const results: ExecuteArrAddResultItem[] = [];
  for (const skip of skipped) {
    await recordRestoreResult({
      db: input.db,
      runId,
      result: { mediaItemId: skip.mediaItemId, ok: false, error: skip.error },
    });
    results.push(skip);
  }

  // The live target state (profiles/root folders/tags) is only needed to re-add absent items.
  let state: LiveTargetState | undefined;
  if (actions.some((a) => a.kind === 'add')) {
    try {
      state = await fetchLiveTargetState(input.arr, input.arrKind);
    } catch (err) {
      // Catastrophic: the target isn't answering — close the run as failed (D-10).
      await finishRestoreRun({ db: input.db, runId, status: 'failed' });
      throw err;
    }
  }

  for (const action of actions) {
    const outcome: 'added' | 'monitored' = action.kind === 'add' ? 'added' : 'monitored';
    let result: ExecuteArrAddResultItem;
    try {
      let newArrItemId: number | undefined;
      let targetArrId: number;
      if (action.kind === 'add') {
        const st = state!;
        const qualityProfileId = st.profileIdByName.get(action.row.qualityProfileName);
        if (qualityProfileId === undefined) {
          // Recorded per item, never a silent default (D-16/D-17).
          throw new RestoreProfileUnmappedError(
            `quality profile '${action.row.qualityProfileName}' not found on the live ${input.arrKind}`,
          );
        }
        if (!st.rootFolderPaths.has(action.row.rootFolder)) {
          throw new Error(
            `root folder '${action.row.rootFolder}' not found on the live ${input.arrKind}`,
          );
        }
        const tags = await resolveTagIds(input.arr, input.arrKind, st, action.row.arrTags);
        newArrItemId = await addItemToArr(
          input.arr,
          input.arrKind,
          action.row,
          st,
          qualityProfileId,
          tags,
        );
        targetArrId = newArrItemId;
      } else {
        await setArrMonitored(input.arr, input.arrKind, action.liveArrId!);
        targetArrId = action.liveArrId!;
      }

      // Best-effort search — the add/monitor is the durable state change; a failed search
      // command does NOT fail the item (the *arrs queue search internally; indexers may throttle).
      let searched = false;
      let searchError: string | undefined;
      if (searchOnAdd) {
        try {
          await triggerArrSearch(input.arr, input.arrKind, targetArrId);
          searched = true;
        } catch (err) {
          searchError = errMessage(err);
        }
      }

      result = {
        mediaItemId: action.row.id,
        title: action.row.title,
        ok: true,
        outcome,
        ...(newArrItemId !== undefined ? { newArrItemId } : {}),
        ...(searched ? { searched: true } : {}),
        ...(searchError !== undefined ? { error: `search failed: ${searchError}` } : {}),
      };
      await recordRestoreResult({
        db: input.db,
        runId,
        result: {
          mediaItemId: action.row.id,
          ok: true,
          outcome,
          searched,
          ...(newArrItemId !== undefined ? { newArrItemId } : {}),
          ...(searchError !== undefined ? { searchError } : {}),
        },
      });
    } catch (err) {
      const message = errMessage(err);
      result = { mediaItemId: action.row.id, title: action.row.title, ok: false, outcome, error: message };
      await recordRestoreResult({
        db: input.db,
        runId,
        result: { mediaItemId: action.row.id, ok: false, error: message },
      });
    }
    results.push(result);
  }

  const { status } = await finishRestoreRun({ db: input.db, runId });
  return {
    runId,
    status,
    itemCount: actions.length,
    successCount: results.filter((r) => r.ok).length,
    results,
  };
}

/**
 * DESIGN-005 D-16 — the admin-only failsafe Restore, now a thin wrapper over executeArrAdd
 * with the historical contract preserved: searches OFF, present items skipped (never
 * monitor-flipped), only monitored ledger rows eligible. The restore router + tests are
 * unchanged (ADR-022 C-01).
 */
export async function executeRestore(input: ExecuteRestoreInput): Promise<ExecuteArrAddResult> {
  return executeArrAdd({ ...input, reason: 'restore', searchOnAdd: false });
}
