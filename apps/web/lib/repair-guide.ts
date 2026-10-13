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
  /** DESIGN-055 D-08 (PLAN-077 P6): Wrong language may set a show's audio language in Plex (Q-03 ruling). */
  audio_preference?: boolean;
  /** DESIGN-055 D-08 rule 4 (PLAN-077 P6): Wrong language replaces a file that lacks the language (the Language Replace). */
  language_search?: boolean;
}

export type GuideStep =
  | 'pick'
  | 'episodes'
  | 'reason'
  | 'playback'
  | 'language'
  | 'language-present'
  // DESIGN-055 D-08 (PLAN-077 P6): Plex now plays the wanted language first on the show; a season whose files lack it.
  | 'language-set'
  | 'language-episodes'
  | 'preview'
  | 'confirm'
  | 'done'
  // DESIGN-055 D-04 (PLAN-077 P4): the Episode Re-map (episode-remap.tsx runs its own question, preview and result).
  | 'remap';

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

/**
 * The first question: a Title Check flag opens the re-map straight away (D-05); else pick an episode for a bare TV Fix,
 * the episodes of a season (season guard), else the reason.
 */
export function firstGuideStep(input: {
  isTv: boolean;
  hasTarget: boolean;
  isSeason: boolean;
  remedies: GuideRemedies;
  /** DESIGN-055 D-05 — opened from a Title Check flag with the move already chosen. */
  remapStart?: boolean;
}): GuideStep {
  if (input.remapStart && input.isTv && input.hasTarget) return 'remap';
  if (input.isTv && !input.hasTarget) return 'pick';
  if (input.isSeason && input.remedies.season_guard) return 'episodes';
  return 'reason';
}

/** The Language Replace's plan applies: a Wrong language Fix with both of its remedies on (DESIGN-055 D-08 rule 4). */
export function languagePlans(reason: FixReasonName, remedies: GuideRemedies): boolean {
  return reason === 'wrong_language' && remedies.language_check && remedies.language_search === true;
}

/** After the triage steps: the preview when a planning remedy is on, else today's confirm. Subtitles never preview. */
export function stepAfterTriage(reason: FixReasonName, remedies: GuideRemedies): GuideStep {
  if (languagePlans(reason, remedies)) return 'preview';
  return guidePlans(remedies) && reason !== 'missing_subtitles' ? 'preview' : 'confirm';
}

/**
 * DESIGN-055 D-08 (PLAN-077 P6) — after "Which language did you want?": the language in every file goes to the track
 * advice (and, for a show's original language, the Plex setting); a season whose files lack it goes to the episode list
 * (each episode is fixed on its own); otherwise the replace preview, or today's Fix.
 */
export function stepAfterLanguage(input: {
  files: ReadonlyArray<{ codes: readonly string[] }>;
  wanted: string;
  isSeason: boolean;
  remedies: GuideRemedies;
}): GuideStep {
  if (wantedLanguageInFile(input.files, input.wanted)) return 'language-present';
  if (input.isSeason && languagePlans('wrong_language', input.remedies)) return 'language-episodes';
  return stepAfterTriage('wrong_language', input.remedies);
}

/** The files in scope that do not carry the wanted language (a season's episodes, by label). */
export function filesLacking(
  files: ReadonlyArray<{ label: string | null; codes: readonly string[] }>,
  wanted: string,
): string[] {
  return files.filter((f) => f.codes.length > 0 && !f.codes.includes(wanted)).map((f) => f.label ?? 'This file');
}

/** One audio track as Plex lists it (`fix.audioPreference`'s `tracks`). */
export interface GuideAudioTrack {
  position: number;
  languageCode: string | null;
  displayTitle: string | null;
  isDefault: boolean;
}

/** The terminology codes Plex sends for a few languages, folded to the codes the *arrs send (`deu` → `ger`). */
const TRACK_CODE_ALIASES: Readonly<Record<string, string>> = {
  fra: 'fre',
  deu: 'ger',
  zho: 'chi',
  nld: 'dut',
  ces: 'cze',
  ell: 'gre',
  ron: 'rum',
  msa: 'may',
  isl: 'ice',
  fas: 'per',
  slk: 'slo',
  nob: 'nor',
};
const trackCode = (code: string | null) => {
  const c = (code ?? '').toLowerCase();
  return TRACK_CODE_ALIASES[c] ?? c;
};

/**
 * DESIGN-055 D-08 rule 3 — the track to pick, as Plex names it (`English (EAC3 5.1)`), its place among the file's audio
 * tracks, and the track that plays first instead (the file's default, else its first). Null when Plex listed no track in
 * the wanted language.
 */
export function trackAdvice(
  tracks: readonly GuideAudioTrack[],
  wanted: string,
): { pick: string; position: number; total: number; playsFirst: string | null } | null {
  const pick = tracks.find((t) => trackCode(t.languageCode) === wanted);
  if (!pick) return null;
  const first = tracks.find((t) => t.isDefault) ?? tracks[0] ?? null;
  return {
    pick: pick.displayTitle ?? `Track ${pick.position}`,
    position: pick.position,
    total: tracks.length,
    playsFirst: first && first !== pick ? (first.displayTitle ?? `Track ${first.position}`) : null,
  };
}

/** "the 2nd", "the 11th" — a track's place, for "choose the 2nd track". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** After "What's wrong?": Won't play reads Playback Evidence, Wrong language reads the audio, if their remedy is on. */
export function stepAfterReason(reason: FixReasonName, remedies: GuideRemedies): GuideStep {
  if (reason === 'wont_play_corrupt' && remedies.playback_triage) return 'playback';
  if (reason === 'wrong_language' && remedies.language_check) return 'language';
  return stepAfterTriage(reason, remedies);
}

/**
 * DESIGN-055 D-01, D-04 (PLAN-077 P4) — where the re-map choice sits. A single move ("It's a different episode of this
 * show") is a choice on "What's wrong?". A shift ("They're all off by one") belongs to the season's first question: the
 * season guard's "Which episodes are wrong?" when that remedy is on, else "What's wrong?".
 */
export function remapChoiceOn(
  where: 'reason' | 'episodes',
  kind: 'single' | 'shift' | null,
  remedies: Pick<GuideRemedies, 'season_guard'>,
): boolean {
  if (kind === null) return false;
  if (kind === 'single') return where === 'reason';
  return where === 'episodes' ? remedies.season_guard : !remedies.season_guard;
}

/** After "What's wrong?" with the re-map chosen, or a reason: the re-map step, else the reason's own next step. */
export function stepAfterChoice(choice: FixReasonName | 'remap', remedies: GuideRemedies): GuideStep {
  return choice === 'remap' ? 'remap' : stepAfterReason(choice, remedies);
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
  } else if (plan.kind === 'language') {
    if (plan.verdict !== 'ok') return lines;
    if (plan.grab) {
      lines.push({
        key: `block:${plan.grab.grabId}`,
        text: `${plan.grab.sourceTitle ?? 'The download it came from'} is blocked, so it is not downloaded again.`,
      });
    }
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

export type GuideRefusal = 'same_release' | 'no_replacement' | 'nothing_safe' | 'no_language_release';

/** When the preview itself is the answer: the Fix would refuse, so the guide offers no confirm (D-09). */
export function refusalFor(plan: GuidePlan | null, remedies: GuideRemedies): GuideRefusal | null {
  if (!plan) return null;
  if (plan.kind === 'delete' && plan.file && remedies.replacement_preview) {
    if (plan.replacement.verdict === 'same_release') return 'same_release';
    if (plan.replacement.verdict === 'no_replacement') return 'no_replacement';
  }
  if (plan.kind === 'season' && !plan.actionable) return 'nothing_safe';
  if (plan.kind === 'language' && plan.verdict !== 'ok') return 'no_language_release';
  return null;
}

/** The confirm button names the action (D-01). */
export function confirmLabelFor(plan: GuidePlan | null): string {
  if (!plan) return 'Submit fix';
  if (plan.kind === 'blocklist') return 'Block it and search again';
  if (plan.kind === 'delete') return plan.file ? 'Delete it and search again' : 'Search again';
  if (plan.kind === 'language') return `Replace it with the ${plan.wanted.name} release`;
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
