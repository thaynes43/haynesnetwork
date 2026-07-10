'use client';

// ADR-039 / DESIGN-019 (PLAN-020) — the Metrics → Network sub-tab. The headline: how much of the WAN
// upload/download capacity the ecosystem is consuming. `limited` roles see ONLY the two WAN usage-vs-
// capacity meters (reusing the Overview's capacity denominators) + a 7-day throughput history sparkline;
// `full` roles ADD infrastructure-performance groups (per-AP/switch/gateway CPU/mem/load, WAN health,
// site rollup counts, per-uplink caps). NO CLIENT IDENTITIES at ANY level — the server never sends the
// `infra` key to a `limited` caller, and the allow-listed `network.ts` module can't name a client series.
// Grafana stays the verbose LAN layer (deep-linked per group). ADR-015: the 45s poll (paused when the
// sub-tab is hidden/inactive) dims in place via placeholderData; each group degrades to a muted note.
import type { MetricsLevel } from '@hnet/db';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import {
  formatMbps,
  formatPct,
  formatMs,
  meterTone,
  meterWidth,
  sparklinePolyline,
  type MeterTone,
} from '@/lib/metrics';

type NetworkMetrics = RouterOutputs['metrics']['network'];
type DeviceRow = NonNullable<NetworkMetrics['infra']>['devices'][number];

/** Grafana stays the LAN power tool — deep-linked, never embedded (ADR-030 C-04 / ADR-037 C-09). The
 *  Client-Insights board is DELIBERATELY not linked — the privacy line holds in the deep-links too. */
const GRAFANA_URL = 'https://grafana.haynesops.com';
const BOARD_SITES = `${GRAFANA_URL}/d/9WaGWZaZk`; // UniFi-Poller: Network Sites (WAN + site + gateway)
const BOARD_UAP = `${GRAFANA_URL}/d/g5wFWqxZk`; // UniFi-Poller: UAP Insights (access points)
const BOARD_USW = `${GRAFANA_URL}/d/FsfxpWaZz`; // UniFi-Poller: USW Insights (switches)

/** Show at most this many device rows per group; the rest live in Grafana (curated, phone-friendly). */
const MAX_DEVICE_ROWS = 8;

function GrafanaLink({ href, testId }: { href: string; testId: string }) {
  return (
    <a
      className="metrics-group__link muted"
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
    >
      Open in Grafana ↗
    </a>
  );
}

function GroupCard({
  title,
  href,
  linkTestId,
  testId,
  unavailable,
  children,
}: {
  title: string;
  href: string;
  linkTestId: string;
  testId: string;
  unavailable: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="metrics-group" data-testid={testId}>
      <div className="metrics-group__head">
        <h2 className="metrics-group__title">{title}</h2>
        <GrafanaLink href={href} testId={linkTestId} />
      </div>
      {unavailable ? (
        <p className="muted" data-testid={`${testId}-unavailable`}>
          These numbers are unavailable right now.
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function Meter({
  testId,
  label,
  valueText,
  footText,
  pct,
  tone,
}: {
  testId: string;
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

/** A fixed-geometry SVG sparkline (ADR-015 — only the path changes on refresh, never the layout). */
function Sparkline({ values, label, testId }: { values: number[]; label: string; testId: string }) {
  const W = 240;
  const H = 40;
  const points = sparklinePolyline(values, W, H);
  return (
    <div className="metrics-spark" data-testid={testId}>
      <span className="metrics-tile__label">{label}</span>
      {points === '' ? (
        <span className="muted metrics-spark__empty">no history</span>
      ) : (
        <svg
          className="metrics-spark__svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label} — last several days`}
        >
          <polyline className="metrics-spark__line" points={points} />
        </svg>
      )}
    </div>
  );
}

function DeviceTable({
  title,
  rows,
  href,
  linkTestId,
  testId,
}: {
  title: string;
  rows: DeviceRow[];
  href: string;
  linkTestId: string;
  testId: string;
}) {
  const shown = rows.slice(0, MAX_DEVICE_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <GroupCard
      title={title}
      href={href}
      linkTestId={linkTestId}
      testId={testId}
      unavailable={rows.length === 0}
    >
      <div className="metrics-apps-tablewrap">
        <table className="metrics-apps-table">
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">CPU</th>
              <th scope="col">Memory</th>
              <th scope="col">Load</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.name} data-testid={`${testId}-row`}>
                <th scope="row">{d.name}</th>
                <td className={d.cpuPct !== null && d.cpuPct >= 85 ? 'metrics-apps-warn' : undefined}>
                  {formatPct(d.cpuPct)}
                </td>
                <td className={d.memPct !== null && d.memPct >= 90 ? 'metrics-apps-warn' : undefined}>
                  {formatPct(d.memPct)}
                </td>
                <td>{d.load1 === null ? '—' : d.load1.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? (
        <p className="muted metrics-overview__footnote">
          +{hidden} more in{' '}
          <a href={href} target="_blank" rel="noreferrer">
            Grafana
          </a>
          .
        </p>
      ) : null}
    </GroupCard>
  );
}

export function NetworkTab({ active }: { active: boolean; metricsLevel: MetricsLevel }) {
  const network = trpc.metrics.network.useQuery(undefined, {
    enabled: active,
    // Bounded poll; React Query auto-pauses refetchInterval while the browser tab is hidden.
    refetchInterval: active ? 45_000 : false,
    refetchOnWindowFocus: false,
    // ADR-015 — keep the previous render mounted while a refetch resolves (dim in place, no reflow).
    placeholderData: (prev) => prev,
  });
  const data = network.data;

  if (!data) {
    return (
      <section className="metrics-overview" aria-busy="true">
        <p className="muted" data-testid="metrics-net-loading">
          {network.error ? 'Network metrics are unavailable right now.' : 'Loading network metrics…'}
        </p>
      </section>
    );
  }

  const wan = data.wan;
  const infra = data.infra;
  const gateways = infra?.devices.filter((d) => d.category === 'gateway') ?? [];
  const switches = infra?.devices.filter((d) => d.category === 'switch') ?? [];
  const aps = infra?.devices.filter((d) => d.category === 'ap') ?? [];

  return (
    <section className="metrics-overview" data-testid="metrics-network">
      {data.level === 'limited' ? (
        <p className="muted" data-testid="metrics-net-limited-note">
          You’re seeing WAN usage vs capacity. Ask an admin for full access to see per-device
          infrastructure performance.
        </p>
      ) : null}

      {/* WAN usage vs capacity — both levels (the headline). */}
      <div className="metrics-overview__grid">
        <Meter
          testId="metrics-net-upload-meter"
          label="Upload"
          valueText={`${formatMbps(wan.upload.usageMbps)} of ${formatMbps(wan.upload.capacityMbps)}`}
          footText={`${formatPct(wan.upload.pct)} of the ${formatMbps(wan.upload.capacityMbps)} up cap`}
          pct={wan.upload.pct}
          tone={meterTone(wan.upload.pct)}
        />
        <Meter
          testId="metrics-net-download-meter"
          label="Download"
          valueText={`${formatMbps(wan.download.usageMbps)} of ${formatMbps(wan.download.capacityMbps)}`}
          footText={`${formatPct(wan.download.pct)} of the ${formatMbps(wan.download.capacityMbps)} down cap`}
          pct={wan.download.pct}
          tone={meterTone(wan.download.pct)}
        />
      </div>
      {wan.unavailable ? (
        <p className="muted" data-testid="metrics-net-unavailable">
          Couldn’t reach the gateway — WAN throughput is unavailable right now.
        </p>
      ) : null}

      {/* WAN throughput history — both levels (the limited value-add over the Overview). */}
      {!data.history.unavailable ? (
        <section className="metrics-group" data-testid="metrics-net-history">
          <div className="metrics-group__head">
            <h2 className="metrics-group__title">WAN throughput · last {data.history.rangeDays} days</h2>
            <GrafanaLink href={BOARD_SITES} testId="metrics-net-history-grafana" />
          </div>
          <div className="metrics-overview__grid">
            <Sparkline
              values={data.history.upload.map((p) => p.mbps)}
              label="Upload (Mbps)"
              testId="metrics-net-spark-up"
            />
            <Sparkline
              values={data.history.download.map((p) => p.mbps)}
              label="Download (Mbps)"
              testId="metrics-net-spark-down"
            />
          </div>
        </section>
      ) : null}

      {/* FULL-ONLY: infrastructure performance (no client identities, ever). */}
      {infra ? (
        <>
          <DeviceTable
            title="Gateway"
            rows={gateways}
            href={BOARD_SITES}
            linkTestId="metrics-net-gateway-grafana"
            testId="metrics-net-gateway"
          />

          {/* WAN health — the gateway speedtest + internet-path latency. */}
          <GroupCard
            title="WAN health"
            href={BOARD_SITES}
            linkTestId="metrics-net-wanhealth-grafana"
            testId="metrics-net-wanhealth"
            unavailable={infra.wanHealth.unavailable}
          >
            <div className="metrics-overview__grid">
              <div className="metrics-tile" data-testid="metrics-net-speedtest">
                <span className="metrics-tile__label">Last speedtest</span>
                <span className="metrics-tile__value">{formatMbps(infra.wanHealth.speedtestDownMbps)}</span>
                <span className="metrics-tile__label">
                  ↓ down · {formatMbps(infra.wanHealth.speedtestUpMbps)} ↑ up ·{' '}
                  {formatMs(infra.wanHealth.speedtestLatencyMs)}
                </span>
              </div>
              <div className="metrics-tile" data-testid="metrics-net-latency">
                <span className="metrics-tile__label">Internet latency</span>
                <span className="metrics-tile__value">{formatMs(infra.wanHealth.siteLatencyMs)}</span>
                <span className="metrics-tile__label">
                  worst uplink {formatMs(infra.wanHealth.uplinkLatencyMs)}
                </span>
              </div>
            </div>
          </GroupCard>

          <DeviceTable
            title="Switches"
            rows={switches}
            href={BOARD_USW}
            linkTestId="metrics-net-switch-grafana"
            testId="metrics-net-switch"
          />
          <DeviceTable
            title="Access points"
            rows={aps}
            href={BOARD_UAP}
            linkTestId="metrics-net-ap-grafana"
            testId="metrics-net-ap"
          />

          {/* Per-uplink capacity (primary vs failover) — generic "Internet 1/2", no ISP identity. */}
          {wan.wanLinks && wan.wanLinks.length > 0 ? (
            <section className="metrics-group" data-testid="metrics-net-wanlinks">
              <div className="metrics-group__head">
                <h2 className="metrics-group__title">Internet uplinks</h2>
                <GrafanaLink href={BOARD_SITES} testId="metrics-net-wanlinks-grafana" />
              </div>
              <div className="metrics-overview__grid">
                {wan.wanLinks.map((link) => (
                  <div className="metrics-tile" key={link.id}>
                    <span className="metrics-tile__value">{link.label}</span>
                    <span className="metrics-tile__label">
                      {formatMbps(link.capacityUpMbps)} up · {formatMbps(link.capacityDownMbps)} down
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Site rollup COUNTS — aggregates, never per-client rows. */}
          <GroupCard
            title="Site rollup"
            href={BOARD_SITES}
            linkTestId="metrics-net-site-grafana"
            testId="metrics-net-site"
            unavailable={infra.site.unavailable}
          >
            <div className="metrics-overview__grid">
              <div className="metrics-tile">
                <span className="metrics-tile__label">Access points</span>
                <span className="metrics-tile__value">{infra.site.aps ?? '—'}</span>
              </div>
              <div className="metrics-tile">
                <span className="metrics-tile__label">Switches</span>
                <span className="metrics-tile__value">{infra.site.switches ?? '—'}</span>
              </div>
              <div className="metrics-tile">
                <span className="metrics-tile__label">Gateways</span>
                <span className="metrics-tile__value">{infra.site.gateways ?? '—'}</span>
              </div>
              <div className="metrics-tile" data-testid="metrics-net-stations">
                <span className="metrics-tile__label">Connected devices</span>
                <span className="metrics-tile__value">{infra.site.stations ?? '—'}</span>
                <span className="metrics-tile__label">aggregate count only</span>
              </div>
            </div>
          </GroupCard>
        </>
      ) : null}

      <p className="muted metrics-overview__footnote">
        Curated highlights — no client devices are shown here by design. Full network dashboards live in{' '}
        <a href={BOARD_SITES} target="_blank" rel="noreferrer" data-testid="metrics-net-grafana-link">
          Grafana
        </a>{' '}
        (LAN only).
      </p>
    </section>
  );
}
