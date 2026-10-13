// ADR-109 C-02, C-03 / ADR-110 C-03 / DESIGN-055 D-04 (PLAN-077 P4) — the Episode Re-map's plan, pure. A person says
// "this file is really episode N" (a single move) or "every episode from N on is one slot off" (a shift by +1 or -1);
// the plan lists which existing library file moves onto which episode, in an order where every move lands on a slot
// that is already free, and refuses anything that would displace a file it does not move.
//
// What the plan relies on (Sonarr 4.0.20.3012, read in its source and proven by the 2026-10-12 hand fix of Case A): a
// ManualImport of a file that is already inside the series folder does not touch the file on disk. It deletes the old
// episode-file record for that path (`DeleteMediaFileReason.ManualOverride`, a database delete) and adds a new record
// on the chosen episodes; the file keeps its name until RenameFiles. Importing onto an episode that still has another
// file would leave that file on disk but unmapped, so the plan never does it (rule 3), and the order (rule 4) means a
// run that stops part way leaves every completed move whole.
//
// Owner ruling (2026-10-12, P4 work order): a re-map never deletes a file. The design's "discard this file" tick
// (D-04 rule 3) is therefore not offered: a slot held by a file the plan does not move refuses the plan.
import { createHash } from 'node:crypto';
import { episodeLabel } from './media-children';
import { episodeTitleEvidence, type TitleVerdict } from './title-evidence';

/** D-04 rule 11: at most this many moves in one request. */
export const REMAP_MAX_MOVES = 40;

export interface RemapEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  /** The episode file on this episode, or null. */
  episodeFileId: number | null;
}

export interface RemapFile {
  id: number;
  seasonNumber: number | null;
  relativePath: string | null;
  size: number | null;
  releaseGroup: string | null;
  qualityName: string | null;
  /**
   * The name the file was imported under (the episode file's scene name, else the Title Check's judged name). Never
   * the relative path: Sonarr renames a file to the episode it sits on, so that name always "agrees".
   */
  sourceName: string | null;
}

export type RemapClaim =
  | { kind: 'single'; fromEpisodeId: number; toEpisodeId: number }
  | { kind: 'shift'; fromEpisodeNumber: number; throughEpisodeNumber?: number | null; by: 1 | -1 };

/** The claim as the plan read it (a shift's last episode filled in). */
export type ResolvedRemapClaim =
  | { kind: 'single'; fromEpisodeId: number; toEpisodeId: number }
  | { kind: 'shift'; fromEpisodeNumber: number; throughEpisodeNumber: number; by: 1 | -1 };

export type RemapRefusal =
  /** No file to move: the episode has none, or the range holds none. */
  | 'nothing_to_move'
  /** A move would land on an episode the season does not have (the last episode shifted on by one). */
  | 'no_such_episode'
  /** A move would land on an episode that keeps a file the plan does not move (rule 3). */
  | 'occupied'
  /** Two files would land on the same episode. */
  | 'collision'
  /** The moves form a cycle, a swap, with no free slot to pass through (rule 4). */
  | 'cycle'
  /** A file holding two episodes would be split (rule 5). */
  | 'split_multi'
  /** More than REMAP_MAX_MOVES moves (rule 11). */
  | 'too_many'
  /** A download for this season is in the queue; its import could race the moves (rule 11). */
  | 'queue_busy'
  /** Sonarr is still running an earlier move or rename (a late one could land on a slot this plan counts as free). */
  | 'sonarr_busy'
  /** A single move onto the episode it is already on. */
  | 'same_episode';

export interface RemapEpisodeRef {
  id: number;
  episodeNumber: number;
  title: string | null;
  label: string;
}

/** What the file's own name says about where it belongs (Title Evidence against the move's target). */
export interface RemapNameEvidence {
  name: string;
  /** The verdict against the episodes the file moves TO. */
  verdict: TitleVerdict;
  /** The episode the name matches best, when it names one. */
  best: RemapEpisodeRef | null;
}

export interface RemapMove {
  fileId: number;
  fileName: string | null;
  size: number | null;
  releaseGroup: string | null;
  qualityName: string | null;
  from: RemapEpisodeRef[];
  to: RemapEpisodeRef[];
  nameSays: RemapNameEvidence | null;
}

export interface RemapBlocker {
  episode: RemapEpisodeRef;
  fileName: string | null;
}

export interface RemapPlan {
  seasonNumber: number;
  claim: ResolvedRemapClaim;
  /** In execution order: every move lands on a slot that is free by then. */
  moves: RemapMove[];
  /** Episodes that have a file now and none afterwards (each is offered Force Search, rule 9). */
  vacated: RemapEpisodeRef[];
  refusal: RemapRefusal | null;
  /** The episode and file behind an `occupied`, `collision` or `split_multi` refusal. */
  blocker: RemapBlocker | null;
  /** D-04 rule 10: a shift that moves two or more files of one release group offers the Mislabel Block. */
  mislabelGroups: Array<{ releaseGroup: string; fileCount: number }>;
  /** A stable digest of what the run will DO; the confirm sends it back and a changed season refuses (rule 6). */
  digest: string;
}

export interface RemapPlanInput {
  seasonNumber: number;
  claim: RemapClaim;
  /** Every episode of the series (only the season is used). */
  episodes: readonly RemapEpisode[];
  /** Every episode file of the series. */
  files: readonly RemapFile[];
  /** Whether any queue record targets this season (rule 11). */
  queueBusy: boolean;
  /** Whether Sonarr has a ManualImport or RenameFiles still queued or running. */
  sonarrBusy?: boolean;
}

const basename = (path: string | null): string | null => {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || null;
};

function ref(e: RemapEpisode): RemapEpisodeRef {
  return { id: e.id, episodeNumber: e.episodeNumber, title: e.title, label: episodeLabel(e.seasonNumber, e.episodeNumber, e.title ?? '') };
}

const byNumber = (a: RemapEpisode, b: RemapEpisode) => a.episodeNumber - b.episodeNumber;

function digestOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * D-04 rules 1-5, 11 — build the plan for one claim on one season. Pure: the caller reads the season (episodes, files,
 * queue) just before, and again before executing (rule 6, by the digest).
 */
export function buildRemapPlan(input: RemapPlanInput): RemapPlan {
  const season = input.episodes.filter((e) => e.seasonNumber === input.seasonNumber).sort(byNumber);
  const byId = new Map(season.map((e) => [e.id, e] as const));
  const byNum = new Map(season.map((e) => [e.episodeNumber, e] as const));
  const filesById = new Map(input.files.map((f) => [f.id, f] as const));
  /** file id → the season's episodes it holds, in episode order. */
  const holds = new Map<number, RemapEpisode[]>();
  for (const e of season) {
    if (e.episodeFileId == null) continue;
    const list = holds.get(e.episodeFileId) ?? [];
    list.push(e);
    holds.set(e.episodeFileId, list);
  }

  let claim: ResolvedRemapClaim;
  if (input.claim.kind === 'single') {
    claim = { kind: 'single', fromEpisodeId: input.claim.fromEpisodeId, toEpisodeId: input.claim.toEpisodeId };
  } else {
    const lastWithFile = [...season].reverse().find((e) => e.episodeFileId != null)?.episodeNumber ?? input.claim.fromEpisodeNumber;
    const through = input.claim.throughEpisodeNumber ?? Math.max(lastWithFile, input.claim.fromEpisodeNumber);
    claim = {
      kind: 'shift',
      fromEpisodeNumber: Math.min(input.claim.fromEpisodeNumber, through),
      throughEpisodeNumber: Math.max(input.claim.fromEpisodeNumber, through),
      by: input.claim.by,
    };
  }

  const result = (
    moves: Array<{ fileId: number; from: RemapEpisode[]; to: RemapEpisode[] }>,
    refusal: RemapRefusal | null,
    blocker: RemapBlocker | null,
  ): RemapPlan => {
    const moveViews: RemapMove[] = moves.map((m) => {
      const f = filesById.get(m.fileId);
      const name = f?.sourceName?.trim() ? f.sourceName.trim() : null;
      let nameSays: RemapNameEvidence | null = null;
      if (name) {
        const ev = episodeTitleEvidence({
          name,
          episodes: season.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title })),
          againstEpisodeIds: m.to.map((e) => e.id),
        });
        const best = ev.bestEpisodeId !== null ? byId.get(ev.bestEpisodeId) ?? null : null;
        nameSays = { name, verdict: ev.verdict, best: best ? ref(best) : null };
      }
      return {
        fileId: m.fileId,
        fileName: basename(f?.relativePath ?? null),
        size: f?.size ?? null,
        releaseGroup: f?.releaseGroup?.trim() ? f.releaseGroup.trim() : null,
        qualityName: f?.qualityName ?? null,
        from: m.from.map(ref),
        to: m.to.map(ref),
        nameSays,
      };
    });
    const targets = new Set(moves.flatMap((m) => m.to.map((e) => e.id)));
    const vacated = moves
      .flatMap((m) => m.from)
      .filter((e) => !targets.has(e.id))
      .sort(byNumber)
      .map(ref);
    const groups = new Map<string, { releaseGroup: string; fileCount: number }>();
    if (claim.kind === 'shift') {
      for (const m of moveViews) {
        if (!m.releaseGroup) continue;
        const key = m.releaseGroup.toLowerCase();
        const g = groups.get(key) ?? { releaseGroup: m.releaseGroup, fileCount: 0 };
        g.fileCount += 1;
        groups.set(key, g);
      }
    }
    const mislabelGroups = [...groups.values()].filter((g) => g.fileCount >= 2).sort((a, b) => b.fileCount - a.fileCount);
    const digest = digestOf({
      season: input.seasonNumber,
      claim,
      refusal,
      moves: moveViews.map((m) => [m.fileId, m.size, m.fileName, m.from.map((e) => e.id), m.to.map((e) => e.id)]),
    });
    return { seasonNumber: input.seasonNumber, claim, moves: moveViews, vacated, refusal, blocker, mislabelGroups, digest };
  };

  // ---- The raw moves the claim asks for ----
  const raw: Array<{ fileId: number; from: RemapEpisode[]; to: RemapEpisode[] }> = [];
  if (claim.kind === 'single') {
    const from = byId.get(claim.fromEpisodeId);
    const to = byId.get(claim.toEpisodeId);
    if (!from || from.episodeFileId == null) return result([], 'nothing_to_move', null);
    if (!to) return result([], 'no_such_episode', null);
    if (from.id === to.id) return result([], 'same_episode', null);
    const held = holds.get(from.episodeFileId) ?? [from];
    if (held.length > 1) {
      // A file holding two episodes moves as a set (rule 5); a single move names one episode, so it would split it.
      return result([], 'split_multi', { episode: ref(from), fileName: basename(filesById.get(from.episodeFileId)?.relativePath ?? null) });
    }
    raw.push({ fileId: from.episodeFileId, from: [from], to: [to] });
  } else {
    const inRange = (e: RemapEpisode) =>
      e.episodeNumber >= claim.fromEpisodeNumber && e.episodeNumber <= claim.throughEpisodeNumber;
    const seen = new Set<number>();
    for (const e of season) {
      if (!inRange(e) || e.episodeFileId == null || seen.has(e.episodeFileId)) continue;
      seen.add(e.episodeFileId);
      const held = holds.get(e.episodeFileId) ?? [e];
      if (!held.every(inRange)) {
        return result([], 'split_multi', { episode: ref(e), fileName: basename(filesById.get(e.episodeFileId)?.relativePath ?? null) });
      }
      const to: RemapEpisode[] = [];
      for (const h of held) {
        const target = byNum.get(h.episodeNumber + claim.by);
        if (!target) return result([], 'no_such_episode', null);
        to.push(target);
      }
      raw.push({ fileId: e.episodeFileId, from: held, to });
    }
    if (raw.length === 0) return result([], 'nothing_to_move', null);
  }

  // ---- Rule 3: every target is free, or holds a file this plan moves ----
  const moving = new Set(raw.map((m) => m.fileId));
  const landing = new Map<number, number>();
  for (const m of raw) {
    for (const t of m.to) {
      const other = landing.get(t.id);
      if (other !== undefined && other !== m.fileId) {
        return result(raw, 'collision', { episode: ref(t), fileName: basename(filesById.get(m.fileId)?.relativePath ?? null) });
      }
      landing.set(t.id, m.fileId);
      if (t.episodeFileId != null && !moving.has(t.episodeFileId)) {
        return result(raw, 'occupied', { episode: ref(t), fileName: basename(filesById.get(t.episodeFileId)?.relativePath ?? null) });
      }
    }
  }
  if (raw.length > REMAP_MAX_MOVES) return result(raw, 'too_many', null);

  // ---- Rule 4: order every move after the moves that free its targets (a cycle has no order) ----
  const deps = new Map<number, Set<number>>();
  for (const m of raw) {
    const d = new Set<number>();
    for (const t of m.to) if (t.episodeFileId != null && t.episodeFileId !== m.fileId) d.add(t.episodeFileId);
    deps.set(m.fileId, d);
  }
  const prefer = (m: { from: RemapEpisode[] }) => m.from[0]!.episodeNumber * (claim.kind === 'shift' && claim.by === -1 ? 1 : -1);
  const pending = [...raw];
  const ordered: typeof raw = [];
  while (pending.length > 0) {
    const ready = pending.filter((m) => [...deps.get(m.fileId)!].every((d) => !pending.some((p) => p.fileId === d)));
    if (ready.length === 0) return result(raw, 'cycle', null);
    ready.sort((a, b) => prefer(a) - prefer(b));
    const next = ready[0]!;
    ordered.push(next);
    pending.splice(pending.indexOf(next), 1);
  }

  if (input.queueBusy) return result(ordered, 'queue_busy', null);
  if (input.sonarrBusy) return result(ordered, 'sonarr_busy', null);
  return result(ordered, null, null);
}

/** What the guide can pre-fill from Title Evidence (D-04 rule 2), with each judged file's verdict. */
export interface RemapSuggestion {
  claim: RemapClaim | null;
  /** Files whose name names another episode of the season. */
  flagged: Array<{ fileId: number; on: RemapEpisodeRef[]; best: RemapEpisodeRef; name: string }>;
}

/**
 * D-04 rule 2 — a suggested claim from the season's files' own names: two or more files that each name the episode one
 * slot away in the same direction suggest a shift over their range; one file that names another episode suggests a
 * single move. Silent and ambiguous names suggest nothing. Pure.
 */
export function suggestRemap(input: { seasonNumber: number; episodes: readonly RemapEpisode[]; files: readonly RemapFile[] }): RemapSuggestion {
  const season = input.episodes.filter((e) => e.seasonNumber === input.seasonNumber).sort(byNumber);
  const byId = new Map(season.map((e) => [e.id, e] as const));
  const evidenceEpisodes = season.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title }));
  const flagged: RemapSuggestion['flagged'] = [];
  const seen = new Set<number>();
  for (const e of season) {
    if (e.episodeFileId == null || seen.has(e.episodeFileId)) continue;
    seen.add(e.episodeFileId);
    const file = input.files.find((f) => f.id === e.episodeFileId);
    const name = file?.sourceName?.trim();
    if (!name) continue;
    const on = season.filter((x) => x.episodeFileId === e.episodeFileId);
    const ev = episodeTitleEvidence({ name, episodes: evidenceEpisodes, againstEpisodeIds: on.map((x) => x.id) });
    if (ev.verdict !== 'disagrees' || ev.bestEpisodeId === null) continue;
    const best = byId.get(ev.bestEpisodeId);
    if (!best) continue;
    flagged.push({ fileId: e.episodeFileId, on: on.map(ref), best: ref(best), name });
  }
  if (flagged.length === 0) return { claim: null, flagged };
  const singles = flagged.filter((f) => f.on.length === 1);
  const offsets = new Set(singles.map((f) => f.best.episodeNumber - f.on[0]!.episodeNumber));
  if (singles.length >= 2 && singles.length === flagged.length && offsets.size === 1) {
    const by = [...offsets][0]!;
    if (by === 1 || by === -1) {
      const numbers = singles.map((f) => f.on[0]!.episodeNumber);
      return {
        claim: { kind: 'shift', fromEpisodeNumber: Math.min(...numbers), throughEpisodeNumber: Math.max(...numbers), by },
        flagged,
      };
    }
  }
  const first = singles[0];
  return { claim: first ? { kind: 'single', fromEpisodeId: first.on[0]!.id, toEpisodeId: first.best.id } : null, flagged };
}
