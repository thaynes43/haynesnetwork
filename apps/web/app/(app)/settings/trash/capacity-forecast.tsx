'use client';

// DESIGN-013 D-09 (story 819) — the Capacity Forecast card on the Storage tab, above the free-space
// trend: one panel per media array, drawn from `storage.forecast` (D-08's read).
//   • The words come first: two fixed tiles (the space target, 100% full) and one sentence (the
//     pace, or why there is no forecast). The plot shows the same thing; nothing is only in it.
//   • The plot is the trend chart's school (dependency-free inline SVG, x in percent and y in pixels
//     of a fixed height, every label HTML at the same numbers, no hover): the free space the pace
//     was read from in the muted ink, then the projection from today's level in the direction's
//     colour — danger while filling, accent while freeing up, the meter's own two tones — to the
//     marks where it meets the dashed target floor and zero. The dates sit under their marks.
//   • The plot is hidden from assistive technology: the tiles, the sentence, the notes and the
//     figure's caption say everything it shows.
//   • ADR-015: the tiles keep two slots and the plot a fixed height in every state (forecast, no
//     forecast, loading, Prometheus down), so a saved target changes words and marks, never layout.
import { trpc } from '@/lib/trpc-client';
import {
  FORECAST_LEGEND,
  FORECAST_METHOD_NOTE,
  FORECAST_UNAVAILABLE,
  forecastCaption,
  forecastLabelHalfPx,
  forecastPanels,
  type ForecastArrayRef,
  type ForecastLoadState,
  type ForecastPanel,
  type ForecastPlot,
  type ForecastTile,
} from '@/lib/storage-forecast';

/** The fixed plot height (px). Must equal `.storage-forecast__canvas` in app.css. */
const PLOT_H = 160;

function Plot({ plot, arrayKey }: { plot: ForecastPlot; arrayKey: string }) {
  return (
    <div
      className="storage-forecast__canvas"
      data-testid={`forecast-plot-${arrayKey}`}
      aria-hidden="true"
    >
      {/* The byte axis has its own gutter: with a horizon of years, today sits at the left edge,
          and labels laid over the plot (the trend's way) would sit on the history. */}
      {plot.yTicks.map((t) => (
        <span key={t.label} className="storage-forecast__ytick" style={{ top: `${t.y}px` }}>
          {t.label}
        </span>
      ))}
      {/* Zero is the level the forecast is about, so the baseline says what it is. */}
      <span className="storage-forecast__ytick storage-forecast__ytick--baseline">0 · full</span>

      <div className="storage-forecast__plotarea">
        <svg viewBox={`0 0 100 ${PLOT_H}`} preserveAspectRatio="none">
          {plot.yTicks.map((t) => (
            <line key={t.label} className="storage-trend__grid" x1="0" x2="100" y1={t.y} y2={t.y} />
          ))}
          {plot.today ? (
            <line
              className="storage-forecast__rule"
              x1={plot.today.x}
              x2={plot.today.x}
              y1="0"
              y2={PLOT_H}
            />
          ) : null}
          {plot.marks
            .filter((m) => m.kind === 'target')
            .map((m) => (
              <line
                key={m.kind}
                className="storage-forecast__rule"
                x1={m.x}
                x2={m.x}
                y1={m.y}
                y2={PLOT_H}
              />
            ))}
          {plot.history ? (
            <path
              className="storage-forecast__line storage-forecast__line--history"
              d={plot.history}
              vectorEffect="non-scaling-stroke"
              data-testid={`forecast-history-${arrayKey}`}
            />
          ) : null}
          {plot.projection ? (
            <path
              className="storage-forecast__line storage-forecast__line--projection"
              d={plot.projection}
              vectorEffect="non-scaling-stroke"
              data-testid={`forecast-projection-${arrayKey}`}
            />
          ) : null}
        </svg>

        {/* The dashed target floor: the trend chart's own rule and label (dashes mean a threshold). */}
        {plot.target ? (
          <>
            <div
              className="storage-trend__target"
              data-testid={`forecast-target-line-${arrayKey}`}
              style={{ top: `${plot.target.y}px` }}
            />
            <span
              className="storage-trend__target-label storage-forecast__target-label--above"
              style={{
                top: `${plot.target.y}px`,
                // Stop short of a mark that sits on the floor in the right half of the plot.
                right:
                  plot.target.labelEnd < 100
                    ? `calc(${100 - plot.target.labelEnd}% + 12px)`
                    : undefined,
              }}
            >
              {plot.target.label}
            </span>
          </>
        ) : null}

        {plot.today ? (
          <span
            className="storage-forecast__dot storage-forecast__dot--today"
            style={{ left: `${plot.today.x}%`, top: `${plot.today.y}px` }}
          />
        ) : null}
        {plot.marks.map((m) => (
          <span
            key={m.kind}
            className="storage-forecast__dot storage-forecast__dot--mark"
            data-testid={`forecast-mark-${m.kind}-${arrayKey}`}
            style={{ left: `${m.x}%`, top: `${m.y}px` }}
          />
        ))}
      </div>
    </div>
  );
}

function Tile({ tile, testId }: { tile: ForecastTile; testId: string }) {
  return (
    <div className="storage-forecast__tile" data-testid={testId}>
      <dt>{tile.label}</dt>
      <dd className="storage-forecast__value">{tile.value}</dd>
      <dd className="storage-forecast__detail">{tile.detail}</dd>
    </div>
  );
}

function Panel({ panel }: { panel: ForecastPanel }) {
  return (
    <article
      className={`storage-forecast__array forecast-tone--${panel.tone}`}
      data-testid={`forecast-${panel.key}`}
      data-tone={panel.tone}
    >
      <div className="storage-forecast__words">
        <header className="storage-forecast__name">
          <h3>{panel.label}</h3>
          <span className="storage-forecast__chip" data-testid={`forecast-chip-${panel.key}`}>
            {panel.chip}
          </span>
        </header>
        <dl className="storage-forecast__tiles">
          <Tile tile={panel.target} testId={`forecast-target-${panel.key}`} />
          <Tile tile={panel.full} testId={`forecast-full-${panel.key}`} />
        </dl>
        <p className="storage-forecast__sentence" data-testid={`forecast-sentence-${panel.key}`}>
          {panel.sentence}
        </p>
      </div>

      <figure className="storage-forecast__figure">
        {panel.plot ? (
          <Plot plot={panel.plot} arrayKey={panel.key} />
        ) : (
          <div className="storage-forecast__plotnote" data-testid={`forecast-noplot-${panel.key}`}>
            <p className="muted">{panel.emptyPlot}</p>
          </div>
        )}
        <div className="storage-forecast__xaxis" aria-hidden="true">
          {(panel.plot?.xLabels ?? []).map((l) => (
            <span
              key={`${l.kind}-${l.x}-${l.label}`}
              data-kind={l.kind}
              style={{
                left: `clamp(${forecastLabelHalfPx(l.label)}px, ${l.x}%, calc(100% - ${forecastLabelHalfPx(l.label)}px))`,
              }}
            >
              {l.label}
            </span>
          ))}
        </div>
        <figcaption className="sr-only">{panel.summary}</figcaption>
      </figure>

      {panel.notes.length > 0 ? (
        <div className="storage-forecast__notes" data-testid={`forecast-notes-${panel.key}`}>
          {panel.notes.map((note, i) => (
            <p key={note} data-caution={(panel.caution && i === 0) || undefined}>
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function CapacityForecast({ arrays }: { arrays: readonly ForecastArrayRef[] | undefined }) {
  const forecast = trpc.storage.forecast.useQuery();
  const report = forecast.data;
  const state: ForecastLoadState = forecast.error
    ? { kind: 'error', message: forecast.error.message }
    : forecast.isLoading
      ? { kind: 'loading' }
      : { kind: 'ready' };
  const panels = forecastPanels(report, arrays ?? [], state, PLOT_H);

  return (
    <section
      className="card storage-forecast"
      aria-label="Capacity forecast"
      data-testid="storage-forecast"
      data-unavailable={report?.unavailable || undefined}
    >
      <header className="storage-forecast__head">
        <h2>Capacity forecast</h2>
      </header>
      <p className="muted storage-forecast__caption">{forecastCaption(report)}</p>

      {panels.length > 0 ? (
        <div
          className="storage-forecast__arrays"
          data-refreshing={(forecast.isFetching && !forecast.isLoading) || undefined}
        >
          {panels.map((panel) => (
            <Panel key={panel.key} panel={panel} />
          ))}
        </div>
      ) : (
        // No array is known yet either (the utilization read is still away or failed).
        <div className="storage-forecast__plotnote" data-testid="forecast-note">
          <p className="muted">
            {state.kind === 'error'
              ? `Failed to load the forecast: ${state.message}`
              : report?.unavailable
                ? FORECAST_UNAVAILABLE
                : 'Loading forecast…'}
          </p>
        </div>
      )}

      <ul className="storage-trend__legend storage-forecast__legend" data-testid="forecast-legend">
        {FORECAST_LEGEND.map((entry) => (
          <li key={entry.key} className={`forecast-key--${entry.key}`}>
            <span
              className={
                entry.key === 'today'
                  ? 'storage-forecast__keydot'
                  : `storage-trend__swatch${
                      entry.key === 'target' ? ' storage-trend__swatch--dashed' : ''
                    }`
              }
              aria-hidden="true"
            />
            {entry.label}
          </li>
        ))}
      </ul>
      <p className="muted storage-trend__footnote" data-testid="forecast-method">
        {FORECAST_METHOD_NOTE}
      </p>
    </section>
  );
}
