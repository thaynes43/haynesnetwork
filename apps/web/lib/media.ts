// Pure display helpers for the media ledger UI (DESIGN-005 D-17 surfaces). Kept
// framework-free for cheap unit tests (ADR-010 unit layer).

export type ArrKindName = 'sonarr' | 'radarr' | 'lidarr';

// media-hierarchy actions: the scope a Fix / Force Search targets. 'item' = the whole
// unit (radarr movie); 'episode'/'album' = a single child; 'season' = a sonarr season;
// 'show'/'artist' = the whole series / discography (Force-Search-only). Kept here so the
// detail view and both dialogs agree on the shape carried into the tRPC mutations.
export type ActionScope = 'item' | 'show' | 'season' | 'episode' | 'artist' | 'album';

export interface ActionTarget {
  scope: ActionScope;
  /** What the dialog names in its copy, e.g. 'S01E02 · Chapter 2' / 'Season 2' / a title. */
  label: string;
  /** Episode id (sonarr) / album id (lidarr) — for 'episode'/'album'. */
  childId?: number;
  /** Sonarr season number — for 'season'. */
  seasonNumber?: number;
}

/** The tRPC fix.create / fix.forceSearch scope fields for a chosen target (null ⇒ legacy default). */
export function targetToInput(target: ActionTarget | null): {
  scope?: ActionScope;
  targetChildId?: number;
  seasonNumber?: number;
} {
  if (target === null) return {};
  return {
    scope: target.scope,
    ...(target.childId !== undefined ? { targetChildId: target.childId } : {}),
    ...(target.seasonNumber !== undefined ? { seasonNumber: target.seasonNumber } : {}),
  };
}

/** Sonarr season display name — season 0 is Specials. */
export function seasonName(seasonNumber: number): string {
  return seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`;
}

export interface SeasonGroup {
  seasonNumber: number;
  episodes: SeasonEpisode[];
  onDiskCount: number;
  total: number;
}
export interface SeasonEpisode {
  arrChildId: number;
  label: string;
  hasFile: boolean;
}

/** Group the live sonarr episode list into season sections, ordered by season number. */
export function groupBySeason(
  children: { arrChildId: number; label: string; hasFile: boolean; seasonNumber: number | null }[],
): SeasonGroup[] {
  const bySeason = new Map<number, SeasonEpisode[]>();
  for (const child of children) {
    const season = child.seasonNumber ?? 0;
    const list = bySeason.get(season) ?? [];
    list.push({ arrChildId: child.arrChildId, label: child.label, hasFile: child.hasFile });
    bySeason.set(season, list);
  }
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, episodes]) => ({
      seasonNumber,
      episodes,
      onDiskCount: episodes.filter((e) => e.hasFile).length,
      total: episodes.length,
    }));
}

/** User-facing kind labels (the *arr names are plumbing, not UI copy). */
export const ARR_KIND_LABELS: Record<ArrKindName, string> = {
  sonarr: 'TV',
  radarr: 'Movie',
  lidarr: 'Music',
};

/** R-45 reason taxonomy labels (DDD-001 T-30 wording). */
export const FIX_REASON_LABELS: Record<string, string> = {
  wont_play_corrupt: "Won't play / corrupt",
  wrong_language: 'Wrong language',
  wrong_version_quality: 'Wrong version or quality',
  missing_subtitles: 'Missing subtitles',
  wrong_content: 'Wrong content entirely',
  other: 'Other',
};

/** Fix Lifecycle labels (DDD-001 T-43). */
export const FIX_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  actioned: 'Actioned',
  search_triggered: 'Search triggered',
  failed: 'Failed',
  completed: 'Completed',
};

export type BadgeTone = 'info' | 'ok' | 'warn' | 'danger' | 'muted';

/** Badge tone per fix status: terminal-good green, terminal-bad red, rest neutral. */
export function fixStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'danger';
    case 'search_triggered':
      return 'info';
    default:
      return 'muted';
  }
}

/** Ledger event type labels for the item timeline (D-07 normalized set). */
export const EVENT_TYPE_LABELS: Record<string, string> = {
  grabbed: 'Grabbed',
  imported: 'Imported',
  deleted: 'Deleted',
  download_failed: 'Download failed',
  requested: 'Requested',
  fix_requested: 'Fix requested',
  fix_actioned: 'Fix actioned',
  fix_completed: 'Fix completed',
  fix_failed: 'Fix failed',
  restored: 'Restored',
};

/** Human-readable size; ledger sizes come as bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export interface OnDiskSummary {
  label: string;
  tone: BadgeTone;
}

/**
 * One glanceable on-disk state per card: complete / partially on disk / missing —
 * with the wanted flag (T-27: monitored + nothing on disk) taking precedence for
 * the missing case.
 */
export function onDiskSummary(input: {
  onDiskFileCount: number;
  expectedFileCount: number;
  monitored: boolean;
}): OnDiskSummary {
  const { onDiskFileCount: onDisk, expectedFileCount: expected, monitored } = input;
  if (onDisk <= 0) {
    return monitored ? { label: 'Wanted', tone: 'warn' } : { label: 'Not on disk', tone: 'muted' };
  }
  if (expected > 0 && onDisk < expected) {
    return { label: `${onDisk}/${expected} on disk`, tone: 'info' };
  }
  return { label: expected > 1 ? `${onDisk}/${expected} on disk` : 'On disk', tone: 'ok' };
}

/** Compact local timestamp for timelines/tables (ISO in, locale out, minute precision). */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
