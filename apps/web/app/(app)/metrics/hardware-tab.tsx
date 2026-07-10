'use client';

// ADR-040 / DESIGN-020 (PLAN-019) — the Metrics → Hardware sub-tab. The headline is the NVMe endurance
// panel: per-pool framing (the appdata MIRROR vs the expendable staging pool) with a wear odometer, a
// projection-to-90 %, and the real end-of-life signals. Plus a Drive-health table (a sleeping array disk
// emits no series ⇒ it is simply absent, never a red row), Node load, and the Proxmox host→VM showcase.
// UNGATED (owner ruling — the same payload at `full` and `limited`; hardware is not user-aware). Grafana
// stays the verbose layer (deep-linked per group). ADR-015: the 45 s poll (paused when the sub-tab is
// hidden/inactive) dims in place via placeholderData; each group degrades to a muted note; the host→VM
// expander is a deliberate in-place expansion (ADR-015 allowed exception).
import type { MetricsLevel } from '@hnet/db';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { formatCapacity } from '@/lib/storage';
import { formatHours, formatPct, formatUptime, meterTone, meterWidth, type MeterTone } from '@/lib/metrics';

type HardwareMetrics = RouterOutputs['metrics']['hardware'];
type NvmePool = HardwareMetrics['pools'][number];
type DriveHealth = HardwareMetrics['drives'][number];
type NodeLoad = HardwareMetrics['nodes'][number];
type PveHost = HardwareMetrics['pveHosts'][number];
type HardwareGrafana = NonNullable<HardwareMetrics['grafana']>;

// Grafana stays the power tool — deep-linked, never embedded (ADR-030 C-04 / ADR-037 C-09). The board
// URLs resolve ONLY on the owner's LAN/VPN, so they are ADMIN-ONLY (DESIGN-016 D-07): the server sends
// `data.grafana` only to an admin caller, so `href` is undefined for a member and the per-group link is
// simply not rendered. Reflow-free (ADR-015) — presence is fixed for the session, nothing toggles.

function GrafanaLink({ href, testId }: { href?: string; testId: string }) {
  if (!href) return null;
  return (
    <a className="metrics-group__link muted" href={href} target="_blank" rel="noreferrer" data-testid={testId}>
      Open in Grafana ↗
    </a>
  );
}

function GroupCard({
  title,
  href,
  linkTestId,
  testId,
  children,
  className,
}: {
  title: string;
  href?: string;
  linkTestId: string;
  testId: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`metrics-group${className ? ` ${className}` : ''}`} data-testid={testId}>
      <div className="metrics-group__head">
        <h2 className="metrics-group__title">{title}</h2>
        <GrafanaLink href={href} testId={linkTestId} />
      </div>
      {children}
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

const PILL_LABEL: Record<DriveHealth['health'], string> = {
  healthy: 'Healthy',
  warn: 'Watch',
  fail: 'Failed',
};

function StatusPill({ health }: { health: DriveHealth['health'] }) {
  return (
    <span className={`metrics-pill metrics-pill--${health}`} data-testid="metrics-hw-pill">
      {PILL_LABEL[health]}
    </span>
  );
}

/** NVMe endurance pool card — the acceptance panel (per-pool framing + wear + projection). */
function PoolCard({ pool, href }: { pool: NvmePool; href?: string }) {
  return (
    <section
      className={`metrics-group metrics-pool metrics-pool--${pool.framing}`}
      data-testid={`metrics-hw-pool-${pool.name}`}
    >
      <div className="metrics-group__head">
        <h3 className="metrics-group__title">
          {pool.name}{' '}
          <span className="metrics-pool__badge" data-testid="metrics-hw-pool-framing">
            {pool.framing === 'critical' ? 'critical' : 'expendable'}
          </span>
        </h3>
        <GrafanaLink href={href} testId={`metrics-hw-pool-grafana-${pool.name}`} />
      </div>
      <p className="metrics-pool__topology">{pool.topology}</p>
      <p className="metrics-pool__status" data-testid={`metrics-hw-pool-status-${pool.name}`}>
        {pool.statusLine}
      </p>
      <div className="metrics-overview__grid">
        {pool.members.map((m) => (
          <Meter
            key={m.driveKey}
            testId={`metrics-hw-poolwear-${m.driveKey}`}
            label={`${m.device} wear`}
            valueText={formatPct(m.wearPct)}
            footText={`${m.smartStatus === 'pass' ? 'passing' : 'SMART FAILED'} · spare ${formatPct(m.availableSpare)}`}
            pct={m.wearPct}
            tone={m.smartStatus === 'fail' ? 'danger' : meterTone(m.wearPct)}
          />
        ))}
      </div>
      <p className="metrics-pool__facts">
        <span>spare {formatPct(pool.minAvailableSpare)} (fails at {formatPct(pool.spareThreshold)})</span>
        <span>{pool.totalMediaErrors} media errors</span>
        <span>{pool.criticalWarningActive ? 'critical-warning bit set' : 'no critical warnings'}</span>
        <span>
          {pool.projection.insufficientHistory
            ? 'wear projection: insufficient history yet'
            : `wear ~${pool.projection.weeklyRatePct}%/wk`}
        </span>
      </p>
    </section>
  );
}

function DriveTable({ drives }: { drives: DriveHealth[] }) {
  return (
    <div className="metrics-apps-tablewrap">
      <table className="metrics-apps-table">
        <thead>
          <tr>
            <th scope="col">Drive</th>
            <th scope="col">Health</th>
            <th scope="col">Wear</th>
            <th scope="col">Temp</th>
            <th scope="col">Powered on</th>
            <th scope="col">Media errors</th>
          </tr>
        </thead>
        <tbody>
          {drives.map((d) => (
            <tr key={d.driveKey} data-testid="metrics-hw-drive-row">
              <th scope="row">
                {d.label}
                {d.pool ? <span className="muted"> · {d.pool}</span> : null}
              </th>
              <td>
                <StatusPill health={d.health} />
              </td>
              <td className={d.wearPct !== null && d.wearPct >= 90 ? 'metrics-apps-warn' : undefined}>
                {formatPct(d.wearPct)}
              </td>
              <td className={d.tempC !== null && d.tempC >= 65 ? 'metrics-apps-warn' : undefined}>
                {d.tempC === null ? '—' : `${d.tempC}°C`}
              </td>
              <td>{formatHours(d.powerOnHours)}</td>
              <td className={d.mediaErrors !== null && d.mediaErrors > 0 ? 'metrics-apps-warn' : undefined}>
                {d.mediaErrors ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeCard({ node }: { node: NodeLoad }) {
  return (
    <div className="metrics-tile" data-testid={`metrics-hw-node-${node.name}`}>
      <span className="metrics-tile__label">
        {node.name}
        {node.role === 'nas' ? ' · NAS' : ''}
      </span>
      <div className="metrics-overview__grid">
        <Meter
          testId={`metrics-hw-nodeload-${node.name}`}
          label="Load / core"
          valueText={formatPct(node.loadPerCorePct)}
          footText={`load ${node.load1 ?? '—'} across ${node.cores ?? '—'} cores`}
          pct={node.loadPerCorePct}
          tone={meterTone(node.loadPerCorePct)}
        />
        <Meter
          testId={`metrics-hw-nodemem-${node.name}`}
          label="Memory"
          valueText={formatPct(node.memPct)}
          footText={
            node.memUsedBytes !== null && node.memTotalBytes !== null
              ? `${formatCapacity(node.memUsedBytes)} of ${formatCapacity(node.memTotalBytes)}`
              : 'unavailable'
          }
          pct={node.memPct}
          tone={meterTone(node.memPct)}
        />
      </div>
      <span className="metrics-tile__label">
        {node.hottestTempC === null ? 'temp —' : `hottest sensor ${node.hottestTempC}°C`}
      </span>
    </div>
  );
}

function HostTile({ host }: { host: PveHost }) {
  return (
    <details className="metrics-host" data-testid={`metrics-hw-pve-${host.name}`}>
      <summary className="metrics-host__summary">
        <span className="metrics-host__name">
          {host.name}
          {host.up ? '' : <span className="metrics-host__down"> · down</span>}
        </span>
        <span className="metrics-host__meta">
          CPU {formatPct(host.cpuPct)} · mem {formatPct(host.memPct)} · up {formatUptime(host.uptimeSeconds)} ·{' '}
          {host.vms.length} VM{host.vms.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="metrics-host__vms">
        <div className="metrics-apps-tablewrap">
          <table className="metrics-apps-table">
            <thead>
              <tr>
                <th scope="col">VM</th>
                <th scope="col">State</th>
                <th scope="col">CPU</th>
                <th scope="col">Memory</th>
              </tr>
            </thead>
            <tbody>
              {host.vms.map((vm) => (
                <tr key={vm.id} data-testid="metrics-hw-vm-row">
                  <th scope="row">{vm.name}</th>
                  <td className={vm.up ? undefined : 'metrics-host__down'}>{vm.up ? 'running' : 'stopped'}</td>
                  <td>{formatPct(vm.cpuPct)}</td>
                  <td>
                    {vm.memUsedBytes !== null && vm.memTotalBytes !== null
                      ? `${formatCapacity(vm.memUsedBytes)} / ${formatCapacity(vm.memTotalBytes)}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

export function HardwareTab({ active }: { active: boolean; metricsLevel: MetricsLevel }) {
  const hardware = trpc.metrics.hardware.useQuery(undefined, {
    enabled: active,
    // Bounded poll; React Query auto-pauses refetchInterval while the browser tab is hidden.
    refetchInterval: active ? 45_000 : false,
    refetchOnWindowFocus: false,
    // ADR-015 — keep the previous render mounted while a refetch resolves (dim in place, no reflow).
    placeholderData: (prev) => prev,
  });
  const data = hardware.data;

  if (!data) {
    return (
      <section className="metrics-overview" aria-busy="true">
        <p className="muted" data-testid="metrics-hw-loading">
          {hardware.error ? 'Hardware metrics are unavailable right now.' : 'Loading hardware metrics…'}
        </p>
      </section>
    );
  }

  // Admin-only (D-07): `data.grafana` is present only for an admin caller — members get no board links.
  const g: HardwareGrafana | undefined = data.grafana;

  return (
    <section className="metrics-overview" data-testid="metrics-hardware">
      {/* NVMe endurance — the headline (R-129). */}
      {data.pools.length > 0 ? (
        <>
          {data.pools.map((pool) => (
            <PoolCard key={pool.name} pool={pool} href={g?.nas} />
          ))}
        </>
      ) : (
        <p className="muted" data-testid="metrics-hw-pools-unavailable">
          NVMe endurance data is unavailable right now.
        </p>
      )}

      {/* Drive health — every reporting SMART device (asleep array disks are simply absent). */}
      <GroupCard
        title="Drive health"
        href={g?.smart}
        linkTestId="metrics-hw-drives-grafana"
        testId="metrics-hw-drives"
      >
        {data.drives.length > 0 ? (
          <DriveTable drives={data.drives} />
        ) : (
          <p className="muted" data-testid="metrics-hw-drives-unavailable">
            SMART data is unavailable right now.
          </p>
        )}
        <p className="muted metrics-overview__footnote">
          Sleeping array disks report no SMART series and are shown as asleep (omitted) — never as a fault.
        </p>
      </GroupCard>

      {/* Node load — cluster + NAS. */}
      <GroupCard title="Node load" href={g?.nodes} linkTestId="metrics-hw-nodes-grafana" testId="metrics-hw-nodes">
        {data.nodes.length > 0 ? (
          <div className="metrics-overview__grid">
            {data.nodes.map((node) => (
              <NodeCard key={node.name} node={node} />
            ))}
          </div>
        ) : (
          <p className="muted" data-testid="metrics-hw-nodes-unavailable">
            Node load is unavailable right now.
          </p>
        )}
      </GroupCard>

      {/* Proxmox showcase — host tiles expand in place to their VMs (ADR-015 allowed exception). */}
      <GroupCard
        title="Proxmox hosts"
        href={g?.pve}
        linkTestId="metrics-hw-pve-grafana"
        testId="metrics-hw-pve"
      >
        {data.pveHosts.length > 0 ? (
          <div className="metrics-overview__grid">
            {data.pveHosts.map((host) => (
              <HostTile key={host.name} host={host} />
            ))}
          </div>
        ) : (
          <p className="muted" data-testid="metrics-hw-pve-unavailable">
            Proxmox host data is unavailable right now.
          </p>
        )}
      </GroupCard>

      {g ? (
        <p className="muted metrics-overview__footnote">
          Curated highlights — the verbose disk, node, and Proxmox dashboards live in{' '}
          <a href={g.nas} target="_blank" rel="noreferrer" data-testid="metrics-hw-grafana-link">
            Grafana
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}
