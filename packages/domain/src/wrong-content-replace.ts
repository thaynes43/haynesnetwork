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
  /** An episode named has no file. */
  | 'no_file'
  /** A file sits on episodes of more than one season. */
  | 'other_season'
  /** No release (or set of releases) names the slot's episodes and could be grabbed once the files are gone: they stay. */
  | 'no_release'
  /** A download for one of the slot's episodes is already on its way or stuck in the queue. */
  | 'queue_busy';

export interface WrongContentCandidate {
  key: string;
  title: string;
  state: 'grab' | 'override';
  /** Why it would need an override (plain-words codes), empty for a plain grab. */
  reasonCodes: string[];
  /** The slot's episodes it lands on. */
  lands: string[];
  /** It fills the whole slot alone; otherwise it is one part of a set (`--key a,b`) that does. */
  whole: boolean;
}

export interface WrongContentFile {
  id: number;
  size: number | null;
  name: string | null;
  /** The slot's episodes this file sits on. */
  episodes: string[];
}

export interface WrongContentPlan {
  seriesId: number;
  seriesTitle: string;
  seasonNumber: number;
  /** Every episode the wrong files sit on (all are emptied and refilled). */
  slot: Array<{ id: number; episodeNumber: number; label: string }>;
  /** The wrong files: one, or several replaced together when one release holds all their episodes. */
  files: WrongContentFile[];
  /**
   * Releases that name the slot's episodes and would be taken once the files are gone, each landing only on the slot's
   * episodes. A `whole` one fills the slot alone; together the parts fill it exactly. Whole first, then plain grabs.
   */
  candidates: WrongContentCandidate[];
  refusal: WrongContentRefusal | null;
  digest: string;
}

const REFUSAL_TEXT: Record<WrongContentRefusal, string> = {
  no_file: 'That episode has no file to replace.',
  other_season: 'The file sits on episodes of more than one season.',
  no_release: 'No release names these episodes and could be grabbed, so the file stays where it is for now.',
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
  /**
   * More episodes (same season) whose files are replaced together with this one's: the release that holds the right
   * stories spans them. Mickey Mouse: Mixed-Up Adventures' S01E33 and S01E34 files each sit on one episode, and the
   * right release `S01E33E34` holds both.
   */
  alsoEpisodes?: readonly number[];
}

interface Landing {
  offer: ReleasePickOffer;
  ids: number[];
}

const sameIds = (a: readonly number[], b: readonly number[]) => {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

async function readPlan(input: WrongContentRequest): Promise<{ plan: WrongContentPlan; landings: Landing[] }> {
  const season = await readRemapSeasonState(input);
  const wanted = [...new Set([input.episodeNumber, ...(input.alsoEpisodes ?? [])])];
  const named = wanted.map((n) => {
    const e = season.episodes.find((x) => x.seasonNumber === input.seasonNumber && x.episodeNumber === n);
    if (!e) throw new FixRefusedError('copy_refused', `Season ${input.seasonNumber} has no episode ${n}.`);
    return e;
  });
  const fileIds = [...new Set(named.map((e) => e.episodeFileId).filter((id): id is number => id != null))];
  const rawFiles = fileIds.map((id) => season.files.find((x) => x.id === id));
  const slotEps = season.episodes
    .filter((e) => e.episodeFileId != null && fileIds.includes(e.episodeFileId))
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const slot = (slotEps.length > 0 ? slotEps : named).map((e) => ({
    id: e.id,
    episodeNumber: e.episodeNumber,
    label: episodeLabel(e.seasonNumber, e.episodeNumber, e.title ?? ''),
  }));
  const files: WrongContentFile[] = rawFiles
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
    .map((f) => ({
      id: f.id,
      size: f.size ?? null,
      name: (f.relativePathFull ?? '').split(/[\\/]/).pop() ?? null,
      episodes: slotEps.filter((e) => e.episodeFileId === f.id).map((e) => episodeLabel(e.seasonNumber, e.episodeNumber, e.title ?? '')),
    }));
  const base = { seriesId: season.seriesId, seriesTitle: season.seriesTitle, seasonNumber: input.seasonNumber, slot, files };
  let refusal: WrongContentRefusal | null = null;
  let landings: Landing[] = [];
  if (named.some((e) => e.episodeFileId == null) || rawFiles.some((f) => f === undefined)) refusal = 'no_file';
  else if (slotEps.some((e) => e.seasonNumber !== input.seasonNumber)) refusal = 'other_season';
  else {
    // One list per slot episode: a release numbered for another episode whose title is this one's is offered only on
    // its own target's list. The season search is cached, so the slot costs one search.
    const slotIds = slot.map((e) => e.id);
    const seen = new Set<string>();
    for (const ep of slot) {
      const list = await previewReplacementList({
        db: input.db,
        arr: input.arr,
        mediaItemId: input.mediaItemId,
        scope: 'episode',
        targetChildId: ep.id,
        freedEpisodeIds: slotIds,
      });
      if (list.status !== 'list') {
        refusal = 'queue_busy';
        break;
      }
      for (const o of list.offers) {
        // Its name must agree with the episodes it lands on, and it must land only on the slot.
        if (o.titleVerdict !== 'agrees' || seen.has(o.key)) continue;
        const ids = o.episodeIds ?? [ep.id];
        if (!ids.every((id) => slotIds.includes(id))) continue;
        seen.add(o.key);
        landings.push({ offer: o, ids });
      }
    }
    if (refusal === null) {
      const covered = new Set(landings.flatMap((l) => l.ids));
      if (!slotIds.every((id) => covered.has(id))) {
        refusal = 'no_release';
        landings = [];
      } else {
        landings = landings
          .map((l, i) => ({ l, i }))
          .sort(
            (a, b) =>
              Number(!sameIds(a.l.ids, slotIds)) - Number(!sameIds(b.l.ids, slotIds)) ||
              Number(a.l.offer.state === 'override') - Number(b.l.offer.state === 'override') ||
              a.i - b.i,
          )
          .map((x) => x.l);
      }
    }
  }
  const label = (id: number) => slot.find((e) => e.id === id)?.label ?? String(id);
  const candidates: WrongContentCandidate[] = landings.map(({ offer: o, ids }) => ({
    key: o.key,
    title: o.title,
    state: o.state,
    reasonCodes: [...o.reasonCodes],
    lands: ids.map(label),
    whole: sameIds(ids, slot.map((e) => e.id)),
  }));
  const digest = createHash('sha256')
    .update(JSON.stringify([input.seasonNumber, slot.map((e) => e.id), files.map((f) => [f.id, f.size]), refusal]))
    .digest('hex')
    .slice(0, 32);
  return { plan: { ...base, candidates, refusal, digest }, landings };
}

/** DESIGN-055 P4 decision 38 — the read-only plan: the slot, its wrong files, and the releases that could replace them. */
export async function planWrongContentReplace(input: WrongContentRequest): Promise<WrongContentPlan> {
  return (await readPlan(input)).plan;
}

export interface RunWrongContentReplaceInput extends WrongContentRequest {
  planDigest: string;
  /** The candidates staff chose (keys the plan printed): one whole one, or parts that fill the slot exactly. */
  keys: readonly string[];
  /** Staff's evidence that the files hold the wrong content (what was read). */
  evidence: string;
  /**
   * Staff evidence: episodes of this show (any season) whose own file holds the same story as a wrong file. The carry
   * credits that file's plays to them. `copyOfEpisode` names the slot episode whose file it copies (needed when the slot
   * has several files). Empty: the wrong content is nowhere else, so its marks are dropped.
   */
  sameAs?: ReadonlyArray<{ seasonNumber: number; episodeNumber: number; copyOfEpisode?: number }>;
  watchCarry?: WatchCarryPlex | null;
  carryPauseMs?: number;
  /** A staff run filling several slots in one process: keep the season's cached list after each grab (one search). */
  keepReleaseList?: boolean;
}

export interface WrongContentReplaceResult {
  fixRequestId: string;
  grabbed: Array<{ key: string; title: string; lands: string[] }>;
  carry: { carryId: string; status: string; result: WatchCarryResult | null; error: string | null } | null;
}

/**
 * DESIGN-055 P4 decision 38 — run it: re-plan and refuse a changed plan, a refusal, or keys that are no longer
 * candidates or do not fill the slot exactly, writing nothing; snapshot the watch state and clear the slot; open a Fix
 * Request (requester null, `wrong_content`); delete the files and read the slot back empty; grab the chosen releases
 * onto their episodes; carry and verify. The import is the *arr's: the Fix Request completes when it lands.
 */
export async function runWrongContentReplace(input: RunWrongContentReplaceInput): Promise<WrongContentReplaceResult> {
  const evidence = input.evidence.trim();
  if (evidence.length < 10) throw new FixRefusedError('copy_refused', 'Record the evidence that the file holds the wrong content.');
  const { plan, landings } = await readPlan(input);
  if (plan.digest !== input.planDigest) throw new FixPlanChangedError('The episode changed since the plan was checked. Plan it again.');
  if (plan.refusal || plan.files.length === 0) {
    throw new FixRefusedError('copy_refused', wrongContentRefusalText(plan.refusal) ?? 'This file cannot be replaced.');
  }
  const keys = [...new Set(input.keys)];
  const chosen = keys.map((k) => landings.find((l) => l.offer.key === k));
  if (keys.length === 0 || chosen.some((c) => c === undefined)) {
    throw new FixRefusedError('copy_refused', 'That release is not one of the replacements the plan found now. Plan it again.');
  }
  const picks = chosen as Landing[];
  const slotIds = plan.slot.map((e) => e.id);
  const landed = picks.flatMap((p) => p.ids);
  if (new Set(landed).size !== landed.length || !sameIds(landed, slotIds)) {
    throw new FixRefusedError('copy_refused', 'Those releases do not fill the slot exactly (each episode once). Nothing was removed.');
  }
  if (input.watchCarry && plan.files.some((f) => !f.size || !f.name)) {
    throw new FixRefusedError('copy_refused', 'Sonarr does not list the file’s size and name, so its watch state cannot be carried. Nothing was removed.');
  }

  // The copies of the wrong content elsewhere in the show (staff evidence), each with its own file, per wrong file.
  const season = await readRemapSeasonState(input);
  const fileOfEpisode = (n: number) => {
    const ep = season.episodes.find((e) => e.seasonNumber === input.seasonNumber && e.episodeNumber === n);
    return plan.files.find((f) => f.id === ep?.episodeFileId) ?? null;
  };
  const sameAsFiles: Array<{ seasonNumber: number; episodeNumber: number; size: number; copyOf: number }> = [];
  for (const s of input.sameAs ?? []) {
    const wrong = s.copyOfEpisode !== undefined ? fileOfEpisode(s.copyOfEpisode) : plan.files.length === 1 ? plan.files[0]! : null;
    if (!wrong) {
      throw new FixRefusedError('copy_refused', `Name which of the slot's files S${s.seasonNumber}E${s.episodeNumber} copies (the slot has ${plan.files.length}).`);
    }
    const ep = season.episodes.find((e) => e.seasonNumber === s.seasonNumber && e.episodeNumber === s.episodeNumber);
    const f = ep?.episodeFileId != null ? season.files.find((x) => x.id === ep.episodeFileId) : undefined;
    if (!ep || !f || !f.size || slotIds.includes(ep.id)) {
      throw new FixRefusedError('copy_refused', `S${s.seasonNumber}E${s.episodeNumber} has no file of its own to credit the plays to.`);
    }
    sameAsFiles.push({ seasonNumber: s.seasonNumber, episodeNumber: s.episodeNumber, size: f.size, copyOf: wrong.id });
  }

  let carry: WatchCarrySnapshot | null = null;
  if (input.watchCarry) {
    // Per wrong file: a file byte-identical to one of its own copies is told apart by name (it is that copy's content
    // where it sits); any other is deleted content, credited only through its copies.
    const moved: number[] = [];
    const deleted: number[] = [];
    const deletedNames: string[] = [];
    const sameAs: Array<[number, number]> = [];
    for (const f of plan.files) {
      const originals = [...new Set(sameAsFiles.filter((x) => x.copyOf === f.id).map((x) => x.size))];
      if (originals.includes(f.size!)) {
        moved.push(f.size!);
        deletedNames.push(f.name!);
      } else {
        deleted.push(f.size!);
      }
      for (const o of originals) if (o !== f.size) sameAs.push([f.size!, o]);
    }
    try {
      carry = await takeWatchCarrySnapshot({
        db: input.db,
        plex: input.watchCarry,
        kind: 'wrong_content',
        mediaItemId: input.mediaItemId,
        seriesId: plan.seriesId,
        seasons: [...new Set([input.seasonNumber, ...sameAsFiles.map((x) => x.seasonNumber)])],
        scope: {
          moved,
          ...(deleted.length > 0 ? { deleted } : {}),
          ...(deletedNames.length > 0 ? { deletedNames } : {}),
          ...(sameAs.length > 0 ? { sameAs } : {}),
        },
        detail: {
          planDigest: plan.digest,
          slot: plan.slot.map((e) => e.label),
          releases: picks.map((p) => p.offer.title),
          sameAs: sameAsFiles,
        },
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
  const deletes: FixActionEntry[] = [];
  for (const f of plan.files) {
    const endpoint = `DELETE /api/v3/episodefile/${f.id}`;
    try {
      await sonarr.deleteEpisodeFile(f.id);
      deletes.push({ step: 'delete_file', endpoint, ok: true, at: at(), status: 200 });
    } catch (err) {
      const carried = await runCarry();
      await recordFixAction({
        db: input.db,
        fixRequestId,
        transition: 'failed',
        actions: [...deletes, { step: 'delete_file', endpoint, ok: false, at: at(), error: err instanceof Error ? err.message : String(err) }, ...carried],
      });
      throw err;
    }
  }
  const episodes = await remapGuarded('episodes', () => input.arr.read.sonarr.listEpisodes(plan.seriesId)).catch(() => null);
  const slotSet = new Set(slotIds);
  const slotEmpty = episodes !== null && episodes.filter((e) => slotSet.has(e.id)).every((e) => !e.hasFile);
  await recordFixAction({
    db: input.db,
    fixRequestId,
    transition: 'actioned',
    pathTaken: 'delete_search',
    actions: [
      {
        step: 'wrong_content_replace',
        endpoint: 'repair-guide.ts replace-run',
        ok: true,
        at: at(),
        files: plan.files.map((f) => ({ fileId: f.id, name: f.name, size: f.size, episodes: f.episodes })),
        slot: plan.slot.map((e) => e.label),
        releases: picks.map((p) => p.offer.title),
        evidence,
        sameAs: sameAsFiles,
      },
      ...deletes,
      { step: 'delete_read_back', endpoint: 'GET /api/v3/episode', ok: slotEmpty, at: at(), slotEmpty },
    ],
  });
  if (!slotEmpty) {
    const carried = await runCarry();
    await recordFixAction({ db: input.db, fixRequestId, transition: 'failed', actions: [{ step: 'delete_not_landed', endpoint: 'GET /api/v3/episode', ok: false, at: at() }, ...carried] });
    throw new FixRefusedError('copy_refused', 'Sonarr still shows a file on the episode, so nothing was grabbed.');
  }

  // Grab each chosen release onto its episodes (the override body: the *arr judged it while the files were there).
  const target = await readReleasePickTarget({ db: input.db, arr: input.arr, mediaItemId: input.mediaItemId, scope: 'episode', targetChildId: slotIds[0]! })
    .then((r) => r.target)
    .catch(() => null);
  const grabbed: WrongContentReplaceResult['grabbed'] = [];
  const label = (id: number) => plan.slot.find((e) => e.id === id)?.label ?? String(id);
  for (const p of picks) {
    try {
      if (!target || target.kind !== 'sonarr') throw new Error('the episode could not be read back for the grab');
      await sendReleaseGrab({ arr: input.arr, target, offer: p.offer, episodeIds: p.ids, keepList: input.keepReleaseList === true });
      grabbed.push({ key: p.offer.key, title: p.offer.title, lands: p.ids.map(label) });
    } catch (err) {
      const carried = await runCarry();
      await recordFixAction({
        db: input.db,
        fixRequestId,
        transition: 'failed',
        actions: [
          ...grabbed.map((g) => ({ step: 'release_grab', endpoint: 'POST /api/v3/release', ok: true, at: at(), release: g.title, key: g.key, lands: g.lands, override: true })),
          { step: 'release_grab', endpoint: 'POST /api/v3/release', ok: false, at: at(), release: p.offer.title, error: err instanceof Error ? err.message : String(err) },
          ...carried,
        ],
      });
      throw new FixRefusedError('copy_refused', `The file was removed but a release could not be grabbed (${err instanceof Error ? err.message : String(err)}). Sonarr will search for it.`);
    }
  }
  const carried = await runCarry();
  await recordFixAction({
    db: input.db,
    fixRequestId,
    transition: 'search_triggered',
    actions: [
      ...grabbed.map((g) => ({ step: 'release_grab', endpoint: 'POST /api/v3/release', ok: true, at: at(), release: g.title, key: g.key, lands: g.lands, override: true })),
      ...carried,
    ],
  });
  return { fixRequestId, grabbed, carry: carryOutcome };
}
