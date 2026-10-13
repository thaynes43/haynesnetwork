// DESIGN-055 P4 decisions 18-24 (issue #916, owner ruling on Q-11, 2026-10-13) — the SEASON RE-MAP, pure. Staff put
// every file of one season on the episode its own name says it is. The library-wide Title Check found whole seasons
// filed in another order (a streaming service's numbering against TVDB's): the episode a file names keeps its own
// misplaced file, and the moves form chains and cycles (swaps, rotations). The person's Episode Re-map (remap-plan.ts)
// refuses those by design; this plan orders them, breaking each cycle by parking one file on a free episode.
//
// What it relies on is the same Sonarr behaviour remap-plan.ts records: a ManualImport of a file already in the series
// folder only re-links it (no file is touched on disk), and an import onto an episode that still has another file would
// leave that file on disk but unmapped. So every step lands on an episode that is free at that moment: empty, or left by
// an earlier step. A cycle has no such episode, so its first file moves to a PARKING EPISODE (an episode of the series
// with no file that no step targets), the rest of the cycle follows, and the parked file then moves to its own episode.
// The flow renames each file right after its step, so the file names on disk follow the same order and no rename ever
// meets a name another file still holds (Sonarr skips such a rename, never overwrites).
//
// Owner rulings it keeps: a re-map never deletes a file (P4 decision 3), and nothing is displaced: a file stays where it
// is whenever its move would need an episode another file keeps (a second copy of an episode, a name two files share,
// a file whose own name says nothing). Staff name those files' episodes by evidence (`placements`) or keep them.
import { createHash } from 'node:crypto';
import { episodeLabel } from './media-children';
import type { RemapEpisode, RemapEpisodeRef, RemapFile, RemapNameEvidence } from './remap-plan';
import { episodeTitleEvidence, type TitleVerdict } from './title-evidence';

/** A staff run is at most this many steps (moves, parkings and the moves back). */
export const SEASON_REMAP_MAX_STEPS = 120;

/** A season file with every name it was imported under (the scene name, the Title Check's judged names). */
export interface SeasonRemapFile extends RemapFile {
  /** Candidate names, best first; a library's own earlier names are already left out (P4 decision 16). */
  sourceNames: readonly string[];
}

/** Staff evidence (subtitles, title cards): the file on these episode numbers belongs on those. Same count. */
export interface SeasonRemapPlacement {
  from: readonly number[];
  to: readonly number[];
}

export interface SeasonRemapInput {
  seasonNumber: number;
  /** Every episode of the series (other seasons are only used as parking episodes). */
  episodes: readonly RemapEpisode[];
  /** Every episode file of the series. */
  files: readonly SeasonRemapFile[];
  /** Staff placements; they outrank what a name says. */
  placements?: readonly SeasonRemapPlacement[];
  /** Episode numbers whose file stays where it is, whatever its name says. */
  keep?: readonly number[];
  queueBusy: boolean;
  sonarrBusy?: boolean;
}

/** Why a file whose name names another episode stays where it is. */
export type SeasonRemapHold =
  /** Its name names an episode whose own file's name agrees with it: this file is a second copy of that episode. */
  | 'duplicate'
  /** Two or more files name the same episode. */
  | 'collision'
  /** The episode it names keeps a file that does not move (held itself, or one whose name says nothing). */
  | 'blocked'
  /** It holds two or more episodes (a two-segment file); staff place it. */
  | 'multi_episode'
  /** Staff kept it. */
  | 'kept';

export type SeasonRemapRefusal =
  | 'nothing_to_move'
  /** A placement does not name one file's episodes, names an episode the season lacks, or two placements collide. */
  | 'bad_placement'
  /** A cycle needs a parking episode and the series has none free. */
  | 'no_parking'
  | 'too_many'
  | 'queue_busy'
  | 'sonarr_busy';

export type SeasonRemapStepKind = 'move' | 'park' | 'unpark';

export interface SeasonRemapStep {
  kind: SeasonRemapStepKind;
  /** The file's episode-file id when the plan was made (each step re-links it under a new id). */
  fileId: number;
  fileName: string | null;
  size: number | null;
  releaseGroup: string | null;
  from: RemapEpisodeRef[];
  to: RemapEpisodeRef[];
  /** `placed`: staff evidence; `name`: the file's own name. */
  why: 'name' | 'placed';
  /** The name's verdict against the step's final episodes (null: no name). */
  nameSays: RemapNameEvidence | null;
}

export interface SeasonRemapHeldFile {
  fileId: number;
  fileName: string | null;
  on: RemapEpisodeRef[];
  reason: SeasonRemapHold;
  /** The episode the name names. */
  names: RemapEpisodeRef | null;
  name: string | null;
}

/** A file whose name says nothing (silent or ambiguous) on an episode a moving file names: staff place it. */
export interface SeasonRemapUnplaced {
  fileId: number;
  fileName: string | null;
  on: RemapEpisodeRef[];
  name: string | null;
  verdict: TitleVerdict;
  /** Where it would go if the season were a closed reordering: the one episode left over, or its name's best guess. */
  suggestion: RemapEpisodeRef | null;
}

export interface SeasonRemapParking extends RemapEpisodeRef {
  seasonNumber: number;
}

export interface SeasonRemapPlan {
  seasonNumber: number;
  /** In execution order: each lands on episodes free at that moment. */
  steps: SeasonRemapStep[];
  /** Files that end on other episodes. */
  moved: number;
  held: SeasonRemapHeldFile[];
  unplaced: SeasonRemapUnplaced[];
  /** The episodes no name claims if every name-led move went ahead (where unplaced files and second copies could go). */
  open: RemapEpisodeRef[];
  /** Episodes that have a file now and none afterwards. */
  vacated: RemapEpisodeRef[];
  /** The free episode a cycle passes through (null: no cycle). */
  parking: SeasonRemapParking | null;
  refusal: SeasonRemapRefusal | null;
  /** Plain words for a `bad_placement`. */
  refusalDetail: string | null;
  digest: string;
}

/** Title Check precedence (P4 decision 12): any `agrees`, else `disagrees`, else `ambiguous`, else `silent`. */
const VERDICT_RANK: Record<TitleVerdict, number> = { agrees: 0, disagrees: 1, ambiguous: 2, silent: 3 };

interface FileEvidence {
  verdict: TitleVerdict;
  name: string | null;
  /** The episode the name names best (any verdict but silent). */
  best: RemapEpisode | null;
}

const basename = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || null;
};

function ref(e: RemapEpisode): RemapEpisodeRef {
  return { id: e.id, episodeNumber: e.episodeNumber, title: e.title, label: episodeLabel(e.seasonNumber, e.episodeNumber, e.title ?? '') };
}

const byNumber = (a: RemapEpisode, b: RemapEpisode) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber;

/**
 * DESIGN-055 P4 decisions 18-21 — the season plan: what each file's names say, which files stay and why, and the steps
 * (in an order where every step lands on free episodes, parking one file per cycle). Pure.
 */
export function buildSeasonRemapPlan(input: SeasonRemapInput): SeasonRemapPlan {
  const sn = input.seasonNumber;
  const season = input.episodes.filter((e) => e.seasonNumber === sn).sort(byNumber);
  const byId = new Map(input.episodes.map((e) => [e.id, e] as const));
  const byNum = new Map(season.map((e) => [e.episodeNumber, e] as const));
  const filesById = new Map(input.files.map((f) => [f.id, f] as const));
  const evidenceEpisodes = season.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title }));

  /** file id → the season's episodes it holds, in order. */
  const holds = new Map<number, RemapEpisode[]>();
  for (const e of season) {
    if (e.episodeFileId == null) continue;
    holds.set(e.episodeFileId, [...(holds.get(e.episodeFileId) ?? []), e]);
  }
  const fileIds = [...holds.keys()];

  const evidence = new Map<number, FileEvidence>();
  for (const id of fileIds) {
    const f = filesById.get(id);
    const against = holds.get(id)!.map((e) => e.id);
    let kept: FileEvidence = { verdict: 'silent', name: null, best: null };
    for (const raw of f?.sourceNames ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const ev = episodeTitleEvidence({ name, episodes: evidenceEpisodes, againstEpisodeIds: against });
      if (kept.name === null || VERDICT_RANK[ev.verdict] < VERDICT_RANK[kept.verdict]) {
        const best = ev.bestEpisodeId !== null ? byId.get(ev.bestEpisodeId) ?? null : null;
        kept = { verdict: ev.verdict, name, best: best && best.seasonNumber === sn ? best : null };
      }
    }
    evidence.set(id, kept);
  }

  const fileName = (id: number) => basename(filesById.get(id)?.relativePath ?? null);

  // ---- What each file wants ----
  const desire = new Map<number, RemapEpisode[]>();
  const why = new Map<number, 'name' | 'placed'>();
  const held = new Map<number, SeasonRemapHold>();
  const blockedBy = new Map<number, number>();
  const empty = (): SeasonRemapPlan => finish([], 'nothing_to_move', null, null);

  // Staff placements first: each names exactly the episodes one file holds, and episodes of this season.
  const placedTargets = new Map<number, number>();
  for (const p of input.placements ?? []) {
    const from = p.from.map((n) => byNum.get(n));
    const to = p.to.map((n) => byNum.get(n));
    if (from.some((e) => !e) || to.some((e) => !e) || from.length !== to.length || from.length === 0) {
      return finish([], 'bad_placement', `The placement ${p.from.join('-')}:${p.to.join('-')} names an episode this season does not have.`, null);
    }
    const fid = from[0]!.episodeFileId;
    const heldEps = fid != null ? holds.get(fid) ?? [] : [];
    if (fid == null || heldEps.length !== from.length || !heldEps.every((e, i) => e.id === from[i]!.id)) {
      return finish([], 'bad_placement', `No one file holds exactly episode ${p.from.join('-')}.`, null);
    }
    for (const t of to) {
      const other = placedTargets.get(t!.id);
      if (other !== undefined && other !== fid) {
        return finish([], 'bad_placement', `Two placements put files on episode ${t!.episodeNumber}.`, null);
      }
      placedTargets.set(t!.id, fid);
    }
    if (to.every((t, i) => t!.id === from[i]!.id)) held.set(fid, 'kept');
    else {
      desire.set(fid, to as RemapEpisode[]);
      why.set(fid, 'placed');
    }
  }
  for (const n of input.keep ?? []) {
    const fid = byNum.get(n)?.episodeFileId;
    if (fid != null && !why.has(fid)) held.set(fid, 'kept');
  }
  for (const id of fileIds) {
    if (why.has(id) || held.has(id)) continue;
    const ev = evidence.get(id)!;
    if (ev.verdict !== 'disagrees' || ev.best === null) continue;
    if (holds.get(id)!.length > 1) {
      held.set(id, 'multi_episode');
      continue;
    }
    desire.set(id, [ev.best]);
    why.set(id, 'name');
  }
  if (desire.size === 0) return empty();

  // ---- Hold every move that would need an episode a staying file keeps (to a fixpoint: a held file's own episodes
  // then stay occupied, which can hold the files that named them) ----
  const isMover = (id: number) => desire.has(id) && !held.has(id);
  const unknownOccupants = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    const landing = new Map<number, number[]>();
    for (const [id, to] of desire) {
      if (!isMover(id)) continue;
      for (const t of to) landing.set(t.id, [...(landing.get(t.id) ?? []), id]);
    }
    for (const ids of landing.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        if (why.get(id) === 'placed') continue; // staff evidence outranks a name; the named files give way
        held.set(id, 'collision');
        changed = true;
      }
    }
    for (const [id, to] of desire) {
      if (!isMover(id)) continue;
      for (const t of to) {
        const occ = t.episodeFileId;
        if (occ == null || occ === id || isMover(occ)) continue;
        const occEvidence = evidence.get(occ);
        if (held.has(occ)) {
          held.set(id, 'blocked');
          blockedBy.set(id, t.id);
        } else if (occEvidence?.verdict === 'agrees' && why.get(id) === 'name') {
          held.set(id, 'duplicate');
          blockedBy.set(id, t.id);
        } else {
          held.set(id, 'blocked');
          blockedBy.set(id, t.id);
          unknownOccupants.add(occ);
        }
        changed = true;
        break;
      }
    }
  }
  // Recompute the unknown occupants against the final movers plus the files they block (for the suggestion).
  const { unplaced, open } = suggestPlacements({ season, desire, held, evidence, holds, unknown: [...unknownOccupants], fileName });

  const movers = [...desire.keys()].filter(isMover);
  if (movers.length === 0) return finish([], 'nothing_to_move', null, null, unplaced, open);

  // ---- Order: a step is ready when its target episodes are free; a cycle parks one file first ----
  const targeted = new Set(movers.flatMap((id) => desire.get(id)!.map((e) => e.id)));
  const parking =
    input.episodes
      .filter((e) => e.episodeFileId == null && !targeted.has(e.id))
      .sort((a, b) => {
        // This season first, then specials, then every other season; lowest episode first.
        const rank = (e: RemapEpisode) => (e.seasonNumber === sn ? 0 : e.seasonNumber === 0 ? 1 : 2);
        return rank(a) - rank(b) || byNumber(a, b);
      })[0] ?? null;

  const occupant = new Map<number, number>();
  for (const e of input.episodes) if (e.episodeFileId != null) occupant.set(e.id, e.episodeFileId);
  const current = new Map<number, RemapEpisode[]>(movers.map((id) => [id, holds.get(id)!] as const));
  const pending = new Set(movers);
  let parkedId: number | null = null;
  let usedParking = false;
  const steps: Array<{ kind: SeasonRemapStepKind; fileId: number; from: RemapEpisode[]; to: RemapEpisode[] }> = [];
  const free = (id: number, e: RemapEpisode) => {
    const occ = occupant.get(e.id);
    return occ === undefined || occ === id;
  };
  const apply = (kind: SeasonRemapStepKind, id: number, to: RemapEpisode[]) => {
    const from = current.get(id)!;
    for (const e of from) if (occupant.get(e.id) === id) occupant.delete(e.id);
    for (const e of to) occupant.set(e.id, id);
    current.set(id, to);
    steps.push({ kind, fileId: id, from, to });
  };
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((id) => desire.get(id)!.every((e) => free(id, e)))
      .sort((a, b) => (a === parkedId ? -1 : b === parkedId ? 1 : byNumber(current.get(a)![0]!, current.get(b)![0]!)));
    if (ready.length > 0) {
      const id = ready[0]!;
      apply(id === parkedId ? 'unpark' : 'move', id, desire.get(id)!);
      if (id === parkedId) parkedId = null;
      pending.delete(id);
      continue;
    }
    // Every pending file waits on another pending file. Walk the waits from the lowest one until it repeats: that is
    // a cycle (a file waiting on a cycle is not one, and parking it would free nothing the cycle needs). Park the
    // cycle's lowest single-episode file.
    if (parkedId !== null || parking === null) return finish([], 'no_parking', null, null, unplaced, open);
    const waitsOn = (id: number) => occupant.get(desire.get(id)!.find((e) => !free(id, e))!.id)!;
    const lowest = [...pending].sort((a, b) => byNumber(current.get(a)![0]!, current.get(b)![0]!))[0]!;
    const walk: number[] = [];
    let at = lowest;
    while (!walk.includes(at)) {
      walk.push(at);
      at = waitsOn(at);
    }
    const cycle = walk.slice(walk.indexOf(at));
    const candidate = cycle
      .filter((id) => current.get(id)!.length === 1)
      .sort((a, b) => byNumber(current.get(a)![0]!, current.get(b)![0]!))[0];
    if (candidate === undefined) return finish([], 'no_parking', null, null, unplaced, open);
    apply('park', candidate, [parking]);
    parkedId = candidate;
    usedParking = true;
  }

  if (steps.length > SEASON_REMAP_MAX_STEPS) return finish(steps, 'too_many', null, usedParking ? parking : null, unplaced, open);
  if (input.queueBusy) return finish(steps, 'queue_busy', null, usedParking ? parking : null, unplaced, open);
  if (input.sonarrBusy) return finish(steps, 'sonarr_busy', null, usedParking ? parking : null, unplaced, open);
  return finish(steps, null, null, usedParking ? parking : null, unplaced, open);

  function finish(
    raw: Array<{ kind: SeasonRemapStepKind; fileId: number; from: RemapEpisode[]; to: RemapEpisode[] }>,
    refusal: SeasonRemapRefusal | null,
    refusalDetail: string | null,
    park: RemapEpisode | null,
    unplacedFiles: SeasonRemapUnplaced[] = [],
    openEpisodes: RemapEpisodeRef[] = [],
  ): SeasonRemapPlan {
    const stepViews: SeasonRemapStep[] = raw.map((s) => {
      const f = filesById.get(s.fileId);
      const final = desire.get(s.fileId) ?? s.to;
      const ev = evidence.get(s.fileId);
      let nameSays: RemapNameEvidence | null = null;
      if (ev?.name) {
        const judged = episodeTitleEvidence({ name: ev.name, episodes: evidenceEpisodes, againstEpisodeIds: final.map((e) => e.id) });
        const best = judged.bestEpisodeId !== null ? byId.get(judged.bestEpisodeId) ?? null : null;
        nameSays = { name: ev.name, verdict: judged.verdict, best: best ? ref(best) : null };
      }
      return {
        kind: s.kind,
        fileId: s.fileId,
        fileName: basename(f?.relativePath ?? null),
        size: f?.size ?? null,
        releaseGroup: f?.releaseGroup?.trim() ? f.releaseGroup.trim() : null,
        from: s.from.map(ref),
        to: s.to.map(ref),
        why: why.get(s.fileId) ?? 'name',
        nameSays,
      };
    });
    const heldViews: SeasonRemapHeldFile[] = [...held.entries()]
      .filter(([id]) => holds.has(id))
      .map(([id, reason]) => {
        const ev = evidence.get(id)!;
        return {
          fileId: id,
          fileName: fileName(id),
          on: holds.get(id)!.map(ref),
          reason,
          names: ev.verdict === 'disagrees' && ev.best ? ref(ev.best) : null,
          name: ev.name,
        };
      })
      .sort((a, b) => a.on[0]!.episodeNumber - b.on[0]!.episodeNumber);
    const movedIds = new Set(raw.filter((s) => s.kind !== 'park').map((s) => s.fileId));
    const finalTargets = new Set([...movedIds].flatMap((id) => (desire.get(id) ?? []).map((e) => e.id)));
    const vacated = [...movedIds]
      .flatMap((id) => holds.get(id) ?? [])
      .filter((e) => !finalTargets.has(e.id))
      .sort(byNumber)
      .map(ref);
    const parkingView = park ? { ...ref(park), seasonNumber: park.seasonNumber } : null;
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          season: sn,
          refusal,
          steps: stepViews.map((s) => [s.kind, s.fileId, s.size, s.fileName, s.from.map((e) => e.id), s.to.map((e) => e.id)]),
          held: heldViews.map((h) => [h.fileId, h.reason]),
        }),
      )
      .digest('hex')
      .slice(0, 32);
    return {
      seasonNumber: sn,
      steps: stepViews,
      moved: movedIds.size,
      held: heldViews,
      unplaced: unplacedFiles,
      open: openEpisodes,
      vacated,
      parking: parkingView,
      refusal,
      refusalDetail,
      digest,
    };
  }
}

/**
 * The files whose names say nothing but sit where a moving file belongs, with a suggestion: if every name-led move
 * went ahead, the episodes left over are where those files would have to go. One file and one episode left over is
 * the season's last piece; otherwise an ambiguous name's best guess among the leftovers. Staff confirm by evidence.
 */
function suggestPlacements(input: {
  season: readonly RemapEpisode[];
  desire: ReadonlyMap<number, RemapEpisode[]>;
  held: ReadonlyMap<number, SeasonRemapHold>;
  evidence: ReadonlyMap<number, FileEvidence>;
  holds: ReadonlyMap<number, RemapEpisode[]>;
  unknown: readonly number[];
  fileName: (id: number) => string | null;
}): { unplaced: SeasonRemapUnplaced[]; open: RemapEpisodeRef[] } {
  // The moves that only wait on a file whose name says nothing (or on such a wait).
  const would = [...input.desire.keys()].filter((id) => {
    const h = input.held.get(id);
    return h === undefined || h === 'blocked';
  });
  const targets = new Set(would.flatMap((id) => input.desire.get(id)!.map((e) => e.id)));
  const leftover = would
    .flatMap((id) => input.holds.get(id) ?? [])
    .filter((e) => !targets.has(e.id))
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
  const unplaced = input.unknown
    .map((id) => {
      const ev = input.evidence.get(id)!;
      let suggestion: RemapEpisode | null = null;
      if (input.unknown.length === 1 && leftover.length === 1) suggestion = leftover[0]!;
      else if (ev.best && leftover.some((e) => e.id === ev.best!.id)) suggestion = ev.best;
      return {
        fileId: id,
        fileName: input.fileName(id),
        on: (input.holds.get(id) ?? []).map(ref),
        name: ev.name,
        verdict: ev.verdict,
        suggestion: suggestion ? ref(suggestion) : null,
      };
    })
    .sort((a, b) => (a.on[0]?.episodeNumber ?? 0) - (b.on[0]?.episodeNumber ?? 0));
  return { unplaced, open: leftover.map(ref) };
}
