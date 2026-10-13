// DESIGN-055 P4 decisions 18-24 (issue #916, owner ruling on Q-11, 2026-10-13) — the SEASON RE-MAP, staff only: read
// one season, plan it by the files' own names and staff's placements (season-remap-plan.ts, pure), check that Plex
// numbers the season the way TVDB does (otherwise a move would put the wrong title on the file in Plex), and run the
// steps with Sonarr's own ManualImport and RenameFiles, one file at a time.
//
// Each step re-links one file onto episodes that are free at that moment, reads it back, renames that file and reads
// the rename back, before the next step is sent. Renaming every step (not once at the end, as the person's re-map
// does) is what lets a cycle pass: the parked file leaves its old name before the file that takes its episode needs
// that name. The first step that does not land, or whose rename Sonarr skips, stops the run; every step before it is
// whole, and a file left on the parking episode is reported with the placement that finishes it.
//
// Hard rule 4: the writes are the Episode Re-map's own (ADR-109 C-02: ManualImport, RenameFiles) through
// `@hnet/arr/write` from this package. Nothing is deleted or downloaded. Staff run it from the in-cluster tool
// (`repair-guide.ts season-plan | season-run`); its Repair Request has no requester (P4 decision 17).
import { mediaItems, mediaPlexMatches, plexLibraries, plexServers, type DbClient } from '@hnet/db';
import { type SonarrManualImportFile } from '@hnet/arr';
import { eq } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { FixPlanChangedError, FixRefusedError } from './errors';
import { type PlexClientBundle } from './plex-clients';
import { releaseTokens } from './release-terms';
import { getRepairGuideRemedies } from './repair-guide-settings';
import { appendRepairActions, createRepairRequest, recordRepairTransition } from './repair-requests';
import { carryTitleCheckForward } from './title-check';
import {
  abandonWatchCarry,
  carryWatchState,
  markWatchCarryWaiting,
  noteWatchCarry,
  preClearWatchCarry,
  takeWatchCarrySnapshot,
  waitForCarryPlaces,
  type CarryExpectedPlace,
  type WatchCarryPlex,
  type WatchCarryResult,
  type WatchCarrySnapshot,
} from './watch-carry';
import {
  REMAP_COMMAND_WAIT,
  readBackRemapMove,
  readRemapSeasonState,
  remapGuarded,
  waitForSonarrCommand,
  type RemapSeasonState,
  type RemapTargetInput,
} from './remap-flow';
import type { RemapEpisodeRef } from './remap-plan';
import {
  buildSeasonRemapPlan,
  type SeasonRemapPlacement,
  type SeasonRemapPlan,
  type SeasonRemapRefusal,
} from './season-remap-plan';

// ---------------------------------------------------------------------------
// Plex: does it number this season the way TVDB does?
// ---------------------------------------------------------------------------

/** The season as one Plex server holds it: each item's episode number and title. */
export interface PlexSeasonTitles {
  server: string;
  items: Array<{ episodeNumber: number; title: string }>;
}

/** Reads the season on every Plex server that carries the series (tests pass a stub). */
export interface SeasonPlexReader {
  seasonTitles(input: { mediaItemId: string; seasonNumber: number }): Promise<PlexSeasonTitles[]>;
}

/** The production reader: the series' Plex matches (`media_plex_matches`) and each server's `allLeaves`. */
export function seasonPlexReader(input: { db?: DbClient; plex: PlexClientBundle }): SeasonPlexReader {
  return {
    async seasonTitles({ mediaItemId, seasonNumber }) {
      const rows = await resolveDb(input.db)
        .select({ slug: plexServers.slug, ratingKey: mediaPlexMatches.ratingKey })
        .from(mediaPlexMatches)
        .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
        .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
        .where(eq(mediaPlexMatches.mediaItemId, mediaItemId));
      const out: PlexSeasonTitles[] = [];
      for (const row of rows) {
        const client = input.plex.read[row.slug as keyof PlexClientBundle['read']];
        if (!client) continue;
        const leaves = await client.listAllLeaves(row.ratingKey);
        out.push({
          server: row.slug,
          items: leaves.items
            .filter((e) => e.parentIndex === seasonNumber && typeof e.index === 'number')
            .map((e) => ({ episodeNumber: e.index as number, title: e.title })),
        });
      }
      return out;
    },
  };
}

/** A Plex title that only numbers the item ("Episode 13") says nothing. */
const PLACEHOLDER = /^(episode\s*\d+|tba|tbd)$/i;

/** Two titles name the same episode: their folded word sets overlap by at least 0.8 (Dice), as Title Evidence scores. */
export function sameEpisodeTitle(a: string | null, b: string | null): boolean {
  const x = new Set(releaseTokens(a ?? ''));
  const y = new Set(releaseTokens(b ?? ''));
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return (2 * shared) / (x.size + y.size) >= 0.8;
}

export interface SeasonPlexServerCheck {
  server: string;
  /** Plex items in the season. */
  items: number;
  /** Items whose Plex title is the TVDB title of the same number. */
  followsTvdb: number;
  /** Items whose Plex title is another title. */
  differs: number;
  /** Items Plex titles only by number, or whose number TVDB has no title for. */
  unknown: number;
}

export interface SeasonPlexCheck {
  servers: SeasonPlexServerCheck[];
  /**
   * Files that would show another title in Plex after their move (the episode they move to is titled differently
   * there). `rightNow`: Plex shows the file's own title where it sits today, so the move would make Plex worse.
   */
  wrongAfter: Array<{ fileId: number; to: RemapEpisodeRef; server: string; plexTitle: string | null; rightNow: boolean }>;
  /** How many of those would make Plex worse (each refuses a run). */
  worse: number;
  /** No move takes a title Plex shows right today and makes it wrong (a title wrong before and after is no worse). */
  ok: boolean;
}

/** A server follows TVDB for the season when at least this share of its titled items carry the TVDB title. */
export const PLEX_FOLLOWS_TVDB_MIN = 0.9;

/**
 * DESIGN-055 P4 decision 21 — the Plex check: Plex reads the episode number from the renamed file and titles the item
 * from its own metadata (TMDB order on these servers), so a move only fixes what viewers see when Plex's title for the
 * episode a file moves to is that episode's TVDB title. Pure.
 */
export function checkSeasonPlex(input: {
  plan: Pick<SeasonRemapPlan, 'steps'>;
  tvdbTitles: ReadonlyMap<number, string | null>;
  plex: readonly PlexSeasonTitles[];
}): SeasonPlexCheck {
  const servers: SeasonPlexServerCheck[] = input.plex.map((p) => {
    let followsTvdb = 0;
    let differs = 0;
    let unknown = 0;
    for (const item of p.items) {
      const tv = input.tvdbTitles.get(item.episodeNumber) ?? null;
      if (!tv || PLACEHOLDER.test(item.title.trim()) || PLACEHOLDER.test(tv.trim())) unknown += 1;
      else if (sameEpisodeTitle(item.title, tv)) followsTvdb += 1;
      else differs += 1;
    }
    return { server: p.server, items: p.items.length, followsTvdb, differs, unknown };
  });
  // Each moved file's final episode (its last step; a parking step is never final), and where it sits today (its first).
  const finals = new Map<number, RemapEpisodeRef[]>();
  const origins = new Map<number, RemapEpisodeRef[]>();
  for (const s of input.plan.steps) {
    if (!origins.has(s.fileId)) origins.set(s.fileId, s.from);
    if (s.kind !== 'park') finals.set(s.fileId, s.to);
  }
  const wrongAfter: SeasonPlexCheck['wrongAfter'] = [];
  for (const p of input.plex) {
    const check = servers.find((c) => c.server === p.server)!;
    const titled = check.followsTvdb + check.differs;
    const follows = titled > 0 && check.followsTvdb / titled >= PLEX_FOLLOWS_TVDB_MIN;
    for (const [fileId, to] of finals) {
      // Does Plex show this file's own title (the TVDB title of where it belongs) where it sits today?
      const own = to.map((e) => input.tvdbTitles.get(e.episodeNumber) ?? null);
      const rightNow = (origins.get(fileId) ?? []).some((from) => {
        const item = p.items.find((i) => i.episodeNumber === from.episodeNumber);
        return !!item && own.some((t) => !!t && sameEpisodeTitle(item.title, t));
      });
      for (const ep of to) {
        const tv = input.tvdbTitles.get(ep.episodeNumber) ?? null;
        const item = p.items.find((i) => i.episodeNumber === ep.episodeNumber);
        if (item) {
          if (PLACEHOLDER.test(item.title.trim()) || !tv || sameEpisodeTitle(item.title, tv)) continue;
          wrongAfter.push({ fileId, to: ep, server: p.server, plexTitle: item.title, rightNow });
        } else if (!follows) {
          // No item to read yet: trust the season's own numbering only when it follows TVDB.
          wrongAfter.push({ fileId, to: ep, server: p.server, plexTitle: null, rightNow });
        }
      }
    }
  }
  const worse = wrongAfter.filter((w) => w.rightNow).length;
  return { servers, wrongAfter, worse, ok: worse === 0 };
}

// ---------------------------------------------------------------------------
// The plan as staff see it
// ---------------------------------------------------------------------------

export interface SeasonRemapRequest extends RemapTargetInput {
  placements?: readonly SeasonRemapPlacement[];
  keep?: readonly number[];
  /** Plex reader; null skips the Plex check (it is then reported as not done). */
  plex?: SeasonPlexReader | null;
}

export interface SeasonRemapView extends SeasonRemapPlan {
  seriesId: number;
  seriesTitle: string;
  /** null when the check could not be done (`plexError` says why). */
  plexCheck: SeasonPlexCheck | null;
  plexError: string | null;
  /** Whether the `episode_remap` remedy is on (a run refuses while it is off). */
  remapOn: boolean;
  refusalText: string | null;
}

/** The plan's refusals in plain words (the staff tool prints them). */
export function seasonRemapRefusalText(plan: Pick<SeasonRemapPlan, 'refusal' | 'refusalDetail'>): string | null {
  const texts: Record<SeasonRemapRefusal, string> = {
    nothing_to_move: 'No file in this season can move by its name yet.',
    bad_placement: plan.refusalDetail ?? 'A placement does not fit this season.',
    no_parking: 'These files would have to trade places, and the series has no free episode to pass one through.',
    too_many: 'That is more steps than one run takes. Split it with --keep.',
    queue_busy: 'A download for this season is still being added. Try again once it has finished.',
    sonarr_busy: 'Sonarr is still busy moving or renaming files. Try again in a minute.',
  };
  return plan.refusal ? texts[plan.refusal] : null;
}

function planFrom(season: RemapSeasonState, input: SeasonRemapRequest): SeasonRemapPlan {
  return buildSeasonRemapPlan({
    seasonNumber: input.seasonNumber,
    episodes: season.episodes,
    files: season.files,
    placements: input.placements ?? [],
    keep: input.keep ?? [],
    queueBusy: season.queueBusy,
    sonarrBusy: season.sonarrBusy,
    queuedEpisodeIds: season.queuedEpisodeIds,
    queuedSeasonNumbers: season.queuedSeasonNumbers,
  });
}

async function plexCheckFor(
  season: RemapSeasonState,
  input: SeasonRemapRequest,
  plan: SeasonRemapPlan,
): Promise<{ check: SeasonPlexCheck | null; error: string | null }> {
  if (!input.plex) return { check: null, error: 'no Plex reader was given' };
  let titles: PlexSeasonTitles[];
  try {
    titles = await input.plex.seasonTitles({ mediaItemId: season.mediaItemId, seasonNumber: input.seasonNumber });
  } catch (err) {
    // A Plex server that cannot be read leaves the check not done (a run then refuses); staff see why.
    return { check: null, error: errText(err) };
  }
  const tvdbTitles = new Map(
    season.episodes.filter((e) => e.seasonNumber === input.seasonNumber).map((e) => [e.episodeNumber, e.title] as const),
  );
  return { check: checkSeasonPlex({ plan, tvdbTitles, plex: titles }), error: null };
}

/** DESIGN-055 P4 decisions 18-21 — the read-only season plan with its Plex check. */
export async function planSeasonRemap(input: SeasonRemapRequest): Promise<SeasonRemapView> {
  const season = await readRemapSeasonState(input);
  const plan = planFrom(season, input);
  const plex = await plexCheckFor(season, input, plan);
  const remapOn = (await getRepairGuideRemedies(input.db)).episode_remap;
  return {
    ...plan,
    seriesId: season.seriesId,
    seriesTitle: season.seriesTitle,
    plexCheck: plex.check,
    plexError: plex.error,
    remapOn,
    refusalText: seasonRemapRefusalText(plan),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunSeasonRemapInput extends SeasonRemapRequest {
  /** The digest of the plan staff checked. */
  planDigest: string;
  /** Run although the Plex check failed or was not done (staff decision; recorded in the trail). */
  ignorePlex?: boolean;
  /** Per-command wait (tests shorten it). */
  commandWait?: { timeoutMs: number; intervalMs: number };
  /** Pause between steps, to pace Sonarr (tests set 0). */
  stepPauseMs?: number;
  /**
   * ADR-114 / P4 decisions 26-34 — the Watch Carry's Plex clients. When given, the run snapshots every account's watch
   * state first (refusing when it cannot), clears the items the move takes files away from, and after the steps
   * carries each account's state onto the items that now play the files. The staff tool always passes it.
   */
  watchCarry?: WatchCarryPlex | null;
  /** The carry's wait for Plex to show each moved file on its new item (tests shorten it). */
  carryWait?: { timeoutMs: number; intervalMs: number };
  /** Pause between the carry's Plex calls (tests set 0). */
  carryPauseMs?: number;
}

/** ADR-114 — what the run's Watch Carry did: its id, status and per-account counts (no names). */
export interface SeasonRemapCarryOutcome {
  carryId: string;
  status: string;
  accountsWithState: number;
  /** The carry's result once it ran (null while it waits for Plex, or when it failed; `carry-finish` completes it). */
  result: WatchCarryResult | null;
  error: string | null;
}

export interface SeasonRemapRunResult {
  outcome: 'moved' | 'stopped';
  repairRequestId: string;
  /** Steps done of `planned` (each moved, read back and renamed). */
  done: number;
  planned: number;
  /** Files that ended on their episode. */
  moved: number;
  /** A file a stop left on the parking episode, and the episodes it belongs on (finish with `--place`). */
  parked: { fileId: number; on: RemapEpisodeRef; belongs: RemapEpisodeRef[] } | null;
  /** The series held as many episode files after the run as before (nothing was lost or left unmapped). */
  fileCountUnchanged: boolean;
  vacated: RemapEpisodeRef[];
  stoppedText: string | null;
  /** ADR-114 — the Watch Carry (null when the run was given no carry clients). */
  carry: SeasonRemapCarryOutcome | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
type TrailAction = { step: string; at: string; [key: string]: unknown };

/**
 * DESIGN-055 P4 decisions 18-23 — run a season plan staff checked. Refuses (writing nothing) when the remedy is off,
 * the plan changed since staff saw it (digest), the plan refuses, or the Plex check fails without `ignorePlex`. Then one
 * Repair Request (`remap`, no requester) and, per step: the file's manual-import candidate in the season it sits in,
 * ManualImport onto the step's episodes, the read-back, RenameFiles for that file and the rename read-back.
 */
export async function runSeasonRemap(input: RunSeasonRemapInput): Promise<SeasonRemapRunResult> {
  const remedies = await getRepairGuideRemedies(input.db);
  if (!remedies.episode_remap) {
    throw new FixRefusedError('remap_refused', 'Moving episode files is switched off right now.');
  }
  const season = await readRemapSeasonState(input);
  const plan = planFrom(season, input);
  if (plan.digest !== input.planDigest) {
    throw new FixPlanChangedError('The season changed since the plan was checked. Plan it again.');
  }
  if (plan.refusal) throw new FixRefusedError('remap_refused', seasonRemapRefusalText(plan) ?? 'This season cannot be moved.');
  const { check: plexCheck, error: plexError } = await plexCheckFor(season, input, plan);
  if (!input.ignorePlex && (plexCheck === null || !plexCheck.ok)) {
    throw new FixRefusedError(
      'remap_refused',
      plexCheck === null
        ? `The Plex check was not done (${plexError ?? 'unknown'}), so nothing moved.`
        : 'Plex already shows the right title for some of these files, and moving them would make it wrong. Nothing moved.',
    );
  }

  // ADR-114 C-02, C-03 — snapshot every account's watch state and clear what the move takes away, before anything moves.
  let carry: WatchCarrySnapshot | null = null;
  if (input.watchCarry) {
    const sizeOf = new Map(season.files.map((f) => [f.id, f.size] as const));
    const movingIds = [...new Set(plan.steps.map((s) => s.fileId))];
    const sizes = movingIds.map((id) => sizeOf.get(id) ?? null);
    if (sizes.some((size) => size === null || size <= 0)) {
      throw new FixRefusedError('remap_refused', 'Sonarr does not list the size of every file that would move, so their watch state cannot be carried. Nothing moved.');
    }
    const seasons = [...new Set([input.seasonNumber, ...plan.parkings.map((p) => p.seasonNumber)])];
    try {
      carry = await takeWatchCarrySnapshot({
        db: input.db,
        plex: input.watchCarry,
        kind: 'season_remap',
        mediaItemId: season.mediaItemId,
        seriesId: season.seriesId,
        seasons,
        scope: { moved: sizes as number[] },
        detail: { planDigest: plan.digest, seasonNumber: input.seasonNumber },
        pauseMs: input.carryPauseMs,
      });
      await preClearWatchCarry({ db: input.db, plex: input.watchCarry, snapshot: carry, pauseMs: input.carryPauseMs });
    } catch (err) {
      throw new FixRefusedError('remap_refused', `The watch state could not be carried (${errText(err)}). Nothing moved.`);
    }
  }

  const arr = input.arr;
  const sonarr = arr.read.sonarr;
  const seasonOfEpisode = new Map(season.episodes.map((e) => [e.id, e.seasonNumber] as const));
  const seasonIds = season.episodes.filter((e) => e.seasonNumber === input.seasonNumber).map((e) => e.id);
  const touched = [...new Set(plan.steps.flatMap((s) => [...s.from, ...s.to].map((e) => e.id)))];
  const filesBefore = season.files.length;
  const namesOf = new Map(season.files.map((f) => [f.id, f.sourceNames] as const));
  const evidenceEpisodes = season.episodes.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title }));
  let repairRequestId: string;
  try {
    ({ repairRequestId } = await createRepairRequest({
    db: input.db,
    requesterId: null,
    requesterIsAdmin: true,
    mediaItemId: season.mediaItemId,
    kind: 'remap',
    scope: 'season',
    seasonNumber: input.seasonNumber,
    targetChildIds: touched,
    seasonEpisodeIds: seasonIds,
    targetLabel: `Season ${input.seasonNumber}`,
    reason: null,
    preview: {
      claim: { kind: 'names', placements: input.placements ?? [], keep: input.keep ?? [] },
      digest: plan.digest,
      seriesId: season.seriesId,
      seriesTitle: season.seriesTitle,
      parking: plan.parking,
      parkings: plan.parkings,
      steps: plan.steps.map((s) => ({
        kind: s.kind,
        fileId: s.fileId,
        fileName: s.fileName,
        size: s.size,
        releaseGroup: s.releaseGroup,
        why: s.why,
        fromEpisodeIds: s.from.map((e) => e.id),
        toEpisodeIds: s.to.map((e) => e.id),
      })),
      held: plan.held.map((h) => ({ fileId: h.fileId, onEpisodeIds: h.on.map((e) => e.id), reason: h.reason })),
      vacatedEpisodeIds: plan.vacated.map((e) => e.id),
      plexCheck: plexCheck
        ? { ok: plexCheck.ok, servers: plexCheck.servers, wrongAfter: plexCheck.wrongAfter.length, worse: plexCheck.worse }
        : null,
      plexError,
      ignorePlex: input.ignorePlex === true,
      // No Mislabel offer from a season re-map (it is not a shift).
      mislabelGroups: [],
      watchCarry: carry ? { carryId: carry.carryId, accountsWithState: carry.accountsWithState, touchedStates: carry.touchedStates } : null,
    },
  }));
  } catch (err) {
    // The move will not run: put back what the carry cleared.
    if (carry && input.watchCarry) {
      await abandonWatchCarry({ db: input.db, plex: input.watchCarry, carryId: carry.carryId, reason: errText(err), pauseMs: input.carryPauseMs }).catch(() => {});
    }
    throw err;
  }
  if (carry) await noteWatchCarry({ db: input.db, carryId: carry.carryId, detail: { repairRequestId } });

  const wait = input.commandWait ?? REMAP_COMMAND_WAIT;
  const pause = input.stepPauseMs ?? 1_000;
  /** Where each planned file is now: its current episode-file id, path and season. */
  const now = new Map(
    season.files.map((f) => [f.id, { id: f.id, path: f.relativePathFull, seasonNumber: input.seasonNumber }] as const),
  );
  let done = 0;
  /** Steps whose move landed (a stop at the rename leaves one landed but not done). */
  let landed = 0;
  let stoppedText: string | null = null;
  let first = true;
  const record = async (actions: TrailAction[]) => {
    if (first) {
      first = false;
      await recordRepairTransition({ db: input.db, repairRequestId, transition: 'actioned', actions });
    } else {
      await appendRepairActions({ db: input.db, repairRequestId, actions });
    }
  };
  const at = () => new Date().toISOString();

  for (const [index, step] of plan.steps.entries()) {
    const file = now.get(step.fileId);
    const toIds = step.to.map((e) => e.id);
    const toSeason = seasonOfEpisode.get(toIds[0]!) ?? input.seasonNumber;
    if (!file || !file.path) {
      stoppedText = 'One of the files could not be found where the plan expected it, so the rest were not sent.';
      await record([{ step: 'season_remap_stop', at: at(), ok: false, index, fileId: step.fileId }]);
      break;
    }
    // The file's own manual-import candidate, in the season it sits in now (a parked file sits in the parking season).
    let candidate;
    try {
      const candidates = await remapGuarded('season import candidates', () =>
        sonarr.listSeasonImportCandidates(season.seriesId, file.seasonNumber),
      );
      candidate = candidates.find((c) => c.episodeFileId === file.id);
    } catch (err) {
      stoppedText = 'Sonarr could not show one of the files for moving, so the rest were not sent.';
      await record([{ step: 'season_remap_stop', at: at(), ok: false, index, fileId: file.id, error: errText(err) }]);
      break;
    }
    if (!candidate || !candidate.quality) {
      stoppedText = 'Sonarr could not show one of the files for moving, so the rest were not sent.';
      await record([{ step: 'season_remap_stop', at: at(), ok: false, index, fileId: file.id, error: 'no candidate' }]);
      break;
    }
    const body: SonarrManualImportFile = {
      path: candidate.path,
      ...(candidate.folderName ? { folderName: candidate.folderName } : {}),
      seriesId: season.seriesId,
      episodeIds: toIds,
      ...(candidate.releaseGroup ? { releaseGroup: candidate.releaseGroup } : {}),
      quality: candidate.quality,
      languages: candidate.languages ?? [],
      indexerFlags: candidate.indexerFlags ?? 0,
      ...(candidate.releaseType ? { releaseType: candidate.releaseType } : {}),
      episodeFileId: file.id,
    };
    let commandId: number;
    try {
      commandId = (await arr.write.sonarr.manualImport([body], 'move')).id;
    } catch (err) {
      stoppedText = 'Sonarr did not take one of the moves, so the rest were not sent.';
      await record([{ step: 'season_remap_move', at: at(), ok: false, index, kind: step.kind, fileId: file.id, error: errText(err) }]);
      break;
    }
    await record([{ step: 'season_remap_move', at: at(), ok: true, index, kind: step.kind, commandId, fileId: file.id, to: toIds }]);
    const moved = await waitForSonarrCommand(arr, commandId, wait);
    const landedId =
      moved.status === 'completed' ? await readBackRemapMove(arr, season.seriesId, file.path, toIds).catch(() => null) : null;
    if (landedId === null) {
      stoppedText =
        moved.status === 'completed'
          ? 'One of the moves did not land where it should, so the rest were not sent.'
          : 'Sonarr could not finish one of the moves, so the rest were not sent.';
      await record([{ step: 'season_remap_read_back', at: at(), ok: false, index, commandId, fileId: file.id, status: moved.status, message: moved.message }]);
      break;
    }
    now.set(step.fileId, { id: landedId, path: file.path, seasonNumber: toSeason });
    landed += 1;

    // Rename this file now, so its old name is free before a later step needs it.
    let renamed = false;
    let newPath: string | null = null;
    let renameAction: TrailAction;
    try {
      const rename = await arr.write.sonarr.renameFiles(season.seriesId, [landedId]);
      const renameStatus = await waitForSonarrCommand(arr, rename.id, wait);
      const [preview, files] = await Promise.all([
        sonarr.listRenamePreview(season.seriesId, toSeason),
        sonarr.listEpisodeFileReleases(season.seriesId),
      ]);
      newPath = files.find((f) => f.id === landedId)?.relativePath ?? null;
      renamed = newPath !== null && !preview.some((p) => p.episodeFileId === landedId);
      renameAction = { step: 'season_remap_rename', at: at(), ok: renamed, index, commandId: rename.id, status: renameStatus.status, fileId: landedId };
    } catch (err) {
      renameAction = { step: 'season_remap_rename', at: at(), ok: false, index, fileId: landedId, error: errText(err) };
    }
    await record([{ step: 'season_remap_read_back', at: at(), ok: true, index, commandId, fileId: file.id, newFileId: landedId }, renameAction]);
    if (!renamed) {
      stoppedText =
        'One file moved to its episode but Sonarr kept its old name (another file may still hold the new one), so the rest were not sent.';
      break;
    }
    now.set(step.fileId, { id: landedId, path: newPath, seasonNumber: toSeason });
    done += 1;
    // Keep the census honest: the file's names go with it to its new id (a parked file's are carried when it lands).
    if (step.kind !== 'park') {
      try {
        await carryTitleCheckForward({
          db: input.db,
          seriesId: season.seriesId,
          mediaItemId: season.mediaItemId,
          oldFileId: step.fileId,
          newFileId: landedId,
          names: namesOf.get(step.fileId) ?? [],
          episodes: evidenceEpisodes,
          fileEpisodeIds: toIds,
        });
      } catch (err) {
        // The move stands; the census picks the file up again only by hand, so the trail says so.
        await record([{ step: 'season_remap_title_check', at: at(), ok: false, index, fileId: landedId, error: errText(err) }]);
      }
    }
    if (pause > 0 && index < plan.steps.length - 1) await sleep(pause);
  }

  // Nothing lost or left unmapped: the series holds as many episode files as before.
  let fileCountUnchanged = false;
  try {
    fileCountUnchanged = (await sonarr.listEpisodeFileReleases(season.seriesId)).length === filesBefore;
  } catch {
    fileCountUnchanged = false;
  }

  // A stop between a park and its move back leaves that file on the parking episode.
  let parked: SeasonRemapRunResult['parked'] = null;
  const doneSteps = plan.steps.slice(0, done);
  const landedSteps = plan.steps.slice(0, landed);
  // Two cycles open at once can leave two files parked (P4 decision 36): the first is reported, the trail has them all.
  const stillParked = landedSteps.filter((s) => s.kind === 'park' && !landedSteps.some((u) => u.kind === 'unpark' && u.fileId === s.fileId));
  const parkedAll = stillParked.map((parkStep) => {
    const back = plan.steps.find((s) => s.kind === 'unpark' && s.fileId === parkStep.fileId);
    return { fileId: now.get(parkStep.fileId)?.id ?? parkStep.fileId, on: parkStep.to[0]!, belongs: back?.to ?? [] };
  });
  parked = parkedAll[0] ?? null;
  const movedFiles = new Set(doneSteps.filter((s) => s.kind !== 'park').map((s) => s.fileId)).size;

  // ADR-114 C-04..C-06 — carry every account's state onto the items that now play the files, then verify.
  let carryOutcome: SeasonRemapCarryOutcome | null = null;
  const carryActions: TrailAction[] = [];
  if (carry && input.watchCarry) {
    carryOutcome = await finishSeasonCarry({ input, season, carry, plex: input.watchCarry });
    carryActions.push({
      step: 'season_remap_watch_carry',
      at: at(),
      ok: carryOutcome.status === 'verified',
      carryId: carryOutcome.carryId,
      status: carryOutcome.status,
      totals: carryOutcome.result?.totals ?? null,
      ...(carryOutcome.error ? { error: carryOutcome.error } : {}),
    });
  }

  const closing: TrailAction = {
    step: stoppedText === null ? 'season_remap_done' : 'season_remap_stopped',
    at: at(),
    ok: stoppedText === null,
    done,
    planned: plan.steps.length,
    moved: movedFiles,
    fileCountUnchanged,
    ...(parked ? { parkedFileId: parked.fileId, parkedOn: parked.on.id, belongs: parked.belongs.map((e) => e.id) } : {}),
    ...(parkedAll.length > 1 ? { parkedAll: parkedAll.map((p) => ({ fileId: p.fileId, on: p.on.id, belongs: p.belongs.map((e) => e.id) })) } : {}),
  };
  await recordRepairTransition({
    db: input.db,
    repairRequestId,
    transition: stoppedText === null ? 'completed' : 'failed',
    actions: [closing, ...carryActions],
  });
  return {
    outcome: stoppedText === null ? 'moved' : 'stopped',
    repairRequestId,
    done,
    planned: plan.steps.length,
    moved: movedFiles,
    parked,
    fileCountUnchanged,
    vacated: stoppedText === null ? plan.vacated : [],
    stoppedText,
    carry: carryOutcome,
  };
}

/**
 * ADR-114 C-04 — where Sonarr has each of the carry's files now: its season and first episode (Plex shows a two-episode
 * file as one item there).
 */
export function expectedCarryPlaces(
  sizes: readonly number[],
  state: Pick<RemapSeasonState, 'episodes' | 'files'>,
): CarryExpectedPlace[] {
  const out: CarryExpectedPlace[] = [];
  for (const size of sizes) {
    const file = state.files.find((f) => f.size === size);
    if (!file) continue;
    const on = state.episodes.filter((e) => e.episodeFileId === file.id).sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
    if (on.length === 0) continue;
    out.push({ size, season: on[0]!.seasonNumber, episode: on[0]!.episodeNumber });
  }
  return out;
}

/** After the steps: wait for Plex to show each moved file on its new item, then carry and verify (never throws). */
async function finishSeasonCarry(args: {
  input: RunSeasonRemapInput;
  season: RemapSeasonState;
  carry: WatchCarrySnapshot;
  plex: WatchCarryPlex;
}): Promise<SeasonRemapCarryOutcome> {
  const { input, carry, plex } = args;
  const base = { carryId: carry.carryId, accountsWithState: carry.accountsWithState };
  try {
    const sizes = carry.scope.moved === 'all' ? [] : carry.scope.moved;
    const after = await readRemapSeasonState(input);
    const expected = expectedCarryPlaces(sizes, after);
    const wait = await waitForCarryPlaces({ plex, snapshot: carry, expected, ...(input.carryWait ?? {}) });
    if (!wait.ready) {
      await markWatchCarryWaiting({ db: input.db, carryId: carry.carryId, wait });
      return { ...base, status: 'waiting', result: null, error: null };
    }
    const result = await carryWatchState({ db: input.db, plex, carryId: carry.carryId, pauseMs: input.carryPauseMs });
    return { ...base, status: result.status, result, error: null };
  } catch (err) {
    return { ...base, status: 'cleared', result: null, error: errText(err) };
  }
}

/** The ledger item for a Sonarr series by its tvdb id (the staff tool's target lookup). */
export async function sonarrItemByTvdb(input: { db?: DbClient; tvdbId: number }): Promise<{ id: string; title: string } | null> {
  const rows = await resolveDb(input.db)
    .select({ id: mediaItems.id, title: mediaItems.title, arrKind: mediaItems.arrKind, deletedFromArrAt: mediaItems.deletedFromArrAt })
    .from(mediaItems)
    .where(eq(mediaItems.tvdbId, input.tvdbId));
  const live = rows.find((r) => r.arrKind === 'sonarr' && r.deletedFromArrAt === null);
  return live ? { id: live.id, title: live.title } : null;
}
