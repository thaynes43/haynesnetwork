'use client';

// ADR-083 / DESIGN-046 D-08 (PLAN-065) — /admin/janitor: the *arr queue-janitor surface. Admin-only (the
// AdminLayout gate). READ: the promotion-ladder readout (level, age, next criteria, the stagnation nag), the
// resolved config with its source (saved vs all-census defaults), and a last-7-days census/action summary.
// WRITE: the DB-backed audited config as ONE form with ONE Save. A save whose diff contains any
// census→enforce escalation swaps the plain Save for the ConfirmButton two-step (ADR-014) — turning
// enforcement ON is the one consequential act on this page; turning it off or tuning knobs is not.
//
// Reflow-safe (ADR-015 / hard rule 9): mode cells reserve the width of the wider label so a toggle recolors
// without shifting the grid; the save-status slot is reserved; the ladder pill holds its footprint. Tokens
// only (hard rule 2).

import { useState } from 'react';
import { ConfirmButton } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

const INSTANCES = ['sonarr', 'radarr', 'lidarr'] as const;
type Instance = (typeof INSTANCES)[number];
const CLASSES = ['have_better', 'retry_import', 'bad_release'] as const;
type EnforceableClass = (typeof CLASSES)[number];
type Mode = 'census' | 'enforce';
type ModeMatrix = Record<Instance, Record<EnforceableClass, Mode>>;

const INSTANCE_LABEL: Record<Instance, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  lidarr: 'Lidarr',
};

const CLASS_LABEL: Record<EnforceableClass | 'unknown', string> = {
  have_better: 'Already have it',
  retry_import: 'Retry the import',
  bad_release: 'Bad release',
  unknown: 'Unknown reason',
};

const CLASS_HINT: Record<EnforceableClass | 'unknown', string> = {
  have_better: 'The library already holds this at equal or better quality. Enforcing removes the download and blocklists the release. Nothing is searched again.',
  retry_import: 'A completed download stuck short of importing. Enforcing asks the app to re-run its import pass, then escalates if it stays stuck.',
  bad_release: 'A failed or defective release. Enforcing blocklists it and searches for a replacement while the item is still monitored.',
  unknown: 'Report only. The janitor never acts on a reason it does not recognize.',
};

interface KnobDraft {
  maxActionsPerRun: string;
  minItemAgeHours: string;
  retryEscalateRuns: string;
}

const intOrNaN = (s: string): number => (/^-?\d+$/.test(s.trim()) ? Number(s) : NaN);

function cloneMatrix(m: ModeMatrix): ModeMatrix {
  return {
    sonarr: { ...m.sonarr },
    radarr: { ...m.radarr },
    lidarr: { ...m.lidarr },
  };
}

function LadderPill({ level, due }: { level: number; due: boolean }) {
  const label = level === 0 ? 'L0 · census' : level === 1 ? `L${level} · partial` : `L${level} · enforced`;
  return (
    <span className={`janitor-pill ${due ? 'janitor-pill--due' : `janitor-pill--l${Math.min(level, 2)}`}`}>
      {label}
    </span>
  );
}

export default function AdminJanitorPage() {
  const utils = trpc.useUtils();
  const status = trpc.queueCleanup.status.useQuery();
  const [modesDraft, setModesDraft] = useState<ModeMatrix | null>(null);
  const [knobsDraft, setKnobsDraft] = useState<KnobDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = trpc.queueCleanup.config.set.useMutation({
    onError: (err) => {
      setError(describeMutationError(err));
      setSaved(false);
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setModesDraft(null);
      setKnobsDraft(null);
    },
    onSettled: () => void utils.queueCleanup.status.invalidate(),
  });

  const data = status.data;
  const cfg = data?.config;
  const serverModes: ModeMatrix | null = cfg ? (cfg.modes as ModeMatrix) : null;
  const serverKnobs: KnobDraft | null = cfg
    ? {
        maxActionsPerRun: String(cfg.maxActionsPerRun),
        minItemAgeHours: String(cfg.minItemAgeHours),
        retryEscalateRuns: String(cfg.retryEscalateRuns),
      }
    : null;
  const modes = modesDraft ?? serverModes;
  const knobs = knobsDraft ?? serverKnobs;

  const toggleCell = (instance: Instance, klass: EnforceableClass) => {
    if (!modes) return;
    setSaved(false);
    const next = cloneMatrix(modes);
    next[instance][klass] = next[instance][klass] === 'census' ? 'enforce' : 'census';
    setModesDraft(next);
  };

  const patchKnobs = (next: Partial<KnobDraft>) => {
    if (!knobs) return;
    setSaved(false);
    setKnobsDraft({ ...knobs, ...next });
  };

  const cap = knobs ? intOrNaN(knobs.maxActionsPerRun) : NaN;
  const age = knobs ? intOrNaN(knobs.minItemAgeHours) : NaN;
  const esc = knobs ? intOrNaN(knobs.retryEscalateRuns) : NaN;

  // Mirror the domain writer's invariants (queueCleanupConfigError) so Save can never submit an unstorable set.
  const invalidMsg: string | null = !knobs
    ? null
    : !(cap >= 1 && cap <= 100)
      ? 'Actions per run must be 1 to 100.'
      : !(age >= 0 && age <= 168)
        ? 'Minimum age must be 0 to 168 hours.'
        : !(esc >= 1 && esc <= 48)
          ? 'Escalate after must be 1 to 48 runs.'
          : null;

  // The cells this save would flip census→enforce. Enforcing is the consequential direction (ADR-014):
  // it is what turns automated *arr mutations on, so it alone earns the two-step confirm.
  const escalations: string[] = [];
  if (modes && serverModes) {
    for (const instance of INSTANCES) {
      for (const klass of CLASSES) {
        if (serverModes[instance][klass] === 'census' && modes[instance][klass] === 'enforce') {
          escalations.push(`${INSTANCE_LABEL[instance]}: ${CLASS_LABEL[klass]}`);
        }
      }
    }
  }

  const dirty =
    (modes !== null &&
      serverModes !== null &&
      JSON.stringify(modes) !== JSON.stringify(serverModes)) ||
    (knobs !== null && serverKnobs !== null && JSON.stringify(knobs) !== JSON.stringify(serverKnobs));
  const canSave = modes !== null && knobs !== null && invalidMsg === null && dirty && !save.isPending;

  const doSave = () => {
    if (!canSave || !modes || !knobs) return;
    save.mutate({
      modes,
      maxActionsPerRun: cap,
      minItemAgeHours: age,
      retryEscalateRuns: esc,
    });
  };

  const ladder = data?.ladder ?? null;
  const summary = data?.summary ?? [];
  const summaryCell = (instance: Instance, klass: EnforceableClass | 'unknown') =>
    summary.find((s) => s.instance === instance && s.actionClass === klass) ?? null;

  return (
    <>
      <div className="admin-head">
        <h1>Queue janitor</h1>
      </div>
      <p className="muted">
        The janitor sweeps errored grabs out of the Sonarr, Radarr and Lidarr download queues every hour. It
        starts in census, where it only records what it would do. Each class of problem is promoted to
        enforcement per app, one audited flip at a time.
      </p>

      {status.isLoading ? <p className="muted">Loading…</p> : null}

      {/* Ladder */}
      {ladder ? (
        <section className="card janitor" data-testid="janitor-ladder" aria-label="Promotion ladder">
          <div className="janitor__head">
            <h2>Promotion ladder</h2>
            <LadderPill level={ladder.level} due={ladder.promotionDue} />
          </div>
          <p className="muted janitor__age">
            {ladder.ageDays === null
              ? 'The config has never been saved. Everything runs on the all-census defaults.'
              : `Last config change ${ladder.ageDays} ${ladder.ageDays === 1 ? 'day' : 'days'} ago.`}
          </p>
          {ladder.promotionDue ? (
            <p className="alert" role="status" data-testid="janitor-nag">
              Promotion is due. Review the census evidence below and either advance the ladder or record a
              blocker in the build plan.
            </p>
          ) : null}
          <p className="janitor__criteria">{ladder.nextCriteria}</p>
        </section>
      ) : null}

      {/* Mode grid + knobs */}
      {cfg && modes && knobs ? (
        <section className="card janitor" data-testid="janitor-config" aria-label="Janitor config">
          <h2>Enforcement</h2>
          <p className="muted">
            {data?.source === 'db'
              ? 'Saved config. Every save is audited.'
              : 'Running on the all-census defaults. The first save takes over, audited.'}
          </p>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}

          <div className="janitor-grid-wrap">
            <table className="janitor-grid" data-testid="janitor-mode-grid">
              <thead>
                <tr>
                  <th scope="col">Problem class</th>
                  {INSTANCES.map((i) => (
                    <th key={i} scope="col">
                      {INSTANCE_LABEL[i]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CLASSES.map((klass) => (
                  <tr key={klass}>
                    <th scope="row">
                      <span className="janitor-grid__class">{CLASS_LABEL[klass]}</span>
                      <span className="field-hint">{CLASS_HINT[klass]}</span>
                    </th>
                    {INSTANCES.map((instance) => {
                      const mode = modes[instance][klass];
                      return (
                        <td key={instance}>
                          <button
                            type="button"
                            className={`janitor-mode janitor-mode--${mode}`}
                            data-testid={`janitor-cell-${instance}-${klass}`}
                            aria-pressed={mode === 'enforce'}
                            aria-label={`${CLASS_LABEL[klass]} on ${INSTANCE_LABEL[instance]}: ${mode}`}
                            onClick={() => toggleCell(instance, klass)}
                          >
                            {mode === 'census' ? 'Census' : 'Enforce'}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <th scope="row">
                    <span className="janitor-grid__class">{CLASS_LABEL.unknown}</span>
                    <span className="field-hint">{CLASS_HINT.unknown}</span>
                  </th>
                  {INSTANCES.map((instance) => (
                    <td key={instance}>
                      <span className="janitor-mode janitor-mode--fixed">Report only</span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="janitor-knobs">
            <label className="field janitor-knob">
              <span>Actions per run</span>
              <input
                type="number"
                min={1}
                max={100}
                value={knobs.maxActionsPerRun}
                data-testid="janitor-cap"
                aria-label="Actions per run"
                onChange={(e) => patchKnobs({ maxActionsPerRun: e.target.value })}
              />
              <span className="field-hint">
                The most mutations one hourly run may make per app. A runaway rule can never empty a queue in
                one pass.
              </span>
            </label>
            <label className="field janitor-knob">
              <span>Minimum age (hours)</span>
              <input
                type="number"
                min={0}
                max={168}
                value={knobs.minItemAgeHours}
                data-testid="janitor-age"
                aria-label="Minimum age in hours"
                onChange={(e) => patchKnobs({ minItemAgeHours: e.target.value })}
              />
              <span className="field-hint">
                Freshly finished downloads get this long to import on their own before the janitor may touch
                them.
              </span>
            </label>
            <label className="field janitor-knob">
              <span>Escalate after (runs)</span>
              <input
                type="number"
                min={1}
                max={48}
                value={knobs.retryEscalateRuns}
                data-testid="janitor-escalate"
                aria-label="Escalate after this many runs"
                onChange={(e) => patchKnobs({ retryEscalateRuns: e.target.value })}
              />
              <span className="field-hint">
                An import still stuck after this many retry passes is treated as a bad release instead.
              </span>
            </label>
          </div>

          <div className="form-actions janitor__save">
            {escalations.length > 0 ? (
              <ConfirmButton
                className="btn primary"
                data-testid="janitor-save"
                disabled={!canSave}
                label={save.isPending ? 'Saving…' : 'Save'}
                confirmLabel={`Enforce ${escalations.length} ${escalations.length === 1 ? 'cell' : 'cells'}?`}
                restingAriaLabel={`Save janitor config, enabling enforcement for ${escalations.join(', ')} — click twice to confirm`}
                confirmAriaLabel={`Confirm: enable enforcement for ${escalations.join(', ')}`}
                onConfirm={doSave}
              />
            ) : (
              <button
                type="button"
                className="btn primary"
                data-testid="janitor-save"
                disabled={!canSave}
                onClick={doSave}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            )}
            {/* Reserved status slot — text recolors, never reflows (ADR-015). */}
            <span className="janitor__status" role="status">
              {invalidMsg ?? (saved ? 'Saved' : dirty ? 'Unsaved' : ' ')}
            </span>
          </div>
        </section>
      ) : null}

      {/* Last 7 days */}
      {status.isSuccess ? (
        <section className="card janitor" data-testid="janitor-summary" aria-label="Last seven days">
          <h2>Last 7 days</h2>
          {summary.length === 0 ? (
            <p className="muted">
              No janitor runs recorded yet. The census appears here after the first hourly run.
            </p>
          ) : (
            <div className="janitor-grid-wrap">
              <table className="janitor-grid janitor-grid--summary">
                <thead>
                  <tr>
                    <th scope="col">Problem class</th>
                    {INSTANCES.map((i) => (
                      <th key={i} scope="col">
                        {INSTANCE_LABEL[i]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {([...CLASSES, 'unknown'] as const).map((klass) => (
                    <tr key={klass}>
                      <th scope="row">{CLASS_LABEL[klass]}</th>
                      {INSTANCES.map((instance) => {
                        const cell = summaryCell(instance, klass);
                        return (
                          <td key={instance}>
                            {cell ? (
                              <>
                                {cell.observed} seen
                                {cell.enforced > 0 ? (
                                  <span className="janitor-grid__enforced"> · {cell.enforced} handled</span>
                                ) : null}
                              </>
                            ) : (
                              <span className="muted">0</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
