// ADR-109 C-02, C-03, C-04 / DESIGN-055 D-04 (PLAN-077 P4) — the Episode Re-map: read one season, plan the claim
// (remap-plan.ts, pure), and, once the person confirmed the plan they saw, move the existing library files onto the
// right episodes with Sonarr's own ManualImport, one move at a time, highest first for a +1 shift. Nothing is downloaded
// and nothing is deleted (owner ruling, 2026-10-12): a ManualImport of a file already inside the series folder only
// re-links it (remap-plan.ts has the Sonarr facts). Then RenameFiles gives the moved files their new episode names, so
// Plex (which reads the names) sees the fix.
//
// Order of writes (hard rule 4, the Fix pattern): the plan is re-read and its digest compared (rule 6), the Repair
// Request row commits with its `repair_requested` event, and only then is the first *arr call made. Every move is read
// back before the next one is sent; the first mismatch stops the run, and by the plan's order every move done so far is
// whole (rule 7). Behind the `episode_remap` remedy of `repair_guide_remedies`; one press is one unit of the hourly
// budget, and the season's grain is held against any open Fix or repair (D-02).
import { mediaItems, titleChecks, type DbClient } from '@hnet/db';
import { ArrError, type SonarrManualImportCandidate, type SonarrManualImportFile } from '@hnet/arr';
import { and, eq } from 'drizzle-orm';
import { type ArrClientBundle } from './arr-clients';
import { resolveDb } from './db-client';
import { ArrUpstreamError, FixPlanChangedError, FixRefusedError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { getRepairGuideRemedies } from './repair-guide-settings';
import { appendRepairActions, createRepairRequest, recordRepairTransition } from './repair-requests';
import {
  buildRemapPlan,
  suggestRemap,
  type RemapClaim,
  type RemapEpisode,
  type RemapEpisodeRef,
  type RemapFile,
  type RemapPlan,
  type RemapSuggestion,
} from './remap-plan';
import { episodeLabel } from './media-children';
import { isLibraryFileName } from './title-check';
import type { FixReason } from '@hnet/db';

export interface RemapTargetInput {
  db?: DbClient;
  arr: ArrClientBundle;
  mediaItemId: string;
  seasonNumber: number;
}

/** One season as the re-maps read it (the person's re-map here, staff's Season Re-map in season-remap-flow.ts). */
export interface RemapSeasonState {
  mediaItemId: string;
  seriesId: number;
  seriesTitle: string;
  episodes: RemapEpisode[];
  files: Array<RemapFile & { relativePathFull: string | null; sourceNames: string[] }>;
  queueBusy: boolean;
  sonarrBusy: boolean;
}

/** An *arr call whose ArrError becomes an ArrUpstreamError naming `what` (the re-maps' reads). */
export async function remapGuarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArrError) {
      throw new ArrUpstreamError(`${what}: ${err instanceof Error ? err.message : 'failed'}`, { cause: err });
    }
    throw err;
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Read one season for a re-map: the episodes, the files with the names they were imported under, and whether a
 *  download or an earlier move or rename is still in flight. */
export async function readRemapSeasonState(input: RemapTargetInput): Promise<RemapSeasonState> {
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
  if (item.arrKind !== 'sonarr') {
    throw new FixRefusedError('remap_refused', 'Only TV episodes can be moved. A wrong movie is fixed with Fix.');
  }
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to move in the *arr`);
  }
  const sonarr = input.arr.read.sonarr;
  const [episodes, files, queue, commands] = await Promise.all([
    remapGuarded('episodes', () => sonarr.listEpisodes(item.arrItemId)),
    remapGuarded('episode files', () => sonarr.listEpisodeFileReleases(item.arrItemId)),
    remapGuarded('queue', () => sonarr.getQueue(item.arrItemId)),
    remapGuarded('commands', () => sonarr.listCommands()),
  ]);
  const sonarrBusy = commands.some(
    (c) => (c.name === 'ManualImport' || c.name === 'RenameFiles') && ['queued', 'started'].includes(c.status.toLowerCase()),
  );
  // The name each file was imported under: Sonarr's scene name, else what the Title Check judged.
  const judged = await db
    .select({ fileId: titleChecks.episodeFileId, name: titleChecks.sourceTitle })
    .from(titleChecks)
    .where(and(eq(titleChecks.instance, 'sonarr'), eq(titleChecks.seriesId, item.arrItemId)));
  const judgedName = new Map(judged.map((r) => [r.fileId, r.name] as const));
  const seasonEpisodeIds = new Set(
    episodes.filter((e) => e.seasonNumber === input.seasonNumber).map((e) => e.id),
  );
  const queueBusy = queue.some(
    (r) => r.seasonNumber === input.seasonNumber || (r.episodeId != null && seasonEpisodeIds.has(r.episodeId)),
  );
  return {
    mediaItemId: item.id,
    seriesId: item.arrItemId,
    seriesTitle: item.title,
    episodes: episodes.map((e) => ({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      title: e.title ?? null,
      episodeFileId: e.hasFile && e.episodeFileId ? e.episodeFileId : null,
    })),
    files: files.map((f) => {
      // A library's own earlier name is no evidence (DESIGN-055 P4 decision 16).
      const names = [f.sceneName?.trim() || null, judgedName.get(f.id)?.trim() || null].filter(
        (n): n is string => !!n && !isLibraryFileName(n),
      );
      return {
        id: f.id,
        seasonNumber: f.seasonNumber ?? null,
        relativePath: f.relativePath ?? null,
        relativePathFull: f.relativePath ?? null,
        size: f.size ?? null,
        releaseGroup: f.releaseGroup ?? null,
        qualityName: f.quality?.quality?.name ?? null,
        sourceName: names[0] ?? null,
        sourceNames: [...new Set(names)],
      };
    }),
    queueBusy,
    sonarrBusy,
  };
}

// ---------------------------------------------------------------------------
// Reads for the guide
// ---------------------------------------------------------------------------

export interface RemapSeasonEpisode extends RemapEpisodeRef {
  hasFile: boolean;
  fileName: string | null;
  /** Two or more episodes share this file. */
  multiEpisode: boolean;
}

export interface RemapSeasonView {
  /** Whether the `episode_remap` remedy is on (off: the guide does not offer moving files). */
  remapOn: boolean;
  seasonNumber: number;
  seriesTitle: string;
  episodes: RemapSeasonEpisode[];
  suggestion: RemapSuggestion;
  queueBusy: boolean;
}

/**
 * DESIGN-055 D-04 rules 1-2 — the season as the guide shows it: every episode with whether it has a file, and the claim
 * Title Evidence suggests (files whose name names another episode). Read-only, costs nothing.
 */
export async function readRemapSeason(input: RemapTargetInput & { remapOn?: boolean }): Promise<RemapSeasonView> {
  const season = await readRemapSeasonState(input);
  const remedies = input.remapOn === undefined ? await getRepairGuideRemedies(input.db) : null;
  const inSeason = season.episodes
    .filter((e) => e.seasonNumber === input.seasonNumber)
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
  const fileUse = new Map<number, number>();
  for (const e of inSeason) if (e.episodeFileId != null) fileUse.set(e.episodeFileId, (fileUse.get(e.episodeFileId) ?? 0) + 1);
  const fileById = new Map(season.files.map((f) => [f.id, f] as const));
  return {
    remapOn: input.remapOn ?? remedies!.episode_remap,
    seasonNumber: input.seasonNumber,
    seriesTitle: season.seriesTitle,
    episodes: inSeason.map((e) => {
      const f = e.episodeFileId != null ? fileById.get(e.episodeFileId) : undefined;
      const path = f?.relativePath ?? null;
      return {
        id: e.id,
        episodeNumber: e.episodeNumber,
        title: e.title,
        label: episodeLabel(e.seasonNumber, e.episodeNumber, e.title ?? ''),
        hasFile: e.episodeFileId != null,
        fileName: path ? (path.split(/[\\/]/).pop() ?? null) : null,
        multiEpisode: e.episodeFileId != null && (fileUse.get(e.episodeFileId) ?? 0) > 1,
      };
    }),
    suggestion: suggestRemap({ seasonNumber: input.seasonNumber, episodes: season.episodes, files: season.files }),
    queueBusy: season.queueBusy,
  };
}

/** The plan as the guide shows it (never the internal paths). */
export interface PublicRemapPlan extends RemapPlan {
  remapOn: boolean;
  seriesTitle: string;
  /** Plain words for a refusal, or null. */
  refusalText: string | null;
}

/** D-04 refusals in plain words (the guide shows them; the server refuses with the same text). */
export function remapRefusalText(plan: Pick<RemapPlan, 'refusal' | 'blocker'>): string | null {
  const b = plan.blocker;
  switch (plan.refusal) {
    case null:
      return null;
    case 'nothing_to_move':
      return 'There is no file to move there.';
    case 'same_episode':
      return 'That is the episode the file is already on.';
    case 'no_such_episode':
      return 'That would move a file past the last episode of the season.';
    case 'occupied':
      if (b?.misplaced) {
        return `The file on ${b.episode.label} seems to be on the wrong episode too, so the two would have to trade places. That needs staff for now.`;
      }
      return b
        ? `${b.episode.label} has its own file, which this would not move. Fix that episode first, or ask staff for help.`
        : 'One of those episodes has its own file, which this would not move. Ask staff for help.';
    case 'collision':
      return b ? `Two files would end up on ${b.episode.label}.` : 'Two files would end up on the same episode.';
    case 'cycle':
      return 'These files would have to swap places, and that needs staff.';
    case 'split_multi':
      return b
        ? `The file on ${b.episode.label} holds two episodes, and this would split it. Ask staff for help.`
        : 'One file holds two episodes, and this would split it. Ask staff for help.';
    case 'too_many':
      return 'That is more than 40 files at once. Ask staff for help with this one.';
    case 'queue_busy':
      return 'A download for this season is still being added. Try again once it has finished.';
    case 'sonarr_busy':
      return 'Sonarr is still busy moving or renaming files. Try again in a minute.';
  }
}

export interface RemapPlanRequest extends RemapTargetInput {
  claim: RemapClaim;
}

/** DESIGN-055 D-04 — the read-only plan for a claim: what moves where, in what order, and what is left empty. */
export async function planEpisodeRemap(input: RemapPlanRequest & { remapOn?: boolean }): Promise<PublicRemapPlan> {
  const season = await readRemapSeasonState(input);
  const plan = buildRemapPlan({
    seasonNumber: input.seasonNumber,
    claim: input.claim,
    episodes: season.episodes,
    files: season.files,
    queueBusy: season.queueBusy,
    sonarrBusy: season.sonarrBusy,
  });
  const remapOn = input.remapOn ?? (await getRepairGuideRemedies(input.db)).episode_remap;
  return { ...plan, remapOn, seriesTitle: season.seriesTitle, refusalText: remapRefusalText(plan) };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunRemapInput extends RemapPlanRequest {
  /** The person who confirmed the plan; null is staff working from the in-cluster tool (P4 decision 17). */
  requesterId: string | null;
  requesterIsAdmin?: boolean;
  /** The digest of the plan the person confirmed. */
  planDigest: string;
  /** The Fix reason the guide started from, when it did. */
  reason?: FixReason | null;
  /** Per-command wait (tests shorten it). */
  commandWait?: { timeoutMs: number; intervalMs: number };
}

export type RemapOutcome =
  /** Every move landed (and the files were renamed, or `renamed` says which were not). */
  | 'moved'
  /** The run stopped part way: `moved` moves landed whole, the rest were not sent. */
  | 'stopped';

export interface RemapRunResult {
  outcome: RemapOutcome;
  repairRequestId: string;
  /** How many moves landed, of `planned`. */
  moved: number;
  planned: number;
  /** Every moved file was renamed to its new episode (false: Sonarr kept an old name; staff can rename). */
  renamed: boolean;
  /** Episodes left without a file (each is offered Force Search, D-04 rule 9). Only when every move landed. */
  vacated: RemapEpisodeRef[];
  /** D-04 rule 10: the Mislabel Block offer (a shift, two or more moved files of one group). */
  mislabelGroups: Array<{ releaseGroup: string; fileCount: number }>;
  /** Plain words for a stop, or null. */
  stoppedText: string | null;
}

export const REMAP_COMMAND_WAIT = { timeoutMs: 60_000, intervalMs: 1_000 };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(['completed', 'failed', 'aborted', 'cancelled', 'orphaned']);

/** Poll one Sonarr command until it ends or the wait runs out (a failed read is not a failed command). */
export async function waitForSonarrCommand(
  arr: ArrClientBundle,
  commandId: number,
  wait: { timeoutMs: number; intervalMs: number },
): Promise<{ status: string | null; message: string | null }> {
  const deadline = Date.now() + wait.timeoutMs;
  let status: string | null = null;
  let message: string | null = null;
  for (;;) {
    try {
      const c = await arr.read.sonarr.getCommand(commandId);
      status = c.status.toLowerCase();
      message = c.message ?? null;
    } catch {
      status = null; // a failed read is not a failed command; keep waiting
    }
    if (status !== null && TERMINAL.has(status)) return { status, message };
    if (Date.now() >= deadline) return { status, message };
    await sleep(wait.intervalMs);
  }
}

/**
 * DESIGN-055 D-04 rules 6-9 — run a confirmed re-map. Refuses (writing nothing) when the remedy is off, the plan changed
 * since the person saw it, or the plan refuses. Then one Repair Request (`remap`), one ManualImport per move in the
 * plan's order, each read back before the next, then RenameFiles and its read-back.
 */
export async function runEpisodeRemap(input: RunRemapInput): Promise<RemapRunResult> {
  const remedies = await getRepairGuideRemedies(input.db);
  if (!remedies.episode_remap) {
    throw new FixRefusedError('remap_refused', 'Moving episode files is switched off right now. Ask staff for help.');
  }
  const season = await readRemapSeasonState(input);
  const plan = buildRemapPlan({
    seasonNumber: input.seasonNumber,
    claim: input.claim,
    episodes: season.episodes,
    files: season.files,
    queueBusy: season.queueBusy,
    sonarrBusy: season.sonarrBusy,
  });
  if (plan.digest !== input.planDigest) {
    throw new FixPlanChangedError('The season changed since you looked. Here is what it looks like now.');
  }
  if (plan.refusal) throw new FixRefusedError('remap_refused', remapRefusalText(plan) ?? 'This cannot be moved.');

  // Rule 7: each move sends the file's own manual-import candidate back with its new episodes.
  const candidates = await remapGuarded('season import candidates', () =>
    input.arr.read.sonarr.listSeasonImportCandidates(season.seriesId, input.seasonNumber),
  );
  const byFileId = new Map<number, SonarrManualImportCandidate>();
  for (const c of candidates) if (c.episodeFileId) byFileId.set(c.episodeFileId, c);
  const fileById = new Map(season.files.map((f) => [f.id, f] as const));
  const steps: Array<{ moveIndex: number; file: SonarrManualImportFile; relativePath: string }> = [];
  for (const [moveIndex, move] of plan.moves.entries()) {
    const c = byFileId.get(move.fileId);
    const relativePath = fileById.get(move.fileId)?.relativePathFull ?? null;
    if (!c || !relativePath || !c.quality) {
      throw new FixRefusedError('remap_refused', 'Sonarr could not show one of these files for moving. Ask staff for help.');
    }
    steps.push({
      moveIndex,
      relativePath,
      // The fields Sonarr 4.0.20.3012's interactive import sends for a library file (InteractiveImportModalContent
      // `onImportSelectedPress`); a field the candidate lacks is left out, and a library file has no download id.
      file: {
        path: c.path,
        ...(c.folderName ? { folderName: c.folderName } : {}),
        seriesId: season.seriesId,
        episodeIds: move.to.map((e) => e.id),
        ...(c.releaseGroup ? { releaseGroup: c.releaseGroup } : {}),
        quality: c.quality,
        languages: c.languages ?? [],
        indexerFlags: c.indexerFlags ?? 0,
        ...(c.releaseType ? { releaseType: c.releaseType } : {}),
        episodeFileId: move.fileId,
      },
    });
  }

  const allSeasonIds = season.episodes.filter((e) => e.seasonNumber === input.seasonNumber).map((e) => e.id);
  const touched = [...new Set(plan.moves.flatMap((m) => [...m.from, ...m.to].map((e) => e.id)))];
  const { repairRequestId } = await createRepairRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: season.mediaItemId,
    kind: 'remap',
    scope: 'season',
    seasonNumber: input.seasonNumber,
    targetChildIds: touched,
    // The moves re-link files across the season, so a Fix on any of its episodes waits (D-02).
    seasonEpisodeIds: allSeasonIds,
    targetLabel: `Season ${input.seasonNumber}`,
    reason: input.reason ?? null,
    preview: {
      claim: plan.claim,
      digest: plan.digest,
      seriesId: season.seriesId,
      seriesTitle: season.seriesTitle,
      moves: plan.moves.map((m) => ({
        fileId: m.fileId,
        fileName: m.fileName,
        size: m.size,
        releaseGroup: m.releaseGroup,
        fromEpisodeIds: m.from.map((e) => e.id),
        toEpisodeIds: m.to.map((e) => e.id),
      })),
      vacatedEpisodeIds: plan.vacated.map((e) => e.id),
      mislabelGroups: plan.mislabelGroups,
    },
  });

  const wait = input.commandWait ?? REMAP_COMMAND_WAIT;
  const movedFileIds: number[] = [];
  let stoppedText: string | null = null;
  let stopAction: { step: string; at: string; [key: string]: unknown } | null = null;
  for (const step of steps) {
    const move = plan.moves[step.moveIndex]!;
    const at = () => new Date().toISOString();
    let commandId: number;
    try {
      const command = await input.arr.write.sonarr.manualImport([step.file], 'move');
      commandId = command.id;
    } catch (err) {
      stoppedText = 'Sonarr did not take one of the moves, so the rest were not sent.';
      stopAction = { step: 'remap_move', at: at(), ok: false, fileId: move.fileId, error: errText(err) };
      break;
    }
    const sent = { step: 'remap_move', at: at(), ok: true, commandId, fileId: move.fileId, to: step.file.episodeIds };
    if (movedFileIds.length === 0) {
      await recordRepairTransition({ db: input.db, repairRequestId, transition: 'actioned', actions: [sent] });
    } else {
      await appendRepairActions({ db: input.db, repairRequestId, actions: [sent] });
    }
    const { status, message } = await waitForSonarrCommand(input.arr, commandId, wait);
    let landedId: number | null = null;
    if (status === 'completed') {
      landedId = await readBackRemapMove(input.arr, season.seriesId, step.relativePath, step.file.episodeIds).catch(() => null);
    }
    if (landedId === null) {
      stoppedText =
        status === 'completed'
          ? 'One of the moves did not land where it should, so the rest were not sent.'
          : status === null || status === 'queued' || status === 'started'
            ? 'Sonarr is still busy with one of the moves, so the rest were not sent.'
            : 'Sonarr could not finish one of the moves, so the rest were not sent.';
      stopAction = { step: 'remap_read_back', at: at(), ok: false, commandId, fileId: move.fileId, status, message };
      break;
    }
    movedFileIds.push(landedId);
    await appendRepairActions({
      db: input.db,
      repairRequestId,
      actions: [{ step: 'remap_read_back', at: at(), ok: true, commandId, fileId: move.fileId, newFileId: landedId }],
    });
  }

  // Rule 8: rename what moved (also after a stop: the moved files carry their old episode's name until renamed).
  const rename = movedFileIds.length > 0 ? await renameMoved(input, season.seriesId, movedFileIds) : { renamed: true, trail: [] };
  const renamed = rename.renamed;

  if (stoppedText !== null) {
    // A stop before the first move was sent leaves the row pending; `failed` closes it either way and releases the grain.
    await recordRepairTransition({
      db: input.db,
      repairRequestId,
      transition: 'failed',
      actions: [...rename.trail, { ...(stopAction ?? { step: 'remap_stop', at: new Date().toISOString(), ok: false }), movedSoFar: movedFileIds.length }],
    });
    return {
      outcome: 'stopped',
      repairRequestId,
      moved: movedFileIds.length,
      planned: plan.moves.length,
      renamed,
      vacated: [],
      mislabelGroups: [],
      stoppedText,
    };
  }
  await recordRepairTransition({
    db: input.db,
    repairRequestId,
    transition: 'completed',
    actions: [...rename.trail, { step: 'remap_done', at: new Date().toISOString(), ok: true, moved: movedFileIds.length, renamed }],
  });
  return {
    outcome: 'moved',
    repairRequestId,
    moved: movedFileIds.length,
    planned: plan.moves.length,
    renamed,
    vacated: plan.vacated,
    mislabelGroups: plan.mislabelGroups,
    stoppedText: null,
  };
}

/**
 * Rule 7's read-back: the file at `relativePath` now holds exactly the target episodes. A library file keeps its path
 * through the import (Sonarr re-links it under a new episode-file id), so the path finds it. Returns the new id.
 */
export async function readBackRemapMove(
  arr: ArrClientBundle,
  seriesId: number,
  relativePath: string,
  targetIds: number[],
): Promise<number | null> {
  const [episodes, files] = await Promise.all([
    arr.read.sonarr.listEpisodes(seriesId),
    arr.read.sonarr.listEpisodeFileReleases(seriesId),
  ]);
  const file = files.find((f) => f.relativePath === relativePath);
  if (!file) return null;
  const onTargets = targetIds.every((id) => {
    const e = episodes.find((x) => x.id === id);
    return e?.hasFile === true && e.episodeFileId === file.id;
  });
  const elsewhere = episodes.some((e) => e.episodeFileId === file.id && !targetIds.includes(e.id));
  return onTargets && !elsewhere ? file.id : null;
}

/**
 * Rule 8: RenameFiles for the moved files, then Sonarr's own rename preview as the read-back. Sonarr renames in its own
 * order and skips a name another file still holds, so a second pass picks up what the first skipped. Never fatal: the
 * files are on the right episodes either way.
 */
async function renameMoved(
  input: RunRemapInput,
  seriesId: number,
  fileIds: number[],
): Promise<{ renamed: boolean; trail: Array<{ step: string; at: string; [key: string]: unknown }> }> {
  const wait = input.commandWait ?? REMAP_COMMAND_WAIT;
  let pending = fileIds;
  const trail: Array<{ step: string; at: string; [key: string]: unknown }> = [];
  for (let pass = 1; pass <= 3 && pending.length > 0; pass += 1) {
    try {
      const command = await input.arr.write.sonarr.renameFiles(seriesId, pending);
      const { status } = await waitForSonarrCommand(input.arr, command.id, wait);
      const preview = await input.arr.read.sonarr.listRenamePreview(seriesId, input.seasonNumber);
      const left = new Set(preview.map((p) => p.episodeFileId));
      const before = pending.length;
      pending = pending.filter((id) => left.has(id));
      trail.push({ step: 'remap_rename', at: new Date().toISOString(), ok: pending.length === 0, pass, commandId: command.id, status, left: pending.length });
      if (pending.length === before) break; // no progress: stop asking
    } catch (err) {
      trail.push({ step: 'remap_rename', at: new Date().toISOString(), ok: false, pass, error: errText(err) });
      break;
    }
  }
  return { renamed: pending.length === 0, trail };
}
