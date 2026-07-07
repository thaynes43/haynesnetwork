// ADR-023 / DESIGN-010 — the Trash section orchestrators over Maintainerr (the deletion system of
// record). Read-through pending (no mirror table), the preflight SAFETY audit, the confined
// exclusion/expedite/rules write surface, the cross-server watch guardian, and the recently-deleted
// + restore paths. The mutating Maintainerr surface (@hnet/arr/write) stays confined here (ADR-008
// guard). Music/Lidarr is NEVER a Trash target (R-87) — rejected at the orchestrator, not just UI.
import { ledgerEvents, mediaItems, mediaMetadata, type ArrKind, type DbClient } from '@hnet/db';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import {
  MaintainerrUnsafeError,
  MaintainerrUpstreamError,
  TrashMusicUnsupportedError,
} from './errors';
import { guardMaintainerrCall, type MaintainerrClientBundle } from './maintainerr-clients';
import { executeRestore, type ExecuteArrAddResult } from './restore-flow';

/** The Maintainerr-managed protective tag (addendum b): enabled on Radarr/Sonarr via the settings
 *  patch (a deploy step), Maintainerr stamps it when it excludes an item and removes it on
 *  un-exclude ("remove tag on un-exclude" ON). We READ it off the synced media_items.arrTags as
 *  the first-class "protected" signal — we never hand-apply it (it stays Maintainerr-managed). */
export const PROTECTED_TAG = 'dnd';

/** Addendum a — the cross-server watch guardian window. An item watched on ANY of the three Plex
 *  servers within this many days (media_metadata.last_viewed_at = cross-server MAX, PLAN-004) is
 *  auto-protected from deletion and flagged in the pending tables. A constant for now (Q-01:
 *  admin/per-role configurability is deferred — the plan says "else constant + Q"). */
export const RECENTLY_WATCHED_WINDOW_DAYS = 30;

/** The two media kinds Trash covers — Music (Lidarr) is structurally undeletable (R-87). */
export type TrashMedia = 'movie' | 'tv';

/** ADR-025 (Q-09) — the rolling per-kind "Leaving Soon" collection titles. Defined here (the shared
 *  Maintainerr read module) so the batch drive that CREATES them (trash-batches.ts) and the pending
 *  derivation that must never treat them as rule-collection sources agree on the exact name. */
export const LEAVING_SOON_COLLECTION_TITLES = {
  movie: 'Leaving Soon — Movies',
  tv: 'Leaving Soon — TV',
} as const;

/** True when a Maintainerr collection title is one of OUR manual Leaving-Soon collections. */
export function isLeavingSoonCollectionTitle(title: string | null | undefined): boolean {
  return (
    title === LEAVING_SOON_COLLECTION_TITLES.movie || title === LEAVING_SOON_COLLECTION_TITLES.tv
  );
}

/** Map a Trash media kind to the owning *arr (movie→radarr, tv→sonarr). */
export function arrKindForTrashMedia(media: TrashMedia): 'radarr' | 'sonarr' {
  return media === 'movie' ? 'radarr' : 'sonarr';
}

// ---------------------------------------------------------------------------
// Preflight safety audit (D4)
// ---------------------------------------------------------------------------

export interface MaintainerrIntegrations {
  plex: boolean;
  radarr: boolean;
  sonarr: boolean;
  tautulli: boolean;
  seerr: boolean;
}

export interface MaintainerrAudit {
  /** SAFE = reachable AND every required integration connected (the destructive-path gate). */
  safe: boolean;
  reachable: boolean;
  version: string | null;
  integrations: MaintainerrIntegrations;
  /** Active rule groups poised to schedule deletions (context for the owner — not a gate). */
  armedRules: number;
  /** Active collections currently holding pending-deletion items. */
  activeCollections: number;
}

/** The integrations that MUST be connected for a destructive Trash action to be SAFE (the plan's
 *  preflight requires all of Plex/Radarr/Sonarr/Tautulli/Seerr — the deletion + watch/keep signal
 *  chain). Tune here if the estate's required set changes. */
const REQUIRED_INTEGRATIONS: Array<keyof MaintainerrIntegrations> = [
  'plex',
  'radarr',
  'sonarr',
  'tautulli',
  'seerr',
];

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((n) => haystack.includes(n));

/**
 * ADR-023 D-04 — the read-only preflight audit. Writes NO state. Reachability + version come from
 * `GET /api/app/status`; Plex from `GET /api/settings/test/plex`; the other integrations from
 * `GET /api/rules/constants` (Maintainerr filters its `applications` list to CONFIGURED
 * integrations — the cleanest keyless connectivity signal); armed rules + active collections from
 * `GET /api/rules` + `GET /api/collections`. Each sub-read fails closed (unreachable ⇒ safe:false).
 */
export async function auditMaintainerr(input: {
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
}): Promise<MaintainerrAudit> {
  const read = input.maintainerr.read;

  let reachable = false;
  let version: string | null = null;
  try {
    const status = await read.getAppStatus();
    reachable = true;
    version = status.version ?? null;
  } catch {
    // Unreachable — nothing else can be trusted; fail closed.
    return {
      safe: false,
      reachable: false,
      version: null,
      integrations: { plex: false, radarr: false, sonarr: false, tautulli: false, seerr: false },
      armedRules: 0,
      activeCollections: 0,
    };
  }

  let plex = false;
  try {
    const test = await read.testPlex();
    plex = (test.status ?? '').toUpperCase() === 'OK';
  } catch {
    plex = false;
  }

  // Integration presence: the constants `applications` names are only present for CONFIGURED
  // integrations (Radarr/Sonarr/Tautulli/Seerr dropped if not set up — Maintainerr filters at
  // runtime). Match by lowercased application name.
  let radarr = false;
  let sonarr = false;
  let tautulli = false;
  let seerr = false;
  try {
    const constants = await read.getRuleConstants();
    const names = (constants.applications ?? []).map((a) => (a.name ?? '').toLowerCase());
    for (const n of names) {
      if (n.includes('radarr')) radarr = true;
      if (n.includes('sonarr')) sonarr = true;
      if (n.includes('tautulli')) tautulli = true;
      if (includesAny(n, ['overseerr', 'jellyseerr', 'seerr'])) seerr = true;
    }
  } catch {
    // Leave the integration flags false — fail closed.
  }

  let armedRules = 0;
  try {
    const rules = await read.getRules();
    armedRules = rules.filter((r) => r.isActive === true).length;
  } catch {
    armedRules = 0;
  }

  let activeCollections = 0;
  try {
    const collections = await read.getCollections();
    activeCollections = collections.filter((c) => c.isActive === true).length;
  } catch {
    activeCollections = 0;
  }

  const integrations: MaintainerrIntegrations = { plex, radarr, sonarr, tautulli, seerr };
  const safe = reachable && REQUIRED_INTEGRATIONS.every((k) => integrations[k]);
  return { safe, reachable, version, integrations, armedRules, activeCollections };
}

// ---------------------------------------------------------------------------
// Read-through pending list (D2) + recently-deleted (D2)
// ---------------------------------------------------------------------------

export interface TrashPendingItem {
  /** Maintainerr's item id (Plex ratingKey) — the exclusion/handle key. Null ⇒ can't be actioned. */
  maintainerrMediaId: string | null;
  collectionId: number;
  collectionTitle: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  sizeBytes: number;
  addedToCollectionAt: string | null;
  deleteAfterDays: number | null;
  /** ISO — addedToCollectionAt + deleteAfterDays; null when either input is missing. */
  scheduledDeleteAt: string | null;
  // Our ledger join (null when the item is unknown to our ledger — still listed).
  mediaItemId: string | null;
  title: string;
  year: number | null;
  arrKind: 'radarr' | 'sonarr' | null;
  arrTags: string[];
  /** arrTags includes the Maintainerr-managed protective tag (already safe from deletion). */
  protectedByTag: boolean;
  /** Live-repro fix (2026-07-06) — this item is currently on Maintainerr's exclusion (whitelist)
   *  list per a direct read, independent of whether the `dnd` tag has synced into arrTags yet. Only
   *  populated when listTrashPending is called with `includeLiveExclusions` (the pending TAB);
   *  false otherwise. The UI treats tag-OR-exclusion as Protected (closes the cross-session window
   *  where an exclusion made outside this session shows Unprotected until the tag round-trips). */
  protectedByExclusion: boolean;
  /** last_viewed_at (cross-server MAX) is within RECENTLY_WATCHED_WINDOW_DAYS — never delete. */
  recentlyWatched: boolean;
  lastViewedAt: string | null;
  requesters: string[];
  sourceCollections: string[];
  posterSource: string | null;
  // DESIGN-010 D-09 (UX pass, 2026-07-06) — the harvested facet fields the shared filter engine
  // chips over (genre/resolution/rating). Same media_metadata join the fields above ride; all
  // empty/null when the item is unknown to our ledger.
  genres: string[];
  resolution: string | null;
  imdbRating: number | null;
  tmdbRating: number | null;
}

export interface TrashPendingResult {
  items: TrashPendingItem[];
  totalSizeBytes: number;
  count: number;
}

/** Normalize a Maintainerr collection `type` (string 'movie'|'show'|… OR number 1..4) → our kind. */
function collectionMediaKind(type: unknown): 'movie' | 'tv' | null {
  if (typeof type === 'string') {
    const t = type.toLowerCase();
    if (t === 'movie') return 'movie';
    if (t === 'show' || t === 'tv' || t === 'season' || t === 'episode') return 'tv';
    return null;
  }
  if (typeof type === 'number') {
    if (type === 1) return 'movie';
    if (type === 2 || type === 3 || type === 4) return 'tv';
  }
  return null;
}

const asString = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined ? null : String(v);

interface FlatPending {
  collectionId: number;
  collectionTitle: string | null;
  deleteAfterDays: number | null;
  collectionKind: 'movie' | 'tv' | null;
  maintainerrMediaId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  sizeBytes: number;
  addDate: string | null;
}

/** Fetch every active collection's FULL membership (paged) with per-item size + ids. */
async function fetchMaintainerrPending(
  maintainerr: Pick<MaintainerrClientBundle, 'read'>,
): Promise<FlatPending[]> {
  const collections = await guardMaintainerrCall('maintainerr GET /collections', () =>
    maintainerr.read.getCollections(),
  );
  const out: FlatPending[] = [];
  const PAGE_SIZE = 50;
  for (const c of collections) {
    if (c.isActive !== true || c.id === null || c.id === undefined) continue;
    // OUR manually-driven Leaving-Soon collections are NOT rule-collection sources (ADR-025 C-04):
    // their members are the SAME physical media the rule collections already surface, so folding them
    // in would double-count sizes AND — worse — let the sweep re-derive an item's collectionId to the
    // Leaving-Soon collection, whose arrAction is DO_NOTHING → a per-item handle there deletes nothing.
    // Skip them (verified 2026-07-07: v3.17.0 GET /api/collections returns manual collections too).
    if (isLeavingSoonCollectionTitle(c.title)) continue;
    const collectionId = c.id;
    const collectionKind = collectionMediaKind(c.type);
    let page = 1;
    let seen = 0;
    // Page until we've collected the reported totalSize (bounded — household scale).
    for (;;) {
      const content = await guardMaintainerrCall(
        `maintainerr GET /collections/media/${collectionId}/content/${page}`,
        () => maintainerr.read.getCollectionContent(collectionId, page, PAGE_SIZE),
      );
      for (const m of content.items) {
        out.push({
          collectionId,
          collectionTitle: c.title ?? null,
          deleteAfterDays: c.deleteAfterDays ?? null,
          collectionKind,
          maintainerrMediaId: asString(m.mediaServerId ?? m.plexId ?? null),
          tmdbId: m.tmdbId ?? null,
          tvdbId: m.tvdbId ?? null,
          sizeBytes: m.sizeBytes ?? 0,
          addDate: m.addDate ?? null,
        });
      }
      seen += content.items.length;
      if (content.items.length === 0 || seen >= content.totalSize) break;
      page += 1;
    }
  }
  return out;
}

/** addDate + deleteAfterDays days → ISO, or null when either is missing/unparseable. */
function scheduledDeleteAt(addDate: string | null, deleteAfterDays: number | null): string | null {
  if (addDate === null || deleteAfterDays === null) return null;
  const base = Date.parse(addDate);
  if (Number.isNaN(base)) return null;
  return new Date(base + deleteAfterDays * 86_400_000).toISOString();
}

/**
 * ADR-023 / DESIGN-010 D-02 — the read-through pending list for one media kind (movie|tv, NEVER
 * combined; music rejected upstream at the router). Merges Maintainerr's collections+media with
 * our media_items/media_metadata by tmdbId (movie→radarr) / tvdbId (tv→sonarr): the join supplies
 * title/poster/facets, but an item unknown to our ledger is STILL listed with Maintainerr's own
 * fields. Returns per-item size + the aggregate total.
 */
export async function listTrashPending(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  media: TrashMedia;
  /** Window override for the recently-watched flag (default RECENTLY_WATCHED_WINDOW_DAYS). */
  watchWindowDays?: number;
  /**
   * Live-repro fix (2026-07-06) — when true, cross-check each pending item against Maintainerr's LIVE
   * exclusion list (per-item mediaServerId reads via fetchLiveExclusions — real Maintainerr answers
   * [] for a param-less exclusion GET, so there is no cheaper bulk read) and set `protectedByExclusion`.
   * The pending TAB passes this so an exclusion created OUTSIDE this session shows as Protected before
   * its `dnd` tag round-trips into arrTags. Left OFF for the internal expedite/guardian calls: they run
   * their own per-run authoritative fetchLiveExclusions and `classifyGuardian` never reads this flag, so
   * those paths are unchanged and pay no extra exclusion reads.
   */
  includeLiveExclusions?: boolean;
}): Promise<TrashPendingResult> {
  const db = resolveDb(input.db);
  const arrKind = arrKindForTrashMedia(input.media);
  const windowMs = (input.watchWindowDays ?? RECENTLY_WATCHED_WINDOW_DAYS) * 86_400_000;
  const now = Date.now();

  const flat = await fetchMaintainerrPending(input.maintainerr);
  // Bucket by requested media: prefer the collection's declared kind; fall back to which external
  // id the item carries (movie→tmdbId, tv→tvdbId).
  const forMedia = flat.filter((f) => {
    if (f.collectionKind !== null) return f.collectionKind === input.media;
    return input.media === 'movie' ? f.tmdbId !== null : f.tvdbId !== null;
  });

  // Live-repro fix (2026-07-06) — optionally OR in Maintainerr's LIVE exclusion set so a whitelist
  // made outside this session is reflected as Protected before its `dnd` tag syncs into arrTags.
  const liveExcludedIds = input.includeLiveExclusions
    ? await fetchLiveExclusions(input.maintainerr, [
        ...new Set(
          forMedia.map((f) => f.maintainerrMediaId).filter((id): id is string => id !== null),
        ),
      ])
    : new Set<string>();

  // Gather the external ids to join our ledger on.
  const ids = new Set<number>();
  for (const f of forMedia) {
    const ext = input.media === 'movie' ? f.tmdbId : f.tvdbId;
    if (ext !== null) ids.add(ext);
  }

  interface LedgerJoin {
    mediaItemId: string;
    title: string;
    year: number | null;
    arrTags: string[];
    posterSource: string | null;
    lastViewedAt: Date | null;
    requesters: string[];
    sourceCollections: string[];
    genres: string[];
    resolution: string | null;
    imdbRating: number | null;
    tmdbRating: number | null;
  }
  /** Drizzle numeric columns arrive as strings — normalize to number|null for the wire. */
  const numOrNull = (v: string | null | undefined): number | null =>
    v === null || v === undefined ? null : Number(v);
  const byExtId = new Map<number, LedgerJoin>();
  if (ids.size > 0) {
    const extCol = input.media === 'movie' ? mediaItems.tmdbId : mediaItems.tvdbId;
    const rows = await db
      .select({
        extId: extCol,
        mediaItemId: mediaItems.id,
        title: mediaItems.title,
        year: mediaItems.year,
        arrTags: mediaItems.arrTags,
        posterSource: mediaMetadata.posterSource,
        lastViewedAt: mediaMetadata.lastViewedAt,
        requesters: mediaMetadata.requesters,
        sourceCollections: mediaMetadata.sourceCollections,
        genres: mediaMetadata.genres,
        resolution: mediaMetadata.resolution,
        imdbRating: mediaMetadata.imdbRating,
        tmdbRating: mediaMetadata.tmdbRating,
      })
      .from(mediaItems)
      .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
      .where(and(eq(mediaItems.arrKind, arrKind), inArray(extCol, [...ids])));
    for (const r of rows) {
      if (r.extId === null) continue;
      byExtId.set(r.extId, {
        mediaItemId: r.mediaItemId,
        title: r.title,
        year: r.year,
        arrTags: r.arrTags ?? [],
        posterSource: r.posterSource,
        lastViewedAt: r.lastViewedAt,
        requesters: r.requesters ?? [],
        sourceCollections: r.sourceCollections ?? [],
        genres: r.genres ?? [],
        resolution: r.resolution ?? null,
        imdbRating: numOrNull(r.imdbRating),
        tmdbRating: numOrNull(r.tmdbRating),
      });
    }
  }

  let totalSizeBytes = 0;
  const items: TrashPendingItem[] = forMedia.map((f) => {
    const ext = input.media === 'movie' ? f.tmdbId : f.tvdbId;
    const joined = ext !== null ? byExtId.get(ext) : undefined;
    totalSizeBytes += f.sizeBytes;
    const arrTags = joined?.arrTags ?? [];
    const lastViewed = joined?.lastViewedAt ?? null;
    const recentlyWatched = lastViewed !== null && now - lastViewed.getTime() <= windowMs;
    return {
      maintainerrMediaId: f.maintainerrMediaId,
      collectionId: f.collectionId,
      collectionTitle: f.collectionTitle,
      tmdbId: f.tmdbId,
      tvdbId: f.tvdbId,
      sizeBytes: f.sizeBytes,
      addedToCollectionAt: f.addDate,
      deleteAfterDays: f.deleteAfterDays,
      scheduledDeleteAt: scheduledDeleteAt(f.addDate, f.deleteAfterDays),
      mediaItemId: joined?.mediaItemId ?? null,
      title:
        joined?.title ??
        `tmdb:${f.tmdbId ?? ''}${f.tvdbId !== null ? ` tvdb:${f.tvdbId}` : ''}`.trim(),
      year: joined?.year ?? null,
      arrKind: joined ? arrKind : null,
      arrTags,
      protectedByTag: arrTags.includes(PROTECTED_TAG),
      protectedByExclusion:
        f.maintainerrMediaId !== null && liveExcludedIds.has(f.maintainerrMediaId),
      recentlyWatched,
      lastViewedAt: lastViewed === null ? null : lastViewed.toISOString(),
      requesters: joined?.requesters ?? [],
      sourceCollections: joined?.sourceCollections ?? [],
      posterSource: joined?.posterSource ?? null,
      genres: joined?.genres ?? [],
      resolution: joined?.resolution ?? null,
      imdbRating: joined?.imdbRating ?? null,
      tmdbRating: joined?.tmdbRating ?? null,
    };
  });

  return { items, totalSizeBytes, count: items.length };
}

export interface RecentlyDeletedItem {
  mediaItemId: string;
  title: string;
  year: number | null;
  arrKind: ArrKind;
  tmdbId: number | null;
  tvdbId: number | null;
  sizeOnDisk: number;
  deletedAt: string | null;
  posterSource: string | null;
}

/**
 * ADR-023 / DESIGN-010 D-02 — Recently-Deleted from OUR ledger: tombstoned media_items
 * (deleted_from_arr_at set, T-41) of the requested kind, newest tombstone first. This is the
 * durable, restore-able set (Maintainerr exposes no deletion-history API); Restore re-adds via the
 * existing executeRestore path.
 */
export async function listRecentlyDeleted(input: {
  db?: DbClient;
  media: TrashMedia;
  limit?: number;
}): Promise<RecentlyDeletedItem[]> {
  const db = resolveDb(input.db);
  const arrKind = arrKindForTrashMedia(input.media);
  const rows = await db
    .select({
      mediaItemId: mediaItems.id,
      title: mediaItems.title,
      year: mediaItems.year,
      arrKind: mediaItems.arrKind,
      tmdbId: mediaItems.tmdbId,
      tvdbId: mediaItems.tvdbId,
      sizeOnDisk: mediaItems.sizeOnDisk,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
      posterSource: mediaMetadata.posterSource,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(and(eq(mediaItems.arrKind, arrKind), isNotNull(mediaItems.deletedFromArrAt)))
    .orderBy(desc(mediaItems.deletedFromArrAt))
    .limit(input.limit ?? 100);
  return rows.map((r) => ({
    mediaItemId: r.mediaItemId,
    title: r.title,
    year: r.year,
    arrKind: r.arrKind,
    tmdbId: r.tmdbId,
    tvdbId: r.tvdbId,
    sizeOnDisk: r.sizeOnDisk,
    deletedAt: r.deletedFromArrAt === null ? null : r.deletedFromArrAt.toISOString(),
    posterSource: r.posterSource,
  }));
}

// ---------------------------------------------------------------------------
// Exclusion writes (D5 — protective ordering) + the dnd/watch guardian (D6)
// ---------------------------------------------------------------------------

const nowDate = () => new Date();

/**
 * ADR-023 / DESIGN-010 D-05 — Save/whitelist an item so Maintainerr never deletes it. Ordering
 * decision (documented): a Save is PROTECTIVE, so the fail-safe direction is establish-protection
 * FIRST (the external Maintainerr addExclusion), THEN write the `trash_excluded` ledger event —
 * the OPPOSITE of the destructive Fix D-09 discipline. A crash after the exclusion but before the
 * event leaves the item GENUINELY protected (only the audit missing — reconcilable from
 * Maintainerr's exclusion list); a phantom "excluded" event (written before a failed call) would
 * be the dangerous under-protection failure, so we never write the event first. Idempotent: if
 * Maintainerr already excludes the item, no-op and no event. Only reachability is required (no
 * integration-health gate — that gates the DESTRUCTIVE paths).
 */
export interface SaveExclusionInput {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  /** Maintainerr's item id (Plex ratingKey) — the exclusion key. */
  maintainerrMediaId: string;
  /** Our ledger id, when the item is known (for event attribution). */
  mediaItemId?: string | null;
  /** Scope to a collection's rule group; omit for a GLOBAL exclusion (recommended for a save). */
  collectionId?: number;
  actorId: string | null;
  /** Attribution note for the ledger payload (e.g. 'user' | 'watch_guardian'). */
  reason?: string;
}

export async function saveExclusion(
  input: SaveExclusionInput,
): Promise<{ excluded: boolean; alreadyExcluded: boolean }> {
  // Idempotency: is the item already excluded? (Maintainerr returns [] with no params, so query
  // by the item's mediaServerId.)
  const existing = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
    input.maintainerr.read.getExclusions({ mediaServerId: input.maintainerrMediaId }),
  );
  if (existing.length > 0) {
    return { excluded: false, alreadyExcluded: true };
  }

  // 1) Establish the protective state FIRST (external).
  await guardMaintainerrCall('maintainerr POST /rules/exclusion', () =>
    input.maintainerr.write.addExclusion(input.maintainerrMediaId, input.collectionId),
  );

  // 2) Then record the durable audit event (source 'maintainerr').
  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: input.mediaItemId ?? null,
      eventType: 'trash_excluded',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: {
        action: 'save',
        maintainerrMediaId: input.maintainerrMediaId,
        ...(input.collectionId !== undefined ? { collectionId: input.collectionId } : {}),
        reason: input.reason ?? 'user',
      },
    });
  });

  return { excluded: true, alreadyExcluded: false };
}

/**
 * ADR-023 / DESIGN-010 D-05 — un-save: remove the item's Maintainerr exclusion(s). Symmetric to
 * saveExclusion — external removal FIRST, then the `trash_excluded` (action 'unsave') audit event.
 * Idempotent: nothing excluded ⇒ no-op, no event.
 */
export async function removeExclusion(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  maintainerrMediaId: string;
  mediaItemId?: string | null;
  actorId: string | null;
}): Promise<{ removed: boolean }> {
  const existing = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
    input.maintainerr.read.getExclusions({ mediaServerId: input.maintainerrMediaId }),
  );
  if (existing.length === 0) {
    return { removed: false };
  }

  await guardMaintainerrCall('maintainerr DELETE /rules/exclusions', () =>
    input.maintainerr.write.removeExclusion(input.maintainerrMediaId),
  );

  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: input.mediaItemId ?? null,
      eventType: 'trash_excluded',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: { action: 'unsave', maintainerrMediaId: input.maintainerrMediaId },
    });
  });

  return { removed: true };
}

/**
 * Why an item is kept out of a deletion. `tag` ⇒ already whitelisted by the Maintainerr-managed
 * `dnd` tag; `recently_watched`/`requested` ⇒ the watch/requester guardian (auto-whitelist);
 * `unevaluable` ⇒ FAIL-CLOSED: the item is not resolved to our ledger, so we have NO cross-server
 * watch / requester signal to positively clear it (P4) — we never delete what we cannot evaluate.
 */
export type GuardianKeepReason = 'tag' | 'recently_watched' | 'requested' | 'unevaluable';
export type GuardianVerdict = { keep: true; reason: GuardianKeepReason } | { keep: false };

/**
 * The guardian's per-item verdict (P4 — fail closed). An item is expeditable ONLY when it is
 * positively evaluated (resolved to our ledger) AND cold (not tag-protected, not recently watched,
 * no requester). Anything we cannot positively clear — including an item unknown to our ledger — is
 * KEPT. The `media`-param bypass (P3) is defeated by callers running this over the item's REAL
 * pending identity, never a client-declared kind.
 */
export function classifyGuardian(item: TrashPendingItem): GuardianVerdict {
  if (item.protectedByTag) return { keep: true, reason: 'tag' };
  if (item.recentlyWatched) return { keep: true, reason: 'recently_watched' };
  if (item.requesters.length > 0) return { keep: true, reason: 'requested' };
  // Fail closed: no ledger resolution ⇒ no watch/requester data ⇒ we cannot confirm it is safe.
  if (item.mediaItemId === null) return { keep: true, reason: 'unevaluable' };
  return { keep: false };
}

/**
 * Addendum a — the cross-server watch guardian. Given the pending set for a media kind, auto-protect
 * (whitelist in Maintainerr) every item watched on ANY server within the window that is not already
 * protected, BEFORE any expedite. Returns the protected + surviving (expeditable) partitions. Each
 * protection records a `trash_excluded` (reason 'watch_guardian') event. Items with no Maintainerr id
 * (unactionable) or that the guardian cannot positively evaluate are kept out of the expeditable set
 * (fail closed, P4). NOTE this returns only ids; `expediteDeletion` scope 'all' runs the richer
 * per-item loop directly (it needs each survivor's collectionId for `handleCollectionMedia`).
 */
export async function guardRecentlyWatched(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  media: TrashMedia;
  actorId: string | null;
  watchWindowDays?: number;
}): Promise<{ protectedCount: number; protectedIds: string[]; expeditableIds: string[] }> {
  const pending = await listTrashPending({
    db: input.db,
    maintainerr: input.maintainerr,
    media: input.media,
    watchWindowDays: input.watchWindowDays,
  });
  const protectedIds: string[] = [];
  const expeditableIds: string[] = [];
  for (const item of pending.items) {
    if (item.maintainerrMediaId === null) continue;
    const verdict = classifyGuardian(item);
    if (verdict.keep) {
      if (verdict.reason === 'recently_watched' || verdict.reason === 'requested') {
        const res = await saveExclusion({
          db: input.db,
          maintainerr: input.maintainerr,
          maintainerrMediaId: item.maintainerrMediaId,
          mediaItemId: item.mediaItemId,
          actorId: input.actorId,
          reason: 'watch_guardian',
        });
        if (res.excluded || res.alreadyExcluded) protectedIds.push(item.maintainerrMediaId);
      } else {
        // tag-protected (already whitelisted) or unevaluable (kept, not force-whitelisted).
        protectedIds.push(item.maintainerrMediaId);
      }
    } else {
      expeditableIds.push(item.maintainerrMediaId);
    }
  }
  return { protectedCount: protectedIds.length, protectedIds, expeditableIds };
}

/**
 * Resolve a pending item to its REAL identity + media kind by scanning the actual Maintainerr
 * pending sets (both movie and tv), NOT trusting any client-declared `media` param (P3). Returns the
 * merged pending row (which carries the true collectionId, arrKind, watch/requester facets the
 * guardian needs) or null when the item is not present in ANY pending set. At household scale
 * (currently zero collections) the two-kind scan is negligible.
 */
async function resolvePendingTarget(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  maintainerrMediaId: string;
  collectionId?: number;
  watchWindowDays?: number;
}): Promise<{ item: TrashPendingItem; media: TrashMedia } | null> {
  for (const media of ['movie', 'tv'] as const) {
    const pending = await listTrashPending({
      db: input.db,
      maintainerr: input.maintainerr,
      media,
      watchWindowDays: input.watchWindowDays,
    });
    const item = pending.items.find(
      (p) =>
        p.maintainerrMediaId === input.maintainerrMediaId &&
        (input.collectionId === undefined || p.collectionId === input.collectionId),
    );
    if (item) return { item, media };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Expedite (destructive — D5 intent-first ordering) + rules + restore
// ---------------------------------------------------------------------------

/**
 * ADR-023 / DESIGN-010 D-04/D-05 — expedite deletion (DESTRUCTIVE). Every call re-runs the preflight
 * audit and refuses (MaintainerrUnsafeError → PRECONDITION_FAILED) unless SAFE.
 *
 * P1b/P5 (dated ruling 2026-07-06, Fable): Maintainerr's `POST /collections/handle` processes EVERY
 * active collection (all media kinds, incl. items outside our ledger) and is NOT scopeable — so
 * expedite NEVER calls it. Both scopes delete PER ITEM via `POST /collections/media/handle`, guarded
 * individually. This keeps deletion scoped to exactly the media kind / set the user saw and
 * guarantees every deleted item passed the guardian.
 *
 * F1 (2026-07-06 review) — BOTH scopes first consult the LIVE Maintainerr exclusion set
 * (`fetchLiveExclusions`) and treat a currently-excluded item as PROTECTED, closing the window where
 * a just-SAVED item's `dnd` tag has not yet synced to `classifyGuardian`'s inputs. F2 — scope 'all'
 * is pinned to `snapshotMediaIds` (the set the user saw); only its intersection with the current
 * pending set is processed (stale ids → `stalePending`; newly-pending items are never touched).
 *
 * scope 'item' — resolve the target's REAL identity from the actual pending set (NOT the client
 * `media` param, P3); if it cannot be resolved to run the guardian, REFUSE (don't fail open). scope
 * 'all' — a two-pass loop over the (pinned) pending targets: PASS 1 runs the guardian over each
 * item (auto-whitelisting watched/requested; a failed protection SKIPS the item, never deletes it —
 * P4/P5); PASS 2 deletes each SURVIVOR individually, committing the `trash_expedited` intent event
 * BEFORE its handle call (the Fix D-09 destructive-ordering discipline). Music/Lidarr is rejected
 * upstream at the router (media is movie|tv only, R-87).
 */
export interface ExpediteDeletionInput {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  scope: 'item' | 'all';
  media: TrashMedia;
  actorId: string | null;
  watchWindowDays?: number;
  /** scope 'item' — the target. */
  item?: {
    collectionId: number;
    maintainerrMediaId: string;
    mediaItemId?: string | null;
  };
  /**
   * F2 (2026-07-06 pre-ship review) — scope 'all' ONLY: the maintainerrMediaId snapshot the user
   * actually SAW in the confirm modal. The run processes EXACTLY the intersection of this list with
   * the CURRENT pending set: ids no longer pending are counted `stalePending` (never deleted), and
   * items that became pending AFTER the snapshot are NEVER touched (the user never consented to
   * them). Omit for the legacy/internal whole-set behaviour (process the entire current pending set).
   */
  snapshotMediaIds?: string[];
}

export interface ExpediteDeletionResult {
  scope: 'item' | 'all';
  /** items kept by the guardian (whitelisted / already tag-protected / LIVE-excluded) instead of
   *  deleted. */
  protectedCount: number;
  /** items handed to Maintainerr's per-item handler (each passed the guardian). */
  expeditedCount: number;
  /** items NOT deleted because the guardian could not clear them: unevaluable (unknown to our
   *  ledger), unactionable (no Maintainerr id), or a failed protection write. Never deleted. */
  skippedCount: number;
  /** F2 — scope 'all': snapshot ids that were no longer pending at run time (the pending set moved
   *  under the user). Not deleted, not an error — just no longer applicable. Always 0 for scope 'item'
   *  and for an unpinned 'all' run. */
  stalePending: number;
}

/**
 * F1 (2026-07-06 pre-ship review) — the LIVE-exclusion safety seam. `classifyGuardian` reads only
 * the SYNCED facets (arrTags/watched/requesters); a just-SAVED item's protective `dnd` tag has not
 * yet round-tripped Maintainerr → the *arr → our ledger, so the guardian would (wrongly) clear a
 * freshly-saved cold item as deletable — the save→expedite race the review found. Before any
 * expedite deletes anything we therefore ask Maintainerr DIRECTLY whether each candidate is
 * currently excluded (whitelisted) and treat a live exclusion as PROTECTED — never handled.
 *
 * Gathered ONCE per run (before the guardian loop). Real Maintainerr returns [] for `getExclusions`
 * with no params, so we query per candidate by mediaServerId — bounded by the (household-scale)
 * candidate set. Read-only; failures fail closed via guardMaintainerrCall like every other call.
 */
async function fetchLiveExclusions(
  maintainerr: Pick<MaintainerrClientBundle, 'read'>,
  ids: readonly string[],
): Promise<Set<string>> {
  const excluded = new Set<string>();
  for (const id of ids) {
    const rows = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
      maintainerr.read.getExclusions({ mediaServerId: id }),
    );
    if (rows.length > 0) excluded.add(id);
  }
  return excluded;
}

/** Commit the `trash_expedited` intent event for one item, THEN trigger its per-item handle. The
 *  intent is durable before the (lost-response-prone) destructive call — Fix D-09 discipline. */
async function expediteOneSurvivor(
  input: Pick<ExpediteDeletionInput, 'db' | 'maintainerr' | 'actorId'>,
  scope: 'item' | 'all',
  survivor: { collectionId: number; maintainerrMediaId: string; mediaItemId: string | null },
): Promise<void> {
  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: survivor.mediaItemId,
      eventType: 'trash_expedited',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: {
        scope,
        collectionId: survivor.collectionId,
        maintainerrMediaId: survivor.maintainerrMediaId,
      },
    });
  });
  await guardMaintainerrCall('maintainerr POST /collections/media/handle', () =>
    input.maintainerr.write.handleCollectionMedia(
      survivor.collectionId,
      survivor.maintainerrMediaId,
    ),
  );
}

export async function expediteDeletion(
  input: ExpediteDeletionInput,
): Promise<ExpediteDeletionResult> {
  // Preflight SAFETY gate — destructive paths refuse on an unsafe install (fail closed).
  const audit = await auditMaintainerr({ maintainerr: input.maintainerr });
  if (!audit.safe) {
    throw new MaintainerrUnsafeError(
      `Maintainerr is not in a safe state to expedite deletions (reachable=${audit.reachable}, ` +
        `integrations ${JSON.stringify(audit.integrations)}). Refusing.`,
      {
        integrations: audit.integrations as unknown as Record<string, boolean>,
        reachable: audit.reachable,
      },
    );
  }

  if (input.scope === 'item') {
    const item = input.item;
    if (!item) throw new Error('expediteDeletion scope "item" requires an item target');
    // P3 — resolve the target's REAL identity from the actual pending set; the client `media` param
    // never steers the guardian. Unresolvable ⇒ REFUSE, never fail open.
    const resolved = await resolvePendingTarget({
      db: input.db,
      maintainerr: input.maintainerr,
      maintainerrMediaId: item.maintainerrMediaId,
      collectionId: item.collectionId,
      watchWindowDays: input.watchWindowDays,
    });
    if (!resolved) {
      throw new MaintainerrUnsafeError(
        `Cannot resolve pending item ${item.maintainerrMediaId} in any Maintainerr collection to ` +
          `run the deletion guardian. Refusing to expedite (fail closed).`,
        { reachable: true },
      );
    }
    const target = resolved.item;
    // target.maintainerrMediaId is guaranteed non-null (we matched on it above).
    const targetMediaId = target.maintainerrMediaId as string;
    // F1 — a LIVE Maintainerr exclusion protects the item even if its dnd tag hasn't synced yet.
    // Checked BEFORE the guardian so a just-saved cold item is never handled (closes the race).
    const liveExcluded = await fetchLiveExclusions(input.maintainerr, [targetMediaId]);
    if (liveExcluded.has(targetMediaId)) {
      return { scope: 'item', protectedCount: 1, expeditedCount: 0, skippedCount: 0, stalePending: 0 };
    }
    const verdict = classifyGuardian(target);
    if (verdict.keep) {
      // Watched/requested ⇒ auto-whitelist; tag ⇒ already protected; unevaluable ⇒ keep (fail closed).
      if (verdict.reason === 'recently_watched' || verdict.reason === 'requested') {
        await saveExclusion({
          db: input.db,
          maintainerr: input.maintainerr,
          maintainerrMediaId: targetMediaId,
          mediaItemId: target.mediaItemId,
          actorId: input.actorId,
          reason: 'watch_guardian',
        });
        return { scope: 'item', protectedCount: 1, expeditedCount: 0, skippedCount: 0, stalePending: 0 };
      }
      if (verdict.reason === 'tag') {
        return { scope: 'item', protectedCount: 1, expeditedCount: 0, skippedCount: 0, stalePending: 0 };
      }
      // unevaluable — not deleted, not force-whitelisted.
      return { scope: 'item', protectedCount: 0, expeditedCount: 0, skippedCount: 1, stalePending: 0 };
    }

    // Cold + positively evaluated ⇒ delete this one item (intent-first). Use the RESOLVED
    // collectionId, not the client's (defence in depth against a mismatched request).
    await expediteOneSurvivor(input, 'item', {
      collectionId: target.collectionId,
      maintainerrMediaId: targetMediaId,
      mediaItemId: target.mediaItemId,
    });
    return { scope: 'item', protectedCount: 0, expeditedCount: 1, skippedCount: 0, stalePending: 0 };
  }

  // scope 'all' — per-item loop over the REQUESTED kind's pending set (never /collections/handle).
  const pending = await listTrashPending({
    db: input.db,
    maintainerr: input.maintainerr,
    media: input.media,
    watchWindowDays: input.watchWindowDays,
  });

  // F2 — pin to the snapshot the user SAW. Only actionable pending items are eligible; when a
  // snapshot is supplied the eligible set is narrowed to its intersection with the current pending
  // set. Snapshot ids no longer pending are counted `stalePending`; items that became pending after
  // the snapshot are absent from `targets` and thus NEVER touched. Unpinned (snapshot === null) is
  // the legacy whole-set behaviour: every actionable pending item is a target; unactionable (no
  // Maintainerr id) items are counted skipped exactly as before.
  const snapshot = input.snapshotMediaIds === undefined ? null : new Set(input.snapshotMediaIds);
  const actionable = pending.items.filter(
    (p): p is TrashPendingItem & { maintainerrMediaId: string } => p.maintainerrMediaId !== null,
  );
  let stalePending = 0;
  if (snapshot !== null) {
    const pendingIds = new Set(actionable.map((p) => p.maintainerrMediaId));
    for (const id of snapshot) if (!pendingIds.has(id)) stalePending += 1;
  }
  const targets =
    snapshot === null
      ? actionable
      : actionable.filter((p) => snapshot.has(p.maintainerrMediaId));

  // F1 — live-exclusion safety seam: fetch which targets are currently excluded (whitelisted) ONCE,
  // before the guardian loop, and treat any live exclusion as PROTECTED (never handled).
  const excludedIds = await fetchLiveExclusions(
    input.maintainerr,
    targets.map((p) => p.maintainerrMediaId),
  );

  // PASS 1 — guardian: whitelist watched/requested, skip anything we can't positively clear.
  const survivors: Array<{
    collectionId: number;
    maintainerrMediaId: string;
    mediaItemId: string | null;
  }> = [];
  let protectedCount = 0;
  // Legacy (unpinned) parity: unactionable items still count as skipped. When pinned they are simply
  // not targets (never in the snapshot) and are left untouched, uncounted.
  let skippedCount =
    snapshot === null ? pending.items.filter((p) => p.maintainerrMediaId === null).length : 0;
  for (const p of targets) {
    const mediaId = p.maintainerrMediaId;
    // F1 — a LIVE exclusion protects the item even before its dnd tag round-trips.
    if (excludedIds.has(mediaId)) {
      protectedCount += 1;
      continue;
    }
    const verdict = classifyGuardian(p);
    if (verdict.keep) {
      if (verdict.reason === 'recently_watched' || verdict.reason === 'requested') {
        // A FAILED protection must never be followed by that item's deletion (P5): skip it.
        try {
          await saveExclusion({
            db: input.db,
            maintainerr: input.maintainerr,
            maintainerrMediaId: mediaId,
            mediaItemId: p.mediaItemId,
            actorId: input.actorId,
            reason: 'watch_guardian',
          });
          protectedCount += 1;
        } catch (err) {
          if (err instanceof MaintainerrUpstreamError) {
            skippedCount += 1;
            continue;
          }
          throw err;
        }
      } else if (verdict.reason === 'tag') {
        protectedCount += 1; // already whitelisted by the dnd tag.
      } else {
        skippedCount += 1; // unevaluable — fail closed.
      }
      continue;
    }
    survivors.push({
      collectionId: p.collectionId,
      maintainerrMediaId: mediaId,
      mediaItemId: p.mediaItemId,
    });
  }

  // PASS 2 — delete each survivor individually (intent-first, then per-item handle).
  let expeditedCount = 0;
  for (const survivor of survivors) {
    await expediteOneSurvivor(input, 'all', survivor);
    expeditedCount += 1;
  }

  return { scope: 'all', protectedCount, expeditedCount, skippedCount, stalePending };
}

/**
 * ADR-023 / DESIGN-010 D-02 — Restore a recently-deleted item. Reuses the EXISTING executeRestore
 * failsafe path (reason 'restore', searches OFF, skip-if-present) unchanged, then records a
 * `trash_restored` marker event attributing the re-add to the Trash section (executeRestore writes
 * its own 'restored' event; this marker is the Trash-context attribution). Music is rejected (R-87).
 */
export async function restoreDeleted(input: {
  db?: DbClient;
  arr: Parameters<typeof executeRestore>[0]['arr'];
  arrKind: ArrKind;
  mediaItemId: string;
  actorId: string | null;
}): Promise<ExecuteArrAddResult> {
  if (input.arrKind === 'lidarr') {
    throw new TrashMusicUnsupportedError('Music (Lidarr) has no Trash restore surface (R-87).');
  }
  const result = await executeRestore({
    db: input.db,
    arr: input.arr,
    arrKind: input.arrKind,
    initiatedBy: input.actorId,
    mediaItemIds: [input.mediaItemId],
  });
  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: input.mediaItemId,
      eventType: 'trash_restored',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: { restoreRunId: result.runId, status: result.status },
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Rule-group writes (D5 — gated behind edit_rules + section edit)
// ---------------------------------------------------------------------------

/**
 * Live-repro fix (2026-07-06, plan-006 live validation) — reconcile the Maintainerr GET/PUT rule
 * shapes. `GET /api/rules` returns each rule group's `rules[]` as the DB ENTITY shape (`RuleDbDto`:
 * `{ id, ruleJson: <stringified RuleDto>, section, ruleGroupId, isActive }`) — the actual filter is
 * an ENCODED `ruleJson` string. But `PUT /api/rules` (`updateRules`) validates each rule as a DECODED
 * `RuleDto` (it reads `firstVal`/`action`/`lastVal`/`customVal`); it does NOT decode `ruleJson`.
 * Maintainerr's own web UI decodes `ruleJson` → `RuleDto` before saving; our Rules tab round-trips
 * the GET object verbatim (`{ ...rule, isActive }`). So any rule group with a NON-EMPTY `rules[]`
 * fails `validateRule` upstream (`firstVal` is undefined) → Maintainerr answers `{ code:0, result:
 * 'First value is not available for this server' }` at HTTP 200/201 → the write client's P1a
 * ReturnStatus hardening throws MaintainerrWriteFailedError → BAD_GATEWAY. (An EMPTY `rules[]` skips
 * the loop, which is why the old stub/e2e — a rule with `rules: []` — never caught it.)
 *
 * We normalize here (the confined write seam, not the UI) so the payload we PUT matches the DTO
 * `updateRules` expects: each `rules[]` item that still carries a string `ruleJson` is replaced by
 * `JSON.parse(ruleJson)` (backfilling `section` from the column when the encoded rule lacks it).
 * Items already in decoded `RuleDto` shape (no `ruleJson`) and non-array/absent `rules` pass through
 * untouched — the transform is idempotent and shape-agnostic.
 */
function decodeRuleGroupRules(payload: Record<string, unknown>): Record<string, unknown> {
  const rules = payload.rules;
  if (!Array.isArray(rules)) return payload;
  const decoded = rules.map((rule) => {
    if (
      rule === null ||
      typeof rule !== 'object' ||
      typeof (rule as { ruleJson?: unknown }).ruleJson !== 'string'
    ) {
      return rule;
    }
    const entity = rule as { ruleJson: string; section?: unknown };
    let parsed: unknown;
    try {
      parsed = JSON.parse(entity.ruleJson);
    } catch {
      return rule; // leave undecodable rules as-is — Maintainerr surfaces the error as before.
    }
    if (parsed === null || typeof parsed !== 'object') return rule;
    const out = parsed as Record<string, unknown>;
    // `section` is a column on the entity; older ruleJson may not embed it — backfill from the row.
    if (out.section === undefined && entity.section !== undefined) out.section = entity.section;
    return out;
  });
  return { ...payload, rules: decoded };
}

/**
 * ADR-023 / DESIGN-010 — create/update a Maintainerr rule group. Maintainerr owns the rule engine
 * and validation; we pass the RulesDto payload through the confined write client. `POST` when no id
 * (create), `PUT` when an id is present (update). Only reachable via the edit_rules-gated router.
 * The GET→PUT rule-shape reconciliation (decodeRuleGroupRules) runs FIRST so a round-tripped rule
 * group's `rules[]` is the decoded shape `updateRules` validates against (see that helper's note).
 */
export async function upsertTrashRule(input: {
  maintainerr: MaintainerrClientBundle;
  payload: Record<string, unknown>;
}): Promise<void> {
  const payload = decodeRuleGroupRules(input.payload);
  const hasId = typeof payload.id === 'number';
  await guardMaintainerrCall(hasId ? 'maintainerr PUT /rules' : 'maintainerr POST /rules', () =>
    hasId
      ? input.maintainerr.write.updateRuleGroup(payload)
      : input.maintainerr.write.createRuleGroup(payload),
  );
}

/** ADR-023 / DESIGN-010 — delete a Maintainerr rule group (edit_rules-gated). */
export async function deleteTrashRule(input: {
  maintainerr: MaintainerrClientBundle;
  ruleGroupId: number;
}): Promise<void> {
  await guardMaintainerrCall('maintainerr DELETE /rules/:id', () =>
    input.maintainerr.write.deleteRuleGroup(input.ruleGroupId),
  );
}
