// ADR-111 C-02, C-04 / DESIGN-055 D-10, D-11 (PLAN-077 P3) — the client side of a Seerr report: which guide a report
// opens (the D-10 routing table), and the words the title page and the admin list use for it. Pure (unit-tested);
// lib/ never imports @hnet/domain, so the shapes are the tRPC outputs'.
import type { ActionTarget, ArrKindName, FixReasonName } from './media';

/** Seerr's issue types, in Seerr's numbering. */
export type SeerrIssueTypeNumber = 1 | 2 | 3 | 4;

export const SEERR_ISSUE_TYPE_WORDS: Record<SeerrIssueTypeNumber, string> = {
  1: 'Video',
  2: 'Audio',
  3: 'Subtitles',
  4: 'Other',
};

/** Where people report problems (Seerr's own issue pages). */
export const SEERR_URL = 'https://overseerr.haynesnetwork.com';
/** A Seerr issue's own page. */
export const seerrIssueUrl = (seerrIssueId: number) => `${SEERR_URL}/issues/${seerrIssueId}`;
/** D-11 — the stable fix-it-yourself link, relative (the page builds the absolute one from its origin). */
export const seerrLinkPath = (seerrIssueId: number) => `/r/seerr/${seerrIssueId}`;

/** A report as the routing reads it (the `seerrIssues.forItem` row). */
export interface GuideEntryIssue {
  issueType: SeerrIssueTypeNumber;
  mediaType: 'movie' | 'tv' | null;
  problemSeason: number;
  problemEpisode: number;
  targetChildId: number | null;
}

/** The title as the routing reads it. */
export interface GuideEntryItem {
  arrKind: ArrKindName | string;
  title: string;
  onDiskFileCount: number;
}

/** One live episode (`ledger.children`). */
export interface GuideEntryChild {
  arrChildId: number;
  label: string;
  hasFile: boolean;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** Which dialog a report opens, on what, and with which reason preselected. */
export interface SeerrGuideEntry {
  mode: 'fix' | 'search';
  target: ActionTarget | null;
  reason: FixReasonName | null;
  /** The grain qualifier on the banner's action ("S02E06", "Season 2", "Whole show"); null for a movie. */
  scopeLabel: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The reason a report's type points at: Audio is Wrong language, Subtitles is Missing subtitles. */
export function reasonForIssueType(type: SeerrIssueTypeNumber): FixReasonName | null {
  if (type === 2) return 'wrong_language';
  if (type === 3) return 'missing_subtitles';
  return null;
}

/**
 * DESIGN-055 D-10 routing — the guide a report opens:
 *   • a movie or an episode with no file: Force Search on it (a fix needs a file to fix);
 *   • with a file: Fix on it, the reason preselected by type (Video and Other ask "What's wrong?");
 *   • a whole season: Fix on the season when anything in it is on disk, else Force Search on the season;
 *   • a whole show: Fix with the episode picker when anything is on disk, else Force Search on the whole show.
 * Null while the episodes are still loading, and for a kind Seerr never reports (music).
 */
export function seerrGuideEntry(
  issue: GuideEntryIssue,
  item: GuideEntryItem,
  children: readonly GuideEntryChild[] | null,
): SeerrGuideEntry | null {
  const reason = reasonForIssueType(issue.issueType);
  if (item.arrKind === 'radarr') {
    return item.onDiskFileCount > 0
      ? { mode: 'fix', target: null, reason, scopeLabel: null }
      : { mode: 'search', target: null, reason: null, scopeLabel: null };
  }
  if (item.arrKind !== 'sonarr') return null;
  if (children === null) return null;

  const season = issue.problemSeason;
  const episode = issue.problemEpisode;
  if (season > 0 && episode > 0) {
    const child =
      children.find((c) => issue.targetChildId !== null && c.arrChildId === issue.targetChildId) ??
      children.find((c) => c.seasonNumber === season && c.episodeNumber === episode);
    if (child) {
      const code = `S${pad2(season)}E${pad2(episode)}`;
      const target: ActionTarget = { scope: 'episode', childId: child.arrChildId, label: child.label };
      return child.hasFile
        ? { mode: 'fix', target, reason, scopeLabel: code }
        : { mode: 'search', target, reason: null, scopeLabel: code };
    }
    // The episode is not in the manager (yet): the season is the nearest grain.
  }
  if (season > 0) {
    const inSeason = children.filter((c) => c.seasonNumber === season);
    if (inSeason.length > 0) {
      const label = `Season ${season}`;
      const target: ActionTarget = { scope: 'season', seasonNumber: season, label };
      return inSeason.some((c) => c.hasFile)
        ? { mode: 'fix', target, reason, scopeLabel: label }
        : { mode: 'search', target, reason: null, scopeLabel: label };
    }
  }
  return children.some((c) => c.hasFile)
    ? { mode: 'fix', target: null, reason, scopeLabel: null }
    : { mode: 'search', target: { scope: 'show', label: item.title }, reason: null, scopeLabel: 'Whole show' };
}

/** "S02E06", "Season 2" or null (the whole title), from Seerr's numbers. */
export function issueGrainLabel(issue: Pick<GuideEntryIssue, 'mediaType' | 'problemSeason' | 'problemEpisode'>): string | null {
  if (issue.mediaType === 'movie' || issue.problemSeason <= 0) return null;
  if (issue.problemEpisode <= 0) return `Season ${issue.problemSeason}`;
  return `S${pad2(issue.problemSeason)}E${pad2(issue.problemEpisode)}`;
}

/** The report's one-line kicker: "Video · S02E06", "Audio", "Other · Season 1". */
export function issueKicker(issue: Pick<GuideEntryIssue, 'issueType' | 'mediaType' | 'problemSeason' | 'problemEpisode'>): string {
  const grain = issueGrainLabel(issue);
  const type = SEERR_ISSUE_TYPE_WORDS[issue.issueType] ?? 'Other';
  return grain ? `${type} · ${grain}` : type;
}

/** D-11 — the note above the guide when a report opened it. */
export function guideIntroText(viewerIsReporter: boolean): string {
  return viewerIsReporter
    ? "You reported this in Seerr. Here's what you can try first."
    : "This was reported in Seerr. Here's what you can try first.";
}

/** The `?seerr=` param, when it is a Seerr issue id. */
export function parseSeerrParam(value: string | string[] | undefined | null): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}
