import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PELOTON_POSTER_ASSET_DIR,
  PELOTON_POSTER_MAPPING,
  createFilePosterAssetSource,
} from '../src/peloton-poster-map';

describe('Peloton poster mapping + asset source (ADR-043 / DESIGN-021)', () => {
  const mappedFiles = [
    ...Object.values(PELOTON_POSTER_MAPPING.series),
    ...Object.values(PELOTON_POSTER_MAPPING.duration),
  ];

  it('every mapped asset filename exists in the image asset dir', () => {
    const missing = mappedFiles.filter((f) => !existsSync(join(PELOTON_POSTER_ASSET_DIR, f)));
    expect(missing).toEqual([]);
  });

  it('the index-60 season maps to the CLEAN "60-minutes.png" (not the 60+ bucket art)', () => {
    expect(PELOTON_POSTER_MAPPING.duration[60]).toBe('60-minutes.png');
  });

  it('does NOT map the unmapped season indices (0 Specials, 75)', () => {
    expect(PELOTON_POSTER_MAPPING.duration[0]).toBeUndefined();
    expect(PELOTON_POSTER_MAPPING.duration[75]).toBeUndefined();
  });

  it('createFilePosterAssetSource loads real bytes + a sha256, caching per name', async () => {
    const source = createFilePosterAssetSource();
    const a = await source.load('30-minutes.png');
    expect(a).not.toBeNull();
    expect(a!.bytes.byteLength).toBeGreaterThan(1000);
    expect(a!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const b = await source.load('30-minutes.png');
    expect(b!.sha256).toBe(a!.sha256);
  });

  it('returns null for a missing file and for path-traversal names', async () => {
    const source = createFilePosterAssetSource();
    expect(await source.load('does-not-exist.png')).toBeNull();
    expect(await source.load('../secret.png')).toBeNull();
    expect(await source.load('sub/dir.png')).toBeNull();
  });
});
