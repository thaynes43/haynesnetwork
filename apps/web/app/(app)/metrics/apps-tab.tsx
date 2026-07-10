'use client';

// DESIGN-018 (PLAN-018) — the Metrics → Apps sub-tab: the media-automation apps (*arr + downloaders +
// indexers) in four curated, phone-friendly groups, each with a muted "Open in Grafana ↗" deep-link to
// the matching curated board. Read from the same in-cluster Prometheus as the Overview (@hnet/metrics).
// Both-levels: no *arr/downloader series names a user (ADR-037 C-03 / D-05), so nothing here is hidden
// at `limited`. ADR-015: the 45s poll (paused when the tab is hidden/inactive) dims in place via
// placeholderData; each group degrades to a muted "unavailable" note, never a crash.
import type { MetricsLevel } from '@hnet/db';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { formatCount, formatMs, formatPerHour } from '@/lib/metrics';
import { formatCapacity } from '@/lib/storage';

type AppsMetrics = RouterOutputs['metrics']['apps'];

/** Grafana stays the LAN power tool — deep-linked, never embedded (ADR-030 C-04 / ADR-037 C-09). */
const GRAFANA_URL = 'https://grafana.haynesops.com';
const BOARD_LIBRARY = `${GRAFANA_URL}/d/arr-library-overview`;
const BOARD_DOWNLOADS = `${GRAFANA_URL}/d/downloads-clients-indexers`;

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

function num(n: number | null): string {
  return formatCount(n);
}

function CollectionGroup({ group }: { group: AppsMetrics['collection'] }) {
  return (
    <GroupCard
      title="Collection"
      href={BOARD_LIBRARY}
      linkTestId="metrics-apps-collection-grafana"
      testId="metrics-apps-collection"
      unavailable={group.unavailable}
    >
      <div className="metrics-apps-tablewrap">
        <table className="metrics-apps-table">
          <thead>
            <tr>
              <th scope="col">Library</th>
              <th scope="col">Total</th>
              <th scope="col">Monitored</th>
              <th scope="col">Missing</th>
              <th scope="col">Upgrades</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r) => (
              <tr key={r.key} data-testid={`metrics-apps-lib-${r.key}`}>
                <th scope="row">{r.label}</th>
                <td>{num(r.total)}</td>
                <td>{num(r.monitored)}</td>
                <td>{num(r.missing)}</td>
                <td>{r.cutoffUnmet === null ? '—' : num(r.cutoffUnmet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GroupCard>
  );
}

function PipelineGroup({ group }: { group: AppsMetrics['pipeline'] }) {
  return (
    <GroupCard
      title="Acquisition pipeline"
      href={BOARD_LIBRARY}
      linkTestId="metrics-apps-pipeline-grafana"
      testId="metrics-apps-pipeline"
      unavailable={group.unavailable}
    >
      <div className="metrics-apps-tablewrap">
        <table className="metrics-apps-table">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">Queue</th>
              <th scope="col">Grabs</th>
              <th scope="col">Health</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r) => (
              <tr key={r.key} data-testid={`metrics-apps-pipe-${r.key}`}>
                <th scope="row">{r.label}</th>
                <td>{num(r.queue)}</td>
                <td>{formatPerHour(r.grabsPerHour)}</td>
                <td className={r.healthIssues && r.healthIssues > 0 ? 'metrics-apps-warn' : undefined}>
                  {r.healthIssues === null ? '—' : r.healthIssues === 0 ? 'OK' : num(r.healthIssues)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GroupCard>
  );
}

function formatSpeed(bps: number | null): string {
  if (bps === null) return '—';
  if (bps <= 0) return 'idle';
  return `${formatCapacity(bps)}/s`;
}

function DownloadsGroup({ group }: { group: AppsMetrics['downloads'] }) {
  return (
    <GroupCard
      title="Download clients"
      href={BOARD_DOWNLOADS}
      linkTestId="metrics-apps-downloads-grafana"
      testId="metrics-apps-downloads"
      unavailable={group.unavailable}
    >
      <div className="metrics-overview__grid">
        {group.usenet.map((lane) => (
          <div className="metrics-tile" key={lane.key} data-testid={`metrics-apps-sab-${lane.key}`}>
            <span className="metrics-tile__label">{lane.label}</span>
            <span className="metrics-tile__value">{formatSpeed(lane.speedBps)}</span>
            <span className="metrics-tile__label">
              {formatCapacity(lane.downloaded24hBytes ?? 0)} in 24h · queue{' '}
              {lane.queueLength === null ? '—' : num(lane.queueLength)}
              {lane.remainingBytes && lane.remainingBytes > 0
                ? ` · ${formatCapacity(lane.remainingBytes)} left`
                : ''}
            </span>
          </div>
        ))}
        {group.clients.map((c) => (
          <div className="metrics-tile" key={c.key} data-testid={`metrics-apps-client-${c.key}`}>
            <span className="metrics-tile__label">{c.label}</span>
            <span
              className={`metrics-tile__value ${
                c.up === false ? 'metrics-apps-warn' : ''
              }`.trimEnd()}
            >
              {c.up === null ? '—' : c.up ? 'Online' : 'Offline'}
            </span>
            <span className="metrics-tile__label">{c.detail}</span>
          </div>
        ))}
      </div>
    </GroupCard>
  );
}

function IndexersGroup({ group }: { group: AppsMetrics['indexers'] }) {
  return (
    <GroupCard
      title="Indexers · Prowlarr"
      href={BOARD_DOWNLOADS}
      linkTestId="metrics-apps-indexers-grafana"
      testId="metrics-apps-indexers"
      unavailable={group.unavailable}
    >
      <div className="metrics-overview__grid">
        <div className="metrics-tile" data-testid="metrics-apps-indexers-enabled">
          <span className="metrics-tile__label">Indexers enabled</span>
          <span className="metrics-tile__value">{num(group.enabled)}</span>
          <span className="metrics-tile__label">
            {group.unavailableCount === null
              ? 'availability unknown'
              : `${num(group.unavailableCount)} unavailable`}
          </span>
        </div>
      </div>
      {group.rows.length > 0 ? (
        <div className="metrics-apps-tablewrap">
          <table className="metrics-apps-table">
            <thead>
              <tr>
                <th scope="col">Indexer</th>
                <th scope="col">Avg response</th>
                <th scope="col">Queries</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((r) => (
                <tr key={r.indexer} data-testid={`metrics-apps-indexer-${r.indexer}`}>
                  <th scope="row">{r.indexer}</th>
                  <td>{formatMs(r.avgResponseMs)}</td>
                  <td>{formatPerHour(r.queriesPerHour)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </GroupCard>
  );
}

export function AppsTab({ active }: { active: boolean; metricsLevel: MetricsLevel }) {
  const apps = trpc.metrics.apps.useQuery(undefined, {
    enabled: active,
    // Bounded poll; React Query auto-pauses refetchInterval while the browser tab is hidden.
    refetchInterval: active ? 45_000 : false,
    refetchOnWindowFocus: false,
    // ADR-015 — keep the previous render mounted while a refetch resolves (dim in place, no reflow).
    placeholderData: (prev) => prev,
  });
  const data = apps.data;

  if (!data) {
    return (
      <section className="metrics-overview" aria-busy="true">
        <p className="muted" data-testid="metrics-apps-loading">
          {apps.error ? 'App metrics are unavailable right now.' : 'Loading app metrics…'}
        </p>
      </section>
    );
  }

  return (
    <section className="metrics-overview" data-testid="metrics-apps">
      <CollectionGroup group={data.collection} />
      <PipelineGroup group={data.pipeline} />
      <DownloadsGroup group={data.downloads} />
      <IndexersGroup group={data.indexers} />
      <p className="muted metrics-overview__footnote">
        These are curated highlights. Full app dashboards live in{' '}
        <a href={BOARD_LIBRARY} target="_blank" rel="noreferrer" data-testid="metrics-apps-grafana-link">
          Grafana
        </a>{' '}
        (LAN only).
      </p>
    </section>
  );
}
