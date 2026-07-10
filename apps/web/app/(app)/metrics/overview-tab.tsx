'use client';

// ADR-037 / DESIGN-016 D-05 — the Metrics Overview: WAN upload/download usage-vs-capacity meters, a
// cluster load + memory tile, and a storage-utilization snapshot (REUSING the 013 getUtilization read).
// The payload is SHAPED server-side by the caller's level — a `limited` viewer never receives
// `network.wanLinks` (the full-only per-uplink breakdown). ADR-015: the poll (45s, paused when the tab
// is hidden or not active) dims in place via placeholderData; every state shares a stable region.
import { useState, type FormEvent, type ReactNode } from 'react';
import type { MetricsLevel } from '@hnet/db';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import {
  CAPACITY_MBPS_MAX,
  CAPACITY_MBPS_MIN,
  capacityOutOfRange,
  formatMbps,
  formatPct,
  meterPct,
  meterTone,
  meterWidth,
  type MeterTone,
} from '@/lib/metrics';
import { formatCapacity, utilizationTone } from '@/lib/storage';

// Grafana stays the LAN power tool — deep-linked, never embedded (ADR-030 C-04 / ADR-037 C-09). The
// deep-link URLs resolve ONLY on the owner's LAN/VPN, so they are ADMIN-ONLY (DESIGN-016 D-07): the
// server sends `data.grafana` only to an admin caller, and this tab renders the footnote link only when
// that object is present. A member simply has no footnote — reflow-free (nothing toggles on interaction).

function Meter({
  testId,
  label,
  valueText,
  footText,
  pct,
  tone,
  editor,
}: {
  testId?: string;
  label: string;
  valueText: string;
  footText: string;
  pct: number | null;
  tone: MeterTone;
  /** DESIGN-016 D-08 — an OPTIONAL admin-only capacity editor, rendered under the foot. Non-admins
   *  pass nothing, so the meter stays read-only with no toggling affordance (reflow-free by absence). */
  editor?: ReactNode;
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
      {editor}
    </div>
  );
}

// ── DESIGN-016 D-08 — admin-only inline capacity editor ─────────────────────────────────────────────
// Reuses the /settings/trash storage-TARGET idiom verbatim (an always-present number input + tick Save,
// a direct manipulation, NOT a form ceremony): draft-over-stored, optimistic write with server reconcile,
// client-side bound mirror of the server zod. The stored value IS the meter's own `capacityMbps` off the
// Overview payload (no extra admin-only `capacity.get` read) — so a save patches the SAME cache the meter
// renders from and the denominator re-renders instantly. ADR-015: the editor is always mounted for an
// admin (never toggled), so nothing reflows; the status label swap reserves its width.

/** Call BOTH capacity mutations unconditionally (rules-of-hooks) and hand back the one this `kind` uses. */
function useCapacityMutation(
  kind: 'upload' | 'download',
  handlers: {
    onMutate: (vars: { mbps: number }) => Promise<{ prev: unknown }>;
    onError: (err: unknown, vars: { mbps: number }, ctx: { prev: unknown } | undefined) => void;
    onSuccess: () => void;
    onSettled: () => Promise<unknown> | void;
  },
) {
  const setUpload = trpc.metrics.capacity.setUpload.useMutation(handlers);
  const setDownload = trpc.metrics.capacity.setDownload.useMutation(handlers);
  return kind === 'upload' ? setUpload : setDownload;
}

function CapacityEditor({
  kind,
  label,
  capacityMbps,
}: {
  kind: 'upload' | 'download';
  label: string;
  capacityMbps: number;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const value = draft ?? String(capacityMbps);
  const parsed = value.trim() === '' ? Number.NaN : Number(value);
  const invalid = Number.isNaN(parsed) || capacityOutOfRange(parsed);
  const dirty = draft != null && value !== String(capacityMbps);

  const save = useCapacityMutation(kind, {
    // Optimistically patch the Overview cache the meter renders from — denominator (and, via meterPct,
    // the fill) update immediately; onSettled reconciles from the server (which recomputes pct itself).
    onMutate: async (vars) => {
      await utils.metrics.overview.cancel();
      const prev = utils.metrics.overview.getData();
      utils.metrics.overview.setData(undefined, (cur) => {
        if (!cur) return cur;
        const meter = cur.network[kind];
        return {
          ...cur,
          network: {
            ...cur.network,
            [kind]: {
              ...meter,
              capacityMbps: vars.mbps,
              pct: meterPct(meter.usageMbps, vars.mbps),
            },
          },
        };
      });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      utils.metrics.overview.setData(undefined, ctx?.prev as never);
      setError(describeMutationError(err));
      setSaved(false);
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setDraft(null);
    },
    onSettled: () => utils.metrics.overview.invalidate(),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid || !dirty) return;
    setSaved(false);
    save.mutate({ mbps: parsed });
  }

  return (
    <form className="metrics-capacity" onSubmit={submit} data-testid={`metrics-capacity-${kind}`}>
      <label className="metrics-capacity__label">
        <span>Capacity</span>
        <input
          type="number"
          inputMode="numeric"
          min={CAPACITY_MBPS_MIN}
          max={CAPACITY_MBPS_MAX}
          step={1}
          value={value}
          aria-label={`${label} capacity in Mbps`}
          aria-invalid={invalid || undefined}
          data-testid={`metrics-capacity-input-${kind}`}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
        />
        <span>Mbps</span>
      </label>
      <button
        type="submit"
        className="btn sm"
        data-testid={`metrics-capacity-save-${kind}`}
        disabled={!dirty || invalid || save.isPending}
      >
        Save
      </button>
      <span className="metrics-capacity__status" role="status">
        {invalid ? 'Whole 0–1,000,000' : saved ? 'Saved' : dirty ? 'Unsaved' : ' '}
      </span>
      {error ? (
        <span className="alert metrics-capacity__error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

export function OverviewTab({
  active,
  metricsLevel,
  viewerIsAdmin,
}: {
  active: boolean;
  metricsLevel: MetricsLevel;
  /** DESIGN-016 D-08 — server-resolved `role.isAdmin`. Gates the inline capacity editor; a non-admin
   *  never receives an edit control (the WAN meters render read-only). */
  viewerIsAdmin: boolean;
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
          editor={
            viewerIsAdmin ? (
              <CapacityEditor kind="upload" label="Upload" capacityMbps={net.upload.capacityMbps} />
            ) : undefined
          }
        />
        <Meter
          testId="metrics-download-meter"
          label="Download"
          valueText={`${formatMbps(net.download.usageMbps)} of ${formatMbps(net.download.capacityMbps)}`}
          footText={`${formatPct(net.download.pct)} of the ${formatMbps(net.download.capacityMbps)} cap`}
          pct={net.download.pct}
          tone={meterTone(net.download.pct)}
          editor={
            viewerIsAdmin ? (
              <CapacityEditor
                kind="download"
                label="Download"
                capacityMbps={net.download.capacityMbps}
              />
            ) : undefined
          }
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

      {/* Admin-only (D-07): the LAN-only Grafana footnote renders only when the server sent the link. */}
      {data.grafana ? (
        <p className="muted metrics-overview__footnote">
          Full infra dashboards:{' '}
          <a
            href={data.grafana.base}
            target="_blank"
            rel="noreferrer"
            data-testid="metrics-grafana-link"
          >
            Grafana
          </a>{' '}
          (LAN only).
        </p>
      ) : null}
    </section>
  );
}
