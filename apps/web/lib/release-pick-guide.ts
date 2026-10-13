// ADR-109 C-06 / DESIGN-055 D-01, D-06 (PLAN-077 P5): the Release Pick step of the Repair Guide, its pure rules and
// every word it shows. "See every release" lists every release the sites have for one missing episode or movie, each
// with the *arr's reasons in plain words; the person grabs an approved one, or one outside the library's usual rules
// when every reason allows it (the owner's Q-01 ruling). The component (app/(app)/library/[id]/release-pick.tsx)
// renders these; lib/__tests__/release-pick-guide.test.ts proves them.
//
// Copy follows the owner's rules: plain words a household member understands, friendly and semi-professional, no
// em-dashes, no names, no time-grounding. A guid, a URL or a custom-format score is never the explanation; the score
// sits only under the *arr's own words.
import { MEDIA_ACTIONS } from '@hnet/ui';
import type { RouterOutputs } from './trpc-client';
import type { ActionTarget } from './media';

/** What `fix.releaseList` returns (DESIGN-055 D-06). */
export type ReleaseList = RouterOutputs['fix']['releaseList'];
export type ReleaseRow = ReleaseList['rows'][number];
export type ReleaseReasonView = ReleaseRow['reasons'][number];
export type ReleaseBudget = ReleaseList['budget'];
/** What `fix.releaseGrab` returns. */
export type ReleaseGrab = RouterOutputs['fix']['releaseGrab'];
export type ReleaseGrabOutcome = ReleaseGrab['outcome'];

export type PickArrKind = 'sonarr' | 'radarr';

const ARR_NAME: Record<PickArrKind, string> = { sonarr: 'Sonarr', radarr: 'Radarr' };
const noun = (kind: PickArrKind) => (kind === 'radarr' ? 'movie' : 'episode');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Whether "See every release" is offered for a target: the `release_pick` remedy is on and the target is one episode
 * (Sonarr) or the movie (Radarr). The list is for one missing episode or movie at a time, so a season, a whole show and
 * music never get it.
 */
export function offersReleasePick(input: {
  arrKind: string;
  target: ActionTarget | null;
  releasePickOn: boolean;
}): boolean {
  if (!input.releasePickOn) return false;
  const t = input.target;
  if (input.arrKind === 'sonarr') return t !== null && t.scope === 'episode' && t.childId !== undefined;
  if (input.arrKind === 'radarr') return t === null || t.scope === 'item';
  return false;
}

/** The entry's note beside "See every release": what it lists and what it costs, before anyone presses it. */
export const PICK_ENTRY_NOTE =
  'Lists every release the sites have, including ones the library would not normally take. Opening the list uses one hourly media action.';

/** The note on an emptied episode in a re-map's result, where "See every release" sits beside Force Search. */
export const PICK_ENTRY_SHORT_NOTE = 'See every release lists what the sites have. It uses one hourly media action.';

// ---------------------------------------------------------------------------
// Searching, and the answers that come with no list
// ---------------------------------------------------------------------------

export function searchingText(targetLabel: string): string {
  return `Looking on every site for ${targetLabel}…`;
}

export const SEARCHING_NOTE = 'This can take up to a minute.';

/**
 * The step for a list that came back with no rows because there is nothing to pick (it costs no hourly action).
 * `on_its_way` without a download in the queue is a pick still open on the target: its download is being added, or
 * failed in a way the *arr has not recorded yet.
 */
export function statusStepText(
  status: Exclude<ReleaseList['status'], 'list'>,
  targetLabel: string,
  hasDownload = true,
): { heading: string; body: string } {
  const free = 'Nothing was listed, so no hourly media action was used.';
  switch (status) {
    case 'has_file':
      return {
        heading: `${targetLabel} already has a file`,
        body: `Every release is listed only for something that is missing. ${free}`,
      };
    case 'on_its_way':
      return {
        heading: 'Already on its way',
        body: hasDownload
          ? `A download for ${targetLabel} is in the queue, so there is nothing to pick. ${free}`
          : `A release picked for ${targetLabel} is still on its way or being added, so there is nothing to pick. ${free}`,
      };
    case 'queue_stuck':
      return {
        heading: `A download for ${targetLabel} is stuck in the queue`,
        body: `Force Search looks at that download first, and adds it when it can. ${free}`,
      };
  }
}

// ---------------------------------------------------------------------------
// One row, in plain words
// ---------------------------------------------------------------------------

/** The site's name without the " (Prowlarr)" suffix the indexer manager adds. */
export function siteName(indexer: string | null | undefined): string | null {
  if (!indexer) return null;
  const name = indexer.replace(/\s*\(prowlarr\)\s*$/i, '').trim();
  return name === '' ? null : name;
}

/** A release's size in GB ("2.4 GB", "14 GB"); a small one in MB. Null when the size is unknown. */
export function sizeText(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 0.1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** The facts under a release's title: quality, size, languages, the site, and how many sites have it. */
export function rowFacts(row: Pick<ReleaseRow, 'qualityPlain' | 'sizeBytes' | 'languages' | 'indexer' | 'keys'>): string[] {
  const facts: string[] = [row.qualityPlain];
  const size = sizeText(row.sizeBytes);
  if (size) facts.push(size);
  const languages = row.languages.filter((l) => l.trim() !== '');
  if (languages.length > 0) facts.push(languages.join(', '));
  const site = siteName(row.indexer);
  if (site) facts.push(site);
  if (row.keys.length > 1) facts.push(`found on ${row.keys.length} sites`);
  return facts;
}

/** The episode code of a label ("S01E10 · Chapter 10" reads "S01E10"). */
function codeOf(label: string): string {
  return label.split(' · ')[0] ?? label;
}

/** "S05E19 and S05E20", "S01E01, S01E02 and S01E03". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "both" for two, "all 3" for more. */
function bothOrAll(n: number): string {
  return n === 2 ? 'both' : `all ${n}`;
}

/**
 * DESIGN-055 P5 decision 17 (issue #936): a release that holds several episodes, every one of them missing, fills them
 * all. The line under its facts says which.
 */
export function holdsText(holds: readonly string[]): string {
  return `Holds ${andList(holds.map(codeOf))}, ${holds.length === 2 ? 'both' : 'all'} missing`;
}

export type EvidenceTone = 'good' | 'quiet';

/**
 * The Title Evidence badge (ADR-110) in words: what the release's own name says about the target. A name that says it
 * is another episode is not repeated here: its hard reason already says so, in the alert tone.
 */
export function evidenceText(
  row: Pick<ReleaseRow, 'evidence' | 'numberedAs' | 'holds'>,
  kind: PickArrKind,
): { text: string; tone: EvidenceTone } | null {
  if (row.holds && row.holds.length > 1) return { text: holdsText(row.holds), tone: 'good' };
  if (row.numberedAs) {
    return { text: `Numbered as ${codeOf(row.numberedAs)}, but its title is this episode’s`, tone: 'good' };
  }
  switch (row.evidence?.verdict) {
    case 'agrees':
      return { text: `Its name matches this ${noun(kind)}`, tone: 'good' };
    case 'silent':
      return kind === 'sonarr' ? { text: 'Its name gives no episode title', tone: 'quiet' } : null;
    case 'ambiguous':
      return { text: `Its name could fit more than one ${noun(kind)}`, tone: 'quiet' };
    default:
      return null;
  }
}

export type ReasonTone = 'hard' | 'blocks' | 'neutral';

/** A hard refusal reads in the alert tone; a reason that blocks a pick in the warning tone; an overridable one neutral. */
export function reasonTone(reason: Pick<ReleaseReasonView, 'class'>): ReasonTone {
  if (reason.class === 'hard') return 'hard';
  if (reason.class === 'other') return 'blocks';
  return 'neutral';
}

/** The reasons a row shows. The "numbered as another episode" reason is the badge's line, so it is not repeated. */
export function displayReasons(row: Pick<ReleaseRow, 'reasons' | 'numberedAs'>): ReleaseReasonView[] {
  return row.numberedAs ? row.reasons.filter((r) => r.code !== 'numbered_other_episode') : [...row.reasons];
}

/** The disclosure's summary over the *arr's own words. */
export function arrWordsLabel(kind: PickArrKind): string {
  return `What ${ARR_NAME[kind]} says`;
}

/** The *arr's own words about a row (each once), and its custom-format score when it has one. */
export function arrWords(row: Pick<ReleaseRow, 'reasons' | 'customFormatScore'>): string[] {
  const words = [...new Set(row.reasons.map((r) => r.arrText).filter((t): t is string => !!t && t.trim() !== ''))];
  if (row.customFormatScore !== null && row.customFormatScore !== 0) words.push(`Custom format score: ${row.customFormatScore}`);
  return words;
}

/** The short tag on a row: whether it fits the library's rules, is outside them, or cannot be picked. */
export function rowStateTag(row: Pick<ReleaseRow, 'state'>): string {
  switch (row.state) {
    case 'grab':
      return 'Fits the library’s rules';
    case 'override':
      return 'Outside the usual rules';
    case 'not_allowed':
      return 'Can’t be picked';
  }
}

export const BEST_CHOICE_LABEL = 'Best choice';

/** One line on why the recommended row is the best choice. */
export function bestChoiceWhy(
  row: Pick<ReleaseRow, 'state' | 'evidence' | 'numberedAs' | 'holds'>,
  kind: PickArrKind,
): string {
  // A release that fills several episodes: its line under the facts says which, so the name is not claimed for this one.
  const matches = row.evidence?.verdict === 'agrees' && !(row.holds && row.holds.length > 1);
  if (row.state === 'grab') {
    return matches
      ? `It’s the one the library would pick on its own, and its name matches this ${noun(kind)}.`
      : 'It’s the one the library would pick on its own.';
  }
  if (row.numberedAs) {
    return `The closest to what the library usually keeps, and its title is this ${noun(kind)}’s.`;
  }
  return matches
    ? `The closest to what the library usually keeps, and its name matches this ${noun(kind)}.`
    : 'The closest to what the library usually keeps.';
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function isPickable(row: Pick<ReleaseRow, 'state'>): boolean {
  return row.state !== 'not_allowed';
}

export interface ListSections {
  best: ReleaseRow | null;
  /** The other rows the person can pick, in the list's order (Grab before Override). */
  others: ReleaseRow[];
  /** The rows nobody can pick, with their reasons. */
  blocked: ReleaseRow[];
}

/** The recommended row first, then the other rows the person can pick, then the ones nobody can. */
export function listSections(list: Pick<ReleaseList, 'rows' | 'recommendedKey'>): ListSections {
  const best =
    list.rows.find((r) => r.key === list.recommendedKey && isPickable(r)) ??
    list.rows.find((r) => r.recommended && isPickable(r)) ??
    null;
  return {
    best,
    others: list.rows.filter((r) => isPickable(r) && r !== best),
    blocked: list.rows.filter((r) => !isPickable(r)),
  };
}

/** The line over the list. */
export function listLead(sections: ListSections, targetLabel: string): string {
  const pickable = (sections.best ? 1 : 0) + sections.others.length;
  const total = pickable + sections.blocked.length;
  if (total === 0) return `No site has a release of ${targetLabel}.`;
  if (pickable === 0) {
    return `The sites have ${plural(total, 'release', 'releases')} of ${targetLabel}, but none of them can be picked.`;
  }
  return `Found ${plural(total, 'release', 'releases')} of ${targetLabel}. You can pick ${pickable === total ? (total === 1 ? 'it' : 'any of them') : `${pickable} of them`}.`;
}

export const OTHERS_HEADING = 'Other releases you can pick';

export function blockedSummary(count: number): string {
  return `Releases you can’t pick (${count})`;
}

export const BLOCKED_NOTE =
  'These break a rule that applies to everyone. If one of them is the right release, ask staff and they can look at it.';

/** When nothing at all came back, or nothing can be picked: where to go next (before the "Ask staff" link). */
export const NOTHING_TO_PICK_NOTE = 'Staff can look further.';
/** After an "Ask staff" link in a sentence. */
export const ASK_STAFF_TAIL = 'and the details go with your ticket.';

export const PICK_LABEL = 'Pick this one';

/**
 * The hourly budget in plain words: what is left while picking is possible, and why it is paused when it is not
 * (the existing budget wording: "Give it a little while and try again"). Null for someone with no limit.
 */
export function budgetText(budget: Pick<ReleaseBudget, 'limit' | 'left'>, canPick: boolean): string | null {
  if (!canPick) {
    return budget.limit === 0
      ? 'Media actions are turned off for your role, so nothing can be picked. An admin can turn them back on.'
      : 'You have used all your hourly media actions, so picking is paused. Give it a little while and try again.';
  }
  if (budget.limit === null || budget.left === null) return null;
  return `Picking a release uses one hourly media action. You have ${budget.left} left.`;
}

/**
 * The budget after the picks made from this list (each grab press is one unit, even one a site refuses). The list's
 * own budget was read when it opened.
 */
export function budgetAfter(
  budget: Pick<ReleaseBudget, 'limit' | 'used' | 'left'>,
  picksMade: number,
): { limit: number | null; used: number; left: number | null; canPick: boolean } {
  if (budget.limit === null || budget.left === null) return { ...budget, canPick: true };
  const left = Math.max(0, budget.left - picksMade);
  return { limit: budget.limit, used: budget.used + picksMade, left, canPick: left > 0 };
}

// ---------------------------------------------------------------------------
// The confirm (DESIGN-055 D-01 preview contract)
// ---------------------------------------------------------------------------

export const CONFIRM_HEADING = 'Grab this release?';

/** The confirm button: the registry's "Grab this release" (MEDIA_ACTIONS.grabRelease). */
export const CONFIRM_LABEL = MEDIA_ACTIONS.grabRelease.label;

/** One line of "What it will do"; an override's line lists the library rules it goes past under it. */
export interface ConfirmLine {
  text: string;
  sub: string[];
}

/**
 * DESIGN-055 D-01's preview contract for a grab: what it will do, in order. The download for the target; for an override,
 * that it is outside the library's usual rules (each rule under it) and is an exception for this one episode or movie;
 * for a release numbered for another episode, how it reaches the right one; that nothing is deleted or blocked; and the
 * hourly action it uses (for someone with a limit).
 */
export function confirmPlan(
  row: Pick<ReleaseRow, 'state' | 'reasons' | 'numberedAs' | 'holds'>,
  input: { kind: PickArrKind; targetLabel: string; limited: boolean },
): ConfirmLine[] {
  // P5 decision 17: a release that holds several missing episodes names each one it fills.
  const holds = row.holds && row.holds.length > 1 ? row.holds : null;
  const lines: ConfirmLine[] = holds
    ? [{ text: `Download this release for ${bothOrAll(holds.length)} of the missing episodes it holds:`, sub: [...holds] }]
    : [{ text: `Download this release for ${input.targetLabel}.`, sub: [] }];
  if (row.state === 'override') {
    lines.push({
      text: `It is outside the library’s usual rules, so the library would not take it on its own. Grabbing it makes an exception for ${holds ? 'these episodes' : `this one ${noun(input.kind)}`}.`,
      sub: displayReasons(row)
        .filter((r) => r.class === 'overridable')
        .map((r) => r.text),
    });
  }
  if (row.numberedAs) {
    lines.push({
      text: `Its name numbers it as ${codeOf(row.numberedAs)}, so once it arrives the app adds it to ${input.targetLabel}. If it gets stuck on the way, Force Search on this episode adds it.`,
      sub: [],
    });
  }
  lines.push({ text: 'Nothing is deleted or blocked.', sub: [] });
  if (input.limited) lines.push({ text: 'It uses one of your hourly media actions.', sub: [] });
  return lines;
}

export const GRABBING_TEXT = 'Asking the site for it…';

// ---------------------------------------------------------------------------
// After the press
// ---------------------------------------------------------------------------

/** The site would not hand the release over: the row stays on the list, marked. */
export const SITE_REFUSED_TEXT = 'That site wouldn’t hand it over.';
export const TRY_ANOTHER_SITE_LABEL = 'Try another site';
export const TRY_ANOTHER_SITE_NOTE = 'Trying another site uses one more hourly media action.';
/** Every site the release was found on refused it. */
export const EVERY_SITE_REFUSED_TEXT = 'None of its sites would hand it over. Pick another release.';

/** The next site to try for a row a site refused: the first of its sources not tried yet. */
export function nextKey(row: Pick<ReleaseRow, 'keys'>, tried: readonly string[]): string | null {
  return row.keys.find((k) => !tried.includes(k)) ?? null;
}

/** The words for a grab's outcome. `grabbed` is the result step's lead; the rest say why nothing was grabbed. */
export function grabOutcomeText(input: { outcome: ReleaseGrabOutcome; targetLabel: string; override: boolean }): string {
  const { outcome, targetLabel } = input;
  switch (outcome) {
    case 'grabbed':
      return input.override
        ? `Grabbed it for ${targetLabel}, as an exception to the library’s usual rules.`
        : `Grabbed it for ${targetLabel}.`;
    case 'unsure':
      return `It isn’t certain the grab for ${targetLabel} went through: the answer got lost on the way. The status below shows what happens.`;
    case 'list_stale':
      return 'This list is out of date, so nothing was grabbed.';
    case 'grab_failed':
      return SITE_REFUSED_TEXT;
    case 'has_file':
      return `${targetLabel} has a file, so nothing was grabbed.`;
    case 'on_its_way':
      return `Something for ${targetLabel} is already downloading, so nothing was grabbed.`;
    case 'not_allowed':
      return 'That release can’t be picked, so nothing was grabbed. Choose another one, or ask staff.';
  }
}

export const STALE_NOTE = 'Search again to see what the sites have. A fresh list uses one more hourly media action.';
export const SEARCH_AGAIN_LABEL = 'Search again';

/** What comes after the live progress of a grab, per phase (ADR-028), and the step it offers. */
export function resultFollowUp(
  phase: string | null,
  input: { kind: PickArrKind; targetLabel: string },
): { text: string; next: 'pick_again' | 'force_search' | null; tone: 'quiet' | 'alert' | 'done' } {
  switch (phase) {
    case 'failed':
      return {
        text: 'The download didn’t work, so that release is blocked and won’t be tried again. You can pick another one. A fresh list uses one more hourly media action.',
        next: 'pick_again',
        tone: 'alert',
      };
    case 'nothing_found':
      return {
        text: 'This pick closed before anything arrived. You can pick another release. A fresh list uses one more hourly media action.',
        next: 'pick_again',
        tone: 'alert',
      };
    case 'stalled':
      return {
        text: `It finished downloading but needs a hand to be added. Force Search on this ${noun(input.kind)} checks the download and adds it.`,
        next: 'force_search',
        tone: 'alert',
      };
    case 'completed':
      return { text: `Added to ${input.targetLabel}.`, next: null, tone: 'done' };
    default:
      return { text: 'You can close this. The download carries on without it.', next: null, tone: 'quiet' };
  }
}

export const PICK_AGAIN_LABEL = 'Pick another release';

// ---------------------------------------------------------------------------
// Ask staff: a prefilled Helpdesk ticket
// ---------------------------------------------------------------------------

/** The ticket "Ask staff" prefills for a release nobody can pick, or for a list with nothing to pick. */
export function askStaffTicket(input: {
  row: Pick<ReleaseRow, 'title' | 'indexer' | 'reasons' | 'customFormatScore'> | null;
  targetLabel: string;
  kind: PickArrKind;
}): { subject: string; note: string } {
  const { row, targetLabel, kind } = input;
  if (!row) {
    return {
      subject: `No release to pick for ${targetLabel}`,
      note: [`The release list for ${targetLabel} had nothing that could be picked from the app.`].join('\n'),
    };
  }
  const lines = [`The release list for ${targetLabel} found a release that can’t be picked from the app.`, '', `Release: ${row.title}`];
  const site = siteName(row.indexer);
  if (site) lines.push(`Found on: ${site}`);
  const reasons = row.reasons.map((r) => r.text);
  if (reasons.length > 0) lines.push('', 'Why it can’t be picked:', ...reasons.map((r) => `- ${r}`));
  for (const w of arrWords(row)) lines.push(`${ARR_NAME[kind]} says: ${w}`);
  return { subject: `Release for ${targetLabel}: ${row.title}`, note: lines.join('\n') };
}

export const ASK_STAFF_LABEL = 'Ask staff';
