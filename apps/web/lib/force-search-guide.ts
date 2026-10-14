// ADR-109 C-05 / DESIGN-055 D-01, D-07 (PLAN-077 P2) — the queue-aware Force Search step of the Repair Guide, its pure
// rules: when Force Search reads the queue first, and the words for each thing it can find there (the plan's state, the
// Import Check's reason code, the download's progress) and for what happened after the press. The component
// (app/(app)/library/[id]/force-search-dialog.tsx) renders them; lib/__tests__/force-search-guide.test.ts proves them.
// Copy follows the owner's rules: plain and friendly, no em-dashes, no names, no time-grounding.
import { MEDIA_ACTIONS } from '@hnet/ui';
import type { RouterOutputs } from './trpc-client';
import { formatBytes, type ActionTarget } from './media';

/** What `fix.searchPlan` returns (DESIGN-055 D-07). */
export type SearchPlan = RouterOutputs['fix']['searchPlan'];
export type SearchPlanState = SearchPlan['state'];
export type SearchPlanCheck = NonNullable<SearchPlan['check']>;
export type SearchPlanDownload = NonNullable<SearchPlan['download']>;
/** The Import Check's reason codes (`ImportCheckReason` in @hnet/domain import-check.ts). */
export type ImportCheckReasonCode = SearchPlanCheck['reason'];
export type ForceSearchOutcome = RouterOutputs['fix']['forceSearch']['outcome'];

export type GuideArrKind = 'sonarr' | 'radarr';

/** The *arr that read the queue, by name (people see these names in the apps' own pages). */
const ARR_NAME: Record<GuideArrKind, string> = { sonarr: 'Sonarr', radarr: 'Radarr' };
export const arrName = (kind: GuideArrKind): string => ARR_NAME[kind];

/**
 * Whether a Force Search press reads the queue first: the `import_check` remedy is on and the target is one episode
 * (Sonarr) or the movie (Radarr). The client mirror of the domain's `queueAwareEligible`; anything else keeps today's
 * search-only dialog.
 */
export function readsQueueFirst(input: {
  arrKind: string;
  target: ActionTarget | null;
  importCheckOn: boolean;
}): boolean {
  if (!input.importCheckOn) return false;
  const t = input.target;
  if (input.arrKind === 'sonarr') return t !== null && t.scope === 'episode' && t.childId !== undefined;
  if (input.arrKind === 'radarr') return t === null || t.scope === 'item';
  return false;
}

// ---------------------------------------------------------------------------
// The download in the queue
// ---------------------------------------------------------------------------

/** The download's state in a few plain words, from the client status and the *arr's tracked state. */
export function downloadStatusText(d: Pick<SearchPlanDownload, 'status' | 'trackedState'>): string {
  const tracked = (d.trackedState ?? '').toLowerCase();
  const status = (d.status ?? '').toLowerCase();
  if (tracked === 'importing' || tracked === 'importpending') return 'Downloaded and being added to the library';
  if (status === 'delay') return 'Waiting a little while in case a better release turns up';
  if (status === 'queued') return 'Waiting its turn in the download queue';
  if (status === 'paused') return 'Paused in the download client';
  if (status === 'downloading' || tracked === 'downloading') return 'Downloading';
  if (status === 'completed') return 'Downloaded';
  return 'In the download queue';
}

/**
 * The *arr's `timeleft` (a .NET TimeSpan, `hh:mm:ss` or `d.hh:mm:ss`) as rough words: "about 12 minutes left".
 * Null when there is nothing to say.
 */
export function timeLeftText(timeLeft: string | null | undefined): string | null {
  if (!timeLeft) return null;
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/.exec(timeLeft.trim());
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 86_400 + Number(m[2]) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
  if (seconds <= 0) return null;
  const about = (n: number, one: string, many: string) => `about ${n} ${n === 1 ? one : many} left`;
  if (seconds >= 86_400) return about(Math.round(seconds / 86_400), 'day', 'days');
  if (seconds >= 3_600) return about(Math.round(seconds / 3_600), 'hour', 'hours');
  if (seconds >= 60) return about(Math.round(seconds / 60), 'minute', 'minutes');
  return 'less than a minute left';
}

/** 0..1 as a whole percent, or null when the size is unknown. */
export function progressPercent(progress: number | null | undefined): number | null {
  if (progress === null || progress === undefined || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

/** The readout under the progress bar: "45% · about 12 minutes left". */
export function progressDetail(d: Pick<SearchPlanDownload, 'progress' | 'timeLeft'>): string {
  const pct = progressPercent(d.progress);
  return [pct !== null ? `${pct}%` : null, timeLeftText(d.timeLeft)].filter((p): p is string => p !== null).join(' · ');
}

// ---------------------------------------------------------------------------
// What it found: the Import Check's evidence
// ---------------------------------------------------------------------------

/** One fact about the finished download, each with where it came from (D-01 preview contract). */
export interface EvidenceFact {
  label: string;
  value: string;
}

/** The file the Import Check judged: name, size, quality, audio languages, release group (what is known). */
export function fileFacts(file: SearchPlanCheck['file']): EvidenceFact[] {
  if (!file) return [];
  const facts: EvidenceFact[] = [{ label: 'File', value: file.fileName }];
  if (file.sizeBytes !== null && file.sizeBytes > 0) facts.push({ label: 'Size', value: formatBytes(file.sizeBytes) });
  if (file.qualityName) facts.push({ label: 'Quality', value: file.qualityName });
  if (file.languages.length > 0) facts.push({ label: 'Audio', value: file.languages.join(', ') });
  if (file.releaseGroup) facts.push({ label: 'Release group', value: file.releaseGroup });
  return facts;
}

/** A message that is only a file or archive name (Sonarr titles each status message with the file it is about). */
const FILE_NAME_ONLY = /\.(?:mkv|mp4|m4v|avi|wmv|ts|mov|rar|zip|7z|nzb)$/i;

/**
 * The *arr's own words about the download (its status and error messages), without the lines that only name the file
 * or the download, which the evidence already shows.
 */
export function arrMessages(
  download: Pick<SearchPlanDownload, 'title' | 'messages'> | null,
  check: Pick<SearchPlanCheck, 'file'> | null,
): string[] {
  const skip = new Set([download?.title, check?.file?.fileName].filter((x): x is string => !!x));
  return (download?.messages ?? []).filter((m) => !skip.has(m) && !FILE_NAME_ONLY.test(m.trim()));
}

/** What the file's own name says about the title (Title Evidence, ADR-110): only the two verdicts an import rides on. */
export function titleEvidenceText(check: Pick<SearchPlanCheck, 'title'>, kind: GuideArrKind): string | null {
  const noun = kind === 'radarr' ? 'movie' : 'episode';
  switch (check.title?.verdict) {
    case 'agrees':
      return `The file name matches the ${noun} title`;
    case 'silent':
      return `The file name carries no ${noun} title`;
    default:
      return null;
  }
}

/**
 * The episodes a file lands on, by label: the target first, then the others the file holds (a multi-episode file).
 * `labelOf` looks an episode id up (the title's episode list); an unknown one reads "another episode".
 */
export function importTargetLabels(
  targetIds: readonly number[],
  target: { id: number | null; label: string },
  labelOf: (id: number) => string | null,
): string[] {
  if (targetIds.length <= 1) return [target.label];
  const ordered =
    target.id !== null && targetIds.includes(target.id)
      ? [target.id, ...targetIds.filter((id) => id !== target.id)]
      : [...targetIds];
  return ordered.map((id) =>
    id === target.id ? target.label : (labelOf(id) ?? 'another episode'),
  );
}

/** "A, B and C". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The step's question, per state
// ---------------------------------------------------------------------------

/** The heading of the step for a plan. */
export function stepHeading(
  plan: Pick<SearchPlan, 'state' | 'removeWhy'> & {
    needsTargetCheck?: boolean;
    activeRequest?: boolean;
  },
  targetLabel: string,
  ontoSuggested: string | null,
): string {
  switch (plan.state) {
    case 'search':
      return `Nothing for ${targetLabel} is in the download queue.`;
    case 'on_its_way':
      return plan.activeRequest ? 'A repair is already running' : 'Already on its way';
    case 'import':
      return plan.needsTargetCheck
        ? `Check this download for ${targetLabel}`
        : `A finished download for ${targetLabel} is waiting to be added`;
    case 'import_onto':
      return ontoSuggested !== null
        ? `This download's name says it is ${ontoSuggested}`
        : `This download's name does not match ${targetLabel}`;
    case 'remove_and_search':
      return plan.removeWhy === 'defect'
        ? `The download for ${targetLabel} is broken.`
        : `The last download for ${targetLabel} failed.`;
    case 'staff':
      return plan.activeRequest
        ? 'This repair needs staff'
        : `A download for ${targetLabel} needs staff`;
  }
}

/** A release defect, in plain words, from the *arr's own rejection text (`check.detail`). */
export function defectText(detail: string | null | undefined, kind: GuideArrKind): string | null {
  if (!detail) return null;
  const whole = kind === 'radarr' ? 'the movie' : 'the episode';
  if (/^sample\.?$/i.test(detail.trim())) return `It is only a short sample, not ${whole}.`;
  if (/unable to parse/i.test(detail)) return `${arrName(kind)} cannot read its file name.`;
  if (/password/i.test(detail)) return 'It is locked with a password.';
  if (/executable/i.test(detail)) return 'It holds a program file, not a video.';
  return `${arrName(kind)} says: “${detail}”`;
}

/** Why a stuck download needs staff, one plain sentence (or two) per Import Check reason. */
export function staffText(input: {
  check: Pick<SearchPlanCheck, 'reason' | 'detail' | 'title'> | null;
  targetLabel: string;
  kind: GuideArrKind;
  activeRequest?: boolean;
}): string {
  const { check, targetLabel, kind } = input;
  const app = arrName(kind);
  const what = kind === 'radarr' ? 'movie' : 'episode';
  if (input.activeRequest)
    return `A repair is already open for ${targetLabel}. Staff can check its progress and the download.`;
  if (!check)
    return `A download for ${targetLabel} is stuck in the queue, and it cannot be added on its own.`;
  const mismatch = `This download's name does not match ${targetLabel}, so it will not be added automatically.`;
  switch (check.reason) {
    case 'archive':
      return 'This download has to be unpacked before it can be added, and that needs staff for now.';
    case 'title_ambiguous':
    case 'title_disagrees':
    case 'mapping_conflict':
      return mismatch;
    case 'year_conflict': {
      const year = check.title?.conflictingYear ?? null;
      return year !== null ? `${mismatch} It names a ${kind === 'radarr' ? 'movie' : 'show'} from ${year}.` : mismatch;
    }
    case 'no_files':
      return 'This download has no video file to add.';
    case 'only_sample':
      return `This download holds only a short sample, not the whole ${what}.`;
    case 'have_better':
      return `The library already has this at the same or better quality, so ${app} will not add this download.`;
    case 'temporary':
      return `${app} cannot add this download yet because something about it is still in progress. Try again in a little while.`;
    case 'rejected':
      return check.detail ? `${app} turned this download down: “${check.detail}”` : `${app} turned this download down.`;
    case 'other_series':
      return kind === 'radarr' ? 'This download is for a different movie.' : 'This download is for a different show.';
    case 'no_file_for_target':
      return `None of the files in this download is for ${targetLabel}.`;
    case 'several_files':
      return `This download holds more than one file for ${targetLabel}, so someone has to pick the right one.`;
    case 'missing_quality':
      return `${app} could not tell this download's quality or language, so it cannot add it on its own.`;
    case 'no_mapping':
      return `${app} could not tell which ${what} this download is.`;
    case 'uncovered_targets':
      return 'This download was grabbed for more episodes than it has files for.';
    case 'defect':
      return defectText(check.detail, kind) ?? 'This download is broken.';
    case 'ok':
      return `A download for ${targetLabel} is stuck in the queue, and it cannot be added on its own.`;
  }
}

// ---------------------------------------------------------------------------
// The confirm, the "gone afterwards" line and the outcome
// ---------------------------------------------------------------------------

/** The confirm button names the action (D-01). `import` is the registry's "Import it" (MEDIA_ACTIONS.importDownload). */
export function confirmText(state: SearchPlanState, ontoLabel: string | null): string | null {
  switch (state) {
    case 'search':
      return 'Force search';
    case 'import':
      return MEDIA_ACTIONS.importDownload.label;
    case 'import_onto':
      return ontoLabel !== null ? `Import onto ${ontoLabel}` : null;
    case 'remove_and_search':
      return 'Remove it and search again';
    default:
      return null;
  }
}

/**
 * DESIGN-055 D-01 preview contract — the "gone afterwards" line for a file an import replaces: the *arr imports the
 * upgrade over the file on disk and deletes the old one, so the person ticks it before "Import it" works.
 */
export function replacedGoneLine(r: Pick<SearchPlan['replaces'][number], 'label' | 'qualityName' | 'sizeBytes'>): string {
  const about = [r.qualityName, r.sizeBytes !== null && r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : null].filter(
    (x): x is string => x !== null && x !== '',
  );
  return `The current file of ${r.label}${about.length > 0 ? ` (${about.join(', ')})` : ''}, which this download replaces`;
}

/** The one line a removal makes gone for good. It must be ticked first and is never pre-ticked (D-01). */
export function removalGoneLine(download: Pick<SearchPlanDownload, 'title'> | null): string {
  return `Remove ${download?.title ?? 'this download'} and block that release so it is not downloaded again`;
}

/** The final line after the write, in plain words (D-07); it is also the Seerr resolve note later (D-10). */
export function outcomeText(input: {
  outcome: ForceSearchOutcome;
  removeWhy: 'failed' | 'defect' | null;
  targetLabel: string;
}): string {
  switch (input.outcome) {
    case 'imported':
      return 'Found a finished download and imported it.';
    case 'importing':
      return `Found a finished download and started the import. ${input.targetLabel} shows up here when it finishes.`;
    case 'removed_and_searched':
      return input.removeWhy === 'defect'
        ? 'Removed a bad download and searched again.'
        : 'Removed a failed download and searched again.';
    case 'on_its_way':
      return 'Already on its way.';
    case 'searched':
      return `A fresh search is running, and the manager will grab ${input.targetLabel} as soon as a release is found.`;
  }
}

/** Whether an outcome started a search the live progress view can follow (ADR-028). */
export function outcomeSearched(outcome: ForceSearchOutcome): boolean {
  return outcome === 'searched' || outcome === 'removed_and_searched';
}

// ---------------------------------------------------------------------------
// The staff path: a prefilled Helpdesk ticket
// ---------------------------------------------------------------------------

/** The ticket a stuck download prefills: a subject and a note that says what Force Search found. */
export function staffTicketText(input: {
  plan: Pick<SearchPlan, 'state' | 'check' | 'download'>;
  targetLabel: string;
  kind: GuideArrKind;
  reasonLine: string;
}): { subject: string; note: string } {
  const { plan, targetLabel, kind } = input;
  const lines = [`Force Search found a download for ${targetLabel} that it could not add on its own.`, '', input.reasonLine];
  if (plan.download?.title) lines.push('', `Download: ${plan.download.title}`);
  if (plan.check?.file?.fileName) lines.push(`File: ${plan.check.file.fileName}`);
  for (const m of arrMessages(plan.download, plan.check)) lines.push(`${arrName(kind)} says: ${m}`);
  return { subject: `Stuck download: ${targetLabel}`, note: lines.join('\n') };
}
