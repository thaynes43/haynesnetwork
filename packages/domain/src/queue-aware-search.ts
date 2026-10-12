// ADR-109 C-05 / DESIGN-055 D-07 (PLAN-077 P2, issue #597 Part 1) — queue-aware Force Search. Before it searches for a
// missing episode or movie, Force Search reads the *arr's queue for that target:
//
//   | queue state for the target            | what Force Search does                                   |
//   |---------------------------------------|----------------------------------------------------------|
//   | nothing                               | searches, as today                                       |
//   | downloading, queued, held, importing  | nothing ("already on its way")                           |
//   | finished, import blocked or pending   | the Import Check (T-306): import it, offer "Import this  |
//   |                                       | download onto...", remove a defect and search, or staff  |
//   | download failed                       | removes it with blocklist (skipRedownload) and searches  |
//
// Behind the `import_check` remedy of `repair_guide_remedies` (off ⇒ today's search-only path). The plan is read-only
// (`planForceSearch`, no budget) and carries a digest; an import or a removal runs only with the digest of the plan the
// person saw, re-planned just before acting (FixPlanChangedError when it changed). A caller without a digest gets the
// search or "on its way"; anything else is refused with the guide's words. An import is one Repair Request
// (`import_download`), a removal one search event: each press costs one unit of the shared hourly budget.
import { createHash } from 'node:crypto';
import { mediaItems, type DbClient } from '@hnet/db';
import { ArrError, type RadarrQueueRecord, type SonarrQueueRecord } from '@hnet/arr';
import { eq } from 'drizzle-orm';
import { type ArrClientBundle } from './arr-clients';
import { resolveDb } from './db-client';
import { ArrUpstreamError, FixPlanChangedError, FixRefusedError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { resolveSearchTarget, type SearchScope } from './action-scope';
import { episodeLabel } from './media-children';
import { getRepairGuideRemedies } from './repair-guide-settings';
import { createRepairRequest, recordRepairTransition } from './repair-requests';
import {
  checkRadarrImport,
  checkSonarrImport,
  checkSonarrImportOnto,
  queueTexts,
  type ImportCheckFileSummary,
  type ImportCheckReason,
  type ImportCheckTitle,
  type ImportCheckVerdict,
  type RadarrImportCheck,
  type SonarrImportCheck,
  type SonarrImportCheckInput,
} from './import-check';

/** What a Force Search press will do (D-07 table). */
export type ForceSearchPlanState =
  /** Nothing queued (or the remedy is off): search, as today. */
  | 'search'
  /** Something is downloading, queued, held by a delay profile or being imported: nothing to do. */
  | 'on_its_way'
  /** A finished download passes the Import Check: import it. */
  | 'import'
  /** The download's title names another episode: the person may import it onto that one (or the grab's own target). */
  | 'import_onto'
  /** A failed download, or a release defect: remove it with blocklist and search once. */
  | 'remove_and_search'
  /** Nothing the guide can do safely (a packed download, a title that does not match, anything else): staff. */
  | 'staff';

/** The queue's download for the target, as the guide shows it. */
export interface ForceSearchDownload {
  downloadId: string | null;
  title: string | null;
  /** The download client status (`queued`, `downloading`, `completed`, `delay`, ...). */
  status: string | null;
  /** The *arr's tracked state (`downloading`, `importBlocked`, `importPending`, `failed`, ...). */
  trackedState: string | null;
  /** 0..1 when the size is known. */
  progress: number | null;
  timeLeft: string | null;
  /** The *arr's own messages on the record (statusMessages and errorMessage). */
  messages: string[];
}

/** The Import Check as the guide shows it (no file paths, no command body). */
export interface ForceSearchCheck {
  verdict: ImportCheckVerdict;
  reason: ImportCheckReason;
  detail: string | null;
  file: ImportCheckFileSummary | null;
  title: ImportCheckTitle | null;
}

/** One episode "Import this download onto..." may choose (D-07 rule 4). */
export interface ForceSearchOntoChoice {
  episodeId: number;
  label: string;
  /** The episode Title Evidence names (preselected). */
  suggested: boolean;
  /** The grab's own target (the episode Force Search was pressed on). */
  grabTarget: boolean;
}

export interface ForceSearchPlan {
  /** False when the remedy is off or the target is not one episode or one movie: today's search-only Force Search. */
  queueAware: boolean;
  state: ForceSearchPlanState;
  targetLabel: string | null;
  download: ForceSearchDownload | null;
  check: ForceSearchCheck | null;
  ontoChoices: ForceSearchOntoChoice[];
  /** `remove_and_search`: `failed` or `defect`. */
  removeWhy: 'failed' | 'defect' | null;
  /** A stable digest of what the press will DO; the confirm sends it back. */
  digest: string;
}

export interface ForceSearchPlanInput {
  db?: DbClient;
  arr: ArrClientBundle;
  mediaItemId: string;
  scope?: SearchScope;
  targetChildId?: number;
  seasonNumber?: number;
  /** Read-only previews only (the in-cluster tool): plan as if the remedy were on, whatever the switch says. */
  importCheckOn?: boolean;
}

/** The plan plus what executing it needs (never sent to a client). */
interface InternalPlan extends ForceSearchPlan {
  kind: 'sonarr' | 'radarr';
  mediaItemId: string;
  arrItemId: number;
  seasonNumber: number | null;
  targetChildId: number | null;
  seasonEpisodeIds: number[];
  /** The first queue record of the download (a removal goes through it). */
  queueItemId: number | null;
  sonarrCheck: SonarrImportCheck | null;
  sonarrCheckInput: SonarrImportCheckInput | null;
  radarrCheck: RadarrImportCheck | null;
}

type QueueRecord = SonarrQueueRecord | RadarrQueueRecord;

const FAILED_STATES = new Set(['failed', 'failedpending']);
const STUCK_STATES = new Set(['importblocked', 'importpending', 'importfailed']);

/** One queue record's place in the D-07 table. */
export function queueRecordState(r: {
  status?: string | null;
  trackedDownloadState?: string | null;
  trackedDownloadStatus?: string | null;
}): 'failed' | 'stuck' | 'on_its_way' {
  const state = (r.trackedDownloadState ?? '').toLowerCase();
  const status = (r.status ?? '').toLowerCase();
  const tracked = (r.trackedDownloadStatus ?? '').toLowerCase();
  if (FAILED_STATES.has(state) || status === 'failed' || tracked === 'error') return 'failed';
  if (STUCK_STATES.has(state)) return 'stuck';
  return 'on_its_way';
}

function planDigest(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function downloadSummary(records: QueueRecord[]): ForceSearchDownload {
  const r = records[0]!;
  const size = r.size ?? null;
  const left = r.sizeleft ?? null;
  return {
    downloadId: r.downloadId ?? null,
    title: r.title ?? null,
    status: r.status ?? null,
    trackedState: r.trackedDownloadState ?? null,
    progress: size !== null && size > 0 && left !== null ? Math.max(0, Math.min(1, (size - left) / size)) : null,
    timeLeft: r.timeleft ?? null,
    messages: queueTexts(records).filter((m, i, all) => all.indexOf(m) === i && m !== r.title),
  };
}

/** Group a target's queue records by download, newest grab first; the D-07 priority picks one. */
function pickDownload(records: QueueRecord[]): { state: 'failed' | 'stuck' | 'on_its_way'; records: QueueRecord[] } | null {
  if (records.length === 0) return null;
  const byDownload = new Map<string, QueueRecord[]>();
  for (const r of records) {
    const key = r.downloadId ?? `queue-${r.id}`;
    byDownload.set(key, [...(byDownload.get(key) ?? []), r]);
  }
  const groups = [...byDownload.values()].map((rs) => ({
    records: rs,
    state: rs.map(queueRecordState).includes('on_its_way')
      ? ('on_its_way' as const)
      : rs.map(queueRecordState).includes('stuck')
        ? ('stuck' as const)
        : ('failed' as const),
    added: Math.max(...rs.map((r) => Date.parse(r.added ?? '') || 0)),
  }));
  // Something on its way wins (searching would only be refused); then a stuck download (a good file may be there);
  // then a failed one. Within a state, the newest grab.
  const rank = { on_its_way: 0, stuck: 1, failed: 2 } as const;
  groups.sort((a, b) => rank[a.state] - rank[b.state] || b.added - a.added);
  return groups[0]!;
}

const publicCheck = (c: SonarrImportCheck | RadarrImportCheck): ForceSearchCheck => ({
  verdict: c.verdict,
  reason: c.reason,
  detail: c.detail,
  file: c.file,
  title: c.title,
});

/** What the person sees, with the internals dropped. */
export function publicPlan(plan: ForceSearchPlan): ForceSearchPlan {
  return {
    queueAware: plan.queueAware,
    state: plan.state,
    targetLabel: plan.targetLabel,
    download: plan.download,
    check: plan.check,
    ontoChoices: plan.ontoChoices,
    removeWhy: plan.removeWhy,
    digest: plan.digest,
  };
}

async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArrError) {
      throw new ArrUpstreamError(`${what}: ${err instanceof Error ? err.message : 'failed'}`, { cause: err });
    }
    throw err;
  }
}

async function buildPlan(input: ForceSearchPlanInput): Promise<InternalPlan> {
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
    throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to search in the *arr`);
  }
  const { scope, targetChildId } = resolveSearchTarget(item.arrKind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });
  const plain: InternalPlan = {
    queueAware: false,
    state: 'search',
    targetLabel: null,
    download: null,
    check: null,
    ontoChoices: [],
    removeWhy: null,
    digest: '',
    kind: item.arrKind === 'radarr' ? 'radarr' : 'sonarr',
    mediaItemId: item.id,
    arrItemId: item.arrItemId,
    seasonNumber: null,
    targetChildId,
    seasonEpisodeIds: [],
    queueItemId: null,
    sonarrCheck: null,
    sonarrCheckInput: null,
    radarrCheck: null,
  };
  const remedies = await getRepairGuideRemedies(db);
  const importCheckOn = input.importCheckOn ?? remedies.import_check;
  if (!queueAwareEligible({ arrKind: item.arrKind, scope, targetChildId, importCheckOn })) {
    return finish(plain);
  }

  if (item.arrKind === 'radarr') {
    const queue = await guarded('queue read', () => input.arr.read.radarr.getQueue(item.arrItemId));
    const plan: InternalPlan = { ...plain, queueAware: true, targetLabel: item.title };
    const picked = pickDownload(queue.filter((r) => r.movieId === item.arrItemId));
    if (!picked) return finish(plan);
    plan.download = downloadSummary(picked.records);
    plan.queueItemId = picked.records[0]!.id;
    if (picked.state === 'on_its_way') return finish({ ...plan, state: 'on_its_way' });
    if (picked.state === 'failed') return finish({ ...plan, state: 'remove_and_search', removeWhy: 'failed' });
    const downloadId = picked.records[0]!.downloadId;
    if (!downloadId) return finish({ ...plan, state: 'staff' });
    const [candidates, movie] = await guarded('manual import read', () =>
      Promise.all([input.arr.read.radarr.getManualImport(downloadId), input.arr.read.radarr.getMovieById(item.arrItemId)]),
    );
    const check = checkRadarrImport({
      downloadId,
      movie: {
        id: movie.id,
        title: movie.title,
        originalTitle: movie.originalTitle ?? null,
        alternateTitles: movie.alternateTitles ?? [],
        year: movie.year ?? null,
      },
      releaseTitle: picked.records[0]!.title ?? null,
      queueMessages: queueTexts(picked.records),
      candidates,
    });
    plan.radarrCheck = check;
    plan.check = publicCheck(check);
    return finish({ ...plan, ...stateFor(check) });
  }

  // Sonarr: one episode.
  const seriesId = item.arrItemId;
  const [queue, episodes] = await guarded('queue read', () =>
    Promise.all([input.arr.read.sonarr.getQueue(seriesId), input.arr.read.sonarr.listEpisodes(seriesId)]),
  );
  const target = episodes.find((e) => e.id === targetChildId);
  if (!target) throw new NotFoundError(`sonarr episode ${targetChildId} not found on live item ${seriesId}`);
  const label = (id: number): string => {
    const e = episodes.find((x) => x.id === id);
    return e ? episodeLabel(e.seasonNumber, e.episodeNumber, e.title) : `Episode ${id}`;
  };
  const plan: InternalPlan = {
    ...plain,
    queueAware: true,
    targetLabel: label(target.id),
    seasonNumber: target.seasonNumber,
    seasonEpisodeIds: episodes.filter((e) => e.seasonNumber === target.seasonNumber).map((e) => e.id),
  };
  const picked = pickDownload(queue.filter((r) => r.episodeId === target.id));
  if (!picked) return finish(plan);
  plan.download = downloadSummary(picked.records);
  plan.queueItemId = picked.records[0]!.id;
  if (picked.state === 'on_its_way') return finish({ ...plan, state: 'on_its_way' });
  if (picked.state === 'failed') return finish({ ...plan, state: 'remove_and_search', removeWhy: 'failed' });
  const downloadId = picked.records[0]!.downloadId;
  if (!downloadId) return finish({ ...plan, state: 'staff' });
  // Every record of the download (a pack tracks other episodes too): the queue's own mapping.
  const downloadRecords = queue.filter((r) => r.downloadId === downloadId);
  const [candidates, series] = await guarded('manual import read', () =>
    Promise.all([input.arr.read.sonarr.getManualImport(downloadId), input.arr.read.sonarr.getSeriesById(seriesId)]),
  );
  const checkInput: SonarrImportCheckInput = {
    downloadId,
    seriesId,
    seriesYear: series.year ?? null,
    targetEpisodeIds: [target.id],
    mode: 'target',
    recordEpisodeIds: [...new Set(downloadRecords.map((r) => r.episodeId).filter((id): id is number => id != null))],
    releaseTitle: picked.records[0]!.title ?? null,
    queueMessages: queueTexts(downloadRecords),
    candidates,
    episodes: episodes.map((e) => ({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      title: e.title,
    })),
  };
  const check = checkSonarrImport(checkInput);
  plan.sonarrCheck = check;
  plan.sonarrCheckInput = checkInput;
  plan.check = publicCheck(check);
  const next = stateFor(check);
  if (check.verdict === 'title_mismatch' && check.reason === 'title_disagrees') {
    // D-07 rule 4: "Import this download onto..." the episode the title names (when it has no file), or the grab's own
    // target. Anything else is for staff.
    const suggested = check.title?.bestEpisodeId ?? null;
    const choices: ForceSearchOntoChoice[] = [];
    const named = suggested !== null ? episodes.find((e) => e.id === suggested) : undefined;
    if (named && !named.hasFile) {
      choices.push({ episodeId: named.id, label: label(named.id), suggested: true, grabTarget: false });
    }
    if (!target.hasFile) choices.push({ episodeId: target.id, label: label(target.id), suggested: false, grabTarget: true });
    if (choices.length > 0) return finish({ ...plan, state: 'import_onto', ontoChoices: choices });
  }
  return finish({ ...plan, ...next });
}

/** The D-07 outcome for an Import Check verdict. */
function stateFor(check: SonarrImportCheck | RadarrImportCheck): Pick<ForceSearchPlan, 'state' | 'removeWhy'> {
  switch (check.verdict) {
    case 'importable':
      return { state: 'import', removeWhy: null };
    case 'release_defect':
      return { state: 'remove_and_search', removeWhy: 'defect' };
    default:
      return { state: 'staff', removeWhy: null };
  }
}

function finish(plan: InternalPlan): InternalPlan {
  const files = plan.sonarrCheck?.files ?? plan.radarrCheck?.files ?? [];
  return {
    ...plan,
    digest: planDigest({
      state: plan.state,
      downloadId: plan.download?.downloadId ?? null,
      queueItemId: plan.state === 'remove_and_search' ? plan.queueItemId : null,
      files: files.map((f) => ({ path: f.path, to: 'episodeIds' in f ? f.episodeIds : f.movieId })),
      onto: plan.ontoChoices.map((c) => c.episodeId),
      removeWhy: plan.removeWhy,
      reason: plan.check?.reason ?? null,
    }),
  };
}

/** DESIGN-055 D-07 — the read-only plan a Force Search press would follow. Costs no budget. */
export async function planForceSearch(input: ForceSearchPlanInput): Promise<ForceSearchPlan> {
  return publicPlan(await buildPlan(input));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** What a Force Search press did. */
export type ForceSearchOutcome =
  | 'searched'
  | 'on_its_way'
  /** The ManualImport landed and the target has its file. */
  | 'imported'
  /** The ManualImport was sent and is still running; the sync completes the Repair Request when it lands. */
  | 'importing'
  | 'removed_and_searched';

export interface QueueAwareSearchInput extends ForceSearchPlanInput {
  requesterId: string;
  requesterIsAdmin?: boolean;
  /** The plan the person confirmed; an import or a removal needs it. */
  confirm?: { digest: string; ontoEpisodeId?: number } | null;
  /** How long to wait for the ManualImport command before answering `importing` (tests shorten it). */
  commandWait?: { timeoutMs: number; intervalMs: number };
}

export interface QueueAwareSearchResult {
  outcome: ForceSearchOutcome;
  eventId: string | null;
  repairRequestId: string | null;
  targetLabel: string | null;
  commandName: string | null;
}

/** The search half, supplied by search-flow.ts (it records the event and sends the *arr command). */
export type SearchOnce = (opts: {
  queueRemoval?: { downloadId: string | null; title: string | null; why: 'failed' | 'defect' } | null;
  beforeSearch?: () => Promise<void>;
}) => Promise<{ eventId: string; targetLabel: string | null; commandName: string }>;

/** Whether a press goes through the queue-aware path: the remedy is on and the target is one episode or one movie. */
export function queueAwareEligible(input: {
  arrKind: string;
  scope: SearchScope;
  targetChildId: number | null;
  importCheckOn: boolean;
}): boolean {
  if (!input.importCheckOn) return false;
  return (
    (input.arrKind === 'sonarr' && input.scope === 'episode' && input.targetChildId !== null) ||
    (input.arrKind === 'radarr' && input.scope === 'item')
  );
}

const DEFAULT_COMMAND_WAIT = { timeoutMs: 20_000, intervalMs: 1_000 };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const REFUSAL_COPY: Partial<Record<ForceSearchPlanState, string>> = {
  import: 'A finished download for this is waiting to be added. Open Force Search again to review it.',
  import_onto: 'A finished download for this is waiting to be added. Open Force Search again to review it.',
  remove_and_search: 'A download for this is stuck. Open Force Search again to review it.',
  staff: 'A download for this is stuck and needs staff to look at it.',
};

/**
 * DESIGN-055 D-07 — run a queue-aware Force Search press. Re-plans, refuses a plan that changed since the person saw it,
 * then follows the plan: search (the supplied `search`), nothing (on its way), import (one Repair Request), or remove
 * with blocklist and search once.
 */
export async function runQueueAwareForceSearch(
  input: QueueAwareSearchInput,
  search: SearchOnce,
): Promise<QueueAwareSearchResult> {
  const plan = await buildPlan({ ...input, importCheckOn: undefined });
  const label = plan.targetLabel;
  if (input.confirm && input.confirm.digest !== plan.digest) {
    throw new FixPlanChangedError('What Force Search found has changed. Here is what it sees now.');
  }
  if (plan.state === 'search') {
    const r = await search({});
    return { outcome: 'searched', eventId: r.eventId, repairRequestId: null, targetLabel: r.targetLabel, commandName: r.commandName };
  }
  if (plan.state === 'on_its_way') {
    return { outcome: 'on_its_way', eventId: null, repairRequestId: null, targetLabel: label, commandName: null };
  }
  if (!input.confirm || plan.state === 'staff') {
    throw new FixRefusedError('needs_guide', REFUSAL_COPY[plan.state] ?? 'Open Force Search again to review it.');
  }

  if (plan.state === 'remove_and_search') {
    const removal = { downloadId: plan.download?.downloadId ?? null, title: plan.download?.title ?? null, why: plan.removeWhy ?? 'failed' };
    const r = await search({
      queueRemoval: removal,
      beforeSearch: async () => {
        const id = plan.queueItemId!;
        const opts = { removeFromClient: true, blocklist: true, skipRedownload: true };
        await guarded('queue removal', () =>
          plan.kind === 'sonarr'
            ? input.arr.write.sonarr.deleteQueueItem(id, opts)
            : input.arr.write.radarr.deleteQueueItem(id, opts),
        );
      },
    });
    return {
      outcome: 'removed_and_searched',
      eventId: r.eventId,
      repairRequestId: null,
      targetLabel: r.targetLabel,
      commandName: r.commandName,
    };
  }

  // import / import_onto
  let check: SonarrImportCheck | RadarrImportCheck;
  if (plan.state === 'import_onto') {
    const onto = input.confirm.ontoEpisodeId;
    if (onto === undefined || !plan.ontoChoices.some((c) => c.episodeId === onto)) {
      throw new FixRefusedError('needs_guide', 'Choose one of the episodes offered, or ask staff for help.');
    }
    check = checkSonarrImportOnto(plan.sonarrCheckInput!, onto);
    if (check.verdict !== 'importable') {
      throw new FixRefusedError('needs_guide', 'That download cannot be added to that episode. Ask staff for help.');
    }
  } else {
    check = (plan.sonarrCheck ?? plan.radarrCheck)!;
  }
  const targetIds = check.file?.targetIds ?? [];
  const { repairRequestId } = await createRepairRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: plan.mediaItemId,
    kind: 'import_download',
    scope: plan.kind === 'radarr' ? 'item' : 'episode',
    seasonNumber: plan.kind === 'radarr' ? null : plan.seasonNumber,
    targetChildIds: plan.kind === 'radarr' ? [] : targetIds,
    seasonEpisodeIds: plan.seasonEpisodeIds,
    targetLabel: label,
    reason: null,
    preview: {
      state: plan.state,
      digest: plan.digest,
      download: plan.download,
      check: plan.check,
      ontoEpisodeId: input.confirm.ontoEpisodeId ?? null,
      files: check.files.map((f) => ({ path: f.path, to: 'episodeIds' in f ? f.episodeIds : f.movieId })),
    },
  });

  let commandId: number;
  let commandName: string;
  try {
    const command =
      check.kind === 'sonarr'
        ? await input.arr.write.sonarr.manualImport(check.files, 'auto')
        : await input.arr.write.radarr.manualImport(check.files, 'auto');
    commandId = command.id;
    commandName = command.name;
  } catch (err) {
    await recordRepairTransition({
      db: input.db,
      repairRequestId,
      transition: 'failed',
      actions: [{ step: 'manual_import', at: new Date().toISOString(), ok: false, error: errText(err) }],
    });
    if (err instanceof ArrError) throw new ArrUpstreamError(`manual import: ${errText(err)}`, { cause: err });
    throw err;
  }
  await recordRepairTransition({
    db: input.db,
    repairRequestId,
    transition: 'actioned',
    actions: [{ step: 'manual_import', at: new Date().toISOString(), ok: true, commandId, files: check.files.length }],
  });

  // Read the command back, then the target (completion is read, never assumed — D-02).
  const wait = input.commandWait ?? DEFAULT_COMMAND_WAIT;
  const read = plan.kind === 'sonarr' ? input.arr.read.sonarr : input.arr.read.radarr;
  const deadline = Date.now() + wait.timeoutMs;
  let status: string | null = null;
  let message: string | null = null;
  for (;;) {
    try {
      const c = await read.getCommand(commandId);
      status = c.status.toLowerCase();
      message = c.message ?? null;
    } catch {
      status = null; // a failed read is not a failed import; keep waiting
    }
    if (status === 'completed' || status === 'failed' || status === 'aborted' || status === 'cancelled' || status === 'orphaned') break;
    if (Date.now() >= deadline) break;
    await sleep(wait.intervalMs);
  }
  if (status === 'completed') {
    const landed = await targetHasFile(input.arr, plan, targetIds).catch(() => null);
    if (landed === true) {
      await recordRepairTransition({
        db: input.db,
        repairRequestId,
        transition: 'completed',
        actions: [{ step: 'read_back', at: new Date().toISOString(), ok: true, commandId }],
      });
      return { outcome: 'imported', eventId: null, repairRequestId, targetLabel: label, commandName };
    }
    if (landed === false) {
      await recordRepairTransition({
        db: input.db,
        repairRequestId,
        transition: 'failed',
        actions: [{ step: 'read_back', at: new Date().toISOString(), ok: false, commandId, note: 'command completed, no file on the target' }],
      });
      throw new FixRefusedError('needs_guide', 'The download could not be added. Ask staff for help.');
    }
  } else if (status !== null && status !== 'queued' && status !== 'started') {
    await recordRepairTransition({
      db: input.db,
      repairRequestId,
      transition: 'failed',
      actions: [{ step: 'read_back', at: new Date().toISOString(), ok: false, commandId, status, message }],
    });
    throw new FixRefusedError('needs_guide', 'The download could not be added. Ask staff for help.');
  }
  return { outcome: 'importing', eventId: null, repairRequestId, targetLabel: label, commandName };
}

async function targetHasFile(arr: ArrClientBundle, plan: InternalPlan, targetIds: number[]): Promise<boolean> {
  if (plan.kind === 'radarr') return (await arr.read.radarr.getMovieById(plan.arrItemId)).hasFile;
  const episodes = await arr.read.sonarr.listEpisodes(plan.arrItemId);
  return targetIds.length > 0 && targetIds.every((id) => episodes.find((e) => e.id === id)?.hasFile === true);
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
