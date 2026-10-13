// DESIGN-055 P4 decision 25 (issue #928, coordinator ruling 2026-10-13) — the staff SECOND-COPY FIX. A second copy is
// an episode file that holds another episode of the season, one that already has its own file: the slot it sits on
// plays the wrong episode, and that episode's own file is missing from the library. The remedy is the app's Fix on that
// slot, run as staff with no person: delete the copy (nothing is lost, its content is on its own episode) and search
// for the episode the slot is missing.
//
// Guards, all read-only before the Fix Request row (the Fix pattern):
// - the slot holds exactly one file, on this one episode;
// - the file names another episode of the season (its Title Check names, or staff's `copyOf` from evidence), and that
//   episode holds a DIFFERENT file: the content survives the delete (staff confirm by subtitles that both files hold
//   it, recorded as `evidence`);
// - no other file of the season names this slot's episode: if one did, the slot's real content is already in the
//   library and a re-map, not a search, puts it here;
// - no download is queued for the season, and no open Fix or repair holds the episode (createFixRequest).
// Then one Fix Request (`wrong_content`, path `delete_search`, requester null), the delete, its read-back (the slot is
// empty and the original still holds its file), and one EpisodeSearch for the slot.
//
// Hard rule 4: the Fix's own writes (DELETE episodefile, the search command) through `@hnet/arr/write` from here.
import { createHash } from 'node:crypto';
import type { DbClient } from '@hnet/db';
import { ArrError } from '@hnet/arr';
import type { ArrClientBundle } from './arr-clients';
import { FixPlanChangedError, FixRefusedError } from './errors';
import { createFixRequest, recordFixAction } from './fix-requests';
import { episodeLabel } from './media-children';
import { readRemapSeasonState, remapGuarded } from './remap-flow';
import { episodeTitleEvidence } from './title-evidence';

export type SecondCopyRefusal =
  /** The episode has no file, or its file holds other episodes too. */
  | 'no_file'
  /** The file's names do not name another episode of the season, and staff gave none. */
  | 'not_a_copy'
  /** The episode the file holds has no file of its own (or only this one): deleting it would lose that episode. */
  | 'only_copy'
  /** Another file of the season names this episode: its real content is in the library (re-map instead). */
  | 'content_elsewhere'
  /** A download for this season is still in the queue. */
  | 'queue_busy';

export interface SecondCopyPlan {
  seriesId: number;
  seriesTitle: string;
  seasonNumber: number;
  episode: { id: number; episodeNumber: number; label: string };
  copy: { fileId: number; relativePath: string | null; size: number | null; name: string | null } | null;
  /** The episode the copy holds, and its own file. */
  original: { id: number; episodeNumber: number; label: string; fileId: number; relativePath: string | null } | null;
  /** Files of the season whose names name this slot's episode (they would block the delete: `content_elsewhere`). */
  namedElsewhere: Array<{ episodeNumber: number; fileId: number; name: string }>;
  refusal: SecondCopyRefusal | null;
  digest: string;
}

const refusalText: Record<SecondCopyRefusal, string> = {
  no_file: 'That episode has no file of its own to remove.',
  not_a_copy: "The file's name does not name another episode of this season. Give --copy-of from evidence.",
  only_copy: 'The episode this file holds has no other file, so this is the only copy. Re-map it instead.',
  content_elsewhere: "Another file of the season says it is this episode, so its content is already here. Re-map it.",
  queue_busy: 'A download for this season is still in the queue. Try again once it has finished.',
};

export function secondCopyRefusalText(refusal: SecondCopyRefusal | null): string | null {
  return refusal ? refusalText[refusal] : null;
}

export interface SecondCopyRequest {
  db?: DbClient;
  arr: ArrClientBundle;
  mediaItemId: string;
  seasonNumber: number;
  episodeNumber: number;
  /** Staff evidence: the episode number (this season) the copy holds, when its names do not say. */
  copyOf?: number | null;
}

/** DESIGN-055 P4 decision 25 — the read-only plan for removing one second copy. */
export async function planSecondCopyFix(input: SecondCopyRequest): Promise<SecondCopyPlan> {
  const season = await readRemapSeasonState(input);
  const eps = season.episodes.filter((e) => e.seasonNumber === input.seasonNumber);
  const evidenceEpisodes = eps.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title }));
  const ref = (e: (typeof eps)[number]) => ({
    id: e.id,
    episodeNumber: e.episodeNumber,
    label: episodeLabel(e.seasonNumber, e.episodeNumber, e.title ?? ''),
  });
  const target = eps.find((e) => e.episodeNumber === input.episodeNumber);
  const fileById = new Map(season.files.map((f) => [f.id, f] as const));
  /** What a file's names say it is (the Title Check's precedence: agrees, then disagrees). */
  const namedBy = (fileId: number): { episodeNumber: number; name: string } | null => {
    const on = eps.filter((e) => e.episodeFileId === fileId).map((e) => e.id);
    for (const verdict of ['agrees', 'disagrees'] as const) {
      for (const name of fileById.get(fileId)?.sourceNames ?? []) {
        const ev = episodeTitleEvidence({ name, episodes: evidenceEpisodes, againstEpisodeIds: on });
        if (ev.verdict !== verdict) continue;
        const best = verdict === 'agrees' ? eps.find((e) => e.id === on[0]) : eps.find((e) => e.id === ev.bestEpisodeId);
        if (best) return { episodeNumber: best.episodeNumber, name };
      }
    }
    return null;
  };

  let refusal: SecondCopyRefusal | null = null;
  let copy: SecondCopyPlan['copy'] = null;
  let original: SecondCopyPlan['original'] = null;
  const namedElsewhere: SecondCopyPlan['namedElsewhere'] = [];
  if (!target) throw new FixRefusedError('copy_refused', `Season ${input.seasonNumber} has no episode ${input.episodeNumber}.`);
  const fileId = target.episodeFileId;
  if (fileId == null || eps.filter((e) => e.episodeFileId === fileId).length !== 1) {
    refusal = 'no_file';
  } else {
    const f = fileById.get(fileId);
    const named = namedBy(fileId);
    copy = { fileId, relativePath: f?.relativePathFull ?? null, size: f?.size ?? null, name: named?.name ?? f?.sourceNames[0] ?? null };
    const holds = input.copyOf ?? (named && named.episodeNumber !== target.episodeNumber ? named.episodeNumber : null);
    const origEp = holds != null ? eps.find((e) => e.episodeNumber === holds) : undefined;
    if (holds == null || holds === target.episodeNumber || !origEp) refusal = 'not_a_copy';
    else if (origEp.episodeFileId == null || origEp.episodeFileId === fileId) refusal = 'only_copy';
    else {
      const of = fileById.get(origEp.episodeFileId);
      original = { ...ref(origEp), fileId: origEp.episodeFileId, relativePath: of?.relativePathFull ?? null };
    }
    for (const other of season.files) {
      if (other.id === fileId) continue;
      const n = namedBy(other.id);
      const onEps = eps.filter((e) => e.episodeFileId === other.id);
      if (n && n.episodeNumber === target.episodeNumber && onEps.length > 0 && !onEps.some((e) => e.id === target.id)) {
        namedElsewhere.push({ episodeNumber: onEps[0]!.episodeNumber, fileId: other.id, name: n.name });
      }
    }
    if (refusal === null && namedElsewhere.length > 0) refusal = 'content_elsewhere';
  }
  if (refusal === null && season.queueBusy) refusal = 'queue_busy';
  const digest = createHash('sha256')
    .update(JSON.stringify([input.seasonNumber, target.id, copy?.fileId ?? null, copy?.size ?? null, original?.fileId ?? null, refusal]))
    .digest('hex')
    .slice(0, 32);
  return {
    seriesId: season.seriesId,
    seriesTitle: season.seriesTitle,
    seasonNumber: input.seasonNumber,
    episode: ref(target),
    copy,
    original,
    namedElsewhere,
    refusal,
    digest,
  };
}

export interface RunSecondCopyFixInput extends SecondCopyRequest {
  planDigest: string;
  /** Staff's evidence that both files hold the same episode (a short note: the subtitle lines or durations compared). */
  evidence: string;
}

export interface SecondCopyFixResult {
  fixRequestId: string;
  /** The search command Sonarr took for the emptied episode. */
  searchCommandId: number;
}

/**
 * DESIGN-055 P4 decision 25 — run a second-copy Fix staff checked. Re-plans and refuses a changed plan or a refusal
 * (writing nothing); then the Fix Request (requester null), the delete with its read-back, and the search.
 */
export async function runSecondCopyFix(input: RunSecondCopyFixInput): Promise<SecondCopyFixResult> {
  const evidence = input.evidence.trim();
  if (evidence.length < 10) throw new FixRefusedError('copy_refused', 'Record the evidence that both files hold the same episode.');
  const plan = await planSecondCopyFix(input);
  if (plan.digest !== input.planDigest) throw new FixPlanChangedError('The season changed since the plan was checked. Plan it again.');
  if (plan.refusal || !plan.copy || !plan.original) {
    throw new FixRefusedError('copy_refused', secondCopyRefusalText(plan.refusal) ?? 'This file cannot be removed.');
  }
  const { fixRequestId } = await createFixRequest({
    db: input.db,
    requesterId: null,
    requesterIsAdmin: true,
    mediaItemId: input.mediaItemId,
    scope: 'episode',
    targetArrChildId: plan.episode.id,
    targetLabel: plan.episode.label,
    reason: 'wrong_content',
  });
  const at = () => new Date().toISOString();
  const sonarr = input.arr.write.sonarr;
  const endpoint = `DELETE /api/v3/episodefile/${plan.copy.fileId}`;
  const fail = async (step: string, err: unknown) => {
    await recordFixAction({
      db: input.db,
      fixRequestId,
      transition: 'failed',
      actions: [{ step, endpoint, ok: false, at: at(), error: err instanceof Error ? err.message : String(err) }],
    });
  };
  try {
    await sonarr.deleteEpisodeFile(plan.copy.fileId);
  } catch (err) {
    await fail('delete_file', err);
    throw err;
  }
  // Read back: the slot is empty and the original still holds its own file.
  const [episodes, files] = await Promise.all([
    remapGuarded('episodes', () => input.arr.read.sonarr.listEpisodes(plan.seriesId)),
    remapGuarded('episode files', () => input.arr.read.sonarr.listEpisodeFileReleases(plan.seriesId)),
  ]);
  const slot = episodes.find((e) => e.id === plan.episode.id);
  const orig = episodes.find((e) => e.id === plan.original!.id);
  const readBack = {
    slotEmpty: !!slot && !slot.hasFile,
    copyGone: !files.some((f) => f.id === plan.copy!.fileId),
    originalKept: !!orig && orig.hasFile && orig.episodeFileId === plan.original.fileId,
  };
  await recordFixAction({
    db: input.db,
    fixRequestId,
    transition: 'actioned',
    pathTaken: 'delete_search',
    actions: [
      {
        step: 'second_copy',
        endpoint: 'repair-guide.ts copy-run',
        ok: true,
        at: at(),
        copy: { fileId: plan.copy.fileId, relativePath: plan.copy.relativePath, size: plan.copy.size, name: plan.copy.name },
        original: { episodeId: plan.original.id, label: plan.original.label, fileId: plan.original.fileId, relativePath: plan.original.relativePath },
        evidence,
      },
      { step: 'delete_file', endpoint, ok: true, at: at(), status: 200 },
      { step: 'delete_read_back', endpoint: 'GET /api/v3/episode, /episodefile', ok: readBack.slotEmpty && readBack.copyGone && readBack.originalKept, at: at(), ...readBack },
    ],
  });
  if (!readBack.originalKept) {
    // Never search over a library that lost the original: staff look first.
    await recordFixAction({ db: input.db, fixRequestId, transition: 'failed', actions: [{ step: 'original_missing', endpoint: 'GET /api/v3/episode', ok: false, at: at() }] });
    throw new FixRefusedError('copy_refused', 'The copy was removed but the original no longer reads back on its episode. Nothing was searched.');
  }
  let searchCommandId: number;
  try {
    searchCommandId = (await sonarr.searchEpisodes([plan.episode.id])).id;
  } catch (err) {
    if (err instanceof ArrError) await fail('trigger_search', err);
    throw err;
  }
  await recordFixAction({
    db: input.db,
    fixRequestId,
    transition: 'search_triggered',
    actions: [{ step: 'trigger_search', endpoint: 'POST /api/v3/command (EpisodeSearch)', ok: true, at: at(), commandId: searchCommandId }],
  });
  return { fixRequestId, searchCommandId };
}
