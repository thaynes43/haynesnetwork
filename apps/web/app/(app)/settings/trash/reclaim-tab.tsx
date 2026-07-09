'use client';

// ADR-030 / DESIGN-013 (PLAN-013) · IA reshuffle (2026-07-09, build B) — the RECLAIM tab of the
// tabbed Trash Settings hub: the reclaim-ATTRIBUTION surface relocated verbatim from /admin/storage
// (the storage.reclaim procedure is unchanged — only the UI moved). Window switcher → headline
// totals, the bang-for-buck bars (category × resolution, bytes-desc), the cumulative step strip, the
// per-batch table, and the best-effort expedite footnote (never folded into totals, C-01b). A read
// surface — no Save. Admin-only (storage.reclaim is an adminProcedure read).
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { formatBytes, formatWhen } from '@/lib/media';
import {
  RECLAIM_WINDOW_OPTIONS,
  categoryResolutionLabel,
  cumulativeStepGeometry,
  reclaimHeadline,
  sharePct,
  windowDescription,
  type ReclaimWindow,
} from '@/lib/storage';

const CUMULATIVE_W = 600;
const CUMULATIVE_H = 64;

export function ReclaimTab() {
  const [win, setWindow] = useState<ReclaimWindow>('90d');
  // placeholderData keeps the previous report on screen while a window switch refetches — the
  // section swaps numbers, never collapses (ADR-015).
  const reclaim = trpc.storage.reclaim.useQuery(
    { window: win },
    { placeholderData: (prev) => prev },
  );
  const report = reclaim.data;
  const empty = report != null && report.totals.items === 0;
  const geometry = report
    ? cumulativeStepGeometry(
        report.cumulative,
        CUMULATIVE_W,
        CUMULATIVE_H,
        new Date().toISOString().slice(0, 10),
      )
    : null;

  return (
    <section className="storage-reclaim admin-section" aria-label="Reclaim">
      <div className="storage-reclaim__head">
        <h2>Reclaim</h2>
        <div className="seg" role="group" aria-label="Reclaim window">
          {RECLAIM_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={win === opt.value ? 'is-active' : undefined}
              onClick={() => setWindow(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {reclaim.isLoading ? <p className="muted">Loading reclaim…</p> : null}
      {reclaim.error ? (
        <p className="alert" role="alert">
          Failed to load reclaim: {reclaim.error.message}
        </p>
      ) : null}

      {report ? (
        <>
          <p className="storage-reclaim__headline" data-testid="reclaim-headline">
            {reclaimHeadline(report.totals)}{' '}
            <span className="muted">· {windowDescription(report.window)}</span>
          </p>

          {empty ? (
            <div className="card storage-reclaim__empty" data-testid="reclaim-empty">
              <p>Nothing swept in this window yet — and that’s the normal starting state.</p>
              <p className="muted">
                Reclaim accrues when Leaving-Soon batches expire and sweep: each swept item lands
                here with its frozen size, category, and resolution, so you can see exactly where
                the space came back from.
              </p>
            </div>
          ) : (
            <>
              <ol className="reclaim-bars" data-testid="reclaim-bars">
                {report.byCategoryResolution.map((row) => {
                  const share = sharePct(row.reclaimedBytes, report.totals.reclaimedBytes);
                  return (
                    <li key={`${row.mediaKind}-${row.resolution}`} className="reclaim-bar">
                      <div className="reclaim-bar__meta">
                        <span className="reclaim-bar__label">
                          {categoryResolutionLabel(row.mediaKind, row.resolution)}
                        </span>
                        <span className="reclaim-bar__value">
                          {formatBytes(row.reclaimedBytes)} ({share}%) · {row.items} item
                          {row.items === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="reclaim-bar__track">
                        <div className="reclaim-bar__fill" style={{ width: `${share}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ol>

              {geometry ? (
                <figure className="reclaim-cumulative" data-testid="reclaim-cumulative">
                  <figcaption className="muted">Cumulative reclaim over the window</figcaption>
                  <svg
                    viewBox={`0 0 ${CUMULATIVE_W} ${CUMULATIVE_H}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path className="reclaim-cumulative__area" d={geometry.area} />
                    <path
                      className="reclaim-cumulative__line"
                      d={geometry.line}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <div className="reclaim-cumulative__axis muted">
                    <span>{geometry.startDay}</span>
                    <span>today · {formatBytes(report.totals.reclaimedBytes)} total</span>
                  </div>
                </figure>
              ) : null}

              <table className="admin-table storage-batches" data-testid="reclaim-batches">
                <thead>
                  <tr>
                    <th>Swept</th>
                    <th>Kind</th>
                    <th>Green-lit by</th>
                    <th>Items</th>
                    <th>Reclaimed</th>
                  </tr>
                </thead>
                <tbody>
                  {report.batches.map((b) => (
                    <tr key={b.batchId}>
                      <td data-label="Swept">
                        {b.lastDeletedAt ? formatWhen(b.lastDeletedAt) : '—'}
                      </td>
                      <td data-label="Kind">{b.mediaKind === 'movie' ? 'Movies' : 'TV'}</td>
                      <td data-label="Green-lit by">{b.greenlitByName ?? '—'}</td>
                      <td data-label="Items">{b.items}</td>
                      <td data-label="Reclaimed">{formatBytes(b.reclaimedBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {report.expedited.items > 0 ? (
            <p className="muted storage-reclaim__expedited" data-testid="reclaim-expedited">
              + {report.expedited.items} direct expedite{report.expedited.items === 1 ? '' : 's'} ·{' '}
              {formatBytes(report.expedited.reclaimedBytes)}, best-effort — not in the totals.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
