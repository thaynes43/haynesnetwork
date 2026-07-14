// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — THE common read-model CONTRACT: the normalized
// activity-item shape every per-source adapter implements. SLICE 1 ships the BOOKS adapter (LL + SAB); the
// *arr-queue and Kapowarr adapters (the fan-out) fill this SAME shape with NO change to the card, tab,
// chips, or detail page (DESIGN-030 D-08). Pure types — no I/O, no client — so it is safe to import
// everywhere (the aggregator, the API router, the card gallery fixtures).
import type { ActivityAction } from '@hnet/db';

/** The media families Activity spans (one per Library wall). */
export type ActivityKind = 'movie' | 'tv' | 'music' | 'book' | 'audiobook' | 'comic';

/** The user-facing app a stage came from (the badge attribution + the downstream deep-link target). */
export type ActivitySourceApp =
  | 'radarr'
  | 'sonarr'
  | 'lidarr'
  | 'lazylibrarian'
  | 'sabnzbd'
  | 'qbittorrent'
  | 'kapowarr';

/** The pipeline stage — the Activity chip + the wall in-flight badge switch on this. */
export type ActivityStage = 'searching' | 'downloading' | 'importing' | 'failed' | 'completed';

/** The failure class the UI + actions switch on (mirrors @hnet/db ACTIVITY_FAILURE_KINDS). */
export type ActivityFailureKind =
  | 'stranded_import'
  | 'postprocess_failed'
  | 'download_failed'
  | 'import_blocked';

/** The section that gates an item's VISIBILITY. 'books' gates the book walls; null = the universal *arr
 *  walls (no gate). A narrow union today; the *arr adapter adds no new value (they map to null). */
export type ActivitySection = 'books';

/** The Library wall an item belongs to (the wall-badge join key). */
export type ActivityWall = 'movies' | 'tv' | 'music' | 'books' | 'audiobooks' | 'comics';

/**
 * The normalized, source-agnostic activity item. `id` is the adapter-owned stable ref (also the failure
 * ledger's `source_ref`), so distinct items never collide. `href` is filled by the aggregator (a failure
 * links to its detail page once the ledger row id is known); adapters leave it null. `actions` is what an
 * ADMIN may do — the server re-gates each action per `activityActionProcedure`, so this is an affordance
 * hint, never the authority.
 */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  section: ActivitySection | null;
  wall: ActivityWall | null;
  title: string;
  year: number | null;
  sourceApp: ActivitySourceApp;
  stage: ActivityStage;
  /** 0..100 for `downloading`; null otherwise. */
  progress: number | null;
  failureReason: string | null;
  failureKind: ActivityFailureKind | null;
  /** ISO-8601 — when this stage was last observed (recency sort + staleness). */
  updatedAt: string;
  posterUrl: string | null;
  href: string | null;
  /** The downstream operator deep link (LL/SAB/*arr) — Admin-only in the UI; null when none. */
  downstreamUrl: string | null;
  actions: ActivityAction[];
}

/**
 * A per-source adapter — the fan-out seam. Each source family (books today; *arr + Kapowarr next) provides
 * a `source` family name (also the failure ledger's `source` column) and a `list()` returning normalized
 * items. `list()` reads LIVE (ADR-059 Q-01); a source that is unreachable (or unconfigured — a missing env)
 * MUST throw so the aggregator can degrade THAT source (an `unavailable` marker + the OTHER sources' items),
 * never the whole read. A source that merely returns [] is available-with-nothing-in-flight, NOT unavailable.
 * `label` is the human family name the aggregator surfaces on the degraded-source notice (falls back to
 * `source` when absent).
 */
export interface ActivitySourceAdapter {
  readonly source: string;
  readonly label?: string;
  list(): Promise<ActivityItem[]>;
}

/** The canonical stage order (chip order + recency tiebreak); `failed` first so strands lead. */
export const ACTIVITY_STAGES: readonly ActivityStage[] = [
  'failed',
  'importing',
  'downloading',
  'searching',
  'completed',
];

/** The canonical kind order (chip order). */
export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'movie',
  'tv',
  'music',
  'book',
  'audiobook',
  'comic',
];

/** Which stages an actionable failure carries (the badge is "actionable"). */
export function isFailureStage(stage: ActivityStage): boolean {
  return stage === 'failed';
}
