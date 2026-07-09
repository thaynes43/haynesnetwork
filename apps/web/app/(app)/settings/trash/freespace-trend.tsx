'use client';

// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — the NATIVE free-space trend chart, replacing
// the LAN-only Grafana deep-link card on the Storage tab (the old dashboard stays reachable via the
// muted footnote for LAN power use). Dependency-free inline SVG in the reclaim-strip school:
//   • one 2px line per physical array (the SAME array grouping as the meters above), series colors
//     from theme tokens only (accent = HaynesTower, progress = Music) — identity is carried by the
//     legend + direct end-labels, never color alone;
//   • the space target drawn as a DASHED free-bytes floor with a label (dashes are reserved for
//     thresholds; gridlines stay solid hairlines);
//   • hover-free by design (mobile-first): direct end-labels + a legend with current values carry
//     every reading — nothing is gated behind a pointer;
//   • honest axes: zero-based free-bytes scale on round ticks, sparse UTC date ticks, and a
//     "history begins …" note when Prometheus retention covers less than the window;
//   • ADR-015: the plot region is FIXED-height for every state (loading / chart / degraded / no
//     history); a window switch dims and swaps in place — nothing reflows.
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import {
  TREND_WINDOW_OPTIONS,
  trendGeometry,
  trendLegendValue,
  type StorageTrendReport,
  type TrendGeometry,
  type TrendWindow,
} from '@/lib/storage-trend';

/** ADR-030 C-04 (amended 2026-07-09) — the retired deep-link target, kept as the LAN footnote. */
const GRAFANA_TREND_URL = 'https://grafana.haynesops.com/d/media-storage-utilization';

/** The fixed plot height (px). The SVG viewBox is `0 0 100 PLOT_H` under preserveAspectRatio="none",
 *  so x is percent-of-width and y is real pixels — HTML labels share the same coordinates. */
const PLOT_H = 200;

function TrendPlot({ geometry }: { geometry: TrendGeometry }) {
  return (
    <div className="storage-trend__canvas" data-testid="trend-chart">
      <svg viewBox={`0 0 100 ${PLOT_H}`} preserveAspectRatio="none" aria-hidden="true">
        {geometry.yTicks.map((t) => (
          <line key={t.value} className="storage-trend__grid" x1="0" x2="100" y1={t.y} y2={t.y} />
        ))}
        {geometry.series.map((s) =>
          s.path ? (
            <path
              key={s.key}
              className={`storage-trend__line trend-series--${s.key}`}
              d={s.path}
              vectorEffect="non-scaling-stroke"
              data-testid={`trend-line-${s.key}`}
            />
          ) : null,
        )}
      </svg>

      {/* The dashed target floor — an HTML rule (CSS dashes stay crisp at any width; an SVG
          dasharray would stretch with the non-uniform viewBox scale). */}
      {geometry.target ? (
        <>
          <div
            className="storage-trend__target"
            data-testid="trend-target"
            style={{ top: `${geometry.target.y}px` }}
          />
          <span
            className="storage-trend__target-label"
            data-testid="trend-target-label"
            style={{ top: `${geometry.target.y}px` }}
          >
            {geometry.target.label}
          </span>
        </>
      ) : null}

      {geometry.yTicks.map((t) => (
        <span key={t.value} className="storage-trend__ytick" style={{ top: `${t.y}px` }}>
          {t.label}
        </span>
      ))}
      {/* Fitted-domain honesty: a non-zero baseline is labeled explicitly at the axis corner. */}
      {geometry.baselineLabel ? (
        <span
          className="storage-trend__ytick storage-trend__ytick--baseline"
          data-testid="trend-baseline"
        >
          {geometry.baselineLabel}
        </span>
      ) : null}

      {geometry.series.map((s) =>
        s.end ? (
          <span
            key={s.key}
            className={`storage-trend__dot trend-series--${s.key}`}
            style={{ left: `${s.end.x}%`, top: `${s.end.y}px` }}
          />
        ) : null,
      )}
      {geometry.series.map((s) =>
        s.end ? (
          <span
            key={s.key}
            className={`storage-trend__endlabel trend-series--${s.key}`}
            data-testid={`trend-endlabel-${s.key}`}
            style={{ left: `${s.end.x}%`, top: `${s.end.labelY}px` }}
          >
            <span className="storage-trend__key" aria-hidden="true" />
            {s.label}
          </span>
        ) : null,
      )}
    </div>
  );
}

/** The fixed-height stand-in for every non-chart state (ADR-015 — the region never changes size). */
function PlotNote({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div className="storage-trend__note" data-testid={testId}>
      <p className="muted">{children}</p>
    </div>
  );
}

function plotFor(
  report: StorageTrendReport | undefined,
  geometry: TrendGeometry | null,
  isLoading: boolean,
  errorMessage: string | undefined,
) {
  if (geometry) return <TrendPlot geometry={geometry} />;
  if (isLoading) return <PlotNote>Loading trend…</PlotNote>;
  if (errorMessage) {
    return <PlotNote testId="trend-error">Failed to load the trend: {errorMessage}</PlotNote>;
  }
  if (report?.unavailable) {
    return (
      <PlotNote testId="trend-degraded">
        Trend unavailable — couldn’t reach Prometheus right now. The meters above still show live
        utilization.
      </PlotNote>
    );
  }
  return (
    <PlotNote testId="trend-empty">
      No history yet — the trend fills in as Prometheus retains the exportarr free-space series.
    </PlotNote>
  );
}

export function FreespaceTrend() {
  const [win, setWin] = useState<TrendWindow>('30d');
  // placeholderData keeps the previous chart on screen while a window switch refetches — the plot
  // dims and swaps, never collapses (ADR-015; the no-skeleton-flash rule).
  const trend = trpc.storage.trend.useQuery({ window: win }, { placeholderData: (prev) => prev });
  const report = trend.data;
  const geometry = report && !report.unavailable ? trendGeometry(report, PLOT_H) : null;

  return (
    <section className="card storage-trend" aria-label="Free-space trend" data-testid="storage-trend">
      <header className="storage-trend__head">
        <h2>Free-space trend</h2>
        <div className="seg" role="group" aria-label="Trend window">
          {TREND_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={win === opt.value ? 'is-active' : undefined}
              data-testid={`trend-window-${opt.value}`}
              onClick={() => setWin(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </header>
      <p className="muted storage-trend__caption">
        Free space per media array (exportarr series in Prometheus); the dashed line is the space
        target as a free-space floor.
      </p>

      <figure
        className="storage-trend__plotwrap"
        data-refreshing={trend.isFetching || undefined}
        data-window={report?.window}
      >
        {plotFor(report, geometry, trend.isLoading, trend.error?.message)}
        <div className="storage-trend__xaxis" aria-hidden="true">
          {(geometry?.xTicks ?? []).map((t) => (
            <span key={`${t.x}-${t.label}`} style={{ left: `${t.x}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <figcaption className="sr-only">
          {report && !report.unavailable
            ? `Free-space trend, ${report.window}: ${report.series.map(trendLegendValue).join('; ')}.`
            : 'Free-space trend unavailable.'}
        </figcaption>
      </figure>

      {report && report.series.length > 0 ? (
        <ul className="storage-trend__legend" data-testid="trend-legend">
          {report.series.map((s) => (
            <li key={s.key} className={`trend-series--${s.key}`}>
              <span className="storage-trend__swatch" aria-hidden="true" />
              {trendLegendValue(s)}
            </li>
          ))}
          {geometry?.target ? (
            <li className="storage-trend__legend-target">
              <span
                className="storage-trend__swatch storage-trend__swatch--dashed"
                aria-hidden="true"
              />
              {geometry.target.label}
            </li>
          ) : null}
          {geometry?.historyBegins ? (
            <li className="storage-trend__legend-note" data-testid="trend-history-begins">
              history begins {geometry.historyBegins}
            </li>
          ) : null}
        </ul>
      ) : null}

      <p className="muted storage-trend__footnote">
        Full infra dashboards:{' '}
        <a href={GRAFANA_TREND_URL} target="_blank" rel="noreferrer" data-testid="grafana-trend-link">
          Grafana
        </a>{' '}
        (LAN only).
      </p>
    </section>
  );
}
