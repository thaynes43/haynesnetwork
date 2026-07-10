'use client';

// ADR-037 / DESIGN-016 D-05 — the Metrics Overview: WAN upload/download usage-vs-capacity meters, a
// cluster load + memory tile, and a storage-utilization snapshot (REUSING the 013 getUtilization read).
// The payload is SHAPED server-side by the caller's level — a `limited` viewer never receives
// `network.wanLinks` (the full-only per-uplink breakdown). ADR-015: the poll (45s, paused when the tab
// is hidden or not active) dims in place via placeholderData; every state shares a stable region.
import type { MetricsLevel } from '@hnet/db';
import { trpc } from '@/lib/trpc-client';
import { formatMbps, formatPct, meterTone, meterWidth, type MeterTone } from '@/lib/metrics';
import { formatCapacity, utilizationTone } from '@/lib/storage';

/** Grafana stays the LAN power tool — deep-linked, never embedded (ADR-030 C-04 / ADR-037 C-09). */
const GRAFANA_URL = 'https://grafana.haynesops.com';

function Meter({
  testId,
  label,
  valueText,
  footText,
  pct,
  tone,
}: {
  testId?: string;
  label: string;
  valueText: string;
  footText: string;
  pct: number | null;
  tone: MeterTone;
}) {
  return (
    <div className={`metrics-meter metrics-meter--${tone}`}>
      <div className="metrics-meter__head">
        <span className="metrics-meter__label">{label}</span>
        <span className="metrics-meter__value">{valueText}</span>
      </div>
      <div
        className="metrics-meter__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct === null ? 'unavailable' : `${pct}%`}
        data-testid={testId}
      >
        <div className="metrics-meter__fill" style={{ width: `${meterWidth(pct)}%` }} />
      </div>
      <div className="metrics-meter__foot muted">{footText}</div>
    </div>
  );
}

export function OverviewTab({
  active,
  metricsLevel,
}: {
  active: boolean;
  metricsLevel: MetricsLevel;
}) {
  const overview = trpc.metrics.overview.useQuery(undefined, {
    enabled: active,
    // Bounded poll; React Query auto-pauses refetchInterval while the browser tab is hidden.
    refetchInterval: active ? 45_000 : false,
    refetchOnWindowFocus: false,
    // ADR-015 — keep the previous render mounted while a refetch resolves (dim in place, no reflow).
    placeholderData: (prev) => prev,
  });
  const data = overview.data;

  if (!data) {
    return (
      <section className="metrics-overview" aria-busy="true">
        <p className="muted" data-testid="metrics-loading">
          {overview.error ? 'Metrics are unavailable right now.' : 'Loading metrics…'}
        </p>
      </section>
    );
  }

  const net = data.network;
  const hw = data.hardware;

  return (
    <section className="metrics-overview" data-testid="metrics-overview">
      {metricsLevel === 'limited' ? (
        <p className="muted" data-testid="metrics-limited-note">
          You’re seeing the shared summary. Ask an admin for full access to see per-uplink and
          user-level detail.
        </p>
      ) : null}

      {/* WAN usage vs capacity — both levels. */}
      <div className="metrics-overview__grid">
        <Meter
          testId="metrics-upload-meter"
          label="Upload"
          valueText={`${formatMbps(net.upload.usageMbps)} of ${formatMbps(net.upload.capacityMbps)}`}
          footText={`${formatPct(net.upload.pct)} of the ${formatMbps(net.upload.capacityMbps)} cap`}
          pct={net.upload.pct}
          tone={meterTone(net.upload.pct)}
        />
        <Meter
          testId="metrics-download-meter"
          label="Download"
          valueText={`${formatMbps(net.download.usageMbps)} of ${formatMbps(net.download.capacityMbps)}`}
          footText={`${formatPct(net.download.pct)} of the ${formatMbps(net.download.capacityMbps)} cap`}
          pct={net.download.pct}
          tone={meterTone(net.download.pct)}
        />
      </div>
      {net.unavailable ? (
        <p className="muted" data-testid="metrics-network-unavailable">
          Couldn’t reach the gateway — WAN throughput is unavailable right now.
        </p>
      ) : null}

      {/* Full-only: the per-uplink capacity breakdown (primary vs failover). */}
      {net.wanLinks && net.wanLinks.length > 0 ? (
        <div className="metrics-wanlinks" data-testid="metrics-wanlinks">
          <h2 className="settings-section__head">Internet uplinks</h2>
          {net.wanLinks.map((link) => (
            <div key={link.id} className="metrics-tile">
              <span className="metrics-tile__value">{link.label}</span>
              <span className="metrics-tile__label">
                {formatMbps(link.capacityUpMbps)} up · {formatMbps(link.capacityDownMbps)} down
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Cluster load + memory — ungated (both levels). */}
      <div className="metrics-overview__grid">
        <div className="metrics-tile" data-testid="metrics-cluster-tile">
          <span className="metrics-tile__label">Cluster load</span>
          <span className="metrics-tile__value">
            {hw.nodes ? `${hw.nodes.loadPerCorePct}%` : '—'}
          </span>
          <span className="metrics-tile__label">
            {hw.nodes
              ? `${hw.nodes.count} nodes · ${hw.nodes.coresTotal} cores · load ${hw.nodes.load1Total}`
              : 'unavailable'}
          </span>
        </div>
        <div className="metrics-tile" data-testid="metrics-memory-tile">
          <span className="metrics-tile__label">Cluster memory</span>
          <span className="metrics-tile__value">{hw.memory ? `${hw.memory.pct}%` : '—'}</span>
          <span className="metrics-tile__label">
            {hw.memory
              ? `${formatCapacity(hw.memory.usedBytes)} of ${formatCapacity(hw.memory.totalBytes)}`
              : 'unavailable'}
          </span>
        </div>
      </div>

      {/* Storage snapshot — REUSE of the 013 getUtilization read (not user-aware; both levels). */}
      {data.storage.length > 0 ? (
        <div className="metrics-overview__grid" data-testid="metrics-storage">
          {data.storage.map((arr) => (
            <Meter
              key={arr.key}
              label={arr.label}
              valueText={
                arr.unavailable || arr.freeSpace === null || arr.totalSpace === null
                  ? 'unavailable'
                  : `${formatCapacity(arr.freeSpace)} free of ${formatCapacity(arr.totalSpace)}`
              }
              footText={
                arr.usedPct === null
                  ? 'storage utilization unavailable'
                  : `${arr.usedPct}% used${arr.target !== null ? ` · target ${arr.target}%` : ''}`
              }
              pct={arr.usedPct}
              tone={utilizationTone(arr.usedPct, arr.target)}
            />
          ))}
        </div>
      ) : null}

      <p className="muted metrics-overview__footnote">
        Full infra dashboards:{' '}
        <a href={GRAFANA_URL} target="_blank" rel="noreferrer" data-testid="metrics-grafana-link">
          Grafana
        </a>{' '}
        (LAN only).
      </p>
    </section>
  );
}
