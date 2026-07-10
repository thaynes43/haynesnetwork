import { describe, expect, it, vi } from 'vitest';
import type { PromVectorSample, PrometheusReader } from '../src/client';
import {
  getAppsMetrics,
  SAB_SPEED_QUERY,
  SAB_DOWNLOADED_24H_QUERY,
  SAB_REMAINING_QUERY,
  SAB_QUEUE_LENGTH_QUERY,
  SAB_UP_QUERY,
  QBITTORRENT_UP_QUERY,
  QBITTORRENT_TORRENTS_QUERY,
  SLSKD_UP_QUERY,
  SLSKD_QUEUE_DEPTH_QUERY,
  PROWLARR_ENABLED_QUERY,
  PROWLARR_UNAVAILABLE_QUERY,
  PROWLARR_RESPONSE_MS_QUERY,
  PROWLARR_QUERY_RATE_QUERY,
} from '../src/apps';

function sample(value: number, metric: Record<string, string> = {}): PromVectorSample {
  return { metric, value: [1_700_000_000, String(value)] };
}

/** A stub reader that answers instant queries from a map (missing ⇒ throw, to exercise the degrade). */
function stubReader(answers: Record<string, PromVectorSample[]>): {
  reader: PrometheusReader;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (promQL: string) => {
    if (promQL in answers) return answers[promQL]!;
    throw new Error(`no stub for ${promQL}`);
  });
  return { reader: { query, queryRange: async () => [] }, query };
}

/** The full happy-path answer map (mirrors the live 2026-07-10 magnitudes). */
const LIVE: Record<string, PromVectorSample[]> = {
  // Collection
  radarr_movie_total: [sample(9564)],
  radarr_movie_monitored_total: [sample(9000)],
  radarr_movie_missing_total: [sample(120)],
  radarr_movie_cutoff_unmet_total: [sample(45)],
  sonarr_episode_total: [sample(114118)],
  sonarr_series_monitored_total: [sample(800)],
  sonarr_episode_missing_total: [sample(300)],
  sonarr_episode_cutoff_unmet_total: [sample(60)],
  lidarr_albums_total: [sample(55507)],
  lidarr_artists_monitored_total: [sample(2100)],
  lidarr_albums_missing_total: [sample(500)],
  // Pipeline
  'sum(radarr_queue_total)': [sample(3)],
  'sum(rate(radarr_history_total[1h])) * 3600': [sample(0)],
  'sum(radarr_system_health_issues)': [sample(1)],
  'sum(sonarr_queue_total)': [sample(5)],
  'sum(rate(sonarr_history_total[1h])) * 3600': [sample(18)],
  'sum(sonarr_system_health_issues)': [sample(0)],
  'sum(lidarr_queue_total)': [sample(2)],
  'sum(rate(lidarr_history_total[1h])) * 3600': [sample(0.4)],
  'sum(lidarr_system_health_issues)': [sample(0)],
  // Downloads — SAB per lane (job)
  [SAB_SPEED_QUERY]: [
    sample(12_000_000, { job: 'sabnzbd' }),
    sample(0, { job: 'sabnzbd-fast' }),
  ],
  [SAB_DOWNLOADED_24H_QUERY]: [
    sample(848_000_000_000, { job: 'sabnzbd' }),
    sample(60_000_000_000, { job: 'sabnzbd-fast' }),
  ],
  [SAB_REMAINING_QUERY]: [
    sample(5_000_000_000, { job: 'sabnzbd' }),
    sample(0, { job: 'sabnzbd-fast' }),
  ],
  [SAB_QUEUE_LENGTH_QUERY]: [
    sample(4, { job: 'sabnzbd' }),
    sample(0, { job: 'sabnzbd-fast' }),
  ],
  [SAB_UP_QUERY]: [sample(1, { job: 'sabnzbd' }), sample(1, { job: 'sabnzbd-fast' })],
  [QBITTORRENT_UP_QUERY]: [sample(1)],
  [QBITTORRENT_TORRENTS_QUERY]: [sample(12)],
  [SLSKD_UP_QUERY]: [sample(1)],
  [SLSKD_QUEUE_DEPTH_QUERY]: [sample(0)],
  // Indexers
  [PROWLARR_ENABLED_QUERY]: [sample(4)],
  [PROWLARR_UNAVAILABLE_QUERY]: [sample(0)],
  [PROWLARR_RESPONSE_MS_QUERY]: [
    sample(335, { indexer: 'DrunkenSlug' }),
    sample(225, { indexer: 'NinjaCentral' }),
  ],
  [PROWLARR_QUERY_RATE_QUERY]: [
    sample(12, { indexer: 'DrunkenSlug' }),
    sample(6, { indexer: 'NinjaCentral' }),
  ],
};

describe('getAppsMetrics', () => {
  it('maps the four groups from the live series', async () => {
    const { reader } = stubReader(LIVE);
    const out = await getAppsMetrics({ prometheus: reader, includeUserAware: true, includeGrafanaLinks: false });

    // Group A — Collection
    expect(out.collection.unavailable).toBe(false);
    const radarr = out.collection.rows.find((r) => r.key === 'radarr')!;
    expect(radarr).toMatchObject({ total: 9564, monitored: 9000, missing: 120, cutoffUnmet: 45 });
    const lidarr = out.collection.rows.find((r) => r.key === 'lidarr')!;
    expect(lidarr.total).toBe(55507);
    expect(lidarr.cutoffUnmet).toBeNull(); // lidarr has no cutoff-unmet series

    // Group B — Pipeline
    const sonarrPipe = out.pipeline.rows.find((r) => r.key === 'sonarr')!;
    expect(sonarrPipe).toMatchObject({ queue: 5, grabsPerHour: 18, healthIssues: 0 });

    // Group C — Downloads (SAB lanes folded by job)
    const sab = out.downloads.usenet.find((l) => l.key === 'sabnzbd')!;
    expect(sab).toMatchObject({
      speedBps: 12_000_000,
      downloaded24hBytes: 848_000_000_000,
      queueLength: 4,
      up: true,
    });
    const fast = out.downloads.usenet.find((l) => l.key === 'sabnzbd-fast')!;
    expect(fast.speedBps).toBe(0);
    const qbt = out.downloads.clients.find((c) => c.key === 'qbittorrent')!;
    expect(qbt).toMatchObject({ up: true, detail: '12 torrents' });
    const slskd = out.downloads.clients.find((c) => c.key === 'slskd')!;
    expect(slskd).toMatchObject({ up: true, detail: 'queue depth 0' });

    // Group D — Indexers (rows sorted by name)
    expect(out.indexers.enabled).toBe(4);
    expect(out.indexers.unavailableCount).toBe(0);
    expect(out.indexers.rows.map((r) => r.indexer)).toEqual(['DrunkenSlug', 'NinjaCentral']);
    expect(out.indexers.rows[0]).toMatchObject({ avgResponseMs: 335, queriesPerHour: 12 });
  });

  it('keeps the full-only requester seam present-but-empty at full and OMITTED at limited', async () => {
    const { reader } = stubReader(LIVE);
    const full = await getAppsMetrics({ prometheus: reader, includeUserAware: true, includeGrafanaLinks: false });
    expect('requesterActivity' in full).toBe(true);
    expect(full.requesterActivity).toEqual([]);

    const limited = await getAppsMetrics({ prometheus: reader, includeUserAware: false, includeGrafanaLinks: false });
    expect('requesterActivity' in limited).toBe(false);
    expect(limited.requesterActivity).toBeUndefined();
    // The four data groups are identical at both levels (no user-aware series to drop).
    expect(limited.collection).toEqual(full.collection);
    expect(limited.indexers).toEqual(full.indexers);
  });

  it('degrades every group to unavailable when all queries fail, never throwing', async () => {
    const { reader } = stubReader({}); // every query throws
    const out = await getAppsMetrics({ prometheus: reader, includeUserAware: false, includeGrafanaLinks: false });
    expect(out.collection.unavailable).toBe(true);
    expect(out.pipeline.unavailable).toBe(true);
    expect(out.downloads.unavailable).toBe(true);
    expect(out.indexers.unavailable).toBe(true);
    // Rows still exist (with null fields) so the UI can render a stable shape.
    expect(out.collection.rows).toHaveLength(3);
    expect(out.collection.rows.every((r) => r.total === null)).toBe(true);
    expect(out.downloads.clients.every((c) => c.up === null)).toBe(true);
    expect(out.indexers.rows).toHaveLength(0);
  });

  it('reports a client offline when its up series is 0', async () => {
    const { reader } = stubReader({ ...LIVE, [QBITTORRENT_UP_QUERY]: [sample(0)] });
    const out = await getAppsMetrics({ prometheus: reader, includeUserAware: false, includeGrafanaLinks: false });
    const qbt = out.downloads.clients.find((c) => c.key === 'qbittorrent')!;
    expect(qbt.up).toBe(false);
    expect(qbt.detail).toBe('unreachable');
  });

  // DESIGN-016 D-07 — the LAN-only Grafana board links are attached ONLY when includeGrafanaLinks (admin),
  // and are OMITTED otherwise, independent of the level (includeUserAware) seam.
  it('attaches the admin-only Grafana links when includeGrafanaLinks, omits them otherwise', async () => {
    const { reader } = stubReader(LIVE);
    const admin = await getAppsMetrics({ prometheus: reader, includeUserAware: true, includeGrafanaLinks: true });
    expect(admin.grafana).toEqual({
      library: 'https://grafana.haynesops.com/d/arr-library-overview',
      downloads: 'https://grafana.haynesops.com/d/downloads-clients-indexers',
    });

    // A full (includeUserAware) NON-admin caller still gets NO Grafana key.
    const fullMember = await getAppsMetrics({ prometheus: reader, includeUserAware: true, includeGrafanaLinks: false });
    expect('grafana' in fullMember).toBe(false);
    expect(fullMember.grafana).toBeUndefined();
  });
});
