import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { posterGuardApplications } from '@hnet/db';
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexWriteClient } from '@hnet/plex/write';
import {
  decidePosterAction,
  runPelotonPosterGuard,
  type PelotonPosterMapping,
  type PosterAsset,
  type PosterAssetSource,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const MAPPING: PelotonPosterMapping = {
  series: { 'Bike Bootcamp': 'bike-bootcamp-poster.png' },
  duration: { 30: '30-minutes.png' },
};

// A tiny asset source whose bytes/hash we can mutate to exercise the 'asset-updated' path.
function makeAssetSource(): { source: PosterAssetSource; setSha(name: string, sha: string): void; drop(name: string): void } {
  const shas: Record<string, string | null> = {
    'bike-bootcamp-poster.png': 'sha-series-1',
    '30-minutes.png': 'sha-30-1',
  };
  return {
    source: {
      async load(name: string): Promise<PosterAsset | null> {
        const sha = shas[name];
        if (sha == null) return null;
        return { bytes: new Uint8Array([1, 2, 3]), sha256: sha };
      },
    },
    setSha: (name, sha) => {
      shas[name] = sha;
    },
    drop: (name) => {
      shas[name] = null;
    },
  };
}

/**
 * A STATEFUL fake k8plex: a fixed library shape (Bike Bootcamp + Mystery Type) with mutable thumb paths.
 * uploadPoster mutates the target's current thumb (as real Plex does — the thumb path gains a new
 * timestamp), and getMetadataItem returns that fresh value so the guard can record it as the baseline.
 */
function makeFakePlex(): {
  read: PlexReadClient;
  write: PlexWriteClient;
  uploads: string[];
  setThumb(rk: string, thumb: string): void;
  withoutPeloton(): void;
} {
  const thumbs = new Map<string, string>([
    ['bb', 'bb-orig'],
    ['s30', 's30-orig'],
    ['s75', 's75-orig'],
    ['myst', 'myst-orig'],
  ]);
  const uploads: string[] = [];
  let counter = 0;
  let hasPeloton = true;

  const item = (rk: string, title: string, index: number | null, type: string) => ({
    ratingKey: rk,
    title,
    type,
    thumb: thumbs.get(rk),
    index: index ?? undefined,
    librarySectionID: '4',
  });

  const read = {
    async listSections() {
      return hasPeloton
        ? [{ key: '4', type: 'show', title: 'HOps Peloton', agent: null }]
        : [{ key: '2', type: 'artist', title: 'HOps Music', agent: null }];
    },
    async listSectionContents(_key: string) {
      return [item('bb', 'Bike Bootcamp', null, 'show'), item('myst', 'Mystery Type', null, 'show')];
    },
    async listMetadataChildren(rk: string) {
      const kids =
        rk === 'bb'
          ? [item('s30', 'Season 30', 30, 'season'), item('s75', 'Season 75', 75, 'season')]
          : [];
      return { items: kids, librarySectionId: '4', totalSize: kids.length };
    },
    async getMetadataItem(rk: string) {
      return { item: item(rk, rk, null, thumbs.get(rk) ? 'season' : 'season'), librarySectionId: '4' };
    },
  } as unknown as PlexReadClient;

  const write = {
    async uploadPoster(input: { ratingKey: string; body: Uint8Array }) {
      uploads.push(input.ratingKey);
      counter += 1;
      thumbs.set(input.ratingKey, `applied-${input.ratingKey}-${counter}`);
    },
  } as unknown as PlexWriteClient;

  return {
    read,
    write,
    uploads,
    setThumb: (rk, thumb) => thumbs.set(rk, thumb),
    withoutPeloton: () => {
      hasPeloton = false;
    },
  };
}

describe('decidePosterAction (pure)', () => {
  const asset: PosterAsset = { bytes: new Uint8Array(), sha256: 'sha-1' };
  const target = { assetName: '30-minutes.png', currentThumb: '/thumb/base' };

  it("returns 'initial' when there is no prior apply row", () => {
    expect(decidePosterAction(target, null, asset)).toBe('initial');
  });
  it("returns 'asset-updated' when the mapped asset name changed", () => {
    const latest = { assetName: 'old.png', assetSha256: 'sha-1', appliedThumb: '/thumb/base' };
    expect(decidePosterAction(target, latest, asset)).toBe('asset-updated');
  });
  it("returns 'asset-updated' when the asset bytes (sha) changed", () => {
    const latest = { assetName: '30-minutes.png', assetSha256: 'sha-OLD', appliedThumb: '/thumb/base' };
    expect(decidePosterAction(target, latest, asset)).toBe('asset-updated');
  });
  it("returns 'drift' when the live thumb moved off our baseline", () => {
    const latest = { assetName: '30-minutes.png', assetSha256: 'sha-1', appliedThumb: '/thumb/OTHER' };
    expect(decidePosterAction(target, latest, asset)).toBe('drift');
  });
  it('returns null when the target is already in baseline', () => {
    const latest = { assetName: '30-minutes.png', assetSha256: 'sha-1', appliedThumb: '/thumb/base' };
    expect(decidePosterAction(target, latest, asset)).toBeNull();
  });
});

describe('runPelotonPosterGuard (embedded Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.db.delete(posterGuardApplications);
  });

  it('initial run: applies mapped show+season, reports unmapped, writes one ledger row each', async () => {
    const plex = makeFakePlex();
    const assets = makeAssetSource();
    const report = await runPelotonPosterGuard({
      db: t.db,
      read: plex.read,
      write: plex.write,
      assets: assets.source,
      mapping: MAPPING,
    });

    expect(report.found).toBe(true);
    expect(report.sectionKey).toBe('4');
    expect(report.checked).toBe(2); // bb (show) + s30 (season 30)
    expect(report.reapplied.map((r) => r.ratingKey).sort()).toEqual(['bb', 's30']);
    expect(report.reapplied.every((r) => r.reason === 'initial')).toBe(true);
    // Mystery Type (unmapped show) + Season 75 (unmapped index).
    expect(report.unmapped.map((u) => u.ratingKey).sort()).toEqual(['myst', 's75']);
    expect(report.missingAssets).toEqual([]);
    expect(plex.uploads.sort()).toEqual(['bb', 's30']);

    const rows = await t.db.select().from(posterGuardApplications);
    expect(rows).toHaveLength(2);
    // The baseline recorded is the POST-upload thumb, not the pre-drift one.
    const s30 = rows.find((r) => r.ratingKey === 's30')!;
    expect(s30.previousThumb).toBe('s30-orig');
    expect(s30.appliedThumb).toMatch(/^applied-s30-/);
    expect(s30.assetName).toBe('30-minutes.png');
  });

  it('a second run with no drift re-applies nothing (idempotent)', async () => {
    const plex = makeFakePlex();
    const assets = makeAssetSource();
    await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });
    const before = plex.uploads.length;

    const report = await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });
    expect(report.reapplied).toHaveLength(0);
    expect(report.inSync).toBe(2);
    expect(plex.uploads.length).toBe(before); // no new uploads
    expect(await t.db.select().from(posterGuardApplications)).toHaveLength(2); // ledger unchanged
  });

  it('detects DRIFT (thumb overwritten externally) and restores exactly that target', async () => {
    const plex = makeFakePlex();
    const assets = makeAssetSource();
    await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });

    // Simulate a ytdl-sub re-scan overwriting the season 30 art.
    plex.setThumb('s30', 's30-CLOBBERED');
    const report = await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });

    expect(report.reapplied).toHaveLength(1);
    expect(report.reapplied[0]!.ratingKey).toBe('s30');
    expect(report.reapplied[0]!.reason).toBe('drift');
    expect(report.reapplied[0]!.previousThumb).toBe('s30-CLOBBERED');
    expect(await t.db.select().from(posterGuardApplications)).toHaveLength(3); // 2 initial + 1 drift
  });

  it("re-applies with reason 'asset-updated' when the owner swaps the PNG bytes", async () => {
    const plex = makeFakePlex();
    const assets = makeAssetSource();
    await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });

    assets.setSha('30-minutes.png', 'sha-30-2'); // new bytes for the same filename
    const report = await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });

    expect(report.reapplied).toHaveLength(1);
    expect(report.reapplied[0]!.ratingKey).toBe('s30');
    expect(report.reapplied[0]!.reason).toBe('asset-updated');
  });

  it('reports a mapped asset missing from the image without crashing (no upload for it)', async () => {
    const plex = makeFakePlex();
    const assets = makeAssetSource();
    assets.drop('30-minutes.png');
    const report = await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });

    expect(report.missingAssets).toEqual(['30-minutes.png']);
    expect(report.reapplied.map((r) => r.ratingKey)).toEqual(['bb']); // series still applied
    expect(plex.uploads).not.toContain('s30');
  });

  it('degrades to found:false (no writes) when the Peloton library is absent', async () => {
    const plex = makeFakePlex();
    plex.withoutPeloton();
    const assets = makeAssetSource();
    const report = await runPelotonPosterGuard({ db: t.db, read: plex.read, write: plex.write, assets: assets.source, mapping: MAPPING });

    expect(report.found).toBe(false);
    expect(report.sectionKey).toBeNull();
    expect(report.checked).toBe(0);
    expect(plex.uploads).toHaveLength(0);
    expect(await t.db.select().from(posterGuardApplications)).toHaveLength(0);
  });
});
