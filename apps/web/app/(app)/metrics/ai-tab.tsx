'use client';

// ADR-044 / DESIGN-022 (PLAN-021) — the Metrics → AI sub-tab: Open WebUI usage from the synced
// ai_usage_chats mirror (@hnet/domain getAiUsage). LEVEL-SHAPED (ADR-044 C-03, mirrors 017): `limited`
// renders aggregate counts (# chats, # image generations) + the per-day trend sparklines ONLY; `full`
// /admin ADDS the per-model ("for what") and per-user ("who / how long") tables. The server never sends a
// user id/name to a `limited` caller (getAiUsage omits byUser/byModel), so the detail tables simply do not
// exist in that payload — nothing to hide client-side. ADR-015: the 60s poll (paused when the tab is
// hidden/inactive) dims in place via placeholderData; the range control recolors, never relayouts.
import { useState } from 'react';
import type { MetricsLevel } from '@hnet/db';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { formatCount, formatDurationMs, sparklinePolyline } from '@/lib/metrics';

type AiUsage = RouterOutputs['metrics']['aiUsage'];
// The range union mirrors @hnet/domain AI_USAGE_RANGES (the tRPC input z.enum). Kept as a literal here so
// the client needs no domain import; the server validates the value against the same set.
type AiUsageRange = '7d' | '30d' | '90d' | 'all';

const RANGES: { key: AiUsageRange; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
];

/** A stat tile (reuses the 017/018 tile idiom). */
function Tile({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId: string;
}) {
  return (
    <div className="metrics-tile" data-testid={testId}>
      <span className="metrics-tile__label">{label}</span>
      <span className="metrics-tile__value">{value}</span>
      {sub ? <span className="metrics-tile__label">{sub}</span> : null}
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
        <span className="muted metrics-spark__empty">no history yet</span>
      ) : (
        <svg
          className="metrics-spark__svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label} — over the selected window`}
        >
          <polyline className="metrics-spark__line" points={points} />
        </svg>
      )}
    </div>
  );
}

/** FULL/admin — the "for what" primary-model breakdown. */
function ModelTable({ rows }: { rows: NonNullable<AiUsage['byModel']> }) {
  return (
    <section className="metrics-group" data-testid="metrics-ai-models">
      <div className="metrics-group__head">
        <h2 className="metrics-group__title">By model</h2>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No usage in this window.</p>
      ) : (
        <div className="metrics-apps-tablewrap">
          <table className="metrics-apps-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Chats</th>
                <th scope="col">Images</th>
                <th scope="col">Messages</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} data-testid={`metrics-ai-model-${r.model}`}>
                  <th scope="row">{r.model}</th>
                  <td>{formatCount(r.chats)}</td>
                  <td>{formatCount(r.imageGenerations)}</td>
                  <td>{formatCount(r.messages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** FULL/admin — the "who / how long" per-user attribution. */
function UserTable({ rows }: { rows: NonNullable<AiUsage['byUser']> }) {
  return (
    <section className="metrics-group" data-testid="metrics-ai-users">
      <div className="metrics-group__head">
        <h2 className="metrics-group__title">By user</h2>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No usage in this window.</p>
      ) : (
        <div className="metrics-apps-tablewrap">
          <table className="metrics-apps-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Chats</th>
                <th scope="col">Images</th>
                <th scope="col">Time</th>
                <th scope="col">Models</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} data-testid={`metrics-ai-user-${r.userId}`}>
                  <th scope="row">{r.name ?? r.email ?? r.userId}</th>
                  <td>{formatCount(r.chats)}</td>
                  <td>{formatCount(r.imageGenerations)}</td>
                  <td>{formatDurationMs(r.totalDurationMs)}</td>
                  <td>{r.models.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RangeSelector({
  value,
  onChange,
}: {
  value: AiUsageRange;
  onChange: (r: AiUsageRange) => void;
}) {
  return (
    <div className="metrics-range" role="group" aria-label="Usage window" data-testid="metrics-ai-range">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          className="metrics-range__btn"
          aria-pressed={value === r.key}
          data-testid={`metrics-ai-range-${r.key}`}
          onClick={() => onChange(r.key)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function AiTab({ active }: { active: boolean; metricsLevel: MetricsLevel }) {
  const [range, setRange] = useState<AiUsageRange>('30d');
  const usage = trpc.metrics.aiUsage.useQuery(
    { range },
    {
      enabled: active,
      // Bounded poll; React Query auto-pauses refetchInterval while the browser tab is hidden.
      refetchInterval: active ? 60_000 : false,
      refetchOnWindowFocus: false,
      // ADR-015 — keep the previous render mounted while a refetch resolves (dim in place, no reflow).
      placeholderData: (prev) => prev,
    },
  );
  const data = usage.data;

  if (!data) {
    return (
      <section className="metrics-overview" aria-busy="true">
        <p className="muted" data-testid="metrics-ai-loading">
          {usage.error ? 'AI usage is unavailable right now.' : 'Loading AI usage…'}
        </p>
      </section>
    );
  }

  return (
    <section className="metrics-overview" data-testid="metrics-ai">
      <RangeSelector value={range} onChange={setRange} />

      <div className="metrics-overview__grid">
        <Tile label="Chats" value={formatCount(data.totals.chats)} testId="metrics-ai-chats" />
        <Tile
          label="Image generations"
          value={formatCount(data.totals.imageGenerations)}
          testId="metrics-ai-images"
        />
        <Tile label="Messages" value={formatCount(data.totals.messages)} testId="metrics-ai-messages" />
        {/* FULL-only: a distinct-user count is user-aware, so it is null (hidden) at `limited`. */}
        {data.totals.activeUsers !== null ? (
          <Tile
            label="Active users"
            value={formatCount(data.totals.activeUsers)}
            testId="metrics-ai-users-count"
          />
        ) : null}
      </div>

      <div className="metrics-overview__grid">
        <Sparkline
          values={data.series.map((p) => p.chats)}
          label="Chats per day"
          testId="metrics-ai-spark-chats"
        />
        <Sparkline
          values={data.series.map((p) => p.imageGenerations)}
          label="Image generations per day"
          testId="metrics-ai-spark-images"
        />
      </div>

      {/* FULL/admin only (ADR-044 C-03) — the payload carries byModel/byUser only for an admin caller. */}
      {data.byModel ? <ModelTable rows={data.byModel} /> : null}
      {data.byUser ? (
        <UserTable rows={data.byUser} />
      ) : (
        <p className="muted metrics-overview__footnote" data-testid="metrics-ai-limited-note">
          Chat and image-generation totals are shown for everyone. Per-user detail (who used it, for how
          long, and which models) is available to admins.
        </p>
      )}

      <p className="muted metrics-overview__footnote">
        Synced from Open WebUI{data.syncedAt ? ` · updated ${new Date(data.syncedAt).toLocaleString()}` : ''}.
      </p>
    </section>
  );
}
