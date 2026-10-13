// ADR-109 C-02, C-03 / ADR-110 C-03, C-04 / DESIGN-055 D-01, D-04, D-05 (PLAN-077 P4) — the Episode Re-map step of the
// Repair Guide, its pure rules: when the guide offers moving files, what each question pre-fills, the words for each
// move, each name and each episode left empty in the preview, the confirm's name, the result, the Mislabel Block offer,
// and the Title Check flag on the title page. The component (app/(app)/library/[id]/episode-remap.tsx) renders them;
// lib/__tests__/remap-guide.test.ts proves them.
//
// Owner rulings (2026-10-12, P4 work order): a re-map never deletes a file, so nothing in the preview is "gone
// afterwards" and nothing is ticked; and the remedy is for everyone who can use Fix, within the hourly budget.
// Copy follows the owner's rules: plain and friendly, no em-dashes, no names, no time-grounding.
import type { RouterOutputs } from './trpc-client';
import type { ActionTarget } from './media';

/** What `fix.remapSeason` returns: the season's episodes and the claim their files' names suggest. */
export type RemapSeason = RouterOutputs['fix']['remapSeason'];
export type RemapSeasonEpisode = RemapSeason['episodes'][number];
/** What `fix.remapPlan` returns: every move in the order it runs, what is left empty, a refusal in plain words. */
export type RemapPlan = RouterOutputs['fix']['remapPlan'];
export type RemapMove = RemapPlan['moves'][number];
export type RemapEpisodeRef = RemapPlan['vacated'][number];
/** What `fix.remap` returns. */
export type RemapResult = RouterOutputs['fix']['remap'];

/** The claim the guide sends (`fix.remapPlan` and `fix.remap`, DESIGN-055 D-04 rule 2). */
export type RemapClaim =
  | { kind: 'single'; fromEpisodeId: number; toEpisodeId: number }
  | { kind: 'shift'; fromEpisodeNumber: number; throughEpisodeNumber?: number | null; by: 1 | -1 };

/** Which re-map a Fix target can offer: one file onto another episode, or a whole season off by one. */
export type RemapKind = 'single' | 'shift';

/** The Fix reason a re-map records (the guide's "It's a different episode of this show"). */
export const REMAP_FIX_REASON = 'wrong_content' as const;

/** The choice "What's wrong?" (or the season step) gains when the remedy is on, worded for people. */
export const REMAP_CHOICE_LABELS: Record<RemapKind, string> = {
  single: "It's a different episode of this show",
  shift: "They're all off by one: each file plays the episode next to it",
};

/**
 * DESIGN-055 D-01 / D-04 rule 1 — whether Fix can offer a re-map for this target: the `episode_remap` remedy is on and
 * the target is one TV episode with a file (a single move) or a TV season (a shift). Movies have no re-map.
 */
export function remapKindFor(input: {
  remapOn: boolean;
  arrKind: string;
  target: Pick<ActionTarget, 'scope'> | null;
}): RemapKind | null {
  if (!input.remapOn || input.arrKind !== 'sonarr' || input.target === null) return null;
  if (input.target.scope === 'episode') return 'single';
  if (input.target.scope === 'season') return 'shift';
  return null;
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

const titleOf = (ref: { title?: string | null; label: string }): string => {
  const t = ref.title?.trim();
  return t ? t : ref.label;
};

/**
 * "Which episode is this really?": the episode the file's own name points at, when Title Evidence (D-05) flagged the file
 * on `fromEpisodeId`. Null when its name says nothing about another episode.
 */
export function suggestedTarget(season: Pick<RemapSeason, 'suggestion'>, fromEpisodeId: number): RemapEpisodeRef | null {
  const flagged = season.suggestion.flagged.find((f) => f.on.some((e) => e.id === fromEpisodeId));
  if (!flagged || flagged.best.id === fromEpisodeId) return null;
  return flagged.best;
}

export interface TargetOption {
  id: number;
  label: string;
}

/**
 * The season's other episodes, each labelled with whether a file of its own sits there already (a move onto it is
 * refused, D-04 rule 3). The other episode a two-episode file holds is not "its own file": that file moves as a set.
 */
export function targetOptions(episodes: readonly RemapSeasonEpisode[], fromEpisodeId: number): TargetOption[] {
  const from = episodes.find((e) => e.id === fromEpisodeId) ?? null;
  return episodes
    .filter((e) => e.id !== fromEpisodeId)
    .map((e) => {
      const sameFile = from !== null && from.multiEpisode && e.multiEpisode && e.fileName !== null && e.fileName === from.fileName;
      return { id: e.id, label: e.hasFile && !sameFile ? `${e.label} (has its own file)` : e.label };
    });
}

export interface ShiftChoice {
  /** The first episode whose file is on the wrong slot. */
  fromEpisodeNumber: number;
  /** The last one, or null for "to the end of the season". */
  throughEpisodeNumber: number | null;
  by: 1 | -1;
}

/**
 * "They're all off by one": what the questions start with. The shift the files' names suggest (D-04 rule 2) when there
 * is one, else the first episode with a file, one slot later. A suggested last episode that is the season's last file
 * reads "to the end of the season".
 */
export function shiftDefaults(season: Pick<RemapSeason, 'episodes' | 'suggestion'>): ShiftChoice | null {
  const withFile = season.episodes.filter((e) => e.hasFile);
  const lastWithFile = withFile.at(-1)?.episodeNumber ?? null;
  const claim = season.suggestion.claim;
  if (claim && claim.kind === 'shift' && withFile.some((e) => e.episodeNumber === claim.fromEpisodeNumber)) {
    const through = claim.throughEpisodeNumber ?? null;
    return {
      fromEpisodeNumber: claim.fromEpisodeNumber,
      throughEpisodeNumber: through === null || through === lastWithFile ? null : through,
      by: claim.by,
    };
  }
  const first = withFile[0];
  return first ? { fromEpisodeNumber: first.episodeNumber, throughEpisodeNumber: null, by: 1 } : null;
}

/** The episodes a shift can start from: every episode with a file. */
export function shiftFromOptions(episodes: readonly RemapSeasonEpisode[]): RemapSeasonEpisode[] {
  return episodes.filter((e) => e.hasFile);
}

/** The episodes a shift can end on: every episode with a file from `from` on ("to the end" is the null choice). */
export function shiftThroughOptions(episodes: readonly RemapSeasonEpisode[], fromEpisodeNumber: number): RemapSeasonEpisode[] {
  return episodes.filter((e) => e.hasFile && e.episodeNumber > fromEpisodeNumber);
}

/** The claim for a shift choice. A last episode before the first one is dropped (the season's end applies). */
export function shiftClaim(choice: ShiftChoice): RemapClaim {
  const through =
    choice.throughEpisodeNumber !== null && choice.throughEpisodeNumber > choice.fromEpisodeNumber ? choice.throughEpisodeNumber : null;
  return { kind: 'shift', fromEpisodeNumber: choice.fromEpisodeNumber, throughEpisodeNumber: through, by: choice.by };
}

// ---------------------------------------------------------------------------
// The preview (DESIGN-055 D-01 preview contract)
// ---------------------------------------------------------------------------

/** "A, B and C". */
export function joinEpisodeLabels(refs: ReadonlyArray<{ label: string }>): string {
  const labels = refs.map((r) => r.label);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** "The file on S01E18 · Thats Funny moves to S01E19 · Cool Boss." */
export function moveLine(move: Pick<RemapMove, 'from' | 'to'>): string {
  return `The file on ${joinEpisodeLabels(move.from)} moves to ${joinEpisodeLabels(move.to)}.`;
}

export interface NameEvidenceLine {
  text: string;
  /** `agrees`: the name names where it goes. `disagrees`: it names another episode, worth a second look. */
  tone: 'agrees' | 'disagrees';
}

/**
 * What the file's own name says, the evidence with its source (D-05). Only a name that names an episode is shown: a
 * silent or unclear name is never evidence either way (D-05 rule 5).
 */
export function nameEvidenceLine(move: Pick<RemapMove, 'nameSays' | 'to'>): NameEvidenceLine | null {
  const says = move.nameSays;
  if (!says || !says.best) return null;
  if (says.verdict === 'agrees') return { text: `Its name says ${titleOf(says.best)}.`, tone: 'agrees' };
  if (says.verdict === 'disagrees') {
    return { text: `Its name says ${titleOf(says.best)}, which is a different episode.`, tone: 'disagrees' };
  }
  return null;
}

/** The line under the episodes a plan leaves without a file (D-04 rule 9). */
export function vacatedNote(count: number): string {
  return count === 1 ? 'You can search for it afterwards.' : 'You can search for them afterwards.';
}

/** The result's line over the episodes left empty, each with Force Search beside it. */
export function vacatedResultNote(count: number): string {
  return `${count === 1 ? 'Search for it here' : 'Search for them here'}, or later from the episode list. A search blocks no release and removes no file.`;
}

/** The preview's plain promise: a re-map moves existing files only. */
export const REMAP_NOTHING_LOST = 'Nothing is downloaded or deleted.';

/** The one quiet line about Plex watched marks (they follow the episode number, not the file). */
export const REMAP_WATCHED_NOTE = 'Plex keeps watched marks with the episode number, so they stay where they are.';

/** The confirm names the action (D-01): "Move 1 file", "Move 7 files". */
export function remapConfirmLabel(moveCount: number): string {
  return moveCount === 1 ? 'Move 1 file' : `Move ${moveCount} files`;
}

/** Whether a plan can be confirmed: no refusal, and at least one move. */
export function remapConfirmable(plan: Pick<RemapPlan, 'refusal' | 'moves' | 'remapOn'>): boolean {
  return plan.remapOn && plan.refusal === null && plan.moves.length > 0;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** The final line after the run, in plain words (D-01 outcome). */
export function resultLead(result: Pick<RemapResult, 'outcome' | 'moved' | 'stoppedText'>): string {
  if (result.outcome === 'stopped') return result.stoppedText ?? 'The moves stopped part way.';
  return result.moved === 1
    ? 'Moved 1 file. It is on the right episode now.'
    : `Moved ${result.moved} files. Each one is on the right episode now.`;
}

/** The lines under the lead: how far a stopped run got, and a file Sonarr could not rename. */
export function resultNotes(result: Pick<RemapResult, 'outcome' | 'moved' | 'planned' | 'renamed'>): string[] {
  const notes: string[] = [];
  if (result.outcome === 'stopped') {
    notes.push(
      result.moved === 0
        ? 'No file was moved, so nothing changed and nothing was lost.'
        : `${result.moved} of ${result.planned} files moved, each onto its right episode. Nothing was lost.`,
    );
  }
  if (!result.renamed && result.moved > 0) {
    notes.push('Sonarr kept the old name on at least one file, so Plex may still show it on its old episode until staff rename it.');
  }
  return notes;
}

// ---------------------------------------------------------------------------
// The Mislabel Block offer (D-04 rule 10, D-05)
// ---------------------------------------------------------------------------

/** "Stop BiOMA from filing this show again". */
export function mislabelOfferTitle(releaseGroup: string): string {
  return `Stop ${releaseGroup} from filing this show again`;
}

/** The one sentence of why. */
export function mislabelOfferWhy(releaseGroup: string, fileCount: number): string {
  return `${fileCount} of the files that moved came from ${releaseGroup}, so Sonarr would skip ${releaseGroup}'s releases of this show and pick another group's instead.`;
}

/** The offer's button. */
export function mislabelButtonLabel(releaseGroup: string): string {
  return `Block ${releaseGroup} for this show`;
}

/** What the offer says once saved (or when that group was already blocked for this show). */
export function mislabelSavedText(releaseGroup: string, alreadyActive = false): string {
  return alreadyActive
    ? `Already saved. Sonarr skips ${releaseGroup}'s releases of this show.`
    : `Saved. Sonarr will skip ${releaseGroup}'s releases of this show.`;
}

/** Not saved: the server's own words (written for people), else a plain line. */
export function mislabelNotSavedText(message: string | null | undefined): string {
  const why = message?.trim();
  return why ? `Not saved. ${why}` : 'Not saved. Nothing was changed in Sonarr.';
}

// ---------------------------------------------------------------------------
// The Title Check flag on the title page (D-05)
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "S01E23 · All You Can Fit" (the domain's episodeLabel, for a flag's best match). */
export function episodeLabelOf(seasonNumber: number, episodeNumber: number, title: string | null | undefined): string {
  const code = `S${pad2(seasonNumber)}E${pad2(episodeNumber)}`;
  const t = title?.trim();
  return t ? `${code} · ${t}` : code;
}

/** The flag's line: "This file's name says it's S01E23 · All You Can Fit". */
export function titleFlagText(flag: {
  seasonNumber: number;
  best: { episodeNumber: number; title: string | null } | null;
}): string | null {
  if (!flag.best) return null;
  return `This file's name says it's ${episodeLabelOf(flag.seasonNumber, flag.best.episodeNumber, flag.best.title)}`;
}

/**
 * A flag whose move cannot run (that episode keeps its own file, so the guide would refuse): the line under the flag,
 * and the prefilled Helpdesk ticket staff work from (DESIGN-055 P4 decision 15).
 */
export const TITLE_FLAG_STAFF_LINE = 'That episode already has a file, so staff need to move this one.';

export function titleFlagStaffTicket(flag: {
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  sourceTitle: string;
  best: { episodeNumber: number; title: string | null } | null;
}): { subject: string; note: string } {
  const on = episodeLabelOf(flag.seasonNumber, flag.episodeNumber, flag.episodeTitle);
  const named = flag.best ? episodeLabelOf(flag.seasonNumber, flag.best.episodeNumber, flag.best.title) : 'another episode';
  return {
    subject: `${on} plays another episode`,
    note: `The file on ${on} is named for ${named} (${flag.sourceTitle}), and that episode has its own file, so it cannot be moved from the episode page.`,
  };
}

/** The single-move claim a flag opens the guide with, or null when the name points nowhere. */
export function titleFlagClaim(flag: { episodeId: number; best: { episodeId: number } | null }): RemapClaim | null {
  if (!flag.best || flag.best.episodeId === flag.episodeId) return null;
  return { kind: 'single', fromEpisodeId: flag.episodeId, toEpisodeId: flag.best.episodeId };
}

/** The open flags by episode id (one per episode: the first wins; the domain sends the newest first). */
export function flagsByEpisode<T extends { episodeId: number; best: unknown }>(flags: readonly T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const f of flags) if (f.best !== null && !map.has(f.episodeId)) map.set(f.episodeId, f);
  return map;
}
