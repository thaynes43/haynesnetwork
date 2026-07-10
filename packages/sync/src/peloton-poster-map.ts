// ADR-043 / DESIGN-021 (PLAN-024) — the durable Peloton poster mapping + the image-backed asset source.
// The override PNGs live in the app repo/image at packages/sync/assets/peloton-posters (ADR-043 C-01) —
// versioned, PR-reviewed, byte-diffable, and already present in the CronJob's image (no PVC, no DB bytea,
// no NFS mount). The mapping resolves by live Plex TITLE / season INDEX (ADR-043 C-02), seeded from the
// PLAN-024 Part-A restore inventory. To add or change art: drop the PNG here + add its mapping entry, then
// ship a release — the hourly guard re-applies it on the next run.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PelotonPosterMapping, PosterAsset, PosterAssetSource } from '@hnet/domain';

/** The durable-asset directory, resolved relative to this module (image path: /sync/assets/peloton-posters). */
export const PELOTON_POSTER_ASSET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'peloton-posters',
);

/**
 * Show TITLE → series poster, season INDEX (minutes) → duration poster. Seeded from the Part-A inventory
 * of HOps Peloton (12 shows; season indices 5/10/15/20/30/45/60/90/120). Index 60 maps to the CLEAN
 * "60 MINUTES" art ('60-minutes.png') — the library uses a distinct Season 60 alongside 75/90/120, so the
 * "60+ MINUTES" bucket art is NOT used (it stays versioned as 60+-minutes.png). Season indices with no
 * Peloton asset (0 "Specials", 75) are intentionally ABSENT — the guard reports them UNMAPPED, never
 * guesses (ADR-043 C-03). 'Outdoor' is pre-mapped (the asset exists) in case that class type appears.
 */
export const PELOTON_POSTER_MAPPING: PelotonPosterMapping = {
  series: {
    'Bike Bootcamp': 'bike-bootcamp-poster.png',
    Cardio: 'cardio-poster.png',
    Cycling: 'cycling-poster.png',
    Meditation: 'meditation-poster.png',
    Outdoor: 'outdoor-poster.png',
    'Row Bootcamp': 'row-bootcamp-poster.png',
    Rowing: 'rowing-poster.png',
    Running: 'running-poster.png',
    Strength: 'strength-poster.png',
    Stretching: 'stretching-poster.png',
    'Tread Bootcamp': 'tread-bootcamp-poster.png',
    Walking: 'walking-poster.png',
    Yoga: 'yoga-poster.png',
  },
  duration: {
    5: '5-minutes.png',
    10: '10-minutes.png',
    15: '15-minutes.png',
    20: '20-minutes.png',
    30: '30-minutes.png',
    45: '45-minutes.png',
    60: '60-minutes.png',
    90: '90-minutes.png',
    120: '120-minutes.png',
  },
};

/**
 * A filesystem-backed PosterAssetSource: reads a PNG from PELOTON_POSTER_ASSET_DIR and hashes its bytes.
 * Per-process cache (the files are immutable within an image); a missing file resolves to null so a stale
 * mapping entry is reported (missingAssets) rather than crashing the run.
 */
export function createFilePosterAssetSource(dir: string = PELOTON_POSTER_ASSET_DIR): PosterAssetSource {
  const cache = new Map<string, PosterAsset | null>();
  return {
    async load(name: string): Promise<PosterAsset | null> {
      if (cache.has(name)) return cache.get(name)!;
      // Defence-in-depth: mapping names are literals, but never let a name escape the asset dir.
      if (name.includes('/') || name.includes('..') || name.includes('\\')) {
        cache.set(name, null);
        return null;
      }
      let asset: PosterAsset | null;
      try {
        const bytes = await readFile(join(dir, name));
        asset = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
      } catch {
        asset = null;
      }
      cache.set(name, asset);
      return asset;
    },
  };
}
