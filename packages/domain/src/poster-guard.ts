// ADR-043 / DESIGN-021 (PLAN-024) — the Peloton poster GUARD single-writer. The `poster-guard` sync mode
// reads the HOps Peloton library from k8plex, resolves each show → its series poster and each season →
// its duration poster (by title / season-index; owner assets baked into the image, ADR-043 C-01), and
// RE-APPLIES only the targets that DRIFTED since the last apply. Drift = the live Plex thumb no longer
// equals the baseline we recorded at last apply, OR the mapped asset's bytes changed (owner swapped the
// PNG), OR we have never applied this target. Each re-apply pushes the poster via the confined
// @hnet/plex/write surface (ADR-017) and appends ONE poster_guard_applications ledger row (drift baseline
// + audit) in the same transaction — this append-only ledger IS the mode's audit trail (no sync_runs row,
// like smart-alerts). Bounded: ~1 listSections + 1 listSectionContents + one children read per show, then
// writes only on drift (normally zero) — safe to run hourly (ADR-043 C-06).
import { randomUUID } from 'node:crypto';
import {
  posterGuardApplications,
  type DbClient,
  type PosterGuardApplicationRow,
  type PosterGuardReason,
  type PosterGuardTargetKind,
} from '@hnet/db';
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexWriteClient } from '@hnet/plex/write';
import type { PlexSectionItem } from '@hnet/plex';
import { desc, inArray } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

/** The durable-asset mapping (ADR-043 C-02): show TITLE → series poster, season INDEX → duration poster.
 *  Resolution is dynamic (by live title/index), so new shows/seasons auto-map and a Plex re-index that
 *  changes ratingKeys never breaks it. Targets with no mapping entry are reported UNMAPPED, never guessed. */
export interface PelotonPosterMapping {
  /** e.g. { 'Bike Bootcamp': 'bike-bootcamp-poster.png', … }. */
  series: Record<string, string>;
  /** e.g. { 5: '5-minutes.png', 60: '60-minutes.png', 120: '120-minutes.png' }. */
  duration: Record<number, string>;
}

/** One override PNG: its bytes + the sha256 of those bytes (an owner swap changes the hash ⇒ re-apply). */
export interface PosterAsset {
  bytes: Uint8Array;
  sha256: string;
}

/** Loads a durable asset by filename. Injected by @hnet/sync (reads packages/sync/assets from the image);
 *  keeps this domain module free of fs/crypto so it stays unit-testable. null ⇒ the mapped file is absent. */
export interface PosterAssetSource {
  load(name: string): Promise<PosterAsset | null>;
}

/** A resolved Plex target (a show or a season) the guard will check this run. */
interface PosterTarget {
  ratingKey: string;
  kind: PosterGuardTargetKind;
  showTitle: string;
  seasonIndex: number | null;
  /** The item's current Plex thumb path (the drift comparand), or null when it has no art. */
  currentThumb: string | null;
  assetName: string;
}

/** A target with no mapping entry (an unknown show, or a season index like 75/0 with no asset). */
export interface PosterGuardUnmapped {
  ratingKey: string;
  kind: PosterGuardTargetKind;
  showTitle: string;
  seasonIndex: number | null;
}

export interface PosterGuardReapply {
  ratingKey: string;
  kind: PosterGuardTargetKind;
  showTitle: string;
  seasonIndex: number | null;
  assetName: string;
  reason: PosterGuardReason;
  previousThumb: string | null;
  appliedThumb: string | null;
}

export interface PosterGuardReport {
  /** The Peloton library was found on the server (false ⇒ nothing checked, no writes). */
  found: boolean;
  /** The resolved Plex section key (null when not found). */
  sectionKey: string | null;
  /** The per-invocation correlation id stamped on every ledger row written this run. */
  runId: string;
  /** Mapped targets examined (shows + seasons). */
  checked: number;
  /** Targets that were in-baseline (no drift) — left untouched. */
  inSync: number;
  /** Targets re-applied this run (drift / initial / asset-updated). */
  reapplied: PosterGuardReapply[];
  /** Targets with no mapping entry — reported, never guessed (ADR-043 C-03). */
  unmapped: PosterGuardUnmapped[];
  /** Mapping entries whose asset file was missing from the image (a config error; skipped, not fatal). */
  missingAssets: string[];
}

/**
 * PURE drift decision (unit-tested). Given a target, the newest prior ledger row for it (or null), and the
 * mapped asset, return the re-apply reason — or null when the target is already in baseline. Order:
 *   - no prior row              → 'initial'
 *   - asset name/bytes changed  → 'asset-updated'
 *   - live thumb ≠ our baseline → 'drift'
 *   - otherwise                 → null (in sync; do nothing)
 */
export function decidePosterAction(
  target: { assetName: string; currentThumb: string | null },
  latest: Pick<PosterGuardApplicationRow, 'assetName' | 'assetSha256' | 'appliedThumb'> | null,
  asset: PosterAsset,
): PosterGuardReason | null {
  if (!latest) return 'initial';
  if (latest.assetName !== target.assetName || latest.assetSha256 !== asset.sha256) {
    return 'asset-updated';
  }
  if (latest.appliedThumb !== target.currentThumb) return 'drift';
  return null;
}

/** Build the show + season targets from the live Peloton library, resolving each to its mapped asset. */
function resolveTargets(
  shows: PlexSectionItem[],
  seasonsByShow: Map<string, PlexSectionItem[]>,
  mapping: PelotonPosterMapping,
): { targets: PosterTarget[]; unmapped: PosterGuardUnmapped[] } {
  const targets: PosterTarget[] = [];
  const unmapped: PosterGuardUnmapped[] = [];
  for (const show of shows) {
    const seriesAsset = mapping.series[show.title];
    if (seriesAsset) {
      targets.push({
        ratingKey: show.ratingKey,
        kind: 'show',
        showTitle: show.title,
        seasonIndex: null,
        currentThumb: show.thumb ?? null,
        assetName: seriesAsset,
      });
    } else {
      unmapped.push({ ratingKey: show.ratingKey, kind: 'show', showTitle: show.title, seasonIndex: null });
    }
    for (const season of seasonsByShow.get(show.ratingKey) ?? []) {
      const index = season.index ?? null;
      const durationAsset = index === null ? undefined : mapping.duration[index];
      if (durationAsset) {
        targets.push({
          ratingKey: season.ratingKey,
          kind: 'season',
          showTitle: show.title,
          seasonIndex: index,
          currentThumb: season.thumb ?? null,
          assetName: durationAsset,
        });
      } else {
        unmapped.push({
          ratingKey: season.ratingKey,
          kind: 'season',
          showTitle: show.title,
          seasonIndex: index,
        });
      }
    }
  }
  return { targets, unmapped };
}

export interface RunPelotonPosterGuardInput {
  db?: DbClient;
  read: PlexReadClient;
  write: PlexWriteClient;
  assets: PosterAssetSource;
  mapping: PelotonPosterMapping;
  /** Which library title is the Peloton one — default /peloton/i (matches the ytdlsub router matcher). */
  libraryTitleMatch?: RegExp;
}

/**
 * Run the guard once. Resolves the Peloton section by title, walks its shows + seasons, and for each
 * mapped target re-applies its durable poster ONLY on drift, appending a ledger row per re-apply. The
 * Plex upload is issued OUTSIDE the transaction (a network write, like plex-shares.applyShare); the
 * ledger insert is the single-writer record committed same-tx.
 */
export async function runPelotonPosterGuard(
  input: RunPelotonPosterGuardInput,
): Promise<PosterGuardReport> {
  const db = resolveDb(input.db);
  const runId = randomUUID();
  const match = input.libraryTitleMatch ?? /peloton/i;

  const sections = await input.read.listSections();
  const section = sections.find((s) => match.test(s.title));
  if (!section) {
    return {
      found: false,
      sectionKey: null,
      runId,
      checked: 0,
      inSync: 0,
      reapplied: [],
      unmapped: [],
      missingAssets: [],
    };
  }

  const shows = await input.read.listSectionContents(section.key);
  const seasonsByShow = new Map<string, PlexSectionItem[]>();
  for (const show of shows) {
    const children = await input.read.listMetadataChildren(show.ratingKey);
    seasonsByShow.set(
      show.ratingKey,
      children.items.filter((c) => c.type === 'season'),
    );
  }

  const { targets, unmapped } = resolveTargets(shows, seasonsByShow, input.mapping);

  // Newest prior ledger row per target ratingKey (drift baseline).
  const keys = targets.map((t) => t.ratingKey);
  const priorRows = keys.length
    ? await db
        .select()
        .from(posterGuardApplications)
        .where(inArray(posterGuardApplications.ratingKey, keys))
        .orderBy(desc(posterGuardApplications.createdAt))
    : [];
  const latestByKey = new Map<string, PosterGuardApplicationRow>();
  for (const row of priorRows) {
    if (!latestByKey.has(row.ratingKey)) latestByKey.set(row.ratingKey, row);
  }

  const reapplied: PosterGuardReapply[] = [];
  const missingAssets = new Set<string>();
  let inSync = 0;

  for (const target of targets) {
    const asset = await input.assets.load(target.assetName);
    if (!asset) {
      missingAssets.add(target.assetName);
      continue;
    }
    const reason = decidePosterAction(target, latestByKey.get(target.ratingKey) ?? null, asset);
    if (reason === null) {
      inSync += 1;
      continue;
    }
    // Push the poster (confined write surface), then read back the new thumb as the next baseline.
    await input.write.uploadPoster({ ratingKey: target.ratingKey, body: asset.bytes });
    const after = await input.read.getMetadataItem(target.ratingKey);
    const appliedThumb = after?.item.thumb ?? null;

    await inTransaction(input.db, async (tx) => {
      await tx.insert(posterGuardApplications).values({
        runId,
        ratingKey: target.ratingKey,
        targetKind: target.kind,
        showTitle: target.showTitle,
        seasonIndex: target.seasonIndex,
        assetName: target.assetName,
        assetSha256: asset.sha256,
        reason,
        previousThumb: target.currentThumb,
        appliedThumb,
      });
    });

    reapplied.push({
      ratingKey: target.ratingKey,
      kind: target.kind,
      showTitle: target.showTitle,
      seasonIndex: target.seasonIndex,
      assetName: target.assetName,
      reason,
      previousThumb: target.currentThumb,
      appliedThumb,
    });
  }

  return {
    found: true,
    sectionKey: section.key,
    runId,
    checked: targets.length,
    inSync,
    reapplied,
    unmapped,
    missingAssets: [...missingAssets].sort(),
  };
}
