// ADR-109 / DESIGN-055 D-01, D-08, D-09 (PLAN-077 P1) — the Repair Guide's pure rules: which step comes next, which
// lines would be gone afterwards (each must be ticked), when the preview refuses, and the confirm wording. The
// component (app/(app)/library/[id]/repair-guide.tsx) renders them; lib/__tests__/repair-guide.test.ts proves them.
// Copy follows the owner's rules: plain and friendly, no em-dashes, no names.
import type { RouterOutputs } from './trpc-client';
import { formatBytes, type FixReasonName } from './media';

/** The remedies `repair_guide_remedies` switches (mirrors @hnet/db REPAIR_GUIDE_REMEDIES). */
export interface GuideRemedies {
  replacement_preview: boolean;
  season_guard: boolean;
  language_check: boolean;
  playback_triage: boolean;
}

export type GuideStep =
  | 'pick'
  | 'episodes'
  | 'reason'
  | 'playback'
  | 'language'
  | 'language-present'
  | 'preview'
  | 'confirm'
  | 'done';

/** The guarded Fix's plan, as `fix.preview` returns it. */
export type GuidePlan = NonNullable<RouterOutputs['fix']['preview']['plan']>;

/** The R-45 reasons, worded for people. */
export const GUIDE_REASON_LABELS: Record<FixReasonName, string> = {
  wont_play_corrupt: "It won't play, or it plays with errors",
  wrong_language: "It's in the wrong language",
  wrong_version_quality: "It's the wrong version or the quality is poor",
  missing_subtitles: 'Subtitles are missing',
  wrong_content: "It's a different show or movie",
  other: 'Something else',
};

/** Common audio languages for "Another language" (ISO 639-2, the codes Sonarr and Radarr report). */
export const OTHER_AUDIO_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'spa', name: 'Spanish' },
  { code: 'fre', name: 'French' },
  { code: 'ger', name: 'German' },
  { code: 'ita', name: 'Italian' },
  { code: 'por', name: 'Portuguese' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' },
  { code: 'chi', name: 'Chinese' },
  { code: 'hin', name: 'Hindi' },
  { code: 'rus', name: 'Russian' },
];

/** Whether a planning remedy is on (the guide previews the plan before acting). */
export function guidePlans(remedies: GuideRemedies): boolean {
  return remedies.replacement_preview || remedies.season_guard;
}

/** The first question: pick an episode for a bare TV Fix, the episodes of a season (season guard), else the reason. */
export function firstGuideStep(input: {
  isTv: boolean;
  hasTarget: boolean;
  isSeason: boolean;
  remedies: GuideRemedies;
}): GuideStep {
  if (input.isTv && !input.hasTarget) return 'pick';
  if (input.isSeason && input.remedies.season_guard) return 'episodes';
  return 'reason';
}

/** After the triage steps: the preview when a planning remedy is on, else today's confirm. Subtitles never preview. */
export function stepAfterTriage(reason: FixReasonName, remedies: GuideRemedies): GuideStep {
  return guidePlans(remedies) && reason !== 'missing_subtitles' ? 'preview' : 'confirm';
}

/** After "What's wrong?": Won't play reads Playback Evidence, Wrong language reads the audio, if their remedy is on. */
export function stepAfterReason(reason: FixReasonName, remedies: GuideRemedies): GuideStep {
  if (reason === 'wont_play_corrupt' && remedies.playback_triage) return 'playback';
  if (reason === 'wrong_language' && remedies.language_check) return 'language';
  return stepAfterTriage(reason, remedies);
}

/**
 * DESIGN-055 D-08 rule 3 (the client mirror of the domain's languageVerdict): the wanted language is in EVERY file in
 * scope, all of whose audio could be read. Then nothing is replaced and the guide shows how to pick the track.
 */
export function wantedLanguageInFile(files: ReadonlyArray<{ codes: readonly string[] }>, wanted: string): boolean {
  if (files.length === 0) return false;
  return files.every((f) => f.codes.length > 0 && f.codes.includes(wanted));
}

const size = (bytes: number | null | undefined) => (bytes && bytes > 0 ? formatBytes(bytes) : null);

/** "Remux-2160p · FRAMESTOR · 82 GB" from the parts that are known. */
export function describeRelease(r: {
  qualityName: string | null;
  releaseGroup: string | null;
  size: number | null;
}): string {
  return [r.qualityName, r.releaseGroup, size(r.size)].filter((p): p is string => !!p).join(' · ');
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The lines the confirm will make gone for good. Each must be ticked first; none is ever pre-ticked (D-01). */
export function goneLinesFor(plan: GuidePlan | null): Array<{ key: string; text: string }> {
  const lines: Array<{ key: string; text: string }> = [];
  if (!plan) return lines;
  if (plan.kind === 'blocklist') {
    lines.push({
      key: `block:${plan.grab.grabId}`,
      text: `${plan.grab.sourceTitle ?? 'This download'} is blocked, so it is not downloaded again.`,
    });
    if (plan.packCost.length > 0) {
      lines.push({
        key: `pack:${plan.grab.grabId}`,
        text: `The pack is blocked for the ${plan.packCost.length} other ${plural(plan.packCost.length, 'episode', 'episodes')} it holds too.`,
      });
    }
  } else if (plan.kind === 'delete') {
    if (plan.file) {
      const s = size(plan.file.size);
      lines.push({
        key: `delete:${plan.file.fileId}`,
        text: `${plan.file.name ?? 'The file'}${s ? ` (${s})` : ''} is deleted for good. There is no recycle bin.`,
      });
    }
  } else {
    for (const m of plan.marks) {
      lines.push({
        key: `block:${m.grabId}`,
        text: `${m.sourceTitle ?? 'A download'} is blocked, so it is not downloaded again (${m.episodes.map((e) => e.label).join(', ')}).`,
      });
    }
    for (const d of plan.deletes) {
      const s = size(d.file.size);
      lines.push({
        key: `delete:${d.file.fileId}`,
        text: `${d.episode.label}: ${d.file.name ?? 'its file'}${s ? ` (${s})` : ''} is deleted for good.`,
      });
    }
  }
  return lines;
}

export type GuideRefusal = 'same_release' | 'no_replacement' | 'nothing_safe';

/** When the preview itself is the answer: the Fix would refuse, so the guide offers no confirm (D-09). */
export function refusalFor(plan: GuidePlan | null, remedies: GuideRemedies): GuideRefusal | null {
  if (!plan) return null;
  if (plan.kind === 'delete' && plan.file && remedies.replacement_preview) {
    if (plan.replacement.verdict === 'same_release') return 'same_release';
    if (plan.replacement.verdict === 'no_replacement') return 'no_replacement';
  }
  if (plan.kind === 'season' && !plan.actionable) return 'nothing_safe';
  return null;
}

/** The confirm button names the action (D-01). */
export function confirmLabelFor(plan: GuidePlan | null): string {
  if (!plan) return 'Submit fix';
  if (plan.kind === 'blocklist') return 'Block it and search again';
  if (plan.kind === 'delete') return plan.file ? 'Delete it and search again' : 'Search again';
  if (plan.mode === 'blocklist') {
    return plan.marks.length === 1
      ? 'Block it and search again'
      : `Block ${plan.marks.length} downloads and search again`;
  }
  return plan.deletes.length === 1 ? 'Delete it and search again' : `Delete ${plan.deletes.length} files and search again`;
}

/** The create call's guide fields for a confirmed plan: the digest, and the choices the plan was built on. */
export function confirmFieldsFor(plan: GuidePlan, episodeIds: number[] | undefined): Record<string, unknown> {
  return {
    ...(episodeIds ? { episodeIds } : {}),
    ...(plan.kind === 'delete' && plan.insteadOfPack ? { replaceFile: true } : {}),
    ...(plan.kind === 'blocklist' && plan.packCost.length > 0 ? { blockWholePack: true } : {}),
    planDigest: plan.digest,
  };
}

/** Watch-here links with servers that have no known issue first (T-314). */
export function orderPlayTargets<T extends { serverSlug: string }>(play: readonly T[], knownIssue: readonly string[]): T[] {
  return [...play].sort(
    (a, b) => Number(knownIssue.includes(a.serverSlug)) - Number(knownIssue.includes(b.serverSlug)),
  );
}

/** "HaynesOps", "HaynesOps and HaynesKube". */
export function joinServerNames(slugs: readonly string[], names: Readonly<Record<string, string>>): string {
  return slugs.map((s) => names[s] ?? s).join(' and ');
}
