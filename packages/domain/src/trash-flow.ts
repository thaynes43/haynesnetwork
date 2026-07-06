// ADR-023 / DESIGN-010 — the Trash section orchestrators over Maintainerr (the deletion system of
// record). Read-through pending (no mirror table), the preflight SAFETY audit, the confined
// exclusion/expedite/rules write surface, the cross-server watch guardian, and the recently-deleted
// + restore paths. The mutating Maintainerr surface (@hnet/arr/write) stays confined here (ADR-008
// guard). Music/Lidarr is NEVER a Trash target (R-87) — rejected at the orchestrator, not just UI.
import {
  ledgerEvents,
  mediaItems,
  mediaMetadata,
  type ArrKind,
  type DbClient,
} from '@hnet/db';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import {
  MaintainerrUnsafeError,
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
  /** last_viewed_at (cross-server MAX) is within RECENTLY_WATCHED_WINDOW_DAYS — never delete. */
  recentlyWatched: boolean;
  lastViewedAt: string | null;
  requesters: string[];
  sourceCollections: string[];
  posterSource: string | null;
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
  }
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
      title: joined?.title ?? `tmdb:${f.tmdbId ?? ''}${f.tvdbId !== null ? ` tvdb:${f.tvdbId}` : ''}`.trim(),
      year: joined?.year ?? null,
      arrKind: joined ? arrKind : null,
      arrTags,
      protectedByTag: arrTags.includes(PROTECTED_TAG),
      recentlyWatched,
      lastViewedAt: lastViewed === null ? null : lastViewed.toISOString(),
      requesters: joined?.requesters ?? [],
      sourceCollections: joined?.sourceCollections ?? [],
      posterSource: joined?.posterSource ?? null,
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
 * Addendum a — the cross-server watch guardian. Given the pending set for a media kind, auto-protect
 * (whitelist in Maintainerr) every item watched on ANY server within the window that is not already
 * protected, BEFORE any expedite / Maintainerr deletion cron. Returns the protected + surviving
 * (expeditable) partitions. Each protection records a `trash_excluded` (reason 'watch_guardian')
 * event. Items with no Maintainerr id can't be protected/expedited and are dropped from expedite.
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
    const keep = item.recentlyWatched || item.requesters.length > 0 || item.protectedByTag;
    if (keep) {
      if (!item.protectedByTag) {
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
        protectedIds.push(item.maintainerrMediaId);
      }
    } else {
      expeditableIds.push(item.maintainerrMediaId);
    }
  }
  return { protectedCount: protectedIds.length, protectedIds, expeditableIds };
}

// ---------------------------------------------------------------------------
// Expedite (destructive — D5 intent-first ordering) + rules + restore
// ---------------------------------------------------------------------------

/**
 * ADR-023 / DESIGN-010 D-04/D-05 — expedite deletion (DESTRUCTIVE). Every call re-runs the
 * preflight audit and refuses (MaintainerrUnsafeError → PRECONDITION_FAILED) unless SAFE. The
 * watch guardian runs FIRST (auto-whitelisting recently-watched / requested items so Maintainerr's
 * handler can't delete them). Ordering: the `trash_expedited` intent event is committed BEFORE the
 * Maintainerr handle call (the Fix D-09 discipline for destructive actions — a lost response must
 * never hide an initiated deletion). scope 'item' → POST /collections/media/handle for one item;
 * scope 'all' → POST /collections/handle. Music/Lidarr is rejected (R-87).
 */
export interface ExpediteDeletionInput {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  scope: 'item' | 'all';
  media: TrashMedia;
  actorId: string | null;
  /** scope 'item' — the target. */
  item?: {
    collectionId: number;
    maintainerrMediaId: string;
    mediaItemId?: string | null;
  };
}

export interface ExpediteDeletionResult {
  scope: 'item' | 'all';
  /** items protected by the watch guardian (whitelisted instead of deleted). */
  protectedCount: number;
  /** items handed to Maintainerr's handler (scope 'all' ⇒ every surviving pending item). */
  expeditedCount: number;
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
    // Guardian check for the single target: recently-watched / requested ⇒ protect, don't delete.
    const pending = await listTrashPending({
      db: input.db,
      maintainerr: input.maintainerr,
      media: input.media,
    });
    const target = pending.items.find(
      (p) => p.maintainerrMediaId === item.maintainerrMediaId,
    );
    if (
      target &&
      (target.recentlyWatched || target.requesters.length > 0) &&
      !target.protectedByTag
    ) {
      await saveExclusion({
        db: input.db,
        maintainerr: input.maintainerr,
        maintainerrMediaId: item.maintainerrMediaId,
        mediaItemId: item.mediaItemId,
        actorId: input.actorId,
        reason: 'watch_guardian',
      });
      return { scope: 'item', protectedCount: 1, expeditedCount: 0 };
    }

    // 1) Commit the destructive INTENT first (Fix D-09 discipline).
    await inTransaction(input.db, async (tx) => {
      await tx.insert(ledgerEvents).values({
        mediaItemId: item.mediaItemId ?? null,
        eventType: 'trash_expedited',
        source: 'maintainerr',
        occurredAt: nowDate(),
        requestedByUserId: input.actorId ?? null,
        payload: {
          scope: 'item',
          collectionId: item.collectionId,
          maintainerrMediaId: item.maintainerrMediaId,
        },
      });
    });
    // 2) Then trigger Maintainerr's per-item handler.
    await guardMaintainerrCall('maintainerr POST /collections/media/handle', () =>
      input.maintainerr.write.handleCollectionMedia(item.collectionId, item.maintainerrMediaId),
    );
    return { scope: 'item', protectedCount: 0, expeditedCount: 1 };
  }

  // scope 'all' — guardian auto-whitelists watched/requested items, then handle every collection.
  const guard = await guardRecentlyWatched({
    db: input.db,
    maintainerr: input.maintainerr,
    media: input.media,
    actorId: input.actorId,
  });
  // 1) Commit the destructive INTENT (one marker for the batch).
  await inTransaction(input.db, async (tx) => {
    await tx.insert(ledgerEvents).values({
      mediaItemId: null,
      eventType: 'trash_expedited',
      source: 'maintainerr',
      occurredAt: nowDate(),
      requestedByUserId: input.actorId ?? null,
      payload: {
        scope: 'all',
        media: input.media,
        expeditableCount: guard.expeditableIds.length,
        protectedCount: guard.protectedCount,
      },
    });
  });
  // 2) Trigger Maintainerr's whole-estate handler.
  await guardMaintainerrCall('maintainerr POST /collections/handle', () =>
    input.maintainerr.write.handleAllCollections(),
  );
  return {
    scope: 'all',
    protectedCount: guard.protectedCount,
    expeditedCount: guard.expeditableIds.length,
  };
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
 * ADR-023 / DESIGN-010 — create/update a Maintainerr rule group. Maintainerr owns the rule engine
 * and validation; we pass the RulesDto payload through the confined write client. `POST` when no id
 * (create), `PUT` when an id is present (update). Only reachable via the edit_rules-gated router.
 */
export async function upsertTrashRule(input: {
  maintainerr: MaintainerrClientBundle;
  payload: Record<string, unknown>;
}): Promise<void> {
  const hasId = typeof input.payload.id === 'number';
  await guardMaintainerrCall(
    hasId ? 'maintainerr PUT /rules' : 'maintainerr POST /rules',
    () =>
      hasId
        ? input.maintainerr.write.updateRuleGroup(input.payload)
        : input.maintainerr.write.createRuleGroup(input.payload),
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
