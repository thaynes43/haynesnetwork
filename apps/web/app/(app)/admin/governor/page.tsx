'use client';

// ADR-082 / DESIGN-027 D-10 (PLAN-040) — /admin/governor: the MAM compliance governor surface. Admin-only
// (the AdminLayout gate). READ: the gate state (grabs flowing vs paused, current count + headroom, whether
// the count sits in the hold band, the last observed change, the last run), the resolved config with a
// per-value provenance chip (saved here / from env / default), and the recent transitions with their
// reasons. WRITE: the DB-backed audited knobs (limit, buffer, resume floor, trend pause) as ONE form with
// ONE Save — validated at the edge exactly as the domain writer validates them (an unsatisfiable floor can
// never be submitted). Nothing here is destructive, so there is no confirm ceremony.
//
// Reflow-safe (ADR-015 / hard rule 9): the save-status slot is reserved so feedback recolors, never
// reflows; the provenance chips and stat tiles hold their footprint as values change. Tokens only (hard
// rule 2) — every color comes from a --color-* custom property.

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

interface ConfigDraft {
  limit: string;
  buffer: string;
  resumeFloor: string;
  trendPauseDelta: string;
}

type ConfigSource = 'db' | 'env' | 'default';

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

/** The provenance chip — where a resolved knob came from. Fixed footprint so a source change never reflows. */
function ProvenanceChip({ source }: { source: ConfigSource }) {
  const label = source === 'db' ? 'Saved here' : source === 'env' ? 'From env' : 'Default';
  const title =
    source === 'db'
      ? 'Resolved from the saved config below.'
      : source === 'env'
        ? 'Resolved from a cluster environment variable (the fallback tier). Saving here takes over.'
        : 'Resolved from the built-in default. Saving here takes over.';
  return (
    <span className={`gov-prov gov-prov--${source}`} title={title}>
      {label}
    </span>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const REASON_LABEL: Record<string, string> = {
  edge: 'Reached the pause edge',
  trend: 'Climbing fast in the hold band',
  floor: 'Dropped below the resume floor',
  count_failed: 'Could not count (paused as a precaution)',
  hold: 'Held its state',
};

const EVENT_LABEL: Record<string, string> = {
  mam_gate_paused: 'Paused',
  mam_gate_resumed: 'Resumed',
  mam_gate_stuck: 'Pinned at the cap',
};

export default function AdminGovernorPage() {
  const utils = trpc.useUtils();
  const status = trpc.mamGovernor.status.useQuery();
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = trpc.mamGovernor.config.set.useMutation({
    onError: (err) => {
      setError(describeMutationError(err));
      setSaved(false);
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setDraft(null); // re-sync to the freshly-saved, now DB-sourced values
    },
    onSettled: () => void utils.mamGovernor.status.invalidate(),
  });

  const data = status.data;
  const cfg = data?.config;
  const server: ConfigDraft | null = cfg
    ? {
        limit: String(cfg.limit.value),
        buffer: String(cfg.buffer.value),
        resumeFloor: String(cfg.resumeFloor.value),
        trendPauseDelta: String(cfg.trendPauseDelta.value),
      }
    : null;
  const form = draft ?? server;

  const patch = (next: Partial<ConfigDraft>) => {
    if (form === null) return;
    setSaved(false);
    setDraft({ ...form, ...next });
  };

  const limit = form ? intOrNaN(form.limit) : NaN;
  const buffer = form ? intOrNaN(form.buffer) : NaN;
  const resumeFloor = form ? intOrNaN(form.resumeFloor) : NaN;
  const trendPauseDelta = form ? intOrNaN(form.trendPauseDelta) : NaN;
  const edge = limit - buffer;

  // Mirror the domain writer's invariants (ADR-082 C-04) so Save can never submit an unstorable combination.
  const invalidMsg: string | null = !form
    ? null
    : !(limit >= 1 && limit <= 200)
      ? 'Limit must be 1 to 200.'
      : !(buffer >= 0)
        ? 'Buffer cannot be negative.'
        : !(edge > 0)
          ? 'Buffer must be below the limit.'
          : !(resumeFloor >= 0 && resumeFloor < edge)
            ? 'Resume floor must be 0 or more and below the pause edge.'
            : !(trendPauseDelta >= 1)
              ? 'Trend pause must be at least 1.'
              : null;

  const dirty =
    form !== null && server !== null && JSON.stringify(form) !== JSON.stringify(server);
  const canSave = form !== null && invalidMsg === null && dirty && !save.isPending;

  const onSave = () => {
    if (!canSave || form === null) return;
    save.mutate({ limit, buffer, resumeFloor, trendPauseDelta });
  };

  const gate = data?.gate ?? null;

  return (
    <>
      <div className="admin-head">
        <h1>MAM governor</h1>
      </div>
      <p className="muted">
        The governor paces the MyAnonaMouse torrent fallback so grabs stay under the account cap. It pauses
        the indexer near the edge and resumes once seeding torrents pass 72 hours and headroom returns.
        Usenet keeps flowing throughout.
      </p>

      {status.isLoading ? <p className="muted">Loading…</p> : null}

      {/* Gate state */}
      {gate ? (
        <section className="card governor" data-testid="governor-gate" aria-label="Gate state">
          <div className="governor__gate-head">
            <h2>Gate</h2>
            <span
              className={`gov-pill ${gate.gateOpen ? 'gov-pill--open' : gate.countOk ? 'gov-pill--paused' : 'gov-pill--failed'}`}
            >
              {gate.gateOpen ? 'Grabs flowing' : gate.countOk ? 'Paused' : 'Paused (count failed)'}
            </span>
          </div>
          <div className="gov-stats">
            <div className="gov-stat">
              <span className="gov-stat__label">Unsatisfied</span>
              <span className="gov-stat__value">
                {gate.unsatisfied} <span className="muted">of {gate.limit}</span>
              </span>
            </div>
            <div className="gov-stat">
              <span className="gov-stat__label">Headroom</span>
              <span className="gov-stat__value">{gate.headroom}</span>
            </div>
            <div className="gov-stat">
              <span className="gov-stat__label">Last change</span>
              <span className="gov-stat__value">
                {gate.lastDelta === null
                  ? '—'
                  : gate.lastDelta > 0
                    ? `+${gate.lastDelta}`
                    : String(gate.lastDelta)}
              </span>
            </div>
            <div className="gov-stat">
              <span className="gov-stat__label">Pause edge</span>
              <span className="gov-stat__value">{gate.threshold}</span>
            </div>
            <div className="gov-stat">
              <span className="gov-stat__label">Resume floor</span>
              <span className="gov-stat__value">{gate.resumeFloor}</span>
            </div>
            <div className="gov-stat">
              <span className="gov-stat__label">Hold band</span>
              <span className="gov-stat__value">
                {gate.resumeFloor} to {gate.threshold}
                {gate.inDeadBand ? <span className="gov-inband"> · here now</span> : null}
              </span>
            </div>
          </div>
          <p className="muted governor__runline">
            Last run {formatWhen(gate.lastRunAt)}
            {gate.lastEventType ? ` · last event: ${EVENT_LABEL[gate.lastEventType] ?? gate.lastEventType}` : ''}
          </p>
        </section>
      ) : status.isSuccess ? (
        <section className="card governor" data-testid="governor-gate">
          <h2>Gate</h2>
          <p className="muted">The governor has not recorded a run yet. State appears after its first tick.</p>
        </section>
      ) : null}

      {/* Config */}
      {cfg && form ? (
        <section className="card governor" data-testid="governor-config" aria-label="Governor config">
          <h2>Config</h2>
          <p className="muted">
            These knobs resolve saved value first, then a cluster environment variable, then the built-in
            default. Saving here takes over from the environment fallback. Every save is audited.
          </p>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}

          <div className="gov-fields">
            <label className="field gov-field">
              <span>Unsatisfied limit</span>
              <span className="gov-field__row">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={form.limit}
                  data-testid="gov-limit"
                  aria-label="Unsatisfied limit"
                  onChange={(e) => patch({ limit: e.target.value })}
                />
                <ProvenanceChip source={cfg.limit.source} />
              </span>
              <span className="field-hint">The account rank cap (200 max). Bump it at each promotion.</span>
            </label>

            <label className="field gov-field">
              <span>Buffer</span>
              <span className="gov-field__row">
                <input
                  type="number"
                  min={0}
                  value={form.buffer}
                  data-testid="gov-buffer"
                  aria-label="Buffer"
                  onChange={(e) => patch({ buffer: e.target.value })}
                />
                <ProvenanceChip source={cfg.buffer.source} />
              </span>
              <span className="field-hint">
                Reserved slots below the cap. The gate pauses at limit minus buffer (the pause edge).
              </span>
            </label>

            <label className="field gov-field">
              <span>Resume floor</span>
              <span className="gov-field__row">
                <input
                  type="number"
                  min={0}
                  value={form.resumeFloor}
                  data-testid="gov-resume-floor"
                  aria-label="Resume floor"
                  aria-invalid={
                    (form !== null && !(resumeFloor >= 0 && resumeFloor < edge)) || undefined
                  }
                  onChange={(e) => patch({ resumeFloor: e.target.value })}
                />
                <ProvenanceChip source={cfg.resumeFloor.source} />
              </span>
              <span className="field-hint">
                A paused gate reopens only below this. It must sit below the pause edge, leaving a hold band
                between them so a reopen cannot re-flood the cap.
              </span>
            </label>

            <label className="field gov-field">
              <span>Trend pause</span>
              <span className="gov-field__row">
                <input
                  type="number"
                  min={1}
                  value={form.trendPauseDelta}
                  data-testid="gov-trend"
                  aria-label="Trend pause delta"
                  onChange={(e) => patch({ trendPauseDelta: e.target.value })}
                />
                <ProvenanceChip source={cfg.trendPauseDelta.source} />
              </span>
              <span className="field-hint">
                While open in the hold band, a single-interval rise of at least this many pauses right away,
                so a fast climb never rides the hold up into the cap.
              </span>
            </label>
          </div>

          <div className="form-actions governor__save">
            <button
              type="button"
              className="btn primary"
              data-testid="gov-save"
              disabled={!canSave}
              onClick={onSave}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {/* Reserved status slot — text recolors, never reflows (ADR-015). */}
            <span className="governor__status" role="status">
              {invalidMsg ?? (saved ? 'Saved' : dirty ? 'Unsaved' : ' ')}
            </span>
          </div>
        </section>
      ) : null}

      {/* Recent transitions */}
      {data && data.transitions.length > 0 ? (
        <section className="card governor" data-testid="governor-transitions" aria-label="Recent transitions">
          <h2>Recent transitions</h2>
          <ul className="gov-transitions">
            {data.transitions.map((tr, i) => (
              <li key={`${tr.at}-${i}`} className="gov-transition">
                <span className={`gov-pill gov-pill--sm ${tr.event === 'mam_gate_resumed' ? 'gov-pill--open' : 'gov-pill--paused'}`}>
                  {EVENT_LABEL[tr.event] ?? tr.event}
                </span>
                <span className="gov-transition__reason">
                  {tr.reason ? (REASON_LABEL[tr.reason] ?? tr.reason) : ''}
                  {tr.unsatisfied !== null ? ` · ${tr.unsatisfied} unsatisfied` : ''}
                </span>
                <span className="gov-transition__when muted">{formatWhen(tr.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
