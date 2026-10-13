// DESIGN-055 P4 decision 38 (coordinator ruling on issue #928, 2026-10-13: "they are bugs, fix them"; C then A) — the
// staff WRONG-CONTENT REPLACE. An episode file that holds the wrong content (another season's story, another show's
// episode) is replaced only when a correct release for that slot exists: the release is found first (the Release
// Pick's own season search, read as if the file were already gone), and only then is the file deleted and that release
// grabbed. Where no correct release exists, the wrong file stays (an empty slot helps nobody), flagged and recorded as
// waiting for a release.
//
// Watch state (ADR-114): a mark on the wrong content does not mean the person saw the right episode, so it never lands
// on the replacement. Where that wrong content also lives correctly elsewhere in the show (staff evidence: `sameAs`,
// e.g. Mickey Mouse's Season 3 stories filed on Season 1), the carry credits the mark to that copy; otherwise the mark
// is dropped and the carry records it (`dropped` on the carry, and the pre-clear audit row keeps the state).
//
// Writes: the Fix's own (DELETE episodefile) and the Release Pick's grab (POST /release with the override body), through
// `@hnet/arr/write` from this package (hard rule 4), inside one Fix Request per slot (requester null: the staff tool).
import { createHash } from 'node:crypto';
import type { DbClient, FixActionEntry } from '@hnet/db';
import type { ArrClientBundle } from './arr-clients';
import { FixPlanChangedError, FixRefusedError } from './errors';
import { createFixRequest, recordFixAction } from './fix-requests';
import { episodeLabel } from './media-children';
import { previewReplacementList, readReleasePickTarget, sendReleaseGrab, type ReleasePickOffer } from './release-pick';
import { readRemapSeasonState, remapGuarded } from './remap-flow';
import {
  abandonWatchCarry,
  carryWatchState,
  noteWatchCarry,
  preClearWatchCarry,
  takeWatchCarrySnapshot,
  type WatchCarryPlex,
  type WatchCarryResult,
  type WatchCarrySnapshot,
} from './watch-carry';

export type WrongContentRefusal =
  /** The episode has no file. */
  | 'no_file'
  /** The file sits on episodes of more than one season. */
  | 'other_season'
  /** No release names this slot's episode and could be grabbed once the file is gone: the wrong file stays. */
  | 'no_release'
  /** A download for this episode is already on its way or stuck in the queue. */
  | 'queue_busy';

export interface WrongContentCandidate {
  key: string;
  title: string;
  state: 'grab' | 'override';
  /** Why it would need an override (plain-words codes), empty for a plain grab. */
  reasonCodes: string[];
}

export interface WrongContentPlan {
  seriesId: number;
  seriesTitle: string;
  seasonNumber: number;
  /** Every episode the wrong file sits on (all are emptied and refilled by one release). */
  slot: Array<{ id: number; episodeNumber: number; label: string }>;
  file: { id: number; size: number | null; name: string | null } | null;
  /** Releases that name this slot's episodes, would be taken once the file is gone, and cover the whole slot. Best first. */
  candidates: WrongContentCandidate[];
  refusal: WrongContentRefusal | null;
  digest: string;
}

const REFUSAL_TEXT: Record<WrongContentRefusal, string> = {
  no_file: 'That episode has no file to replace.',
  other_season: 'The file sits on episodes of more than one season.',
  no_release: 'No release names this episode and could be grabbed, so the file stays where it is for now.',
  queue_busy: 'A download for this episode is already in the queue.',
};

export function wrongContentRefusalText(refusal: WrongContentRefusal | null): string | null {
  return refusal ? REFUSAL_TEXT[refusal] : null;
}

export interface WrongContentRequest {
  db?: DbClient;
  arr: ArrClientBundle;
  mediaItemId: string;
  seasonNumber: number;
  episodeNumber: number;
}

/**
 * An offer replaces the slot when its name agrees with the slot's episode, and it lands on exactly the slot's episodes:
 * one episode numbered for it (or numbered for another with this one's title), or a multi-episode release holding the
 * same episodes as the slot.
 */
function coversSlot(offer: ReleasePickOffer, slotIds: readonly number[]): boolean {
  if (offer.titleVerdict !== 'agrees') return false;
  if (slotIds.length === 1) return offer.episodeIds === null;
  if (!offer.episodeIds) return false;
  const a = [...offer.episodeIds].sort((x, y) => x - y);
  const b = [...slotIds].sort((x, y) => x - y);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function readPlan(input: WrongContentRequest): Promise<{ plan: WrongContentPlan; offers: ReleasePickOffer[] }> {
  const season = await readRemapSeasonState(input);
  const target = season.episodes.find((e) => e.seasonNumber === input.seasonNumber && e.episodeNumber === input.episodeNumber);
  if (!target) throw new FixRefusedError('copy_refused', `Season ${input.seasonNumber} has no episode ${input.episodeNumber}.`);
  const fileId = target.episodeFileId;
  const slotEps = fileId == null ? [] : season.episodes.filter((e) => e.episodeFileId === fileId).sort((a, b) => a.episodeNumber - b.episodeNumber);
  const f = fileId == null ? undefined : season.files.find((x) => x.id === fileId);
  const slot = (slotEps.length > 0 ? slotEps : [target]).map((e) => ({
    id: e.id,
    episodeNumber: e.episodeNumber,
    label: episodeLabel(e.seasonNumber, e.episodeNumber, e.title ?? ''),
  }));
  const base = {
    seriesId: season.seriesId,
    seriesTitle: season.seriesTitle,
    seasonNumber: input.seasonNumber,
    slot,
    file: f ? { id: f.id, size: f.size ?? null, name: (f.relativePathFull ?? '').split(/[\\/]/).pop() ?? null } : null,
  };
  let refusal: WrongContentRefusal | null = null;
  let offers: ReleasePickOffer[] = [];
  let candidates: WrongContentCandidate[] = [];
  if (fileId == null || !f) refusal = 'no_file';
  else if (slotEps.some((e) => e.seasonNumber !== input.seasonNumber)) refusal = 'other_season';
  else {
    const list = await previewReplacementList({
      db: input.db,
      arr: input.arr,
      mediaItemId: input.mediaItemId,
      scope: 'episode',
      targetChildId: slot[0]!.id,
      freedEpisodeIds: slot.map((e) => e.id),
    });
    if (list.status !== 'list') refusal = 'queue_busy';
    else {
      const slotIds = slot.map((e) => e.id);
      offers = list.offers
        .filter((o) => coversSlot(o, slotIds))
        // A plain grab before an override; otherwise the *arr's own order.
        .map((o, i) => ({ o, i }))
        .sort((a, b) => Number(a.o.state === 'override') - Number(b.o.state === 'override') || a.i - b.i)
        .map((x) => x.o);
      candidates = offers.map((o) => ({ key: o.key, title: o.title, state: o.state, reasonCodes: [...o.reasonCodes] }));
      if (candidates.length === 0) refusal = 'no_release';
    }
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([input.seasonNumber, slot.map((e) => e.id), base.file?.id ?? null, base.file?.size ?? null, refusal]))
    .digest('hex')
    .slice(0, 32);
  return { plan: { ...base, candidates, refusal, digest }, offers };
}

/** DESIGN-055 P4 decision 38 — the read-only plan: the slot, its wrong file, and the releases that could replace it. */
export async function planWrongContentReplace(input: WrongContentRequest): Promise<WrongContentPlan> {
  return (await readPlan(input)).plan;
}

export interface RunWrongContentReplaceInput extends WrongContentRequest {
  planDigest: string;
  /** The candidate staff chose (a key the plan printed). */
  key: string;
  /** Staff's evidence that the file holds the wrong content (what was read). */
  evidence: string;
  /**
   * Staff evidence: episodes of this show (any season) whose own file holds the same story as the wrong file. The
   * carry credits the wrong file's plays to them. Empty: the wrong content is nowhere else, so its marks are dropped.
   */
  sameAs?: ReadonlyArray<{ seasonNumber: number; episodeNumber: number }>;
  watchCarry?: WatchCarryPlex | null;
  carryPauseMs?: number;
}

export interface WrongContentReplaceResult {
  fixRequestId: string;
  grabbed: { key: string; title: string };
  carry: { carryId: string; status: string; result: WatchCarryResult | null; error: string | null } | null;
}

/**
 * DESIGN-055 P4 decision 38 — run it: re-plan (one fresh season search) and refuse a changed plan, a refusal, or a key
 * that is no longer a candidate, writing nothing; snapshot the watch state and clear the slot; open a Fix Request
 * (requester null, `wrong_content`); delete the file and read the slot back empty; grab the chosen release onto the
 * slot's episodes; carry and verify. The import is the *arr's: the Fix Request completes when it lands.
 */
export async function runWrongContentReplace(input: RunWrongContentReplaceInput): Promise<WrongContentReplaceResult> {
  const evidence = input.evidence.trim();
  if (evidence.length < 10) throw new FixRefusedError('copy_refused', 'Record the evidence that the file holds the wrong content.');
  const { plan, offers } = await readPlan(input);
  if (plan.digest !== input.planDigest) throw new FixPlanChangedError('The episode changed since the plan was checked. Plan it again.');
  if (plan.refusal || !plan.file) throw new FixRefusedError('copy_refused', wrongContentRefusalText(plan.refusal) ?? 'This file cannot be replaced.');
  const offer = offers.find((o) => o.key === input.key);
  if (!offer) throw new FixRefusedError('copy_refused', 'That release is not one of the replacements the plan found now. Plan it again.');
  const fileSize = plan.file.size;
  if (input.watchCarry && (!fileSize || !plan.file.name)) {
    throw new FixRefusedError('copy_refused', 'Sonarr does not list the file’s size and name, so its watch state cannot be carried. Nothing was removed.');
  }

  // The copies of the wrong content elsewhere in the show (staff evidence), each with its own file.
  const season = await readRemapSeasonState(input);
  const sameAsFiles: Array<{ seasonNumber: number; episodeNumber: number; size: number }> = [];
  for (const s of input.sameAs ?? []) {
    const ep = season.episodes.find((e) => e.seasonNumber === s.seasonNumber && e.episodeNumber === s.episodeNumber);
    const f = ep?.episodeFileId != null ? season.files.find((x) => x.id === ep.episodeFileId) : undefined;
    if (!ep || !f || !f.size || plan.slot.some((x) => x.id === ep.id)) {
      throw new FixRefusedError('copy_refused', `S${s.seasonNumber}E${s.episodeNumber} has no file of its own to credit the plays to.`);
    }
    sameAsFiles.push({ seasonNumber: s.seasonNumber, episodeNumber: s.episodeNumber, size: f.size });
  }

  let carry: WatchCarrySnapshot | null = null;
  if (input.watchCarry) {
    const originals = [...new Set(sameAsFiles.map((x) => x.size))];
    const identical = originals.includes(fileSize!);
    try {
      carry = await takeWatchCarrySnapshot({
        db: input.db,
        plex: input.watchCarry,
        kind: 'wrong_content',
        mediaItemId: input.mediaItemId,
        seriesId: plan.seriesId,
        seasons: [...new Set([input.seasonNumber, ...sameAsFiles.map((x) => x.seasonNumber)])],
        scope: identical
          ? { moved: [fileSize!], deletedNames: [plan.file.name!], sameAs: originals.filter((x) => x !== fileSize).map((x) => [fileSize!, x] as [number, number]) }
          : { moved: [], deleted: [fileSize!], sameAs: originals.map((x) => [fileSize!, x] as [number, number]) },
        detail: { planDigest: plan.digest, slot: plan.slot.map((e) => e.label), release: offer.title, sameAs: sameAsFiles },
        pauseMs: input.carryPauseMs,
      });
      await preClearWatchCarry({ db: input.db, plex: input.watchCarry, snapshot: carry, pauseMs: input.carryPauseMs });
    } catch (err) {
      throw new FixRefusedError('copy_refused', `The watch state could not be carried (${err instanceof Error ? err.message : String(err)}). Nothing was removed.`);
    }
  }

  let fixRequestId: string;
  try {
    ({ fixRequestId } = await createFixRequest({
      db: input.db,
      requesterId: null,
      requesterIsAdmin: true,
      mediaItemId: input.mediaItemId,
      scope: 'episode',
      targetArrChildId: plan.slot[0]!.id,
      targetLabel: plan.slot.map((e) => e.label).join(' + '),
      reason: 'wrong_content',
    }));
  } catch (err) {
    if (carry && input.watchCarry) {
      await abandonWatchCarry({ db: input.db, plex: input.watchCarry, carryId: carry.carryId, reason: err instanceof Error ? err.message : String(err), pauseMs: input.carryPauseMs }).catch(() => {});
    }
    throw err;
  }
  if (carry) await noteWatchCarry({ db: input.db, carryId: carry.carryId, detail: { fixRequestId } });
  const at = () => new Date().toISOString();
  let carryOutcome: WrongContentReplaceResult['carry'] = null;
  const runCarry = async (): Promise<FixActionEntry[]> => {
    if (!carry || !input.watchCarry || carryOutcome) return [];
    try {
      const result = await carryWatchState({ db: input.db, plex: input.watchCarry, carryId: carry.carryId, pauseMs: input.carryPauseMs });
      carryOutcome = { carryId: carry.carryId, status: result.status, result, error: null };
    } catch (err) {
      carryOutcome = { carryId: carry.carryId, status: 'cleared', result: null, error: err instanceof Error ? err.message : String(err) };
    }
    const o = carryOutcome as NonNullable<WrongContentReplaceResult['carry']>;
    return [{ step: 'watch_carry', endpoint: 'repair-guide.ts replace-run', ok: o.status === 'verified', at: at(), carryId: o.carryId, status: o.status, totals: o.result?.totals ?? null, dropped: o.result?.totals.lost ?? null, ...(o.error ? { error: o.error } : {}) }];
  };

  const sonarr = input.arr.write.sonarr;
  const endpoint = `DELETE /api/v3/episodefile/${plan.file.id}`;
  try {
    await sonarr.deleteEpisodeFile(plan.file.id);
  } catch (err) {
    const carried = await runCarry();
    await recordFixAction({ db: input.db, fixRequestId, transition: 'failed', actions: [{ step: 'delete_file', endpoint, ok: false, at: at(), error: err instanceof Error ? err.message : String(err) }, ...carried] });
    throw err;
  }
  const episodes = await remapGuarded('episodes', () => input.arr.read.sonarr.listEpisodes(plan.seriesId)).catch(() => null);
  const slotIds = new Set(plan.slot.map((e) => e.id));
  const slotEmpty = episodes !== null && episodes.filter((e) => slotIds.has(e.id)).every((e) => !e.hasFile);
  await recordFixAction({
    db: input.db,
    fixRequestId,
    transition: 'actioned',
    pathTaken: 'delete_search',
    actions: [
      { step: 'wrong_content_replace', endpoint: 'repair-guide.ts replace-run', ok: true, at: at(), file: { fileId: plan.file.id, name: plan.file.name, size: plan.file.size }, slot: plan.slot.map((e) => e.label), release: offer.title, evidence, sameAs: sameAsFiles },
      { step: 'delete_file', endpoint, ok: true, at: at(), status: 200 },
      { step: 'delete_read_back', endpoint: 'GET /api/v3/episode', ok: slotEmpty, at: at(), slotEmpty },
    ],
  });
  if (!slotEmpty) {
    const carried = await runCarry();
    await recordFixAction({ db: input.db, fixRequestId, transition: 'failed', actions: [{ step: 'delete_not_landed', endpoint: 'GET /api/v3/episode', ok: false, at: at() }, ...carried] });
    throw new FixRefusedError('copy_refused', 'Sonarr still shows a file on the episode, so nothing was grabbed.');
  }

  // Grab the chosen release onto the slot's episodes (the override body: the *arr judged it while the file was there).
  const target = await readReleasePickTarget({ db: input.db, arr: input.arr, mediaItemId: input.mediaItemId, scope: 'episode', targetChildId: plan.slot[0]!.id })
    .then((r) => r.target)
    .catch(() => null);
  try {
    if (!target || target.kind !== 'sonarr') throw new Error('the episode could not be read back for the grab');
    await sendReleaseGrab({ arr: input.arr, target, offer, episodeIds: plan.slot.map((e) => e.id) });
  } catch (err) {
    const carried = await runCarry();
    await recordFixAction({
      db: input.db,
      fixRequestId,
      transition: 'failed',
      actions: [{ step: 'release_grab', endpoint: 'POST /api/v3/release', ok: false, at: at(), release: offer.title, error: err instanceof Error ? err.message : String(err) }, ...carried],
    });
    throw new FixRefusedError('copy_refused', `The file was removed but the release could not be grabbed (${err instanceof Error ? err.message : String(err)}). Sonarr will search for it.`);
  }
  const carried = await runCarry();
  await recordFixAction({
    db: input.db,
    fixRequestId,
    transition: 'search_triggered',
    actions: [{ step: 'release_grab', endpoint: 'POST /api/v3/release', ok: true, at: at(), release: offer.title, key: offer.key, override: true }, ...carried],
  });
  return { fixRequestId, grabbed: { key: offer.key, title: offer.title }, carry: carryOutcome };
}
